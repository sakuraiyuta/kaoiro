// Issue 482. In the production Claude CLI the two status line tools reach the
// server link through providers that `cli.ts` hands to `InterAgentTool`. Both
// providers are optional in the type, so leaving one out compiles, and every
// Claude agent would then answer "wrapper is not connected to a server". This
// composes the real CLI around a stand-in link and calls the tools the way the
// SDK MCP server would, so a missing provider fails here and not only in a unit
// test that builds its own `InterAgentTool`.
import { describe, expect, it, vi } from "vitest";
import type { ToolDescriptor, WrapperConfig } from "@kaoiro/agent-common";
import { runClaudeCli } from "../src/cli.js";
import { buildKaoiroMcpServer, kaoiroToolDescriptors } from "../src/inter_agent_sdk.js";

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
  const link = {
    close: () => {},
    currentSessionId: () => null,
    send: () => {},
    setStatusLine,
    readStatusLine,
  };
  const host = {
    state: "idle",
    statusExtSnapshot: () => ({}),
    statusSnapshot: () => ({ agent_id: config.agent_id, persona: config.persona, state: "idle" as const }),
    run: async () => {},
  };
  let descriptors!: ToolDescriptor[];

  await runClaudeCli({
    parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
    loadConfig: () => ({ ...config }),
    createServerLink: (_url, _agentId, options) => {
      queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
      return link as never;
    },
    createHost: () => host as never,
    buildMcpServer: (actualInterAgent, claudeOnly) => {
      descriptors = kaoiroToolDescriptors(actualInterAgent);
      return buildKaoiroMcpServer(actualInterAgent, claudeOnly);
    },
  });
  return { descriptors, setStatusLine, readStatusLine };
}

describe("Claude CLI status line composition (issue 482)", () => {
  it("offers both tools", async () => {
    const { descriptors } = await compose();

    expect(descriptors.map((d) => d.name)).toEqual(
      expect.arrayContaining(["set_status_line", "read_status_line"]),
    );
  });

  it("set_status_line reaches the link on its first call and returns the stored size", async () => {
    const { descriptors, setStatusLine } = await compose();

    const result = await descriptors.find((d) => d.name === "set_status_line")!.handler!({ text: "hello" });

    expect(setStatusLine).toHaveBeenCalledWith("hello");
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      status_line: { bytes: 5, truncated: false, updated_at: "2026-10-03T12:00:00.000001Z" },
    });
  });

  it("read_status_line reaches the link with the agent id", async () => {
    const { descriptors, readStatusLine } = await compose();

    const result = await descriptors.find((d) => d.name === "read_status_line")!.handler!({ agent_id: "peer.1" });

    expect(readStatusLine).toHaveBeenCalledWith("peer.1");
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      agent_id: "peer.1",
      status_line: { text: "peer text" },
    });
  });
});
