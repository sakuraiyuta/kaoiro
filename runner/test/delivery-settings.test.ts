import "../../scripts/test/fixtures/test-isolation.mjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineKind, LaunchDeliveryPolicyMetadata, RunnerRegister } from "@kaoiro/protocol";
import { buildRegister, parseRunnerConfig } from "../src/config.js";
import { changedFields } from "../src/config-diff.js";
import { HOST_DELIVERY_ROWS } from "../src/behaviour-settings.js";
import { buildLaunchDeliveryMetadata, createDeliverySnapshot, deliveryJsonBytes, preflightDeliveryRegister,
  registerSizeEstimate, retiredDeliveryWarnings, withoutRetiredDeliveryInputs } from "../src/delivery-settings.js";

const raw = { host_id: "delivery-test", server_url: "ws://localhost/runner", cwd_allowlist: ["/tmp"], codex: { backend: "app-server", auth_mode: "chatgpt", chatgpt_plan: "plus" } };
const none = { operator_early: "none", inter_agent_early: "none", inter_agent_yield: "none" } as const;
afterEach(() => vi.restoreAllMocks());

function boundedMetadata(): LaunchDeliveryPolicyMetadata {
  const metadata: LaunchDeliveryPolicyMetadata = { version: "v1", ceiling: true, mechanisms: none,
    persona_overrides: Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`p${i}`, none])) };
  const key = "p0" + "x".repeat(8192 - deliveryJsonBytes(metadata));
  delete metadata.persona_overrides!.p0; metadata.persona_overrides![key] = none;
  return metadata;
}

describe("host delivery settings", () => {
  it.each([null, [], false, 3, "on", { claude_code: {} }, { unknown: {} },
    { codex: null }, { codex: [] }, { codex: true }, { codex: { enabeld: false } },
    { codex: { enabled: "false" } }, { codex: { default: null } }])("rejects malformed new blocks: %j", block => {
    expect(() => parseRunnerConfig({ ...raw, in_flight_delivery: block })).toThrow();
  });
  it("preserves explicit false, legacy permissiveness, canonical engine defaults and reload visibility", () => {
    const config = parseRunnerConfig({ ...raw, claude_code: { unknown_legacy: true }, in_flight_delivery: {
      "claude-code": { enabled: false, default: false }, codex: { enabled: false, default: true }, antigravity: { default: true },
    } });
    expect(config.in_flight_delivery).toEqual({ "claude-code": { enabled: false, default: false }, codex: { enabled: false, default: true }, antigravity: { default: true } });
    expect(config.claude_code).toEqual({});
    expect(HOST_DELIVERY_ROWS.map(row => row.engine)).toEqual(["claude-code", "codex", "antigravity", "grok"]);
    const base = parseRunnerConfig(raw); const snapshot = createDeliverySnapshot(base, {});
    const defaults = buildRegister(base, undefined, "chatgpt", undefined, undefined, undefined, snapshot);
    expect(defaults.in_flight_defaults).toEqual({ "claude-code": true, codex: true, antigravity: false, grok: false });
    expect(defaults.engines?.map(e => [e.id, e.launch_delivery_policy?.ceiling])).toEqual([["claude-code", true], ["codex", true], ["antigravity", false], ["grok", false]]);
    const changed = buildRegister(config, undefined, "chatgpt", undefined, undefined, undefined, createDeliverySnapshot(config, {}));
    expect(changed.in_flight_defaults).toEqual({ "claude-code": false, codex: true, antigravity: true, grok: false });
    expect(changed.engines?.every(e => Object.values(e.launch_delivery_policy!.mechanisms).every(mode => mode === "none"))).toBe(true);
    expect(changedFields(base, { ...base, in_flight_delivery: { codex: { default: false } } })).toEqual(["in_flight_delivery"]);
  });
  it("captures immutable inputs and projects complete exact Claude persona overrides, but none for the retired Codex list", () => {
    const config = parseRunnerConfig(raw);
    const env = { KAOIRO_CLAUDE_PHASE2_DELIVERY_PERSONAS: "P,__proto__", KAOIRO_CODEX_OPERATOR_STEER_PERSONAS: "P,__proto__" };
    const snapshot = createDeliverySnapshot(config, env);
    env.KAOIRO_CLAUDE_PHASE2_DELIVERY_PERSONAS = "other"; env.KAOIRO_CODEX_OPERATOR_STEER_PERSONAS = "other"; config.codex!.backend = "exec";
    const codex = buildLaunchDeliveryMetadata(snapshot, "codex");
    const claude = buildLaunchDeliveryMetadata(snapshot, "claude-code");
    const fold = { operator_early: "fold", inter_agent_early: "fold", inter_agent_yield: "tool_boundary" };
    expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot.engines.codex)).toBe(true);
    expect(codex.mechanisms).toEqual({ ...none, operator_early: "steer", inter_agent_early: "steer" });
    expect(codex).not.toHaveProperty("persona_overrides");
    expect(claude.mechanisms).toEqual(none);
    expect(claude.persona_overrides).toEqual({ P: fold, ["__proto__"]: fold });
    expect(claude.persona_overrides).not.toHaveProperty("p");
  });
  it("projects the Codex mechanisms from the ceiling and the backend alone", () => {
    const steer = { ...none, operator_early: "steer", inter_agent_early: "steer" };
    const metadata = (codex: Record<string, unknown>) => buildLaunchDeliveryMetadata(
      createDeliverySnapshot(parseRunnerConfig({ ...raw, codex: { ...raw.codex, ...codex } }), {}), "codex");
    expect(metadata({}).mechanisms).toEqual(steer);
    expect(metadata({ operator_steer: false }).mechanisms).toEqual(steer);
    expect(metadata({ backend: "exec" })).toMatchObject({ ceiling: true, mechanisms: none });
    expect(metadata({ backend: "exec", operator_steer: true }).mechanisms).toEqual(none);
    const closed = buildLaunchDeliveryMetadata(createDeliverySnapshot(
      parseRunnerConfig({ ...raw, in_flight_delivery: { codex: { enabled: false } } }),
      { KAOIRO_CODEX_OPERATOR_STEER: "1", KAOIRO_CODEX_OPERATOR_STEER_PERSONAS: "P" }), "codex");
    expect(closed).toMatchObject({ ceiling: false, mechanisms: none });
  });
  it("omits whole metadata at either independent bound and preserves defaults with a size-only warning", () => {
    const metadata = boundedMetadata(); const warn = vi.fn();
    const register: RunnerRegister = { version: "0", host_id: "test", cwd_allowlist: ["/tmp"],
      engines: [{ id: "codex", models: [], launch_delivery_policy: metadata }], in_flight_defaults: { codex: false } };
    expect(deliveryJsonBytes(metadata)).toBe(8192);
    expect(preflightDeliveryRegister(register, warn).engines![0]!.launch_delivery_policy).toEqual(metadata);
    expect(warn).not.toHaveBeenCalled();
    const longKey = Object.keys(metadata.persona_overrides!).find(key => key.length > 2)!;
    const value = metadata.persona_overrides![longKey]!; delete metadata.persona_overrides![longKey]; metadata.persona_overrides![longKey + "x"] = value;
    expect(deliveryJsonBytes(metadata)).toBe(8193);
    const overflow = preflightDeliveryRegister(register, warn);
    expect(overflow.engines![0]).not.toHaveProperty("launch_delivery_policy"); expect(overflow.in_flight_defaults).toEqual({ codex: false });
    expect(warn).toHaveBeenLastCalledWith([{ engine: "codex", reason: "json_bytes", size: 8193, limit: 8192 }]);
    metadata.persona_overrides = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`p${i}`, none]));
    expect(deliveryJsonBytes(metadata)).toBeLessThan(8192);
    expect(preflightDeliveryRegister(register, warn).engines![0]).not.toHaveProperty("launch_delivery_policy");
    expect(warn).toHaveBeenLastCalledWith([{ engine: "codex", reason: "override_count", size: 65, limit: 64 }]);
  });
  it("omits all metadata under register pressure and warns once without model, path or persona data", () => {
    const warn = vi.fn(); const register: RunnerRegister = { version: "0", host_id: "test", cwd_allowlist: ["/private-path"],
      in_flight_defaults: { codex: false }, engines: (["claude-code", "codex", "antigravity"] as EngineKind[]).map(id => ({ id, models: [], launch_delivery_policy: boundedMetadata() })) };
    expect(registerSizeEstimate(register)).toBeGreaterThan(65536);
    expect(preflightDeliveryRegister(register, warn).engines?.every(e => e.launch_delivery_policy === undefined)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toHaveLength(3);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-path");
    const unicodeRegister: RunnerRegister = { ...register, engines: register.engines!.map(entry => ({ ...entry,
      models: Array.from({ length: 32 }, (_, i) => ({ value: `model-${i}`, display_name: "界".repeat(80) })),
      launch_delivery_policy: { version: "v1", ceiling: true, mechanisms: none },
    })) };
    expect(registerSizeEstimate(unicodeRegister)).toBeGreaterThan(65536);
    expect(preflightDeliveryRegister(unicodeRegister, vi.fn()).engines?.every(e => e.launch_delivery_policy === undefined)).toBe(true);
  });
  it("the production builder retains normal metadata and emits the size-only omission diagnostic", () => {
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const config = parseRunnerConfig(raw);
    buildRegister(config, undefined, "chatgpt", undefined, undefined, undefined, createDeliverySnapshot(config, {}));
    expect(warn).not.toHaveBeenCalled();
    const personas = Array.from({ length: 4000 }, (_, i) => `private-persona-${i}`).join(",");
    const retired = buildRegister(config, undefined, "chatgpt", undefined, undefined, undefined,
      createDeliverySnapshot(config, { KAOIRO_CODEX_OPERATOR_STEER_PERSONAS: personas }));
    expect(retired.engines!.find(e => e.id === "codex")).toHaveProperty("launch_delivery_policy");
    expect(warn).not.toHaveBeenCalled();
    const register = buildRegister(config, undefined, "chatgpt", undefined, undefined, undefined,
      createDeliverySnapshot(config, { KAOIRO_CLAUDE_PHASE2_DELIVERY_PERSONAS: personas }));
    expect(register.engines!.find(e => e.id === "claude-code")).not.toHaveProperty("launch_delivery_policy");
    expect(register.engines!.find(e => e.id === "codex")).toHaveProperty("launch_delivery_policy");
    expect(register.in_flight_defaults?.["claude-code"]).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('"reason":"override_count"');
    expect(String(warn.mock.calls[0]![0])).toContain('"size":4000');
    expect(String(warn.mock.calls[0]![0])).not.toContain("private-persona");
  });
});

describe("retired Codex operator-steer inputs in the runner", () => {
  const flag = "KAOIRO_CODEX_OPERATOR_STEER", list = "KAOIRO_CODEX_OPERATOR_STEER_PERSONAS";
  const config = (extra: Record<string, unknown> = {}) => parseRunnerConfig({ ...raw, ...extra });
  it("prints one runner line per present input, once per process, and none for an absent input", () => {
    const seen = new Set<string>();
    const file = config({ codex: { ...raw.codex, operator_steer: false } });
    const first = retiredDeliveryWarnings(file, { [flag]: "0", [list]: "secret-persona-id" }, seen);
    expect(first).toHaveLength(3);
    expect(first[0]).toMatch(new RegExp(`^runner: warn - ${flag} is retired and has no effect`));
    expect(first[1]).toMatch(new RegExp(`^runner: warn - ${list} is retired and has no effect`));
    expect(first[2]).toContain('"codex.operator_steer" in runner.config.json is retired');
    expect(first.join("")).not.toContain("secret-persona-id");
    expect(first.every(line => line.endsWith("\n"))).toBe(true);
    expect(retiredDeliveryWarnings(file, { [flag]: "0", [list]: "secret-persona-id" }, seen)).toEqual([]);
    expect(retiredDeliveryWarnings(config(), {}, new Set())).toEqual([]);
    expect(retiredDeliveryWarnings(config(), { [flag]: "", [list]: "" }, new Set())).toEqual([]);
  });
  it("adds a line only for an input that is new since the last call sharing the same seen set", () => {
    const seen = new Set<string>();
    expect(retiredDeliveryWarnings(config(), { [flag]: "1" }, seen)).toHaveLength(1);
    const withKey = config({ codex: { ...raw.codex, operator_steer: true } });
    const next = retiredDeliveryWarnings(withKey, { [flag]: "1" }, seen);
    expect(next).toHaveLength(1);
    expect(next[0]).toContain('"codex.operator_steer"');
  });
  it("does not warn for a host that does not enable Codex", () => {
    const file = { ...config({ capabilities: ["claude-code"], codex: undefined }), codex: { operator_steer: true } };
    expect(retiredDeliveryWarnings(file, { [flag]: "1", [list]: "P" }, new Set())).toEqual([]);
    expect(retiredDeliveryWarnings({ ...file, capabilities: ["claude-code", "codex"] }, { [flag]: "1" }, new Set())).toHaveLength(2);
  });
  it("removes exactly the two retired variables from a child environment", () => {
    const base = { [flag]: "1", [list]: "P", KAOIRO_CLAUDE_PHASE2_DELIVERY: "1", KAOIRO_CLAUDE_PHASE2_DELIVERY_PERSONAS: "P",
      KAOIRO_CODEX_APPROVAL_AXIS: "1", KAOIRO_CODEX_APPROVAL_AXIS_PERSONAS: "P", PATH: "/bin" };
    const child = withoutRetiredDeliveryInputs(base);
    expect(child).toEqual({ KAOIRO_CLAUDE_PHASE2_DELIVERY: "1", KAOIRO_CLAUDE_PHASE2_DELIVERY_PERSONAS: "P",
      KAOIRO_CODEX_APPROVAL_AXIS: "1", KAOIRO_CODEX_APPROVAL_AXIS_PERSONAS: "P", PATH: "/bin" });
    expect(base[flag]).toBe("1");
  });
});

it("resolves omitted Codex selection before publishing delivery metadata", () => {
  const snapshot = createDeliverySnapshot(parseRunnerConfig({ ...raw, codex: {} }), {});
  expect(snapshot.engines.codex.codexBackend).toBe("app-server");
  expect(buildLaunchDeliveryMetadata(snapshot, "codex").mechanisms).toMatchObject({ operator_early: "steer", inter_agent_early: "steer" });
});
