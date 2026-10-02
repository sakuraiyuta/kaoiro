import { describe, expect, it } from "vitest";
import {
  BEHAVIOUR_ROWS,
  behaviourWarnings,
  computeBehaviourRelay,
  describeBehaviourRelay,
  parseBehaviourBlock,
  readSetVariables,
} from "../src/behaviour-settings.js";
import { ConfigError, parseRunnerConfig } from "../src/config.js";
import type { RunnerConfig } from "../src/config.js";

const base: RunnerConfig = {
  host_id: "lab-pc-1",
  server_url: "ws://localhost:4000/runner",
  cwd_allowlist: ["/work"],
};

const FILE_KEYS = [
  ["yield_claim_timeout_ms", "KAOIRO_CLAUDE_YIELD_CLAIM_TIMEOUT_MS", 60_000],
  [
    "pending_receipt_root_timeout_ms",
    "KAOIRO_CLAUDE_PENDING_RECEIPT_ROOT_TIMEOUT_MS",
    60_000,
  ],
  ["urgent_overtake_limit", "KAOIRO_CLAUDE_URGENT_OVERTAKE_LIMIT", 64],
  ["folds_per_turn", "KAOIRO_CLAUDE_FOLDS_PER_TURN", 64],
] as const;

describe("claude_code block in runner.config.json", () => {
  it.each(FILE_KEYS)("%s: literal bounds, JSON numbers only", (key, _env, max) => {
    const parse = (value: unknown) =>
      parseRunnerConfig({ ...base, claude_code: { [key]: value } });
    expect(parse(1).claude_code?.[key]).toBe(1);
    expect(parse(max).claude_code?.[key]).toBe(max);
    for (const bad of [
      0,
      -1,
      max + 1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      "3",
      "",
      " ",
      true,
      null,
      [],
      {},
    ]) {
      expect(() => parse(bad), JSON.stringify(bad)).toThrow(
        `claude_code.${key} must be an integer from 1 through ${max}`,
      );
    }
  });

  it("ignores unknown keys inside the block and rejects a non-object block", () => {
    expect(
      parseRunnerConfig({ ...base, claude_code: { whatever: 1 } }).claude_code,
    ).toEqual({});
    for (const bad of [null, 1, "x", [], [5]]) {
      expect(
        () => parseRunnerConfig({ ...base, claude_code: bad }),
        JSON.stringify(bad),
      ).toThrow("claude_code must be an object");
    }
  });

  it("parseBehaviourBlock keeps only the keys it parsed", () => {
    expect(
      parseBehaviourBlock("claude_code", { folds_per_turn: 4, other: 9 }),
    ).toEqual({ folds_per_turn: 4 });
  });
});

describe("readSetVariables", () => {
  const enabled = base;

  it("treats an undefined or exactly empty variable as unset", () => {
    expect(readSetVariables(enabled, {})).toEqual([]);
    expect(
      readSetVariables(enabled, { KAOIRO_CLAUDE_FOLDS_PER_TURN: "" }),
    ).toEqual([]);
  });

  it("returns a set variable parsed by the wrapper's legacy grammar", () => {
    const set = readSetVariables(enabled, {
      KAOIRO_CLAUDE_FOLDS_PER_TURN: "1e1",
      KAOIRO_CLAUDE_YIELD_CLAIM_TIMEOUT_MS: " 7 ",
    });
    expect(set.map((s) => [s.row.env, s.value])).toEqual([
      ["KAOIRO_CLAUDE_YIELD_CLAIM_TIMEOUT_MS", 7],
      ["KAOIRO_CLAUDE_FOLDS_PER_TURN", 10],
    ]);
  });

  it.each(FILE_KEYS)(
    "%s: a whitespace-only, zero or oversized variable stops the runner, naming it",
    (_key, env, max) => {
      for (const bad of [" ", "0", String(max + 1), "abc", "1.5", "-1"]) {
        expect(
          () => readSetVariables(enabled, { [env]: bad }),
          JSON.stringify(bad),
        ).toThrow(`${env} must be an integer from 1 through ${max}`);
      }
    },
  );

  it("does not read or validate the variable of a disabled engine", () => {
    const codexOnly: RunnerConfig = { ...base, capabilities: ["codex"] };
    expect(
      readSetVariables(codexOnly, { KAOIRO_CLAUDE_FOLDS_PER_TURN: "abc" }),
    ).toEqual([]);
    const claude: RunnerConfig = { ...base, capabilities: ["claude-code"] };
    expect(() =>
      readSetVariables(claude, { KAOIRO_CLAUDE_FOLDS_PER_TURN: "abc" }),
    ).toThrow(ConfigError);
  });
});

describe("computeBehaviourRelay", () => {
  const withFile: RunnerConfig = {
    ...base,
    claude_code: { folds_per_turn: 5, urgent_overtake_limit: 3 },
  };

  it("relays the file value of every key whose variable is not set", () => {
    expect(computeBehaviourRelay(withFile, {})).toEqual({
      "claude-code": { folds_per_turn: 5, urgent_overtake_limit: 3 },
    });
    expect(
      computeBehaviourRelay(withFile, { KAOIRO_CLAUDE_FOLDS_PER_TURN: "" }),
    ).toEqual({
      "claude-code": { folds_per_turn: 5, urgent_overtake_limit: 3 },
    });
  });

  it("relays nothing for a key whose variable is set, so the wrapper reads the variable", () => {
    expect(
      computeBehaviourRelay(withFile, { KAOIRO_CLAUDE_FOLDS_PER_TURN: "9" }),
    ).toEqual({ "claude-code": { urgent_overtake_limit: 3 } });
    // Whitespace counts as set: the runner never treats it as absent while
    // the wrapper later reads the inherited copy.
    expect(
      computeBehaviourRelay(withFile, { KAOIRO_CLAUDE_FOLDS_PER_TURN: " " }),
    ).toEqual({ "claude-code": { urgent_overtake_limit: 3 } });
  });

  it("relays nothing without a file value, and describes it", () => {
    expect(computeBehaviourRelay(base, {})).toEqual({});
    expect(describeBehaviourRelay({})).toBe("none");
    expect(
      describeBehaviourRelay(computeBehaviourRelay(withFile, {})),
    ).toBe("claude-code.urgent_overtake_limit=3, claude-code.folds_per_turn=5");
  });
});

describe("behaviourWarnings", () => {
  const fileA: RunnerConfig = { ...base, claude_code: { folds_per_turn: 5 } };
  const fileC: RunnerConfig = { ...base, claude_code: { folds_per_turn: 7 } };
  const env = { KAOIRO_CLAUDE_FOLDS_PER_TURN: "9" };

  it("warns once per variable about deprecation", () => {
    const seen = new Set<string>();
    const set = readSetVariables(base, env);
    const first = behaviourWarnings(undefined, base, set, seen);
    expect(first).toHaveLength(1);
    expect(first[0]).toContain(
      'KAOIRO_CLAUDE_FOLDS_PER_TURN is deprecated; set "claude_code.folds_per_turn"',
    );
    expect(behaviourWarnings(base, base, set, seen)).toEqual([]);
  });

  it("warns that a file value is shadowed, and again only when that value changes", () => {
    const seen = new Set<string>();
    const startup = behaviourWarnings(
      undefined,
      fileA,
      readSetVariables(fileA, env),
      seen,
    );
    expect(startup).toHaveLength(2);
    expect(startup[1]).toContain(
      '"claude_code.folds_per_turn" in runner.config.json is shadowed by KAOIRO_CLAUDE_FOLDS_PER_TURN',
    );
    // Same file again: no repeat.
    expect(
      behaviourWarnings(fileA, fileA, readSetVariables(fileA, env), seen),
    ).toEqual([]);
    // file=A/variable=B then file=C/variable=B: the effective result is
    // unchanged, the warning still appears for the new file value.
    expect(
      behaviourWarnings(fileA, fileC, readSetVariables(fileC, env), seen),
    ).toHaveLength(1);
  });

  it("does not warn about shadowing when the file equals the variable, or when unset", () => {
    const equal: RunnerConfig = { ...base, claude_code: { folds_per_turn: 9 } };
    const seen = new Set(["KAOIRO_CLAUDE_FOLDS_PER_TURN"]);
    expect(
      behaviourWarnings(undefined, equal, readSetVariables(equal, env), seen),
    ).toEqual([]);
    expect(
      behaviourWarnings(undefined, fileA, readSetVariables(fileA, {}), new Set()),
    ).toEqual([]);
  });
});

describe("registry", () => {
  it("lists the documented variables in table order, each tied to its engine and key", () => {
    expect(BEHAVIOUR_ROWS.map((r) => [r.env, r.engine, r.block ?? null, r.key])).toEqual([
      ...FILE_KEYS.map(([key, env]) => [env, "claude-code", "claude_code", key]),
      ["KAOIRO_CLAUDE_TURN_WATCHDOG_INACTIVITY_MS", "claude-code", "claude_code", "turn_watchdog_inactivity_ms"],
      ["KAOIRO_CLAUDE_TURN_WATCHDOG_ABORT_GRACE_MS", "claude-code", "claude_code", "turn_watchdog_abort_grace_ms"],
      ["KAOIRO_CODEX_TURN_WATCHDOG_INACTIVITY_MS", "codex", "codex", "turn_watchdog_inactivity_ms"],
      ["KAOIRO_CODEX_TURN_WATCHDOG_ABORT_GRACE_MS", "codex", "codex", "turn_watchdog_abort_grace_ms"],
      ["KAOIRO_ANTIGRAVITY_TURN_WATCHDOG_INACTIVITY_MS", "antigravity", "antigravity", "turn_watchdog_inactivity_ms"],
      ["KAOIRO_ANTIGRAVITY_TURN_WATCHDOG_ABORT_GRACE_MS", "antigravity", "antigravity", "turn_watchdog_abort_grace_ms"],
      ["KAOIRO_WRAPPER_PERMISSION_TIMEOUT_MS", "all", null, "permission_timeout_ms"],
    ]);
  });
});
