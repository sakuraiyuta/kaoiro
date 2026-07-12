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
  import { PERMISSION_MODE_AXES } from "./protocol";

  let {
    hosts,
    connection,
    sessions,
    onClose,
  }: {
    hosts: HostInfo[];
    connection: KaoiroConnection;
    sessions: RunnerSessions | null;
    onClose: () => void;
  } = $props();

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

  // Engine cascade (ADR-0032 F4bc): engine -> model -> optional effort.
  // The select is shown only when the host declares 2+ capabilities; a
  // single-engine host keeps the pre-engine UX (ADR-0032 F4a).
  const engines = $derived(host?.capabilities ?? []);
  const showEngineSelect = $derived(engines.length >= 2);
  const engineModels = $derived(
    host?.engines?.find((e) => e.id === engine)?.models ?? [],
  );
  const effortLevels = $derived(
    engineModels.find((m) => m.value === model)?.effort_levels ?? [],
  );
  function chooseModel(event: Event): void {
    model = (event.currentTarget as HTMLSelectElement).value;
    const choice = engineModels.find((m) => m.value === model);
    effort = choice?.default_effort ?? "";
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
          <select value={model} onchange={chooseModel}>
            <option value="">既定</option>
            {#each engineModels as m (m.value)}
              <option value={m.value}>{m.display_name}</option>
            {/each}
          </select>
        </label>
      {/if}

      {#if effortLevels.length > 0}
        <label>
          effort
          <select bind:value={effort}>
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
  }

  .dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(30rem, 92vw);
    padding: 1.6rem;
    background: var(--bg-card);
    border: 1px solid var(--line);
    border-radius: 0.6rem;
    z-index: 1;
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
