<script lang="ts">
  import { untrack } from "svelte";
  import { expressionFor, spriteUrlFor } from "./expression";
  import { StatusQueue } from "./statusDisplay.svelte";
  import {
    pendingPermissionFrom,
    pendingQuestionFrom,
    RUNNING_STATES,
    STOP_SAFE_STATES,
  } from "./protocol";
  import type { Envelope, PersonaManifest } from "./protocol";

  let {
    envelope,
    manifest = null,
    directoryOnly = false,
    spawnError = null,
    onSelect,
    onInterrupt,
    onStop,
    onRestore,
    onDelete,
  }: {
    envelope: Envelope;
    manifest?: PersonaManifest | null;
    /** True when this tile is rendered from an AgentDirectory entry that has
     *  no live AgentStates counterpart (server restarted after this agent was
     *  last seen — ADR-0030). Enables the restore button unconditionally
     *  (server-side SessionPointer check decides success) and shows an
     *  "offline" label overlay so the operator can tell it apart from a
     *  merely disconnected live entry. */
    directoryOnly?: boolean;
    /** Latest restore/spawn failure reason for this agent — sticky icon in
     *  the tile corner until the agent comes online again or is restored
     *  successfully (ADR-0030 D8). Null clears it. */
    spawnError?: string | null;
    /** Receives the tile's centre so the detail can expand from it (#36). */
    onSelect?: (origin?: { x: number; y: number }) => void;
    // exactOptionalPropertyTypes: undefined must be in the type since
    // App.svelte conditionally passes undefined when there is no connection.
    /** ESC equivalent (#51); pass undefined to hide the button. */
    onInterrupt?: (() => Promise<void>) | undefined;
    /** Terminate the wrapper (#22); pass undefined to hide the button. */
    onStop?: (() => Promise<void>) | undefined;
    /** Restore a disconnected agent (#22, ADR-0014); pass undefined to hide
     *  the button (e.g. no connection / viewer). */
    onRestore?: (() => Promise<void>) | undefined;
    /** Remove a disconnected agent (#14); pass undefined to hide the
     *  button (e.g. no connection / viewer). */
    onDelete?: (() => Promise<void>) | undefined;
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
  // While the permission dialog is open (#82), pin the lamp/label to
  // waiting_permission. The card mirrors AgentDetail so the grid and the
  // detail never disagree on the sticky display.
  $effect(() => {
    if (pendingPermissionFrom(envelope)) display.hold("waiting_permission");
    else if (pendingQuestionFrom(envelope)) display.hold("waiting_question");
    else display.unhold();
  });

  const expression = $derived(expressionFor(display.shown));
  const name = $derived(envelope.persona?.name ?? envelope.agent_id);
  const spriteUrl = $derived(
    spriteUrlFor(manifest, envelope.persona?.sprite_set, display.shown),
  );
  // Needs-attention badge (ADR-0012 F6): approval/error draw the eye on the
  // grid; the actual allow/deny happens in the detail view.
  const attention = $derived(
    envelope.state === "waiting_permission" ||
      envelope.state === "waiting_question" ||
      envelope.state === "error",
  );

  // Interrupt button visible only when the agent is executing (#51 C2). Live
  // state, not the display-lagged one — immediacy matters for an ESC button.
  // RUNNING_STATES is shared with AgentDetail via protocol.ts so the lobby
  // tile and the detail view never drift on what counts as "executing".
  const canInterrupt = $derived(
    onInterrupt !== undefined && RUNNING_STATES.has(envelope.state),
  );

  let interrupting = $state(false);

  async function handleInterrupt(event: MouseEvent): Promise<void> {
    // Don't open the detail when the operator clicks ESC on the lobby tile.
    event.stopPropagation();
    if (interrupting || !onInterrupt) return;
    interrupting = true;
    try {
      await onInterrupt();
    } catch (err) {
      // Surface only on the console: the detail view carries the real
      // feedback channel; this button trades visibility for one-click reach.
      console.warn("interrupt failed:", err);
    } finally {
      interrupting = false;
    }
  }

  // Terminate button for any connected agent (#22): ends the wrapper process
  // (distinct from interrupt, which only stops the current turn). Hidden once
  // disconnected — there is nothing left to terminate (delete handles those).
  const canStop = $derived(
    onStop !== undefined && envelope.state !== "disconnected",
  );

  let stopping = $state(false);

  async function handleStop(event: MouseEvent): Promise<void> {
    // Don't open the detail when the operator clicks terminate on the tile.
    event.stopPropagation();
    if (stopping || !onStop) return;
    // Warn before terminating an agent that is mid-work (#22); idle / your
    // turn / done are safe and skip the confirm.
    if (!STOP_SAFE_STATES.has(envelope.state)) {
      // Use the LIVE state for the label so it matches the gate above; the
      // card's `expression` is display-lagged (StatusQueue) and could name a
      // stale state in the warning.
      const liveLabel = expressionFor(envelope.state).label;
      const ok = window.confirm(
        `「${name}」は${liveLabel}です。終了すると進行中の作業は失われる可能性があります。終了しますか?`,
      );
      if (!ok) return;
    }
    stopping = true;
    try {
      await onStop();
    } catch (err) {
      console.warn("stop failed:", err);
    } finally {
      stopping = false;
    }
  }

  // Restore button for a disconnected agent that has a session to resume
  // (#22, ADR-0014). Re-spawns the same agent_id; the server fills the cwd
  // from its pointer. Bottom-left, where the (now-hidden) terminate chip sat.
  // For a directory-only tile (ADR-0030) the client has no session_id —
  // the server-side SessionPointer check decides success, so we always show
  // the button and surface any failure via spawnError.
  const canRestore = $derived(
    onRestore !== undefined &&
      envelope.state === "disconnected" &&
      (directoryOnly ||
        (typeof envelope.session_id === "string" && envelope.session_id !== "")),
  );

  let restoring = $state(false);

  async function handleRestore(event: MouseEvent): Promise<void> {
    event.stopPropagation();
    if (restoring || !onRestore) return;
    restoring = true;
    try {
      await onRestore();
    } catch (err) {
      console.warn("restore failed:", err);
    } finally {
      restoring = false;
    }
  }

  // Delete button only for a disconnected agent (#14); mutually exclusive
  // with the interrupt button (running vs disconnected never overlap).
  const canDelete = $derived(
    onDelete !== undefined && envelope.state === "disconnected",
  );

  let deleting = $state(false);

  async function handleDelete(event: MouseEvent): Promise<void> {
    // Don't open the detail when the operator clicks delete on the tile.
    event.stopPropagation();
    if (deleting || !onDelete) return;
    const ok = window.confirm(
      `切断済みエージェント「${name}」を一覧から削除します。よろしいですか?`,
    );
    if (!ok) return;
    deleting = true;
    try {
      await onDelete();
    } catch (err) {
      console.warn("delete failed:", err);
    } finally {
      deleting = false;
    }
  }
</script>

<article class="card" data-state={expression.variant} class:directory-only={directoryOnly}>
  <button
    type="button"
    class="open"
    onclick={directoryOnly ? undefined : selectFrom}
    aria-label={directoryOnly
      ? `${name} (オフライン)`
      : `${name} の詳細を開く`}
    disabled={directoryOnly}
  >
    <span class="lamp" title={expression.label}></span>
    {#if directoryOnly}
      <span class="offline-label" aria-label="オフライン">offline</span>
    {/if}
    {#if spawnError}
      <span class="error-icon" title="復元失敗: {spawnError}" aria-label="復元失敗">⚠</span>
    {/if}
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
  {#if canStop}
    <button
      type="button"
      class="terminate"
      onclick={handleStop}
      disabled={stopping}
      title="エージェント(wrapper)を終了する"
      aria-label="{name} を終了"
    >
      <span class="terminate-label">{stopping ? "終了中…" : "終了"}</span>
    </button>
  {:else if canRestore}
    <button
      type="button"
      class="restore"
      onclick={handleRestore}
      disabled={restoring}
      title="セッションを再開してエージェントを復帰させる"
      aria-label="{name} を復帰"
    >
      <span class="restore-label">{restoring ? "復帰中…" : "復帰"}</span>
    </button>
  {/if}
  {#if canInterrupt}
    <button
      type="button"
      class="stop"
      onclick={handleInterrupt}
      disabled={interrupting}
      title="現在のターンを中断 (ESC 相当)"
      aria-label="{name} のターンを中断"
    >
      <span class="stop-icon" aria-hidden="true">■</span>
      <span class="stop-label">{interrupting ? "中断中…" : "中断"}</span>
    </button>
  {:else if canDelete}
    <button
      type="button"
      class="remove"
      onclick={handleDelete}
      disabled={deleting}
      title="切断済みエージェントを一覧から削除"
      aria-label="{name} を削除"
    >
      <span class="remove-icon" aria-hidden="true">✕</span>
      <span class="remove-label">{deleting ? "削除中…" : "削除"}</span>
    </button>
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

  .card[data-state="sending"] { --tone: var(--c-sending); }
  .card[data-state="thinking"] { --tone: var(--c-thinking); }
  .card[data-state="tool_running"] { --tone: var(--c-tool_running); }
  .card[data-state="waiting_permission"] {
    --tone: var(--c-waiting_permission);
  }
  .card[data-state="waiting_question"] {
    --tone: var(--c-waiting_question);
  }
  .card[data-state="waiting_input"] { --tone: var(--c-waiting_input); }
  .card[data-state="done"] { --tone: var(--c-done); }
  .card[data-state="error"] { --tone: var(--c-error); }
  .card[data-state="disconnected"] { --tone: var(--c-disconnected); }

  /* Directory-only tile (ADR-0030): the operator has an identity ledger
     entry for this agent but AgentStates has none. Fade the whole card so
     it reads as "known but not live" alongside neighbouring live tiles. */
  .card.directory-only {
    opacity: 0.7;
  }

  /* "offline" label overlay for directory-only tiles (ADR-0030 D5), sitting
     top-left opposite the lamp so both stay legible over the sprite. */
  .offline-label {
    position: absolute;
    top: 0.6rem;
    left: 0.7rem;
    padding: 0.05rem 0.35rem;
    font-size: 0.65rem;
    letter-spacing: 0.08em;
    text-transform: lowercase;
    color: var(--fg-dim);
    background: color-mix(in srgb, var(--bg) 60%, transparent);
    border: 1px solid var(--line);
    border-radius: 0.2rem;
  }

  /* Restore failure hint (ADR-0030 D8) — sticky next to the lamp until the
     agent comes online again or a subsequent restore succeeds. */
  .error-icon {
    position: absolute;
    top: 0.6rem;
    right: 1.6rem;
    color: var(--c-error);
    font-size: 1.1rem;
    line-height: 1;
    cursor: help;
  }

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
    font-size: var(--fs-h2);
    font-weight: 600;
    color: var(--fg);
  }

  .state {
    margin: 0.25rem 0 0;
    font-size: var(--fs-body-sm);
    font-weight: 600;
    color: var(--tone);
    animation: dissolve 0.35s ease-out;
  }

  .id {
    margin: 0.45rem 0 0;
    font-size: var(--fs-caption);
    color: var(--fg-dim);
    overflow-wrap: anywhere;
  }

  /* Card has the interrupt button as a sibling of the open region, so make
     the wrapper a positioning context for it. */
  .card {
    position: relative;
  }

  /* Interrupt button (#51) on the lobby tile: small chip in the corner so it
     does not compete with the persona's identity, only shows up while the
     agent is running. Click handler stopPropagation prevents opening the
     detail view (the surrounding .open button). */
  .stop {
    position: absolute;
    bottom: 0.35rem;
    right: 0.35rem;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.18rem 0.45rem;
    border: 1px solid var(--c-tool_running);
    border-radius: 0.3rem;
    background: var(--bg-card);
    color: var(--c-tool_running);
    font: inherit;
    font-size: var(--fs-caption);
    cursor: pointer;
  }

  .stop:hover:not(:disabled) {
    background: color-mix(in srgb, var(--c-tool_running) 14%, var(--bg-card));
  }

  .stop:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .stop-icon {
    font-size: 0.7em; /* em-relative to parent button; do not tokenize */
    line-height: 1;
  }

  /* Terminate button (#22): bottom-LEFT chip so it never overlaps the
     interrupt / delete chip (bottom-right). A muted danger tone marks it
     destructive; shown for any connected agent. */
  .terminate {
    position: absolute;
    bottom: 0.35rem;
    left: 0.35rem;
    padding: 0.18rem 0.45rem;
    border: 1px solid var(--c-error);
    border-radius: 0.3rem;
    background: var(--bg-card);
    color: var(--c-error);
    font: inherit;
    font-size: var(--fs-caption);
    cursor: pointer;
  }

  .terminate:hover:not(:disabled) {
    background: color-mix(in srgb, var(--c-error) 14%, var(--bg-card));
  }

  .terminate:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Restore button (#22): bottom-LEFT chip (same slot as terminate, which is
     hidden once disconnected). A waiting_input tone marks it as the
     constructive "bring it back" action, distinct from the danger delete. */
  .restore {
    position: absolute;
    bottom: 0.35rem;
    left: 0.35rem;
    padding: 0.18rem 0.45rem;
    border: 1px solid var(--c-waiting_input);
    border-radius: 0.3rem;
    background: var(--bg-card);
    color: var(--c-waiting_input);
    font: inherit;
    font-size: var(--fs-caption);
    cursor: pointer;
  }

  .restore:hover:not(:disabled) {
    background: color-mix(in srgb, var(--c-waiting_input) 14%, var(--bg-card));
  }

  .restore:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Delete button (#14): same corner chip as .stop but a muted danger tone,
     shown only for a disconnected agent (never overlaps the interrupt). */
  .remove {
    position: absolute;
    bottom: 0.35rem;
    right: 0.35rem;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.18rem 0.45rem;
    border: 1px solid var(--c-error);
    border-radius: 0.3rem;
    background: var(--bg-card);
    color: var(--c-error);
    font: inherit;
    font-size: var(--fs-caption);
    cursor: pointer;
  }

  .remove:hover:not(:disabled) {
    background: color-mix(in srgb, var(--c-error) 14%, var(--bg-card));
  }

  .remove:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .remove-icon {
    font-size: 0.7em; /* em-relative to parent button; do not tokenize */
    line-height: 1;
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

  /* Directory-only tile has no detail view to open (ADR-0030): the button
     is left as-is for layout, but pointer/keyboard affordance is dropped so
     the tile does not advertise an interaction it cannot fulfil. */
  .open:disabled {
    cursor: default;
  }

  .open:disabled:hover h2,
  .open:disabled:focus-visible h2 {
    color: inherit;
  }

  /* Needs-attention badge: blinking chip on the card corner (ADR-0012). */
  .badge {
    position: absolute;
    top: 0;
    right: 0;
    padding: 0.12rem 0.4rem;
    border-radius: 0.3rem;
    font-size: var(--fs-micro);
    font-weight: 600;
    background: var(--c-waiting_permission);
    color: var(--bg);
    animation: blink 1.2s ease-in-out infinite;
  }

  .badge[data-state="error"] {
    background: var(--c-error);
  }

  /* State lamp (#16): same dot as the detail pane's, coloured by --tone.
     Top-left here since the needs-attention badge owns the top-right. */
  .lamp {
    position: absolute;
    top: 0.2rem;
    left: 0.2rem;
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 50%;
    background: var(--tone);
    box-shadow: 0 0 6px var(--tone);
  }

  @keyframes blink {
    50% { opacity: 0.4; }
  }
</style>
