import { describe, expect, it } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { updateEvents } from "../src/muse/events.js";
import { parseSelection } from "../src/muse/usage.js";
import { childEnvironment, museAcpArgs } from "../src/muse/process.js";

const notification = (update: unknown) =>
  ({ sessionId: "s", update }) as SessionNotification;

describe("updateEvents", () => {
  it("maps a text chunk to an assistant event carrying the text", () => {
    const result = updateEvents(notification({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hi" },
    }));
    expect(result.events).toEqual([{ kind: "assistant", blocks: ["text"] }]);
    expect(result.text).toBe("hi");
  });

  it("maps tool call rows and completions", () => {
    const call = updateEvents(notification({
      sessionUpdate: "tool_call", toolCallId: "t1", title: "read", status: "in_progress",
    }));
    expect(call.log).toEqual({ kind: "tool_use", tool_name: "read" });
    const done = updateEvents(notification({
      sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed",
    }));
    expect(done.events).toEqual([{ kind: "tool_result", toolUseIds: ["t1"] }]);
  });

  it("maps a usage update to a context reading and ignores a zero size", () => {
    expect(updateEvents(notification({
      sessionUpdate: "usage_update", used: 42, size: 100,
    })).usage).toEqual({ used: 42, size: 100 });
    expect(updateEvents(notification({
      sessionUpdate: "usage_update", used: 42, size: 0,
    })).usage).toBeUndefined();
  });

  it("drops variants it does not know", () => {
    expect(updateEvents(notification({ sessionUpdate: "future_variant" })).events)
      .toEqual([]);
  });
});

describe("parseSelection", () => {
  it("reads the catalog and current values by ACP category", () => {
    const selection = parseSelection([
      { id: "m", name: "Model", category: "model", type: "select", currentValue: "a",
        options: [{ value: "a", name: "A" }, { value: "b", name: "B" }] },
      { id: "e", name: "Effort", category: "thought_level", type: "select", currentValue: "high",
        options: [{ value: "low", name: "low" }, { value: "high", name: "high" }] },
    ] as never);
    expect(selection.models).toEqual([
      { value: "a", display_name: "A" },
      { value: "b", display_name: "B" },
    ]);
    expect(selection.model).toBe("a");
    expect(selection.modelConfigId).toBe("m");
    expect(selection.effortLevels).toEqual(["low", "high"]);
    expect(selection.effort).toBe("high");
    expect(selection.effortConfigId).toBe("e");
  });

  it("tolerates a session with no config options", () => {
    expect(parseSelection(undefined)).toEqual({ models: [], effortLevels: [] });
  });
});

describe("process arguments and environment", () => {
  it("builds the resident ACP arguments, with a launch model pick", () => {
    expect(museAcpArgs()).toEqual(["acp", "--trust-workspace"]);
    expect(museAcpArgs("default")).toEqual(["acp", "--trust-workspace"]);
    expect(museAcpArgs("muse-wonder")).toEqual(
      ["acp", "--trust-workspace", "--model", "muse-wonder"]);
  });

  it("opens the ACP gate only when the operator has not set it", () => {
    expect(childEnvironment({}).MUSE_EXPERIMENTAL_ACP).toBe("on");
    expect(childEnvironment({ MUSE_EXPERIMENTAL_ACP: "off" }).MUSE_EXPERIMENTAL_ACP)
      .toBe("off");
  });
});
