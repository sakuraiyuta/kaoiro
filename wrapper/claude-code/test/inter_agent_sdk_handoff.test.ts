import { expect, it, vi } from "vitest";
import { InterAgentTool, bindToolResultHandoff, ToolOrigins } from "@kaoiro/agent-common";
import { buildKaoiroMcpServer } from "../src/inter_agent_sdk.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

it.each(["return", "cancel", "retire", "serialization"] as const)("real SDK MCP %s boundary commits or returns result ownership once", async mode => {
  const origins = new ToolOrigins(); origins.begin("T"); origins.observe("tool_T");
  const interAgent = new InterAgentTool({ config: { agent_id: "self", persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P", server_url: "ws://localhost" }, getState: () => "thinking", send: () => {} });
  const entered = deferred(), release = deferred();
  const commit = vi.fn(), rollback = vi.fn();
  const descriptors = interAgent.descriptors();
  const send = descriptors.find(d => d.name === "send_to_agent")!;
  send.handler = async (_args, context) => {
    expect(context?.origin?.token).toBe("T");
    const result = bindToolResultHandoff({ content: [{ type: "text", text: "recovery body" }] }, {
      live: () => !context?.origin?.signal?.aborted,
      commit, rollback,
    });
    if (mode === "serialization") Object.defineProperty(result, "toJSON", { value: () => { throw Error("serialization failure"); } });
    entered.resolve(); await release.promise; return result;
  };
  vi.spyOn(interAgent, "descriptors").mockReturnValue(descriptors);
  const sdk = buildKaoiroMcpServer(interAgent, [], id => origins.resolve(id));
  type Transport = Parameters<typeof sdk.instance.connect>[0];
  const responses: unknown[] = [];
  const transport: Transport = { start: async () => {}, close: async () => {}, send: async message => { responses.push(message); } };
  await sdk.instance.connect(transport);
  try {
    transport.onmessage!({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "send_to_agent", arguments: { to: "peer", conversation_id: "cid", kind: "response", body: "reply" },
      _meta: { "claudecode/toolUseId": "tool_T" },
    } });
    await entered.promise; expect(commit).not.toHaveBeenCalled(); expect(rollback).not.toHaveBeenCalled();
    if (mode === "cancel") transport.onmessage!({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1, reason: "test" } });
    if (mode === "retire") origins.retire();
    release.resolve();
    if (mode === "return") {
      await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
      expect(rollback).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(JSON.stringify(responses)).toContain("recovery body"));
    } else {
      await vi.waitFor(() => expect(rollback).toHaveBeenCalledTimes(1));
      expect(commit).not.toHaveBeenCalled();
      expect(JSON.stringify(responses)).not.toContain("recovery body");
    }
  } finally { release.resolve(); await sdk.instance.close(); vi.restoreAllMocks(); }
});
