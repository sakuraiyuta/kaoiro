import { describe, expect, it } from "vitest";
import {
  formatTurnWatchdogLine,
  readDigitsMs,
  resolveDigitsMs,
} from "../src/turn_watchdog_settings.js";
import {
  isPermissionTimeoutEnvSet,
  parsePermissionTimeoutEnv,
} from "../src/permission_timeout.js";
import { parseConfig } from "../src/persona.js";

const base = {
  agent_id: "a.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

const NAME = "KAOIRO_X_MS";

describe("readDigitsMs (literal grammar)", () => {
  const read = (raw: string | undefined) =>
    readDigitsMs({ [NAME]: raw }, NAME, 123, 60_000, 2_147_483_647);

  it("treats undefined and exactly empty as unset", () => {
    expect(read(undefined)).toBe(123);
    expect(read("")).toBe(123);
  });

  it("accepts digits within the bounds", () => {
    expect(read("60000")).toBe(60_000);
    expect(read("2147483647")).toBe(2_147_483_647);
  });

  it.each(["59999", "2147483648", "1e5", " ", " 70000", "70000 ", "-70000", "7.5e4", "0x10"])(
    "rejects %j",
    (raw) => {
      expect(() => read(raw)).toThrow(NAME);
    },
  );
});

describe("resolveDigitsMs", () => {
  it("selects the config field, then the variable, then the default", () => {
    const env = { [NAME]: "70000" };
    expect(resolveDigitsMs(env, NAME, 90_000, 123, 60_000, 2_147_483_647)).toEqual({
      value: 90_000,
      source: "config",
    });
    expect(resolveDigitsMs(env, NAME, undefined, 123, 60_000, 2_147_483_647)).toEqual({
      value: 70_000,
      source: "env",
    });
    expect(resolveDigitsMs({}, NAME, undefined, 123, 60_000, 2_147_483_647)).toEqual({
      value: 123,
      source: "default",
    });
    expect(resolveDigitsMs({ [NAME]: "" }, NAME, undefined, 123, 60_000, 2_147_483_647)).toEqual({
      value: 123,
      source: "default",
    });
  });
});

describe("formatTurnWatchdogLine", () => {
  it("prints exactly what the resolved object holds, with sources", () => {
    expect(
      formatTurnWatchdogLine(
        "codex",
        42,
        {
          settings: { inactivityMs: 90_000, abortGraceMs: 60_000 },
          sources: { inactivityMs: "config", abortGraceMs: "default" },
        },
        undefined,
      ),
    ).toBe(
      "[kaoiro] codex behaviour: pid=42 turn_watchdog_inactivity_ms=90000(config) " +
        "turn_watchdog_abort_grace_ms=60000(default) permission_timeout_ms=none\n",
    );
  });
});

describe("permission timeout variable", () => {
  it("keeps the legacy Number() grammar", () => {
    expect(isPermissionTimeoutEnvSet(undefined)).toBe(false);
    expect(isPermissionTimeoutEnvSet("")).toBe(false);
    expect(isPermissionTimeoutEnvSet(" ")).toBe(true);
    expect(parsePermissionTimeoutEnv("1")).toBe(1);
    expect(parsePermissionTimeoutEnv("1e3")).toBe(1000);
    expect(parsePermissionTimeoutEnv(" ")).toBeUndefined();
    expect(parsePermissionTimeoutEnv("0")).toBeUndefined();
    expect(parsePermissionTimeoutEnv("-5")).toBeUndefined();
    expect(parsePermissionTimeoutEnv("1.5")).toBeUndefined();
    expect(parsePermissionTimeoutEnv("abc")).toBeUndefined();
  });

  it("parseConfig reads the variable only when the field is absent", () => {
    const previous = process.env.KAOIRO_WRAPPER_PERMISSION_TIMEOUT_MS;
    try {
      process.env.KAOIRO_WRAPPER_PERMISSION_TIMEOUT_MS = "2000";
      expect(parseConfig({ ...base }).permission_timeout_ms).toBe(2000);
      expect(
        parseConfig({ ...base, permission_timeout_ms: 5000 }).permission_timeout_ms,
      ).toBe(5000);
      process.env.KAOIRO_WRAPPER_PERMISSION_TIMEOUT_MS = " ";
      expect(() => parseConfig({ ...base })).toThrow(
        "KAOIRO_WRAPPER_PERMISSION_TIMEOUT_MS must be a positive integer",
      );
    } finally {
      if (previous === undefined) delete process.env.KAOIRO_WRAPPER_PERMISSION_TIMEOUT_MS;
      else process.env.KAOIRO_WRAPPER_PERMISSION_TIMEOUT_MS = previous;
    }
  });
});

describe("parseConfig timing fields", () => {
  it.each([
    ["turn_watchdog_inactivity_ms", 60_000, 59_999],
    ["turn_watchdog_abort_grace_ms", 1, 0],
    ["antigravity_tool_timeout_ms", 1_000, 999],
    ["antigravity_epoch_idle_ms", 1_000, 999],
  ] as const)("%s: literal bounds, numbers only", (field, min, below) => {
    expect(parseConfig({ ...base, [field]: min })[field]).toBe(min);
    expect(parseConfig({ ...base, [field]: 2_147_483_647 })[field]).toBe(2_147_483_647);
    for (const bad of [below, 2_147_483_648, "90000", true, null, 1.5, NaN]) {
      expect(() => parseConfig({ ...base, [field]: bad }), String(bad)).toThrow(
        `${field} must be an integer from ${min} through 2147483647`,
      );
    }
    expect(parseConfig({ ...base })[field]).toBeUndefined();
  });
});
