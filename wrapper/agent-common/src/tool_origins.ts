import type { ReplyOrigin } from "./reply_basis.js";

/** Native call IDs remain bound to their first observed input for a session. */
export class ToolOrigins {
  readonly #observed = new Map<string, ReplyOrigin>();
  readonly #pending = new Map<string, Set<(origin?: ReplyOrigin) => void>>();
  #current: { token: string; controller: AbortController } | undefined;
  #full = false;
  begin(token: string): void {
    this.retire(); this.#current = { token, controller: new AbortController() };
  }
  retire(): void {
    this.#current?.controller.abort(); this.#current = undefined;
    for (const callbacks of this.#pending.values()) for (const resolve of callbacks) resolve();
    this.#pending.clear();
  }
  reset(): void { this.retire(); this.#observed.clear(); this.#full = false; }
  observe(id: string): void {
    const current = this.#current;
    if (!current || this.#full) return;
    const previous = this.#observed.get(id);
    if (previous && previous.token !== current.token) {
      this.#observed.set(id, { token: previous.token, signal: AbortSignal.abort() });
    } else if (!previous) {
      if (this.#observed.size >= 8192) { this.#full = true; this.retire(); return; }
      this.#observed.set(id, { token: current.token, signal: current.controller.signal });
    }
    const origin = this.#observed.get(id);
    for (const resolve of this.#pending.get(id) ?? []) resolve(origin);
    this.#pending.delete(id);
  }
  resolve(id: unknown): Promise<ReplyOrigin | undefined> {
    if (typeof id !== "string" || !id || this.#full) return Promise.resolve(undefined);
    const found = this.#observed.get(id);
    if (found) return Promise.resolve(found);
    if (!this.#current || [...this.#pending.values()].reduce((count, callbacks) => count + callbacks.size, 0) >= 64) return Promise.resolve(undefined);
    return new Promise(resolve => {
      let callbacks = this.#pending.get(id);
      if (!callbacks) { callbacks = new Set(); this.#pending.set(id, callbacks); }
      callbacks.add(resolve);
    });
  }
}
