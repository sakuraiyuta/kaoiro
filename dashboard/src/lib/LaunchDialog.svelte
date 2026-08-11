<script lang="ts">
  // Operator launch dialog (#22, 案A/ADR-0024). Picks a host, one of its
  // declared personas, a cwd from the host allow-list, and an optional first
  // prompt, then asks the server to spawn. The server allocates the agent_id
  // and mints the per-agent token; this form never handles secrets.
  import type {
    HostInfo,
    KaoiroConnection,
    RunnerSessions,
  } from "./protocol";
  import { PERMISSION_MODE_AXES, resolveLaunchDefaultEffort } from "./protocol";

  let {
    hosts,
    connection,
    sessions,
    serverBuildRevision = null,
    onClose,
  }: {
    hosts: HostInfo[];
    connection: KaoiroConnection;
    sessions: RunnerSessions | null;
    /** Server's own build_revision (issue #228, GET /api/health via
     *  fetchServerHealth) — null on a pre-#228 server or a failed fetch.
     *  Unlike round 1, this NOW surfaces its own warning below rather than
     *  silently matching "nothing to compare" (issue #228 round 2 MF-4,
     *  ふじ 差し戻し: an operator could not tell "revisions agree" apart
     *  from "server health was unreachable" — both showed no warning). */
    serverBuildRevision?: string | null;
    onClose: () => void;
  } = $props();

  // Option E, ADR-0039: LaunchDialog fires a live catalog probe when the
  // Claude engine is selected. `refreshEngineCatalog()` resolves with the
  // full EngineCatalogResult (request_id-correlated) once the runner's
  // paired `catalog_result` arrives, or rejects on server ack failure /
  // transport disconnect / timeout — so we can hold the loading spinner
  // until the actual outcome and report a specific failure reason. TTL is
  // owned by the runner; auto-probes always fire with force=false, the
  // manual button with force=true.
  let refreshingCatalog = $state(false);
  let catalogError = $state<string | null>(null);
  const CLAUDE_ENGINE = "claude-code";
  // Guard against a late catalog_result / cancel after this dialog closes
  // (藤 turn-11 追補): $effect returns a cleanup that flips `alive=false`
  // and future refresh completions bail out before touching state.
  let alive = { current: true };
  // Monotonic generation for stale-result rejection (藤 review C): every
  // refresh trigger takes the next generation; only the latest may write
  // refreshingCatalog / catalogError. host/engine changes bump the
  // generation without triggering a probe so any outstanding waiter is
  // dropped even before its promise settles.
  let refreshGeneration = { current: 0 };

  let mode = $state<"new" | "resume">("new");
  let hostId = $state("");
  let personaId = $state("");
  let cwd = $state("");
  let name = $state("");
  let sessionId = $state("");
  let prompt = $state("");
  let engine = $state("claude-code");
  let model = $state("");
  let effort = $state("");
  // Persona-scoped "last chosen effort" (issue #88): `persona_id => effort`
  // fetched once per dialog open (see the $effect below), joined against
  // the current model's effort_levels wherever `effort` is (re)computed.
  // Kept SEPARATE from `effort` itself — writing it directly would fight
  // the model-validity reset effect and the operator's own manual pick.
  let launchDefaults = $state<Record<string, string>>({});
  // True once the operator has directly touched the effort <select> for
  // the CURRENT persona; guards a late getLaunchDefaults() reply (or a
  // launchDefaults-triggered re-evaluation) from clobbering that pick
  // (ふじ review). Reset on persona switch — see the effect below.
  let manualEffortPick = $state(false);
  // Plain (non-reactive) last-seen personaId so the effort-default effect
  // can tell "persona actually changed" apart from "some other tracked
  // value changed while personaId stayed the same" (mirrors this file's
  // `alive`/`refreshGeneration` ref idiom).
  let lastEffortDefaultPersona = { current: "" };
  let sandbox = $state<"read-only" | "workspace-write" | "danger-full-access">(
    "workspace-write",
  );
  let networkAccess = $state(false);
  // Claude-only launch permission mode (phase-15 15-12, ADR-0033 F4 追補).
  // Priority "explicit spawn > persisted store" is enforced server-side:
  // when the operator picks something other than "" the server relays it
  // AND records it into PermissionModes so the next after_join push
  // reinforces (not overwrites) the SpawnMessage value. "" here means "leave
  // to the server's stored value" (natural continuation for restore paths).
  const PERMISSION_MODE_VALUES = [
    "default",
    "acceptEdits",
    "plan",
    "dontAsk",
    "auto",
    "bypassPermissions",
  ] as const;
  type PermissionModeChoice = "" | (typeof PERMISSION_MODE_VALUES)[number];
  let permissionMode = $state<PermissionModeChoice>("");
  let busy = $state(false);
  let error = $state<string | null>(null);

  const host = $derived(hosts.find((h) => h.host_id === hostId) ?? null);

  // Build identity mismatch warning (issue #228). Observability only —
  // never blocks launch (canLaunch/launch() never reference this). Round 2
  // (ふじ MF-4 差し戻し) widened the state matrix round 1 collapsed:
  // "absent runner" and "server health unreachable" used to silently
  // return null, indistinguishable from an exact match — an operator could
  // not tell "identity confirmed equal" apart from "no signal at all".
  // Every non-match state below now surfaces its own message; only a
  // confirmed clean, matching pair stays silent.
  //
  // States, in the order checked:
  //   1. host.build_revision absent  -- pre-#228 runner, no signal at all
  //   2. host.build_revision unknown -- runner determined nothing
  //   3. serverBuildRevision null    -- pre-#228 server OR /api/health
  //                                     fetch failed (fetchServerHealth
  //                                     does not distinguish the two; both
  //                                     mean the operator has no server
  //                                     identity to compare against)
  //   4. serverBuildRevision unknown -- server determined nothing
  //   5. revisions disagree          -- mismatch
  //   6. revisions agree, host dirty -- match, but the runner's own
  //                                     checkout had uncommitted changes
  //   7. revisions agree, clean      -- silent (nothing to warn about)
  const buildRevisionWarning = $derived.by(() => {
    if (!host) return null;
    const runnerRevision = host.build_revision;
    if (runnerRevision === undefined) {
      return "この host は build revision 情報を報告していません(pre-#228 runner)。";
    }
    if (runnerRevision === "unknown") {
      return "この host の build revision が unknown です(git 情報なしでビルドされたか、pnpm build を経ていません)。";
    }
    if (serverBuildRevision === null) {
      return "server の build revision を取得できません(pre-#228 server、または /api/health の取得に失敗)。";
    }
    if (serverBuildRevision === "unknown") {
      return "server 自身の build revision が unknown です。";
    }
    if (runnerRevision !== serverBuildRevision) {
      return (
        `この host の build revision (${runnerRevision.slice(0, 12)}…) が ` +
        `server (${serverBuildRevision.slice(0, 12)}…) と一致しません。`
      );
    }
    if (host.build_dirty === true) {
      return (
        `この host の build (${runnerRevision.slice(0, 12)}…) は ` +
        "コミットされていない変更を含んでいます(dirty)。"
      );
    }
    return null;
  });

  // Engine cascade (ADR-0032 F4bc): engine -> model -> optional effort.
  // The select is shown only when the host declares 2+ capabilities; a
  // single-engine host keeps the pre-engine UX (ADR-0032 F4a).
  const engines = $derived(host?.capabilities ?? []);
  const showEngineSelect = $derived(engines.length >= 2);
  // Primitive derived so the auto-refresh $effect below tracks the boolean
  // (identity-stable across hosts broadcasts) rather than the `engines`
  // array reference — a hosts push that only updates models[].models
  // rotates the array identity, and tracking that would re-fire the
  // refresh $effect and bump the generation for no reason (藤 review 3-1).
  const hostSupportsClaude = $derived(engines.includes(CLAUDE_ENGINE));
  const engineModels = $derived(
    host?.engines?.find((e) => e.id === engine)?.models ?? [],
  );
  const selectedModel = $derived(
    engineModels.find((m) => m.value === model) ?? null,
  );
  // `resolved_model` is read-only probe/cache metadata, never a launch
  // value. Restrict this hint to Claude: Codex's catalog must keep its
  // existing presentation even if a future payload happens to carry the
  // optional field.
  const selectedResolvedModel = $derived(
    engine === CLAUDE_ENGINE &&
      typeof selectedModel?.resolved_model === "string" &&
      selectedModel.resolved_model.length > 0
      ? selectedModel.resolved_model
      : null,
  );
  const effortLevels = $derived(
    selectedModel?.effort_levels ?? [],
  );
  function chooseModel(event: Event): void {
    model = (event.currentTarget as HTMLSelectElement).value;
    const choice = engineModels.find((m) => m.value === model);
    // issue #88: the persona's last-committed effort wins over the model's
    // own default_effort when it is actually offered by the newly chosen
    // model; otherwise fall back to default_effort exactly as before. A
    // model change is a fresh baseline (manualPick: false forces a fresh
    // evaluation here regardless of any prior pick), so it also clears
    // manualEffortPick — there is no longer a "manual pick for this model"
    // to protect.
    const preferred = resolveLaunchDefaultEffort({
      manualPick: false,
      preferred: launchDefaults[personaId],
      effortLevels: choice?.effort_levels ?? [],
    });
    effort = preferred ?? (choice?.default_effort ?? "");
    manualEffortPick = false;
  }
  function chooseEffort(event: Event): void {
    effort = (event.currentTarget as HTMLSelectElement).value;
    manualEffortPick = true;
  }
  // Codex permission is launch-fixed (ADR-0033 F3): the sandbox axis is the
  // only selectable knob; approval is pinned to "never" upstream.
  const isCodex = $derived(engine === "codex");
  // Claude-only: the permission_mode picker only makes sense for engine=
  // claude-code (Codex ignores the field). Kept as a derived so the select
  // vanishes automatically when the operator swaps engines mid-dialog.
  const showPermissionMode = $derived(engine === "claude-code");

  // Resume candidates only count when they match the current host+cwd (and
  // engine, when the reply carries one); a stale enumerate for another
  // selection must not be offered.
  const candidates = $derived(
    sessions &&
      sessions.host_id === hostId &&
      sessions.cwd === cwd &&
      (sessions.engine === undefined || sessions.engine === engine)
      ? sessions.sessions
      : [],
  );

  // In resume mode, (re)fetch the candidate list whenever host/cwd/engine
  // changes. The list arrives asynchronously via onSessions (the `sessions`
  // prop).
  $effect(() => {
    if (mode !== "resume" || hostId === "" || cwd === "") return;
    void connection.enumerateSessions(hostId, cwd, engine).catch(() => {});
  });

  // Option E, ADR-0039: trigger a live catalog refresh whenever a host is
  // selected and the Claude engine is in play. Auto-fires with force=false;
  // the runner honours its TTL cache and skips the probe when fresh, so a
  // dialog-open storm cannot spawn multiple probes. Runs on host or engine
  // change. The dedup guard on the runner side merges concurrent requests.
  // Loading is held until the runner's catalog_result arrives (transport
  // disconnect / timeout / server ack failure all reject). Stale results
  // from a prior host/engine are dropped via generation compare (藤 review C).
  async function triggerCatalogRefresh(force: boolean): Promise<void> {
    if (hostId === "" || engine !== CLAUDE_ENGINE) return;
    const gen = ++refreshGeneration.current;
    const isCurrent = (): boolean =>
      alive.current && gen === refreshGeneration.current;
    refreshingCatalog = true;
    catalogError = null;
    try {
      const result = await connection.refreshEngineCatalog(
        hostId,
        engine,
        force,
      );
      if (!isCurrent()) return;
      if (!result.ok) {
        catalogError = result.reason ?? "probe failed";
      }
    } catch (err) {
      if (!isCurrent()) return;
      catalogError = err instanceof Error ? err.message : String(err);
    } finally {
      if (isCurrent()) refreshingCatalog = false;
    }
  }
  $effect(() => {
    // Cleanup flips `alive.current` so a late resolve/reject after the
    // dialog unmounts cannot touch removed state.
    return () => {
      alive.current = false;
    };
  });
  $effect(() => {
    // Read the reactive deps eagerly so Svelte tracks them. Tracking the
    // primitive `hostSupportsClaude` boolean (not the `engines` array)
    // means an in-place hosts broadcast that only rotates the models
    // array identity does not re-fire this effect (藤 review 3-1).
    const h = hostId;
    const e = engine;
    const supported = hostSupportsClaude;
    // Any host/engine change invalidates pending waiters (藤 review C).
    // Bump BEFORE deciding whether to probe so a switch to Codex mid-flight
    // still marks the outstanding Claude refresh stale.
    refreshGeneration.current++;
    if (h === "" || e !== CLAUDE_ENGINE || !supported) {
      // Non-Claude / no-host: reset the UI so a lingering spinner or error
      // from the previous Claude session does not follow the operator into
      // Codex or a different host.
      refreshingCatalog = false;
      catalogError = null;
      return;
    }
    void triggerCatalogRefresh(false);
  });

  // Keep engine valid for the host, and model/effort valid for the engine
  // catalog ("" = engine/model default, always allowed).
  $effect(() => {
    if (engines.length > 0 && !engines.includes(engine)) {
      engine = engines.includes("claude-code") ? "claude-code" : engines[0]!;
    }
    if (model !== "" && !engineModels.some((m) => m.value === model)) {
      model = "";
    }
    if (effort !== "" && !effortLevels.includes(effort)) {
      effort = "";
    }
  });

  // Keep the selected session valid for the current candidate set.
  $effect(() => {
    if (!candidates.some((s) => s.session_id === sessionId)) {
      sessionId = candidates[0]?.session_id ?? "";
    }
  });

  // Default the host to the first available, and keep persona/cwd valid for
  // the chosen host: fall back to the first option whenever the current
  // selection is not offered (also covers the initial empty state).
  $effect(() => {
    if (!hosts.some((h) => h.host_id === hostId)) {
      hostId = hosts[0]?.host_id ?? "";
    }
    const h = host;
    if (!h) return;
    if (!h.personas.some((p) => p.id === personaId)) {
      personaId = h.personas[0]?.id ?? "";
    }
    if (!h.cwd_allowlist.includes(cwd)) {
      cwd = h.cwd_allowlist[0] ?? "";
    }
  });

  // issue #88: fetch the persona-scoped "last chosen effort" map once per
  // dialog open. Failure falls back silently to the model's own
  // default_effort (chooseModel's existing behavior) — this must never
  // block launch, so no `error`/`catalogError`-style UI surfacing here.
  $effect(() => {
    let cancelled = false;
    connection
      .getLaunchDefaults()
      .then((defaults) => {
        if (!cancelled) launchDefaults = defaults;
      })
      .catch(() => {
        // Silent by design (ふじ pin) — effort picker just stays on
        // whatever chooseModel/default_effort already computed.
      });
    return () => {
      cancelled = true;
    };
  });

  // Applies the current persona's preferred effort once launchDefaults
  // resolves (chooseModel already applies it synchronously on a model
  // change, using whatever launchDefaults holds at that moment; this
  // effect re-applies it if the fetch resolves later). A persona switch
  // always re-baselines (clears manualEffortPick for the new persona)
  // before evaluating — an unrelated re-run (e.g. launchDefaults itself
  // changing) must NOT clear a manual pick made for the CURRENT persona.
  $effect(() => {
    const persona = personaId;
    const personaChanged = persona !== lastEffortDefaultPersona.current;
    if (personaChanged) {
      lastEffortDefaultPersona.current = persona;
      manualEffortPick = false;
    }

    if (manualEffortPick) return;

    const next = resolveLaunchDefaultEffort({
      manualPick: false,
      preferred: launchDefaults[persona],
      effortLevels,
    });

    if (next !== undefined) {
      effort = next;
    } else if (personaChanged) {
      // The newly selected persona has no usable preference (no mapping
      // entry, or one invalid for the current model) — rebaseline to the
      // model's own default rather than leaving the PREVIOUS persona's
      // effort in place (ふじ review, must-fix 1).
      const choice = engineModels.find((m) => m.value === model);
      effort = choice?.default_effort ?? "";
    }
  });

  const canLaunch = $derived(
    !busy &&
      hostId !== "" &&
      personaId !== "" &&
      cwd !== "" &&
      (mode === "new" || sessionId !== ""),
  );

  async function launch(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!canLaunch) return;
    busy = true;
    error = null;
    try {
      const trimmed = prompt.trim();
      const customName = name.trim();
      await connection.spawn({
        host_id: hostId,
        persona: personaId,
        cwd,
        // Per-instance display name (overrides the persona name); applies to
        // both a fresh spawn and a resume.
        ...(customName === "" ? {} : { name: customName }),
        // Engine + launch-time picks (ADR-0032 F4bc). engine rides even for
        // the claude-code default so the server records it for restore.
        engine,
        ...(model === "" ? {} : { model }),
        ...(effort === "" ? {} : { effort }),
        // Codex-only launch permission (ADR-0033 F3).
        ...(isCodex ? { sandbox } : {}),
        ...(isCodex && sandbox === "workspace-write"
          ? { network_access: networkAccess }
          : {}),
        // Claude-only launch permission mode (phase-15 15-12). Empty ""
        // means "no explicit pick" — fall through to the server's stored
        // value (natural continuation).
        ...(showPermissionMode && permissionMode !== ""
          ? { permission_mode: permissionMode }
          : {}),
        ...(mode === "resume"
          ? { resume_session_id: sessionId }
          : trimmed === ""
            ? {}
            : { initial_prompt: trimmed }),
      });
      // The launch outcome arrives separately via spawn_result; closing here
      // returns the operator to the grid where the new agent will appear.
      onClose();
    } catch (e) {
      error = e instanceof Error ? e.message : "起動に失敗しました。";
    } finally {
      busy = false;
    }
  }
</script>

<div
  class="backdrop"
  role="button"
  tabindex="-1"
  aria-label="閉じる"
  onclick={onClose}
  onkeydown={(e) => e.key === "Escape" && onClose()}
></div>
<div class="dialog" role="dialog" aria-modal="true" aria-label="エージェント起動">
  <form onsubmit={launch}>
    <h2>エージェントを起動</h2>

    <div class="tabs" role="tablist">
      <button
        type="button"
        role="tab"
        class:active={mode === "new"}
        aria-selected={mode === "new"}
        onclick={() => (mode = "new")}
      >
        新規
      </button>
      <button
        type="button"
        role="tab"
        class:active={mode === "resume"}
        aria-selected={mode === "resume"}
        onclick={() => (mode = "resume")}
      >
        再開
      </button>
    </div>

    {#if hosts.length === 0}
      <p class="note">起動可能なホストがありません(runner 未接続)。</p>
    {:else}
      <label>
        ホスト
        <select bind:value={hostId}>
          {#each hosts as h (h.host_id)}
            <option value={h.host_id}>{h.host_id}</option>
          {/each}
        </select>
      </label>

      {#if buildRevisionWarning}
        <p class="build-revision-warning" role="status">
          ⚠ {buildRevisionWarning}
        </p>
      {/if}

      <label>
        ペルソナ
        <select bind:value={personaId} disabled={!host}>
          {#each host?.personas ?? [] as p (p.id)}
            <option value={p.id}>{p.name}</option>
          {/each}
        </select>
      </label>

      <label>
        作業ディレクトリ
        <select bind:value={cwd} disabled={!host}>
          {#each host?.cwd_allowlist ?? [] as c (c)}
            <option value={c}>{c}</option>
          {/each}
        </select>
      </label>

      {#if showEngineSelect}
        <label>
          エンジン
          <select bind:value={engine}>
            {#each engines as e (e)}
              <option value={e}>{e}</option>
            {/each}
          </select>
        </label>
      {/if}

      {#if engineModels.length > 0}
        <label>
          モデル
          <select
            value={model}
            onchange={chooseModel}
            aria-describedby={selectedResolvedModel
              ? "launch-model-resolution"
              : undefined}
          >
            <option value="">既定</option>
            {#each engineModels as m (m.value)}
              <option value={m.value}>{m.display_name}</option>
            {/each}
          </select>
        </label>
        {#if selectedResolvedModel}
          <p id="launch-model-resolution" class="note model-resolution">
            取得時点の解決先: <code>{selectedResolvedModel}</code> (起動時に変わる場合があります)
          </p>
        {/if}
      {/if}

      {#if engine === CLAUDE_ENGINE}
        <!-- Option E, ADR-0039: manual force-refresh of the (host, engine)
             catalog. Claude only — Codex catalogs are static (ADR-0035 F1),
             so no button is offered for other engines. -->
        <div class="catalog-refresh">
          <button
            type="button"
            onclick={() => void triggerCatalogRefresh(true)}
            disabled={refreshingCatalog || hostId === ""}
            aria-label="モデル一覧を再取得"
            title="モデル一覧を再取得 (runner のキャッシュを無視して live probe)"
          >
            {refreshingCatalog ? "更新中…" : "モデル一覧を再取得"}
          </button>
          {#if catalogError}
            <span class="catalog-error" role="alert">{catalogError}</span>
          {/if}
        </div>
      {/if}

      {#if effortLevels.length > 0}
        <label>
          effort
          <select value={effort} onchange={chooseEffort}>
            <option value="">既定</option>
            {#each effortLevels as l (l)}
              <option value={l}>{l}</option>
            {/each}
          </select>
        </label>
      {/if}

      {#if showPermissionMode}
        <!-- Claude permission mode の起動時選択 (phase-15 15-12,
             ADR-0033 F4 追補)。空 ("") は「明示しない = 前回保存値を継続」で、
             選ぶと server が SpawnMessage.permission_mode を relay + 保存する。
             tooltip に PERMISSION_MODE_AXES の二軸 (書込 / 承認) を併記して
             AgentDetail の現行 mode ラベルと同じ読み方に揃える。 -->
        <label>
          permission mode(作業意図)
          <select bind:value={permissionMode}>
            <option value="">前回値を継続 (server 保存値)</option>
            {#each PERMISSION_MODE_VALUES as m (m)}
              <option
                value={m}
                title={"書込: " +
                  PERMISSION_MODE_AXES[m].sandbox +
                  " / 承認: " +
                  PERMISSION_MODE_AXES[m].approval}
              >
                {m} (書込 {PERMISSION_MODE_AXES[m].sandbox} / 承認
                {PERMISSION_MODE_AXES[m].approval})
              </option>
            {/each}
          </select>
        </label>
      {/if}

      {#if isCodex}
        <!-- Codex の権限は起動時固定 (ADR-0033 F3): sandbox 軸のみ選択、
             承認 (approval) は upstream 制約で never 固定。 -->
        <label>
          sandbox(書き込み範囲)
          <select bind:value={sandbox}>
            <option value="read-only">read-only — 読み取りのみ</option>
            <option value="workspace-write">
              workspace-write — 作業ディレクトリ内のみ書込可
            </option>
            <option value="danger-full-access">
              danger-full-access — 無制限(危険)
            </option>
          </select>
        </label>
        {#if sandbox === "workspace-write"}
          <label class="row">
            <input type="checkbox" bind:checked={networkAccess} />
            sandbox 内のネットワークアクセスを許可
          </label>
        {/if}
        <p class="note">
          承認 (approval) は never 固定 — Codex は実行中の承認要求に対応しません。
        </p>
      {/if}

      <label>
        エージェント名(任意)
        <input
          type="text"
          bind:value={name}
          maxlength="64"
          placeholder="未入力ならペルソナ名"
        />
      </label>

      {#if mode === "new"}
        <label>
          初期プロンプト(任意)
          <textarea
            bind:value={prompt}
            rows="3"
            placeholder="最初の指示(空ならアイドルで待機)"
          ></textarea>
        </label>
      {:else}
        <label>
          セッション
          {#if candidates.length === 0}
            <span class="note">この cwd に再開可能なセッションはありません。</span>
          {:else}
            <select bind:value={sessionId}>
              {#each candidates as s (s.session_id)}
                <option value={s.session_id}>
                  {s.summary ?? s.session_id}{s.mtime ? ` — ${s.mtime}` : ""}
                </option>
              {/each}
            </select>
          {/if}
        </label>
      {/if}
    {/if}

    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}

    <div class="actions">
      <button type="button" class="ghost" onclick={onClose}>キャンセル</button>
      <button type="submit" disabled={!canLaunch}>
        {busy ? "起動中…" : "起動"}
      </button>
    </div>
  </form>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    border: none;
    cursor: default;
    /* Global dialog/drawer layer (app.css z-index scale): above the bottom
       sheet (30-32); scale shared with SettingsDrawer (phase-31 31-7). */
    z-index: 40;
  }

  .dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    /* The implied 4vw side gap of the former 92vw acts as the safe-area
       floor for landscape notches (responsive-layout.md セーフエリア). */
    width: min(
      30rem,
      calc(100vw - max(4vw, env(safe-area-inset-left))
        - max(4vw, env(safe-area-inset-right)))
    );
    padding: 1.6rem;
    background: var(--bg-card);
    border: 1px solid var(--line);
    border-radius: 0.6rem;
    z-index: 41;
  }

  /* short: cap the dialog and let it scroll internally so a low viewport
     never clips the top/bottom (ADR-0052 F8, phase-31 31-8). */
  @media (max-height: 500px) {
    .dialog {
      max-block-size: calc(
        100dvh - max(1rem, env(safe-area-inset-top))
          - max(1rem, env(safe-area-inset-bottom))
      );
      overflow-y: auto;
    }
  }

  h2 {
    margin: 0 0 1rem;
    font-size: var(--fs-h2);
    color: var(--fg);
  }

  form {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }

  .tabs {
    display: flex;
    gap: 0.4rem;
  }

  .tabs button {
    flex: 1;
    padding: 0.35rem;
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    cursor: pointer;
  }

  .tabs button.active {
    color: var(--fg);
    border-color: var(--fg-dim);
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
  }

  select,
  textarea,
  input {
    padding: 0.5rem 0.6rem;
    font-size: var(--fs-input);
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    font-family: inherit;
  }

  textarea {
    resize: vertical;
  }

  .note {
    margin: 0;
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
  }

  /* issue #228: advisory, not blocking -- same warning color as
   * AgentCard's .error-icon (no dedicated --c-warning token exists yet). */
  .build-revision-warning {
    margin: 0;
    font-size: var(--fs-body-sm);
    color: var(--c-error);
  }

  .model-resolution {
    /* Tighten form's 0.9rem gap to the label's 0.3rem-equivalent spacing. */
    margin: -0.5rem 0 0;
  }

  label.row {
    flex-direction: row;
    align-items: center;
    gap: 0.5rem;
  }

  label.row input[type="checkbox"] {
    width: auto;
    padding: 0;
  }

  .error {
    margin: 0;
    font-size: var(--fs-body-sm);
    color: var(--c-error);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.6rem;
    margin-top: 0.3rem;
  }

  button {
    padding: 0.45rem 0.9rem;
    font-size: var(--fs-body);
    color: var(--fg);
    background: var(--bg-card);
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    cursor: pointer;
  }

  button.ghost {
    color: var(--fg-dim);
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
