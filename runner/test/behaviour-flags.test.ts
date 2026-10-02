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

const FLAGS = [
  ["codex", "codex", "operator_steer", "KAOIRO_CODEX_OPERATOR_STEER"],
  ["codex", "codex", "approval_axis", "KAOIRO_CODEX_APPROVAL_AXIS"],
  ["claude_code", "claude-code", "phase2_delivery", "KAOIRO_CLAUDE_PHASE2_DELIVERY"],
] as const;

describe.each(FLAGS)("%s.%s", (block, engine, key, variable) => {
  const withFile = (value: boolean): RunnerConfig => ({ ...base, [block]: { [key]: value } });

  it("file: a JSON boolean only", () => {
    const parse = (value: unknown) =>
      (parseRunnerConfig({ ...base, [block]: { [key]: value } })[block] as Record<string, unknown>)[key];
    expect(parse(true)).toBe(true);
    expect(parse(false)).toBe(false);
    for (const bad of [1, 0, "true", "1", null, []]) {
      expect(() => parse(bad), JSON.stringify(bad)).toThrow(`${block}.${key} must be a boolean`);
    }
  });

  it("variable: exactly 1 is on, any other set value is off and never an error, empty is unset", () => {
    expect(readSetVariables(base, { [variable]: "" })).toEqual([]);
    expect(readSetVariables(base, { [variable]: "1" }).map((s) => s.value)).toEqual([true]);
    for (const other of ["0", "true", " ", "yes", "01"]) {
      expect(readSetVariables(base, { [variable]: other }).map((s) => s.value), other).toEqual([
        false,
      ]);
    }
  });

  it("relay: only config true, only to this engine, and nothing when the variable is set", () => {
    expect(computeBehaviourRelay(withFile(true), {})).toEqual({ [engine]: { [key]: true } });
    expect(computeBehaviourRelay(withFile(false), {})).toEqual({});
    expect(computeBehaviourRelay(withFile(true), { [variable]: "0" })).toEqual({});
    expect(computeBehaviourRelay(withFile(true), { [variable]: "1" })).toEqual({});
  });

  it("warns that config true is shadowed only when the variable is not 1", () => {
    const lines = (file: RunnerConfig, value: string) =>
      behaviourWarnings(undefined, file, readSetVariables(file, { [variable]: value }), new Set());
    const shadowed = `"${block}.${key}" in runner.config.json is shadowed by ${variable}`;
    expect(lines(withFile(true), "0").join("")).toContain(shadowed);
    expect(lines(withFile(true), "1").join("")).not.toContain("shadowed");
    // `false` is the same as absent: a variable cannot shadow it.
    expect(lines(withFile(false), "1").join("")).not.toContain("shadowed");
    expect(lines(withFile(false), "1")[0]).toContain(`${variable} is deprecated; set "${block}.${key}"`);
  });

  it("does not read the variable of a disabled engine", () => {
    const others = (["claude-code", "codex", "antigravity"] as const).filter((e) => e !== engine);
    expect(readSetVariables({ ...base, capabilities: [...others] }, { [variable]: "1" })).toEqual([]);
  });
});
