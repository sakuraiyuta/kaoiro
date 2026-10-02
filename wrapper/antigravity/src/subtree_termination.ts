import { ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";

/** The minimal shape `planSignal` / `terminateWithGrace` need. */
export interface TerminableProcess {
  readonly pid?: number | undefined;
  exitCode?: number | null | undefined;
  signalCode?: NodeJS.Signals | null | undefined;
  kill(signal: NodeJS.Signals): boolean;
}

export type SignalPlan =
  | { kind: "none" }
  | { kind: "group"; pgid: number; signal: NodeJS.Signals; fallbackTarget: TerminableProcess }
  | { kind: "direct"; target: TerminableProcess; signal: NodeJS.Signals };

export interface PlanSignalOptions {
  /** When true, plans to signal the process group via pgid. */
  group?: boolean | undefined;
}

/** True when `target` has not yet exited, per its own `exitCode` /
 *  `signalCode` (absent/undefined counts as alive, matching a real
 *  `ChildProcess` before `exit`). */
export function isAlive(target: TerminableProcess | null | undefined): boolean {
  if (!target) return false;
  return (target.exitCode ?? null) === null && (target.signalCode ?? null) === null;
}

/** Pure planning layer: derives a SignalPlan without issuing ANY OS syscalls.
 *  Guard mutation testing is strictly confined to this pure function. */
export function planSignal(
  target: TerminableProcess | null | undefined,
  signal: NodeJS.Signals,
  options: PlanSignalOptions = {},
): SignalPlan {
  if (!target || !isAlive(target)) {
    return { kind: "none" };
  }

  const pid = target.pid;
  // Guard invariants:
  // - pid must not be <= 1 (rejects 0, negative numbers, and 1 to prevent kill(-1) and kill(0))
  // - pid must not be process.pid (prevents signaling self or caller process group)
  // - pid must be an integer if provided as a number
  if (
    typeof pid === "number" &&
    (pid <= 1 || pid === process.pid || !Number.isInteger(pid))
  ) {
    return { kind: "none" };
  }

  if (options.group && typeof pid === "number" && pid > 1) {
    return {
      kind: "group",
      pgid: pid,
      signal,
      fallbackTarget: target,
    };
  }

  return {
    kind: "direct",
    target,
    signal,
  };
}

export type ProcessKillFn = (pid: number, signal: NodeJS.Signals | number) => boolean | void;

/** Executes a SignalPlan using an explicitly provided, mandatory killFn.
 *  M1: killFn is mandatory to prevent accidental omitted calls falling back to system kill.
 *  Enforces secondary defensive verification on pgid before calling killFn. */
export function executeSignalPlanWith(
  plan: SignalPlan,
  killFn: ProcessKillFn,
): boolean {
  if (plan.kind === "none") {
    return false;
  }

  if (plan.kind === "group") {
    // Secondary defensive barrier: even hand-crafted plans cannot bypass PGID invariants
    if (
      typeof plan.pgid !== "number" ||
      !Number.isInteger(plan.pgid) ||
      plan.pgid <= 1 ||
      plan.pgid === process.pid
    ) {
      return false;
    }
    try {
      killFn(-plan.pgid, plan.signal);
      return true;
    } catch {
      // Group kill failed (e.g. ESRCH or child not group leader); fall back to direct target.kill
    }
    try {
      return plan.fallbackTarget.kill(plan.signal);
    } catch {
      return false;
    }
  }

  try {
    return plan.target.kill(plan.signal);
  } catch {
    return false;
  }
}

/** Sends signal to an owned process, ensuring it is a verified live ChildProcess.
 *  M2: Closes the entire class against fakes by enforcing `target instanceof ChildProcess`.
 *  Returns false immediately for any non-ChildProcess, unverified PID, or dead process. */
export function signalOwnedChild(
  target: unknown,
  signal: NodeJS.Signals,
  options: PlanSignalOptions = {},
): boolean {
  if (!(target instanceof ChildProcess)) {
    return false;
  }
  const plan = planSignal(target, signal, options);
  return executeSignalPlanWith(plan, process.kill);
}

/** Sends `signal` to the process GROUP (`process.kill(-pid, signal)`) when
 *  `pid` is a valid positive integer > 1, falling back to `target.kill(signal)`
 *  (e.g. when pid is undefined or ESRCH). */
export function signalSubtree(
  target: TerminableProcess | null | undefined,
  signal: NodeJS.Signals,
): boolean {
  if (!target || !isAlive(target)) return false;
  const plan = planSignal(target, signal, { group: true });
  return executeSignalPlanWith(plan, process.kill);
}

export interface GraceTerminationOptions {
  /** Milliseconds from now before the SIGKILL escalation fires. */
  graceMs: number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  nowMs?: () => number;
  signalSubtree?: (target: TerminableProcess | null | undefined, signal: NodeJS.Signals) => boolean;
}

export interface GraceTerminationHandle {
  /** Clears the pending SIGKILL escalation without sending any signal. */
  cancel(): void;
  /** Re-arms the pending escalation to fire after min(remaining, newGraceMs). */
  shortenGraceTo(newGraceMs: number): void;
}

/** Sends SIGTERM to `target` now (via `signalSubtree`) and arms a SIGKILL
 *  escalation after `graceMs` unless cancelled first.
 *  Invariant: The plan is NOT cached; signalSubtree is called afresh at escalation time. */
export function terminateWithGrace(
  target: TerminableProcess,
  options: GraceTerminationOptions,
): GraceTerminationHandle {
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as never));
  const nowMs = options.nowMs ?? (() => performance.now());
  const signal = options.signalSubtree ?? signalSubtree;

  signal(target, "SIGTERM");

  let fired = !isAlive(target);
  let deadlineMs = nowMs() + options.graceMs;
  let timer: unknown = fired ? null : setTimer(onFire, options.graceMs);

  function onFire(): void {
    fired = true;
    signal(target, "SIGKILL");
  }

  return {
    cancel(): void {
      if (fired) return;
      fired = true;
      clearTimer(timer);
    },
    shortenGraceTo(newGraceMs: number): void {
      if (fired) return;
      const candidateDeadlineMs = nowMs() + newGraceMs;
      if (candidateDeadlineMs >= deadlineMs) return;
      clearTimer(timer);
      deadlineMs = candidateDeadlineMs;
      timer = setTimer(onFire, Math.max(0, deadlineMs - nowMs()));
    },
  };
}
