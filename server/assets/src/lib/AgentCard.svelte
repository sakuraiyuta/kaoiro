<script lang="ts">
  import { expressionFor } from "./expression";
  import type { Envelope } from "./protocol";

  let { envelope }: { envelope: Envelope } = $props();

  const expression = $derived(expressionFor(envelope.state));
  const name = $derived(envelope.persona?.name ?? envelope.agent_id);
</script>

<article class="card" data-state={expression.variant}>
  {#key envelope.state}
    <div class="face" role="img" aria-label={expression.label}>
      <span class="eye left"></span>
      <span class="eye right"></span>
      <span class="mouth"></span>
    </div>
  {/key}
  <h2>{name}</h2>
  <p class="state">{expression.label}</p>
  <p class="id">{envelope.agent_id}</p>
</article>

<style>
  .card {
    --tone: var(--c-idle);
    border: 1px solid var(--line);
    border-radius: 0.5rem;
    padding: 1.4rem 1rem 1.1rem;
    text-align: center;
    background:
      radial-gradient(
        circle at 50% 0%,
        color-mix(in srgb, var(--tone) 9%, transparent),
        transparent 70%
      ),
      var(--bg-card);
  }

  .card[data-state="thinking"] { --tone: var(--c-thinking); }
  .card[data-state="tool_running"] { --tone: var(--c-tool_running); }
  .card[data-state="waiting_permission"] {
    --tone: var(--c-waiting_permission);
  }
  .card[data-state="waiting_input"] { --tone: var(--c-waiting_input); }
  .card[data-state="done"] { --tone: var(--c-done); }
  .card[data-state="error"] { --tone: var(--c-error); }
  .card[data-state="disconnected"] { --tone: var(--c-disconnected); }

  /* The placeholder face: 顔色 = the state color itself. Swapped for
     persona sprites once asset distribution (ADR-0008) lands. */
  .face {
    position: relative;
    width: 5.4rem;
    height: 5.4rem;
    margin: 0 auto 1rem;
    border-radius: 50%;
    background: color-mix(in srgb, var(--tone) 28%, var(--bg-card));
    border: 2px solid var(--tone);
    box-shadow: 0 0 18px color-mix(in srgb, var(--tone) 35%, transparent);
    animation: pop 0.35s ease-out;
  }

  @keyframes pop {
    from { transform: scale(0.85); }
    60% { transform: scale(1.05); }
  }

  .eye {
    position: absolute;
    top: 38%;
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: var(--fg);
  }

  .eye.left { left: 28%; }
  .eye.right { right: 28%; }

  .mouth {
    position: absolute;
    bottom: 24%;
    left: 50%;
    translate: -50% 0;
    width: 1.4rem;
    height: 0.65rem;
    border-bottom: 2px solid var(--fg);
    border-radius: 0 0 50% 50% / 0 0 100% 100%;
  }

  /* --- per-state expressions ----------------------------------------- */

  [data-state="idle"] .mouth {
    width: 0.9rem;
    height: 0;
    border-radius: 0;
  }

  [data-state="thinking"] .eye {
    top: 30%;
    height: 0.3rem;
    border-radius: 50% 50% 0 0;
  }

  [data-state="thinking"] .mouth {
    width: 0.5rem;
    height: 0.5rem;
    border: 2px solid var(--fg);
    border-radius: 50%;
  }

  [data-state="thinking"] .face {
    animation: pop 0.35s ease-out, sway 2.4s ease-in-out infinite;
  }

  @keyframes sway {
    50% { rotate: 4deg; }
  }

  [data-state="tool_running"] .eye {
    height: 0.32rem;
    border-radius: 0.16rem;
  }

  [data-state="tool_running"] .mouth {
    width: 1.1rem;
    height: 0;
    border-radius: 0;
  }

  [data-state="waiting_permission"] .eye {
    width: 0.75rem;
    height: 0.75rem;
    box-shadow: inset 0 0 0 2px var(--tone);
  }

  [data-state="waiting_permission"] .mouth {
    width: 0.45rem;
    height: 0.55rem;
    border: 2px solid var(--fg);
    border-radius: 50%;
  }

  [data-state="waiting_permission"] .face {
    animation: pop 0.35s ease-out, hop 1.1s ease-in-out infinite;
  }

  @keyframes hop {
    20% { translate: 0 -0.25rem; }
    40% { translate: 0 0; }
  }

  [data-state="waiting_input"] .mouth {
    width: 1.6rem;
  }

  [data-state="done"] .eye {
    height: 0.34rem;
    border-radius: 0 0 50% 50%;
    background: transparent;
    border-bottom: 2.5px solid var(--fg);
  }

  [data-state="done"] .mouth {
    width: 1.8rem;
    height: 0.8rem;
  }

  [data-state="error"] .eye {
    border-radius: 0;
    background:
      linear-gradient(45deg, transparent 42%, var(--fg) 42% 58%, transparent 58%),
      linear-gradient(-45deg, transparent 42%, var(--fg) 42% 58%, transparent 58%);
  }

  [data-state="error"] .mouth {
    border-bottom: none;
    border-top: 2px solid var(--fg);
    border-radius: 50% 50% 0 0 / 100% 100% 0 0;
  }

  [data-state="disconnected"] .face {
    opacity: 0.45;
    box-shadow: none;
  }

  [data-state="disconnected"] .eye {
    height: 0.12rem;
    border-radius: 0;
  }

  [data-state="disconnected"] .mouth {
    width: 0.9rem;
    height: 0;
    border-radius: 0;
  }

  /* --- text ----------------------------------------------------------- */

  h2 {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--fg);
  }

  .state {
    margin: 0.25rem 0 0;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--tone);
  }

  .id {
    margin: 0.45rem 0 0;
    font-size: 0.65rem;
    color: var(--fg-dim);
    overflow-wrap: anywhere;
  }
</style>
