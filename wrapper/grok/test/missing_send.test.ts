import "../../../scripts/test/fixtures/test-isolation.mjs";
import { describe, expect, it } from "vitest";
import { classifyMissingSend } from "./native-support.js";

// Shapes copied from Grok Build 1.0.52 session records (issue #1123): an auto
// mode refusal, and a refusal by the live-permission test hook.
const update = (text: string) =>
  JSON.stringify({
    timestamp: 1,
    method: "session/update",
    params: {
      sessionId: "session",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "failed",
        content: [{ type: "content", content: { type: "text", text } }],
      },
    },
  });
const autoMode = update(
  "Tool `use_tool` was not executed: Auto mode blocked this action (No " +
    "first-party user request authorizes sending a message). Take a safer approach.",
);
const hookDenied = update(
  "Hook denied: Only the tool calls this test requested may run.",
);

describe("classifyMissingSend (issue #1123)", () => {
  it("counts an auto mode refusal of a tool that never ran as indeterminate", () => {
    const result = classifyMissingSend({
      toolRan: false,
      updates: `not json\nnull\n${hookDenied}\n${autoMode}\n`,
    });
    expect(result.verdict).toBe("indeterminate");
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toContain("Auto mode blocked this action");
  });

  it("fails a run whose requested tool ran, even with a refusal on record", () => {
    expect(
      classifyMissingSend({ toolRan: true, updates: autoMode }).verdict,
    ).toBe("failed");
  });

  it("fails a run with only a hook denial, or no refusal at all", () => {
    expect(
      classifyMissingSend({ toolRan: false, updates: hookDenied }).verdict,
    ).toBe("failed");
    expect(classifyMissingSend({ toolRan: false, updates: "" }).verdict).toBe(
      "failed",
    );
  });

  it("fails a run whose session record could not be read", () => {
    expect(
      classifyMissingSend({ toolRan: false, updates: undefined }).verdict,
    ).toBe("failed");
  });

  it("ignores the refusal text outside a failed tool_call_update", () => {
    const entry = (sessionUpdate: string, status: string) =>
      JSON.stringify({
        params: {
          update: {
            sessionUpdate,
            status,
            content: [{ type: "content", content: { type: "text",
              text: "was not executed: Auto mode blocked this action" } }],
          },
        },
      });
    for (const updates of [
      entry("agent_thought_chunk", "failed"),
      entry("tool_call_update", "completed"),
      JSON.stringify({ params: { update: {
        sessionUpdate: "tool_call_update", status: "failed" } } }),
    ]) {
      expect(classifyMissingSend({ toolRan: false, updates }).verdict).toBe(
        "failed",
      );
    }
  });
});
