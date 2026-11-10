<script lang="ts">
  // The status line block of the member detail view (issue 514): what the agent
  // wrote about itself, drawn as markdown. It shows the head the server keeps
  // for every reader (at most 512 bytes), so it follows the live line without
  // fetching the change log; when the head was cut it says so. One button opens
  // the change log wherever the agent has written or withdrawn a line, and its
  // newest entry is the whole text. Nothing interactive encloses the markdown
  // here, so links are real http(s) links.
  import { intlTag, msg } from "./i18n/index.svelte";
  import { formatRelative } from "./relativeTime";
  import { headOmitted, headOmittedText, type StatusLineView } from "./statusLine";
  import UntrustedMarkdown from "./UntrustedMarkdown.svelte";

  let {
    view,
    onOpenHistory,
    clamp = false,
    expanded = false,
    bodyId,
    bodyEl = $bindable(null),
  }: {
    view: StatusLineView;
    /** Opens the change log of this agent. Undefined hides the button. */
    onOpenHistory?: (() => void) | undefined;
    /** Limit the drawn head to three lines unless `expanded`. */
    clamp?: boolean;
    expanded?: boolean;
    /** id of the drawn head, for a toggle outside the panel to point at. */
    bodyId?: string | undefined;
    /** The drawn head element, or null while nothing is drawn. */
    bodyEl?: HTMLDivElement | null;
  } = $props();

  const more = $derived(
    view.kind === "set" && view.truncated
      ? msg().statusLine.moreAvailable({ kb: (view.bytes / 1024).toFixed(1) })
      : null,
  );
  // An agent that never wrote a line has no change log to read.
  const hasLog = $derived(view.kind === "set" || (view.kind === "unset" && view.cleared));
  const clock = $derived.by(() => {
    if (view.kind !== "set") return "";
    const date = new Date(view.updatedAt);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleTimeString(intlTag(), { hour: "2-digit", minute: "2-digit", hour12: false });
  });
  const ago = $derived(
    view.kind === "set" ? formatRelative(view.updatedAt, Date.now()) : "",
  );
</script>

{#if view.kind !== "none"}
  <section class="status-line-panel" aria-label={msg().statusLinePanel.title}>
    <header>
      <h3>{msg().statusLinePanel.title}</h3>
      {#if view.kind === "set"}
        <time class="when" datetime={view.updatedAt} title={ago}>{clock}</time>
      {/if}
    </header>
    {#if view.kind === "set"}
      {#if headOmitted(view)}
        <p class="omitted">{headOmittedText()}</p>
      {:else}
        <div
          class="body"
          class:clamped={clamp && !expanded}
          class:expanded={clamp && expanded}
          id={bodyId}
          bind:this={bodyEl}
        ><UntrustedMarkdown text={view.head} /></div>
      {/if}
      {#if more !== null}
        <p class="more">{more}</p>
      {/if}
    {:else}
      <p class="unset">{msg().statusLine.unset}</p>
    {/if}
    {#if onOpenHistory !== undefined && hasLog}
      <div class="actions">
        <button type="button" class="read-more" onclick={onOpenHistory}>{msg().statusLinePanel.readMore}</button>
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

  /* Three lines of the panel's own line height. The first block's top margin
     would otherwise eat into them. */
  .body.clamped,
  .body.expanded {
    line-height: 1.4;
  }

  .body.clamped {
    max-height: calc(1.4em * 3);
    overflow: hidden;
  }

  /* The caller sets the cap from its own layout; past it the head scrolls
     in place. */
  .body.expanded {
    max-height: var(--status-line-expanded-max, 40vh);
    overflow-y: auto;
  }

  /* Clamped, a heading or a block margin would take a line's height: the
     three lines hold three lines of text whatever the markdown. */
  .body.clamped :global(:is(h1, h2, h3, h4, h5, h6)) {
    font-size: inherit;
  }

  .body.clamped :global(:is(h1, h2, h3, h4, h5, h6, p, ul, ol, blockquote, pre, table)) {
    margin-block: 0;
  }

  .body.clamped > :global(:first-child),
  .body.expanded > :global(:first-child),
  .body.clamped > :global(:first-child > :first-child),
  .body.expanded > :global(:first-child > :first-child) {
    margin-top: 0;
  }

  .unset {
    margin: 0.3rem 0 0;
    opacity: 0.6;
  }

  /* The dashboard's own sentence for a head with nothing left to draw: dim and
     italic, in a class the agent's markdown never gets. */
  .omitted {
    margin: 0.3rem 0 0;
    font-style: italic;
    opacity: 0.75;
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
