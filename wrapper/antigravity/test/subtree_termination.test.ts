import { describe, expect, it, vi } from "vitest";
import {
  executeSignalPlanWith,
  isAlive,
  planSignal,
  signalOwnedChild,
  terminateWithGrace,
  type ProcessKillFn,
  type TerminableProcess,
} from "../src/subtree_termination.js";

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

describe("planSignal", () => {
  it("derives a group signal plan when group option is true and pid is valid", () => {
    const target = fakeProcess({ pid: 999 });
    const plan = planSignal(target, "SIGTERM", { group: true });
    expect(plan).toEqual({
      kind: "group",
      pgid: 999,
      signal: "SIGTERM",
      fallbackTarget: target,
    });
  });

  it("derives a direct signal plan when group option is false or omitted", () => {
    const target = fakeProcess({ pid: 999 });
    const plan = planSignal(target, "SIGTERM");
    expect(plan).toEqual({
      kind: "direct",
      target,
      signal: "SIGTERM",
    });
  });

  it("returns kind 'none' when pid is <= 1 (M1: guards against kill(-1) and kill(0))", () => {
    expect(planSignal(fakeProcess({ pid: 1 }), "SIGTERM", { group: true }).kind).toBe("none");
    expect(planSignal(fakeProcess({ pid: 0 }), "SIGTERM", { group: true }).kind).toBe("none");
    expect(planSignal(fakeProcess({ pid: -1 }), "SIGTERM", { group: true }).kind).toBe("none");
    expect(planSignal(fakeProcess({ pid: -500 }), "SIGTERM", { group: true }).kind).toBe("none");
  });

  it("returns kind 'none' when pid equals process.pid (guards against signaling self group)", () => {
    expect(planSignal(fakeProcess({ pid: process.pid }), "SIGTERM", { group: true }).kind).toBe("none");
  });

  it("returns kind 'direct' fallback when pid is undefined", () => {
    expect(planSignal(fakeProcess({ pid: undefined }), "SIGTERM", { group: true }).kind).toBe("direct");
  });

  it("returns kind 'none' when pid is non-integer or NaN", () => {
    expect(planSignal(fakeProcess({ pid: 123.45 }), "SIGTERM", { group: true }).kind).toBe("none");
    expect(planSignal(fakeProcess({ pid: NaN }), "SIGTERM", { group: true }).kind).toBe("none");
  });

  it("refuses to plan when target already exited (exitCode or signalCode set) (M4)", () => {
    expect(planSignal(fakeProcess({ exitCode: 0 }), "SIGTERM", { group: true }).kind).toBe("none");
    expect(planSignal(fakeProcess({ signalCode: "SIGKILL" }), "SIGKILL", { group: true }).kind).toBe("none");
  });

  it("refuses to plan when target is null or undefined", () => {
    expect(planSignal(null, "SIGTERM").kind).toBe("none");
    expect(planSignal(undefined, "SIGTERM").kind).toBe("none");
  });
});

describe("executeSignalPlanWith", () => {
  it("executes group signal with mandatory killFn and falls back to target.kill on throw", () => {
    const target = fakeProcess({ pid: 999 });
    const plan = planSignal(target, "SIGTERM", { group: true });

    const calls: [number, NodeJS.Signals | number][] = [];
    const fakeKill: ProcessKillFn = (pid, sig) => {
      calls.push([pid, sig]);
      return true;
    };

    const ok = executeSignalPlanWith(plan, fakeKill);
    expect(ok).toBe(true);
    expect(calls).toEqual([[-999, "SIGTERM"]]);
    expect(target.killCalls).toEqual([]);
  });

  it("falls back to target.kill when killFn throws (e.g. ESRCH)", () => {
    const target = fakeProcess({ pid: 999 });
    const plan = planSignal(target, "SIGKILL", { group: true });

    const throwingKill: ProcessKillFn = () => {
      throw new Error("ESRCH");
    };

    const ok = executeSignalPlanWith(plan, throwingKill);
    expect(ok).toBe(true);
    expect(target.killCalls).toEqual(["SIGKILL"]);
  });

  it("propagates false when fallback target.kill returns false", () => {
    const target = fakeProcess({
      pid: 999,
      kill: () => false,
    });
    const plan = planSignal(target, "SIGTERM", { group: true });

    const throwingKill: ProcessKillFn = () => {
      throw new Error("ESRCH");
    };

    expect(executeSignalPlanWith(plan, throwingKill)).toBe(false);
  });

  it("returns false immediately when plan is kind 'none'", () => {
    const calls: number[] = [];
    const fakeKill: ProcessKillFn = (pid) => {
      calls.push(pid);
      return true;
    };
    expect(executeSignalPlanWith({ kind: "none" }, fakeKill)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("secondary defense: rejects hand-crafted plans with invalid pgid (<= 1 or process.pid)", () => {
    const calls: number[] = [];
    const fakeKill: ProcessKillFn = (pid) => {
      calls.push(pid);
      return true;
    };
    const target = fakeProcess();

    // Hand-crafted plan with pgid = 1
    const dangerousPlan1 = {
      kind: "group" as const,
      pgid: 1,
      signal: "SIGKILL" as const,
      fallbackTarget: target,
    };
    expect(executeSignalPlanWith(dangerousPlan1, fakeKill)).toBe(false);

    // Hand-crafted plan with pgid = process.pid
    const dangerousPlanSelf = {
      kind: "group" as const,
      pgid: process.pid,
      signal: "SIGKILL" as const,
      fallbackTarget: target,
    };
    expect(executeSignalPlanWith(dangerousPlanSelf, fakeKill)).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("signalOwnedChild (M2 class closure & negative control)", () => {
  it("negative control: returns false and never signals fake process with numeric PID", () => {
    const fakeChild = fakeProcess({ pid: 9999 });
    const ok = signalOwnedChild(fakeChild, "SIGKILL");
    expect(ok).toBe(false);
    expect(fakeChild.killCalls).toEqual([]);
  });

  it("negative control: rejects plain objects, null, undefined", () => {
    expect(signalOwnedChild({ pid: 123 }, "SIGTERM")).toBe(false);
    expect(signalOwnedChild(null, "SIGTERM")).toBe(false);
    expect(signalOwnedChild(undefined, "SIGTERM")).toBe(false);
  });
});

describe("terminateWithGrace", () => {
  function recordingSignalSubtree() {
    const sentSignals: [unknown, NodeJS.Signals][] = [];
    const fakeSignalSubtree = (t: unknown, sig: NodeJS.Signals) => {
      if (!isAlive(t as TerminableProcess)) return false;
      sentSignals.push([t, sig]);
      return true;
    };
    return { sentSignals, fakeSignalSubtree };
  }

  it("sends SIGTERM immediately and SIGKILL after graceMs if the target is still alive", () => {
    const timers = new FakeTimers();
    const target = fakeProcess();
    const { sentSignals, fakeSignalSubtree } = recordingSignalSubtree();

    terminateWithGrace(target, {
      graceMs: 1_000,
      nowMs: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
      signalSubtree: fakeSignalSubtree,
    });

    expect(sentSignals).toEqual([[target, "SIGTERM"]]);
    timers.advance(999);
    expect(sentSignals).toEqual([[target, "SIGTERM"]]);
    timers.advance(1);
    expect(sentSignals).toEqual([
      [target, "SIGTERM"],
      [target, "SIGKILL"],
    ]);
  });

  it("sends no SIGTERM and arms no timer for a target already dead at call time (M4)", () => {
    const timers = new FakeTimers();
    const target = fakeProcess({ exitCode: 0 });
    const { sentSignals, fakeSignalSubtree } = recordingSignalSubtree();

    const handle = terminateWithGrace(target, {
      graceMs: 1_000,
      nowMs: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
      signalSubtree: fakeSignalSubtree,
    });

    expect(sentSignals).toEqual([]); // not alive at call time, so signalSubtree returns false
    timers.advance(1_000);
    expect(sentSignals).toEqual([]); // no stray timer fired late
    expect(() => handle.cancel()).not.toThrow();
    expect(() => handle.shortenGraceTo(1)).not.toThrow();
  });

  it("cancel() before graceMs elapses suppresses the SIGKILL", () => {
    const timers = new FakeTimers();
    const target = fakeProcess();
    const { sentSignals, fakeSignalSubtree } = recordingSignalSubtree();

    const handle = terminateWithGrace(target, {
      graceMs: 1_000,
      nowMs: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
      signalSubtree: fakeSignalSubtree,
    });

    expect(sentSignals.length).toBe(1);
    handle.cancel();
    timers.advance(1_000);
    expect(sentSignals.length).toBe(1);
  });

  it("cancel() after the escalation already fired is a harmless no-op", () => {
    const timers = new FakeTimers();
    const target = fakeProcess();
    const { sentSignals, fakeSignalSubtree } = recordingSignalSubtree();

    const handle = terminateWithGrace(target, {
      graceMs: 1_000,
      nowMs: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
      signalSubtree: fakeSignalSubtree,
    });

    timers.advance(1_000);
    expect(sentSignals.length).toBe(2);
    expect(() => handle.cancel()).not.toThrow();
  });

  it("does not send SIGKILL when exitCode is already set at fire time (M3)", () => {
    const timers = new FakeTimers();
    const target = fakeProcess();
    const { sentSignals, fakeSignalSubtree } = recordingSignalSubtree();

    terminateWithGrace(target, {
      graceMs: 1_000,
      nowMs: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
      signalSubtree: fakeSignalSubtree,
    });

    target.exitCode = 0; // simulates child exit before escalation
    timers.advance(1_000);
    expect(sentSignals).toEqual([[target, "SIGTERM"]]);
  });

  it("does not send SIGKILL when signalCode is already set at fire time (M3)", () => {
    const timers = new FakeTimers();
    const target = fakeProcess();
    const { sentSignals, fakeSignalSubtree } = recordingSignalSubtree();

    terminateWithGrace(target, {
      graceMs: 1_000,
      nowMs: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
      signalSubtree: fakeSignalSubtree,
    });

    target.signalCode = "SIGTERM";
    timers.advance(1_000);
    expect(sentSignals).toEqual([[target, "SIGTERM"]]);
  });

  it("treats a fake that never sets exitCode/signalCode as always-alive (fake compat)", () => {
    const timers = new FakeTimers();
    const target = fakeProcess({ exitCode: undefined, signalCode: undefined });
    const { sentSignals, fakeSignalSubtree } = recordingSignalSubtree();

    terminateWithGrace(target, {
      graceMs: 1_000,
      nowMs: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
      signalSubtree: fakeSignalSubtree,
    });

    timers.advance(1_000);
    expect(sentSignals.length).toBe(2);
  });

  describe("shortenGraceTo", () => {
    it("re-arms to fire sooner without re-sending SIGTERM", () => {
      const timers = new FakeTimers();
      const target = fakeProcess();
      const { sentSignals, fakeSignalSubtree } = recordingSignalSubtree();

      const handle = terminateWithGrace(target, {
        graceMs: 60_000,
        nowMs: () => timers.now,
        setTimer: timers.set,
        clearTimer: timers.clear,
        signalSubtree: fakeSignalSubtree,
      });

      expect(sentSignals).toEqual([[target, "SIGTERM"]]);
      handle.shortenGraceTo(2_000);
      timers.advance(1_999);
      expect(sentSignals.length).toBe(1);
      timers.advance(1);
      expect(sentSignals).toEqual([
        [target, "SIGTERM"],
        [target, "SIGKILL"],
      ]);
    });

    it("never lengthens the deadline: a call with a LARGER graceMs is a no-op", () => {
      const timers = new FakeTimers();
      const target = fakeProcess();
      const { sentSignals, fakeSignalSubtree } = recordingSignalSubtree();

      const handle = terminateWithGrace(target, {
        graceMs: 1_000,
        nowMs: () => timers.now,
        setTimer: timers.set,
        clearTimer: timers.clear,
        signalSubtree: fakeSignalSubtree,
      });

      handle.shortenGraceTo(60_000);
      timers.advance(1_000);
      expect(sentSignals.length).toBe(2); // still fired at the ORIGINAL 1s deadline
    });

    it("calling shortenGraceTo with the SAME graceMs after time has passed is a no-op", () => {
      const timers = new FakeTimers();
      const target = fakeProcess();
      const { sentSignals, fakeSignalSubtree } = recordingSignalSubtree();

      const handle = terminateWithGrace(target, {
        graceMs: 1_000,
        nowMs: () => timers.now,
        setTimer: timers.set,
        clearTimer: timers.clear,
        signalSubtree: fakeSignalSubtree,
      });

      timers.advance(200);
      handle.shortenGraceTo(1_000);
      timers.advance(799);
      expect(sentSignals.length).toBe(1);
      timers.advance(1);
      expect(sentSignals.length).toBe(2);
    });

    it("is a no-op once the escalation already fired", () => {
      const timers = new FakeTimers();
      const target = fakeProcess();
      const { sentSignals, fakeSignalSubtree } = recordingSignalSubtree();

      const handle = terminateWithGrace(target, {
        graceMs: 1_000,
        nowMs: () => timers.now,
        setTimer: timers.set,
        clearTimer: timers.clear,
        signalSubtree: fakeSignalSubtree,
      });

      timers.advance(1_000);
      expect(sentSignals.length).toBe(2);
      expect(() => handle.shortenGraceTo(1)).not.toThrow();
      timers.advance(1_000);
      expect(sentSignals.length).toBe(2);
    });
  });
});
