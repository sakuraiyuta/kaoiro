import "../../../scripts/test/fixtures/test-isolation.mjs";
import { describe, expect, it } from "vitest";
import {
  captureDeliveryEnvironment, resolveDelivery, retiredCodexOperatorSteerInputs, retiredCodexOperatorSteerMessage,
  retiredClaudePhase2Inputs, retiredClaudePhase2Message,
} from "../src/delivery_modes.js";

const off = { operator_early: "none", inter_agent_early: "none", inter_agent_yield: "none" };
const fold = { operator_early: "fold", inter_agent_early: "fold", inter_agent_yield: "tool_boundary" };
describe("delivery resolution under a host ceiling", () => {
  it.each([
    ["0", true, "P", "P"],
    ["0", true, "P", "other"],
    [undefined, false, "P", "P"],
    ["", true, "bad id", "other"],
    ["1", false, "bad id", "other"],
    [undefined, false, "P,", "P"],
    [undefined, false, "bad id,P", "P"],
    [undefined, false, "p", "P"],
  ] as const)("preserves flag=%s config=%s list=%s persona=%s", (flag, config, list, persona) => {
    const env = captureDeliveryEnvironment({ KAOIRO_CLAUDE_PHASE2_DELIVERY: flag,
      KAOIRO_CLAUDE_PHASE2_DELIVERY_PERSONAS: list });
    const input = { engine: "claude-code" as const, personaId: persona, env };
    expect(retiredClaudePhase2Inputs({ env, fileKey: config })).toContain("phase2_delivery");
    expect(resolveDelivery(input).mechanisms).toEqual(fold);
    expect(resolveDelivery({ ...input, ceiling: false }).mechanisms).toEqual(off);
  });
  it("declares Codex steering from the backend and the ceiling alone", () => {
    const steer = { operator_early: "steer", inter_agent_early: "steer", inter_agent_yield: "none" };
    const input = { engine: "codex" as const, personaId: "P", env: {}, codexBackend: "app-server" as const };
    expect(resolveDelivery(input).mechanisms).toEqual(steer);
    expect(resolveDelivery({ ...input, ceiling: true }).mechanisms).toEqual(steer);
    expect(resolveDelivery({ ...input, ceiling: false }).mechanisms).toEqual(off);
    expect(resolveDelivery({ ...input, codexBackend: "exec" }).mechanisms).toEqual(off);
    expect(resolveDelivery({ ...input, engine: "antigravity", ceiling: true }).mechanisms).toEqual(off);
  });
  it("ignores every retired Codex input, including a set zero and a list that omits the persona", () => {
    const steer = { operator_early: "steer", inter_agent_early: "steer", inter_agent_yield: "none" };
    for (const raw of [{ KAOIRO_CODEX_OPERATOR_STEER: "0" }, { KAOIRO_CODEX_OPERATOR_STEER_PERSONAS: "other" },
      { KAOIRO_CODEX_OPERATOR_STEER: "1", KAOIRO_CODEX_OPERATOR_STEER_PERSONAS: "P" }]) {
      const input = { engine: "codex" as const, personaId: "P", codexBackend: "app-server" as const, env: captureDeliveryEnvironment(raw) };
      expect(resolveDelivery(input).mechanisms, JSON.stringify(raw)).toEqual(steer);
      expect(resolveDelivery({ ...input, ceiling: false }).mechanisms, JSON.stringify(raw)).toEqual(off);
      expect(resolveDelivery({ ...input, codexBackend: "exec" }).mechanisms, JSON.stringify(raw)).toEqual(off);
    }
  });
});

describe("retired Codex operator-steer inputs", () => {
  const flag = "KAOIRO_CODEX_OPERATOR_STEER", list = "KAOIRO_CODEX_OPERATOR_STEER_PERSONAS";
  it("names each present input once, in a fixed order", () => {
    expect(retiredCodexOperatorSteerInputs({ env: {}, fileKey: undefined })).toEqual([]);
    expect(retiredCodexOperatorSteerInputs({ env: { [flag]: "0" }, fileKey: undefined })).toEqual([flag]);
    expect(retiredCodexOperatorSteerInputs({ env: { [list]: "a,b" }, fileKey: undefined })).toEqual([list]);
    expect(retiredCodexOperatorSteerInputs({ env: {}, fileKey: true })).toEqual(["operator_steer"]);
    expect(retiredCodexOperatorSteerInputs({ env: { [list]: "a", [flag]: "1" }, fileKey: false }))
      .toEqual([flag, list, "operator_steer"]);
  });
  it("treats an empty variable as absent and a false key as present", () => {
    expect(retiredCodexOperatorSteerInputs({ env: { [flag]: "", [list]: "" }, fileKey: undefined })).toEqual([]);
    expect(retiredCodexOperatorSteerInputs({ env: {}, fileKey: false })).toEqual(["operator_steer"]);
  });
  it("renders a message from the input name alone and states the replacements", () => {
    const secret = "secret-persona-id";
    for (const scope of ["runner", "wrapper"] as const) {
      for (const input of [flag, list, "operator_steer"] as const) {
        const text = retiredCodexOperatorSteerMessage(input, scope);
        expect(text).toContain("is retired and has no effect");
        expect(text).toContain("in_flight_delivery.codex.enabled");
        expect(text).toContain("in_flight_delivery.codex.default");
        expect(text).toContain("per-agent policy");
        expect(text).not.toContain(secret);
      }
    }
    expect(retiredCodexOperatorSteerMessage(flag, "runner").startsWith(`${flag} is retired`)).toBe(true);
    expect(retiredCodexOperatorSteerMessage("operator_steer", "runner")).toContain('"codex.operator_steer" in runner.config.json');
    expect(retiredCodexOperatorSteerMessage("operator_steer", "wrapper")).toContain("operator_steer in the wrapper config");
    const present = retiredCodexOperatorSteerInputs({ env: { [list]: secret }, fileKey: undefined });
    expect(present.map(input => retiredCodexOperatorSteerMessage(input, "runner")).join("\n")).not.toContain(secret);
  });
});

describe("retired Claude phase-2 inputs", () => {
  const flag = "KAOIRO_CLAUDE_PHASE2_DELIVERY", list = "KAOIRO_CLAUDE_PHASE2_DELIVERY_PERSONAS";
  it("declares fold by default and warns for each present input without its value", () => {
    expect(resolveDelivery({ engine: "claude-code", env: {} })).toEqual({ mechanisms: fold, source: "policy" });
    expect(retiredClaudePhase2Inputs({ env: {}, fileKey: undefined })).toEqual([]);
    expect(retiredClaudePhase2Inputs({ env: { [flag]: "", [list]: "" }, fileKey: undefined })).toEqual([]);
    for (const fileKey of [true, false]) {
      const inputs = retiredClaudePhase2Inputs({ env: { [flag]: "0", [list]: "private-sentinel" }, fileKey });
      expect(inputs).toEqual([flag, list, "phase2_delivery"]);
      for (const scope of ["runner", "wrapper"] as const) {
        const text = inputs.map(input => retiredClaudePhase2Message(input, scope)).join("\n");
        expect(text).not.toContain("private-sentinel");
        expect(text).toContain("is retired and has no effect");
        expect(text).toContain(scope === "runner" ? "in_flight_delivery.claude-code.enabled" : "in_flight_delivery_enabled");
        expect(text).toContain("per-agent policy");
      }
    }
  });
});
