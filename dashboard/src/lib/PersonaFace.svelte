<script lang="ts">
  // Shared fallback-face renderer (issue #245). Extracted from 4 manual
  // copies: App.svelte's agent-strip (`.chip`), AgentCard.svelte
  // (`.card`), AgentDetail.svelte (`.detail`), ResponseTimeline.svelte
  // (`.portrait`). The 4 sites intentionally differ in size, per-state
  // eye/mouth shape, animation and a11y labelling (pre-existing drift,
  // see issue #245 comment for the full matrix) — this component
  // reproduces each site's existing look byte-for-byte via the `size`
  // prop rather than unifying them; unifying is explicitly out of scope
  // (こはく裁定 2026-08-20). `--tone` itself stays defined on the
  // caller's own `data-state`-bearing wrapper (chip/card/detail/
  // portrait) — this component only consumes it via `var(--tone)`.
  import type { KnownState } from "./expression";

  interface Props {
    /** Resolved sprite URL, or null to fall back to the CSS face. */
    sprite: string | null;
    /** State variant, drives the `data-state` CSS hook. */
    variant: KnownState;
    /** Orthogonal fatigue modifier (issue #172), never a protocol state. */
    fatigued?: boolean;
    /** Human label (expression.label) for alt/aria-label. */
    label: string;
    /** Per-site visual preset — selects which of the 4 copied CSS
     *  blocks applies. No default: every call site must say which. */
    size: "chip" | "card" | "detail" | "timeline";
    /** true: sprite <img alt={label}>. false: <img alt="">. Differs
     *  per site (drift, not a mistake) — always pass explicitly. */
    imgAltLabelled: boolean;
    /** true: face gets role="img" aria-label={label}. false: face gets
     *  aria-hidden="true" instead. Differs per site — always pass
     *  explicitly. */
    faceLabelled: boolean;
  }

  const { sprite, variant, label, size, imgAltLabelled, faceLabelled, fatigued = false }:
    Props = $props();
</script>

{#if sprite}
  <img
    class="portrait-sprite"
    data-size={size}
    data-state={variant}
    src={sprite}
    alt={imgAltLabelled ? label : ""}
  />
{:else if faceLabelled}
  <div
    class="face"
    data-size={size}
    data-state={variant}
    data-fatigued={fatigued ? "true" : undefined}
    role="img"
    aria-label={label}
  >
    <span class="eye left"></span>
    <span class="eye right"></span>
    <span class="mouth"></span>
  </div>
{:else}
  <div
    class="face"
    data-size={size}
    data-state={variant}
    data-fatigued={fatigued ? "true" : undefined}
    aria-hidden="true"
  >
    <span class="eye left"></span>
    <span class="eye right"></span>
    <span class="mouth"></span>
  </div>
{/if}

<style>
  /* ==================================================================
     size="chip" — from App.svelte's `.chip .thumb` / `.chip .face`.
     Chip is ~3rem-ish; per-state eye/mouth shape is skipped there
     (too small to read) and there is no dissolve/sway/hop animation.
     ================================================================== */
  .portrait-sprite[data-size="chip"] {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .portrait-sprite[data-size="chip"][data-state="disconnected"] {
    filter: grayscale(1);
    opacity: 0.45;
  }

  .face[data-size="chip"] {
    position: relative;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    background: color-mix(in srgb, var(--tone) 28%, var(--bg-card));
    border: 1px solid var(--tone);
  }

  .face[data-size="chip"] .eye {
    position: absolute;
    top: 38%;
    width: 12%;
    height: 12%;
    border-radius: 50%;
    background: var(--fg);
  }

  .face[data-size="chip"] .eye.left { left: 28%; }
  .face[data-size="chip"] .eye.right { right: 28%; }

  .face[data-size="chip"] .mouth {
    position: absolute;
    bottom: 26%;
    left: 50%;
    translate: -50% 0;
    width: 30%;
    height: 12%;
    border-bottom: 1.5px solid var(--fg);
    border-radius: 0 0 50% 50% / 0 0 100% 100%;
  }

  /* ==================================================================
     size="card" — from AgentCard.svelte's `.sprite` / `.face`. Fixed
     5.4rem circle, full per-state eye/mouth shape + dissolve/sway/hop.
     ================================================================== */
  .portrait-sprite[data-size="card"] {
    display: block;
    width: 8rem;
    height: 8rem;
    object-fit: contain;
    animation: pf-dissolve 0.35s ease-out;
  }

  .portrait-sprite[data-size="card"][data-state="disconnected"] {
    filter: grayscale(1);
    opacity: 0.45;
  }

  .face[data-size="card"] {
    position: relative;
    width: 5.4rem;
    height: 5.4rem;
    border-radius: 50%;
    background: color-mix(in srgb, var(--tone) 28%, var(--bg-card));
    border: 2px solid var(--tone);
    box-shadow: 0 0 18px color-mix(in srgb, var(--tone) 35%, transparent);
    animation: pf-dissolve 0.35s ease-out;
  }

  .face[data-size="card"] .eye {
    position: absolute;
    top: 38%;
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: var(--fg);
  }

  .face[data-size="card"] .eye.left { left: 28%; }
  .face[data-size="card"] .eye.right { right: 28%; }

  .face[data-size="card"] .mouth {
    position: absolute;
    bottom: 24%;
    left: 50%;
    translate: -50% 0;
    width: 1.4rem;
    height: 0.65rem;
    border-bottom: 2px solid var(--fg);
    border-radius: 0 0 50% 50% / 0 0 100% 100%;
  }

  .face[data-size="card"][data-state="idle"] .mouth {
    width: 0.9rem;
    height: 0;
    border-radius: 0;
  }

  .face[data-size="card"][data-state="thinking"] .eye {
    top: 30%;
    height: 0.3rem;
    border-radius: 50% 50% 0 0;
  }

  .face[data-size="card"][data-state="thinking"] .mouth {
    width: 0.5rem;
    height: 0.5rem;
    border: 2px solid var(--fg);
    border-radius: 50%;
  }

  .face[data-size="card"][data-state="thinking"] {
    animation: pf-dissolve 0.35s ease-out, pf-sway 2.4s ease-in-out infinite;
  }

  .face[data-size="card"][data-state="tool_running"] .eye {
    height: 0.32rem;
    border-radius: 0.16rem;
  }

  .face[data-size="card"][data-state="tool_running"] .mouth {
    width: 1.1rem;
    height: 0;
    border-radius: 0;
  }

  .face[data-size="card"][data-state="waiting_permission"] .eye {
    width: 0.75rem;
    height: 0.75rem;
    box-shadow: inset 0 0 0 2px var(--tone);
  }

  .face[data-size="card"][data-state="waiting_permission"] .mouth {
    width: 0.45rem;
    height: 0.55rem;
    border: 2px solid var(--fg);
    border-radius: 50%;
  }

  .face[data-size="card"][data-state="waiting_permission"] {
    animation: pf-dissolve 0.35s ease-out, pf-hop 1.1s ease-in-out infinite;
    /* card's hop distance — differs from detail's (-4%), see pf-hop */
    --pf-hop-y: -0.25rem;
  }

  .face[data-size="card"][data-state="waiting_input"] .mouth {
    width: 1.6rem;
  }

  .face[data-size="card"][data-state="done"] .eye {
    height: 0.34rem;
    border-radius: 0 0 50% 50%;
    background: transparent;
    border-bottom: 2.5px solid var(--fg);
  }

  .face[data-size="card"][data-state="done"] .mouth {
    width: 1.8rem;
    height: 0.8rem;
  }

  .face[data-size="card"][data-state="error"] .eye {
    border-radius: 0;
    background:
      linear-gradient(45deg, transparent 42%, var(--fg) 42% 58%, transparent 58%),
      linear-gradient(-45deg, transparent 42%, var(--fg) 42% 58%, transparent 58%);
  }

  .face[data-size="card"][data-state="error"] .mouth {
    border-bottom: none;
    border-top: 2px solid var(--fg);
    border-radius: 50% 50% 0 0 / 100% 100% 0 0;
  }

  .face[data-size="card"][data-state="disconnected"] {
    opacity: 0.45;
    box-shadow: none;
  }

  .face[data-size="card"][data-state="disconnected"] .eye {
    height: 0.12rem;
    border-radius: 0;
  }

  .face[data-size="card"][data-state="disconnected"] .mouth {
    width: 0.9rem;
    height: 0;
    border-radius: 0;
  }

  /* ==================================================================
     size="detail" — from AgentDetail.svelte's `.sprite` / `.face`.
     Responsive (% of a responsive parent), mirrors "card"'s per-state
     shapes but there is no waiting_question tone rule at this site
     (that stays on the caller's own `.detail[data-state=...]`, out of
     this component's scope) and no waiting_question shape divergence.
     ================================================================== */
  .portrait-sprite[data-size="detail"] {
    width: 100%;
    height: auto;
    aspect-ratio: 1 / 1;
    object-fit: contain;
    animation: pf-dissolve 0.35s ease-out;
  }

  .portrait-sprite[data-size="detail"][data-state="disconnected"] {
    filter: grayscale(1);
    opacity: 0.45;
  }

  .face[data-size="detail"] {
    position: relative;
    width: 70%;
    aspect-ratio: 1 / 1;
    border-radius: 50%;
    background: color-mix(in srgb, var(--tone) 28%, var(--bg-card));
    border: 2px solid var(--tone);
    box-shadow: 0 0 18px color-mix(in srgb, var(--tone) 35%, transparent);
    animation: pf-dissolve 0.35s ease-out;
  }

  .face[data-size="detail"] .eye {
    position: absolute;
    top: 38%;
    width: 10%;
    height: 10%;
    border-radius: 50%;
    background: var(--fg);
  }

  .face[data-size="detail"] .eye.left { left: 28%; }
  .face[data-size="detail"] .eye.right { right: 28%; }

  .face[data-size="detail"] .mouth {
    position: absolute;
    bottom: 24%;
    left: 50%;
    translate: -50% 0;
    width: 26%;
    height: 12%;
    border-bottom: 3px solid var(--fg);
    border-radius: 0 0 50% 50% / 0 0 100% 100%;
  }

  .face[data-size="detail"][data-state="idle"] .mouth {
    width: 17%;
    height: 0;
    border-radius: 0;
  }

  .face[data-size="detail"][data-state="thinking"] .eye {
    top: 30%;
    height: 5%;
    border-radius: 50% 50% 0 0;
  }

  .face[data-size="detail"][data-state="thinking"] .mouth {
    width: 9%;
    height: 9%;
    border: 3px solid var(--fg);
    border-radius: 50%;
  }

  .face[data-size="detail"][data-state="thinking"] {
    animation: pf-dissolve 0.35s ease-out, pf-sway 2.4s ease-in-out infinite;
  }

  .face[data-size="detail"][data-state="tool_running"] .eye {
    height: 6%;
    border-radius: 6%;
  }

  .face[data-size="detail"][data-state="tool_running"] .mouth {
    width: 20%;
    height: 0;
    border-radius: 0;
  }

  .face[data-size="detail"][data-state="waiting_permission"] .eye {
    width: 14%;
    height: 14%;
    box-shadow: inset 0 0 0 3px var(--tone);
  }

  .face[data-size="detail"][data-state="waiting_permission"] .mouth {
    width: 8%;
    height: 10%;
    border: 3px solid var(--fg);
    border-radius: 50%;
  }

  .face[data-size="detail"][data-state="waiting_permission"] {
    animation: pf-dissolve 0.35s ease-out, pf-hop 1.1s ease-in-out infinite;
    /* detail's hop distance is % (responsive parent) — differs from
       card's fixed -0.25rem, see pf-hop */
    --pf-hop-y: -4%;
  }

  .face[data-size="detail"][data-state="waiting_input"] .mouth {
    width: 30%;
  }

  .face[data-size="detail"][data-state="done"] .eye {
    height: 6%;
    border-radius: 0 0 50% 50%;
    background: transparent;
    border-bottom: 3px solid var(--fg);
  }

  .face[data-size="detail"][data-state="done"] .mouth {
    width: 33%;
    height: 15%;
  }

  .face[data-size="detail"][data-state="error"] .eye {
    border-radius: 0;
    background:
      linear-gradient(45deg, transparent 42%, var(--fg) 42% 58%, transparent 58%),
      linear-gradient(-45deg, transparent 42%, var(--fg) 42% 58%, transparent 58%);
  }

  .face[data-size="detail"][data-state="error"] .mouth {
    border-bottom: none;
    border-top: 3px solid var(--fg);
    border-radius: 50% 50% 0 0 / 100% 100% 0 0;
  }

  .face[data-size="detail"][data-state="disconnected"] {
    opacity: 0.45;
    box-shadow: none;
  }

  .face[data-size="detail"][data-state="disconnected"] .eye {
    height: 2%;
    border-radius: 0;
  }

  .face[data-size="detail"][data-state="disconnected"] .mouth {
    width: 17%;
    height: 0;
    border-radius: 0;
  }

  /* ==================================================================
     size="timeline" — from ResponseTimeline.svelte's `.portrait img` /
     `.face`. Small (2.25rem parent), % of the portrait; dissolve only
     (no sway/hop), no disconnected sprite-filter rule at this site
     (pre-existing — not added here since that would change the look).
     ================================================================== */
  .portrait-sprite[data-size="timeline"] {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .face[data-size="timeline"] {
    position: relative;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    background: color-mix(in srgb, var(--tone) 28%, var(--bg-card));
    border: 1px solid var(--tone);
    animation: pf-dissolve 0.35s ease-out;
  }

  .face[data-size="timeline"] .eye {
    position: absolute;
    top: 38%;
    width: 14%;
    height: 14%;
    border-radius: 50%;
    background: var(--fg);
  }

  .face[data-size="timeline"] .eye.left { left: 26%; }
  .face[data-size="timeline"] .eye.right { right: 26%; }

  .face[data-size="timeline"] .mouth {
    position: absolute;
    bottom: 22%;
    left: 50%;
    translate: -50% 0;
    width: 30%;
    height: 14%;
    border-bottom: 1.5px solid var(--fg);
    border-radius: 0 0 50% 50% / 0 0 100% 100%;
  }

  .face[data-size="timeline"][data-state="idle"] .mouth {
    width: 20%;
    height: 0;
    border-radius: 0;
  }

  .face[data-size="timeline"][data-state="thinking"] .eye {
    top: 30%;
    height: 6%;
    border-radius: 50% 50% 0 0;
  }

  .face[data-size="timeline"][data-state="thinking"] .mouth {
    width: 12%;
    height: 12%;
    border: 1.5px solid var(--fg);
    border-radius: 50%;
  }

  .face[data-size="timeline"][data-state="tool_running"] .eye {
    height: 8%;
    border-radius: 8%;
  }

  .face[data-size="timeline"][data-state="tool_running"] .mouth {
    width: 24%;
    height: 0;
    border-radius: 0;
  }

  .face[data-size="timeline"][data-state="waiting_permission"] .eye {
    width: 18%;
    height: 18%;
    box-shadow: inset 0 0 0 1.5px var(--tone);
  }

  .face[data-size="timeline"][data-state="waiting_permission"] .mouth {
    width: 10%;
    height: 12%;
    border: 1.5px solid var(--fg);
    border-radius: 50%;
  }

  .face[data-size="timeline"][data-state="waiting_input"] .mouth {
    width: 36%;
  }

  .face[data-size="timeline"][data-state="done"] .eye {
    height: 8%;
    border-radius: 0 0 50% 50%;
    background: transparent;
    border-bottom: 1.5px solid var(--fg);
  }

  .face[data-size="timeline"][data-state="done"] .mouth {
    width: 40%;
    height: 18%;
  }

  .face[data-size="timeline"][data-state="error"] .eye {
    border-radius: 0;
    background:
      linear-gradient(45deg, transparent 42%, var(--fg) 42% 58%, transparent 58%),
      linear-gradient(-45deg, transparent 42%, var(--fg) 42% 58%, transparent 58%);
  }

  .face[data-size="timeline"][data-state="error"] .mouth {
    border-bottom: none;
    border-top: 1.5px solid var(--fg);
    border-radius: 50% 50% 0 0 / 100% 100% 0 0;
  }

  .face[data-size="timeline"][data-state="disconnected"] {
    opacity: 0.45;
  }

  .face[data-size="timeline"][data-state="disconnected"] .eye {
    height: 3%;
    border-radius: 0;
  }

  .face[data-size="timeline"][data-state="disconnected"] .mouth {
    width: 20%;
    height: 0;
    border-radius: 0;
  }

  /* Fatigue is a modifier rather than a state: preserve the state-specific
     visual rules above, then make only card/detail fallback faces half-lidded
     with a downturned mouth. Sprite portraits already carry fatigued art and
     intentionally receive no data-fatigued attribute. */
  .face[data-fatigued="true"][data-size="card"] .eye {
    height: 0.22rem;
    border-radius: 0.11rem;
  }

  .face[data-fatigued="true"][data-size="card"] .mouth {
    width: 0.9rem;
    height: 0.35rem;
    border-bottom: none;
    border-top: 2px solid var(--fg);
    border-radius: 50% 50% 0 0 / 100% 100% 0 0;
  }

  .face[data-fatigued="true"][data-size="detail"] .eye {
    height: 4%;
    border-radius: 50% 50% 0 0;
  }

  .face[data-fatigued="true"][data-size="detail"] .mouth {
    width: 17%;
    height: 8%;
    border-bottom: none;
    border-top: 3px solid var(--fg);
    border-radius: 50% 50% 0 0 / 100% 100% 0 0;
  }

  /* ==================================================================
     Shared keyframes (name-merged across the 4 sites; purely a naming
     detail inside this component's own CSS scope — does not change any
     computed animation timing/easing/keyframe values). card/detail
     used "dissolve", timeline used "face-dissolve" — same 0.35s
     ease-out fade-in, just spelled differently; merged here as
     pf-dissolve. pf-hop's Y distance is NOT merged (card: -0.25rem,
     detail: -4% — different values, see --pf-hop-y above); only the
     keyframe's 20%/40% timing structure and pf-sway are shared.
     ================================================================== */
  @keyframes pf-dissolve {
    from { opacity: 0; }
  }

  @keyframes pf-sway {
    50% { rotate: 4deg; }
  }

  @keyframes pf-hop {
    20% { translate: 0 var(--pf-hop-y); }
    40% { translate: 0 0; }
  }
</style>
