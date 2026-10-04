<script lang="ts">
  // The status line block of the member detail view (issue 514): what the agent
  // wrote about itself, drawn as markdown. It shows the head the server keeps
  // for every reader (at most 512 bytes), so it follows the live line without
  // fetching the change log; when the head was cut it says so and offers the
  // change log, whose newest entry is the whole text. Nothing interactive
  // encloses the markdown here, so links are real http(s) links.
  import { formatRelativeJa } from "./relativeTime";
  import type { StatusLineView } from "./statusLine";
  import UntrustedMarkdown from "./UntrustedMarkdown.svelte";

  let {
    view,
    onOpenHistory,
  }: {
    view: StatusLineView;
    /** Opens the change log of this agent. Undefined hides the buttons. */
    onOpenHistory?: (() => void) | undefined;
  } = $props();

  const more = $derived(
    view.kind === "set" && view.truncated
      ? `…続きあり (${(view.bytes / 1024).toFixed(1)} KB)`
      : null,
  );
  const clock = $derived.by(() => {
    if (view.kind !== "set") return "";
    const date = new Date(view.updatedAt);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false });
  });
  const ago = $derived(
    view.kind === "set" ? formatRelativeJa(view.updatedAt, Date.now()) : "",
  );
</script>

{#if view.kind !== "none"}
  <section class="status-line-panel" aria-label="状況表示">
    <header>
      <h3>状況表示</h3>
      {#if view.kind === "set"}
        <time class="when" datetime={view.updatedAt} title={ago}>{clock}</time>
      {/if}
    </header>
    {#if view.kind === "set"}
      <div class="body"><UntrustedMarkdown text={view.head} /></div>
      {#if more !== null}
        <p class="more">{more}</p>
      {/if}
    {:else}
      <p class="unset">未設定</p>
    {/if}
    {#if onOpenHistory !== undefined}
      <div class="actions">
        {#if more !== null}
          <button type="button" class="read-more" onclick={onOpenHistory}>続きを読む</button>
        {/if}
        <button type="button" class="history" onclick={onOpenHistory}>履歴</button>
      </div>
    {/if}
  </section>
{/if}

<style>
  .status-line-panel {
    margin: 0 0 0.9rem;
    padding: 0.5rem 0.65rem;
    border: 1px solid var(--line);
    border-left: 2px solid var(--tone, var(--line));
    border-radius: 0.3rem;
    background: color-mix(in srgb, var(--tone, transparent) 8%, var(--bg-card));
    color: var(--fg);
    font-size: var(--fs-body-sm);
    min-width: 0;
  }

  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }

  /* Secondary text is the foreground colour at .75 opacity, as on the card:
     --fg-dim reaches only 2.96:1 on the panel's tint, below AA. */
  h3 {
    margin: 0;
    font-size: var(--fs-metadata);
    font-weight: 600;
    opacity: 0.75;
  }

  .when,
  .more {
    font-size: var(--fs-micro);
    opacity: 0.75;
  }

  .body {
    margin-top: 0.3rem;
    min-width: 0;
  }

  .more {
    margin: 0.3rem 0 0;
  }

  .unset {
    margin: 0.3rem 0 0;
    opacity: 0.6;
  }

  /* The panel sits in the narrow left column: headings stay at body size, and
     a table or a code block scrolls inside the panel instead of widening it. */
  .body :global(h1),
  .body :global(h2),
  .body :global(h3),
  .body :global(h4),
  .body :global(h5),
  .body :global(h6) {
    margin: 0.4rem 0 0.2rem;
    font-size: var(--fs-body);
  }

  .body :global(p) {
    margin: 0.3rem 0;
  }

  .body :global(table) {
    display: block;
    max-width: 100%;
    overflow-x: auto;
    border-collapse: collapse;
  }

  .body :global(th),
  .body :global(td) {
    padding: 0.15rem 0.4rem;
    border: 1px solid var(--line);
  }

  .actions {
    display: flex;
    gap: 0.6rem;
    margin-top: 0.4rem;
  }

  .actions button {
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

  .actions button:hover,
  .actions button:focus-visible {
    opacity: 1;
  }
</style>
