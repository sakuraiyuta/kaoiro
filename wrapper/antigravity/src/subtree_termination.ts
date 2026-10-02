import { performance } from "node:perf_hooks";
import { ChildProcess } from "node:child_process";

export type SignalDestination = "pid" | "process_group";
export type SignalTargetOperation = (
  target: unknown,
  destination: SignalDestination,
  signal: NodeJS.Signals,
) => boolean;

/** A single production gate for every OS signal sent to a spawned child. */
export function isSafeSignalTarget(target: unknown): target is ChildProcess & { pid: number } {
  if (!(target instanceof ChildProcess)) return false;
  const pid = target.pid;
  return target.exitCode === null
    && target.signalCode === null
    && typeof pid === "number"
    && Number.isInteger(pid)
    && pid >= 2
    && pid !== process.pid;
}

/** Sends only to a checked child PID or its checked process group.
 *  The PID destination is the normal probe path, not a fallback from group failure. */
export const signalTarget: SignalTargetOperation = (target, destination, signal) => {
  if (!isSafeSignalTarget(target)) return false;
  const pid = destination === "process_group" ? -target.pid : target.pid;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
};

/** The fields needed by the termination timer. Production signals still
 *  require the real ChildProcess checked by `signalTarget`. */
export interface TerminableProcess {
  readonly pid?: number | undefined;
  // Not `readonly`: a real `ChildProcess`'s own typing does not mark these
  // readonly either (Node writes them internally on exit); this module only
  // ever reads them, but a test fake needs to be able to set them to
  // simulate a target exiting.
  exitCode?: number | null | undefined;
  signalCode?: NodeJS.Signals | null | undefined;
}

/** True when `target` has not yet exited, per its own `exitCode` /
 *  `signalCode`. */
function isAlive(target: TerminableProcess): boolean {
  return (target.exitCode ?? null) === null && (target.signalCode ?? null) === null;
}

/** Ends a detached agy subtree using only its process-group destination.
 *  A failed group signal is final; changing to the PID path could send to a
 *  different set of processes and must never be an implicit fallback. */
export function signalSubtree(
  target: TerminableProcess,
  signal: NodeJS.Signals,
  send: SignalTargetOperation = signalTarget,
): boolean {
  return send(target, "process_group", signal);
}

export interface GraceTerminationOptions {
  /** Milliseconds from now before the SIGKILL escalation fires. */
  graceMs: number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  nowMs?: () => number;
  signalTarget?: SignalTargetOperation;
}

export interface GraceTerminationHandle {
  /** Clears the pending SIGKILL escalation without sending any signal.
   *  Call this as soon as the target is known to have exited (its own
   *  `close` or `exit` event) -- never on a value read only when the timer
   *  fires, since the target's pid can be reused by an unrelated process
   *  once it has actually exited (issue #379 M3). A no-op once the
   *  escalation has already fired or been cancelled. */
  cancel(): void;
  /** Re-arms the pending escalation to fire after
   *  `min(currently remaining grace, newGraceMs)` from now, WITHOUT
   *  re-sending SIGTERM (already sent once, at `terminateWithGrace()`
   *  time). Used when a shorter deadline supersedes the original one (a
   *  host `close()` arriving after an `interrupt()` already armed the
   *  longer `abortGraceMs`, issue #379 M2) -- never lengthens the
   *  deadline. A no-op once the escalation has already fired or been
   *  cancelled. */
  shortenGraceTo(newGraceMs: number): void;
}

/** Sends SIGTERM to `target` now (via `signalSubtree`) and arms a SIGKILL
 *  escalation after `graceMs` unless cancelled first. `signalSubtree`
 *  itself re-checks liveness immediately before every signal it sends
 *  (issue #379 M4), so a `target` that is already dead when this is
 *  called -- or dies between the initial SIGTERM and the escalation --
 *  never gets a raw pid-based signal that could reach a reused pid; when
 *  it is already dead at call time, no timer is armed at all (nothing to
 *  escalate). Generic on purpose, not interrupt-specific -- issue #377
 *  Stage 2 (epoch termination) is expected to reuse this for the same
 *  "end this active child + its group, with a grace" operation. */
export function terminateWithGrace(
  target: TerminableProcess,
  options: GraceTerminationOptions,
): GraceTerminationHandle {
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as never));
  const nowMs = options.nowMs ?? (() => performance.now());
  const send = options.signalTarget ?? signalTarget;

  signalSubtree(target, "SIGTERM", send);

  let fired = !isAlive(target);
  let deadlineMs = nowMs() + options.graceMs;
  let timer: unknown = fired ? null : setTimer(onFire, options.graceMs);

  function onFire(): void {
    fired = true;
    signalSubtree(target, "SIGKILL", send);
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
