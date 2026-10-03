import { describe, expect, it, vi } from "vitest";
import {
  INTER_AGENT_TOOL_FQN,
  InterAgentTool,
  LIST_AGENTS_TOOL_FQN,
  READ_STATUS_LINE_TOOL_FQN,
  SET_STATUS_LINE_TOOL_FQN,
  WHOAMI_TOOL_FQN,
  type InterAgentToolOptions,
} from "@kaoiro/agent-common";
import { buildKaoiroMcpServer, kaoiroToolDescriptors } from "../src/inter_agent_sdk.js";
import { READ_ONLY_TOOLS } from "../src/read_only_tools.js";

const config = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost",
};

function interAgent(options: Partial<InterAgentToolOptions> = {}): InterAgentTool {
  return new InterAgentTool({ config, getState: () => "idle", send: () => {}, ...options });
}

/** Drives the real SDK MCP server over an in-memory transport. */
async function rpc(tool: InterAgentTool, method: string, params: Record<string, unknown>): Promise<Record<string, any>> {
  const sdk = buildKaoiroMcpServer(tool);
  type Transport = Parameters<typeof sdk.instance.connect>[0];
  const responses: Array<Record<string, any>> = [];
  const transport: Transport = {
    start: async () => {},
    close: async () => {},
    send: async (message) => {
      responses.push(message as Record<string, any>);
    },
  };
  await sdk.instance.connect(transport);
  try {
    transport.onmessage!({ jsonrpc: "2.0", id: 1, method, params });
    await vi.waitFor(() => expect(responses.length).toBeGreaterThan(0));
    return responses[0]!;
  } finally {
    await sdk.instance.close();
  }
}

describe("the status line tools on Claude", () => {
  it("are part of the tool set, in registration order, before any Claude-only tool", () => {
    expect(kaoiroToolDescriptors(interAgent()).map((d) => d.name)).toEqual([
      "send_to_agent",
      "list_agents",
      "whoami",
      "set_status_line",
      "read_status_line",
    ]);
  });

  it("refuse to compose when either one is missing from the common descriptors", () => {
    const full = interAgent().descriptors();

    for (const missing of ["set_status_line", "read_status_line"]) {
      const partial = { descriptors: () => full.filter((d) => d.name !== missing) } as unknown as InterAgentTool;

      expect(() => kaoiroToolDescriptors(partial)).toThrow(/missing a required tool/);
    }
  });

  it("are registered with the real SDK MCP server", async () => {
    const response = await rpc(interAgent(), "tools/list", {});

    const tools = response.result.tools as Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
    expect(tools.map((t) => t.name)).toEqual([
      "send_to_agent",
      "list_agents",
      "whoami",
      "set_status_line",
      "read_status_line",
    ]);
    expect(Object.keys(tools.find((t) => t.name === "set_status_line")!.inputSchema.properties)).toEqual(["text"]);
    expect(Object.keys(tools.find((t) => t.name === "read_status_line")!.inputSchema.properties)).toEqual(["agent_id"]);
  });

  it("reach the provider through the real SDK server and return its result", async () => {
    const setStatusLine = vi.fn(async () => ({
      kind: "ok" as const,
      status_line: { bytes: 5, truncated: false, updated_at: "t" },
    }));
    const readStatusLine = vi.fn(async (agentId: string) => ({
      kind: "ok" as const,
      agent_id: agentId,
      status_line: { text: "peer text", bytes: 9, updated_at: "t" },
    }));
    const tool = interAgent({ setStatusLine, readStatusLine });

    const set = await rpc(tool, "tools/call", { name: "set_status_line", arguments: { text: "hello" } });
    const read = await rpc(tool, "tools/call", { name: "read_status_line", arguments: { agent_id: "peer.1" } });

    expect(setStatusLine).toHaveBeenCalledWith("hello");
    expect(JSON.parse(set.result.content[0].text)).toEqual({
      status_line: { bytes: 5, truncated: false, updated_at: "t" },
    });
    expect(readStatusLine).toHaveBeenCalledWith("peer.1");
    expect(JSON.parse(read.result.content[0].text)).toEqual({
      agent_id: "peer.1",
      status_line: { text: "peer text", bytes: 9, updated_at: "t" },
    });
  });

  it("report a refusal as an error result over the real SDK server", async () => {
    const tool = interAgent({
      setStatusLine: async () => ({ kind: "error", reason: "status_line_too_large", max_bytes: 16384, bytes: 20000 }),
    });

    const response = await rpc(tool, "tools/call", { name: "set_status_line", arguments: { text: "x" } });

    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toMatch(/20000 bytes/);
  });
});

describe("the auto-allow default", () => {
  it("includes the two status line tools next to the other read-only ones", () => {
    expect(READ_ONLY_TOOLS.has(SET_STATUS_LINE_TOOL_FQN)).toBe(true);
    expect(READ_ONLY_TOOLS.has(READ_STATUS_LINE_TOOL_FQN)).toBe(true);
    expect(READ_ONLY_TOOLS.has(LIST_AGENTS_TOOL_FQN)).toBe(true);
    expect(READ_ONLY_TOOLS.has(WHOAMI_TOOL_FQN)).toBe(true);
  });

  it("still leaves the approval-gated send out", () => {
    expect(READ_ONLY_TOOLS.has(INTER_AGENT_TOOL_FQN)).toBe(false);
  });
});
