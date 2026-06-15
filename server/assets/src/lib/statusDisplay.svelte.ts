// Status display queue (#43): enforces a minimum on-screen time per state so
// rapid transitions stay readable, and coalesces intermediate states (the
// final state is always shown). Components render `shown` instead of the raw
// envelope state and crossfade when it changes.

/** Minimum time (ms) a state stays shown before the next one replaces it. */
export const MIN_DISPLAY_MS = 1000;

export class StatusQueue {
  /** The state currently shown; lags the live state by up to MIN_DISPLAY_MS. */
  shown = $state("idle");
  /** Latest live state awaiting the hold window, or null when none is queued. */
  #pending: string | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  readonly #minMs: number;

  constructor(initial: string, minMs: number = MIN_DISPLAY_MS) {
    this.shown = initial;
    this.#minMs = minMs;
  }

  /**
   * Feed the latest live state. Shows it immediately when no hold window is
   * open; otherwise remembers it as the pending next state, dropping any
   * earlier pending one (intermediate states are skipped, the final is kept).
   */
  push(state: string): void {
    if (this.#timer === null) {
      if (state !== this.shown) this.#show(state);
    } else {
      this.#pending = state === this.shown ? null : state;
    }
  }

  #show(state: string): void {
    this.shown = state;
    this.#timer = setTimeout(() => this.#release(), this.#minMs);
  }

  #release(): void {
    this.#timer = null;
    if (this.#pending !== null) {
      const next = this.#pending;
      this.#pending = null;
      this.#show(next);
    }
  }

  /** Cancel the pending timer; call on component teardown. */
  dispose(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}
