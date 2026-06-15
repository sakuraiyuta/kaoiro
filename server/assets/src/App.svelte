<script lang="ts">
  import { onMount } from "svelte";
  import AgentCard from "./lib/AgentCard.svelte";
  import AgentDetail from "./lib/AgentDetail.svelte";
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

    // User token (ADR-0011) via ?token=…; omitted = dev mode. The token
    // is scrubbed from the address bar right away so it does not stick
    // around in history/bookmarks/shared links.
    const token = new URLSearchParams(location.search).get("token");
    if (token !== null) {
      const scrubbed = new URL(location.href);
      scrubbed.searchParams.delete("token");
      history.replaceState(null, "", scrubbed);
    }

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
            agents = { ...agents, [envelope.agent_id]: envelope };
          }
        },
        onHistory: (histories) => (logs = mergeHistories(histories, logs)),
      },
      token === null ? {} : { token },
    );
    return connection.disconnect;
  });
</script>

<header>
  <h1>kaoiro</h1>
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
            {connection}
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

  main {
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
