import { WrapperShutdownBudget } from "./shutdown_budget.js";
import type { PhoenixPushOptions } from "./transport.js";

export type WrapperDisconnectReason = "stop" | "crash";

export interface WrapperShutdownHooks {
  begin(reason: WrapperDisconnectReason, receiptDeadline: number): Promise<void> | void;
  flushRetirements(signal: AbortSignal): Promise<unknown>;
  closeRetirementRequests(): void;
  reportDisconnectIntent(reason: WrapperDisconnectReason, options: PhoenixPushOptions): Promise<unknown>;
  closeLink(signal: AbortSignal): Promise<void> | void;
}

/** Runs the shared finalization, retirement-flush, then disconnect sequence once. */
export class WrapperShutdown {
  readonly #hooks: WrapperShutdownHooks;
  readonly #graceMs: number | undefined;
  readonly #now: (() => number) | undefined;
  #promise: Promise<void> | undefined;

  constructor(hooks: WrapperShutdownHooks, graceMs?: number, now?: () => number) {
    this.#hooks = hooks;
    this.#graceMs = graceMs;
    this.#now = now;
  }

  start(reason: WrapperDisconnectReason): Promise<void> {
    if (this.#promise !== undefined) return this.#promise;
    const budget = new WrapperShutdownBudget(this.#graceMs, this.#now);
    this.#promise = Promise.resolve().then(() => this.#run(reason, budget));
    return this.#promise;
  }

  #run(reason: WrapperDisconnectReason, budget: WrapperShutdownBudget): Promise<void> {
    return (async () => {
      await this.#attempt(() => this.#hooks.begin(reason, budget.deadline("receiptFinalization")));

      const retirement = budget.abortAt("retirementFlush");
      let retirementClosed = false;
      const closeRetirements = (): void => {
        if (retirementClosed) return;
        retirementClosed = true;
        this.#hooks.closeRetirementRequests();
      };
      retirement.signal.addEventListener("abort", closeRetirements, { once: true });
      if (retirement.signal.aborted) closeRetirements();
      try {
        await this.#attempt(() => this.#hooks.flushRetirements(retirement.signal));
      } finally {
        closeRetirements();
        retirement.signal.removeEventListener("abort", closeRetirements);
        retirement.dispose();
      }

      const disconnect = budget.abortAt("disconnectIntent");
      try {
        await this.#attempt(() => this.#hooks.reportDisconnectIntent(reason, {
          signal: disconnect.signal,
          timeoutMs: budget.remaining("disconnectIntent"),
        }));
      } finally {
        disconnect.dispose();
        const close = budget.abortAt("linkClose");
        try {
          await this.#attempt(() => this.#hooks.closeLink(close.signal));
        } finally {
          close.dispose();
        }
      }
    })();
  }

  async #attempt(action: () => Promise<unknown> | unknown): Promise<void> {
    try { await action(); } catch { /* cleanup continues through the remaining phases */ }
  }
}
