import type { DeliveryMechanisms, EngineKind } from "@kaoiro/protocol";

export const DELIVERY_ENGINE_SETTINGS = [
  { engine: "claude-code", enabled: true, default: true },
  { engine: "codex", enabled: true, default: true },
  { engine: "antigravity", enabled: false, default: false },
  { engine: "grok", enabled: false, default: false },
] as const;

export interface DeliveryInputs {
  engine: EngineKind;
  ceiling?: boolean | undefined;
  codexBackend?: "exec" | "app-server" | undefined;
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
