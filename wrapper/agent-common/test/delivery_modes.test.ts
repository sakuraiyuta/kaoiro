import { describe, expect, it } from "vitest";
import { captureDeliveryEnvironment, resolveDelivery } from "../src/delivery_modes.js";

const off = { operator_early: "none", inter_agent_early: "none", inter_agent_yield: "none" };
const fold = { operator_early: "fold", inter_agent_early: "fold", inter_agent_yield: "tool_boundary" };
describe("legacy delivery resolution under a host ceiling", () => {
  it.each([
    ["0", true, "P", "P", true],
    ["0", true, "P", "other", false],
    [undefined, false, "P", "P", true],
    ["", true, "bad id", "other", true],
    ["1", false, "bad id", "other", true],
    [undefined, false, "P,", "P", false],
    [undefined, false, "bad id,P", "P", false],
    [undefined, false, "p", "P", false],
  ] as const)("preserves flag=%s config=%s list=%s persona=%s", (flag, config, list, persona, enabled) => {
    const env = captureDeliveryEnvironment({ KAOIRO_CLAUDE_PHASE2_DELIVERY: flag,
      KAOIRO_CLAUDE_PHASE2_DELIVERY_PERSONAS: list });
    const input = { engine: "claude-code" as const, personaId: persona, phase2Delivery: config, env };
    expect(resolveDelivery(input).mechanisms).toEqual(enabled ? fold : off);
    expect(resolveDelivery({ ...input, ceiling: false }).mechanisms).toEqual(off);
  });
  it("keeps backend, operator opt-in and Antigravity support separate", () => {
    const input = { engine: "codex" as const, personaId: "P", env: {}, codexBackend: "app-server" as const };
    expect(resolveDelivery(input).mechanisms).toEqual({ ...off, inter_agent_early: "steer" });
    expect(resolveDelivery({ ...input, operatorSteer: true }).mechanisms).toEqual({ ...off, operator_early: "steer", inter_agent_early: "steer" });
    expect(resolveDelivery({ ...input, operatorSteer: true, ceiling: false }).mechanisms).toEqual(off);
    expect(resolveDelivery({ ...input, operatorSteer: true, codexBackend: "exec" }).mechanisms).toEqual(off);
    expect(resolveDelivery({ ...input, engine: "antigravity", ceiling: true }).mechanisms).toEqual(off);
  });
});
