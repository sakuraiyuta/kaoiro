<script lang="ts">
  // Persona pack detail modal (issue #232): shows manifest.json's full
  // metadata plus personality.md's full body for the persona/sprite set
  // itself — static pack information, not an individual agent's state.
  // The centered-modal mechanics (initial focus / Escape / Tab trap /
  // close-restore) live in the shared Modal.svelte primitive (issue #232
  // MF-3); the close button follows SettingsDrawer.svelte's top-right
  // `.close` styling.
  import Modal from "./Modal.svelte";
  import { fetchPersonaPackDetail } from "./protocol";
  import type { PersonaPackDetail } from "./protocol";

  let { personaId, onClose }: { personaId: string; onClose: () => void } =
    $props();

  let detail = $state<PersonaPackDetail | null>(null);
  let loading = $state(true);
  let loadError = $state(false);

  // Re-fetches whenever personaId changes (a different persona image
  // clicked while this dialog is already open, in principle — the actual
  // callers unmount/remount instead, but this keeps the effect correct on
  // its own rather than relying on that caller detail).
  $effect(() => {
    const id = personaId;
    let cancelled = false;
    loading = true;
    loadError = false;
    detail = null;
    fetchPersonaPackDetail(id).then((result) => {
      if (cancelled) return;
      loading = false;
      if (result === null) {
        loadError = true;
      } else {
        detail = result;
      }
    });
    return () => {
      cancelled = true;
    };
  });

  // http(s) only — homepage rides in from a persona pack's manifest.json
  // (ADR-0029 server-aggregated packs, moderate trust), and an
  // unrestricted href could carry a javascript: URI. issue #232 S-2
  // (ふじ round-1 should-fix): a prefix regex accepts a malformed-but-
  // prefix-matching string (e.g. "https:evil.com" with no `//", or
  // "https://" with no host) that `new URL()` either normalizes
  // differently or rejects outright — parsing and checking the actual
  // `protocol`/`hostname` the browser itself would resolve is the
  // authoritative check, not a string pattern approximating it.
  function isHttpUrl(value: string): boolean {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
    } catch {
      return false;
    }
  }
</script>

<Modal ariaLabel="ペルソナ詳細" {onClose} contentClass="persona-detail-content">
  {#snippet children()}
    <div class="dialog-header">
      <h2>{detail?.name ?? "ペルソナ詳細"}</h2>
      <!-- svelte-ignore a11y_autofocus -- inside a native <dialog>
           opened via showModal() (Modal.svelte), autofocus is exactly
           the spec-sanctioned initial-focus mechanism (issue #232
           MF-3), not the page-load autofocus the rule guards against. -->
      <button
        type="button"
        class="close"
        onclick={onClose}
        aria-label="閉じる"
        autofocus
      >
        ×
      </button>
    </div>

    {#if loading}
      <p class="note">読み込み中…</p>
    {:else if detail === null}
      <p class="note">
        {loadError ? "取得に失敗しました。" : "見つかりませんでした。"}
      </p>
    {:else}
      <dl class="meta">
        <dt>id</dt>
        <dd>{detail.id}</dd>
        <dt>sprite_set</dt>
        <dd>{detail.sprite_set}</dd>
        <dt>version</dt>
        <dd>{detail.version}</dd>
        <dt>license</dt>
        <dd>{detail.license}</dd>
        <dt>min_kaoiro_version</dt>
        <dd>{detail.min_kaoiro_version}</dd>
        <dt>states</dt>
        <dd>{detail.states.join(", ")}</dd>
        {#if detail.description}
          <dt>description</dt>
          <dd>{detail.description}</dd>
        {/if}
        {#if detail.author}
          <dt>author</dt>
          <dd>{detail.author}</dd>
        {/if}
        {#if detail.homepage}
          <dt>homepage</dt>
          <dd>
            {#if isHttpUrl(detail.homepage)}
              <a
                href={detail.homepage}
                target="_blank"
                rel="noopener noreferrer">{detail.homepage}</a
              >
            {:else}
              {detail.homepage}
            {/if}
          </dd>
        {/if}
      </dl>
      <h3>personality.md</h3>
      <pre class="personality">{detail.personality}</pre>
    {/if}
  {/snippet}
</Modal>

<style>
  /* Modal.svelte renders `.modal-content` in ITS OWN scope, so this
     component's scoped CSS cannot reach it by class alone — :global()
     is required for a class this component only ever hands to a child
     via a prop (contentClass), never renders itself. */
  :global(.persona-detail-content) {
    width: min(
      34rem,
      calc(100vw - max(4vw, env(safe-area-inset-left))
        - max(4vw, env(safe-area-inset-right)))
    );
    max-height: min(
      80vh,
      calc(100dvh - max(2rem, env(safe-area-inset-top))
        - max(2rem, env(safe-area-inset-bottom)))
    );
    overflow-y: auto;
  }

  .dialog-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  h2 {
    margin: 0;
    font-size: var(--fs-h2);
    color: var(--fg);
  }

  h3 {
    margin: 1rem 0 0.4rem;
    font-size: var(--fs-body);
    color: var(--fg);
  }

  .close {
    flex: none;
    padding: 0.2rem 0.5rem;
    font-size: var(--fs-body);
    line-height: 1;
    color: var(--fg-dim);
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    cursor: pointer;
  }

  .close:hover {
    color: var(--fg);
    border-color: var(--fg-dim);
  }

  .note {
    margin: 0;
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
  }

  .meta {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.3rem 0.8rem;
    margin: 0;
    font-size: var(--fs-body-sm);
  }

  .meta dt {
    color: var(--fg-dim);
  }

  .meta dd {
    margin: 0;
    color: var(--fg);
    overflow-wrap: anywhere;
  }

  .personality {
    margin: 0;
    padding: 0.7rem;
    font-size: var(--fs-body-sm);
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
