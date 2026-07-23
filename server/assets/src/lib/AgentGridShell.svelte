<script lang="ts">
  // ふじ A1 must-fix (2026-07-23, 3rd review): extract the response-
  // timeline layout gate out of App.svelte so the integration test can
  // mount the SAME production component instead of a hand-built
  // <div>/<ul> stand-in. `shouldShowResponseTimeline(wide, operator)`
  // is the single source of truth for both class toggles AND the
  // aside mount — the pre-A1 test computed the gate in test-scope
  // (`wide && operator`) and did not observe stubMatchMedia's effect.
  //
  // Kept minimal: the outer `.grid-with-timeline` div + `.agents` ul
  // + optional ResponseTimeline aside. The tile list rides through
  // the `children` snippet so App.svelte's tile props/handlers
  // remain untouched.
  //
  // CSS is co-located here; `> :global(li)` opts out of Svelte's
  // scoped-class rewrite so App's slotted `<li>` tiles still receive
  // the stagger animation.

  import ResponseTimeline from "./ResponseTimeline.svelte";
  import { shouldShowResponseTimeline } from "./protocol";
  import type { DirectoryEntry, Envelope, PersonaManifest } from "./protocol";
  import type { Snippet } from "svelte";

  let {
    wide,
    operator,
    fitViewport = false,
    agents,
    directory,
    logs,
    manifest,
    now,
    onSelectAgent,
    children,
  }: {
    wide: boolean;
    operator: boolean;
    fitViewport?: boolean;
    agents: Record<string, Envelope>;
    directory: Record<string, DirectoryEntry>;
    logs: Record<string, Envelope[]>;
    manifest: PersonaManifest | null;
    now: number;
    onSelectAgent: (agentId: string) => void;
    children?: Snippet;
  } = $props();

  const showTimeline = $derived(shouldShowResponseTimeline(wide, operator));
</script>

<div
  class="grid-with-timeline"
  class:with-timeline={showTimeline}
  class:fit-viewport={fitViewport}
>
  <ul class="agents" class:three-cols={showTimeline}>
    {@render children?.()}
  </ul>
  {#if showTimeline}
    <ResponseTimeline {agents} {directory} {logs} {manifest} {now} {onSelectAgent} />
  {/if}
</div>

<style>
  .agents {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
    gap: 1.2rem;
  }

  /* #25: wide viewport (≥ 1600px), operator only. Pin the grid to 3
     columns and expose the right pane for the response timeline. Only
     applied via the class binding in the template, so the narrow
     viewport keeps the auto-fill grid — no CSS query is checked here. */
  .agents.three-cols {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .grid-with-timeline.with-timeline {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(22rem, 26rem);
    gap: 1.5rem;
    align-items: start;
    /* Timeline uses its own scroll so long agent lists on the left do
       not push the timeline out of the viewport. */
    min-height: 0;
  }

  /* When App has an offline section, the live dashboard gets only the
     viewport height left after that section. Both the card grid and timeline
     scroll inside this bounded region; outside that state, preserve the
     existing page-flow layout. */
  .grid-with-timeline.fit-viewport {
    block-size: 100%;
    min-block-size: 0;
  }

  .grid-with-timeline.with-timeline.fit-viewport {
    grid-template-rows: minmax(0, 1fr);
    align-items: stretch;
  }

  .fit-viewport .agents {
    block-size: 100%;
    min-block-size: 0;
    overflow-y: auto;
    align-content: start;
  }

  .fit-viewport :global(.timeline) {
    block-size: 100%;
    max-block-size: none;
  }

  /* Slotted <li> tiles receive their `data-svelte-*` scope from
     App.svelte, so drop out of Svelte's rewriter to keep the stagger
     animation. */
  .agents > :global(li) {
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
