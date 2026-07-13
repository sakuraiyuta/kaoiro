<script lang="ts">
  import { onMount } from "svelte";
  import AgentCard from "./lib/AgentCard.svelte";
  import AgentDetail from "./lib/AgentDetail.svelte";
  import LaunchDialog from "./lib/LaunchDialog.svelte";
  import { expressionFor, spriteUrlFor } from "./lib/expression";
  import type {
    ConnectionStatus,
    DirectoryEntry,
    Envelope,
    HostInfo,
    KaoiroConnection,
    PersonaManifest,
    RunnerSessions,
    SpawnResult,
  } from "./lib/protocol";
  import {
    connectKaoiro,
    defaultSocketUrl,
    fanOutInterAgentHistory,
    fetchPersonaManifest,
    formatAgentLabel,
    isReplyEnvelope,
    mergeTranscriptEntries,
    resetTranscriptHistory,
  } from "./lib/protocol";
  import {
    isWaitTransition,
    notifyWait,
    requestNotificationPermission,
  } from "./lib/notify";

  let agents = $state<Record<string, Envelope>>({});
  // Restart-surviving identity ledger (ADR-0030) — every agent_id we have
  // ever spawned, with its persona. Merged with `agents` (live) below to
  // surface offline entries in their own section with a restore button.
  let directory = $state<Record<string, DirectoryEntry>>({});
  // Sticky per-agent restore/spawn failure hints (ADR-0030 D8). Cleared
  // when the agent next reports a live envelope or a subsequent
  // spawn_result for the same agent_id succeeds.
  let spawnErrors = $state<Record<string, string>>({});
  // Per-agent session-reset progress (ADR-0036 F7, phase-17 17-9). The
  // value is the mode being reset ("new" | "clear"); presence in the
  // map means the reset is between started and completed/failed, which
  // the Composer uses to disable input and show a progress line.
  let sessionResets = $state<Record<string, "new" | "clear">>({});
  // Per-agent reply transcript (operator-only, ADR-0012): log/result
  // envelopes accumulate here instead of overwriting the latest state.
  let logs = $state<Record<string, Envelope[]>>({});
  // agent_id of the agent shown full-screen, or null for the grid.
  let selected = $state<string | null>(null);
  // Viewport centre of the tile that opened the detail, for the expand
  // animation (#36); null when no tile origin is known.
  let origin = $state<{ x: number; y: number } | null>(null);
  let status = $state<ConnectionStatus>("connecting");
  let manifest = $state<PersonaManifest | null>(null);
  let connection = $state<KaoiroConnection | null>(null);

  // Launch UI (#22, operator-only). `hosts` and operator-ness both come from
  // the `hosts` push, which only operators receive — so its arrival is what
  // reveals the launch affordance. `spawnNotice` is a transient toast for the
  // runner's spawn outcome.
  let hosts = $state<HostInfo[]>([]);
  let isOperator = $state(false);
  let showLaunch = $state(false);
  let spawnNotice = $state<string | null>(null);
  let spawnNoticeTimer: ReturnType<typeof setTimeout> | undefined;
  // spawn の immediate reply は新 agent が state_change を出す前に届くため、
  // 文字列を showNotice で固定すると label が永久に bare id のまま (#).
  // SpawnResult をそのまま保持して spawnResultText を $derived 化、 agents
  // の更新で label が自然に追従するようにする。
  let pendingSpawnResult = $state<SpawnResult | null>(null);
  let pendingSpawnTimer: ReturnType<typeof setTimeout> | undefined;
  // Latest resume candidates from enumerate_sessions (#22 phase-1); the
  // dialog matches them to its current host/cwd selection.
  let runnerSessions = $state<RunnerSessions | null>(null);
  let deletingAllOffline = $state(false);

  // Transient action notice (spawn outcome, or a stop/restore failure that
  // would otherwise fail silently, #22).
  function showNotice(message: string): void {
    spawnNotice = message;
    clearTimeout(spawnNoticeTimer);
    spawnNoticeTimer = setTimeout(() => (spawnNotice = null), 6000);
  }

  function notifySpawn(result: SpawnResult): void {
    // 文字列ではなく結果オブジェクトを $state に持たせて、 表示文字列は
    // spawnNoticeText が $derived で agents 更新に追従する形にする (#)。
    pendingSpawnResult = result;
    clearTimeout(pendingSpawnTimer);
    pendingSpawnTimer = setTimeout(() => (pendingSpawnResult = null), 6000);
  }

  // 表示用の単一窓口 — spawn 結果と汎用 notice を統合し、 spawn 結果は
  // agents の更新で label が自然に解決される。 spawn 結果が優先 (操作員の
  // アクションへの直接応答なので)。
  const spawnNoticeText = $derived.by<string | null>(() => {
    if (pendingSpawnResult !== null) {
      const label = formatAgentLabel(agents, pendingSpawnResult.agent_id);
      return pendingSpawnResult.ok
        ? `起動しました: ${label}`
        : `起動に失敗: ${label} (${pendingSpawnResult.reason ?? "error"})`;
    }
    return spawnNotice;
  });

  // Surface a control-command failure (stop / restore) that the grid buttons
  // would otherwise only console.warn (#22). `label` names the action.
  function notifyActionError(label: string, err: unknown): void {
    const reason = err instanceof Error ? err.message : "error";
    showNotice(`${label}できません (${reason})`);
  }

  // Login form (案A): shown when there is no live session — first load with
  // no usable cookie, after logout, or on a revoked-session 401. Submitting
  // exchanges the typed token for the httpOnly cookie (POST /session/new),
  // then opens the socket. The token is a shared viewer/operator secret
  // (ADR-0011), not a personal account; issue #65 tracks real auth.
  let needLogin = $state(false);
  let loginToken = $state("");
  let loginError = $state<string | null>(null);
  let loginBusy = $state(false);

  // The first auth check (onMount) is async; until it resolves, render a
  // neutral loading state instead of flashing the dashboard before we know
  // whether a session exists.
  let authChecked = $state(false);

  // Connection lifecycle refs shared by mount / login / logout. Plain refs:
  // only their effects (connection, status) need to be reactive.
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let destroyed = false;

  // History is the authoritative recovered transcript, but log/result
  // envelopes can arrive via onEnvelope between join and the history push.
  // Merge those live-buffered entries with the history (deduped by producer,
  // session, ts, seq, and type) so a reload never drops them. Always restore
  // chronological order: after a server restart `local` can contain older SPA state,
  // and after history_reset retained IA can precede older JSONL replay logs.
  function mergeHistories(
    histories: Record<string, Envelope[]>,
    local: Record<string, Envelope[]>,
  ): Record<string, Envelope[]> {
    const merged: Record<string, Envelope[]> = {};
    const ids = new Set([...Object.keys(histories), ...Object.keys(local)]);
    for (const id of ids) {
      merged[id] = mergeTranscriptEntries(histories[id] ?? [], local[id] ?? []);
    }
    return merged;
  }

  // Live grid: agents whose wrapper is currently connected (state !== disconnected).
  // Disconnected agents move to the offline section below so restore UX is
  // consistent whether the server restarted (directory-only) or only the
  // wrapper died (live disconnected — hot reload / crash / network hiccup).
  const sorted = $derived(
    Object.values(agents)
      .filter((envelope) => envelope.state !== "disconnected")
      .sort((a, b) => a.agent_id.localeCompare(b.agent_id)),
  );
  // Everything not in the live grid: directory entries with NO AgentStates
  // envelope (server restarted, ADR-0030) AND live entries whose state is
  // `disconnected` (wrapper died, server survived). Both are restore
  // candidates; unifying them here keeps the operator's UX identical across
  // failure modes.
  type OfflineTile = {
    id: string;
    envelope: Envelope;
    directoryOnly: boolean;
  };
  const offlineEntries = $derived<OfflineTile[]>(
    [
      ...Object.entries(directory)
        .filter(([id]) => !(id in agents))
        .map(([id, entry]): OfflineTile => ({
          id,
          envelope: directoryEnvelope(id, entry),
          directoryOnly: true,
        })),
      ...Object.values(agents)
        .filter((env) => env.state === "disconnected")
        .map((env): OfflineTile => ({
          id: env.agent_id,
          envelope: env,
          directoryOnly: false,
        })),
    ].sort((a, b) => a.id.localeCompare(b.id)),
  );

  // Synthesizes a minimal Envelope from a directory-only entry so AgentCard
  // can render it with the existing disconnected styling. `state=disconnected`
  // is what unlocks the restore button; live-disconnected tiles pass their
  // real envelope through instead (they carry the last session_id / ext).
  function directoryEnvelope(id: string, entry: DirectoryEntry): Envelope {
    return {
      version: "0",
      agent_id: id,
      persona: entry.persona,
      ts: "",
      type: "state_change",
      state: "disconnected",
    };
  }
  // Falls back to the grid if the selected agent vanishes from the map.
  const selectedEnvelope = $derived(
    selected !== null ? (agents[selected] ?? null) : null,
  );

  // Opens the client socket with the given auth and starts the cookie-slide
  // timer (ADR-0013). `slideNow` does an immediate refresh because a cookie
  // already exists (reload / login paths); the first `?token=` load skips it
  // since its cookie-setting POST may still be in flight.
  function startSession(
    connectOpts: { token?: string; ticket?: string },
    slideNow: boolean,
  ): void {
    status = "connecting";
    connection = connectKaoiro(
      defaultSocketUrl(location),
      {
        onStatus: (next) => (status = next),
        onSnapshot: (next) => (agents = next),
        onEnvelope: (envelope) => {
          // Reply lines feed the transcript; state envelopes update the
          // latest-state map that drives the grid faces.
          if (isReplyEnvelope(envelope)) {
            // inter_agent_message lands in BOTH the sender's and receiver's
            // transcript (protocol-inter-agent spec) so each agent's detail
            // view shows the full conversation. Operator-only — viewers
            // never receive these envelopes (sanitize_envelope_for drops
            // them at the channel boundary).
            const targets = new Set<string>([envelope.agent_id]);
            if (envelope.type === "inter_agent_message") {
              const to = (envelope.payload as { to?: unknown } | undefined)?.to;
              if (typeof to === "string" && to !== "") targets.add(to);
              // Server-synthesized escalates carry agent_id="server" with no
              // grid slot of their own; drop the synthetic sender so it does
              // not accumulate a phantom logs["server"] transcript.
              if (envelope.agent_id === "server") targets.delete("server");
            }
            const next = { ...logs };
            for (const id of targets) {
              next[id] = mergeTranscriptEntries(next[id] ?? [], [envelope]);
            }
            logs = next;
          } else {
            const prevState = agents[envelope.agent_id]?.state;
            agents = { ...agents, [envelope.agent_id]: envelope };
            // A live envelope from a previously-failed restore clears its
            // sticky error hint (ADR-0030 D8): the agent is speaking again.
            if (
              envelope.state !== "disconnected" &&
              spawnErrors[envelope.agent_id] !== undefined
            ) {
              const { [envelope.agent_id]: _drop, ...rest } = spawnErrors;
              spawnErrors = rest;
            }
            // Alert the operator the moment an agent needs them (#7).
            if (isWaitTransition(prevState, envelope.state)) {
              notifyWait(envelope);
            }
          }
        },
        onHistory: (histories) =>
          (logs = mergeHistories(fanOutInterAgentHistory(histories), logs)),
        onHistoryCleared: (agentId, sessionId) => {
          // An operator purged past-session lines (#48); keep only the
          // surviving session's transcript to match the server buffer.
          const prev = logs[agentId];
          if (!prev) return;
          logs = {
            ...logs,
            [agentId]: prev.filter((e) => e.session_id === sessionId),
          };
        },
        onHistoryReset: (agentId, preserveInterAgent) => {
          // Resume replay cannot rebuild structured IA (#105), while
          // `/clear` explicitly resets the complete display projection.
          logs = {
            ...logs,
            [agentId]: resetTranscriptHistory(
              logs[agentId] ?? [],
              preserveInterAgent,
            ),
          };
        },
        onAgentDeleted: (agentId) => {
          // A disconnected agent was removed (#14, ADR-0030 D6): drop it
          // from the grid, its transcript, the directory ledger, AND any
          // sticky spawn error. Missing the directory drop leaves a
          // directory-only tile (the operator's typical delete target for
          // a restore-broken agent) visible in the offline section until a
          // page reload re-fetches the shrunk directory. The detail view
          // falls back to the grid on its own when the selected agent
          // vanishes (selectedEnvelope).
          agents = Object.fromEntries(
            Object.entries(agents).filter(([id]) => id !== agentId),
          );
          if (agentId in directory) {
            directory = Object.fromEntries(
              Object.entries(directory).filter(([id]) => id !== agentId),
            );
          }
          if (logs[agentId]) {
            logs = Object.fromEntries(
              Object.entries(logs).filter(([id]) => id !== agentId),
            );
          }
          if (agentId in spawnErrors) {
            const { [agentId]: _drop, ...rest } = spawnErrors;
            spawnErrors = rest;
          }
        },
        onHosts: (next) => {
          // Operators alone receive `hosts`, so this is also the operator
          // signal that reveals the launch UI (#22).
          hosts = next;
          isOperator = true;
        },
        onDirectory: (next) => (directory = next),
        onSpawnResult: (result) => {
          notifySpawn(result);
          // Track failed restore/spawn per agent so the tile can show a
          // sticky error icon (ADR-0030 D8). A subsequent success or a live
          // envelope clears it above.
          if (!result.ok) {
            spawnErrors = {
              ...spawnErrors,
              [result.agent_id]: result.reason ?? "error",
            };
          } else if (spawnErrors[result.agent_id] !== undefined) {
            const { [result.agent_id]: _drop, ...rest } = spawnErrors;
            spawnErrors = rest;
          }
        },
        onSessions: (result) => (runnerSessions = result),
        onAttachRejected: (payload) => {
          // wrapper-side upload rejection (file-upload spec / ADR-0025);
          // surface to operator via the shared transient notice channel.
          showNotice(
            `添付却下: ${payload.upload_id} (${payload.reason}${
              payload.detail !== undefined ? ` — ${payload.detail}` : ""
            })`,
          );
        },
        onInstructionRejected: (payload) => {
          showNotice(
            `指示却下: ${payload.reason}${
              payload.detail !== undefined ? ` — ${payload.detail}` : ""
            }`,
          );
        },
        // phase-17 17-9: session-reset lifecycle events. `started` /
        // `completed` update a per-agent progress flag consumed by
        // AgentDetail's Composer disable / progress indicator. `failed`
        // additionally surfaces a loud notice with the closed-vocab
        // reason so the operator sees why (agent_busy /
        // unsupported_session_reset / session_reset_pending /
        // runner_unavailable / spawn_failed / rollback_failed / timeout).
        onSessionResetStarted: (payload) => {
          sessionResets = { ...sessionResets, [payload.agent_id]: payload.mode };
        },
        onSessionResetCompleted: (payload) => {
          const { [payload.agent_id]: _drop, ...rest } = sessionResets;
          void _drop;
          sessionResets = rest;
        },
        onSessionResetFailed: (payload) => {
          const { [payload.agent_id]: _drop, ...rest } = sessionResets;
          void _drop;
          sessionResets = rest;
          showNotice(
            `session_reset 失敗 (${payload.mode}): ${payload.reason}`,
          );
        },
      },
      connectOpts,
    );

    // Slide the httpOnly cookie while this tab is open so future reloads can
    // still mint a ticket (ADR-0013). On 401 the session is gone
    // (revoked/expired) — tear down and fall back to the login form.
    const refresh = (): void => {
      void fetch("/session/refresh").then(
        (r) => {
          // Guard against an in-flight refresh resolving after teardown.
          if (r.status === 401 && !destroyed) {
            endSession();
            needLogin = true;
          }
        },
        () => {},
      );
    };
    if (slideNow) refresh();
    refreshTimer = setInterval(refresh, 12 * 60 * 60 * 1000);
  }

  // Tears down the live socket and its slide timer without touching the
  // cookie; the caller decides what to show next.
  function endSession(): void {
    if (refreshTimer !== undefined) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
    connection?.disconnect();
    connection = null;
    // Hide the launch UI until the next connection re-announces hosts; a
    // revoked/expired session must not keep the operator affordance.
    hosts = [];
    isOperator = false;
    showLaunch = false;
    runnerSessions = null;
    // Clear the identity ledger overlay so a re-connect / login starts
    // clean; the next `directory` push repopulates for operators.
    directory = {};
    spawnErrors = {};
  }

  // Bulk restore of every offline entry (ADR-0030 D5). Confirms once, then
  // fires the same per-agent restore call the tile button uses — one at a
  // time in a for-loop, since spawn broadcasts are fire-and-forget and each
  // is guarded by the runner's in-flight lock (ADR-0030 D11).
  async function restoreAllOffline(): Promise<void> {
    if (!connection || offlineEntries.length === 0) return;
    const count = offlineEntries.length;
    if (!confirm(`${count} 体のオフラインエージェントを一括復元します。よろしいですか?`)) {
      return;
    }
    for (const tile of offlineEntries) {
      try {
        await connection.restore(tile.id);
      } catch (err) {
        // Record locally too — spawn_result will land later for successful
        // restores, but a per-restore RPC-level error (rare) still needs
        // surfacing so the tile picks up the icon.
        spawnErrors = {
          ...spawnErrors,
          [tile.id]: err instanceof Error ? err.message : "error",
        };
      }
    }
  }

  // Bulk purge uses the same guarded server operation as each tile's delete
  // button. Snapshot the ids before starting because every successful delete
  // broadcasts `agent_deleted`, which shrinks `offlineEntries` as we iterate.
  async function deleteAllOffline(): Promise<void> {
    if (!connection || offlineEntries.length === 0 || deletingAllOffline) return;
    const ids = offlineEntries.map((tile) => tile.id);
    if (
      !confirm(
        `${ids.length} 体のオフラインエージェントを完全に削除します。` +
          "\n会話の復元情報も削除されます。この操作は取り消せません。よろしいですか?",
      )
    ) {
      return;
    }

    deletingAllOffline = true;
    let failed = 0;
    try {
      for (const id of ids) {
        try {
          await connection.deleteAgent(id);
        } catch {
          failed += 1;
        }
      }
    } finally {
      deletingAllOffline = false;
    }

    if (failed > 0) {
      showNotice(`${failed} 体を削除できませんでした`);
    }
  }

  // Mints a short-lived WS ticket from the current httpOnly cookie and opens
  // the socket; no usable cookie/ticket falls back to the login form. Shared
  // by the reload path and post-login: both already hold a valid cookie and
  // must connect via the ticket so the reusable token never rides the WS
  // upgrade URL / access logs (ADR-0013).
  async function connectFromCookie(): Promise<void> {
    try {
      const res = await fetch("/session/ticket");
      if (res.ok) {
        const body = (await res.json()) as { ticket?: string };
        if (typeof body.ticket === "string") {
          if (!destroyed) startSession({ ticket: body.ticket }, true);
          return;
        }
      }
    } catch {
      // No cookie / network error: fall through to the login form.
    }
    if (!destroyed) needLogin = true;
  }

  // Login form submit: exchange the typed token for the cookie, then connect.
  async function login(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const token = loginToken.trim();
    if (token === "" || loginBusy) return;
    loginBusy = true;
    loginError = null;
    try {
      // Token in the POST body, not the URL, so it stays out of access logs.
      const res = await fetch("/session/new", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        loginError = "トークンが無効です。";
        return;
      }
    } catch {
      loginError = "サーバに接続できませんでした。";
      return;
    } finally {
      loginBusy = false;
    }
    loginToken = "";
    needLogin = false;
    // Connect via a ticket minted from the just-set cookie, not the raw
    // token, so the shared secret never rides the WS upgrade URL / access
    // logs — same as the reload path (ADR-0013).
    await connectFromCookie();
  }

  // Logout (#47): drop the server session + cookie, force-close the socket,
  // and return to the login form. Re-entry needs a token (no personal
  // accounts yet — issue #65), so confirm to avoid an accidental logout.
  async function logout(): Promise<void> {
    if (!confirm("ログアウトしますか?")) return;
    try {
      await fetch("/session", { method: "DELETE" });
    } catch {
      // Drop the local session even if the request fails, so the operator
      // is never stuck on a dead or forbidden socket.
    }
    endSession();
    // Don't keep the previous session's data behind the login form.
    agents = {};
    logs = {};
    selected = null;
    needLogin = true;
  }

  onMount(() => {
    // Cards render the CSS face until the manifest arrives (or on
    // fetch failure), then swap to persona sprites.
    fetchPersonaManifest().then((next) => (manifest = next));

    // Ask once so wait-state hand-offs can raise a desktop notification (#7).
    requestNotificationPermission();

    void (async () => {
      // Auth (ADR-0011/0013). A `?token=` in the URL is the first load (dev
      // Vite, or a direct link): set the httpOnly cookie so reloads can mint
      // a ticket, authenticate this load with the token, then scrub the URL.
      const urlToken = new URLSearchParams(location.search).get("token");

      if (urlToken !== null) {
        // Token in the POST body, not the query string, so it does not land
        // in proxy/server access logs (the request-line URL is logged even
        // though Phoenix filters the token param).
        void fetch("/session/new", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: urlToken }),
        }).then(
          (r) => {
            if (!r.ok) {
              console.warn("kaoiro: session cookie set failed", r.status);
            }
          },
          () => console.warn("kaoiro: session cookie request failed"),
        );
        const scrubbed = new URL(location.href);
        scrubbed.searchParams.delete("token");
        history.replaceState(null, "", scrubbed);
        if (!destroyed) startSession({ token: urlToken }, false);
      } else {
        // Reload path: the token lives only in the httpOnly cookie, which
        // cannot ride the WS upgrade (Vite proxy / cross-origin) — mint a
        // ticket from it. With no usable cookie, connectFromCookie shows the
        // login form rather than failing closed silently (案A). The token
        // itself never reaches JS on this path.
        await connectFromCookie();
      }
      // The auth check is done; reveal the form or dashboard instead of the
      // neutral loading state.
      if (!destroyed) authChecked = true;
    })();

    return () => {
      destroyed = true;
      endSession();
    };
  });
</script>

{#if needLogin}
  <main class="login">
    <form class="login-card" onsubmit={login}>
      <h1>kaoiro</h1>
      <p class="login-note">アクセストークンを入力してください。</p>
      <input
        type="password"
        bind:value={loginToken}
        placeholder="トークン"
        autocomplete="off"
        aria-label="アクセストークン"
      />
      {#if loginError}
        <p class="login-error" role="alert">{loginError}</p>
      {/if}
      <button type="submit" disabled={loginBusy || loginToken.trim() === ""}>
        {loginBusy ? "確認中…" : "ログイン"}
      </button>
    </form>
  </main>
{:else if authChecked}
<header>
  <h1>kaoiro</h1>
  {#if selectedEnvelope && sorted.length > 1}
    <nav class="agent-strip" aria-label="エージェント一覧">
      {#each sorted as envelope (envelope.agent_id)}
        {@const expr = expressionFor(envelope.state)}
        {@const sprite = spriteUrlFor(
          manifest,
          envelope.persona?.sprite_set,
          envelope.state,
        )}
        <button
          type="button"
          class="chip"
          class:current={envelope.agent_id === selected}
          data-state={expr.variant}
          aria-current={envelope.agent_id === selected ? "true" : undefined}
          title="{envelope.persona?.name ?? envelope.agent_id} — {expr.label}"
          onclick={() => {
            origin = null;
            selected = envelope.agent_id;
          }}
        >
          {#if sprite}
            <img class="thumb" src={sprite} alt="" />
          {:else}
            <div class="face" aria-hidden="true">
              <span class="eye left"></span>
              <span class="eye right"></span>
              <span class="mouth"></span>
            </div>
          {/if}
          <span class="lamp"></span>
        </button>
      {/each}
    </nav>
  {/if}
  <div class="session">
    {#if isOperator && connection}
      <button type="button" class="launch" onclick={() => (showLaunch = true)}>
        + 起動
      </button>
    {/if}
    <p class="conn" data-status={status}>
      <span class="conn-dot"></span>{status}
    </p>
    <button type="button" class="logout" onclick={logout}>ログアウト</button>
  </div>
</header>

{#if spawnNoticeText}
  <p class="spawn-notice" role="status">{spawnNoticeText}</p>
{/if}

{#if showLaunch && connection}
  <LaunchDialog
    {hosts}
    {connection}
    sessions={runnerSessions}
    onClose={() => (showLaunch = false)}
  />
{/if}

<main>
  {#if selectedEnvelope}
    <AgentDetail
      envelope={selectedEnvelope}
      logs={logs[selectedEnvelope.agent_id] ?? []}
      {agents}
      {connection}
      {manifest}
      sessions={runnerSessions}
      resetMode={sessionResets[selectedEnvelope.agent_id] ?? null}
      {origin}
      onClose={() => (selected = null)}
      onSelectAgent={(id) => {
        // Inter-agent bubble の peer ボタンから呼ばれる。 origin はタイルの
        // 中心ではなく detail 内クリック由来なので null に倒し、 既存の
        // expand-from-origin アニメは省略 (相手が既知 agent ならグリッドで
        // 再選択した時と同じ素直な切替えが得られる)。
        if (agents[id]) {
          origin = null;
          selected = id;
        }
      }}
    />
  {:else if sorted.length === 0 && offlineEntries.length === 0}
    <p class="empty">
      no agents yet — start a wrapper with <code>server_url</code> set.
    </p>
  {:else}
    <ul class="agents">
      {#each sorted as envelope, index (envelope.agent_id)}
        <li style:--stagger="{index * 60}ms">
          <AgentCard
            {envelope}
            {manifest}
            spawnError={spawnErrors[envelope.agent_id] ?? null}
            onSelect={(o) => {
              origin = o ?? null;
              selected = envelope.agent_id;
            }}
            onInterrupt={connection
              ? () => connection!.sendInterrupt(envelope.agent_id)
              : undefined}
            onStop={connection
              ? () =>
                  connection!
                    .stop(envelope.agent_id)
                    .catch((e) => notifyActionError("終了", e))
              : undefined}
            onRestore={connection
              ? () =>
                  connection!
                    .restore(envelope.agent_id)
                    .catch((e) => notifyActionError("復帰", e))
              : undefined}
            onDelete={connection
              ? () => connection!.deleteAgent(envelope.agent_id)
              : undefined}
          />
        </li>
      {/each}
    </ul>
  {/if}
  {#if selectedEnvelope === null && isOperator && offlineEntries.length > 0}
    <!-- Offline agents (ADR-0030): directory-only (server restarted) OR live
         disconnected (wrapper died but server survived — hot reload etc.).
         Collapsed by default so the live section stays uncluttered; expand +
         "前回の状態を復元" surfaces the restore affordance. Live-disconnected
         tiles keep click-to-detail so the operator can still browse the
         transcript history; directory-only tiles have no live envelope to
         detail against, so they stay non-interactive (offline label + no click). -->
    <details class="offline">
      <summary>
        オフライン({offlineEntries.length})
        {#if connection}
          <button
            type="button"
            class="restore-all"
            onclick={(e) => {
              e.preventDefault();
              void restoreAllOffline();
            }}
            title="オフライン全体を一括復元"
          >
            前回の状態を復元
          </button>
          <button
            type="button"
            class="delete-all"
            disabled={deletingAllOffline}
            onclick={(e) => {
              e.preventDefault();
              void deleteAllOffline();
            }}
            title="オフライン全体を台帳ごと削除"
          >
            {deletingAllOffline ? "削除中…" : "すべて削除"}
          </button>
        {/if}
      </summary>
      <ul class="agents">
        {#each offlineEntries as tile, index (tile.id)}
          <li style:--stagger="{index * 60}ms">
            <AgentCard
              envelope={tile.envelope}
              {manifest}
              directoryOnly={tile.directoryOnly}
              spawnError={spawnErrors[tile.id] ?? null}
              onSelect={tile.directoryOnly
                ? undefined
                : (o) => {
                    origin = o ?? null;
                    selected = tile.id;
                  }}
              onRestore={connection
                ? () =>
                    connection!
                      .restore(tile.id)
                      .catch((e) => notifyActionError("復帰", e))
                : undefined}
              onDelete={connection
                ? () => connection!.deleteAgent(tile.id)
                : undefined}
            />
          </li>
        {/each}
      </ul>
    </details>
  {/if}
</main>
{:else}
  <main class="login">
    <p class="login-note">接続中…</p>
  </main>
{/if}

<style>
  header {
    flex: 0 0 auto;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 1.6rem 2rem 0.4rem;
    border-bottom: 1px solid var(--line);
  }

  h1 {
    margin: 0;
    font-size: var(--fs-h1);
    letter-spacing: 0.35em;
    text-transform: lowercase;
    color: var(--fg);
  }

  h1::after {
    content: "— 顔色";
    margin-left: 0.6em;
    letter-spacing: 0;
    color: var(--fg-dim);
    font-size: 0.8em; /* em-relative to parent h1; do not tokenize */
  }

  .conn {
    margin: 0;
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
  }

  .conn-dot {
    display: inline-block;
    width: 0.55em;
    height: 0.55em;
    margin-right: 0.5em;
    border-radius: 50%;
    background: var(--fg-dim);
  }

  .conn[data-status="connected"] .conn-dot {
    background: var(--c-waiting_input);
    box-shadow: 0 0 6px var(--c-waiting_input);
  }

  .conn[data-status="disconnected"] .conn-dot {
    background: var(--c-error);
  }

  /* Detail view only: a compact strip of every agent's state lamp, sitting
     between the title and the connection badge, for quick switching (#16).
     space-between in the header drops it to centre when present. */
  .agent-strip {
    align-self: center;
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    align-items: center;
    gap: 0.45rem;
    min-width: 0;
  }

  /* Each agent now reads as a miniature grid tile: the persona sprite shrunk
     into a small cell with its state lamp overlaid on the top-right corner. */
  .chip {
    --tone: var(--c-idle);
    position: relative;
    display: inline-flex;
    width: 2.4rem;
    height: 2.4rem;
    padding: 0.15rem;
    border: 1px solid transparent;
    border-radius: 0.4rem;
    background: var(--bg-card);
    line-height: 0;
    cursor: pointer;
    transition: border-color 0.2s;
  }

  .chip:hover {
    border-color: var(--line);
  }

  .chip.current {
    border-color: var(--tone);
  }

  /* Shrunk persona sprite filling the cell; disconnected greys out like the
     grid cards (personas.md). */
  .chip .thumb {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .chip[data-state="disconnected"] .thumb {
    filter: grayscale(1);
    opacity: 0.45;
  }

  /* Fallback when the manifest has no sprite (#35 default ペルソナ等):
     state-coloured disc with simplified eyes/mouth so it reads as a face,
     not a bare dot next to sprite-bearing neighbours. State is already on
     the .lamp corner dot, so per-state eye/mouth expressions are skipped
     here -- the chip is 2.4rem and per-state nuance would not be legible. */
  .chip .face {
    position: relative;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    background: color-mix(in srgb, var(--tone) 28%, var(--bg-card));
    border: 1px solid var(--tone);
  }

  .chip .face .eye {
    position: absolute;
    top: 38%;
    width: 12%;
    height: 12%;
    border-radius: 50%;
    background: var(--fg);
  }

  .chip .face .eye.left { left: 28%; }
  .chip .face .eye.right { right: 28%; }

  .chip .face .mouth {
    position: absolute;
    bottom: 26%;
    left: 50%;
    translate: -50% 0;
    width: 30%;
    height: 12%;
    border-bottom: 1.5px solid var(--fg);
    border-radius: 0 0 50% 50% / 0 0 100% 100%;
  }

  .chip .lamp {
    position: absolute;
    top: 0.1rem;
    right: 0.1rem;
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: var(--tone);
    box-shadow: 0 0 6px var(--tone);
  }

  .chip[data-state="sending"] { --tone: var(--c-sending); }
  .chip[data-state="thinking"] { --tone: var(--c-thinking); }
  .chip[data-state="tool_running"] { --tone: var(--c-tool_running); }
  .chip[data-state="waiting_permission"] {
    --tone: var(--c-waiting_permission);
  }
  .chip[data-state="waiting_input"] { --tone: var(--c-waiting_input); }
  .chip[data-state="done"] { --tone: var(--c-done); }
  .chip[data-state="error"] { --tone: var(--c-error); }
  .chip[data-state="disconnected"] { --tone: var(--c-disconnected); }

  /* Fills the viewport below the header; the active view (grid or detail)
     scrolls inside here so the detail composer can pin to the bottom (#33). */
  main {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 1.6rem 2rem 3rem;
  }

  .empty {
    margin-top: 3rem;
    text-align: center;
    color: var(--fg-dim);
    font-size: var(--fs-body);
  }

  .agents {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
    gap: 1.2rem;
  }

  .agents > li {
    animation: rise 0.45s ease-out backwards;
    animation-delay: var(--stagger, 0ms);
  }

  /* Offline section (ADR-0030): collapsed by default; the restore button
     sits in the summary so it never crowds the header. */
  .offline {
    margin-top: 2rem;
    border-top: 1px solid var(--line);
    padding-top: 1rem;
  }

  .offline > summary {
    display: flex;
    align-items: center;
    gap: 0.8rem;
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
    cursor: pointer;
    padding: 0.2rem 0;
    user-select: none;
  }

  .offline > summary::-webkit-details-marker {
    color: var(--fg-dim);
  }

  .offline .agents {
    margin-top: 1rem;
  }

  .restore-all {
    font-size: var(--fs-body-sm);
    color: var(--fg);
    background: var(--bg-card);
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    padding: 0.2rem 0.6rem;
    cursor: pointer;
    transition:
      color 0.2s,
      border-color 0.2s;
  }

  .restore-all:hover {
    border-color: var(--fg-dim);
  }

  .delete-all {
    font-size: var(--fs-body-sm);
    color: var(--c-error);
    background: var(--bg-card);
    border: 1px solid color-mix(in srgb, var(--c-error) 55%, var(--line));
    border-radius: 0.4rem;
    padding: 0.2rem 0.6rem;
    cursor: pointer;
    transition:
      color 0.2s,
      border-color 0.2s;
  }

  .delete-all:hover:not(:disabled) {
    border-color: var(--c-error);
  }

  .delete-all:disabled {
    opacity: 0.55;
    cursor: default;
  }

  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(0.6rem);
    }
  }

  /* Connection badge + logout grouped at the header's right edge so
     space-between keeps the title left and this cluster right. */
  .session {
    display: flex;
    align-items: center;
    gap: 0.8rem;
  }

  .logout {
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    padding: 0.25rem 0.6rem;
    cursor: pointer;
    transition:
      color 0.2s,
      border-color 0.2s;
  }

  .logout:hover {
    color: var(--fg);
    border-color: var(--fg-dim);
  }

  .launch {
    font-size: var(--fs-body-sm);
    color: var(--fg);
    background: var(--bg-card);
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    padding: 0.25rem 0.7rem;
    cursor: pointer;
    transition:
      color 0.2s,
      border-color 0.2s;
  }

  .launch:hover {
    border-color: var(--fg-dim);
  }

  .spawn-notice {
    flex: 0 0 auto;
    margin: 0;
    padding: 0.4rem 2rem;
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
    background: var(--bg-card);
    border-bottom: 1px solid var(--line);
  }

  /* Token-entry login (案A): a centred card filling the main area when there
     is no live session. */
  .login {
    display: flex;
    align-items: flex-start;
    justify-content: center;
  }

  .login-card {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    width: min(22rem, 90vw);
    margin-top: 8vh;
    padding: 2rem;
    border: 1px solid var(--line);
    border-radius: 0.6rem;
    background: var(--bg-card);
  }

  .login-card h1 {
    margin: 0;
    font-size: var(--fs-h1);
    letter-spacing: 0.35em;
    text-transform: lowercase;
    text-align: center;
    color: var(--fg);
  }

  .login-note {
    margin: 0;
    font-size: var(--fs-body-sm);
    text-align: center;
    color: var(--fg-dim);
  }

  .login-card input {
    padding: 0.6rem 0.7rem;
    font-size: var(--fs-input);
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 0.4rem;
  }

  .login-error {
    margin: 0;
    font-size: var(--fs-body-sm);
    color: var(--c-error);
  }

  .login-card button {
    padding: 0.55rem;
    font-size: var(--fs-body);
    color: var(--fg);
    background: var(--bg-card);
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    cursor: pointer;
  }

  .login-card button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
