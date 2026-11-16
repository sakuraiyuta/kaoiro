<script lang="ts">
  import { tick } from "svelte";
  import { markdownWorker } from "./markdownWorker";
  import { renderMarkdownTokens, renderMermaidIn } from "./markdown";
  import { renderUntrustedTokens, type UntrustedRender } from "./untrustedMarkdown";
  import { msg } from "./i18n/index.svelte";

  let { text, scope = "", profile = "chat", onlayout = () => {} }: {
    text: string;
    scope?: string;
    profile?: "chat" | "full";
    onlayout?: () => void;
  } = $props();
  const owner = {};
  let root = $state<HTMLDivElement>(null!);
  let result = $state<{
    text: string; scope: string; profile: string;
    rendered: UntrustedRender; unavailable: boolean;
  } | null>(null);
  const renderIdentity = $derived([text, scope, profile]);
  const currentResult = $derived(result?.text === text &&
    result.scope === scope && result.profile === profile ? result : null);

  $effect(() => {
    const source = text, identity = scope, policy = profile;
    // The service drops a cancelled request's result, and currentResult
    // ignores any result for other props.
    return markdownWorker.request(owner, source, (lexed) => {
      let rendered: UntrustedRender = { kind: "plain" };
      if (lexed.kind === "tokens") {
        try {
          rendered = policy === "chat"
            ? { kind: "html", html: renderMarkdownTokens(lexed.tokens) }
            : renderUntrustedTokens(lexed.tokens);
        } catch { /* Keep the complete source when parsing or sanitizing fails. */ }
      }
      result = { text: source, scope: identity, profile: policy, rendered,
        unavailable: lexed.kind === "plain" && lexed.reason === "unavailable" };
    });
  });

  $effect(() => {
    const value = currentResult;
    if (!value) return;
    let alive = true;
    const current = () => alive && currentResult === value;
    void tick().then(async () => {
      if (!current()) return;
      const element = root;
      if (value.rendered.kind === "html" && value.profile === "chat") {
        try { await renderMermaidIn(element, current); }
        catch (error) { console.error("mermaid render failed", error); }
      }
      if (current()) onlayout();
    });
    return () => { alive = false; };
  });
</script>

{#key renderIdentity}
  <div bind:this={root} class="async-markdown"
    class:untrusted-markdown={profile === "full"}
    class:plain={currentResult?.rendered.kind !== "html"}
    data-markdown-state={currentResult?.rendered.kind ?? "pending"}>
    {#if currentResult?.rendered.kind === "html"}
      {@html currentResult.rendered.html}
    {:else}
      <p class="markdown-note">{currentResult?.unavailable
        ? msg().untrustedMarkdown.unavailableNote
        : currentResult ? msg().untrustedMarkdown.plainNote
          : msg().untrustedMarkdown.pendingNote}</p>
      <div class="markdown-source">{text}</div>
    {/if}
  </div>
{/key}

<style>
  .async-markdown { overflow-wrap: anywhere; }
  .markdown-source { white-space: pre-wrap; }
  .markdown-note { margin: 0 0 0.25rem; font-size: 0.85em; opacity: 0.75; }
  .untrusted-markdown :global(pre) { overflow-x: auto; }
  .untrusted-markdown :global(a), .untrusted-markdown :global(a:visited) {
    color: var(--c-thinking);
    text-decoration: underline;
  }
</style>
