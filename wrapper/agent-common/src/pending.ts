// Generic pending-request registry: the shared plumbing behind the permission
// and AskUserQuestion brokers (ADR-0027 F5). Holds a map of in-flight requests
// by id, arms an optional fail-closed timeout per request, and drains every
// pending request on shutdown. The value `T` is the decision each request
// settles with (a PermissionDecision / QuestionDecision); building that value
// and any side effects (e.g. clearing the ext pending-record) stay in the
// caller's `settle` closure.

interface PendingEntry<T> {
  settle: (value: T) => void;
  /** null when no finite timeout is configured (wait indefinitely). */
  timer: NodeJS.Timeout | null;
}

export class PendingRegistry<T> {
  /** null = no timeout (wait until a decision arrives). */
  readonly #timeoutMs: number | null;
  readonly #pending = new Map<string, PendingEntry<T>>();

  constructor(timeoutMs: number | null) {
    this.#timeoutMs = timeoutMs;
  }

  /** Registers a pending request under `id`. `settle` resolves it with the
   *  decision. `onTimeout` supplies the value to settle with if the finite
   *  timeout elapses; it is never called when no timeout is configured. */
  add(id: string, settle: (value: T) => void, onTimeout: () => T): void {
    if (this.#timeoutMs === null) {
      // No timeout: wait indefinitely, matching the SDK's canUseTool default
      // (ADR-0022 F6). close() still settles pending requests on shutdown.
      this.#pending.set(id, { settle, timer: null });
      return;
    }
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      settle(onTimeout());
    }, this.#timeoutMs);
    // Let the process exit even while a request is pending.
    timer.unref?.();
    this.#pending.set(id, { settle, timer });
  }

  /** Settles a pending request by id; late/unknown ids are ignored (already
   *  timed out, closed, or never ours). */
  resolve(id: string, value: T): void {
    const entry = this.#pending.get(id);
    if (!entry) return;
    this.#pending.delete(id);
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.settle(value);
  }

  /** Settles every pending request with `value` (wrapper shutdown). */
  closeAll(value: T): void {
    for (const [id, entry] of this.#pending) {
      this.#pending.delete(id);
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.settle(value);
    }
  }
}
