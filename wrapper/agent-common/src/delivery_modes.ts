import type { DeliveryMechanisms, EngineKind } from "@kaoiro/protocol";

export const DELIVERY_ENGINE_SETTINGS = [
  { engine: "claude-code", enabled: true, default: true },
  { engine: "codex", enabled: true, default: true },
  { engine: "antigravity", enabled: false, default: false },
  { engine: "grok", enabled: false, default: false },
] as const;

export const DELIVERY_ENV_KEYS = [
  "KAOIRO_CLAUDE_PHASE2_DELIVERY", "KAOIRO_CLAUDE_PHASE2_DELIVERY_PERSONAS",
  "KAOIRO_CODEX_OPERATOR_STEER", "KAOIRO_CODEX_OPERATOR_STEER_PERSONAS",
] as const;
export type DeliveryEnvironment = Readonly<Partial<Record<typeof DELIVERY_ENV_KEYS[number], string>>>;

/** Codex operator-steer inputs that no longer gate anything (issue #563).
 *  The runner warns about them, strips the variables from child
 *  environments and does not relay the file key; the Codex wrapper warns
 *  when a direct launch still carries one. */
export const RETIRED_CODEX_OPERATOR_STEER_ENV = [
  "KAOIRO_CODEX_OPERATOR_STEER", "KAOIRO_CODEX_OPERATOR_STEER_PERSONAS",
] as const;
export type RetiredCodexOperatorSteerInput = typeof RETIRED_CODEX_OPERATOR_STEER_ENV[number] | "operator_steer";

export function retiredCodexOperatorSteerInputs(inputs: {
  env: Readonly<Record<string, string | undefined>>;
  fileKey: boolean | undefined;
}): RetiredCodexOperatorSteerInput[] {
  const present: RetiredCodexOperatorSteerInput[] = RETIRED_CODEX_OPERATOR_STEER_ENV
    .filter(name => inputs.env[name] !== undefined && inputs.env[name] !== "");
  if (inputs.fileKey !== undefined) present.push("operator_steer");
  return present;
}

export function retiredCodexOperatorSteerMessage(
  input: RetiredCodexOperatorSteerInput,
  scope: "runner" | "wrapper",
): string {
  const label = input !== "operator_steer" ? input
    : scope === "runner" ? '"codex.operator_steer" in runner.config.json' : "operator_steer in the wrapper config";
  return `${label} is retired and has no effect; neither a value of 0 nor a persona list that omits an agent ` +
    "restricts operator steering any more. Use in_flight_delivery.codex.enabled (host ceiling, next spawn), " +
    "in_flight_delivery.codex.default (new agents) or the per-agent policy (live).";
}

export const RETIRED_CLAUDE_PHASE2_ENV = [
  "KAOIRO_CLAUDE_PHASE2_DELIVERY", "KAOIRO_CLAUDE_PHASE2_DELIVERY_PERSONAS",
] as const;
export type RetiredClaudePhase2Input = typeof RETIRED_CLAUDE_PHASE2_ENV[number] | "phase2_delivery";

export function retiredClaudePhase2Inputs(inputs: {
  env: Readonly<Record<string, string | undefined>>;
  fileKey: boolean | undefined;
}): RetiredClaudePhase2Input[] {
  const present: RetiredClaudePhase2Input[] = RETIRED_CLAUDE_PHASE2_ENV
    .filter(name => inputs.env[name] !== undefined && inputs.env[name] !== "");
  if (inputs.fileKey !== undefined) present.push("phase2_delivery");
  return present;
}

export function retiredClaudePhase2Message(input: RetiredClaudePhase2Input, scope: "runner" | "wrapper"): string {
  const label = input !== "phase2_delivery" ? input
    : scope === "runner" ? '"claude_code.phase2_delivery" in runner.config.json' : "phase2_delivery in the wrapper config";
  const replacement = scope === "runner"
    ? "in_flight_delivery.claude-code.enabled (host ceiling, next spawn), in_flight_delivery.claude-code.default (new agents) or the per-agent policy (live)"
    : "in_flight_delivery_enabled (wrapper ceiling, next launch) or the per-agent policy (live)";
  return `${label} is retired and has no effect; neither a value of 0 nor a persona list that omits an agent ` +
    `restricts in-flight delivery any more. Use ${replacement}.`;
}

export function captureDeliveryEnvironment(env: Readonly<Record<string, string | undefined>>): DeliveryEnvironment {
  const result: Partial<Record<typeof DELIVERY_ENV_KEYS[number], string>> = {};
  for (const key of DELIVERY_ENV_KEYS) if (env[key] !== undefined) result[key] = env[key];
  return Object.freeze(result);
}

export interface DeliveryInputs {
  engine: EngineKind;
  personaId?: string | undefined;
  ceiling?: boolean | undefined;
  codexBackend?: "exec" | "app-server" | undefined;
  env: DeliveryEnvironment;
}

export function resolveDelivery(inputs: DeliveryInputs): { mechanisms: DeliveryMechanisms; source: "off" | "policy" } {
  const mechanisms: DeliveryMechanisms = { operator_early: "none", inter_agent_early: "none", inter_agent_yield: "none" };
  if (inputs.ceiling === false) return { mechanisms, source: "off" };
  if (inputs.engine === "claude-code") {
    mechanisms.operator_early = "fold";
    mechanisms.inter_agent_early = "fold";
    mechanisms.inter_agent_yield = "tool_boundary";
    return { mechanisms, source: "policy" };
  }
  if (inputs.engine === "codex" && inputs.codexBackend === "app-server") {
    mechanisms.operator_early = "steer";
    mechanisms.inter_agent_early = "steer";
    return { mechanisms, source: "policy" };
  }
  return { mechanisms, source: "off" };
}
