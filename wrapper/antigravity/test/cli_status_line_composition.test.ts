// Issue 482. The status line tools reach Antigravity through
// `...interAgent.descriptors()` in the production CLI. This composes the real
// CLI around a stand-in link and calls the tool the way the bridge would, so a
// tool that is not in the real composition, or is not wired to the link's
// setStatusLine / readStatusLine, fails here and not only in a unit test of
// InterAgentTool.
import { describe, expect, it, vi } from "vitest";
import type { ToolDescriptor, WrapperConfig } from "@kaoiro/agent-common";
import { runAntigravityCli } from "../src/cli.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

async function compose() {
  const setStatusLine = vi.fn(async (_text: string) => ({
    kind: "ok" as const,
    status_line: { bytes: 5, truncated: false, updated_at: "2026-10-03T12:00:00.000001Z" },
  }));
  const readStatusLine = vi.fn(async (agentId: string) => ({
    kind: "ok" as const,
    agent_id: agentId,
    status_line: { text: "peer text", bytes: 9, updated_at: "t" },
  }));
  let hostOptions!: Record<string, unknown>;
  const link = {
    close: () => {},
    send: () => {},
    setStatusLine,
    readStatusLine,
  };
  const host = {
    state: "idle",
    statusExtSnapshot: () => ({ engine: "antigravity" }),
    statusSnapshot: () => ({ agent_id: config.agent_id, persona: config.persona, state: "idle" as const }),
    run: async () => {},
    setPendingPermission: () => {},
    setPendingQuestion: () => {},
    activeInterAgentTurnToken: () => "turn-1",
    beginPermissionWaitLease: () => null,
    endPermissionWaitLease: () => {},
  };

  await runAntigravityCli({
    parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
    loadConfig: () => ({ ...config }),
    createServerLink: (_url, _agentId, options) => {
      queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
      return link as never;
    },
    createHost: (_config, options) => {
      hostOptions = options as unknown as Record<string, unknown>;
      return host as never;
    },
  });
  return { descriptors: hostOptions.toolDescriptors as ToolDescriptor[], setStatusLine, readStatusLine };
}

describe("Antigravity CLI status line composition (issue 482)", () => {
  it("offers both tools on the bridge", async () => {
    const { descriptors } = await compose();

    expect(descriptors.map((d) => d.name)).toEqual(
      expect.arrayContaining(["set_status_line", "read_status_line"]),
    );
  });

  it("set_status_line reaches the link on its first call and returns the stored size", async () => {
    const { descriptors, setStatusLine } = await compose();

    const result = await descriptors.find((d) => d.name === "set_status_line")!.handler({ text: "hello" });

    expect(setStatusLine).toHaveBeenCalledWith("hello");
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      status_line: { bytes: 5, truncated: false, updated_at: "2026-10-03T12:00:00.000001Z" },
    });
  });

  it("read_status_line reaches the link with the agent id", async () => {
    const { descriptors, readStatusLine } = await compose();

    const result = await descriptors.find((d) => d.name === "read_status_line")!.handler({ agent_id: "peer.1" });

    expect(readStatusLine).toHaveBeenCalledWith("peer.1");
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      agent_id: "peer.1",
      status_line: { text: "peer text" },
    });
  });

  it("does not reach the link with an invalid input", async () => {
    const { descriptors, setStatusLine, readStatusLine } = await compose();

    const set = await descriptors.find((d) => d.name === "set_status_line")!.handler({ text: 7 });
    const read = await descriptors.find((d) => d.name === "read_status_line")!.handler({});

    expect(set.isError).toBe(true);
    expect(read.isError).toBe(true);
    expect(setStatusLine).not.toHaveBeenCalled();
    expect(readStatusLine).not.toHaveBeenCalled();
  });
});
