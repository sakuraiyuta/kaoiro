import { describe, expect, it, vi } from "vitest";
import { signalSubtree, terminateWithGrace, type TerminableProcess } from "../src/subtree_termination.js";

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

function fakeProcess(overrides: Partial<TerminableProcess> = {}): TerminableProcess & {
  killCalls: NodeJS.Signals[];
} {
  const killCalls: NodeJS.Signals[] = [];
  return {
    pid: 12345,
    exitCode: null,
    signalCode: null,
    kill: (signal: NodeJS.Signals) => {
      killCalls.push(signal);
      return true;
    },
    killCalls,
    ...overrides,
  };
}

describe("signalSubtree", () => {
  it("sends process.kill(-pid, signal) when pid is known", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const target = fakeProcess({ pid: 999 });
    const ok = signalSubtree(target, "SIGTERM");
    expect(ok).toBe(true);
    expect(spy).toHaveBeenCalledWith(-999, "SIGTERM");
    expect(target.killCalls).toEqual([]);
    spy.mockRestore();
  });

  it("falls back to target.kill when pid is undefined", () => {
    const spy = vi.spyOn(process, "kill");
    const target = fakeProcess({ pid: undefined });
    const ok = signalSubtree(target, "SIGTERM");
    expect(ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    expect(target.killCalls).toEqual(["SIGTERM"]);
    spy.mockRestore();
  });

  it("falls back to target.kill when process.kill(-pid) throws (e.g. ESRCH)", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    const target = fakeProcess();
    const ok = signalSubtree(target, "SIGKILL");
    expect(ok).toBe(true);
    expect(target.killCalls).toEqual(["SIGKILL"]);
    spy.mockRestore();
  });

  it("propagates a false return from the fallback kill", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    const target = fakeProcess({ kill: () => false });
    expect(signalSubtree(target, "SIGTERM")).toBe(false);
    spy.mockRestore();
  });

  // issue #379 M4: a real ChildProcess.kill() already no-ops after exit
  // (measured: returns false, no syscall), but process.kill(-pid, signal)
  // has no such awareness -- a dead pid can be reused by an unrelated
  // process/group. signalSubtree must refuse BEFORE attempting either path.
  it("refuses to signal (either path) when the target already exited (exitCode set) (M4)", () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const target = fakeProcess({ exitCode: 0 });
    expect(signalSubtree(target, "SIGTERM")).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();
    expect(target.killCalls).toEqual([]);
    killSpy.mockRestore();
  });

  it("refuses to signal (either path) when the target already exited (signalCode set) (M4)", () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const target = fakeProcess({ signalCode: "SIGTERM" });
    expect(signalSubtree(target, "SIGKILL")).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();
    expect(target.killCalls).toEqual([]);
    killSpy.mockRestore();
  });
});

describe("terminateWithGrace", () => {
  it("sends SIGTERM immediately and SIGKILL after graceMs if the target is still alive", () => {
    const timers = new FakeTimers();
    const target = fakeProcess();
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    terminateWithGrace(target, {
      graceMs: 1_000,
      nowMs: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenNthCalledWith(1, -12345, "SIGTERM");
    timers.advance(999);
    expect(spy).toHaveBeenCalledTimes(1);
    timers.advance(1);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(2, -12345, "SIGKILL");
    spy.mockRestore();
  });

  // issue #379 M4: the liveness check now lives in signalSubtree itself
  // (single choke point), so calling terminateWithGrace on a target that
  // is ALREADY dead at call time must send no SIGTERM and arm no timer --
  // there is nothing left to escalate against.
  it("sends no SIGTERM and arms no timer for a target already dead at call time (M4)", () => {
    const timers = new FakeTimers();
    const target = fakeProcess({ exitCode: 0 });
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const handle = terminateWithGrace(target, {
      graceMs: 1_000,
      nowMs: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    expect(spy).not.toHaveBeenCalled();
    expect(target.killCalls).toEqual([]);
    timers.advance(1_000);
    expect(spy).not.toHaveBeenCalled(); // no stray timer fired late
    expect(() => handle.cancel()).not.toThrow();
    expect(() => handle.shortenGraceTo(1)).not.toThrow();
    spy.mockRestore();
  });

  it("cancel() before graceMs elapses suppresses the SIGKILL", () => {
    const timers = new FakeTimers();
    const target = fakeProcess();
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const handle = terminateWithGrace(target, {
      graceMs: 1_000,
      nowMs: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    handle.cancel();
    timers.advance(1_000);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("cancel() after the escalation already fired is a harmless no-op", () => {
    const timers = new FakeTimers();
    const target = fakeProcess();
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const handle = terminateWithGrace(target, {
      graceMs: 1_000,
      nowMs: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    timers.advance(1_000);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(() => handle.cancel()).not.toThrow();
    spy.mockRestore();
  });

  // issue #379 M3: a pid can be reused once the target has actually
  // exited. The escalation must re-check liveness at fire time rather than
  // trusting that cancel() ran in time.
  it("does not send SIGKILL when exitCode is already set at fire time (M3)", () => {
    const timers = new FakeTimers();
    const target = fakeProcess();
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    terminateWithGrace(target, {
      graceMs: 1_000,
      nowMs: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    target.exitCode = 0; // simulates the target exiting before the timer fires
    timers.advance(1_000);
    expect(spy).toHaveBeenCalledTimes(1); // SIGTERM only, never SIGKILL
    spy.mockRestore();
  });

  it("does not send SIGKILL when signalCode is already set at fire time (M3)", () => {
    const timers = new FakeTimers();
    const target = fakeProcess();
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    terminateWithGrace(target, {
      graceMs: 1_000,
      nowMs: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    target.signalCode = "SIGTERM";
    timers.advance(1_000);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("treats a fake that never sets exitCode/signalCode as always-alive (fake compat)", () => {
    const timers = new FakeTimers();
    const target = fakeProcess({ exitCode: undefined, signalCode: undefined });
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    terminateWithGrace(target, {
      graceMs: 1_000,
      nowMs: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    timers.advance(1_000);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  describe("shortenGraceTo", () => {
    it("re-arms to fire sooner without re-sending SIGTERM", () => {
      const timers = new FakeTimers();
      const target = fakeProcess();
      const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
      const handle = terminateWithGrace(target, {
        graceMs: 60_000,
        nowMs: () => timers.now,
        setTimer: timers.set,
        clearTimer: timers.clear,
      });
      expect(spy).toHaveBeenCalledTimes(1); // SIGTERM only, at arm time
      handle.shortenGraceTo(2_000);
      timers.advance(1_999);
      expect(spy).toHaveBeenCalledTimes(1);
      timers.advance(1);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenNthCalledWith(2, -12345, "SIGKILL");
      spy.mockRestore();
    });

    it("never lengthens the deadline: a call with a LARGER graceMs is a no-op", () => {
      const timers = new FakeTimers();
      const target = fakeProcess();
      const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
      const handle = terminateWithGrace(target, {
        graceMs: 1_000,
        nowMs: () => timers.now,
        setTimer: timers.set,
        clearTimer: timers.clear,
      });
      handle.shortenGraceTo(60_000);
      timers.advance(1_000);
      expect(spy).toHaveBeenCalledTimes(2); // still fired at the ORIGINAL 1s deadline
      spy.mockRestore();
    });

    // issue #379 M2: repeat interrupt() calls the same shorten path with the
    // SAME graceMs; a later "now" always computes a later-or-equal candidate
    // deadline, so this must be a no-op (no re-signal, no re-arm).
    it("calling shortenGraceTo with the SAME graceMs after time has passed is a no-op", () => {
      const timers = new FakeTimers();
      const target = fakeProcess();
      const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
      const handle = terminateWithGrace(target, {
        graceMs: 1_000,
        nowMs: () => timers.now,
        setTimer: timers.set,
        clearTimer: timers.clear,
      });
      timers.advance(200);
      handle.shortenGraceTo(1_000);
      timers.advance(799);
      expect(spy).toHaveBeenCalledTimes(1);
      timers.advance(1);
      expect(spy).toHaveBeenCalledTimes(2); // fired at the original 1000ms mark, not delayed
      spy.mockRestore();
    });

    it("is a no-op once the escalation already fired", () => {
      const timers = new FakeTimers();
      const target = fakeProcess();
      const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
      const handle = terminateWithGrace(target, {
        graceMs: 1_000,
        nowMs: () => timers.now,
        setTimer: timers.set,
        clearTimer: timers.clear,
      });
      timers.advance(1_000);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(() => handle.shortenGraceTo(1)).not.toThrow();
      timers.advance(1_000);
      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockRestore();
    });
  });
});
