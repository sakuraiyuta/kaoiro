import { describe, expect, it, vi } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { runClaudeCli } from "../src/cli.js";
import { AgentHost } from "../src/host.js";
import type { McpSdkServerConfigWithInstance, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "momo", name: "Momo", sprite_set: "momo" },
  display_name: "Momo",
  server_url: "ws://localhost:4000/wrapper",
};

function inbound(deliverySeq: number, agentId: string, cid: string, turn: number, body: string): Envelope {
  return {
    version: "0", agent_id: agentId,
    persona: { id: agentId, name: agentId, sprite_set: agentId },
    display_name: agentId, ts: "2026-09-30T00:00:00Z", type: "inter_agent_message", state: "tool_running",
    payload: { to: config.agent_id, conversation_id: cid, turn_number: turn, kind: "inform", body,
      ...(agentId === "server" ? { meta: { done: false, propose_next: "" } } : {}) },
    delivery_seq: deliverySeq,
  } as unknown as Envelope;
}

describe("issue #460 Claude server status handoff", () => {
  it("does not reply to a failed server status turn and settles its early peer fold once", async () => {
    vi.stubEnv("KAOIRO_CLAUDE_PHASE2_DELIVERY", "1");
    const acknowledgements: number[] = [];
    const outbound: Envelope[] = [];
    const peerInputs: Array<{ token: string; cids: readonly string[] }> = [];
    let linkOptions!: Record<string, any>;
    let host!: AgentHost;
    let rootReady!: () => void;
    let foldReady!: () => void;
    let failTurn!: () => void;
    const rootReadyPromise = new Promise<void>(resolve => { rootReady = resolve; });
    const foldReadyPromise = new Promise<void>(resolve => { foldReady = resolve; });
    const failTurnPromise = new Promise<void>(resolve => { failTurn = resolve; });
    let resultIndex = 0;
    const running = runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      createServerLink: (_url, _agentId, options) => {
        linkOptions = options as unknown as Record<string, any>;
        queueMicrotask(() => { linkOptions.onReplyBasisMode("v1"); linkOptions.onPersonaPrompt("system prompt"); });
        return {
          deliveryModes: () => ({ early: "fold", yield: "tool_boundary", stage_reports: true }),
          deliveryIncarnation: () => "inc", deliveryGeneration: () => "gen",
          reportDeliveryStage: () => {},
          acknowledgeInterAgentDelivery: (seq: number) => acknowledgements.push(seq),
          retireInterAgentDeliveries: () => true, flushInterAgentRetirements: async () => {},
          sendInterAgent: async (envelope: Envelope) => { outbound.push(envelope); return { kind: "accepted", stamp: null }; },
          send: () => {}, close: () => {}, currentSessionId: () => null,
          setSessionId: () => {}, reportDisconnectIntent: async () => true,
        } as never;
      },
      createHost: (cfg, options) => {
        host = new AgentHost(cfg, {
          ...options,
          queryFn: (({ prompt, options: sdkOptions }: { prompt: AsyncIterable<SDKUserMessage>; options: any }) => {
            const stream = (async function* (): AsyncGenerator<SDKMessage> {
              const input = prompt[Symbol.asyncIterator]();
              const signal = { signal: new AbortController().signal };
              const root = (await input.next()).value!;
              await sdkOptions.hooks.UserPromptSubmit.at(-1).hooks[0]({
                hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "server-root", prompt: root.message.content as string,
              }, undefined, signal);
              yield { type: "system", subtype: "init", session_id: "s" } as SDKMessage;
              rootReady();
              const folded = (await input.next()).value!;
              await sdkOptions.hooks.UserPromptSubmit.at(-1).hooks[0]({
                hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "server-root", prompt: folded.message.content as string,
              }, undefined, signal);
              foldReady();
              await failTurnPromise;
              yield { type: "result", result_index: resultIndex++, subtype: "error_during_execution", is_error: true,
                session_id: "s", errors: ["server status turn failed"] } as SDKMessage;
            })();
            return Object.assign(stream, { interrupt: async () => {}, supportedModels: async () => [] }) as unknown as Query;
          }) as never,
        });
        const send = host.send.bind(host);
        host.send = async (...args) => {
          if (args[4]?.source === "peer") peerInputs.push({ token: args[3]!, cids: args[2] ?? [] });
          return send(...args);
        };
        host.probeRateLimits = async () => {};
        return host;
      },
    });
    try {
      await vi.waitFor(() => expect(host).toBeDefined());
      linkOptions.onInterAgentDeliveryStatus({ acked_seq: 0 });
      await linkOptions.onInterAgentMessage(inbound(1, "server", "server-status", 0, "peer reconnected"));
      await rootReadyPromise;

      const earlyPeer = inbound(2, "peer.agent", "peer-fold", 1, "peer work");
      earlyPeer.payload.delivery_authority = { requested: "early", granted: "early" };
      await linkOptions.onInterAgentMessage(earlyPeer);
      await foldReadyPromise;

      await linkOptions.onInterAgentMessage(inbound(3, "server", "server-next", 0, "another status"));
      failTurn();

      await vi.waitFor(() => expect(outbound.filter(envelope => envelope.payload.notice_type === "turn_failure")).toHaveLength(1));
      expect(outbound.filter(envelope => envelope.payload.to === "server")).toHaveLength(0);
      expect(outbound.filter(envelope => envelope.payload.to === "peer.agent").map(envelope => envelope.payload.conversation_id)).toEqual(["peer-fold"]);
      expect(acknowledgements).toEqual([1, 2]);
      await vi.waitFor(() => expect(peerInputs).toHaveLength(3));
      expect(peerInputs.map(input => input.cids).flat()).toEqual(expect.arrayContaining(["server-status", "peer-fold", "server-next"]));
      expect(new Set(peerInputs.map(input => input.token)).size).toBe(3);
      // These are actual coordinator-to-host inputs, with a distinct token
      // for the root, its folded peer input, and the queued server notice.
      expect(peerInputs).toHaveLength(3);
    } finally {
      failTurn();
      host?.close();
      await running;
      vi.unstubAllEnvs();
    }
  });

  it("delivers a matching turn normally after an empty stale-basis recovery", async () => {
    vi.stubEnv("KAOIRO_CLAUDE_PHASE2_DELIVERY", "1");
    const acknowledgements: number[] = [];
    const prompts: string[] = [];
    let linkOptions!: Record<string, any>;
    let host!: AgentHost;
    let firstReady!: () => void;
    let secondReady!: () => void;
    const firstReadyPromise = new Promise<void>(resolve => { firstReady = resolve; });
    const secondReadyPromise = new Promise<void>(resolve => { secondReady = resolve; });
    let recoveryResult: Record<string, any> | undefined;
    let resultIndex = 0;
    const running = runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      createServerLink: (_url, _agentId, options) => {
        linkOptions = options as unknown as Record<string, any>;
        queueMicrotask(() => { linkOptions.onReplyBasisMode("v1"); linkOptions.onPersonaPrompt("system prompt"); });
        return {
          deliveryModes: () => ({ early: "none", yield: "tool_boundary", stage_reports: true }),
          deliveryIncarnation: () => "inc", deliveryGeneration: () => "gen",
          reportDeliveryStage: () => {},
          acknowledgeInterAgentDelivery: (seq: number) => acknowledgements.push(seq),
          retireInterAgentDeliveries: () => true, flushInterAgentRetirements: async () => {},
          sendInterAgent: async () => ({ kind: "rejected", reason: "stale_reply_basis", details: { expected_peer_turn: 2 } }),
          send: () => {}, close: () => {}, currentSessionId: () => null,
          setSessionId: () => {}, reportDisconnectIntent: async () => true,
        } as never;
      },
      createHost: (cfg, options) => {
        host = new AgentHost(cfg, {
          ...options,
          queryFn: (({ prompt, options: sdkOptions }: { prompt: AsyncIterable<SDKUserMessage>; options: any }) => {
            const stream = (async function* (): AsyncGenerator<SDKMessage> {
              const input = prompt[Symbol.asyncIterator]();
              const signal = { signal: new AbortController().signal };
              const root = (await input.next()).value!;
              const text = root.message.content as string;
              prompts.push(text);
              await sdkOptions.hooks.UserPromptSubmit.at(-1).hooks[0]({
                hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "p1", prompt: text,
              }, undefined, signal);
              yield { type: "system", subtype: "init", session_id: "s" } as SDKMessage;
              firstReady();
              const mcp = sdkOptions.mcpServers.kaoiro as McpSdkServerConfigWithInstance;
              type Transport = Parameters<typeof mcp.instance.connect>[0];
              const responses: Array<Record<string, any>> = [];
              const transport: Transport = { start: async () => {}, close: async () => {}, send: async message => { responses.push(message as Record<string, any>); } };
              await mcp.instance.connect(transport);
              try {
                const toolUseId = "empty-recovery-reply";
                await sdkOptions.hooks.PreToolUse.at(-1).hooks[0]({
                  hook_event_name: "PreToolUse", session_id: "s", prompt_id: "p1",
                  tool_name: "mcp__kaoiro__send_to_agent", tool_use_id: toolUseId,
                }, toolUseId, signal);
                transport.onmessage!({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
                  name: "send_to_agent", arguments: { to: "peer.agent", conversation_id: "later-input", kind: "response", body: "stale send" },
                  _meta: { "claudecode/toolUseId": toolUseId },
                } });
                await vi.waitFor(() => expect(responses).toHaveLength(1));
                recoveryResult = JSON.parse(responses[0]!.result.content[0].text) as Record<string, any>;
                await linkOptions.onInterAgentMessage(inbound(2, "peer.agent", "later-input", 2, "later confirmed input"));
              } finally { await mcp.instance.close(); }
              yield { type: "result", result_index: resultIndex++, subtype: "success", session_id: "s", result: "first turn done" } as SDKMessage;
              const later = (await input.next()).value!;
              const laterText = later.message.content as string;
              prompts.push(laterText);
              await sdkOptions.hooks.UserPromptSubmit.at(-1).hooks[0]({
                hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "p2", prompt: laterText,
              }, undefined, signal);
              secondReady();
              yield { type: "result", result_index: resultIndex++, subtype: "success", session_id: "s", result: "second turn done" } as SDKMessage;
            })();
            return Object.assign(stream, { interrupt: async () => {}, supportedModels: async () => [] }) as unknown as Query;
          }) as never,
        });
        host.probeRateLimits = async () => {};
        return host;
      },
    });
    try {
      await vi.waitFor(() => expect(host).toBeDefined());
      linkOptions.onInterAgentDeliveryStatus({ acked_seq: 0 });
      await linkOptions.onInterAgentMessage(inbound(1, "peer.agent", "later-input", 1, "first confirmed input"));
      await firstReadyPromise;
      await secondReadyPromise;
      expect(recoveryResult).toMatchObject({ error: "stale_reply_basis", recovery: [] });
      expect(recoveryResult).not.toHaveProperty("awaiting_delivery");
      expect(recoveryResult!.guidance).toContain("does not prove delivery was lost");
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("[from peer.agent] inform: later confirmed input");
      expect(prompts[1]).toContain("turn_number=2");
      expect(acknowledgements).toEqual([1, 2]);
    } finally {
      host?.close();
      await running;
      vi.unstubAllEnvs();
    }
  });
});
