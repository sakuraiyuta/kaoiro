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

/** Sends `signal` to the process GROUP (`process.kill(-pid, signal)`) when
 *  `pid` is known, so a grandchild the target spawned (e.g. a `run_command`
 *  promoted background task, issue #377) is reached too -- the production
 *  default spawn creates its own group for exactly this (issue #379).
 *  Falls back to `target.kill(signal)` on any failure (pid undefined,
 *  ESRCH, or a platform where negative-pid group signalling is not
 *  meaningful) so a caller never needs its own try/catch. Linux is the
 *  only platform this is verified on; the fallback keeps other platforms
 *  best-effort rather than throwing. */
export function signalSubtree(target: TerminableProcess, signal: NodeJS.Signals): boolean {
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
 *  escalation after `graceMs` unless cancelled first. The escalation
 *  re-checks `target.exitCode` / `target.signalCode` immediately before
 *  signalling (issue #379 M3): if either is already non-null the target
 *  has exited and its pid may have been reused, so no signal is sent.
 *  Generic on purpose, not interrupt-specific -- issue #377 Stage 2
 *  (epoch termination) is expected to reuse this for the same "end this
 *  active child + its group, with a grace" operation. */
export function terminateWithGrace(
  target: TerminableProcess,
  options: GraceTerminationOptions,
): GraceTerminationHandle {
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as never));
  const nowMs = options.nowMs ?? (() => performance.now());

  signalSubtree(target, "SIGTERM");

  let fired = false;
  let deadlineMs = nowMs() + options.graceMs;
  let timer: unknown = setTimer(onFire, options.graceMs);

  function onFire(): void {
    fired = true;
    // Still alive (both null/undefined): escalate. Already exited: skip --
    // signalling now could reach a reused pid instead of this target.
    if ((target.exitCode ?? null) === null && (target.signalCode ?? null) === null) {
      signalSubtree(target, "SIGKILL");
    }
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
