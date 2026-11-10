<script lang="ts">
  // The pinned area of the member detail view (issue 1074): the ctx and
  // rate-limit gauges and the status line, kept in view without scrolling.
  // AgentDetail mounts it twice at fixed places — under the agent ID
  // (placement "head") and above the log (placement "main") — and CSS shows
  // exactly one per width (ADR-0052 F6 and its 2026-11-10 amendment). The
  // gauge rows come from AgentDetail as a snippet, so their values, gating
  // and styles stay where they are computed.
  import type { Snippet } from "svelte";
  import { msg } from "./i18n/index.svelte";
  import type { StatusLineView } from "./statusLine";
  import StatusLinePanel from "./StatusLinePanel.svelte";

  let {
    placement,
    gauges,
    statusLine,
    onOpenHistory,
    expanded,
    onToggleExpanded,
    open,
    onToggleOpen,
  }: {
    placement: "head" | "main";
    /** The gauge rows; undefined when AgentDetail draws none. */
    gauges: Snippet | undefined;
    statusLine: StatusLineView;
    onOpenHistory?: (() => void) | undefined;
    /** Status line expanded in place; shared by both placements. */
    expanded: boolean;
    onToggleExpanded: () => void;
    /** Narrow-layout disclosure; only CSS at 939px and narrower reads it. */
    open: boolean;
    onToggleOpen: () => void;
  } = $props();

  const bodyId = $derived(`pinned-status-body-${placement}`);
  const regionId = $derived(`pinned-status-region-${placement}`);

  let bodyEl = $state<HTMLDivElement | null>(null);
  let overflowing = $state(false);

  // Measured per placement: a copy hidden with display:none measures 0/0, and
  // the observer fires again on its 0 -> size change once it is displayed.
  // statusLine is read so a new head re-measures even when the clamped box
  // keeps its height (3 lines before and after).
  $effect(() => {
    const el = bodyEl;
    void statusLine;
    if (el === null || expanded) return;
    const measure = (): void => {
      overflowing = el.scrollHeight > el.clientHeight + 1;
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  });

  const showToggle = $derived(bodyEl !== null && (expanded || overflowing));
</script>

{#if gauges !== undefined || statusLine.kind !== "none"}
  <section
    class="pinned"
    data-placement={placement}
    data-open={open ? "true" : "false"}
    aria-label={msg().agentDetail.pinnedLabel}
  >
    <button
      type="button"
      class="disclosure"
      aria-expanded={open}
      aria-controls={regionId}
      onclick={onToggleOpen}
    >{msg().agentDetail.pinnedDisclosure}</button>
    <div class="pinned-body" id={regionId}>
      {#if gauges !== undefined}{@render gauges()}{/if}
      <StatusLinePanel
        view={statusLine}
        {onOpenHistory}
        clamp={true}
        {expanded}
        {bodyId}
        bind:bodyEl
      />
      {#if showToggle}
        <button
          type="button"
          class="expand"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onclick={onToggleExpanded}
        >{expanded ? msg().agentDetail.pinnedShowLess : msg().agentDetail.pinnedShowAll}</button>
      {/if}
    </div>
  </section>
{/if}

<style>
  .pinned {
    min-width: 0;
  }

  .pinned-body {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    min-width: 0;
  }

  /* StatusLinePanel's own bottom margin would double the gap. */
  .pinned-body :global(.status-line-panel) {
    margin: 0;
  }

  .disclosure {
    display: none;
  }

  .disclosure,
  .expand {
    align-self: flex-start;
    border: none;
    background: none;
    padding: 0;
    font: inherit;
    font-size: var(--fs-caption);
    color: var(--fg);
    opacity: 0.75;
    text-decoration: underline;
    cursor: pointer;
  }

  .disclosure:hover,
  .disclosure:focus-visible,
  .expand:hover,
  .expand:focus-visible {
    opacity: 1;
  }

  .disclosure::before {
    content: "▸ ";
  }

  .pinned[data-open="true"] .disclosure::before {
    content: "▾ ";
  }

  @media (max-width: 939px) {
    .pinned[data-placement="main"] .disclosure {
      display: inline-block;
    }

    .pinned[data-placement="main"]:not([data-open="true"]) .pinned-body {
      display: none;
    }

    .pinned[data-placement="main"][data-open="true"] .pinned-body {
      margin-top: 0.4rem;
    }
  }
</style>
