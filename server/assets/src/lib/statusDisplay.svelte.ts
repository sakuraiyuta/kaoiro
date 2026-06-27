// Status display queue (#43): enforces a minimum on-screen time per state so
// rapid transitions stay readable, and shows every intermediate state in
// order rather than coalescing them. Components render `shown` instead of the
// raw envelope state and crossfade when it changes.

/** Minimum time (ms) a state stays shown before the next one replaces it. */
export const MIN_DISPLAY_MS = 2000;

/** Long hold (ms) for the terminal turn states `done` / `error`: lets the
 *  persona sit with the outcome instead of flipping to `waiting_input`
 *  within seconds. Yielded immediately to a real interrupt (see `push`). */
export const TERMINAL_DISPLAY_MS = 180_000;

/** States that use TERMINAL_DISPLAY_MS, and whose hold is interruptible by any
 *  non-natural-followup push (see `push`). */
const TERMINAL_STATES = new Set(["done", "error"]);

export class StatusQueue {
  /** The state currently shown; lags the live state by up to MIN_DISPLAY_MS
   *  times the number of states still queued ahead of it (or up to
   *  TERMINAL_DISPLAY_MS while a terminal state is held). */
  shown = $state("idle");
  /** Live states awaiting their hold window, in arrival order. Every state is
   *  shown (no coalescing); the queue drains one per MIN_DISPLAY_MS. */
  #queue: string[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;
  /** Sticky pin: while non-null, shown is locked to this value and push() only
   *  remembers the latest live state (for the post-unhold catch-up). Used by
   *  #82 to keep `waiting_permission` on screen while the dialog is open even
   *  though the wrapper may emit follow-up states. */
  #heldOn: string | null = null;
  readonly #minMs: number;
  readonly #terminalMs: number;

  constructor(
    initial: string,
    minMs: number = MIN_DISPLAY_MS,
    terminalMs: number = TERMINAL_DISPLAY_MS,
  ) {
    this.shown = initial;
    this.#minMs = minMs;
    this.#terminalMs = terminalMs;
  }

  /**
   * Feed the latest live state. Shows it immediately when no hold window is
   * open; otherwise appends it to the queue so it is shown in turn. Consecutive
   * duplicates are dropped so a repeated state never wastes a hold window.
   *
   * Terminal interrupt: while a terminal state (`done` / `error`) is held, a
   * push of anything other than its natural follow-up `waiting_input` means
   * the operator/agent moved on (e.g. a `sending` from a re-send, or the next
   * turn starting). Drop the queue and show it immediately so the long hold
   * never blocks an active transition.
   */
  push(state: string): void {
    if (this.#disposed) return;
    // Held: shown is pinned (see hold()); only remember the latest live state
    // so unhold() can catch up. The queue is overwritten — older deferred
    // states are stale once the pin releases.
    if (this.#heldOn !== null) {
      if (state === this.#heldOn) this.#queue = [];
      else this.#queue = [state];
      return;
    }
    const last =
      this.#queue.length > 0 ? this.#queue[this.#queue.length - 1] : this.shown;
    if (state === last) return;
    if (
      this.#timer !== null &&
      TERMINAL_STATES.has(this.shown) &&
      state !== "waiting_input"
    ) {
      clearTimeout(this.#timer);
      this.#timer = null;
      this.#queue = [];
      this.#show(state);
      return;
    }
    if (this.#timer === null) {
      this.#show(state);
    } else {
      this.#queue.push(state);
    }
  }

  /** Pin `shown` to `state` until unhold() is called. Subsequent push() calls
   *  do not change `shown` while held; the most recent live state is kept for
   *  the catch-up on unhold(). A second hold() with a different state
   *  replaces the pin. Used by #82 to keep `waiting_permission` displayed
   *  while the permission dialog is open. */
  hold(state: string): void {
    if (this.#disposed) return;
    if (this.#heldOn === state) return;
    this.#heldOn = state;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#queue = [];
    if (this.shown !== state) this.shown = state;
  }

  /** Release a hold(). If a different live state arrived during the hold, it
   *  is shown immediately. No-op when not held. */
  unhold(): void {
    if (this.#disposed) return;
    if (this.#heldOn === null) return;
    this.#heldOn = null;
    const next = this.#queue.shift();
    this.#queue = [];
    if (next !== undefined && next !== this.shown) this.#show(next);
  }

  #show(state: string): void {
    this.shown = state;
    const ms = TERMINAL_STATES.has(state) ? this.#terminalMs : this.#minMs;
    this.#timer = setTimeout(() => this.#release(), ms);
  }

  #release(): void {
    this.#timer = null;
    const next = this.#queue.shift();
    if (next !== undefined) this.#show(next);
  }

  /** Cancel the pending timer and drop any queued states; call on component
   *  teardown. Idempotent, and a push() after disposal is a no-op so a late
   *  envelope during teardown cannot resurrect a transition. */
  dispose(): void {
    this.#disposed = true;
    this.#queue = [];
    this.#heldOn = null;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}
