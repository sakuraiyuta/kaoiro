import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineKind, LaunchDeliveryPolicyMetadata, RunnerRegister } from "@kaoiro/protocol";
import { buildRegister, parseRunnerConfig } from "../src/config.js";
import { changedFields } from "../src/config-diff.js";
import { HOST_DELIVERY_ROWS } from "../src/behaviour-settings.js";
import { buildLaunchDeliveryMetadata, createDeliverySnapshot, deliveryJsonBytes, preflightDeliveryRegister,
  registerSizeEstimate } from "../src/delivery-settings.js";

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
    expect(HOST_DELIVERY_ROWS.map(row => row.engine)).toEqual(["claude-code", "codex", "antigravity"]);
    const base = parseRunnerConfig(raw); const snapshot = createDeliverySnapshot(base, {});
    const defaults = buildRegister(base, undefined, "chatgpt", undefined, undefined, undefined, snapshot);
    expect(defaults.in_flight_defaults).toEqual({ "claude-code": true, codex: true, antigravity: false });
    expect(defaults.engines?.map(e => [e.id, e.launch_delivery_policy?.ceiling])).toEqual([["claude-code", true], ["codex", true], ["antigravity", false]]);
    const changed = buildRegister(config, undefined, "chatgpt", undefined, undefined, undefined, createDeliverySnapshot(config, {}));
    expect(changed.in_flight_defaults).toEqual({ "claude-code": false, codex: true, antigravity: true });
    expect(changed.engines?.every(e => Object.values(e.launch_delivery_policy!.mechanisms).every(mode => mode === "none"))).toBe(true);
    expect(changedFields(base, { ...base, in_flight_delivery: { codex: { default: false } } })).toEqual(["in_flight_delivery"]);
  });
  it("captures immutable inputs, projects complete exact persona overrides and preserves independent operator modes", () => {
    const config = parseRunnerConfig(raw); const env = { KAOIRO_CODEX_OPERATOR_STEER_PERSONAS: "P,__proto__" };
    const snapshot = createDeliverySnapshot(config, env);
    env.KAOIRO_CODEX_OPERATOR_STEER_PERSONAS = "other"; config.codex!.backend = "exec";
    const metadata = buildLaunchDeliveryMetadata(snapshot, "codex");
    expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot.engines.codex)).toBe(true);
    expect(metadata.mechanisms).toEqual({ ...none, inter_agent_early: "steer" });
    expect(metadata.persona_overrides).toEqual({ P: { ...none, operator_early: "steer", inter_agent_early: "steer" },
      ["__proto__"]: { ...none, operator_early: "steer", inter_agent_early: "steer" } });
    expect(metadata.persona_overrides).not.toHaveProperty("p");
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
    const register = buildRegister(config, undefined, "chatgpt", undefined, undefined, undefined,
      createDeliverySnapshot(config, { KAOIRO_CODEX_OPERATOR_STEER_PERSONAS: personas }));
    expect(register.engines!.find(e => e.id === "codex")).not.toHaveProperty("launch_delivery_policy");
    expect(register.in_flight_defaults?.codex).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('"reason":"override_count"');
    expect(String(warn.mock.calls[0]![0])).toContain('"size":4000');
    expect(String(warn.mock.calls[0]![0])).not.toContain("private-persona");
  });
});
