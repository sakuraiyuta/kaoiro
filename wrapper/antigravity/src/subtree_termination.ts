import { performance } from "node:perf_hooks";

/** The minimal shape `signalSubtree` / `terminateWithGrace` need. Any
 *  `SpawnedAgy` satisfies this; `exitCode` / `signalCode` are optional so a
 *  test fake that never tracks exit state is treated as always-alive,
 *  matching a real `ChildProcess` before it has exited. */
export interface TerminableProcess {
  readonly pid?: number | undefined;
  // Not `readonly`: a real `ChildProcess`'s own typing does not mark these
  // readonly either (Node writes them internally on exit); this module only
  // ever reads them, but a test fake needs to be able to set them to
  // simulate a target exiting.
  exitCode?: number | null | undefined;
  signalCode?: NodeJS.Signals | null | undefined;
  kill(signal: NodeJS.Signals): boolean;
}

/** True when `target` has not yet exited, per its own `exitCode` /
 *  `signalCode` (absent/undefined counts as alive, matching a real
 *  `ChildProcess` before `exit` and a test fake that never tracks exit
 *  state). */
function isAlive(target: TerminableProcess): boolean {
  return (target.exitCode ?? null) === null && (target.signalCode ?? null) === null;
}

/** Sends `signal` to the process GROUP (`process.kill(-pid, signal)`) when
 *  `pid` is known, so a grandchild the target spawned (e.g. a `run_command`
 *  promoted background task, issue #377) is reached too -- the production
 *  default spawn creates its own group for exactly this (issue #379).
 *  Falls back to `target.kill(signal)` on any failure (pid undefined,
 *  ESRCH, or a platform where negative-pid group signalling is not
 *  meaningful) so a caller never needs its own try/catch. Linux is the
 *  only platform this is verified on; the fallback keeps other platforms
 *  best-effort rather than throwing.
 *
 *  Checks `isAlive(target)` FIRST, unconditionally (issue #379 M4): a
 *  `ChildProcess`'s own `.kill()` already no-ops after `exit` (measured:
 *  returns `false`, no syscall) because it tracks its own handle's
 *  liveness, but `process.kill(-pid, signal)` is a raw OS-level call with
 *  no such awareness -- once the process has actually exited, that pid (or
 *  a process group sharing its number) can be reused by something
 *  completely unrelated, and a signal sent to it then would hit that
 *  unrelated target instead. This is the single choke point for every
 *  caller (the initial SIGTERM, the SIGKILL escalation, and the
 *  watchdog's direct SIGTERM/SIGKILL calls all route through here), so
 *  fixing it once here closes the class rather than requiring every call
 *  site to remember its own check. */
export function signalSubtree(target: TerminableProcess, signal: NodeJS.Signals): boolean {
  if (!isAlive(target)) return false;
  if (target.pid !== undefined) {
    try {
      process.kill(-target.pid, signal);
      return true;
    } catch {
      // Fall through to the single-process fallback below.
    }
  }
  return target.kill(signal);
}

export interface GraceTerminationOptions {
  /** Milliseconds from now before the SIGKILL escalation fires. */
  graceMs: number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  nowMs?: () => number;
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

  signalSubtree(target, "SIGTERM");

  let fired = !isAlive(target);
  let deadlineMs = nowMs() + options.graceMs;
  let timer: unknown = fired ? null : setTimer(onFire, options.graceMs);

  function onFire(): void {
    fired = true;
    signalSubtree(target, "SIGKILL");
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
