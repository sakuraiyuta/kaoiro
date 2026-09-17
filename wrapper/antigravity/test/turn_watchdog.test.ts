import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  DEFAULT_TURN_WATCHDOG_ABORT_GRACE_MS,
  DEFAULT_TURN_WATCHDOG_INACTIVITY_MS,
  TOOL_TIMEOUT_ENV,
  TURN_WATCHDOG_ABORT_GRACE_ENV,
  TURN_WATCHDOG_INACTIVITY_ENV,
  TurnWatchdog,
  readTurnWatchdogSettings,
  type TurnWatchdogInterruptCause,
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
      settings: { inactivityMs: 1_000, abortGraceMs: 60, toolTimeoutMs: 10_000 },
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
      toolTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    });
    expect(readTurnWatchdogSettings({
      [TURN_WATCHDOG_INACTIVITY_ENV]: "60000",
      [TURN_WATCHDOG_ABORT_GRACE_ENV]: "1",
      [TOOL_TIMEOUT_ENV]: "1000",
    }, (message) => warnings.push(message))).toEqual({
      inactivityMs: 60_000,
      abortGraceMs: 1,
      toolTimeoutMs: 1_000,
    });
    expect(warnings).toHaveLength(1);
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBe(600_000);
    expect(() => readTurnWatchdogSettings({ [TOOL_TIMEOUT_ENV]: "999" }, () => {})).toThrow(TOOL_TIMEOUT_ENV);
  });

  function toolHarness(settings = { inactivityMs: 1_000, abortGraceMs: 60, toolTimeoutMs: 10_000 }) {
    const timers = new FakeTimers();
    const warnings: TurnWatchdogWarning[] = [];
    const interrupts: Array<{ token: string; cause: TurnWatchdogInterruptCause }> = [];
    const failStops: string[] = [];
    const watchdog = new TurnWatchdog({
      settings,
      onWarning: (warning) => warnings.push(warning),
      requestInterrupt: (token, cause) => {
        interrupts.push({ token, cause });
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
    return { timers, warnings, interrupts, failStops, watchdog };
  }

  it("bounds an ACTIVE tool by an absolute deadline that stream progress does not extend (issue #350)", () => {
    const { timers, warnings, interrupts, failStops, watchdog } = toolHarness();
    watchdog.start("turn-a");
    timers.advance(500);
    watchdog.toolStart("turn-a", 3, "run_command");
    // Output keeps arriving well inside the inactivity window the whole time.
    for (let elapsed = 0; elapsed < 9_600; elapsed += 400) {
      timers.advance(400);
      watchdog.progress("turn-a");
      expect(interrupts).toEqual([]);
    }
    timers.advance(400);
    expect(interrupts).toEqual([{
      token: "turn-a",
      cause: { kind: "tool_timeout", stepIndex: 3, toolName: "run_command", elapsedMs: 10_000, toolTimeoutMs: 10_000 },
    }]);
    expect(warnings).toContainEqual({
      kind: "tool_timeout", turnToken: "turn-a", stepIndex: 3, toolName: "run_command", elapsedMs: 10_000, toolTimeoutMs: 10_000,
    });
    // agy printing after its SIGTERM does not reopen monitoring.
    timers.advance(30);
    watchdog.progress("turn-a");
    timers.advance(30);
    expect(failStops).toEqual(["turn-a"]);
    expect(interrupts).toHaveLength(1);
  });

  it("releases a tool on DONE before its deadline and keeps the inactivity bound", () => {
    const { timers, interrupts, watchdog } = toolHarness({ inactivityMs: 100_000, abortGraceMs: 60, toolTimeoutMs: 10_000 });
    watchdog.start("turn-a");
    watchdog.toolStart("turn-a", 3, "run_command");
    // A repeated ACTIVE keeps the original start.
    timers.advance(4_000);
    watchdog.toolStart("turn-a", 3, "run_command");
    timers.advance(5_000);
    watchdog.progress("turn-a");
    watchdog.toolEnd("turn-a", 3);
    timers.advance(2_000);
    expect(interrupts).toEqual([]);
    timers.advance(100_000);
    expect(interrupts).toEqual([{ token: "turn-a", cause: { kind: "inactivity", idleMs: 100_000 } }]);
  });

  it("keys the deadline on the oldest ACTIVE step and clears tracking at turn end", () => {
    const { timers, interrupts, watchdog } = toolHarness({ inactivityMs: 100_000, abortGraceMs: 60, toolTimeoutMs: 10_000 });
    watchdog.start("turn-a");
    watchdog.toolStart("turn-a", 3, "run_command");
    timers.advance(500);
    watchdog.toolStart("turn-a", 4, "view_file");
    watchdog.progress("turn-a");
    watchdog.toolEnd("turn-a", 4);
    watchdog.end("turn-a");
    timers.advance(20_000);
    expect(interrupts).toEqual([]);
    watchdog.start("turn-b");
    watchdog.toolStart("turn-b", 1, "run_command");
    timers.advance(500);
    watchdog.toolStart("turn-b", 2, "view_file");
    timers.advance(9_500);
    expect(interrupts.map((entry) => [entry.token, entry.cause.kind, (entry.cause as { stepIndex?: number }).stepIndex]))
      .toEqual([["turn-b", "tool_timeout", 1]]);
  });
});
