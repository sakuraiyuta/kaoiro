import {
  captureDeliveryEnvironment, DELIVERY_ENGINE_SETTINGS, DELIVERY_ENV_KEYS,
  deliveryPersonaList, resolveDelivery,
  type DeliveryEnvironment, type DeliveryInputs,
} from "@kaoiro/agent-common";
import type { EngineCatalogEntry, EngineKind, LaunchDeliveryPolicyMetadata, RunnerRegister } from "@kaoiro/protocol";
import type { RunnerConfig } from "./config.js";
import { computeBehaviourRelay, type BehaviourRelay } from "./behaviour-settings.js";

export interface AppliedDeliverySnapshot {
  readonly env: DeliveryEnvironment;
  readonly engines: Readonly<Record<EngineKind, Readonly<DeliveryInputs & { ceiling: boolean; default: boolean }>>>;
}

export function createDeliverySnapshot(config: RunnerConfig, env: Readonly<Record<string, string | undefined>>): AppliedDeliverySnapshot {
  const captured = captureDeliveryEnvironment(env);
  const engines = Object.fromEntries(DELIVERY_ENGINE_SETTINGS.map(row => [row.engine, Object.freeze({
    engine: row.engine,
    ceiling: config.in_flight_delivery?.[row.engine]?.enabled ?? row.enabled,
    default: config.in_flight_delivery?.[row.engine]?.default ?? row.default,
    codexBackend: config.codex?.backend ?? "exec",
    phase2Delivery: config.claude_code?.phase2_delivery,
    operatorSteer: config.codex?.operator_steer,
    env: captured,
  })])) as Record<EngineKind, DeliveryInputs & { ceiling: boolean; default: boolean }>;
  return Object.freeze({ env: captured, engines: Object.freeze(engines) });
}

export function deliveryEnvironment(base: NodeJS.ProcessEnv, captured: DeliveryEnvironment): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of DELIVERY_ENV_KEYS) {
    if (captured[key] === undefined) delete env[key];
    else env[key] = captured[key];
  }
  return env;
}

export function buildLaunchDeliveryMetadata(snapshot: AppliedDeliverySnapshot, engine: EngineKind): LaunchDeliveryPolicyMetadata {
  const inputs = snapshot.engines[engine];
  const mechanisms = resolveDelivery(inputs).mechanisms;
  const list = engine === "claude-code" ? snapshot.env.KAOIRO_CLAUDE_PHASE2_DELIVERY_PERSONAS
    : engine === "codex" ? snapshot.env.KAOIRO_CODEX_OPERATOR_STEER_PERSONAS : undefined;
  const overrides: NonNullable<LaunchDeliveryPolicyMetadata["persona_overrides"]> = Object.create(null);
  for (const personaId of deliveryPersonaList(list)) {
    const modes = resolveDelivery({ ...inputs, personaId }).mechanisms;
    if (JSON.stringify(modes) !== JSON.stringify(mechanisms)) overrides[personaId] = modes;
  }
  return { version: "v1", ceiling: inputs.ceiling, mechanisms,
    ...(Object.keys(overrides).length === 0 ? {} : { persona_overrides: overrides }) };
}

export const DELIVERY_JSON_LIMIT = 8192;
export const DELIVERY_OVERRIDE_LIMIT = 64;
export const REGISTER_EXTERNAL_LIMIT = 65536;
export const REGISTER_EXTERNAL_JSON_RATIO = 1.5;
export const REGISTER_ESTIMATE_MULTIPLIER = 2;
export const REGISTER_ESTIMATE_MARGIN = 4096;

export const deliveryJsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
export const registerSizeEstimate = (value: RunnerRegister): number =>
  Math.ceil(deliveryJsonBytes(value) * REGISTER_EXTERNAL_JSON_RATIO * REGISTER_ESTIMATE_MULTIPLIER) + REGISTER_ESTIMATE_MARGIN;

export interface DeliveryOmission {
  engine: EngineKind;
  reason: "json_bytes" | "override_count" | "register_pressure";
  size: number;
  limit: number;
}

export function preflightDeliveryRegister(register: RunnerRegister, warn: (omissions: DeliveryOmission[]) => void): RunnerRegister {
  const omissions: DeliveryOmission[] = [];
  const engines: EngineCatalogEntry[] = (register.engines ?? []).map(entry => {
    const metadata = entry.launch_delivery_policy;
    if (metadata === undefined) return entry;
    const count = Object.keys(metadata.persona_overrides ?? {}).length;
    const bytes = deliveryJsonBytes(metadata);
    const reason = count > DELIVERY_OVERRIDE_LIMIT ? "override_count" : bytes > DELIVERY_JSON_LIMIT ? "json_bytes" : undefined;
    if (reason === undefined) return entry;
    omissions.push({ engine: entry.id, reason, size: reason === "override_count" ? count : bytes,
      limit: reason === "override_count" ? DELIVERY_OVERRIDE_LIMIT : DELIVERY_JSON_LIMIT });
    const { launch_delivery_policy: _metadata, ...rest } = entry;
    return rest;
  });
  let result = { ...register, engines };
  const estimate = registerSizeEstimate(result);
  if (estimate > REGISTER_EXTERNAL_LIMIT) {
    result = { ...result, engines: engines.map(entry => {
      if (entry.launch_delivery_policy === undefined) return entry;
      omissions.push({ engine: entry.id, reason: "register_pressure", size: estimate, limit: REGISTER_EXTERNAL_LIMIT });
      const { launch_delivery_policy: _metadata, ...rest } = entry;
      return rest;
    }) };
  }
  if (omissions.length !== 0) warn(omissions);
  return result;
}

export function projectDeliveryRegister(register: RunnerRegister, snapshot: AppliedDeliverySnapshot): RunnerRegister {
  const engines = (register.engines ?? []).map(entry => ({ ...entry, launch_delivery_policy: buildLaunchDeliveryMetadata(snapshot, entry.id) }));
  const in_flight_defaults = Object.fromEntries(engines.map(entry => [entry.id, snapshot.engines[entry.id].default]));
  return preflightDeliveryRegister({ ...register, engines, in_flight_defaults }, omissions => {
    process.stderr.write(`runner: launch delivery metadata omitted ${JSON.stringify(omissions)}\n`);
  });
}

export function deliveryBehaviourRelay(config: RunnerConfig, env: NodeJS.ProcessEnv, snapshot: AppliedDeliverySnapshot): BehaviourRelay {
  const relay = computeBehaviourRelay(config, deliveryEnvironment(env, snapshot.env));
  for (const { engine } of DELIVERY_ENGINE_SETTINGS) {
    relay[engine] = { ...relay[engine], in_flight_delivery_enabled: snapshot.engines[engine].ceiling };
  }
  return relay;
}
