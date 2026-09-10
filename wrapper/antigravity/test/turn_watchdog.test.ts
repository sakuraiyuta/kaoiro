import { describe, expect, it } from "vitest";
import {
  DEFAULT_TURN_WATCHDOG_ABORT_GRACE_MS,
  DEFAULT_TURN_WATCHDOG_INACTIVITY_MS,
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
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (due === undefined) break;
      this.#timers.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
    }
    this.now = target;
  }
}

describe("Antigravity TurnWatchdog", () => {
  it("resets on agy stream progress, then requests interrupt and exact fail-stop", () => {
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
    timers.advance(1_000);
    expect(interrupts).toEqual(["turn-a"]);
    timers.advance(60);

    expect(failStops).toEqual(["turn-a"]);
    expect(warnings).toContainEqual({
      kind: "inactivity_timeout",
      turnToken: "turn-a",
      idleMs: 1_000,
      inactivityMs: 1_000,
    });
    expect(warnings).toContainEqual({
      kind: "abort_grace_expired",
      turnToken: "turn-a",
      abortGraceMs: 60,
    });
  });

  it("uses Antigravity-local environment settings and validates a short operational override", () => {
    const warnings: string[] = [];
    expect(readTurnWatchdogSettings({}, (message) => warnings.push(message))).toEqual({
      inactivityMs: DEFAULT_TURN_WATCHDOG_INACTIVITY_MS,
      abortGraceMs: DEFAULT_TURN_WATCHDOG_ABORT_GRACE_MS,
    });
    expect(readTurnWatchdogSettings({
      [TURN_WATCHDOG_INACTIVITY_ENV]: "60000",
      [TURN_WATCHDOG_ABORT_GRACE_ENV]: "1",
    }, (message) => warnings.push(message))).toEqual({
      inactivityMs: 60_000,
      abortGraceMs: 1,
    });
    expect(warnings).toHaveLength(1);
  });
});
