<script lang="ts">
  // Layout shell for the agent grid + optional response-timeline pane.
  // `shouldShowResponseTimeline(operator)` is the single source of
  // truth for the class toggles AND the aside mount. The pane rides
  // an operator-only gate (ADR-0012 — reply logs are operator-only);
  // the previous wide-viewport threshold (#25, `min-width: 1600px`)
  // was removed on 2026-07-24 so the pane shows at all widths.
  //
  // Kept minimal: the outer `.grid-with-timeline` div + `.agents` ul
  // + optional ResponseTimeline aside. The tile list rides through
  // the `children` snippet so App.svelte's tile props/handlers
  // remain untouched.
  //
  // CSS is co-located here; `> :global(li)` opts out of Svelte's
  // scoped-class rewrite so App's slotted `<li>` tiles still receive
  // the stagger animation.

  import BottomSheet from "./BottomSheet.svelte";
  import ResponseTimeline from "./ResponseTimeline.svelte";
  import type { ConversationEntry } from "./conversationTimeline";
  import { shouldShowResponseTimeline } from "./protocol";
  import type { DirectoryEntry, Envelope, PersonaManifest } from "./protocol";
  import type { Snippet } from "svelte";

  let {
    operator,
    fitViewport = false,
    agents,
    directory,
    logs,
    manifest,
    now,
    readTimelineEntryKeys = new Set<string>(),
    newTimelineEntryKeys = new Set<string>(),
    onMarkRead = () => {},
    onArrivalAnimationComplete = () => {},
    onSelectAgent,
    children,
  }: {
    operator: boolean;
    fitViewport?: boolean;
    agents: Record<string, Envelope>;
    directory: Record<string, DirectoryEntry>;
    logs: Record<string, Envelope[]>;
    manifest: PersonaManifest | null;
    now: number;
    readTimelineEntryKeys?: ReadonlySet<string>;
    newTimelineEntryKeys?: ReadonlySet<string>;
    onMarkRead?: (key: string) => void;
    onArrivalAnimationComplete?: (key: string) => void;
    onSelectAgent: (entry: ConversationEntry) => void;
    children?: Snippet;
  } = $props();

  const showTimeline = $derived(shouldShowResponseTimeline(operator));

  // Sheet-open pending lamp (responsive-layout.md MUST: シート展開中も
  // pending permission / question に気づける表示を出す)。lobby では背景
  // grid が backdrop で暗転するため、handle の lamp が唯一の signal。
  // attention バッジは出さない — lobby は既に一覧であり「一覧へ戻す」が
  // 無意味なため (シートを閉じれば grid が見える)。
  const lobbyPendingTone = $derived.by(() => {
    const values = Object.values(agents);
    if (values.some((e) => e.state === "waiting_permission")) {
      return "waiting_permission";
    }
    if (values.some((e) => e.state === "waiting_question")) {
      return "waiting_question";
    }
    return null;
  });
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
    <!-- Smartphone width sheets the timeline (ADR-0052 F1); above it the
         BottomSheet wrapper is display:contents, so the aside stays the
         grid's second column. The gate here is ROLE (operator-only pane,
         ADR-0012), never viewport size — DOM stays common across sizes
         (F6). -->
    <BottomSheet
      mode="smartphone"
      label="タイムライン"
      pendingTone={lobbyPendingTone}
    >
      <ResponseTimeline
        {agents}
        {directory}
        {logs}
        {manifest}
        {now}
        {readTimelineEntryKeys}
        {newTimelineEntryKeys}
        {onMarkRead}
        {onArrivalAnimationComplete}
        {onSelectAgent}
      />
    </BottomSheet>
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
    /* Grid's default stretch would equalize every row's card height to its
       tallest member. AgentCard's optional stats block (issue #193) now
       makes card height vary a lot more than before (badges/labels alone),
       so a stats-less neighbour would stretch far past its own content and
       strand its corner buttons well below the sprite. Each card sizes to
       its own content instead. */
    align-items: start;
  }

  /* Operator sessions with the timeline SIDE-BY-SIDE pin the grid columns
     (ADR-0052 / responsive-layout.md 領域別レイアウト規則): desktop 3 列,
     tablet 2 列 — the breakpoints are derived so tiles never drop below
     the 240px (15rem) minimum. Smartphone sheets the timeline instead, so
     the grid reverts to the same auto-fill as viewer sessions. Viewer
     sessions keep the auto-fill grid via `.agents` alone. */
  .agents.three-cols {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  @media (max-width: 1198px) {
    .agents.three-cols {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  .grid-with-timeline.with-timeline {
    display: grid;
    /* 22rem 固定 (ADR-0052 F5): the former minmax(22rem, 26rem) upper
       bound pushed the 3-column viewport floor to 1263px; every breakpoint
       in responsive-layout.md is derived from this fixed track. */
    grid-template-columns: minmax(0, 1fr) 22rem;
    gap: 1.5rem;
    align-items: start;
    /* Timeline uses its own scroll so long agent lists on the left do
       not push the timeline out of the viewport. */
    min-height: 0;
  }

  @media (max-width: 939px) {
    /* Smartphone: timeline moves into the bottom sheet (ADR-0052 F1); the
       grid takes the full width and flows column-count from auto-fill. */
    .agents.three-cols {
      grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
    }

    .grid-with-timeline.with-timeline {
      grid-template-columns: minmax(0, 1fr);
      /* Clearance so the last card row can scroll out from under the
         fixed sheet handle (the handle sits in this band at scroll end). */
      padding-bottom: 3rem;
    }

    /* Inside the sheet panel the timeline drops its side-pane sizing
       (sticky + viewport-tall) and fills the panel's flex column; its
       .rows list stays the single vertical scroll owner. */
    .grid-with-timeline.with-timeline :global(.timeline) {
      position: static;
      height: auto;
      max-height: none;
      block-size: auto;
      max-block-size: 100%;
      flex: 1 1 auto;
      min-block-size: 0;
    }
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
