<script lang="ts">
  import { onMount } from "svelte";
  import AgentCard from "./lib/AgentCard.svelte";
  import AgentDetail from "./lib/AgentDetail.svelte";
  import LaunchDialog from "./lib/LaunchDialog.svelte";
  import { expressionFor, spriteUrlFor } from "./lib/expression";
  import type {
    ConnectionStatus,
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
    fetchPersonaManifest,
    isReplyEnvelope,
  } from "./lib/protocol";
  import {
    isWaitTransition,
    notifyWait,
    requestNotificationPermission,
  } from "./lib/notify";

  let agents = $state<Record<string, Envelope>>({});
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
  // Latest resume candidates from enumerate_sessions (#22 phase-1); the
  // dialog matches them to its current host/cwd selection.
  let runnerSessions = $state<RunnerSessions | null>(null);

  function notifySpawn(result: SpawnResult): void {
    spawnNotice = result.ok
      ? `起動しました: ${result.agent_id}`
      : `起動に失敗: ${result.agent_id} (${result.reason ?? "error"})`;
    clearTimeout(spawnNoticeTimer);
    spawnNoticeTimer = setTimeout(() => (spawnNotice = null), 6000);
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
  // Append those live-buffered entries after the history (deduped by
  // ts+seq+type) so a reload never drops them.
  function mergeHistories(
    histories: Record<string, Envelope[]>,
    local: Record<string, Envelope[]>,
  ): Record<string, Envelope[]> {
    const key = (e: Envelope): string => `${e.ts}|${e.seq ?? ""}|${e.type}`;
    const merged: Record<string, Envelope[]> = { ...histories };
    for (const [id, entries] of Object.entries(local)) {
      const base = merged[id] ?? [];
      const seen = new Set(base.map(key));
      const extra = entries.filter((e) => !seen.has(key(e)));
      if (extra.length > 0) merged[id] = [...base, ...extra];
    }
    return merged;
  }

  const sorted = $derived(
    Object.values(agents).sort((a, b) => a.agent_id.localeCompare(b.agent_id)),
  );
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
            const prev = logs[envelope.agent_id] ?? [];
            logs = { ...logs, [envelope.agent_id]: [...prev, envelope] };
          } else {
            const prevState = agents[envelope.agent_id]?.state;
            agents = { ...agents, [envelope.agent_id]: envelope };
            // Alert the operator the moment an agent needs them (#7).
            if (isWaitTransition(prevState, envelope.state)) {
              notifyWait(envelope);
            }
          }
        },
        onHistory: (histories) => (logs = mergeHistories(histories, logs)),
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
        onAgentDeleted: (agentId) => {
          // A disconnected agent was removed (#14): drop it from the grid
          // and its transcript. The detail view falls back to the grid on
          // its own when the selected agent vanishes (selectedEnvelope).
          agents = Object.fromEntries(
            Object.entries(agents).filter(([id]) => id !== agentId),
          );
          if (logs[agentId]) {
            logs = Object.fromEntries(
              Object.entries(logs).filter(([id]) => id !== agentId),
            );
          }
        },
        onHosts: (next) => {
          // Operators alone receive `hosts`, so this is also the operator
          // signal that reveals the launch UI (#22).
          hosts = next;
          isOperator = true;
        },
        onSpawnResult: (result) => notifySpawn(result),
        onSessions: (result) => (runnerSessions = result),
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
            <span class="face" aria-hidden="true"></span>
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

{#if spawnNotice}
  <p class="spawn-notice" role="status">{spawnNotice}</p>
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
      {origin}
      onClose={() => (selected = null)}
    />
  {:else if sorted.length === 0}
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
            onSelect={(o) => {
              origin = o ?? null;
              selected = envelope.agent_id;
            }}
            onInterrupt={connection
              ? () => connection!.sendInterrupt(envelope.agent_id)
              : undefined}
            onStop={connection
              ? () => connection!.stop(envelope.agent_id)
              : undefined}
            onDelete={connection
              ? () => connection!.deleteAgent(envelope.agent_id)
              : undefined}
          />
        </li>
      {/each}
    </ul>
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
    font-size: 1.05rem;
    letter-spacing: 0.35em;
    text-transform: lowercase;
    color: var(--fg);
  }

  h1::after {
    content: "— 顔色";
    margin-left: 0.6em;
    letter-spacing: 0;
    color: var(--fg-dim);
    font-size: 0.8em;
  }

  .conn {
    margin: 0;
    font-size: 0.75rem;
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

  /* Fallback when the manifest has no sprite: a state-coloured disc, matching
     the detail portrait's simple face. */
  .chip .face {
    width: 100%;
    height: 100%;
    border-radius: 50%;
    background: color-mix(in srgb, var(--tone) 28%, var(--bg-card));
    border: 1px solid var(--tone);
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
    font-size: 0.85rem;
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
    font-size: 0.75rem;
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
    font-size: 0.75rem;
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
    font-size: 0.78rem;
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
    font-size: 1.05rem;
    letter-spacing: 0.35em;
    text-transform: lowercase;
    text-align: center;
    color: var(--fg);
  }

  .login-note {
    margin: 0;
    font-size: 0.8rem;
    text-align: center;
    color: var(--fg-dim);
  }

  .login-card input {
    padding: 0.6rem 0.7rem;
    font-size: 0.9rem;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 0.4rem;
  }

  .login-error {
    margin: 0;
    font-size: 0.8rem;
    color: var(--c-error);
  }

  .login-card button {
    padding: 0.55rem;
    font-size: 0.85rem;
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
