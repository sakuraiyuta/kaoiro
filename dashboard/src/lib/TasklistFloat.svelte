<script lang="ts">
  import type { TasklistSnapshot } from "./protocol";

  let {
    agentId,
    tasklist,
  }: {
    /** The selected parent agent. An AgentDetail instance is reused while
     * navigating, so this resets its local expand/collapse affordance. */
    agentId: string;
    /** The latest LWW tasklist snapshot for this detail's parent agent.
     * Null means no entity exists; an empty `items` array is retained state
     * but intentionally has no float, avoiding a meaningless 0/0 widget. */
    tasklist: TasklistSnapshot | null;
  } = $props();

  // A float begins compact so it does not cover the conversation log. The
  // button toggles the operator between this honest aggregate and the source-
  // ordered detail. AgentDetail is reused for peer navigation, so reset it
  // when the parent agent changes instead of carrying one agent's UI state
  // onto another agent's list.
  let expanded = $state(false);
  let expandedAgentId = $state<string | null>(null);
  $effect(() => {
    if (expandedAgentId !== agentId) {
      expandedAgentId = agentId;
      expanded = false;
    }
  });
  const completed = $derived(
    (tasklist?.items.filter((item) => item.status === "completed").length ?? 0) +
      (tasklist?.omitted?.completed ?? 0),
  );
  const total = $derived(
    (tasklist?.items.length ?? 0) + (tasklist?.omitted?.count ?? 0),
  );
  const visible = $derived(total > 0);

  function statusLabel(status: TasklistSnapshot["items"][number]["status"]): string {
    switch (status) {
      case "pending":
        return "未着手";
      case "in_progress":
        return "進行中";
      case "completed":
        return "完了";
    }
  }

  function toggle(): void {
    expanded = !expanded;
  }
</script>

{#if tasklist && visible}
  <section class="tasklist-float" aria-label="現在の todo リスト">
    <button
      type="button"
      class="tasklist-toggle"
      aria-expanded={expanded}
      aria-controls="tasklist-detail"
      onclick={toggle}
    >
      <span class="tasklist-label">TODO</span>
      <span class="tasklist-progress">[{completed}/{total}]</span>
      <span class="tasklist-action">{expanded ? "折りたたむ" : "詳細"}</span>
    </button>
    {#if expanded}
      <ul id="tasklist-detail" class="tasklist-items" aria-label="todo の詳細">
        {#each tasklist.items as item, index (`${index}:${item.text}`)}
          <li class="tasklist-item" data-status={item.status}>
            <span class="item-status" aria-hidden="true"></span>
            <span class="sr-only">{statusLabel(item.status)}: </span>
            <span class="item-text">{item.text}</span>
          </li>
        {/each}
        {#if tasklist.omitted}
          <li class="tasklist-omitted">
            以下 {tasklist.omitted.count} 件省略 (うち完了 {tasklist.omitted.completed} 件)
          </li>
        {/if}
      </ul>
    {/if}
  </section>
{/if}

<style>
  /* Detail's .main is the containing block. This is deliberately a float,
     * not a transcript row: tasklist is current LWW state, whereas the log is
     * append-only conversation history. */
  .tasklist-float {
    position: absolute;
    top: 0.4rem;
    right: 0.4rem;
    z-index: 2;
    width: min(20rem, calc(100% - 0.8rem));
    border: 1px solid color-mix(in srgb, var(--c-tool_running) 55%, var(--line));
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--bg-card) 92%, var(--c-tool_running));
    box-shadow: 0 0.2rem 0.8rem rgb(0 0 0 / 18%);
    overflow: hidden;
  }

  .tasklist-toggle {
    display: grid;
    grid-template-columns: auto auto 1fr;
    gap: 0.45rem;
    align-items: baseline;
    width: 100%;
    padding: 0.38rem 0.55rem;
    border: 0;
    background: transparent;
    color: var(--fg);
    font: inherit;
    font-size: var(--fs-body-sm);
    text-align: left;
    cursor: pointer;
  }

  .tasklist-toggle:hover,
  .tasklist-toggle:focus-visible {
    background: color-mix(in srgb, var(--c-tool_running) 14%, var(--bg-card));
  }

  .tasklist-toggle:focus-visible {
    outline: 2px solid var(--fg);
    outline-offset: -2px;
  }

  .tasklist-label {
    font-weight: 700;
    letter-spacing: 0.04em;
  }

  .tasklist-progress {
    font-variant-numeric: tabular-nums;
    color: var(--fg-dim);
  }

  .tasklist-action {
    justify-self: end;
    color: var(--fg-dim);
    font-size: var(--fs-caption);
  }

  .tasklist-items {
    display: flex;
    flex-direction: column;
    gap: 0.28rem;
    max-height: min(50dvh, 22rem);
    margin: 0;
    padding: 0.25rem 0.55rem 0.5rem;
    overflow-y: auto;
    list-style: none;
    border-top: 1px solid var(--line);
  }

  .tasklist-item {
    display: grid;
    grid-template-columns: 0.6rem minmax(0, 1fr);
    gap: 0.42rem;
    align-items: start;
    font-size: var(--fs-body-sm);
  }

  .item-status {
    width: 0.5rem;
    height: 0.5rem;
    margin-top: 0.33rem;
    border: 1px solid var(--fg-dim);
    border-radius: 50%;
  }

  .tasklist-item[data-status="in_progress"] .item-status {
    border-color: var(--c-tool_running);
    background: var(--c-tool_running);
  }

  .tasklist-item[data-status="completed"] .item-status {
    border-color: var(--fg-dim);
    background: var(--fg-dim);
  }

  .tasklist-item[data-status="completed"] .item-text {
    color: var(--fg-dim);
    text-decoration: line-through;
  }

  .item-text {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  /* Keep semantic item state in the accessibility tree while status dots stay
     visual only. This is the usual clipped-text pattern, not display:none:
     screen readers announce e.g. "完了: 調査" for every list item. */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .tasklist-omitted {
    padding-top: 0.25rem;
    border-top: 1px dashed var(--line);
    color: var(--fg-dim);
    font-size: var(--fs-caption);
  }

  /* A phone has no spare horizontal log gutter. Preserve the same component
     * and toggle, but put it in normal flow ahead of `.log` so an expanded
     * list cannot cover the first transcript rows or intercept their taps. */
  @media (max-width: 939px) {
    .tasklist-float {
      position: relative;
      top: auto;
      right: auto;
      align-self: flex-end;
    }
  }
</style>
