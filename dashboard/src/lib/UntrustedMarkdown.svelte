<script lang="ts">
  // Renders someone else's markdown under the fixed untrusted policy
  // (untrustedMarkdown.ts). This is the one {@html} site for such text; a
  // failure to render shows the source as plain text through Svelte's own
  // escaping, never as HTML.
  //
  // `inline` is the agent card's profile: the text sits inside a button, so the
  // output is phrasing content in span wrappers only, and the plain fallback
  // carries no explanatory note.
  import {
    inlineLineCount,
    renderUntrustedInline,
    renderUntrustedMarkdown,
  } from "./untrustedMarkdown";

  let {
    text,
    variant = "full",
    lines = $bindable(0),
  }: {
    text: string;
    variant?: "full" | "inline";
    /** The number of lines the inline variant draws, for a caller that says
     *  "more" past a limit. It is reported from the one render this component
     *  does, so the caller never parses the text again. 0 for the full variant. */
    lines?: number;
  } = $props();

  const inline = $derived(variant === "inline");
  const rendered = $derived(inline ? renderUntrustedInline(text) : renderUntrustedMarkdown(text));

  $effect.pre(() => {
    lines = inline ? inlineLineCount(rendered, text) : 0;
  });
</script>

{#if rendered.kind === "html"}
  <svelte:element this={inline ? "span" : "div"} class="untrusted-markdown" class:inline>{@html rendered.html}</svelte:element>
{:else}
  {#if !inline}
    <p class="untrusted-markdown-note">書式を表示できないため、そのまま表示しています</p>
  {/if}
  <svelte:element this={inline ? "span" : "div"} class="untrusted-markdown plain" class:inline>{text}</svelte:element>
{/if}

<style>
  .untrusted-markdown {
    overflow-wrap: anywhere;
  }
  .untrusted-markdown.plain {
    white-space: pre-wrap;
  }
  /* The card draws breaks itself, and the plain fallback keeps the author's. */
  .untrusted-markdown.inline {
    white-space: normal;
  }
  .untrusted-markdown.inline.plain {
    white-space: pre-line;
  }
  .untrusted-markdown-note {
    margin: 0 0 0.25rem;
    font-size: 0.85em;
    opacity: 0.75;
  }
  /* The markdown output is injected, so the selectors cannot be scoped. */
  .untrusted-markdown :global(pre) {
    overflow-x: auto;
  }
  .untrusted-markdown :global(a),
  .untrusted-markdown :global(.md-link) {
    text-decoration: underline;
  }
  .untrusted-markdown.inline :global(code) {
    font-family: ui-monospace, monospace;
    font-size: 0.95em;
  }
</style>
