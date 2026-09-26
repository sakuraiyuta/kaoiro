import { describe, expect, it, vi } from "vitest";
import type { Envelope, InterAgentTool, WrapperConfig } from "@kaoiro/agent-common";
import { runClaudeCli } from "../src/cli.js";
import { AgentHost, type AgentHostOptions } from "../src/host.js";
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

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
          yield { type: "result", subtype: "success", result: "first done" } as SDKMessage;
          inputs.push((await input.next()).value!);
          await secondBoundary;
          yield { type: "result", subtype: "success", result: "second done" } as SDKMessage;
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
            close: () => {}, currentSessionId: () => null, send: () => {},
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
