import { describe, expect, it } from "vitest";
import {
  DEFAULT_TURN_WATCHDOG_ABORT_GRACE_MS,
  DEFAULT_TURN_WATCHDOG_INACTIVITY_MS,
  MAX_TURN_WATCHDOG_DELAY_MS,
  MIN_TURN_WATCHDOG_INACTIVITY_MS,
  TURN_WATCHDOG_ABORT_GRACE_ENV,
  TURN_WATCHDOG_INACTIVITY_ENV,
  TurnWatchdog,
  readTurnWatchdogSettings,
  type TurnWatchdogWarning,
} from "../src/turn_watchdog.js";

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
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.#timers.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
    }
    this.now = target;
  }
}

describe("Codex TurnWatchdog", () => {
  it("default composition binds performance.now and reaches its first lifecycle action", () => {
    const warnings: TurnWatchdogWarning[] = [];
    const watchdog = new TurnWatchdog({
      settings: {
        inactivityMs: DEFAULT_TURN_WATCHDOG_INACTIVITY_MS,
        abortGraceMs: DEFAULT_TURN_WATCHDOG_ABORT_GRACE_MS,
      },
      onWarning: (warning) => warnings.push(warning),
      requestInterrupt: () => true,
      failStop: () => true,
      failStopUnattributed: () => {},
    });

    watchdog.start("default-turn");
    watchdog.progress("default-turn");
    watchdog.end("default-turn");

    expect(warnings).toEqual([]);
  });

  it("SDK frame progress resets inactivity, then abort grace reaches exact fail-stop", () => {
    const timers = new FakeTimers();
    const warnings: TurnWatchdogWarning[] = [];
    const interrupts: string[] = [];
    const failStops: string[] = [];
    const watchdog = new TurnWatchdog({
      settings: { inactivityMs: 1_000, abortGraceMs: 60 },
      onWarning: (warning) => warnings.push(warning),
      requestInterrupt: (token) => {
        interrupts.push(token);
        return true;
      },
      failStop: (token) => {
        failStops.push(token);
        return true;
      },
      failStopUnattributed: () => {
        throw new Error("unexpected unattributed fail-stop");
      },
      nowMs: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });

    watchdog.start("turn-a");
    timers.advance(999);
    watchdog.progress("turn-a");
    timers.advance(999);
    expect(warnings).toEqual([]);

    timers.advance(1);
    expect(interrupts).toEqual(["turn-a"]);
    expect(warnings).toContainEqual({
      kind: "inactivity_timeout",
      turnToken: "turn-a",
      idleMs: 1_000,
      inactivityMs: 1_000,
    });

    timers.advance(60);
    expect(failStops).toEqual(["turn-a"]);
    expect(warnings).toContainEqual({
      kind: "abort_grace_expired",
      turnToken: "turn-a",
      abortGraceMs: 60,
    });
    watchdog.progress("turn-a");
    timers.advance(10_000);
    expect(failStops).toEqual(["turn-a"]);
  });

  it("progress over several inactivity windows is not a wall-clock turn limit", () => {
    const timers = new FakeTimers();
    const warnings: TurnWatchdogWarning[] = [];
    const watchdog = new TurnWatchdog({
      settings: {
        inactivityMs: DEFAULT_TURN_WATCHDOG_INACTIVITY_MS,
        abortGraceMs: DEFAULT_TURN_WATCHDOG_ABORT_GRACE_MS,
      },
      onWarning: (warning) => warnings.push(warning),
      requestInterrupt: () => true,
      failStop: () => true,
      failStopUnattributed: () => {},
      nowMs: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    watchdog.start("long-turn");
    for (let i = 0; i < 4; i += 1) {
      timers.advance(DEFAULT_TURN_WATCHDOG_INACTIVITY_MS - 1);
      watchdog.progress("long-turn");
    }
    expect(timers.now).toBeGreaterThan(90 * 60 * 1_000);
    expect(warnings).toEqual([]);
  });

  it("token mismatch and unavailable interrupt fail closed without guessing ownership", () => {
    const timers = new FakeTimers();
    const warnings: TurnWatchdogWarning[] = [];
    const fallbacks: string[] = [];
    const watchdog = new TurnWatchdog({
      settings: { inactivityMs: 10, abortGraceMs: 10 },
      onWarning: (warning) => warnings.push(warning),
      requestInterrupt: () => false,
      failStop: () => {
        throw new Error("exact fail-stop must not run");
      },
      failStopUnattributed: () => fallbacks.push("fallback"),
      nowMs: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    watchdog.start("turn-a");
    watchdog.start("turn-b");
    timers.advance(10);

    expect(warnings).toContainEqual({
      kind: "start_conflict",
      watchedTurnToken: "turn-a",
      startedTurnToken: "turn-b",
    });
    expect(fallbacks).toEqual(["fallback"]);

    const unavailableWarnings: TurnWatchdogWarning[] = [];
    const unavailable = new TurnWatchdog({
      settings: { inactivityMs: 10, abortGraceMs: 10 },
      onWarning: (warning) => unavailableWarnings.push(warning),
      requestInterrupt: () => false,
      failStop: () => true,
      failStopUnattributed: () => fallbacks.push("unavailable"),
      nowMs: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    unavailable.start("turn-c");
    timers.advance(10);
    expect(unavailableWarnings).toContainEqual({
      kind: "interrupt_unavailable",
      turnToken: "turn-c",
    });
    expect(fallbacks).toContain("unavailable");
  });
});

describe("Codex TurnWatchdog settings", () => {
  it("uses engine-local defaults and validates operational overrides", () => {
    const warnings: string[] = [];
    expect(readTurnWatchdogSettings({}, (message) => warnings.push(message))).toEqual({
      inactivityMs: DEFAULT_TURN_WATCHDOG_INACTIVITY_MS,
      abortGraceMs: DEFAULT_TURN_WATCHDOG_ABORT_GRACE_MS,
    });
    expect(
      readTurnWatchdogSettings(
        {
          [TURN_WATCHDOG_INACTIVITY_ENV]: "60000",
          [TURN_WATCHDOG_ABORT_GRACE_ENV]: "1",
        },
        (message) => warnings.push(message),
      ),
    ).toEqual({ inactivityMs: MIN_TURN_WATCHDOG_INACTIVITY_MS, abortGraceMs: 1 });
    expect(warnings).toHaveLength(1);
    expect(() =>
      readTurnWatchdogSettings(
        { [TURN_WATCHDOG_INACTIVITY_ENV]: String(MAX_TURN_WATCHDOG_DELAY_MS + 1) },
        () => {},
      ),
    ).toThrow();
  });
});
