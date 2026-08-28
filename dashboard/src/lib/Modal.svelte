<script lang="ts">
  // Shared modal primitive (issue #232 MF-3, ふじ round-1 must-fix):
  // native <dialog>.showModal() for the a11y properties a hand-rolled
  // backdrop+positioned-div cannot get for free — Escape-to-close, a
  // background focus trap (every element outside an open showModal()
  // dialog becomes inert per the HTML spec, so Tab cannot escape it),
  // and a spec-defined initial-focus target. PersonaDetailDialog.svelte
  // previously reimplemented the backdrop by hand and had none of these
  // (ふじ measured: Escape did nothing, no initial focus, no trap, no
  // focus restore on close).
  //
  // LaunchDialog.svelte / SettingsDrawer.svelte share the same gap but
  // are OUT OF SCOPE here — migrating them is tracked as a separate
  // issue (ふじ round-1, director instruction) so this fix stays scoped
  // to the surface it was found on.
  import { onMount } from "svelte";
  import type { Snippet } from "svelte";

  let {
    ariaLabel,
    onClose,
    contentClass = "",
    children,
  }: {
    ariaLabel: string;
    onClose: () => void;
    /** Extra class(es) for `.modal-content`, so a caller can size the box
     *  (width/max-height/etc.) with its own scoped CSS via `:global()`
     *  instead of every caller sharing one fixed size here. */
    contentClass?: string;
    children: Snippet;
  } = $props();

  let dialogEl: HTMLDialogElement | undefined = $state();
  // The element focused before this modal opened, so closing it can put
  // focus back where the operator was (issue #232 MF-3) rather than
  // leaving it on <body> — the default once the focused element (the
  // trigger button, now covered by the modal) becomes inert.
  let triggerElement: Element | null = null;

  onMount(() => {
    triggerElement = document.activeElement;
    dialogEl?.showModal();

    return () => {
      if (triggerElement instanceof HTMLElement && document.contains(triggerElement)) {
        triggerElement.focus();
      }
    };
  });

  // `cancel` fires on Escape (native <dialog> behaviour), before the
  // element's own `close`. preventDefault so the dialog does not close
  // itself out of sync with the caller's own open/closed state (an `{#if}`
  // in every current caller) — routing through the same `onClose` the
  // close button uses keeps exactly one path that unmounts this component.
  function handleCancel(event: Event): void {
    event.preventDefault();
    onClose();
  }

  // Click-outside-to-close: a <dialog> has no separate backdrop element
  // to attach a listener to (`::backdrop` is a pseudo-element, not part
  // of the DOM), but a click landing on the <dialog> box itself — rather
  // than bubbling up from `.modal-content` inside it — means the click
  // was outside the visible content, on the dialog's own padding/margin
  // box. `.modal-content` fills the dialog with no gap so no legitimate
  // in-content click can reach this.
  function handleBackdropClick(event: MouseEvent): void {
    if (event.target === dialogEl) onClose();
  }

  // Tab-cycle wraparound (issue #232 MF-3, measured gap in Chromium
  // e2e): showModal() makes every element OUTSIDE the dialog inert per
  // the HTML spec, so Tab can never escape it — but it does NOT wrap
  // focus from the last tabbable element back to the first (or
  // vice-versa with Shift+Tab). Measured directly: tabbing past the last
  // element inside the dialog left `document.activeElement` on `<body>`,
  // not back on the first element — focus effectively vanishes from the
  // keyboard user's view even though it never reaches anything behind
  // the modal. WAI-ARIA's dialog pattern requires the cycle, so this
  // supplies it explicitly rather than relying on the element alone.
  const FOCUSABLE_SELECTOR =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== "Tab" || !dialogEl) return;
    const focusable = Array.from(
      dialogEl.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    );
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
</script>

<dialog
  bind:this={dialogEl}
  aria-label={ariaLabel}
  onclick={handleBackdropClick}
  oncancel={handleCancel}
  onkeydown={handleKeydown}
>
  <div class="modal-content {contentClass}">
    {@render children()}
  </div>
</dialog>

<style>
  dialog {
    padding: 0;
    margin: 0;
    border: none;
    background: transparent;
    color: inherit;
    /* Full-viewport box, NOT sized to content: `handleBackdropClick`
       tells "outside" apart from "inside" by comparing event.target to
       this element, which only works if the dialog box extends beyond
       `.modal-content` — a content-sized dialog (the UA default) leaves
       no such outside area, so every click would land ON `.modal-content`
       and never reach this element as the target. */
    width: 100vw;
    height: 100vh;
    max-width: 100vw;
    max-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  dialog::backdrop {
    background: rgba(0, 0, 0, 0.5);
  }

  .modal-content {
    padding: 1.6rem;
    background: var(--bg-card);
    border: 1px solid var(--line);
    border-radius: 0.6rem;
  }
</style>
