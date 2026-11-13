<script lang="ts">
  import { onMount, untrack, type Snippet } from "svelte";
  import type { KnownState } from "./expression";
  import { msg } from "./i18n/index.svelte";

  let { groupKey, label, open, control = true, count, lamp, ontoggle, children }: {
    groupKey: string; label: string; open: boolean; control?: boolean;
    count: number; lamp: KnownState; ontoggle: () => void; children?: Snippet;
  } = $props();
  const id = $props.id();
  let present = $state(untrack(() => open));
  let clipped = $state(untrack(() => !open));
  let reveal: HTMLSpanElement;
  let reduced = $state(false);
  let frame: number | null = null;

  function cancelFrame(): boolean {
    if (frame === null) return false;
    cancelAnimationFrame(frame);
    frame = null;
    return true;
  }

  $effect(() => {
    const target = open;
    const immediate = reduced;
    untrack(() => {
      const pending = cancelFrame();
      if (immediate) {
        present = target;
        clipped = !target;
      } else if (target) {
        if (!present) {
          present = true;
          clipped = true;
          frame = requestAnimationFrame(() => {
            frame = null;
            // Resolve the closed clip before changing it; layout width stays final.
            reveal?.getBoundingClientRect();
            clipped = false;
          });
        } else {
          clipped = false;
        }
      } else {
        clipped = true;
        // No transition starts if opening is cancelled before its queued frame.
        if (pending) present = false;
      }
    });
  });

  function finish(event: TransitionEvent): void {
    if (event.target === reveal && event.propertyName === "clip-path" && !open) present = false;
  }

  onMount(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    reduced = media.matches;
    const change = () => { reduced = media.matches; };
    media.addEventListener("change", change);
    return () => { media.removeEventListener("change", change); cancelFrame(); };
  });
</script>

<span class="strip-group" role="group" aria-label={label} title={label} data-strip-key={groupKey}>
  <span class="strip-row">
    {#if control}
      <button type="button" class="room-toggle" aria-expanded={open} aria-controls={id}
        aria-label={msg().rooms.stripToggle({ name: label, open, count, state: msg().rooms.stripStates[lamp] })}
        onclick={ontoggle}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 5h8l2 3h10v12H2z" /></svg>
        {#if !open}
          <span class="strip-count" aria-hidden="true">{count}</span>
          <span class="state-lamp" data-state={lamp} aria-hidden="true"></span>
        {/if}
      </button>
    {/if}
    <span bind:this={reveal} {id} class="strip-reveal" class:clipped class:closed={!present}
      class:spaced={control} inert={!open} aria-hidden={!open} ontransitionend={finish}>
      <span class="strip-chips">{@render children?.()}</span>
    </span>
  </span>
  <span class="strip-label" aria-hidden="true">{label}</span>
</span>

<style>
  .strip-group { display: grid; flex: 0 1 auto; min-width: 0; max-width: 100%; justify-items: center; gap: 0.2rem; }
  :global(.strip-group) + .strip-group { padding-inline-start: 0.45rem; border-inline-start: 1px solid var(--line); }
  .strip-row { display: flex; align-items: flex-start; min-width: 0; max-width: 100%; }
  .room-toggle { position: relative; flex: none; width: clamp(3rem, 8dvh, 3.6rem); height: clamp(3rem, 8dvh, 3.6rem); padding: 0.45rem; }
  .room-toggle:focus-visible { outline: 2px solid var(--fg); outline-offset: -2px; }
  svg { width: 100%; height: 100%; fill: none; stroke: currentColor; stroke-width: 1.5; }
  .strip-count { position: absolute; bottom: 0.1rem; left: 0.1rem; font-size: var(--fs-caption); background: var(--bg); border-radius: 0.2rem; padding: 0 0.1rem; }
  .state-lamp { --tone: var(--c-idle); position: absolute; top: 0.1rem; right: 0.1rem; width: 0.55rem; height: 0.55rem; border-radius: 50%; background: var(--tone); box-shadow: 0 0 6px var(--tone); }
  .state-lamp[data-state="waiting_permission"] { --tone: var(--c-waiting_permission); }
  .state-lamp[data-state="waiting_question"] { --tone: var(--c-waiting_question); }
  .state-lamp[data-state="waiting_input"] { --tone: var(--c-waiting_input); }
  .state-lamp[data-state="error"] { --tone: var(--c-error); }
  .state-lamp[data-state="tool_running"] { --tone: var(--c-tool_running); }
  .state-lamp[data-state="thinking"] { --tone: var(--c-thinking); }
  .state-lamp[data-state="sending"] { --tone: var(--c-sending); }
  .state-lamp[data-state="done"] { --tone: var(--c-done); }
  .state-lamp[data-state="disconnected"] { --tone: var(--c-disconnected); }
  .strip-reveal { min-width: 0; max-width: 100%; clip-path: inset(0); transition: clip-path 180ms linear; }
  .strip-reveal.spaced { margin-inline-start: 0.45rem; }
  .strip-reveal.clipped { clip-path: inset(0 100% 0 0); }
  .strip-reveal.closed { display: none; margin-inline-start: 0; }
  .strip-chips { display: flex; flex-wrap: wrap; justify-content: center; min-width: 0; max-width: 100%; align-items: center; gap: 0.45rem; }
  .strip-label { width: 0; min-width: 100%; overflow: hidden; text-align: center; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-dim); font-size: var(--fs-body-sm); line-height: 1.2; }
  @media (max-width: 939px) {
    .strip-group { flex: 0 0 auto; max-width: none; }
    .strip-chips { flex-wrap: nowrap; }
  }
  @media (prefers-reduced-motion: reduce) {
    .strip-reveal, .room-toggle { transition: none; }
  }
</style>
