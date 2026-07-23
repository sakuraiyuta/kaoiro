<script lang="ts">
  import { spriteUrlFor } from "./expression";
  import { latestReplies } from "./latestReply";
  import { formatRelativeJa } from "./relativeTime";
  import type { Envelope, PersonaManifest } from "./protocol";

  let {
    agents,
    logs,
    manifest = null,
    now,
    onSelectAgent,
  }: {
    /** Latest state map from App.svelte, used only for persona lookup
     *  (name + sprite_set) — this pane never mutates or filters by
     *  state, so a disconnected agent whose latest reply predates its
     *  disconnect still shows here. */
    agents: Record<string, Envelope>;
    /** Full transcript map (App.svelte's `logs`). The pane derives one
     *  entry per agent from the assistant/result envelopes inside; agents
     *  with no assistant/result envelope are omitted so the timeline shows
     *  only rows with actual content. */
    logs: Record<string, Envelope[]>;
    manifest?: PersonaManifest | null;
    /** Millisecond clock owned by the parent (App.svelte). Passed in so
     *  the pane refreshes as the clock ticks without each row calling
     *  Date.now on its own — critical for test determinism. */
    now: number;
    /** Row click → open detail for that agent. App.svelte handles
     *  origin=null so the click does not try to animate from a
     *  non-existent tile centre. */
    onSelectAgent: (agentId: string) => void;
  } = $props();

  const entries = $derived(latestReplies(logs));

  function personaName(agentId: string): string {
    const p = agents[agentId]?.persona;
    return p?.name ?? agentId;
  }

  function personaSprite(agentId: string, state: string): string | null {
    const p = agents[agentId]?.persona;
    return spriteUrlFor(manifest, p?.sprite_set, state);
  }

  function stateFor(agentId: string): string {
    return agents[agentId]?.state ?? "idle";
  }
</script>

<aside class="timeline" aria-label="最新応答タイムライン">
  <h2 class="title">最新応答</h2>
  {#if entries.length === 0}
    <p class="empty">まだ応答なし</p>
  {:else}
    <ul class="rows">
      {#each entries as entry (entry.agentId)}
        {@const state = stateFor(entry.agentId)}
        {@const sprite = personaSprite(entry.agentId, state)}
        <li>
          <button
            type="button"
            class="row"
            onclick={() => onSelectAgent(entry.agentId)}
            title={`${personaName(entry.agentId)} の詳細を開く`}
          >
            <span class="portrait" aria-hidden="true">
              {#if sprite}
                <img src={sprite} alt="" />
              {:else}
                <span class="portrait-fallback">👤</span>
              {/if}
            </span>
            <span class="meta">
              <span class="row-head">
                <span class="name">{personaName(entry.agentId)}</span>
                <span class="when">{formatRelativeJa(entry.envelope.ts, now)}</span>
              </span>
              <span class="summary">
                {entry.summary || "(空応答)"}
              </span>
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</aside>

<style>
  .timeline {
    display: flex;
    flex-direction: column;
    min-height: 0;
    max-height: 100%;
    padding: 0.75rem 0.85rem 1rem;
    border: 1px solid var(--line);
    border-radius: 0.75rem;
    background: color-mix(in srgb, var(--bg-card) 70%, transparent);
    overflow: hidden;
  }

  .title {
    margin: 0 0 0.65rem;
    font-size: var(--fs-body);
    font-weight: 600;
    color: var(--fg-dim);
    letter-spacing: 0.02em;
  }

  .empty {
    margin: 0.35rem 0 0;
    color: var(--fg-dim);
    font-size: var(--fs-body-sm);
  }

  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    overflow-y: auto;
    min-height: 0;
  }

  .row {
    display: flex;
    align-items: flex-start;
    gap: 0.55rem;
    width: 100%;
    padding: 0.5rem 0.6rem;
    border: 1px solid transparent;
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--bg-card) 88%, transparent);
    color: inherit;
    text-align: left;
    font: inherit;
    cursor: pointer;
    transition:
      border-color 0.12s,
      background 0.12s;
  }

  .row:hover,
  .row:focus-visible {
    border-color: var(--c-thinking);
    background: color-mix(in srgb, var(--c-thinking) 8%, var(--bg-card));
    outline: none;
  }

  .portrait {
    flex: 0 0 auto;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: 50%;
    overflow: hidden;
    background: color-mix(in srgb, var(--bg-card) 60%, transparent);
    display: grid;
    place-items: center;
  }

  .portrait img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .portrait-fallback {
    font-size: 1.2rem;
    line-height: 1;
  }

  .meta {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
    flex: 1 1 auto;
  }

  .row-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.5rem;
    font-size: var(--fs-body-sm);
  }

  .name {
    font-weight: 600;
    color: var(--fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .when {
    flex: 0 0 auto;
    color: var(--fg-dim);
    font-size: var(--fs-caption, var(--fs-body-sm));
    white-space: nowrap;
  }

  .summary {
    color: var(--fg-dim);
    font-size: var(--fs-body-sm);
    line-height: 1.35;
    display: -webkit-box;
    -webkit-line-clamp: 1;
    line-clamp: 1;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
</style>
