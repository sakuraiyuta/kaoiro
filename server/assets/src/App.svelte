<script lang="ts">
  import { onMount } from "svelte";
  import AgentCard from "./lib/AgentCard.svelte";
  import AgentDetail from "./lib/AgentDetail.svelte";
  import { expressionFor, spriteUrlFor } from "./lib/expression";
  import type {
    ConnectionStatus,
    Envelope,
    KaoiroConnection,
    PersonaManifest,
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

  onMount(() => {
    // Cards render the CSS face until the manifest arrives (or on
    // fetch failure), then swap to persona sprites.
    fetchPersonaManifest().then((next) => (manifest = next));

    // Ask once so wait-state hand-offs can raise a desktop notification (#7).
    requestNotificationPermission();

    let cancelled = false;
    let refreshTimer: ReturnType<typeof setInterval> | undefined;

    void (async () => {
      // Auth (ADR-0011/0013). A `?token=` in the URL is the first load (dev
      // Vite, or a direct link): set the httpOnly cookie so reloads can mint
      // a ticket, authenticate this load with the token, then scrub the URL.
      // Without a URL token (reload) the token lives only in the httpOnly
      // cookie — which cannot ride the WS upgrade (Vite proxy / cross-origin)
      // — so mint a short-lived WS ticket from the cookie over HTTP and
      // connect with that. The token itself never reaches JS.
      const urlToken = new URLSearchParams(location.search).get("token");
      let connectOpts: { token?: string; ticket?: string } = {};

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
        connectOpts = { token: urlToken };
        const scrubbed = new URL(location.href);
        scrubbed.searchParams.delete("token");
        history.replaceState(null, "", scrubbed);
      } else {
        try {
          const res = await fetch("/session/ticket");
          if (res.ok) {
            const body = (await res.json()) as { ticket?: string };
            if (typeof body.ticket === "string") {
              connectOpts = { ticket: body.ticket };
            }
          }
        } catch {
          // No cookie / network error: connect unauthenticated (fail-closed).
        }
      }

      if (cancelled) return;

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
        },
        connectOpts,
      );

      // Slide the httpOnly cookie while this tab is open so future reloads
      // can still mint a ticket (ADR-0013). On 401 the session is gone
      // (revoked/expired) — drop the socket. The immediate slide runs only on
      // the reload path (a cookie already exists there); a first `?token=`
      // load just set the cookie, so its first slide is the interval.
      const refresh = (): void => {
        void fetch("/session/refresh").then(
          (r) => {
            // Guard against an in-flight refresh resolving after unmount.
            if (r.status === 401 && !cancelled) connection?.disconnect();
          },
          () => {},
        );
      };
      if (urlToken === null) refresh();
      refreshTimer = setInterval(refresh, 12 * 60 * 60 * 1000);
    })();

    return () => {
      cancelled = true;
      if (refreshTimer !== undefined) clearInterval(refreshTimer);
      connection?.disconnect();
    };
  });
</script>

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
  <p class="conn" data-status={status}>
    <span class="conn-dot"></span>{status}
  </p>
</header>

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
          />
        </li>
      {/each}
    </ul>
  {/if}
</main>

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
</style>
