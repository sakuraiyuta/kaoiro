import { describe, expect, it } from "vitest";
import {
  behaviourWarnings,
  computeBehaviourRelay,
  readSetVariables,
} from "../src/behaviour-settings.js";
import { parseRunnerConfig } from "../src/config.js";
import type { RunnerConfig } from "../src/config.js";

const base: RunnerConfig = {
  host_id: "lab-pc-1",
  server_url: "ws://localhost:4000/runner",
  cwd_allowlist: ["/work"],
};

const WATCHDOG_VARIABLES = {
  claude_code: [
    "KAOIRO_CLAUDE_TURN_WATCHDOG_INACTIVITY_MS",
    "KAOIRO_CLAUDE_TURN_WATCHDOG_ABORT_GRACE_MS",
  ],
  codex: [
    "KAOIRO_CODEX_TURN_WATCHDOG_INACTIVITY_MS",
    "KAOIRO_CODEX_TURN_WATCHDOG_ABORT_GRACE_MS",
  ],
  antigravity: [
    "KAOIRO_ANTIGRAVITY_TURN_WATCHDOG_INACTIVITY_MS",
    "KAOIRO_ANTIGRAVITY_TURN_WATCHDOG_ABORT_GRACE_MS",
  ],
} as const;
const ENGINE_OF = {
  claude_code: "claude-code",
  codex: "codex",
  antigravity: "antigravity",
} as const;

describe.each(["claude_code", "codex", "antigravity"] as const)(
  "%s turn watchdog keys",
  (block) => {
    const [inactivityName, graceName] = WATCHDOG_VARIABLES[block];
    const parse = (key: string, value: unknown) =>
      parseRunnerConfig({ ...base, [block]: { [key]: value } })[block];

    it("file: literal bounds, JSON numbers only", () => {
      expect(parse("turn_watchdog_inactivity_ms", 60_000)?.turn_watchdog_inactivity_ms).toBe(60_000);
      expect(parse("turn_watchdog_inactivity_ms", 2_147_483_647)?.turn_watchdog_inactivity_ms).toBe(
        2_147_483_647,
      );
      expect(parse("turn_watchdog_abort_grace_ms", 1)?.turn_watchdog_abort_grace_ms).toBe(1);
      for (const bad of [59_999, 2_147_483_648, 1.5, "90000", true, null, NaN]) {
        expect(() => parse("turn_watchdog_inactivity_ms", bad), String(bad)).toThrow(
          `${block}.turn_watchdog_inactivity_ms must be an integer from 60000 through 2147483647`,
        );
      }
      for (const bad of [0, 2_147_483_648, "5", false, null]) {
        expect(() => parse("turn_watchdog_abort_grace_ms", bad), String(bad)).toThrow(
          `${block}.turn_watchdog_abort_grace_ms must be an integer from 1 through 2147483647`,
        );
      }
    });

    it("variable: the engine's digits-only grammar, whitespace rejected, empty unset", () => {
      expect(readSetVariables(base, { [inactivityName]: "" })).toEqual([]);
      expect(
        readSetVariables(base, { [inactivityName]: "3600000" }).map((s) => s.value),
      ).toEqual([3_600_000]);
      for (const bad of [" ", "1e3", "59999", "2147483648", "-1", "0x10"]) {
        expect(() => readSetVariables(base, { [inactivityName]: bad }), bad).toThrow(
          inactivityName,
        );
      }
      for (const bad of [" ", "1e3", "0", "2147483648"]) {
        expect(() => readSetVariables(base, { [graceName]: bad }), bad).toThrow(graceName);
      }
    });

    it("relay: the file value goes to this engine only, a set variable removes its key", () => {
      const withFile: RunnerConfig = {
        ...base,
        [block]: { turn_watchdog_inactivity_ms: 90_000, turn_watchdog_abort_grace_ms: 5000 },
      };
      expect(computeBehaviourRelay(withFile, {})).toEqual({
        [ENGINE_OF[block]]: {
          turn_watchdog_inactivity_ms: 90_000,
          turn_watchdog_abort_grace_ms: 5000,
        },
      });
      expect(computeBehaviourRelay(withFile, { [inactivityName]: "70000" })).toEqual({
        [ENGINE_OF[block]]: { turn_watchdog_abort_grace_ms: 5000 },
      });
    });

    it("a disabled engine's variable is not validated", () => {
      const others = (["claude-code", "codex", "antigravity"] as const).filter(
        (engine) => engine !== ENGINE_OF[block],
      );
      expect(
        readSetVariables({ ...base, capabilities: [...others] }, { [inactivityName]: "abc" }),
      ).toEqual([]);
    });
  },
);

describe("permission_timeout_ms (top level, every engine)", () => {
  const VARIABLE = "KAOIRO_WRAPPER_PERMISSION_TIMEOUT_MS";
  const parse = (value: unknown) =>
    parseRunnerConfig({ ...base, permission_timeout_ms: value }).permission_timeout_ms;

  it("file: JSON integer within the Node timer range", () => {
    expect(parse(1)).toBe(1);
    expect(parse(600_000)).toBe(600_000);
    expect(parse(2_147_483_647)).toBe(2_147_483_647);
    for (const bad of [0, -1, 1.5, "5", true, null, NaN, Number.MAX_SAFE_INTEGER + 1, 2_147_483_648]) {
      expect(() => parse(bad), String(bad)).toThrow(
        "permission_timeout_ms must be an integer from 1 through 2147483647",
      );
    }
  });

  it("variable: the legacy Number() grammar, whitespace rejected, validated even when an engine is disabled", () => {
    expect(readSetVariables(base, { [VARIABLE]: "" })).toEqual([]);
    expect(readSetVariables(base, { [VARIABLE]: "1e3" }).map((s) => s.value)).toEqual([1000]);
    expect(readSetVariables(base, { [VARIABLE]: "2147483647" }).map((s) => s.value)).toEqual([
      2_147_483_647,
    ]);
    for (const bad of [" ", "0", "-1", "1.5", "abc", "2147483648"]) {
      expect(() => readSetVariables(base, { [VARIABLE]: bad }), bad).toThrow(
        `${VARIABLE} must be an integer from 1 through 2147483647`,
      );
    }
    expect(() =>
      readSetVariables({ ...base, capabilities: ["codex"] }, { [VARIABLE]: "abc" }),
    ).toThrow(VARIABLE);
  });

  it("relay: reaches every engine unless the variable is set", () => {
    const withFile: RunnerConfig = { ...base, permission_timeout_ms: 5000 };
    expect(computeBehaviourRelay(withFile, {})).toEqual({
      "claude-code": { permission_timeout_ms: 5000 },
      codex: { permission_timeout_ms: 5000 },
      antigravity: { permission_timeout_ms: 5000 },
    });
    expect(computeBehaviourRelay(withFile, { [VARIABLE]: "9000" })).toEqual({});
  });

  it("names the top-level key without a block prefix in the warnings", () => {
    const next: RunnerConfig = { ...base, permission_timeout_ms: 5000 };
    const lines = behaviourWarnings(
      undefined,
      next,
      readSetVariables(next, { [VARIABLE]: "9000" }),
      new Set(),
    ).join("");
    expect(lines).toContain('set "permission_timeout_ms" in runner.config.json');
    expect(lines).toContain('"permission_timeout_ms" in runner.config.json is shadowed');
  });
});
