import { beforeEach, describe, expect, it } from "vitest";
import { ChildProcess } from "node:child_process";
import { isSafeSignalTarget, signalSubtree, terminateWithGrace, type SignalDestination, type SignalTargetOperation, type TerminableProcess } from "../src/subtree_termination.js";

// Mirrors turn_watchdog.test.ts's FakeTimers: `terminateWithGrace`'s default
// `nowMs` is `performance.now()`, which `vi.useFakeTimers()` does not mock in
// lockstep with `setTimeout`, so a self-driven fake keeps both in sync.
class FakeTimers {
  now = 0;
  #next = 0;
  #timers = new Map<number, { at: number; callback: () => void }>();

  set = (callback: () => void, delayMs: number): number => {
    const id = ++this.#next;
    this.#timers.set(id, { at: this.now + delayMs, callback });
    return id;
  };

  clear = (timer: unknown): void => {
    this.#timers.delete(timer as number);
  };

  advance(ms: number): void {
    const target = this.now + ms;
    while (true) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (due === undefined) break;
      this.#timers.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
    }
    this.now = target;
  }
}

function fakeProcess(overrides: Partial<TerminableProcess> = {}): TerminableProcess {
  return {
    pid: 12345,
    exitCode: null,
    signalCode: null,
    ...overrides,
  };
}

function childProcess(pid: number | undefined, exitCode: number | null = null, signalCode: NodeJS.Signals | null = null): ChildProcess {
  const child = new ChildProcess();
  Object.defineProperty(child, "pid", { configurable: true, writable: true, value: pid });
  Object.defineProperty(child, "exitCode", { configurable: true, writable: true, value: exitCode });
  Object.defineProperty(child, "signalCode", { configurable: true, writable: true, value: signalCode });
  return child;
}

interface SignalAttempt {
  target: unknown;
  destination: SignalDestination;
  signal: NodeJS.Signals;
}

const signalAttempts: SignalAttempt[] = [];

function fakeSignalTarget(result = true): SignalTargetOperation {
  return (target, destination, signal) => {
    const child = target as TerminableProcess;
    if (child.pid === undefined || (child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null) return false;
    signalAttempts.push({ target, destination, signal });
    return result;
  };
}

function expectedAttempts(target: unknown, ...signals: NodeJS.Signals[]): SignalAttempt[] {
  return signals.map((signal) => ({ target, destination: "process_group", signal }));
}

beforeEach(() => {
  signalAttempts.length = 0;
});

const terminateWithGraceDefault = terminateWithGrace;

function terminateWithGraceUsingFakeSignals(
  target: TerminableProcess,
  options: Parameters<typeof terminateWithGrace>[1],
) {
  return terminateWithGraceDefault(target, { ...options, signalTarget: fakeSignalTarget() });
}

describe("signalSubtree", () => {
  it("sends only to the detached child's process group", () => {
    const target = childProcess(999);
    const ok = signalSubtree(target, "SIGTERM", fakeSignalTarget());
    expect(ok).toBe(true);
    expect(signalAttempts).toEqual([{ target, destination: "process_group", signal: "SIGTERM" }]);
    expect(target.killed).toBe(false);
  });

  it("does not fall back to the child PID when process-group signaling fails", () => {
    const target = childProcess(999);
    expect(signalSubtree(target, "SIGKILL", fakeSignalTarget(false))).toBe(false);
    expect(signalAttempts).toEqual([{ target, destination: "process_group", signal: "SIGKILL" }]);
  });

  it.each([
    ["structural fake", fakeProcess() as unknown],
    ["missing pid", childProcess(undefined)],
    ["PID zero", childProcess(0)],
    ["PID one", childProcess(1)],
    ["self PID", childProcess(process.pid)],
    ["fractional PID", childProcess(2.5)],
    ["NaN PID", childProcess(Number.NaN)],
    ["exited child", childProcess(999, 0)],
    ["signaled child", childProcess(999, null, "SIGTERM")],
  ])("rejects an unsafe signal target (%s)", (_name, target) => {
    expect(isSafeSignalTarget(target)).toBe(false);
  });

  it("accepts a live real ChildProcess with a checked PID for the normal probe route", () => {
    const target = childProcess(999);
    expect(isSafeSignalTarget(target)).toBe(true);
  });
});

describe("terminateWithGrace", () => {
  it("sends SIGTERM immediately and SIGKILL after graceMs if the target is still alive", () => {
    const timers = new FakeTimers();
    const target = fakeProcess();
    terminateWithGraceUsingFakeSignals(target, {
      graceMs: 1_000,
      nowMs: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    expect(signalAttempts).toEqual(expectedAttempts(target, "SIGTERM"));
    timers.advance(999);
    expect(signalAttempts).toEqual(expectedAttempts(target, "SIGTERM"));
    timers.advance(1);
    expect(signalAttempts).toEqual(expectedAttempts(target, "SIGTERM", "SIGKILL"));
  });

  // issue #379 M4: the liveness check now lives in signalSubtree itself
  // (single choke point), so calling terminateWithGrace on a target that
  // is ALREADY dead at call time must send no SIGTERM and arm no timer --
  // there is nothing left to escalate against.
  it("sends no SIGTERM and arms no timer for a target already dead at call time (M4)", () => {
    const timers = new FakeTimers();
    const target = fakeProcess({ exitCode: 0 });
    const handle = terminateWithGraceUsingFakeSignals(target, {
      graceMs: 1_000,
      nowMs: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    expect(signalAttempts).toEqual([]);
    timers.advance(1_000);
    expect(signalAttempts).toEqual([]); // no stray timer fired late
    expect(() => handle.cancel()).not.toThrow();
    expect(() => handle.shortenGraceTo(1)).not.toThrow();
  });

  it("cancel() before graceMs elapses suppresses the SIGKILL", () => {
    const timers = new FakeTimers();
    const target = fakeProcess();
    const handle = terminateWithGraceUsingFakeSignals(target, {
      graceMs: 1_000,
      nowMs: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    expect(signalAttempts).toEqual(expectedAttempts(target, "SIGTERM"));
    handle.cancel();
    timers.advance(1_000);
    expect(signalAttempts).toEqual(expectedAttempts(target, "SIGTERM"));
  });

  it("cancel() after the escalation already fired is a harmless no-op", () => {
    const timers = new FakeTimers();
    const target = fakeProcess();
    const handle = terminateWithGraceUsingFakeSignals(target, {
      graceMs: 1_000,
      nowMs: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    timers.advance(1_000);
    expect(signalAttempts).toEqual(expectedAttempts(target, "SIGTERM", "SIGKILL"));
    expect(() => handle.cancel()).not.toThrow();
  });

  // issue #379 M3: a pid can be reused once the target has actually
  // exited. The escalation must re-check liveness at fire time rather than
  // trusting that cancel() ran in time.
  it("does not send SIGKILL when exitCode is already set at fire time (M3)", () => {
    const timers = new FakeTimers();
    const target = fakeProcess();
    terminateWithGraceUsingFakeSignals(target, {
      graceMs: 1_000,
      nowMs: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    target.exitCode = 0; // simulates the target exiting before the timer fires
    timers.advance(1_000);
    expect(signalAttempts).toEqual(expectedAttempts(target, "SIGTERM")); // SIGTERM only, never SIGKILL
  });

  it("does not send SIGKILL when signalCode is already set at fire time (M3)", () => {
    const timers = new FakeTimers();
    const target = fakeProcess();
    terminateWithGraceUsingFakeSignals(target, {
      graceMs: 1_000,
      nowMs: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    target.signalCode = "SIGTERM";
    timers.advance(1_000);
    expect(signalAttempts).toEqual(expectedAttempts(target, "SIGTERM"));
  });

  it("treats a fake that never sets exitCode/signalCode as always-alive (fake compat)", () => {
    const timers = new FakeTimers();
    const target = fakeProcess({ exitCode: undefined, signalCode: undefined });
    terminateWithGraceUsingFakeSignals(target, {
      graceMs: 1_000,
      nowMs: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    timers.advance(1_000);
    expect(signalAttempts).toEqual(expectedAttempts(target, "SIGTERM", "SIGKILL"));
  });

  describe("shortenGraceTo", () => {
    it("re-arms to fire sooner without re-sending SIGTERM", () => {
      const timers = new FakeTimers();
      const target = fakeProcess();
      const handle = terminateWithGraceUsingFakeSignals(target, {
        graceMs: 60_000,
        nowMs: () => timers.now,
        setTimer: timers.set,
        clearTimer: timers.clear,
      });
      expect(signalAttempts).toEqual(expectedAttempts(target, "SIGTERM")); // SIGTERM only, at arm time
      handle.shortenGraceTo(2_000);
      timers.advance(1_999);
      expect(signalAttempts).toEqual(expectedAttempts(target, "SIGTERM"));
      timers.advance(1);
      expect(signalAttempts).toEqual(expectedAttempts(target, "SIGTERM", "SIGKILL"));
    });

    it("never lengthens the deadline: a call with a LARGER graceMs is a no-op", () => {
      const timers = new FakeTimers();
      const target = fakeProcess();
      const handle = terminateWithGraceUsingFakeSignals(target, {
        graceMs: 1_000,
        nowMs: () => timers.now,
        setTimer: timers.set,
        clearTimer: timers.clear,
      });
      handle.shortenGraceTo(60_000);
      timers.advance(1_000);
      expect(signalAttempts).toEqual(expectedAttempts(target, "SIGTERM", "SIGKILL")); // still fired at the ORIGINAL 1s deadline
    });

    // issue #379 M2: repeat interrupt() calls the same shorten path with the
    // SAME graceMs; a later "now" always computes a later-or-equal candidate
    // deadline, so this must be a no-op (no re-signal, no re-arm).
    it("calling shortenGraceTo with the SAME graceMs after time has passed is a no-op", () => {
      const timers = new FakeTimers();
      const target = fakeProcess();
      const handle = terminateWithGraceUsingFakeSignals(target, {
        graceMs: 1_000,
        nowMs: () => timers.now,
        setTimer: timers.set,
        clearTimer: timers.clear,
      });
      timers.advance(200);
      handle.shortenGraceTo(1_000);
      timers.advance(799);
      expect(signalAttempts).toEqual(expectedAttempts(target, "SIGTERM"));
      timers.advance(1);
      expect(signalAttempts).toEqual(expectedAttempts(target, "SIGTERM", "SIGKILL")); // fired at the original 1000ms mark, not delayed
    });

    it("is a no-op once the escalation already fired", () => {
      const timers = new FakeTimers();
      const target = fakeProcess();
      const handle = terminateWithGraceUsingFakeSignals(target, {
        graceMs: 1_000,
        nowMs: () => timers.now,
        setTimer: timers.set,
        clearTimer: timers.clear,
      });
      timers.advance(1_000);
      expect(signalAttempts).toEqual(expectedAttempts(target, "SIGTERM", "SIGKILL"));
      expect(() => handle.shortenGraceTo(1)).not.toThrow();
      timers.advance(1_000);
      expect(signalAttempts).toEqual(expectedAttempts(target, "SIGTERM", "SIGKILL"));
    });
  });
});
