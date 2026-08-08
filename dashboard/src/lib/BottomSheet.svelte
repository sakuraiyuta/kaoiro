<script lang="ts">
  // Bottom sheet mechanism (ADR-0052 F1-F3 / responsive-layout.md シート機構).
  //
  // The wrapped region stays mounted at EVERY size (F6 — no size-driven
  // mount/unmount): above the sheet breakpoint the wrapper renders as
  // `display: contents`, so the content participates in the parent layout
  // exactly as if this component were absent; at or below the breakpoint the
  // content becomes a fixed bottom sheet pulled up from a fixed handle.
  //
  // Contract (responsive-layout.md シートの契約):
  //   開く   — handle のタップ/クリックのみ (agent イベントでは開かない)
  //   閉じる — handle 再押下 / backdrop / Escape
  //   最大高 — viewport 高の 60%
  //   scroll — panel は overflow:hidden の非スクロール wrapper。中身
  //            (timeline は .rows、status は .status 自身) が唯一の
  //            縦スクロール所有者。背景は body.sheet-open で固定
  //   focus  — 展開でシート内へ、閉じたら handle へ戻す
  //   breakpoint 跨ぎ — シート化されないサイズへ遷移したら open を破棄
  //   handle — シート化されるサイズでのみ表示 (閉時も出しつづける)
  import { tick } from "svelte";
  import type { Snippet } from "svelte";

  let {
    mode,
    label,
    attentionCount = 0,
    attentionTone = null,
    onAttention = undefined,
    pendingTone = null,
    children,
  }: {
    /** Breakpoint at which the region sheets (responsive-layout.md):
     *  "smartphone" = max-width 939px (lobby timeline),
     *  "tablet" = max-width 1198px (AgentDetail status). */
    mode: "smartphone" | "tablet";
    /** Handle text + panel aria-label. */
    label: string;
    /** Other agents needing attention (ADR-0012 F8). While the sheet is
     *  open the handle badge shows this count and the badge itself performs
     *  the same "一覧へ戻す" action as `button.blindspot` (ADR-0052 F3). */
    attentionCount?: number;
    attentionTone?: string | null;
    onAttention?: () => void;
    /** Current-agent pending permission/question tone. The in-flow docks
     *  sit behind an open sheet, so the handle carries a lamp to keep the
     *  pending decision noticeable (responsive-layout.md MUST). */
    pendingTone?: string | null;
    children: Snippet;
  } = $props();

  // The ONLY responsive Svelte state allowed by ADR-0052 F6 is the sheet
  // open flag; layout itself is pure CSS media queries.
  let open = $state(false);
  let toggleEl = $state<HTMLButtonElement | null>(null);
  let panelEl = $state<HTMLDivElement | null>(null);

  // Same px literals as the CSS @media blocks below (app.css breakpoint
  // token comment is the canonical list to grep when these change).
  const SHEET_QUERY = {
    smartphone: "(max-width: 939px)",
    tablet: "(max-width: 1198px)",
  } as const;

  // Discard the open state when the viewport leaves the sheeted size
  // (シート契約: breakpoint 跨ぎ). matchMedia only OBSERVES the breakpoint;
  // it never drives layout, so F6 (CSS media query 中心) holds.
  $effect(() => {
    // jsdom (component integration tests) has no matchMedia; the sheet
    // simply keeps its open state there. Every target browser has it.
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(SHEET_QUERY[mode]);
    const onChange = (): void => {
      if (!mq.matches) open = false;
    };
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  });

  // Freeze the page's main scroller while open (背景はスクロールさせない).
  // The class lives on <body> so app.css can target `main` without this
  // component reaching into App's DOM; the cleanup runs on close, unmount,
  // and breakpoint-crossing discard alike.
  $effect(() => {
    if (!open) return;
    document.body.classList.add("sheet-open");
    return () => document.body.classList.remove("sheet-open");
  });

  async function openSheet(): Promise<void> {
    open = true;
    await tick();
    panelEl?.focus();
  }

  function close(): void {
    open = false;
    toggleEl?.focus();
  }

  function toggle(): void {
    if (open) close();
    else void openSheet();
  }

  // Escape closes the sheet (契約: 閉じる手段). Bubbling-phase window
  // listener, so a focused widget that already consumed its own Escape
  // (slash menu, switch popover) wins via defaultPrevented.
  function onWindowKeydown(event: KeyboardEvent): void {
    if (!open || event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    close();
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div
  class="sheet"
  class:open
  class:at-smartphone={mode === "smartphone"}
  class:at-tablet={mode === "tablet"}
>
  <div class="handle">
    <!-- The handle is a CONTAINER: the open/close toggle and the attention
         badge are sibling buttons, never nested interactive elements
         (responsive-reachability.md 盲点インジケータの扱い). -->
    <button
      type="button"
      class="toggle"
      bind:this={toggleEl}
      aria-expanded={open}
      onclick={toggle}
    >
      <span class="grip" aria-hidden="true"></span>
      <span class="toggle-label">{label}</span>
      {#if open && pendingTone}
        <!-- 展開中のみ (responsive-reachability.md overlay 表): 閉時は
             シートが何も覆っておらず、dock / カード自身が signal になる。 -->
        <span
          class="pending-lamp"
          data-tone={pendingTone}
          role="status"
          aria-label="対応待ちがあります"
          title="対応待ちがあります"
        ></span>
      {/if}
    </button>
    {#if open && attentionCount > 0 && onAttention}
      <button
        type="button"
        class="attention"
        data-tone={attentionTone}
        onclick={onAttention}
        title="一覧へ戻って対応する"
      >
        他に {attentionCount} 体が要対応
      </button>
    {/if}
  </div>
  {#if open}
    <div
      class="backdrop"
      role="button"
      tabindex="-1"
      aria-label="閉じる"
      onclick={close}
      onkeydown={(e) => e.key === "Escape" && close()}
    ></div>
  {/if}
  <div
    class="panel"
    bind:this={panelEl}
    tabindex="-1"
    aria-label={label}
  >
    {@render children()}
  </div>
</div>

<style>
  /* Above the sheet breakpoint every box here is transparent: the root and
     the panel are `display: contents` (content joins the parent layout
     untouched) and the handle/backdrop render nothing. The @media blocks
     below only flip `display` — all box styling is declared once here and
     stays inert while the element is boxless. */
  .sheet {
    display: contents;
  }

  .handle {
    display: none;
    position: fixed;
    inset-inline: 0;
    /* Safe-area floor (responsive-layout.md セーフエリア): the handle's own
       edge gap acts as the floor, never an addition. */
    bottom: max(0.25rem, env(safe-area-inset-bottom));
    justify-content: center;
    align-items: center;
    gap: 0.5rem;
    padding-inline: max(0.5rem, env(safe-area-inset-left))
      max(0.5rem, env(safe-area-inset-right));
    pointer-events: none;
    z-index: 32;
  }

  .toggle {
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    max-width: 100%;
    padding: 0.3rem 0.9rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--bg-card);
    color: var(--fg-dim);
    font: inherit;
    font-size: var(--fs-body-sm);
    cursor: pointer;
    /* menu-layer shadow (design.md の許可 2 種のうち menu 層の値)。 */
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  }

  .toggle:hover,
  .toggle:focus-visible {
    color: var(--fg);
    border-color: var(--fg-dim);
    outline: none;
  }

  .grip {
    width: 1.4rem;
    height: 3px;
    border-radius: 2px;
    background: var(--fg-dim);
  }

  .toggle-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pending-lamp {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: var(--pending-tone, var(--fg-dim));
    box-shadow: 0 0 6px var(--pending-tone, var(--fg-dim));
    animation: sheet-blink 1.2s ease-in-out infinite;
  }

  .pending-lamp[data-tone="waiting_permission"] {
    --pending-tone: var(--c-waiting_permission);
  }

  .pending-lamp[data-tone="waiting_question"] {
    --pending-tone: var(--c-waiting_question);
  }

  .attention {
    pointer-events: auto;
    padding: 0.3rem 0.7rem;
    border: 1px solid var(--attention-tone, var(--c-waiting_permission));
    border-radius: 999px;
    background: var(--bg-card);
    color: var(--attention-tone, var(--c-waiting_permission));
    font: inherit;
    font-size: var(--fs-body-sm);
    white-space: nowrap;
    cursor: pointer;
    /* menu-layer shadow (design.md の許可 2 種のうち menu 層の値)。 */
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    animation: sheet-blink 1.2s ease-in-out infinite;
  }

  .attention[data-tone="error"] {
    --attention-tone: var(--c-error);
  }

  .attention[data-tone="waiting_question"] {
    --attention-tone: var(--c-waiting_question);
  }

  @keyframes sheet-blink {
    50% {
      opacity: 0.45;
    }
  }

  .backdrop {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    border: none;
    cursor: default;
    z-index: 30;
  }

  .panel {
    display: contents;
    position: fixed;
    inset-inline: 0;
    bottom: 0;
    flex-direction: column;
    /* 最大高 = viewport 高の 60% (シート契約). dvh tracks the mobile
       dynamic viewport; vh is the fallback. */
    max-block-size: 60vh;
    max-block-size: 60dvh;
    padding: 0.6rem max(0.8rem, env(safe-area-inset-right))
      max(2.4rem, env(safe-area-inset-bottom)) max(0.8rem, env(safe-area-inset-left));
    border-top: 1px solid var(--line);
    border-radius: 0.75rem 0.75rem 0 0;
    background: var(--bg);
    /* Non-scrolling wrapper: the slotted content owns the vertical scroll
       (responsive-reachability.md スクロール所有者). */
    overflow: hidden;
    z-index: 31;
    outline: none;
  }

  @media (max-width: 939px) {
    .at-smartphone .handle {
      display: flex;
    }

    .at-smartphone .panel {
      display: none;
    }

    .at-smartphone.open .panel {
      display: flex;
    }

    .at-smartphone.open .backdrop {
      display: block;
    }
  }

  @media (max-width: 1198px) {
    .at-tablet .handle {
      display: flex;
    }

    .at-tablet .panel {
      display: none;
    }

    .at-tablet.open .panel {
      display: flex;
    }

    .at-tablet.open .backdrop {
      display: block;
    }
  }
</style>
