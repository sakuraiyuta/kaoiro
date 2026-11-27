import "../../../scripts/test/fixtures/test-isolation.mjs";
import { describe, expect, it, vi } from "vitest";
import { resolveTurnWatchdogSettings as grok } from "../src/settings.js";
import { resolveTurnWatchdogSettings as muse } from "../../muse/src/settings.js";

describe.each([
  ["GROK", "MUSE", grok],
  ["MUSE", "GROK", muse],
] as const)("%s watchdog settings", (engine, foreign, resolve) => {
  const inactivity = `KAOIRO_${engine}_TURN_WATCHDOG_INACTIVITY_MS`;
  const grace = `KAOIRO_${engine}_TURN_WATCHDOG_ABORT_GRACE_MS`;
  const foreignInactivity = `KAOIRO_${foreign}_TURN_WATCHDOG_INACTIVITY_MS`;
  const foreignGrace = `KAOIRO_${foreign}_TURN_WATCHDOG_ABORT_GRACE_MS`;
  const defaults = {
    settings: { inactivityMs: 1_800_000, abortGraceMs: 3_000 },
    sources: { inactivityMs: "default", abortGraceMs: "default" },
  };

  it("uses defaults for absent, empty and foreign environment fields", () => {
    for (const env of [
      {},
      { [inactivity]: "", [grace]: "" },
      { [foreignInactivity]: "60000", [foreignGrace]: "1" },
    ]) expect(resolve(env, vi.fn())).toEqual(defaults);
  });

  it("resolves each field independently and preserves warning labels", () => {
    const warn = vi.fn();
    expect(resolve({ [inactivity]: "60000", [grace]: "1" }, warn)).toEqual({
      settings: { inactivityMs: 60_000, abortGraceMs: 1 },
      sources: { inactivityMs: "env", abortGraceMs: "env" },
    });
    expect(warn).toHaveBeenCalledWith(
      `[kaoiro] ${inactivity}=60000ms is below the 30-minute default; ` +
      "choose the shorter inactivity value deliberately.\n",
    );
    warn.mockClear();
    expect(resolve({ [inactivity]: "invalid", [grace]: "9" }, warn, {
      turn_watchdog_inactivity_ms: 120_000,
    })).toEqual({
      settings: { inactivityMs: 120_000, abortGraceMs: 9 },
      sources: { inactivityMs: "config", abortGraceMs: "env" },
    });
    expect(warn).toHaveBeenCalledWith(
      "[kaoiro] turn_watchdog_inactivity_ms=120000ms is below " +
      "the 30-minute default; choose the shorter inactivity value deliberately.\n",
    );
    expect(resolve({ [inactivity]: "1800001", [grace]: "invalid" }, vi.fn(), {
      turn_watchdog_abort_grace_ms: 7,
    })).toEqual({
      settings: { inactivityMs: 1_800_001, abortGraceMs: 7 },
      sources: { inactivityMs: "env", abortGraceMs: "config" },
    });
    expect(resolve({ [inactivity]: "2147483647", [grace]: "2147483647" }, vi.fn()))
      .toEqual({
        settings: { inactivityMs: 2_147_483_647, abortGraceMs: 2_147_483_647 },
        sources: { inactivityMs: "env", abortGraceMs: "env" },
      });
  });

  it("rejects invalid environment values independently", () => {
    for (const value of ["59999", "2147483648", " 60000", "6e4"]) {
      expect(() => resolve({ [inactivity]: value }, vi.fn())).toThrow();
    }
    for (const value of ["0", "2147483648", " 1", "1e2"]) {
      expect(() => resolve({ [grace]: value }, vi.fn())).toThrow();
    }
  });
});
