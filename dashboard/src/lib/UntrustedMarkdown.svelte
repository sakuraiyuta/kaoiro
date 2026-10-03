<script lang="ts">
  // Renders someone else's markdown under the fixed untrusted policy
  // (untrustedMarkdown.ts). This is the one {@html} site for such text; a
  // failure to render shows the source as plain text through Svelte's own
  // escaping, never as HTML.
  import { renderUntrustedMarkdown } from "./untrustedMarkdown";

  let { text }: { text: string } = $props();

  const rendered = $derived(renderUntrustedMarkdown(text));
</script>

{#if rendered.kind === "html"}
  <div class="untrusted-markdown">{@html rendered.html}</div>
{:else}
  <p class="untrusted-markdown-note">書式を表示できないため、そのまま表示しています</p>
  <div class="untrusted-markdown plain">{text}</div>
{/if}

<style>
  .untrusted-markdown {
    overflow-wrap: anywhere;
  }
  .untrusted-markdown.plain {
    white-space: pre-wrap;
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
  .untrusted-markdown :global(a) {
    text-decoration: underline;
  }
</style>
