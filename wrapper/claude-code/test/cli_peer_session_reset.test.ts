// issue #677: the Claude CLI registers `request_peer_session_reset` on the
// kaoiro SDK MCP server (behind canUseTool, never in the auto-allow default)
// and hands a result nobody waited for to the model as a root input.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { WrapperConfig } from "@kaoiro/agent-common";
import { REQUEST_PEER_SESSION_RESET_TOOL_FQN } from "@kaoiro/agent-common";
import { runClaudeCli } from "../src/cli.js";
import { NATIVE_CONTINUATIONS_ENV } from "../src/native_continuations_setting.js";
import { READ_ONLY_TOOLS } from "../src/read_only_tools.js";

beforeEach(() => { vi.stubEnv(NATIVE_CONTINUATIONS_ENV, "0"); });
afterEach(() => { vi.unstubAllEnvs(); });

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

async function compose() {
  const sends: string[] = [];
  const requests: { request: unknown; options: unknown }[] = [];
  let linkOptions!: Record<string, any>;
  let hostOptions!: Record<string, any>;
  const link = {
    close: () => {},
    send: () => {},
    currentSessionId: () => null,
    setSessionId: () => {},
    requestPeerSessionReset: async (request: unknown, options: unknown) => {
      requests.push({ request, options });
      return { outcome: "accepted", requestId: "rs-1" };
    },
  };
  const host = {
    state: "idle",
    statusExtSnapshot: () => ({}),
    run: async () => {},
    close: () => {},
    probeRateLimits: async () => {},
    send: async (text: string) => { sends.push(text); },
    activeInterAgentTurnToken: () => "turn-1",
    toolOrigins: { resolveBound: () => undefined },
    pendingReceiptRootTimeoutMs: 0,
    urgentOvertakeLimit: 0,
    foldsPerTurn: 0,
  };
  await runClaudeCli({
    parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
    loadConfig: () => ({ ...config }),
    createServerLink: (_url, _agentId, options) => {
      linkOptions = options as unknown as Record<string, any>;
      queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
      return link as never;
    },
    createHost: (_config, options) => {
      hostOptions = options as unknown as Record<string, any>;
      return host as never;
    },
  });
  return { sends, requests, linkOptions, hostOptions };
}

async function callTool(
  hostOptions: Record<string, any>,
  name: string,
  args: Record<string, unknown>,
) {
  const mcp = hostOptions.queryOptions.mcpServers.kaoiro as McpSdkServerConfigWithInstance;
  type Transport = Parameters<typeof mcp.instance.connect>[0];
  const responses: Array<Record<string, any>> = [];
  const transport: Transport = {
    start: async () => {},
    close: async () => {},
    send: async (message) => { responses.push(message as Record<string, any>); },
  };
  await mcp.instance.connect(transport);
  try {
    transport.onmessage!({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    await vi.waitFor(() => expect(responses).toHaveLength(1));
    return responses[0]!.result as { content: { text: string }[]; isError?: boolean };
  } finally { await mcp.instance.close(); }
}

describe("Claude CLI request_peer_session_reset (issue #677)", () => {
  it("is not in the auto-allow default, so the call rides canUseTool", async () => {
    const { hostOptions } = await compose();
    expect(READ_ONLY_TOOLS.has(REQUEST_PEER_SESSION_RESET_TOOL_FQN)).toBe(false);
    // Positive control: the default list is really in force.
    expect(hostOptions.queryOptions.allowedTools).toContain("mcp__kaoiro__whoami");
    expect(hostOptions.queryOptions.allowedTools).not.toContain(REQUEST_PEER_SESSION_RESET_TOOL_FQN);
  });

  it("is registered on the kaoiro MCP server and forwards the grant to the link", async () => {
    const { hostOptions, requests } = await compose();
    const result = await callTool(hostOptions, "request_peer_session_reset", {
      agent_id: "peer.1", mode: "new", work_id: "wrk_1", expected_authority_epoch: 3, wait: false,
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text.split("\n")[0]!)).toMatchObject({
      outcome: "accepted", request_id: "rs-1",
    });
    expect(requests).toEqual([{
      request: { agentId: "peer.1", mode: "new", workId: "wrk_1", expectedAuthorityEpoch: 3 },
      options: { wait: false },
    }]);
  });

  it("hands a result nobody waited for to the model as a root input", async () => {
    const { linkOptions, sends } = await compose();
    linkOptions.onPeerSessionResetResult({
      requestId: "rs-1", agentId: "peer.1", mode: "new", workId: "wrk_1",
      ok: true, toSessionId: "sess-2",
    });
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toContain("Peer session reset completed: ");
    expect(sends[0]).toContain("\"work_id\":\"wrk_1\"");
  });
});
