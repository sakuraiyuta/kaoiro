<script lang="ts">
  import { untrack } from "svelte";
  import { expressionFor, spriteUrlFor } from "./expression";
  import { StatusQueue } from "./statusDisplay.svelte";
  import type {
    Envelope,
    KaoiroConnection,
    PersonaManifest,
  } from "./protocol";

  let {
    envelope,
    manifest = null,
    connection = null,
    onSelect,
  }: {
    envelope: Envelope;
    manifest?: PersonaManifest | null;
    connection?: KaoiroConnection | null;
    /** Receives the tile's centre so the detail can expand from it (#36). */
    onSelect?: (origin?: { x: number; y: number }) => void;
  } = $props();

  // Hand the detail the tile's viewport centre so it grows from this tile.
  function selectFrom(event: MouseEvent): void {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    onSelect?.({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  }

  // Displayed state lags the live state for min readability + crossfade (#43);
  // the needs-attention badge below still tracks the live state for immediacy.
  const display = new StatusQueue(untrack(() => envelope.state));
  $effect(() => {
    display.push(envelope.state);
  });
  $effect(() => () => display.dispose());

  const expression = $derived(expressionFor(display.shown));
  const name = $derived(envelope.persona?.name ?? envelope.agent_id);
  const spriteUrl = $derived(
    spriteUrlFor(manifest, envelope.persona?.sprite_set, display.shown),
  );
  // Needs-attention badge (ADR-0012 F6): approval/error draw the eye on the
  // grid; the actual allow/deny happens in the detail view.
  const attention = $derived(
    envelope.state === "waiting_permission" || envelope.state === "error",
  );

  let instruction = $state("");
  let actionError = $state("");
  // Optimistic "sent, awaiting the next state" cue (#32), mirroring
  // AgentDetail; cleared by the next state envelope, not by the protocol.
  let sending = $state(false);

  // The card clears its own error and sending cue once the agent moves on.
  $effect(() => {
    void envelope.state;
    actionError = "";
    sending = false;
  });

  function sendInstruction(event: SubmitEvent): void {
    event.preventDefault();
    const text = instruction.trim();
    if (!connection || text === "") return;
    actionError = "";
    sending = true;
    void connection
      .sendInstruction(envelope.agent_id, text)
      .then(() => (instruction = ""))
      .catch((error: unknown) => {
        sending = false;
        actionError = error instanceof Error ? error.message : String(error);
      });
  }

  // Multi-line input (#33): Enter inserts a newline; Ctrl/Cmd+Enter submits.
  function onInstructionKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      (event.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
    }
  }
</script>

<article class="card" data-state={expression.variant}>
  <button
    type="button"
    class="open"
    onclick={selectFrom}
    aria-label="{name} の詳細を開く"
  >
    {#if attention}
      <span class="badge" data-state={expression.variant}>要対応</span>
    {/if}
    {#key display.shown}
      {#if spriteUrl}
        <img class="sprite" src={spriteUrl} alt={expression.label} />
      {:else}
        <div class="face" role="img" aria-label={expression.label}>
          <span class="eye left"></span>
          <span class="eye right"></span>
          <span class="mouth"></span>
        </div>
      {/if}
    {/key}
    <h2>{name}</h2>
    {#key display.shown}
      <p class="state">{expression.label}</p>
    {/key}
    <p class="id">{envelope.agent_id}</p>
  </button>

  {#if connection}
    <form class="instruct" onsubmit={sendInstruction}>
      <textarea
        class:sending
        placeholder="指示を送る…(Ctrl+Enter で送信)"
        bind:value={instruction}
        onkeydown={onInstructionKeydown}
        rows="1"
        aria-label="instruction for {name}"
      ></textarea>
      <button type="submit" disabled={instruction.trim() === ""}>送信</button>
    </form>

    {#if sending}
      <p class="sending-note">送信中…</p>
    {/if}

    {#if actionError}
      <p class="action-error">{actionError}</p>
    {/if}
  {/if}
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

  /* Persona sprite (ADR-0008): square transparent PNG, contain-fit.
     disconnected has no sprite by spec — grey out idle instead. */
  .sprite {
    display: block;
    width: 8rem;
    height: 8rem;
    margin: 0 auto 1rem;
    object-fit: contain;
    animation: dissolve 0.35s ease-out;
  }

  [data-state="disconnected"] .sprite {
    filter: grayscale(1);
    opacity: 0.45;
  }

  /* The placeholder face: 顔色 = the state color itself. Fallback when
     the manifest has no sprite for the persona. */
  .face {
    position: relative;
    width: 5.4rem;
    height: 5.4rem;
    margin: 0 auto 1rem;
    border-radius: 50%;
    background: color-mix(in srgb, var(--tone) 28%, var(--bg-card));
    border: 2px solid var(--tone);
    box-shadow: 0 0 18px color-mix(in srgb, var(--tone) 35%, transparent);
    animation: dissolve 0.35s ease-out;
  }

  /* Dissolve-in on state change (#43): the previous face/label is replaced
     via {#key}, so the new one fades up from transparent. prefers-reduced-
     motion shortens this to ~instant via the global rule in app.css. */
  @keyframes dissolve {
    from { opacity: 0; }
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
    animation: dissolve 0.35s ease-out, sway 2.4s ease-in-out infinite;
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
    animation: dissolve 0.35s ease-out, hop 1.1s ease-in-out infinite;
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
    animation: dissolve 0.35s ease-out;
  }

  .id {
    margin: 0.45rem 0 0;
    font-size: 0.65rem;
    color: var(--fg-dim);
    overflow-wrap: anywhere;
  }

  /* --- clickable identity region (opens the detail view) -------------- */

  .open {
    display: block;
    position: relative;
    width: 100%;
    margin: 0;
    padding: 0;
    border: none;
    background: none;
    font: inherit;
    color: inherit;
    text-align: center;
    cursor: pointer;
  }

  .open:hover h2,
  .open:focus-visible h2 {
    color: var(--tone);
  }

  /* Needs-attention badge: blinking chip on the card corner (ADR-0012). */
  .badge {
    position: absolute;
    top: 0;
    right: 0;
    padding: 0.12rem 0.4rem;
    border-radius: 0.3rem;
    font-size: 0.6rem;
    font-weight: 600;
    background: var(--c-waiting_permission);
    color: var(--bg);
    animation: blink 1.2s ease-in-out infinite;
  }

  .badge[data-state="error"] {
    background: var(--c-error);
  }

  @keyframes blink {
    50% { opacity: 0.4; }
  }

  /* --- bidirectional controls (Phase 3) ------------------------------- */

  .instruct {
    display: flex;
    align-items: flex-end;
    gap: 0.4rem;
    margin-top: 0.8rem;
  }

  .instruct textarea {
    flex: 1;
    min-width: 0;
    padding: 0.35rem 0.5rem;
    border: 1px solid var(--line);
    border-radius: 0.35rem;
    background: var(--bg-card);
    color: var(--fg);
    font: inherit;
    font-size: 0.75rem;
    line-height: 1.4;
    resize: vertical;
  }

  /* Awaiting-response cue (#32): dark-yellow field while a send is in flight,
     until the agent's next state envelope clears it. */
  .instruct textarea.sending {
    background: color-mix(in srgb, var(--c-tool_running) 22%, var(--bg-card));
    border-color: var(--c-tool_running);
  }

  .sending-note {
    margin: 0.5rem 0 0;
    font-size: 0.7rem;
    color: var(--c-tool_running);
  }

  .instruct button {
    padding: 0.35rem 0.7rem;
    border: 1px solid var(--line);
    border-radius: 0.35rem;
    background: var(--bg-card);
    color: var(--fg);
    font-size: 0.75rem;
    cursor: pointer;
  }

  .instruct button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .action-error {
    margin: 0.5rem 0 0;
    font-size: 0.7rem;
    color: var(--c-error);
    overflow-wrap: anywhere;
  }
</style>
