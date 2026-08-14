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
  #nextId = 0;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();

  set = (callback: () => void, delayMs: number): number => {
    const id = ++this.#nextId;
    this.#timers.set(id, { at: this.now + delayMs, callback });
    return id;
  };

  clear = (id: unknown): void => {
    if (typeof id === "number") this.#timers.delete(id);
  };

  advance(ms: number): void {
    const target = this.now + ms;
    while (true) {
      let next: [number, { at: number; callback: () => void }] | undefined;
      for (const entry of this.#timers) {
        if (entry[1].at <= target && (next === undefined || entry[1].at < next[1].at)) {
          next = entry;
        }
      }
      if (next === undefined) break;
      this.#timers.delete(next[0]);
      this.now = next[1].at;
      next[1].callback();
    }
    this.now = target;
  }
}

describe("TurnWatchdog (issue #248)", () => {
  it("既定は30分 inactivity・60秒 abort grace、短い指定は #221 の経緯を warning する", () => {
    const warnings: string[] = [];
    expect(readTurnWatchdogSettings({}, (warning) => warnings.push(warning))).toEqual({
      inactivityMs: DEFAULT_TURN_WATCHDOG_INACTIVITY_MS,
      abortGraceMs: DEFAULT_TURN_WATCHDOG_ABORT_GRACE_MS,
    });
    expect(warnings).toEqual([]);

    // The warning belongs to startup configuration parsing, not a global
    // once-only dedupe: every wrapper launch with this override must surface
    // the risk again after older logs have rolled away.
    const short = readTurnWatchdogSettings(
      { [TURN_WATCHDOG_INACTIVITY_ENV]: String(MIN_TURN_WATCHDOG_INACTIVITY_MS) },
      (warning) => warnings.push(warning),
    );
    expect(short.inactivityMs).toBe(MIN_TURN_WATCHDOG_INACTIVITY_MS);
    const shortAgain = readTurnWatchdogSettings(
      { [TURN_WATCHDOG_INACTIVITY_ENV]: String(MIN_TURN_WATCHDOG_INACTIVITY_MS) },
      (warning) => warnings.push(warning),
    );
    expect(shortAgain.inactivityMs).toBe(MIN_TURN_WATCHDOG_INACTIVITY_MS);
    expect(warnings).toHaveLength(2);
    expect(warnings.join(" ")).toContain("e97e708");
    expect(warnings.join(" ")).toContain("xhigh");
    expect(() =>
      readTurnWatchdogSettings(
        { [TURN_WATCHDOG_INACTIVITY_ENV]: String(MIN_TURN_WATCHDOG_INACTIVITY_MS - 1) },
        () => {},
      ),
    ).toThrow(`>= ${MIN_TURN_WATCHDOG_INACTIVITY_MS}`);
  });

  it("設定の境界: 60秒と30分ちょうどは受理、60秒未満・負値・非数値は拒否し、30分未満だけが warning", () => {
    const warnings: string[] = [];
    const exactThirtyMinutes = readTurnWatchdogSettings(
      { [TURN_WATCHDOG_INACTIVITY_ENV]: String(DEFAULT_TURN_WATCHDOG_INACTIVITY_MS) },
      (warning) => warnings.push(warning),
    );
    expect(exactThirtyMinutes.inactivityMs).toBe(
      DEFAULT_TURN_WATCHDOG_INACTIVITY_MS,
    );
    expect(warnings).toEqual([]);

    const belowThirtyMinutes = readTurnWatchdogSettings(
      {
        [TURN_WATCHDOG_INACTIVITY_ENV]: String(
          DEFAULT_TURN_WATCHDOG_INACTIVITY_MS - 1,
        ),
      },
      (warning) => warnings.push(warning),
    );
    expect(belowThirtyMinutes.inactivityMs).toBe(
      DEFAULT_TURN_WATCHDOG_INACTIVITY_MS - 1,
    );
    expect(warnings).toHaveLength(1);

    for (const raw of ["-1", "not-a-number", "59999"]) {
      expect(() =>
        readTurnWatchdogSettings(
          { [TURN_WATCHDOG_INACTIVITY_ENV]: raw },
          () => {},
        ),
      ).toThrow();
    }

    expect(
      readTurnWatchdogSettings(
        { [TURN_WATCHDOG_ABORT_GRACE_ENV]: "1" },
        () => {},
      ).abortGraceMs,
    ).toBe(1);
    for (const raw of ["-1", "not-a-number", String(MAX_TURN_WATCHDOG_DELAY_MS + 1)]) {
      expect(() =>
        readTurnWatchdogSettings(
          { [TURN_WATCHDOG_ABORT_GRACE_ENV]: raw },
          () => {},
        ),
      ).toThrow();
    }
    expect(
      readTurnWatchdogSettings(
        { [TURN_WATCHDOG_INACTIVITY_ENV]: String(MAX_TURN_WATCHDOG_DELAY_MS) },
        () => {},
      ).inactivityMs,
    ).toBe(MAX_TURN_WATCHDOG_DELAY_MS);
    expect(
      readTurnWatchdogSettings(
        { [TURN_WATCHDOG_ABORT_GRACE_ENV]: String(MAX_TURN_WATCHDOG_DELAY_MS) },
        () => {},
      ).abortGraceMs,
    ).toBe(MAX_TURN_WATCHDOG_DELAY_MS);
    for (const envName of [
      TURN_WATCHDOG_INACTIVITY_ENV,
      TURN_WATCHDOG_ABORT_GRACE_ENV,
    ]) {
      expect(() =>
        readTurnWatchdogSettings(
          { [envName]: String(MAX_TURN_WATCHDOG_DELAY_MS + 1) },
          () => {},
        ),
      ).toThrow(`<= ${MAX_TURN_WATCHDOG_DELAY_MS}`);
    }
  });

  it("SDK progress だけが inactivity を延長し、発火は warning → interrupt → grace 後 fail-stop になる", () => {
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
        throw new Error("must not use unattributed fallback");
      },
      nowMs: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });

    // No caller other than real SDK-frame wiring invokes progress(); a local
    // timer/server instruction therefore cannot accidentally keep this alive.
    watchdog.start("turn-a");
    timers.advance(999);
    expect(warnings).toEqual([]);
    watchdog.progress("turn-a");
    timers.advance(999);
    expect(warnings).toEqual([]);

    timers.advance(1);
    expect(warnings).toMatchObject([
      { kind: "inactivity_timeout", turnToken: "turn-a", idleMs: 1_000 },
    ]);
    expect(interrupts).toEqual(["turn-a"]);
    expect(failStops).toEqual([]);

    // Actual output after an interrupt is progress, not a terminal ACK: it
    // returns the watchdog to monitoring and cancels the prior grace timer.
    watchdog.progress("turn-a");
    timers.advance(1_000);
    timers.advance(60);
    expect(interrupts).toEqual(["turn-a", "turn-a"]);
    expect(warnings.at(-1)).toEqual({
      kind: "abort_grace_expired",
      turnToken: "turn-a",
      abortGraceMs: 60,
    });
    expect(failStops).toEqual(["turn-a"]);

    // Buffered output may arrive after grace expiry. It must not recreate a
    // monitoring timer once the host has already entered fail-stop.
    watchdog.progress("turn-a");
    timers.advance(10_000);
    expect(failStops).toEqual(["turn-a"]);
    watchdog.end("turn-a");
  });

  it("30分既定は総 wallclock ではなく inactivity を測るため、長考中に SDK progress が続けば3区間を越えても殺さない", () => {
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
      failStopUnattributed: () => {
        throw new Error("must not use unattributed fallback");
      },
      nowMs: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    watchdog.start("xhigh-turn");
    for (let interval = 0; interval < 4; interval += 1) {
      timers.advance(DEFAULT_TURN_WATCHDOG_INACTIVITY_MS - 1);
      watchdog.progress("xhigh-turn");
    }
    // More than 90 minutes of wall time elapsed, yet every interval had an
    // SDK frame. This pins the #221 non-wallclock rationale in behaviour.
    expect(timers.now).toBeGreaterThan(90 * 60 * 1_000);
    expect(warnings).toEqual([]);
  });

  it("終端済み token は no-op、interrupt unavailable は unattributed fail-stop へ落とす", () => {
    const timers = new FakeTimers();
    const warnings: TurnWatchdogWarning[] = [];
    const unattributedStops: string[] = [];
    const watchdog = new TurnWatchdog({
      settings: { inactivityMs: 10, abortGraceMs: 10 },
      onWarning: (warning) => warnings.push(warning),
      requestInterrupt: () => false,
      failStop: () => {
        throw new Error("exact fail-stop must not run");
      },
      failStopUnattributed: () => unattributedStops.push("fallback"),
      nowMs: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    watchdog.start("turn-a");
    watchdog.end("turn-a");
    timers.advance(1_000);
    expect(warnings).toEqual([]);

    watchdog.start("turn-b");
    timers.advance(10);
    expect(warnings).toMatchObject([
      { kind: "inactivity_timeout", turnToken: "turn-b" },
      { kind: "interrupt_unavailable", turnToken: "turn-b" },
    ]);
    expect(unattributedStops).toEqual(["fallback"]);
  });

  it("二重 start と exact fail-stop unavailable は fail-visible な unattributed fail-stop へ落とす", () => {
    const timers = new FakeTimers();
    const warnings: TurnWatchdogWarning[] = [];
    const unattributedStops: string[] = [];
    const watchdog = new TurnWatchdog({
      settings: { inactivityMs: 10, abortGraceMs: 10 },
      onWarning: (warning) => warnings.push(warning),
      requestInterrupt: () => true,
      failStop: () => false,
      failStopUnattributed: () => unattributedStops.push("fallback"),
      nowMs: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    watchdog.start("turn-a");
    watchdog.start("turn-b");
    expect(warnings).toContainEqual({
      kind: "start_conflict",
      watchedTurnToken: "turn-a",
      startedTurnToken: "turn-b",
    });
    expect(unattributedStops).toEqual(["fallback"]);

    const second = new TurnWatchdog({
      settings: { inactivityMs: 10, abortGraceMs: 10 },
      onWarning: (warning) => warnings.push(warning),
      requestInterrupt: () => true,
      failStop: () => false,
      failStopUnattributed: () => unattributedStops.push("second-fallback"),
      nowMs: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    second.start("turn-c");
    timers.advance(10);
    timers.advance(10);
    expect(warnings).toContainEqual({
      kind: "fail_stop_unavailable",
      turnToken: "turn-c",
    });
    expect(unattributedStops).toEqual(["fallback", "second-fallback"]);
  });
});
