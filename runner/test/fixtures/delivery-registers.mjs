import { buildRegister, parseRunnerConfig } from "../../dist/config.js";
import { createDeliverySnapshot, deliveryJsonBytes, preflightDeliveryRegister, registerSizeEstimate,
  REGISTER_EXTERNAL_JSON_RATIO, REGISTER_ESTIMATE_MULTIPLIER } from "../../dist/delivery-settings.js";

const ids = ["claude-code", "codex", "antigravity"];
const none = { operator_early: "none", inter_agent_early: "none", inter_agent_yield: "none" };
function maximumMetadata() {
  const value = { version: "v1", ceiling: true, mechanisms: none,
    persona_overrides: Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`p${i}`, none])) };
  const key = "p0" + "x".repeat(8192 - deliveryJsonBytes(value));
  delete value.persona_overrides.p0; value.persona_overrides[key] = none;
  return value;
}
const config = parseRunnerConfig({ host_id: "delivery-integration", server_url: "ws://127.0.0.1/runner", cwd_allowlist: ["/tmp"],
  allowed_personas: ["ao"], capabilities: ids, codex: { backend: "app-server", auth_mode: "chatgpt", chatgpt_plan: "plus" },
  claude_code: { phase2_delivery: true }, in_flight_delivery: { codex: { default: false } } });
const snapshot = createDeliverySnapshot(config, {});
const actual = buildRegister(config, undefined, "chatgpt", undefined, undefined, undefined, snapshot);
const disabledConfig = { ...config, in_flight_delivery: { codex: { enabled: false, default: false } } };
const disabled = buildRegister(disabledConfig, undefined, "chatgpt", undefined, undefined, undefined, createDeliverySnapshot(disabledConfig, {}));
const oversized = buildRegister(config, undefined, "chatgpt", undefined, undefined, undefined,
  createDeliverySnapshot(config, { KAOIRO_CODEX_OPERATOR_STEER_PERSONAS: Array.from({ length: 65 }, (_, i) => `p${i}`).join(",") }));
const minimal = { version: "0", host_id: "delivery-size", cwd_allowlist: ["/tmp"], capabilities: ids,
  in_flight_defaults: { "claude-code": true, codex: true, antigravity: false } };
const rawMaximum = { ...minimal, engines: ids.map(id => ({ id, models: [], launch_delivery_policy: maximumMetadata() })) };
const ordinary = { ...minimal, engines: ids.map(id => ({ id,
  models: Array.from({ length: 32 }, (_, i) => ({ value: `sample-${id}-model-${String(i).padStart(2, "0")}`, display_name: `Sample ${i}` })),
  launch_delivery_policy: { version: "v1", ceiling: true, mechanisms: none,
    persona_overrides: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`test-persona-${String(i).padStart(2, "0")}`, none])) },
})) };
const near = { ...rawMaximum, engines: rawMaximum.engines.map(entry => ({ ...entry,
  models: Array.from({ length: 32 }, (_, i) => ({ value: String(i).padEnd(250, "v"), display_name: "d".repeat(250) })) })) };
const short = { ...minimal, engines: ids.map(id => ({ id, models: Array.from({ length: 32 }, () => ({ value: "v", display_name: "d" })) })) };
const noWarnings = () => {};
const size = value => ({ json_bytes: deliveryJsonBytes(value), estimate: registerSizeEstimate(value) });
const ordinarySent = preflightDeliveryRegister(ordinary, noWarnings);
const maximumSent = preflightDeliveryRegister(rawMaximum, noWarnings);
const nearSent = preflightDeliveryRegister(near, noWarnings);
process.stdout.write(JSON.stringify({ actual, disabled, oversized, rawMaximum, ordinary, ordinarySent, maximumSent, near, nearSent, short,
  sentMeasurements: Object.fromEntries(Object.entries({ actual, rawMaximum, ordinarySent, maximumSent, nearSent, short }).map(([key, value]) => [key, size(value)])),
  measurements: Object.fromEntries(Object.entries({ actual, rawMaximum, ordinary, near, short }).map(([key, value]) => [key, size(value)])),
  ratio: REGISTER_EXTERNAL_JSON_RATIO, multiplier: REGISTER_ESTIMATE_MULTIPLIER,
}));
