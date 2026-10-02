import { describe, expect, it } from "vitest";
import {
  behaviourWarnings,
  computeBehaviourRelay,
  readSetVariables,
  resolveHeartbeatLogging,
} from "../src/behaviour-settings.js";
import { parseRunnerConfig } from "../src/config.js";
import type { RunnerConfig } from "../src/config.js";
import { PhoenixHeartbeatLogFilter } from "../src/transport.js";

const base: RunnerConfig = {
  host_id: "lab-pc-1",
  server_url: "ws://localhost:4000/runner",
  cwd_allowlist: ["/work"],
};

const TOOL = "KAOIRO_ANTIGRAVITY_TOOL_TIMEOUT_MS";
const EPOCH = "KAOIRO_ANTIGRAVITY_EPOCH_IDLE_MS";
const HEARTBEATS = "KAOIRO_RUNNER_LOG_PHOENIX_HEARTBEATS";
const SERVER_URL = "KAOIRO_RUNNER_SERVER_URL";

describe.each([
  ["tool_timeout_ms", TOOL, "antigravity_tool_timeout_ms"],
  ["epoch_idle_ms", EPOCH, "antigravity_epoch_idle_ms"],
] as const)("antigravity.%s", (key, variable, wrapperField) => {
  const parse = (value: unknown) =>
    parseRunnerConfig({ ...base, antigravity: { [key]: value } }).antigravity?.[key];

  it("file: literal bounds, JSON numbers only", () => {
    expect(parse(1000)).toBe(1000);
    expect(parse(2_147_483_647)).toBe(2_147_483_647);
    for (const bad of [999, 2_147_483_648, 1.5, "5000", true, null, NaN]) {
      expect(() => parse(bad), String(bad)).toThrow(
        `antigravity.${key} must be an integer from 1000 through 2147483647`,
      );
    }
  });

  it("variable: the wrapper's digits-only grammar and ceiling, whitespace rejected, empty unset", () => {
    expect(readSetVariables(base, { [variable]: "" })).toEqual([]);
    expect(readSetVariables(base, { [variable]: "5000" }).map((s) => s.value)).toEqual([5000]);
    expect(
      readSetVariables(base, { [variable]: "2147483647" }).map((s) => s.value),
    ).toEqual([2_147_483_647]);
    for (const bad of [" ", "999", "1e3", "-1", "0x10", "2147483648"]) {
      expect(() => readSetVariables(base, { [variable]: bad }), bad).toThrow(variable);
    }
  });

  it("relay: the file value reaches Antigravity wrappers only, and a set variable removes it", () => {
    const withFile: RunnerConfig = { ...base, antigravity: { [key]: 7000 } };
    expect(computeBehaviourRelay(withFile, {})).toEqual({
      antigravity: { [wrapperField]: 7000 },
    });
    expect(computeBehaviourRelay(withFile, { [variable]: "5000" })).toEqual({});
  });

  it("a disabled engine's variable is not validated", () => {
    expect(
      readSetVariables({ ...base, capabilities: ["codex"] }, { [variable]: "abc" }),
    ).toEqual([]);
  });
});

describe("log_phoenix_heartbeats", () => {
  const parse = (value: unknown) =>
    parseRunnerConfig({ ...base, log_phoenix_heartbeats: value }).log_phoenix_heartbeats;

  it("file: a JSON boolean only", () => {
    expect(parse(true)).toBe(true);
    expect(parse(false)).toBe(false);
    for (const bad of [1, 0, "true", "1", null, []]) {
      expect(() => parse(bad), JSON.stringify(bad)).toThrow(
        "log_phoenix_heartbeats must be a boolean",
      );
    }
    expect(parseRunnerConfig({ ...base }).log_phoenix_heartbeats).toBeUndefined();
  });

  it("variable: exactly 1 is on and anything else set is off, with no validation error", () => {
    expect(readSetVariables(base, { [HEARTBEATS]: "" })).toEqual([]);
    expect(readSetVariables(base, { [HEARTBEATS]: "1" }).map((s) => s.value)).toEqual([true]);
    for (const other of ["0", "true", "yes", " ", "01"]) {
      expect(readSetVariables(base, { [HEARTBEATS]: other }).map((s) => s.value), other).toEqual([
        false,
      ]);
    }
  });

  it("resolves variable, then file, then off, and relays nothing", () => {
    const on: RunnerConfig = { ...base, log_phoenix_heartbeats: true };
    expect(resolveHeartbeatLogging(base, {})).toBe(false);
    expect(resolveHeartbeatLogging(on, {})).toBe(true);
    expect(resolveHeartbeatLogging(on, { [HEARTBEATS]: "" })).toBe(true);
    expect(resolveHeartbeatLogging(on, { [HEARTBEATS]: "0" })).toBe(false);
    expect(resolveHeartbeatLogging(base, { [HEARTBEATS]: "1" })).toBe(true);
    expect(computeBehaviourRelay(on, {})).toEqual({});
  });

  it("the filter asks for the setting on every line", () => {
    let on = false;
    const filter = new PhoenixHeartbeatLogFilter("runner:h", () => on);
    const heartbeat = "runner:h heartbeat (3, 102)";
    expect(filter.shouldWrite("push", heartbeat, {})).toBe(false);
    on = true;
    expect(filter.shouldWrite("push", heartbeat, {})).toBe(true);
    on = false;
    expect(filter.shouldWrite("push", heartbeat, {})).toBe(false);
  });

  it("names the key and warns about shadowing", () => {
    const next: RunnerConfig = { ...base, log_phoenix_heartbeats: true };
    const lines = behaviourWarnings(
      undefined,
      next,
      readSetVariables(next, { [HEARTBEATS]: "0" }),
      new Set(),
    ).join("");
    expect(lines).toContain(
      `${HEARTBEATS} is deprecated; set "log_phoenix_heartbeats" in runner.config.json`,
    );
    expect(lines).toContain(
      `"log_phoenix_heartbeats" in runner.config.json is shadowed by ${HEARTBEATS}`,
    );
  });
});

describe("server_url", () => {
  it("variable: must start with ws:// or wss://, empty is unset, nothing is relayed", () => {
    expect(readSetVariables(base, { [SERVER_URL]: "" })).toEqual([]);
    expect(
      readSetVariables(base, { [SERVER_URL]: "wss://kaoiro.example/runner" }).map((s) => s.value),
    ).toEqual(["wss://kaoiro.example/runner"]);
    for (const bad of ["http://x/runner", " ", "kaoiro.example"]) {
      expect(() => readSetVariables(base, { [SERVER_URL]: bad }), bad).toThrow(
        `${SERVER_URL} must start with ws:// or wss://`,
      );
    }
    expect(
      computeBehaviourRelay(base, { [SERVER_URL]: "wss://kaoiro.example/runner" }),
    ).toEqual({});
  });

  it("warns once about deprecation and when the file value differs and is new", () => {
    const seen = new Set<string>();
    const env = { [SERVER_URL]: "wss://prod.example/runner" };
    const startup = behaviourWarnings(undefined, base, readSetVariables(base, env), seen);
    expect(startup).toHaveLength(2);
    expect(startup[0]).toContain(
      `${SERVER_URL} is deprecated; set "server_url" in runner.config.json`,
    );
    expect(startup[1]).toContain(
      `"server_url" in runner.config.json is shadowed by ${SERVER_URL}`,
    );
    expect(behaviourWarnings(base, base, readSetVariables(base, env), seen)).toEqual([]);
    const edited: RunnerConfig = { ...base, server_url: "ws://other:4000/runner" };
    expect(behaviourWarnings(base, edited, readSetVariables(edited, env), seen)).toHaveLength(1);
    const same: RunnerConfig = { ...base, server_url: "wss://prod.example/runner" };
    expect(
      behaviourWarnings(undefined, same, readSetVariables(same, env), new Set([SERVER_URL])),
    ).toEqual([]);
  });
});
