import { describe, expect, it, vi } from "vitest";
import { formatInboundMessage, handoffToolResult, INTER_AGENT_TOOL_FQN, MAX_COALESCED_BYTES } from "@kaoiro/agent-common";
import type { Envelope, InterAgentTool, WrapperConfig } from "@kaoiro/agent-common";
import { runClaudeCli } from "../src/cli.js";
import { AgentHost, type AgentHostOptions } from "../src/host.js";
import type { McpSdkServerConfigWithInstance, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { phoenixLoopback } from "./fixtures/phoenix_loopback.js";

// Native results carry a run-wide delivery sequence; a live interval only
// accepts a result whose index advanced.
let resultIndexCounter = 0;
const nextResultIndex = (): number => resultIndexCounter++;

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

function inboundEnvelope(deliverySeq: number, turnNumber = 1): Envelope {
  return {
    version: "0",
    agent_id: "peer.agent",
    persona: { id: "peer", name: "Peer", sprite_set: "peer" },
    display_name: "Peer",
    ts: "2026-08-17T00:00:00Z",
    type: "inter_agent_message",
    state: "tool_running",
    payload: {
      to: config.agent_id,
      conversation_id: `c-${deliverySeq}`,
      turn_number: turnNumber,
      kind: "inform",
      body: "hello",
    },
    delivery_seq: deliverySeq,
  } as unknown as Envelope;
}

describe("Claude CLI delivery composition (issue #247)", () => {
  it.each(["flag off", "no mode echo"] as const)("keeps legacy peer root scheduling when %s", async scenario => {
    if (scenario === "no mode echo") vi.stubEnv("KAOIRO_CLAUDE_PHASE2_DELIVERY", "1");
    else vi.stubEnv("KAOIRO_CLAUDE_PHASE2_DELIVERY", "0");
    let linkOptions!: Record<string, any>;
    let hostOptions!: AgentHostOptions;
    const sends: Array<{ urgent?: boolean }> = [];
    let start!: () => void;
    let finish!: () => void;
    const ready = new Promise<void>(resolve => { start = resolve; });
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const running = runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      createServerLink: (_url, _id, options) => {
        linkOptions = options as unknown as Record<string, any>;
        queueMicrotask(() => { linkOptions.onReplyBasisMode("v1"); linkOptions.onPersonaPrompt("system prompt"); });
        return {
          deliveryModes: () => scenario === "no mode echo" ? undefined : { early: "none", yield: "none", stage_reports: true },
          acknowledgeInterAgentDelivery: () => {}, retireInterAgentDeliveries: () => true,
          sendInterAgent: async () => ({ kind: "accepted", stamp: null }),
          send: () => {}, close: () => {}, currentSessionId: () => null, setSessionId: () => {},
          reportDisconnectIntent: async () => true,
        } as never;
      },
      createHost: (_cfg, options) => {
        hostOptions = options;
        return {
          state: "idle", statusExtSnapshot: () => ({}),
          run: async () => { start(); await finished; },
          send: async (_text: string, _attachments: unknown, _cids: readonly string[], _token: string, policy?: { urgent?: boolean }) => {
            sends.push({ urgent: policy?.urgent ?? false });
          },
          close: () => {},
        } as never;
      },
    });
    try {
      await ready;
      expect(hostOptions.phase2RootScheduling?.()).toBe(false);
      const inbound = inboundEnvelope(90);
      inbound.payload.delivery_authority = { requested: "early", granted: "early" };
      await linkOptions.onInterAgentMessage(inbound);
      await vi.waitFor(() => expect(sends).toHaveLength(1));
      expect(sends[0]?.urgent).toBe(false);
    } finally { finish(); await running; vi.unstubAllEnvs(); }
  });

  it.each(["success", "error"] as const)("folds a granted early delivery from the same peer while its work turn is live (%s)", async outcome => {
    vi.stubEnv("KAOIRO_CLAUDE_PHASE2_DELIVERY", "1");
    const stages: Array<Record<string, unknown>> = [];
    const acknowledged: number[] = [];
    const pushedInputs: string[] = [];
    const notices: Envelope[] = [];
    const foldedGuidance: string[] = [];
    const foldedOutboundCounts: number[] = [];
    let linkOptions!: Record<string, any>;
    let host!: AgentHost;
    let ready!: () => void;
    const rootReady = new Promise<void>(resolve => { ready = resolve; });
    const running = runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      createServerLink: (_url, _agentId, options) => {
        linkOptions = options as unknown as Record<string, any>;
        queueMicrotask(() => { linkOptions.onReplyBasisMode("v1"); linkOptions.onPersonaPrompt("system prompt"); });
        return {
          deliveryModes: () => ({ early: "fold", yield: "tool_boundary", stage_reports: true }),
          deliveryIncarnation: () => "inc",
          deliveryGeneration: () => "gen",
          reportDeliveryStage: (stage: Record<string, unknown>) => stages.push(stage),
          acknowledgeInterAgentDelivery: (seq: number) => acknowledged.push(seq),
          retireInterAgentDeliveries: () => true,
          flushInterAgentRetirements: async () => {},
          sendInterAgent: async (envelope: Envelope) => { notices.push(envelope); return { kind: "accepted", stamp: null }; },
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
              const rootText = root.message.content as string;
              await sdkOptions.hooks.UserPromptSubmit.at(-1).hooks[0]({
                hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "p1", prompt: rootText,
              }, undefined, signal);
              yield { type: "system", subtype: "init", session_id: "s" } as SDKMessage;
              ready();
              const fold = (await input.next()).value!;
              const foldText = fold.message.content as string;
              pushedInputs.push(foldText);
              await sdkOptions.hooks.UserPromptSubmit.at(-1).hooks[0]({
                hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "p1", prompt: foldText,
              }, undefined, signal);
              const authorizationLine = foldText.split("\n").find(line => line.startsWith("reply_authorization: "))!;
              const authorization = JSON.parse(authorizationLine.slice("reply_authorization: ".length)) as { in_reply_to: number };
              const mcp = sdkOptions.mcpServers.kaoiro as McpSdkServerConfigWithInstance;
              type Transport = Parameters<typeof mcp.instance.connect>[0];
              const responses: Array<Record<string, any>> = [];
              const transport: Transport = { start: async () => {}, close: async () => {}, send: async message => { responses.push(message as Record<string, any>); } };
              await mcp.instance.connect(transport);
              try {
                const toolUseId = "folded-reply";
                await sdkOptions.hooks.PreToolUse.at(-1).hooks[0]({
                  hook_event_name: "PreToolUse", session_id: "s", prompt_id: "p1", tool_name: INTER_AGENT_TOOL_FQN, tool_use_id: toolUseId,
                }, toolUseId, signal);
                transport.onmessage!({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
                  name: "send_to_agent", arguments: { to: "peer.agent", conversation_id: "c-2", kind: "response", body: "reply", in_reply_to: authorization.in_reply_to },
                  _meta: { "claudecode/toolUseId": toolUseId },
                } });
                await vi.waitFor(() => expect(responses).toHaveLength(1));
                foldedGuidance.push(JSON.parse(responses[0]!.result.content[0].text).guidance as string);
                foldedOutboundCounts.push(notices.filter(envelope => envelope.payload.conversation_id === "c-2").length);
              } finally { await mcp.instance.close(); }
              yield outcome === "error"
                ? { type: "result", result_index: nextResultIndex(), subtype: "error_during_execution", is_error: true, session_id: "s", errors: ["failed"] } as SDKMessage
                : { type: "result", result_index: nextResultIndex(), subtype: "success", session_id: "s", result: "done" } as SDKMessage;
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
      await linkOptions.onInterAgentMessage(inboundEnvelope(1));
      await rootReady;
      const inbound = inboundEnvelope(2);
      inbound.payload.delivery_authority = { requested: "early", granted: "early" };
      await linkOptions.onInterAgentMessage(inbound);
      await running;
      expect(pushedInputs).toHaveLength(1);
      expect(pushedInputs[0]).toContain("Mid-turn peer delivery");
      expect(stages).toContainEqual(expect.objectContaining({ stage: "submitted", handoff: "fold_hook" }));
      expect(acknowledged).toEqual([1, 2]);
      expect(foldedGuidance).toEqual(["Copy both fields from the original reply_authorization; an unspent, unexpired ticket can be retried."]);
      expect(foldedOutboundCounts).toEqual([0]);
      if (outcome === "error") {
        await vi.waitFor(() => expect(notices.filter(envelope => envelope.payload.conversation_id === "c-2")).toHaveLength(1));
        expect(notices.find(envelope => envelope.payload.conversation_id === "c-2")?.payload.notice_type).toBe("turn_failure");
      }
    } finally { host?.close(); await running; vi.unstubAllEnvs(); }
  });

  it("keeps an oversized early batch queued for a root without activating fold tickets", async () => {
    vi.stubEnv("KAOIRO_CLAUDE_PHASE2_DELIVERY", "1");
    let linkOptions!: Record<string, any>;
    let host!: AgentHost;
    let ready!: () => void;
    let release!: () => void;
    const firstReady = new Promise<void>(resolve => { ready = resolve; });
    const releaseResult = new Promise<void>(resolve => { release = resolve; });
    const rootTexts: string[] = [];
    const stages: Array<Record<string, unknown>> = [];
    const running = runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      createServerLink: (_url, _id, options) => {
        linkOptions = options as unknown as Record<string, any>;
        queueMicrotask(() => { linkOptions.onReplyBasisMode("v1"); linkOptions.onPersonaPrompt("system prompt"); });
        return {
          deliveryModes: () => ({ early: "fold", yield: "tool_boundary", stage_reports: true }),
          deliveryIncarnation: () => "inc", deliveryGeneration: () => "gen",
          reportDeliveryStage: (stage: Record<string, unknown>) => stages.push(stage),
          acknowledgeInterAgentDelivery: () => {}, retireInterAgentDeliveries: () => true,
          sendInterAgent: async () => ({ kind: "accepted", stamp: null }),
          send: () => {}, close: () => {}, currentSessionId: () => null, setSessionId: () => {},
          reportDisconnectIntent: async () => true,
        } as never;
      },
      createHost: (cfg, options) => {
        host = new AgentHost(cfg, {
          ...options,
          queryFn: (({ prompt, options: sdkOptions }: { prompt: AsyncIterable<SDKUserMessage>; options: any }) =>
            Object.assign((async function* (): AsyncGenerator<SDKMessage> {
              const input = prompt[Symbol.asyncIterator]();
              const signal = { signal: new AbortController().signal };
              const first = (await input.next()).value!;
              await sdkOptions.hooks.UserPromptSubmit.at(-1).hooks[0]({
                hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "p1", prompt: first.message.content,
              }, undefined, signal);
              yield { type: "system", subtype: "init", session_id: "s" } as SDKMessage;
              ready();
              await releaseResult;
              yield { type: "result", result_index: nextResultIndex(), subtype: "success", session_id: "s", result: "T done" } as SDKMessage;
              const root = (await input.next()).value!;
              rootTexts.push(root.message.content as string);
              await sdkOptions.hooks.UserPromptSubmit.at(-1).hooks[0]({
                hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "p2", prompt: root.message.content,
              }, undefined, signal);
              yield { type: "result", result_index: nextResultIndex(), subtype: "success", session_id: "s", result: "R done" } as SDKMessage;
            })(), { interrupt: async () => {}, supportedModels: async () => [] }) as unknown as Query) as never,
        });
        host.probeRateLimits = async () => {};
        return host;
      },
    });
    try {
      await vi.waitFor(() => expect(host).toBeDefined());
      linkOptions.onInterAgentDeliveryStatus({ acked_seq: 0 });
      await linkOptions.onInterAgentMessage(inboundEnvelope(1));
      await firstReady;
      const oversized = inboundEnvelope(2);
      oversized.payload.body = "α".repeat(10_000);
      oversized.payload.delivery_authority = { requested: "early", granted: "early" };
      await linkOptions.onInterAgentMessage(oversized);
      release();
      await running;
      expect(rootTexts).toHaveLength(1);
      expect(rootTexts[0]).toContain("α".repeat(10_000));
      expect(rootTexts[0]).not.toContain("fold_id:");
      expect(stages).toContainEqual(expect.objectContaining({ delivery_seq: 2, stage: "submitted", handoff: "prompt_hook" }));
      expect(stages).not.toContainEqual(expect.objectContaining({ delivery_seq: 2, handoff: "fold_hook" }));
    } finally { release(); host?.close(); await running; vi.unstubAllEnvs(); }
  });

  it("hands off an oversized recovery candidate through the Claude fold hook", async () => {
    vi.stubEnv("KAOIRO_CLAUDE_PHASE2_DELIVERY", "1");
    let linkOptions!: Record<string, any>;
    let host!: AgentHost;
    let ready!: () => void;
    const rootReady = new Promise<void>(resolve => { ready = resolve; });
    const oversizedBody = "x".repeat(15_700);
    const stages: Array<Record<string, unknown>> = [];
    const acknowledged: number[] = [];
    const rootTexts: string[] = [];
    const foldTexts: string[] = [];
    const running = runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      createServerLink: (_url, _agentId, options) => {
        linkOptions = options as unknown as Record<string, any>;
        queueMicrotask(() => { linkOptions.onReplyBasisMode("v1"); linkOptions.onPersonaPrompt("system prompt"); });
        return {
          deliveryModes: () => ({ early: "fold", yield: "tool_boundary", stage_reports: true }),
          deliveryIncarnation: () => "inc", deliveryGeneration: () => "gen",
          reportDeliveryStage: (stage: Record<string, unknown>) => stages.push(stage),
          acknowledgeInterAgentDelivery: (seq: number) => acknowledged.push(seq),
          retireInterAgentDeliveries: () => true,
          flushInterAgentRetirements: async () => {},
          sendInterAgent: async () => ({ kind: "accepted", stamp: null }),
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
              const rootText = root.message.content as string;
              rootTexts.push(rootText);
              await sdkOptions.hooks.UserPromptSubmit.at(-1).hooks[0]({
                hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "p1", prompt: rootText,
              }, undefined, signal);
              yield { type: "system", subtype: "init", session_id: "s" } as SDKMessage;
              ready();
              const fold = (await input.next()).value!;
              const foldText = fold.message.content as string;
              foldTexts.push(foldText);
              await sdkOptions.hooks.UserPromptSubmit.at(-1).hooks[0]({
                hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "p1", prompt: foldText,
              }, undefined, signal);
              yield { type: "result", result_index: nextResultIndex(), subtype: "success", session_id: "s", result: "done" } as SDKMessage;
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
      const root = inboundEnvelope(1);
      root.payload.conversation_id = "same-cid";
      await linkOptions.onInterAgentMessage(root);
      await rootReady;
      const oversized = inboundEnvelope(2, 2);
      oversized.payload.conversation_id = "same-cid";
      oversized.payload.body = oversizedBody;
      oversized.payload.delivery_authority = { requested: "early", granted: "early" };
      await linkOptions.onInterAgentMessage(oversized);
      await running;
      expect(rootTexts[0]).not.toContain("reply_authorization:");
      expect(foldTexts).toHaveLength(1);
      expect(foldTexts[0]).toContain(oversizedBody);
      const authorizationLine = foldTexts[0]!.split("\n").find(line => line.startsWith("reply_authorization: "));
      expect(authorizationLine).toBeDefined();
      const authorization = JSON.parse(authorizationLine!.slice("reply_authorization: ".length)) as { in_reply_to: number; reply_ticket: string };
      expect(authorization.in_reply_to).toBe(2);
      expect(authorization.reply_ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.byteLength(foldTexts[0]!, "utf8")).toBeLessThanOrEqual(MAX_COALESCED_BYTES);
      expect(stages).toContainEqual(expect.objectContaining({ delivery_seq: 2, stage: "submitted", handoff: "fold_hook" }));
      expect(acknowledged).toEqual([1, 2]);
    } finally { host?.close(); await running; vi.unstubAllEnvs(); }
  });

  it("keeps a cut root F active for its peer until F settles before dispatching the next same-CID item", async () => {
    vi.stubEnv("KAOIRO_CLAUDE_PHASE2_DELIVERY", "1");
    const notices: Envelope[] = [];
    const dispatched: string[] = [];
    const stages: Array<Record<string, unknown>> = [];
    let linkOptions!: Record<string, any>;
    let host!: AgentHost;
    let rootReady!: () => void;
    let cutReady!: () => void;
    let finishCut!: () => void;
    const rootStarted = new Promise<void>(resolve => { rootReady = resolve; });
    const cutStarted = new Promise<void>(resolve => { cutReady = resolve; });
    const cutFinished = new Promise<void>(resolve => { finishCut = resolve; });
    const running = runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      createServerLink: (_url, _agentId, options) => {
        linkOptions = options as unknown as Record<string, any>;
        queueMicrotask(() => { linkOptions.onReplyBasisMode("v1"); linkOptions.onPersonaPrompt("system prompt"); });
        return {
          deliveryModes: () => ({ early: "fold", yield: "tool_boundary", stage_reports: true }),
          deliveryIncarnation: () => "inc", deliveryGeneration: () => "gen",
          requestYieldClaim: async () => ({ granted: true }),
          reportDeliveryStage: (stage: Record<string, unknown>) => stages.push(stage),
          acknowledgeInterAgentDelivery: () => {}, retireInterAgentDeliveries: () => true,
          flushInterAgentRetirements: async () => {},
          sendInterAgent: async (envelope: Envelope) => { notices.push(envelope); return { kind: "accepted", stamp: null }; },
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
              const first = (await input.next()).value!;
              await sdkOptions.hooks.UserPromptSubmit.at(-1).hooks[0]({
                hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "p1", prompt: first.message.content as string,
              }, undefined, signal);
              yield { type: "system", subtype: "init", session_id: "s" } as SDKMessage;
              rootReady();
              const cut = (await input.next()).value!;
              expect(cut.priority).toBe("now");
              yield { type: "result", result_index: nextResultIndex(), subtype: "success", session_id: "s", result: "T done" } as SDKMessage;
              await sdkOptions.hooks.UserPromptSubmit.at(-1).hooks[0]({
                hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "p2", prompt: cut.message.content as string,
              }, undefined, signal);
              cutReady();
              await cutFinished;
              yield { type: "result", result_index: nextResultIndex(), subtype: "error_during_execution", is_error: true, session_id: "s", errors: ["F failed"] } as SDKMessage;
              const later = (await input.next()).value!;
              await sdkOptions.hooks.UserPromptSubmit.at(-1).hooks[0]({
                hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "p3", prompt: later.message.content as string,
              }, undefined, signal);
              yield { type: "result", result_index: nextResultIndex(), subtype: "success", session_id: "s", result: "R done" } as SDKMessage;
            })();
            return Object.assign(stream, { interrupt: async () => {}, supportedModels: async () => [] }) as unknown as Query;
          }) as never,
        });
        const send = host.send.bind(host);
        host.send = async (...args) => { if (args[4]?.source === "peer") dispatched.push(args[3]!); return send(...args); };
        host.probeRateLimits = async () => {};
        return host;
      },
    });
    try {
      await vi.waitFor(() => expect(host).toBeDefined());
      linkOptions.onInterAgentDeliveryStatus({ acked_seq: 0 });
      const work = inboundEnvelope(1);
      work.payload.work = { work_id: "W", revision: 1, authority_epoch: 1, state: "active" };
      await linkOptions.onInterAgentMessage(work);
      await rootStarted;
      const yieldMessage = inboundEnvelope(2);
      yieldMessage.payload.delivery_authority = {
        requested: "yield", granted: "yield", work_id: "W", authority_epoch: 1, yield_token: "token",
      };
      await linkOptions.onInterAgentMessage(yieldMessage);
      await cutStarted;
      const later = inboundEnvelope(3, 2);
      later.payload.conversation_id = yieldMessage.payload.conversation_id;
      await linkOptions.onInterAgentMessage(later);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(dispatched).toHaveLength(2); // T and the queued lease; R has not dispatched.
      finishCut();
      await running;
      expect(dispatched).toHaveLength(3);
      expect(notices.filter(envelope => envelope.payload.conversation_id === yieldMessage.payload.conversation_id && envelope.payload.notice_type === "turn_failure")).toHaveLength(1);
      expect(stages).toContainEqual(expect.objectContaining({ stage: "submitted", handoff: "prompt_hook" }));
    } finally { finishCut(); host?.close(); await running; vi.unstubAllEnvs(); }
  });

  it.each([
    { name: "mixed work", eligibility: "mixed_turn", claim: "none", reason: "mixed_turn", cuts: 0 },
    { name: "claim refusal", eligibility: null, claim: "refuse", reason: "yield_interval", cuts: 0 },
    { name: "claim timeout", eligibility: null, claim: "timeout", reason: "claim_timeout", cuts: 0 },
    { name: "eligibility changes during claim", eligibility: null, claim: "changed", reason: "eligibility_changed", cuts: 0 },
    { name: "input context changes during claim", eligibility: null, claim: "context changed", reason: "eligibility_changed", cuts: 0 },
    { name: "rendered input changes during claim", eligibility: null, claim: "render changed", reason: "eligibility_changed", cuts: 0 },
    { name: "receipt deadline", eligibility: null, claim: "chain timeout", reason: "receipt_wait_timeout", cuts: 0 },
    { name: "receipt chain expires", eligibility: null, claim: "chain expires", reason: "receipt_wait_timeout", cuts: 0 },
    { name: "transfer after claim", eligibility: null, claim: "transfer", reason: undefined, cuts: 1 },
    { name: "granted claim waits for prior receipt", eligibility: null, claim: "pending", reason: undefined, cuts: 1 },
  ] as const)("decides yield from the final live input and claim result ($name)", async scenario => {
    vi.stubEnv("KAOIRO_CLAUDE_PHASE2_DELIVERY", "1");
    const dispositions: Array<Record<string, unknown>> = [];
    const pushes: string[] = [];
    const deliveredNotices: string[] = [];
    const queued = new Set<string>();
    let eligibility: string | null = scenario.eligibility;
    let claimCalls = 0;
    let resolveClaim!: (value: unknown) => void;
    const delayedClaim = new Promise<unknown>(resolve => { resolveClaim = resolve; });
    let releaseReceipt!: (value: boolean) => void;
    let receiptPending = scenario.claim === "pending" || scenario.claim === "chain timeout" || scenario.claim === "chain expires";
    let sameContext = true;
    const receiptWaitTimeouts: number[] = [];
    const receiptResolved = new Promise<boolean>(resolve => {
      releaseReceipt = value => { receiptPending = false; resolve(value); };
    });
    let receiptWaitCalls = 0;
    let linkOptions!: Record<string, any>;
    let finishHost!: () => void;
    let started!: () => void;
    const finished = new Promise<void>(resolve => { finishHost = resolve; });
    const ready = new Promise<void>(resolve => { started = resolve; });
    const running = runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config,
        yield_claim_timeout_ms: scenario.claim === "timeout" ? 5 : 2_000,
        pending_receipt_root_timeout_ms: scenario.claim === "chain expires" ? 50 : 2_000,
      }),
      createServerLink: (_url, _agentId, options) => {
        linkOptions = options as unknown as Record<string, any>;
        queueMicrotask(() => { linkOptions.onReplyBasisMode("v1"); linkOptions.onPersonaPrompt("system prompt"); });
        return {
          deliveryModes: () => ({ early: "fold", yield: "tool_boundary", stage_reports: true }),
          deliveryIncarnation: () => "inc", deliveryGeneration: () => "gen",
          requestYieldClaim: async () => {
            claimCalls += 1;
            return scenario.claim === "refuse" ? { granted: false, reason: "yield_interval" } : delayedClaim;
          },
          reportDeliveryStage: (report: Record<string, unknown>) => dispositions.push(report),
          acknowledgeInterAgentDelivery: () => {}, retireInterAgentDeliveries: () => true,
          sendInterAgent: async () => ({ kind: "accepted", stamp: null }),
          send: () => {}, close: () => {}, currentSessionId: () => null,
          reportDisconnectIntent: async () => true,
        } as never;
      },
      createHost: (_cfg, options) => ({
        state: "thinking", statusExtSnapshot: () => ({}),
        run: async () => { started(); await finished; },
        send: async (text: string, _attachments: unknown, _cids: readonly string[], token: string, policy?: { source?: string }) => {
          if (policy?.source === "peer") queued.add(token);
          else if (text.startsWith("Work notice:")) deliveredNotices.push(text);
        },
        activeInterAgentTurnToken: () => "T",
        canPushLiveInput: () => true, canFoldLiveInput: () => false,
        captureLiveInputContext: () => ({}),
        matchesLiveInputContext: () => sameContext,
        hasPendingPushedReceipt: () => receiptPending,
        waitForPushedReceipt: async (_ownerToken: string, timeoutMs: number) => {
          receiptWaitCalls += 1;
          receiptWaitTimeouts.push(timeoutMs);
          if (scenario.claim === "chain timeout") {
            if (receiptWaitCalls === 1) {
              await new Promise(resolve => setTimeout(resolve, 25));
              return true;
            }
            return false;
          }
          if (scenario.claim === "chain expires") {
            await new Promise(resolve => setTimeout(resolve, 12));
            return receiptWaitCalls < 8;
          }
          return scenario.claim === "pending" ? receiptResolved : true;
        },
        yieldEligibility: () => eligibility,
        canReserveYieldOvertake: () => true,
        pushedInputFits: (text: string, count: number) => count <= 10 && Buffer.byteLength(text, "utf8") <= 16_384,
        hasQueuedInput: (token: string) => queued.has(token),
        removeQueuedInput: (token: string) => queued.delete(token),
        pushLiveInput: (input: { kind: string }) => { pushes.push(input.kind); return true; },
      }) as never,
    });
    try {
      await ready;
      linkOptions.onInterAgentDeliveryStatus({ acked_seq: 0 });
      const yieldMessage = inboundEnvelope(1);
      yieldMessage.payload.delivery_authority = {
        requested: "yield", granted: "yield", work_id: "W", authority_epoch: 1, yield_token: "token",
      };
      await linkOptions.onInterAgentMessage(yieldMessage);
      if (scenario.claim === "changed" || scenario.claim === "context changed" || scenario.claim === "render changed" ||
          scenario.claim === "chain timeout" || scenario.claim === "chain expires" ||
          scenario.claim === "transfer" || scenario.claim === "pending") {
        await vi.waitFor(() => expect(claimCalls).toBe(1));
        if (scenario.claim === "changed") eligibility = "mixed_turn";
        else if (scenario.claim === "context changed") sameContext = false;
        else if (scenario.claim === "render changed") yieldMessage.payload.body = "updated while the claim was pending";
        else if (scenario.claim === "transfer") {
          linkOptions.onWorkNotice({ version: "0", work: { work_id: "W" }, op: "transfer" });
          await vi.waitFor(() => expect(deliveredNotices).toHaveLength(1));
        }
        resolveClaim({ granted: true });
        if (scenario.claim === "pending") {
          await vi.waitFor(() => expect(receiptWaitCalls).toBe(1));
          expect(dispositions.some(report => report.yield_disposition !== undefined)).toBe(false);
          releaseReceipt(true);
        }
      }
      await vi.waitFor(() => expect(dispositions.some(report =>
        (report.yield_disposition as { outcome?: string } | undefined)?.outcome === (scenario.cuts ? "cut" : "downgraded"))).toBe(true));
      const last = [...dispositions].reverse().find(report => report.yield_disposition !== undefined)!.yield_disposition as { reason?: string };
      expect(last.reason).toBe(scenario.reason);
      expect(pushes.filter(kind => kind === "cut")).toHaveLength(scenario.cuts);
      expect(claimCalls).toBe(scenario.claim === "none" ? 0 : 1);
      if (scenario.claim === "chain timeout") {
        expect(receiptWaitTimeouts).toHaveLength(2);
        expect(receiptWaitTimeouts[1]!).toBeLessThan(receiptWaitTimeouts[0]! - 15);
      }
      if (scenario.claim === "chain expires") expect(receiptWaitCalls).toBeLessThan(8);
    } finally { releaseReceipt(false); finishHost(); await running; vi.unstubAllEnvs(); }
  });

  it.each([
    { name: "exact limit", targetBytes: 16_384, multibyte: false, allowed: true },
    { name: "one byte over", targetBytes: 16_385, multibyte: false, allowed: false },
    { name: "multibyte over", targetBytes: 16_385, multibyte: true, allowed: false },
  ] as const)("checks the final cut text before consuming its claim ($name)", async scenario => {
    vi.stubEnv("KAOIRO_CLAUDE_PHASE2_DELIVERY", "1");
    const queued = new Set<string>();
    const pushes: string[] = [];
    const dispositions: Array<Record<string, unknown>> = [];
    let claims = 0;
    let linkOptions!: Record<string, any>;
    let finishHost!: () => void;
    let started!: () => void;
    const finished = new Promise<void>(resolve => { finishHost = resolve; });
    const ready = new Promise<void>(resolve => { started = resolve; });
    const running = runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      createServerLink: (_url, _agentId, options) => {
        linkOptions = options as unknown as Record<string, any>;
        queueMicrotask(() => { linkOptions.onReplyBasisMode("v1"); linkOptions.onPersonaPrompt("system prompt"); });
        return {
          deliveryModes: () => ({ early: "fold", yield: "tool_boundary", stage_reports: true }),
          deliveryIncarnation: () => "inc", deliveryGeneration: () => "gen",
          requestYieldClaim: async () => { claims += 1; return { granted: true }; },
          reportDeliveryStage: (report: Record<string, unknown>) => dispositions.push(report),
          acknowledgeInterAgentDelivery: () => {}, retireInterAgentDeliveries: () => true,
          sendInterAgent: async () => ({ kind: "accepted", stamp: null }),
          send: () => {}, close: () => {}, currentSessionId: () => null,
          reportDisconnectIntent: async () => true,
        } as never;
      },
      createHost: () => ({
        state: "thinking", statusExtSnapshot: () => ({}),
        run: async () => { started(); await finished; },
        send: async (_text: string, _attachments: unknown, _cids: readonly string[], token: string, policy?: { source?: string }) => {
          if (policy?.source === "peer") queued.add(token);
        },
        activeInterAgentTurnToken: () => "T",
        canPushLiveInput: () => true, canFoldLiveInput: () => false,
        captureLiveInputContext: () => ({}),
        matchesLiveInputContext: () => true,
        hasPendingPushedReceipt: () => false,
        waitForPushedReceipt: async () => true,
        yieldEligibility: () => null,
        canReserveYieldOvertake: () => true,
        pushedInputFits: (text: string, count: number) => count <= 10 && Buffer.byteLength(text, "utf8") <= 16_384,
        hasQueuedInput: (token: string) => queued.has(token),
        removeQueuedInput: (token: string) => queued.delete(token),
        pushLiveInput: (input: { text: (foldId: string) => string }) => {
          pushes.push(input.text("0".repeat(32)));
          return true;
        },
      }) as never,
    });
    try {
      await ready;
      linkOptions.onInterAgentDeliveryStatus({ acked_seq: 0 });
      const message = inboundEnvelope(1);
      message.payload.delivery_authority = {
        requested: "yield", granted: "yield", work_id: "W", authority_epoch: 1, yield_token: "token",
      };
      message.payload.body = "";
      const prefixBytes = Buffer.byteLength(
        `[Director yield after the running tool]\nfold_id: ${"0".repeat(32)}\n\n${formatInboundMessage(message)}`, "utf8",
      );
      const bodyBytes = scenario.targetBytes - prefixBytes;
      message.payload.body = scenario.multibyte
        ? "α".repeat(Math.floor(bodyBytes / 2)) + (bodyBytes % 2 ? "a" : "")
        : "a".repeat(bodyBytes);
      expect(Buffer.byteLength(
        `[Director yield after the running tool]\nfold_id: ${"0".repeat(32)}\n\n${formatInboundMessage(message)}`, "utf8",
      )).toBe(scenario.targetBytes);
      await linkOptions.onInterAgentMessage(message);
      await vi.waitFor(() => expect(dispositions.some(report => report.yield_disposition !== undefined)).toBe(true));
      const disposition = [...dispositions].reverse().find(report => report.yield_disposition !== undefined)!
        .yield_disposition as { outcome?: string; reason?: string };
      expect(claims).toBe(scenario.allowed ? 1 : 0);
      expect(pushes).toHaveLength(scenario.allowed ? 1 : 0);
      expect(disposition).toMatchObject(scenario.allowed
        ? { outcome: "cut" }
        : { outcome: "downgraded", reason: "oversized_input" });
      expect(queued.size).toBe(scenario.allowed ? 0 : 1);
    } finally { finishHost(); await running; vi.unstubAllEnvs(); }
  });

  it("keeps an unpushed early lease urgent and lets same-peer ordinary input reach the root scheduler", async () => {
    vi.stubEnv("KAOIRO_CLAUDE_PHASE2_DELIVERY", "1");
    const inputs: Array<{ text: string; urgent?: boolean }> = [];
    let linkOptions!: Record<string, any>;
    let finishHost!: () => void;
    let started!: () => void;
    const finished = new Promise<void>(resolve => { finishHost = resolve; });
    const ready = new Promise<void>(resolve => { started = resolve; });
    const running = runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      createServerLink: (_url, _agentId, options) => {
        linkOptions = options as unknown as Record<string, any>;
        queueMicrotask(() => { linkOptions.onReplyBasisMode("v1"); linkOptions.onPersonaPrompt("system prompt"); });
        return {
          deliveryModes: () => ({ early: "fold", yield: "tool_boundary", stage_reports: true }),
          deliveryIncarnation: () => "inc", deliveryGeneration: () => "gen",
          reportDeliveryStage: () => {}, acknowledgeInterAgentDelivery: () => {},
          sendInterAgent: async () => ({ kind: "accepted", stamp: null }),
          send: () => {}, close: () => {}, currentSessionId: () => null,
          reportDisconnectIntent: async () => true,
        } as never;
      },
      createHost: () => ({
        state: "idle", statusExtSnapshot: () => ({}),
        run: async () => { started(); await finished; },
        send: async (text: string, _attachments: unknown, _cids: readonly string[], _token: string,
          policy?: { urgent?: boolean }) => { inputs.push({ text, urgent: policy?.urgent ?? false }); },
        canFoldLiveInput: () => false, hasQueuedInput: () => false,
      }) as never,
    });
    try {
      await ready;
      linkOptions.onInterAgentDeliveryStatus({ acked_seq: 0 });
      const early = inboundEnvelope(1);
      early.payload.delivery_authority = { requested: "early", granted: "early" };
      await linkOptions.onInterAgentMessage(early);
      await linkOptions.onInterAgentMessage(inboundEnvelope(2));
      await vi.waitFor(() => expect(inputs).toHaveLength(2));
      expect(inputs.map(input => input.urgent)).toEqual([true, false]);
      expect(inputs[0]!.text).toContain("c-1");
      expect(inputs[1]!.text).toContain("c-2");
    } finally { finishHost(); await running; vi.unstubAllEnvs(); }
  });

  it("sends a failure notice for a queued peer turn cancelled before its first hook", async () => {
    const notices: Envelope[] = [];
    let linkOptions!: Record<string, any>;
    let hostOptions!: Record<string, any>;
    let finishHost!: () => void;
    let started!: () => void;
    const finished = new Promise<void>(resolve => { finishHost = resolve; });
    const ready = new Promise<void>(resolve => { started = resolve; });
    const running = runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      createServerLink: (_url, _agentId, options) => {
        linkOptions = options as unknown as Record<string, any>;
        queueMicrotask(() => { linkOptions.onReplyBasisMode("v1"); linkOptions.onPersonaPrompt("system prompt"); });
        return {
          sendInterAgent: async (envelope: Envelope) => { notices.push(envelope); return { kind: "accepted", stamp: null }; },
          send: () => {}, close: () => {}, currentSessionId: () => null,
          acknowledgeInterAgentDelivery: () => {}, retireInterAgentDeliveries: () => true,
          reportDisconnectIntent: async () => true,
        } as never;
      },
      createHost: (_cfg, options) => {
        hostOptions = options as unknown as Record<string, any>;
        return {
          state: "error", statusExtSnapshot: () => ({}),
          run: async () => { started(); await finished; },
          send: async (_text: string, _attachments: unknown, _cids: readonly string[], token: string) => {
            hostOptions.onTurnEnd({ turnToken: token, error: { reason: "timeout" },
              cancellation: { kind: "receipt_timeout_fail_stop", started: false } });
          },
        } as never;
      },
    });
    try {
      await ready;
      await linkOptions.onInterAgentMessage(inboundEnvelope(1));
      await vi.waitFor(() => expect(notices.filter(envelope => envelope.payload.conversation_id === "c-1")).toHaveLength(1));
      expect(notices[0]!.payload.notice_type).toBe("turn_failure");
    } finally { finishHost(); await running; }
  });
  it("connects a real Host watchdog fail-stop to the CLI send decision", async () => {
    const outbound: Envelope[] = [];
    const states: string[] = [];
    let tool!: InterAgentTool;
    let host!: AgentHost;
    let linkOptions!: Record<string, any>;
    const running = runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      buildMcpServer: interAgent => { tool = interAgent; return {} as never; },
      createServerLink: (_url, _agentId, options) => {
        linkOptions = options as unknown as Record<string, any>;
        queueMicrotask(() => { linkOptions.onReplyBasisMode("v1"); linkOptions.onPersonaPrompt("system prompt"); });
        return {
          sendInterAgent: async (envelope: Envelope) => { outbound.push(envelope); return { kind: "accepted", stamp: null }; },
          send: (envelope: Envelope) => { if (envelope.type === "state_change") states.push(envelope.state); },
          close: () => {}, currentSessionId: () => null,
          acknowledgeInterAgentDelivery: () => {},
          retireInterAgentDeliveries: () => true,
          flushInterAgentRetirements: async () => {},
          reportDisconnectIntent: async () => true,
        } as never;
      },
      createHost: (cfg, options) => {
        host = new AgentHost(cfg, options);
        host.probeRateLimits = async () => {};
        return host;
      },
    });
    try {
      await vi.waitFor(() => expect(host).toBeDefined());
      tool.beginReplyInput("valid-token", undefined, true);
      const args = { to: "peer.agent", kind: "request" as const, body: "before stop" };
      expect((await tool.invoke(args, { origin: { token: "valid-token" } })).isError).toBeUndefined();
      expect(host.failStopForWatchdogAttributionUnknown()).toBe(true);
      expect(host.state).toBe("error");
      const after = await tool.invoke({ ...args, body: "after stop" }, { origin: { token: "valid-token" } });
      expect(JSON.parse(after.content[0]!.text)).toMatchObject({ error: "admission_fail_stop", send_not_attempted: true });
      expect(outbound).toHaveLength(1);
      expect(states).toContain("error");
    } finally {
      host?.close();
      await running;
    }
  });

  it("freezes later peer dispatch after an unattributable notification result", async () => {
    const sentTokens: string[] = [];
    const outbound: Envelope[] = [];
    let tool!: InterAgentTool;
    let hostOptions!: Record<string, any>;
    let linkOptions!: Record<string, any>;
    let finishHost!: () => void;
    let started!: () => void;
    const finished = new Promise<void>(resolve => { finishHost = resolve; });
    const ready = new Promise<void>(resolve => { started = resolve; });
    const running = runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      buildMcpServer: interAgent => { tool = interAgent; return {} as never; },
      createServerLink: (_url, _agentId, options) => {
        linkOptions = options as unknown as Record<string, any>;
        queueMicrotask(() => { linkOptions.onReplyBasisMode("v1"); linkOptions.onPersonaPrompt("system prompt"); });
        return {
          sendInterAgent: async (envelope: Envelope) => { outbound.push(envelope); return { kind: "accepted", stamp: null }; },
          send: () => {}, close: () => {}, currentSessionId: () => null,
          acknowledgeInterAgentDelivery: () => {},
          retireInterAgentDeliveries: () => true,
          reportDisconnectIntent: async () => true,
        } as never;
      },
      createHost: (_config, options) => {
        hostOptions = options as unknown as Record<string, any>;
        return {
          state: "idle", statusExtSnapshot: () => ({}),
          run: async () => { started(); await finished; },
          send: async (_text: string, _attachments: unknown, _cids: readonly string[], token: string) => {
            sentTokens.push(token);
            hostOptions.prepareInput(token);
            hostOptions.onTurnStart({ turnToken: token });
          },
        } as never;
      },
    });
    try {
      await ready;
      await linkOptions.onInterAgentMessage(inboundEnvelope(1, 1));
      await vi.waitFor(() => expect(sentTokens).toHaveLength(1));
      const args = { to: "peer.agent", conversation_id: "c-1", kind: "response" as const, body: "before freeze" };
      expect((await tool.invoke(args, { origin: { token: sentTokens[0]! } })).isError).toBeUndefined();
      hostOptions.onAdmissionFailStop({ turnToken: sentTokens[0], conversationIds: ["c-1"] });
      const after = await tool.invoke({ ...args, body: "after freeze" }, { origin: { token: sentTokens[0]! } });
      expect(after.isError).toBe(true);
      expect(JSON.parse(after.content[0]!.text)).toMatchObject({ error: "admission_fail_stop", send_not_attempted: true });
      tool.beginNotificationReplyInput("independent");
      const independent = await tool.invoke({ ...args, body: "independent" }, { origin: { token: "independent" } });
      expect(independent.isError).toBe(true);
      expect(JSON.parse(independent.content[0]!.text)).toMatchObject({ error: "admission_fail_stop", send_not_attempted: true });
      expect(outbound.map(envelope => envelope.payload.body)).toEqual(["before freeze"]);
      await linkOptions.onInterAgentMessage(inboundEnvelope(2, 3));
      hostOptions.onTurnEnd({ turnToken: sentTokens[0], error: { reason: "stream_eof" } });
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(sentTokens).toHaveLength(1);
    } finally { finishHost(); await running; }
  });

  it("resolves a coordinator batch and a newly recovered CID before ending T2", async () => {
    const notices: Envelope[] = [];
    let hostOptions!: Record<string, any>;
    let linkOptions!: Record<string, any>;
    let tool!: InterAgentTool;
    let activeToken = "";
    let finishHost!: () => void;
    let started!: () => void;
    const finished = new Promise<void>(resolve => { finishHost = resolve; });
    const ready = new Promise<void>(resolve => { started = resolve; });
    const running = runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      buildMcpServer: interAgent => { tool = interAgent; return {} as never; },
      createServerLink: (_url, _agentId, options) => {
        linkOptions = options as unknown as Record<string, any>;
        queueMicrotask(() => { linkOptions.onReplyBasisMode("v1"); linkOptions.onPersonaPrompt("system prompt"); });
        return {
          sendInterAgent: async (envelope: Envelope) => { notices.push(envelope); return { kind: "accepted", stamp: null }; },
          acknowledgeInterAgentDelivery: () => {},
          send: () => {}, close: () => {}, currentSessionId: () => null,
          reportDisconnectIntent: async () => true,
        } as never;
      },
      createHost: (_config, options) => {
        hostOptions = options as unknown as Record<string, any>;
        return {
          state: "idle", statusExtSnapshot: () => ({}),
          run: async () => { started(); await finished; },
          send: async (_text: string, _attachments: unknown, _cids: readonly string[], token: string) => {
            activeToken = token;
            hostOptions.prepareInput(token);
            hostOptions.onTurnStart({ turnToken: token });
          },
        } as never;
      },
    });
    try {
      await ready;
      await linkOptions.onInterAgentMessage(inboundEnvelope(1, 1));
      await vi.waitFor(() => expect(activeToken).not.toBe(""));
      tool.notePendingInjection(inboundEnvelope(2, 3), activeToken);
      hostOptions.onTurnEnd({ turnToken: activeToken, error: { reason: "api_error" } });
      await vi.waitFor(() => expect(notices.filter(e => e.type === "inter_agent_message")).toHaveLength(2));
      expect(notices.filter(e => e.type === "inter_agent_message").map(e => e.payload.conversation_id).sort()).toEqual(["c-1", "c-2"]);
      expect(tool.pendingConversationIdsForTurn(activeToken)).toEqual([]);
    } finally { finishHost(); await running; }
  });
  it.each(["sdk_notification", "wrapper_input"] as const)("settles committed recovery owned by %s exactly once", async (kind) => {
    const notices: Envelope[] = [];
    let hostOptions!: Record<string, any>;
    let tool!: InterAgentTool;
    let finishHost!: () => void;
    let started!: () => void;
    const finished = new Promise<void>(resolve => { finishHost = resolve; });
    const ready = new Promise<void>(resolve => { started = resolve; });
    const running = runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      buildMcpServer: interAgent => { tool = interAgent; return {} as never; },
      createServerLink: (_url, _agentId, options) => {
        queueMicrotask(() => {
          options.onReplyBasisMode!("v1");
          options.onPersonaPrompt?.("system prompt");
        });
        return {
          sendInterAgent: async (envelope: Envelope) => { notices.push(envelope); return { kind: "accepted", stamp: null }; },
          send: () => {},
          close: () => {}, currentSessionId: () => null,
          reportDisconnectIntent: async () => true,
        } as never;
      },
      createHost: (_config, options) => {
        hostOptions = options as unknown as Record<string, any>;
        return { state: "idle", statusExtSnapshot: () => ({}), run: async () => { started(); await finished; } } as never;
      },
    });
    try {
      await ready;
      const token = "recovery-token";
      hostOptions.onTurnStart({ turnToken: token, conversationIds: [], kind });
      tool.notePendingInjection(inboundEnvelope(1, 3), token);
      hostOptions.onTurnEnd({ turnToken: token, conversationIds: [], kind, error: { reason: "api_error" } });
      await vi.waitFor(() => expect(notices).toHaveLength(1));
      const failureNotices = notices.filter(envelope => envelope.type === "inter_agent_message");
      expect(failureNotices).toHaveLength(1);
      expect(failureNotices[0]!.payload).toMatchObject({ conversation_id: "c-1", notice_type: "turn_failure" });
      expect(tool.pendingConversationIdsForTurn(token)).toEqual([]);
    } finally {
      finishHost();
      await running;
    }
  });
  it("acks a queued terminal item without a second host turn or delivery retirement", async () => {
    const acknowledgements: number[] = [];
    const retire = vi.fn(() => true);
    const sends: string[] = [];
    let firstTurnToken = "";
    let linkOptions!: Record<string, any>;
    let hostOptions!: Record<string, any>;
    let tool!: InterAgentTool;
    let finishHost!: () => void;
    const finished = new Promise<void>((resolve) => { finishHost = resolve; });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const host = {
      state: "idle",
      statusExtSnapshot: () => ({}),
      activeInterAgentTurnToken: () => firstTurnToken || null,
      run: async () => { started(); await finished; },
      send: async (text: string, _attachments: unknown, _cids: readonly string[], token: string) => {
        sends.push(text);
        if (firstTurnToken === "") firstTurnToken = token;
        hostOptions.prepareInput(token);
        hostOptions.onTurnStart({ turnToken: token });
      },
    };
    const running = runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      buildMcpServer: (interAgent) => { tool = interAgent; return {} as never; },
      createServerLink: (_url, _agentId, options) => {
        linkOptions = options as unknown as Record<string, any>;
        queueMicrotask(() => { linkOptions.onReplyBasisMode("v1"); linkOptions.onPersonaPrompt("system prompt"); });
        return {
          acknowledgeInterAgentDelivery: (seq: number) => acknowledgements.push(seq),
          retireInterAgentDeliveries: retire,
          sendInterAgent: async () => ({ kind: "accepted", stamp: null }),
          close: () => {}, currentSessionId: () => null, send: () => {},
          reportDisconnectIntent: async () => true,
        } as never;
      },
      createHost: (_config, options) => {
        hostOptions = options as unknown as Record<string, any>;
        return host as never;
      },
    });
    try {
      await ready;
      expect(hostOptions.prepareInput).toBeTypeOf("function");
      linkOptions.onInterAgentDeliveryStatus({ acked_seq: 0 });
      const first = inboundEnvelope(1, 2);
      first.payload.conversation_id = "queued-closed";
      first.payload.meta = { done: true, propose_next: "" };
      const second = inboundEnvelope(2, 3);
      second.payload.conversation_id = "queued-closed";
      second.payload.meta = { done: true, propose_next: "" };
      await linkOptions.onInterAgentMessage(first);
      await vi.waitFor(() => expect(sends).toHaveLength(1));
      await linkOptions.onInterAgentMessage(second);
      const done = await tool.invoke({ to: "peer.agent", kind: "done", body: "done", conversation_id: "queued-closed", done: true }, { origin: { token: firstTurnToken } });
      expect(done.isError).toBeFalsy();
      hostOptions.onTurnEnd({ turnToken: firstTurnToken });
      expect(retire).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(acknowledgements).toEqual([1, 2]));
      expect(sends).toHaveLength(1);
    } finally {
      finishHost();
      await running;
    }
  });
  it.each([false, true])(
    "acks a mid-turn arrival only when the real host yields the next input (stderr failure: %s)",
    async (stderrFails) => {
      const acknowledgements: number[] = [];
      const inputs: SDKUserMessage[] = [];
      const lifecycle: Record<string, unknown>[] = [];
      const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        const line = String(chunk);
        const prefix = "[kaoiro][claude-code-lifecycle] ";
        if (line.startsWith(prefix)) {
          if (stderrFails) throw new Error("diagnostic sink unavailable");
          lifecycle.push(JSON.parse(line.slice(prefix.length)));
        }
        return true;
      });
      let releaseFirst!: () => void;
      const firstBoundary = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let releaseSecond!: () => void;
      const secondBoundary = new Promise<void>((resolve) => { releaseSecond = resolve; });
      let linkOptions!: Record<string, any>;
      let host!: AgentHost;
      const queryFn: NonNullable<AgentHostOptions["queryFn"]> = (args) => {
        async function* frames(): AsyncGenerator<SDKMessage, void> {
          const input = (args.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
          inputs.push((await input.next()).value!);
          yield { type: "assistant", message: { content: [
            { type: "tool_use", id: "held-tool", name: "Read", input: {} },
          ] } } as unknown as SDKMessage;
          await firstBoundary;
          yield { type: "result", result_index: nextResultIndex(), session_id: "s", subtype: "success", result: "first done" } as SDKMessage;
          inputs.push((await input.next()).value!);
          await secondBoundary;
          yield { type: "result", result_index: nextResultIndex(), session_id: "s", subtype: "success", result: "second done" } as SDKMessage;
        }
        return Object.assign(frames(), { interrupt: async () => {} }) as unknown as Query;
      };
      const running = runClaudeCli({
        parseCliArgs: () => ({ configPath: "test", prompt: "first instruction", resume: undefined }),
        loadConfig: () => ({ ...config }),
        createServerLink: (_url, _agentId, options) => {
          linkOptions = options as unknown as Record<string, any>;
          queueMicrotask(() => {
            linkOptions.onInterAgentDeliveryStatus({ issued_seq: 0, acked_seq: 0 });
            linkOptions.onPersonaPrompt("system prompt");
          });
          return {
            acknowledgeInterAgentDelivery: (seq: number) => acknowledgements.push(seq),
            close: () => {}, currentSessionId: () => null, setSessionId: () => {}, send: () => {},
            reportSessionLifecycle: () => {},
          } as never;
        },
        createHost: (config, options) => {
          host = new AgentHost(config, { ...options, queryFn });
          return host;
        },
      });
      // Observe early failures while assertions are waiting; cleanup below
      // still awaits the original promise and propagates its rejection.
      void running.catch(() => {});
      try {
        await vi.waitFor(() => expect(host?.state).toBe("tool_running"));
        await linkOptions.onInterAgentMessage(inboundEnvelope(1));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(inputs).toHaveLength(1);
        expect(acknowledgements).toEqual([]);
        if (!stderrFails) {
          expect(lifecycle.filter((event) => event.seq_first === 1).map((event) => event.event))
            .toEqual(["dispatch_queued"]);
        }
        releaseFirst();
        await vi.waitFor(() => expect(inputs).toHaveLength(2));
        expect(acknowledgements).toEqual([1]);
        if (!stderrFails) {
          const queued = lifecycle.find((event) => event.event === "dispatch_queued")!;
          expect(lifecycle).toContainEqual(expect.objectContaining({
            agent_id: config.agent_id, event: "turn_start", turn_token: queued.turn_token,
            seq_first: 1, seq_last: 1,
          }));
          expect(lifecycle).toContainEqual(expect.objectContaining({
            agent_id: config.agent_id, event: "delivery_ack", seq: 1, phase: "send_attempt",
          }));
          expect(JSON.stringify(lifecycle)).not.toContain("first instruction");
          expect(JSON.stringify(lifecycle)).not.toContain("hello");
        }
      } finally {
        releaseFirst();
        releaseSecond();
        host?.close();
        try {
          await running;
        } finally {
          stderr.mockRestore();
          output.mockRestore();
        }
      }
    },
  );

  it("decision-level test: onPromptAdmitted reaches the injected ServerLink seam", async () => {
    const reports: Record<string, unknown>[] = [];
    let beforeHookStages: unknown[] = [];
    let linkOptions!: Record<string, any>;
    let hostOptions!: Record<string, any>;
    let finishHost!: () => void;
    const finished = new Promise<void>(resolve => { finishHost = resolve; });
    let startHost!: () => void;
    const ready = new Promise<void>(resolve => { startHost = resolve; });
    const running = runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      createServerLink: (_url, _id, options) => {
        linkOptions = options as unknown as Record<string, any>;
        queueMicrotask(() => { linkOptions.onReplyBasisMode("v1"); linkOptions.onPersonaPrompt("system prompt"); });
        return {
          deliveryIncarnation: () => "server-incarnation",
          deliveryGeneration: () => "wrapper-generation",
          reportDeliveryStage: (report: Record<string, unknown>) => reports.push(report),
          acknowledgeInterAgentDelivery: () => {}, close: () => {}, currentSessionId: () => null, send: () => {},
          reportDisconnectIntent: async () => true,
        } as never;
      },
      createHost: (_config, options) => {
        hostOptions = options as unknown as Record<string, any>;
        return {
          state: "idle", statusExtSnapshot: () => ({}),
          run: async () => { startHost(); await finished; },
          send: async (_text: string, _attachments: unknown, _cids: readonly string[], token: string) => {
            const prepared = hostOptions.prepareInput(token);
            expect(prepared).toBeDefined();
            hostOptions.onTurnStart({ turnToken: token, kind: "wrapper_input" });
            beforeHookStages = reports.map(report => report.stage);
            hostOptions.onPromptAdmitted(token);
          },
        } as never;
      },
    });
    try {
      await ready;
      expect(linkOptions.interAgentDeliveryModes).toEqual({ version: "v1", early: "none", yield: "none", stage_reports: true });
      await linkOptions.onInterAgentMessage(inboundEnvelope(41));
      await vi.waitFor(() => expect(reports.map(report => report.stage)).toContain("submitted"));
      expect(beforeHookStages).toEqual(["queued"]);
      expect(reports).toEqual(expect.arrayContaining([
        expect.objectContaining({ incarnation: "server-incarnation", generation: "wrapper-generation", delivery_seq: 41, stage: "queued" }),
        expect.objectContaining({ incarnation: "server-incarnation", generation: "wrapper-generation", delivery_seq: 41, stage: "submitted", handoff: "prompt_hook" }),
      ]));
    } finally {
      finishHost();
      await running;
    }
  });

  /**
   * Default composition except for the engine Host; the real Host is covered
   * by E5 (issue #433). ServerLink, negotiation, tools, and reporter remain
   * the runClaudeCli defaults, and stage evidence is read from the wire.
   */
  it("default composition except engine Host negotiates and reports first-turn stages", async () => {
    const wire = await phoenixLoopback(() => ({
      inter_agent_reply_basis: "v1",
      inter_agent_delivery_modes: "v1",
      inter_agent_delivery_incarnation: "server-incarnation",
      work_control: "v1",
    }));
    let hostOptions!: Record<string, any>;
    let finishHost!: () => void;
    let startHost!: () => void;
    const finished = new Promise<void>(resolve => { finishHost = resolve; });
    const ready = new Promise<void>(resolve => { startHost = resolve; });
    const running = runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config, server_url: wire.url }),
      createHost: (_config, options) => {
        hostOptions = options as unknown as Record<string, any>;
        return {
          state: "idle", statusExtSnapshot: () => ({}),
          run: async () => { startHost(); await finished; },
          send: async (_text: string, _attachments: unknown, _cids: readonly string[], token: string) => {
            const prepared = hostOptions.prepareInput(token);
            expect(prepared).toBeDefined();
            hostOptions.onTurnStart({ turnToken: token, conversationIds: prepared.conversationIds, kind: "wrapper_input" });
            hostOptions.onPromptAdmitted(token);
            hostOptions.onTurnEnd({ turnToken: token, conversationIds: prepared.conversationIds, kind: "wrapper_input" });
          },
          close: () => {},
        } as never;
      },
    });
    try {
      await vi.waitFor(() => expect(wire.joins).toBe(1));
      expect(wire.received.find(item => item.event === "phx_join")?.payload).toMatchObject({
        inter_agent_reply_basis: "v1",
        inter_agent_delivery_modes: { version: "v1", early: "none", yield: "none", stage_reports: true },
        work_control: "v1",
      });
      wire.push("persona_prompt", { prompt: "system prompt" });
      await ready;
      wire.push("envelope", inboundEnvelope(42) as unknown as Record<string, unknown>);
      await vi.waitFor(() => expect(wire.received.filter(item => item.event === "delivery_stage").map(item => item.payload.stage)).toEqual(["queued", "submitted", "settled"]));
      const stages = wire.received.filter(item => item.event === "delivery_stage").map(item => item.payload);
      expect(stages).toEqual([
        expect.objectContaining({ incarnation: "server-incarnation", delivery_seq: 42, stage: "queued" }),
        expect.objectContaining({ incarnation: "server-incarnation", delivery_seq: 42, stage: "submitted", handoff: "prompt_hook" }),
        expect.objectContaining({ incarnation: "server-incarnation", delivery_seq: 42, stage: "settled", reason: "turn_end" }),
      ]);
    } finally {
      finishHost();
      await running;
      await wire.close();
    }
  });

  it("reports a consumed waiter reply at the CLI's committed tool-result handoff", async () => {
    const wire = await phoenixLoopback(() => ({
      inter_agent_reply_basis: "v1",
      inter_agent_delivery_modes: "v1",
      inter_agent_delivery_incarnation: "server-incarnation",
      work_control: "v1",
    }));
    let tool!: InterAgentTool;
    let hostOptions!: Record<string, any>;
    let finishHost!: () => void;
    let startHost!: () => void;
    const finished = new Promise<void>(resolve => { finishHost = resolve; });
    const started = new Promise<void>(resolve => { startHost = resolve; });
    const running = runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config, server_url: wire.url }),
      buildMcpServer: interAgent => { tool = interAgent; return {} as never; },
      createHost: (_config, options) => {
        hostOptions = options as unknown as Record<string, any>;
        return {
          state: "idle", statusExtSnapshot: () => ({}),
          activeInterAgentTurnToken: () => "waiter-turn",
          run: async () => { startHost(); await finished; },
          send: async () => {}, close: () => {},
        } as never;
      },
    });
    try {
      await vi.waitFor(() => expect(wire.joins).toBe(1));
      wire.push("persona_prompt", { prompt: "system prompt" });
      await started;
      hostOptions.onTurnStart({ turnToken: "waiter-turn", kind: "wrapper_input" });
      hostOptions.onPromptAdmitted("waiter-turn");

      const waiting = tool.invoke({
        to: "peer.agent", conversation_id: "waiter-cli", kind: "query", body: "question",
        wait_for_response: true, timeout_ms: 2_000,
      }, { origin: { token: "waiter-turn" } });
      await vi.waitFor(() => expect(wire.received.some(item =>
        item.event === "envelope" && item.payload.type === "inter_agent_message",
      )).toBe(true));
      const reply = inboundEnvelope(1, 2);
      reply.payload.conversation_id = "waiter-cli";
      reply.payload.kind = "response";
      wire.push("envelope", reply as unknown as Record<string, unknown>);
      const result = await waiting;
      const stages = () => wire.received.filter(item => item.event === "delivery_stage").map(item => item.payload);
      await vi.waitFor(() => expect(stages().map(stage => stage.stage)).toEqual(["queued"]));
      expect(wire.received.filter(item => item.event === "delivery_ack")).toHaveLength(0);

      expect(handoffToolResult(result, () => {})).toBe(true);
      await vi.waitFor(() => expect(stages().map(stage => stage.stage)).toEqual(["queued", "submitted"]));
      expect(stages()[1]).toMatchObject({ delivery_seq: 1, handoff: "tool_result" });
      await vi.waitFor(() => expect(wire.received.filter(item => item.event === "delivery_ack")).toHaveLength(1));

      hostOptions.onTurnEnd({ turnToken: "waiter-turn", conversationIds: ["waiter-cli"] });
      await vi.waitFor(() => expect(stages().map(stage => stage.stage)).toEqual(["queued", "submitted", "settled"]));
      expect(stages()[2]).toMatchObject({ delivery_seq: 1, reason: "turn_end" });
    } finally {
      finishHost();
      await running;
      await wire.close();
    }
  });

  it("captures a delivery before receiveInbound waits across an identity change", async () => {
    let identity = "old-incarnation";
    const reports: Array<Record<string, unknown>> = [];
    let releaseDone!: (value: { kind: "rejected"; reason: string }) => void;
    const doneAcceptance = new Promise<{ kind: "rejected"; reason: string }>(resolve => { releaseDone = resolve; });
    let tool!: InterAgentTool;
    let linkOptions!: Record<string, any>;
    let hostOptions!: Record<string, any>;
    let finishHost!: () => void;
    let startHost!: () => void;
    const finished = new Promise<void>(resolve => { finishHost = resolve; });
    const started = new Promise<void>(resolve => { startHost = resolve; });
    const running = runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      buildMcpServer: interAgent => { tool = interAgent; return {} as never; },
      createServerLink: (_url, _agentId, options) => {
        linkOptions = options as unknown as Record<string, any>;
        queueMicrotask(() => {
          options.onReplyBasisMode!("v1");
          options.onPersonaPrompt!("system prompt");
        });
        return {
          sendInterAgent: async (envelope: Envelope) =>
            envelope.payload.kind === "done" ? doneAcceptance : { kind: "accepted", stamp: null },
          send: () => {}, close: () => {}, currentSessionId: () => null,
          deliveryIncarnation: () => identity,
          deliveryGeneration: () => "generation",
          reportDeliveryStage: (report: Record<string, unknown>) => { reports.push(report); return true; },
          acknowledgeInterAgentDelivery: () => {},
          retireInterAgentDeliveries: () => true,
          flushInterAgentRetirements: async () => {},
          reportDisconnectIntent: async () => true,
        } as never;
      },
      createHost: (_config, options) => {
        hostOptions = options as unknown as Record<string, any>;
        return {
          state: "tool_running", statusExtSnapshot: () => ({}),
          activeInterAgentTurnToken: () => "identity-turn",
          run: async () => { startHost(); await finished; },
          send: async () => {}, close: () => {},
        } as never;
      },
    });
    let doneAttempt: Promise<unknown> | undefined;
    try {
      await started;
      hostOptions.onTurnStart({ turnToken: "identity-turn", kind: "wrapper_input" });
      hostOptions.onPromptAdmitted("identity-turn");
      doneAttempt = tool.invoke({
        to: "peer.agent", conversation_id: "done-gate", kind: "done", body: "close", done: true,
      }, { origin: { token: "identity-turn" } });

      const oldDelivery = inboundEnvelope(7, 2);
      oldDelivery.payload.conversation_id = "done-gate";
      const oldReceive = (linkOptions.onInterAgentMessage as (envelope: Envelope) => Promise<void>)(oldDelivery);
      identity = "new-incarnation";
      const newDelivery = inboundEnvelope(7, 2);
      newDelivery.payload.conversation_id = "separate-conversation";
      await (linkOptions.onInterAgentMessage as (envelope: Envelope) => Promise<void>)(newDelivery);
      releaseDone({ kind: "rejected", reason: "unknown_agent" });
      await doneAttempt;
      await oldReceive;

      expect(reports.filter(report => report.stage === "queued")).toEqual([
        expect.objectContaining({ incarnation: "new-incarnation", generation: "generation", delivery_seq: 7 }),
      ]);
    } finally {
      releaseDone({ kind: "rejected", reason: "unknown_agent" });
      await doneAttempt;
      finishHost();
      await running;
    }
  });

  it("actual entrypoint connects status, handler, and host turn-start to one acknowledgement flow", async () => {
    const acknowledgements: number[] = [];
    const disconnectReasons: string[] = [];
    let linkOptions!: Record<string, any>;
    let hostOptions!: Record<string, any>;

    const link = {
      acknowledgeInterAgentDelivery: (seq: number) => acknowledgements.push(seq),
      close: () => {},
      currentSessionId: () => null,
      send: () => {},
      reportDisconnectIntent: async (reason: string) => {
        disconnectReasons.push(reason);
        return true;
      },
    };
    let startHost!: () => void;
    let finishHost!: () => void;
    const ready = new Promise<void>((resolve) => { startHost = resolve; });
    const finished = new Promise<void>((resolve) => { finishHost = resolve; });
    let running: Promise<void> | undefined;
    const host = {
      state: "idle",
      statusExtSnapshot: () => ({}),
      run: async () => { startHost(); await finished; },
      send: async (
        _text: string,
        _attachments: unknown,
        _conversationIds: readonly string[],
        turnToken: string,
      ) => {
        hostOptions.onTurnStart({ turnToken });
      },
    };

    try {
    running = runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      createServerLink: (_url, _agentId, options) => {
        linkOptions = options as unknown as Record<string, any>;
        queueMicrotask(() => {
          linkOptions.onPersonaPrompt("system prompt");
        });
        return link as never;
      },
      createHost: (_config, options) => {
        hostOptions = options as unknown as Record<string, any>;
        return host as never;
      },
    });
    await ready;

    expect(linkOptions.onInterAgentDeliveryStatus).toBeTypeOf("function");
    expect(linkOptions.onInterAgentMessage).toBeTypeOf("function");
    expect(hostOptions.onTurnStart).toBeTypeOf("function");

    linkOptions.onInterAgentDeliveryStatus({ acked_seq: 1 });
    // The actual production handler drops the stale turn before injection,
    // then injects the next fresh turn through the production coordinator.
    await linkOptions.onInterAgentMessage(inboundEnvelope(2, 0));
    await linkOptions.onInterAgentMessage(inboundEnvelope(3));

    await vi.waitFor(() => expect(acknowledgements).toEqual([2, 3]));
    hostOptions.onHostEnd({ error: {} });
    } finally { finishHost(); await running; }
    expect(disconnectReasons).toEqual(["stop"]);
  });
});
