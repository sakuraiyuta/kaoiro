import { expect, it, vi } from "vitest";
import { InterAgentTool, bindToolResultHandoff, ToolOrigins } from "@kaoiro/agent-common";
import type { Envelope } from "@kaoiro/agent-common";
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

it("issues a recovery ticket only through the real SDK MCP result handoff", async () => {
  const inbound = (turn: number): Envelope => ({
    version: "0", agent_id: "peer", persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P",
    ts: "2026-09-30T00:00:00Z", type: "inter_agent_message", state: "thinking",
    payload: { to: "self", conversation_id: "cid", turn_number: turn, kind: "response", body: `input ${turn}` }, ext: {},
  });
  const sendInterAgent = vi.fn(async () => ({ kind: "rejected" as const, reason: "stale_reply_basis" as const }));
  const interAgent = new InterAgentTool({
    config: { agent_id: "self", persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P", server_url: "ws://localhost" },
    getState: () => "thinking", send: () => {}, replyBasisMode: () => "v1",
    claimRecovery: () => ({ envelopes: [inbound(3)], commit: vi.fn(), rollback: vi.fn() }),
    sendInterAgent,
  });
  interAgent.prepareReplyInput("T", [inbound(1)]);interAgent.beginReplyInput("T");
  const sdk = buildKaoiroMcpServer(interAgent, [], async () => ({ token: "T" }));
  type Transport = Parameters<typeof sdk.instance.connect>[0];
  const responses: Array<Record<string, any>> = [];
  const transport: Transport = { start: async () => {}, close: async () => {}, send: async message => { responses.push(message as Record<string, any>); } };
  await sdk.instance.connect(transport);
  const call = async (id: number, in_reply_to?: number) => {
    transport.onmessage!({ jsonrpc: "2.0", id, method: "tools/call", params: {
      name: "send_to_agent", arguments: { to: "peer", conversation_id: "cid", kind: "response", body: "reply", ...(in_reply_to === undefined ? {} : { in_reply_to }) },
      _meta: { "claudecode/toolUseId": `tool-${id}` },
    } });
    await vi.waitFor(() => expect(responses).toHaveLength(id));
    return JSON.parse(responses[id - 1]!.result.content[0].text) as Record<string, any>;
  };
  try {
    const recovery = await call(1);
    expect(recovery.reply_authorization.in_reply_to).toBe(3);
    const matching = await call(2, 3);
    expect(matching).toEqual({ error: "reply_ticket_required", send_not_attempted: true,
      guidance: "Copy both fields from the original reply_authorization; an unspent, unexpired ticket can be retried." });
    const different = await call(3, 1);
    expect(different).toEqual({ error: "reply_ticket_required", send_not_attempted: true,
      guidance: "A usable reply_authorization exists for a different in_reply_to. Do not use it or omit both fields. Wait for a new confirmed input or a handed-off reply_authorization matching in_reply_to=1." });
    expect(sendInterAgent).toHaveBeenCalledTimes(1);
  } finally { await sdk.instance.close();interAgent.endReplyInput("T"); }
});
