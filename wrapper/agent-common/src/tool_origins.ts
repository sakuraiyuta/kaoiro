import type { ReplyOrigin } from "./reply_basis.js";

/** Native call IDs remain bound to their first observed input for a session. */
export class ToolOrigins {
  readonly #observed = new Map<string, ReplyOrigin>();
  readonly #pending = new Map<string, Set<(origin?: ReplyOrigin) => void>>();
  #current: { token: string; controller: AbortController } | undefined;
  readonly #independent = new Map<string, AbortController>();
  #full = false;
  #frozen = false;
  begin(token: string): void {
    if (this.#frozen) return;
    this.retire(); this.#current = { token, controller: new AbortController() };
  }
  beginIndependent(token: string): void {
    if (this.#frozen) return;
    if (this.#independent.has(token) || this.#current?.token === token) throw Error("SDK turn token reused");
    this.#independent.set(token, new AbortController());
  }
  retireIndependent(token: string): void {
    this.#independent.get(token)?.abort();
    this.#independent.delete(token);
    this.#settlePending();
  }
  bind(id: string, token: string): void {
    if (!id || this.#full || this.#frozen) return;
    const controller = this.#current?.token === token ? this.#current.controller : this.#independent.get(token);
    if (!controller || controller.signal.aborted) return;
    const previous = this.#observed.get(id);
    if (previous && previous.token !== token) this.#observed.set(id, { token: previous.token, signal: AbortSignal.abort() });
    else if (!previous) {
      if (this.#observed.size >= 8192) {
        this.#full = true;
        this.retire();
        for (const active of this.#independent.values()) active.abort();
        this.#independent.clear();
        return;
      }
      this.#observed.set(id, { token, signal: controller.signal });
    }
    const origin = this.#observed.get(id);
    for (const resolve of this.#pending.get(id) ?? []) resolve(origin);
    this.#pending.delete(id);
  }
  #settlePending(): void {
    for (const callbacks of this.#pending.values()) for (const resolve of callbacks) resolve();
    this.#pending.clear();
  }
  retire(): void {
    this.#current?.controller.abort(); this.#current = undefined;
    this.#settlePending();
  }
  freeze(): void {
    this.#frozen = true;
    this.retire();
    for (const controller of this.#independent.values()) controller.abort();
    this.#independent.clear();
  }
  reset(): void { this.retire(); for (const controller of this.#independent.values()) controller.abort(); this.#independent.clear(); this.#observed.clear(); this.#full = false; }
  observe(id: string): void {
    const current = this.#current;
    if (!current || this.#full || this.#frozen) return;
    const previous = this.#observed.get(id);
    if (previous && previous.token !== current.token) {
      this.#observed.set(id, { token: previous.token, signal: AbortSignal.abort() });
    } else if (!previous) {
      if (this.#observed.size >= 8192) {
        this.#full = true;
        this.retire();
        for (const active of this.#independent.values()) active.abort();
        this.#independent.clear();
        return;
      }
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
    if (this.#frozen) return Promise.resolve(undefined);
    if (!this.#current || [...this.#pending.values()].reduce((count, callbacks) => count + callbacks.size, 0) >= 64) return Promise.resolve(undefined);
    return new Promise(resolve => {
      let callbacks = this.#pending.get(id);
      if (!callbacks) { callbacks = new Set(); this.#pending.set(id, callbacks); }
      callbacks.add(resolve);
    });
  }
  resolveBound(id: unknown): Promise<ReplyOrigin | undefined> {
    if (typeof id !== "string" || !id || this.#full) return Promise.resolve(undefined);
    const found = this.#observed.get(id);
    if (found) return Promise.resolve(found);
    if (this.#frozen) return Promise.resolve(undefined);
    if ([...this.#pending.values()].reduce((count, callbacks) => count + callbacks.size, 0) >= 64) return Promise.resolve(undefined);
    return new Promise(resolve => {
      let callbacks = this.#pending.get(id);
      if (!callbacks) { callbacks = new Set(); this.#pending.set(id, callbacks); }
      let timer: ReturnType<typeof setTimeout>;
      const finish = (origin?: ReplyOrigin) => {
        clearTimeout(timer);
        callbacks!.delete(finish);
        if (callbacks!.size === 0) this.#pending.delete(id);
        resolve(origin);
      };
      callbacks.add(finish);
      timer = setTimeout(() => finish(), 5_000);
    });
  }
}
