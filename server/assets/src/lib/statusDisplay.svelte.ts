// Status display queue (#43): enforces a minimum on-screen time per state so
// rapid transitions stay readable, and shows every intermediate state in
// order rather than coalescing them. Components render `shown` instead of the
// raw envelope state and crossfade when it changes.

/** Minimum time (ms) a state stays shown before the next one replaces it. */
export const MIN_DISPLAY_MS = 2000;

export class StatusQueue {
  /** The state currently shown; lags the live state by up to MIN_DISPLAY_MS
   *  times the number of states still queued ahead of it. */
  shown = $state("idle");
  /** Live states awaiting their hold window, in arrival order. Every state is
   *  shown (no coalescing); the queue drains one per MIN_DISPLAY_MS. */
  #queue: string[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;
  readonly #minMs: number;

  constructor(initial: string, minMs: number = MIN_DISPLAY_MS) {
    this.shown = initial;
    this.#minMs = minMs;
  }

  /**
   * Feed the latest live state. Shows it immediately when no hold window is
   * open; otherwise appends it to the queue so it is shown in turn. Consecutive
   * duplicates are dropped so a repeated state never wastes a hold window.
   */
  push(state: string): void {
    if (this.#disposed) return;
    const last =
      this.#queue.length > 0 ? this.#queue[this.#queue.length - 1] : this.shown;
    if (state === last) return;
    if (this.#timer === null) {
      this.#show(state);
    } else {
      this.#queue.push(state);
    }
  }

  #show(state: string): void {
    this.shown = state;
    this.#timer = setTimeout(() => this.#release(), this.#minMs);
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
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}
