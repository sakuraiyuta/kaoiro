import { RESET_TERMINATION_GRACE_MS } from "@kaoiro/protocol";

export type ShutdownPhase = "receiptFinalization" | "retirementFlush" | "disconnectIntent" | "linkClose";

const CUTOFF_FRACTIONS: Record<ShutdownPhase, number> = {
  receiptFinalization: 0.4,
  retirementFlush: 0.7,
  disconnectIntent: 0.9,
  linkClose: 0.95,
};

/** One monotonic budget shared by every final-cleanup phase of a wrapper. */
export class WrapperShutdownBudget {
  readonly startedAt: number;
  readonly graceMs: number;
  readonly #now: () => number;

  constructor(graceMs = RESET_TERMINATION_GRACE_MS, now: () => number = () => performance.now()) {
    if (!Number.isFinite(graceMs) || graceMs <= 0) throw new RangeError("shutdown grace must be positive and finite");
    this.graceMs = graceMs;
    this.#now = now;
    this.startedAt = now();
  }

  deadline(phase: ShutdownPhase): number {
    return this.startedAt + this.graceMs * CUTOFF_FRACTIONS[phase];
  }

  remaining(phase: ShutdownPhase): number {
    return Math.max(0, this.deadline(phase) - this.#now());
  }

  abortAt(phase: ShutdownPhase): { signal: AbortSignal; dispose(): void } {
    const controller = new AbortController();
    const remaining = this.remaining(phase);
    if (remaining === 0) controller.abort();
    const timer = remaining === 0 ? undefined : setTimeout(() => controller.abort(), remaining);
    return {
      signal: controller.signal,
      dispose: () => { if (timer !== undefined) clearTimeout(timer); },
    };
  }
}
