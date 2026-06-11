<script lang="ts">
  import { onMount } from "svelte";
  import AgentCard from "./lib/AgentCard.svelte";
  import type {
    ConnectionStatus,
    Envelope,
    PersonaManifest,
  } from "./lib/protocol";
  import {
    connectKaoiro,
    defaultSocketUrl,
    fetchPersonaManifest,
  } from "./lib/protocol";

  let agents = $state<Record<string, Envelope>>({});
  let status = $state<ConnectionStatus>("connecting");
  let manifest = $state<PersonaManifest | null>(null);

  const sorted = $derived(
    Object.values(agents).sort((a, b) => a.agent_id.localeCompare(b.agent_id)),
  );

  onMount(() => {
    // Cards render the CSS face until the manifest arrives (or on
    // fetch failure), then swap to persona sprites.
    fetchPersonaManifest().then((next) => (manifest = next));

    const connection = connectKaoiro(defaultSocketUrl(location), {
      onStatus: (next) => (status = next),
      onSnapshot: (next) => (agents = next),
      onEnvelope: (envelope) => {
        agents = { ...agents, [envelope.agent_id]: envelope };
      },
    });
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
  {#if sorted.length === 0}
    <p class="empty">
      no agents yet — start a wrapper with <code>server_url</code> set.
    </p>
  {:else}
    <ul class="agents">
      {#each sorted as envelope, index (envelope.agent_id)}
        <li style:--stagger="{index * 60}ms">
          <AgentCard {envelope} {manifest} />
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
