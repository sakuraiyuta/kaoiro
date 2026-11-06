import "../../../scripts/test/fixtures/test-isolation.mjs";
import { describe, expect, it } from "vitest";
import { resolveDelivery } from "../src/delivery_modes.js";

const none = { operator_early: "none", inter_agent_early: "none", inter_agent_yield: "none" };
describe("delivery resolution under a host ceiling", () => {
  it("declares Claude fold and yield by default", () => {
    const input = { engine: "claude-code" as const };
    expect(resolveDelivery(input)).toEqual({ mechanisms: {
      operator_early: "fold", inter_agent_early: "fold", inter_agent_yield: "tool_boundary",
    }, source: "policy" });
    expect(resolveDelivery({ ...input, ceiling: false })).toEqual({ mechanisms: none, source: "off" });
  });
  it("declares Codex steering from the backend and ceiling alone", () => {
    const input = { engine: "codex" as const, codexBackend: "app-server" as const };
    const steer = { operator_early: "steer", inter_agent_early: "steer", inter_agent_yield: "none" };
    expect(resolveDelivery(input).mechanisms).toEqual(steer);
    expect(resolveDelivery({ ...input, ceiling: true }).mechanisms).toEqual(steer);
    expect(resolveDelivery({ ...input, ceiling: false }).mechanisms).toEqual(none);
    expect(resolveDelivery({ ...input, codexBackend: "exec" }).mechanisms).toEqual(none);
    expect(resolveDelivery({ ...input, engine: "antigravity", ceiling: true }).mechanisms).toEqual(none);
  });
});
