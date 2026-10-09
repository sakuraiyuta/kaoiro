import type { DeliveryMechanisms, EngineKind } from "@kaoiro/protocol";
import { flagArgument, personaOptInSource, type PersonaOptInSource } from "./persona_opt_in.js";

export const DELIVERY_ENGINE_SETTINGS = [
  { engine: "claude-code", enabled: true, default: true },
  { engine: "codex", enabled: true, default: true },
  { engine: "antigravity", enabled: false, default: false },
] as const;

export const DELIVERY_ENV_KEYS = [
  "KAOIRO_CLAUDE_PHASE2_DELIVERY", "KAOIRO_CLAUDE_PHASE2_DELIVERY_PERSONAS",
  "KAOIRO_CODEX_OPERATOR_STEER", "KAOIRO_CODEX_OPERATOR_STEER_PERSONAS",
] as const;
export type DeliveryEnvironment = Readonly<Partial<Record<typeof DELIVERY_ENV_KEYS[number], string>>>;

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
  phase2Delivery?: boolean | undefined;
  operatorSteer?: boolean | undefined;
  env: DeliveryEnvironment;
}

export function resolveDelivery(inputs: DeliveryInputs): { mechanisms: DeliveryMechanisms; source: PersonaOptInSource } {
  const mechanisms: DeliveryMechanisms = { operator_early: "none", inter_agent_early: "none", inter_agent_yield: "none" };
  if (inputs.ceiling === false) return { mechanisms, source: "off" };
  const persona = inputs.personaId ?? "";
  if (inputs.engine === "claude-code") {
    const source = personaOptInSource(persona,
      flagArgument(inputs.env.KAOIRO_CLAUDE_PHASE2_DELIVERY, inputs.phase2Delivery),
      inputs.env.KAOIRO_CLAUDE_PHASE2_DELIVERY_PERSONAS);
    if (source !== "off") {
      mechanisms.operator_early = "fold";
      mechanisms.inter_agent_early = "fold";
      mechanisms.inter_agent_yield = "tool_boundary";
    }
    return { mechanisms, source };
  }
  if (inputs.engine === "codex" && inputs.codexBackend === "app-server") {
    const source = personaOptInSource(persona,
      flagArgument(inputs.env.KAOIRO_CODEX_OPERATOR_STEER, inputs.operatorSteer),
      inputs.env.KAOIRO_CODEX_OPERATOR_STEER_PERSONAS);
    mechanisms.inter_agent_early = "steer";
    if (source !== "off") mechanisms.operator_early = "steer";
    return { mechanisms, source };
  }
  return { mechanisms, source: "off" };
}
