import { describe, expect, it } from "vitest";
import {
  DEFAULT_EPOCH_IDLE_MS,
  EPOCH_IDLE_MS_ENV,
  readEpochIdleMs,
  resolveEpochIdleMs,
} from "../src/epoch.js";
import {
  TOOL_TIMEOUT_ENV,
  resolveTurnWatchdogSettings,
} from "../src/turn_watchdog.js";

describe("epoch idle setting (issue #469)", () => {
  it("selects the config field, then the variable, then the default, with its source", () => {
    expect(resolveEpochIdleMs({})).toEqual({ value: 1_800_000, source: "default" });
    expect(DEFAULT_EPOCH_IDLE_MS).toBe(1_800_000);
    expect(resolveEpochIdleMs({ [EPOCH_IDLE_MS_ENV]: "5000" })).toEqual({
      value: 5000,
      source: "env",
    });
    expect(resolveEpochIdleMs({ [EPOCH_IDLE_MS_ENV]: "" })).toEqual({
      value: 1_800_000,
      source: "default",
    });
    expect(resolveEpochIdleMs({ [EPOCH_IDLE_MS_ENV]: "5000" }, 7000)).toEqual({
      value: 7000,
      source: "config",
    });
    expect(readEpochIdleMs({ [EPOCH_IDLE_MS_ENV]: "5000" })).toBe(5000);
  });

  it("keeps the digits-only grammar and adds a ceiling of 2147483647", () => {
    expect(readEpochIdleMs({ [EPOCH_IDLE_MS_ENV]: "1000" })).toBe(1000);
    expect(readEpochIdleMs({ [EPOCH_IDLE_MS_ENV]: "2147483647" })).toBe(2_147_483_647);
    for (const bad of [" ", "999", "1e3", "-1", "0x10", "2147483648"]) {
      expect(() => readEpochIdleMs({ [EPOCH_IDLE_MS_ENV]: bad }), bad).toThrow(
        EPOCH_IDLE_MS_ENV,
      );
    }
  });
});

describe("tool timeout setting (issue #469)", () => {
  it("selects the config field, then the variable, then the default, with its source", () => {
    const sourceOf = (env: Record<string, string>, config?: number) =>
      resolveTurnWatchdogSettings(
        env,
        () => {},
        config === undefined ? undefined : { antigravity_tool_timeout_ms: config },
      );
    expect(sourceOf({}).settings.toolTimeoutMs).toBe(600_000);
    expect(sourceOf({}).sources.toolTimeoutMs).toBe("default");
    expect(sourceOf({ [TOOL_TIMEOUT_ENV]: "2000" }).settings.toolTimeoutMs).toBe(2000);
    expect(sourceOf({ [TOOL_TIMEOUT_ENV]: "2000" }).sources.toolTimeoutMs).toBe("env");
    const withConfig = sourceOf({ [TOOL_TIMEOUT_ENV]: "2000" }, 3000);
    expect(withConfig.settings.toolTimeoutMs).toBe(3000);
    expect(withConfig.sources.toolTimeoutMs).toBe("config");
  });
});
