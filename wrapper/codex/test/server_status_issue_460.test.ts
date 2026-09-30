import { describe, expect, it, vi } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { runCodexCli } from "../src/cli.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "momo", name: "Momo", sprite_set: "momo" },
  display_name: "Momo",
  server_url: "ws://localhost:4000/wrapper",
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

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

function launchCodex(onInput: (turn: { text: string; cids: readonly string[]; token: string }, harness: Harness) => Promise<void>) {
  const started = deferred();
  const finished = deferred();
  const acknowledgements: number[] = [];
  const outbound: Envelope[] = [];
  const attempts: Envelope[] = [];
  const inputs: Array<{ text: string; cids: readonly string[]; token: string }> = [];
  let linkOptions!: Record<string, any>;
  let hostOptions!: Record<string, any>;
  let activeToken: string | null = null;
  const harness: Harness = {
    acknowledgements, outbound, attempts, inputs,
    get linkOptions() { return linkOptions; },
    get hostOptions() { return hostOptions; },
    endTurn(turn, error) {
      activeToken = null;
      hostOptions.onTurnEnd({ turnToken: turn.token, conversationIds: turn.cids, ...(error === undefined ? {} : { error }) });
      hostOptions.onTurnBoundary?.({ turnToken: turn.token });
      hostOptions.onTurnFinalized?.({ turnToken: turn.token });
    },
    finish: () => finished.resolve(),
  };
  const running = runCodexCli({
    parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
    loadConfig: () => ({ ...config }),
    createServerLink: (_url, _agentId, options) => {
      linkOptions = options as unknown as Record<string, any>;
      queueMicrotask(() => { options.onReplyBasisMode!("v1"); options.onPersonaPrompt!("system prompt"); });
      return {
        deliveryModes: () => ({ early: "none", yield: "none", stage_reports: true }),
        sendInterAgent: async (envelope: Envelope) => {
          attempts.push(envelope);
          if (envelope.payload.body === "stale body") return { kind: "rejected" as const, reason: "stale_reply_basis" as const, details: { expected_peer_turn: 2 } };
          outbound.push(envelope);
          return { kind: "accepted" as const, stamp: null };
        },
        acknowledgeInterAgentDelivery: (seq: number) => acknowledgements.push(seq),
        retireInterAgentDeliveries: () => true, flushInterAgentRetirements: async () => {},
        send: () => {}, close: () => {}, currentSessionId: () => null, setSessionId: () => {},
        reportDisconnectIntent: async () => true,
      } as never;
    },
    createHost: (_cfg, options) => {
      hostOptions = options as unknown as Record<string, any>;
      return {
        state: "idle", statusExtSnapshot: () => ({}),
        activeInterAgentTurnToken: () => activeToken,
        run: async () => { started.resolve(); await finished.promise; },
        send: async (text: string, _attachments: unknown, cids: readonly string[], token: string) => {
          const turn = { text, cids, token };
          inputs.push(turn);
          activeToken = token;
          hostOptions.prepareInput(token);
          hostOptions.onTurnStart({ turnToken: token, conversationIds: cids });
          await onInput(turn, harness);
        },
        close: () => {},
      } as never;
    },
    prepareStartup: async () => {},
  });
  return { harness, running, ready: started.promise };
}

interface Harness {
  acknowledgements: number[];
  outbound: Envelope[];
  attempts: Envelope[];
  inputs: Array<{ text: string; cids: readonly string[]; token: string }>;
  readonly linkOptions: Record<string, any>;
  readonly hostOptions: Record<string, any>;
  endTurn(turn: { text: string; cids: readonly string[]; token: string }, error?: { reason: string }): void;
  finish(): void;
}

describe("issue #460 Codex status and recovery handoff", () => {
  it("a failing server status turn creates no server reply; the peer failure notice remains", async () => {
    const { harness, running, ready } = launchCodex(async (turn, h) => {
      h.endTurn(turn, { reason: "api_error" });
    });
    try {
      await ready;
      harness.linkOptions.onInterAgentDeliveryStatus({ acked_seq: 0 });
      await harness.linkOptions.onInterAgentMessage(inbound(1, "server", "server-status", 0, "peer reconnected"));
      await vi.waitFor(() => expect(harness.inputs).toHaveLength(1));
      await vi.waitFor(() => expect(harness.acknowledgements).toEqual([1]));
      expect(harness.outbound.filter(envelope => envelope.payload.to === "server")).toHaveLength(0);

      await harness.linkOptions.onInterAgentMessage(inbound(2, "peer.agent", "peer-work", 1, "work"));
      await vi.waitFor(() => expect(harness.inputs).toHaveLength(2));
      await vi.waitFor(() => expect(harness.outbound.filter(envelope => envelope.payload.notice_type === "turn_failure")).toHaveLength(1));
      expect(harness.outbound[0]!.payload).toMatchObject({ to: "peer.agent", conversation_id: "peer-work", notice_type: "turn_failure" });
      expect(harness.outbound.filter(envelope => envelope.payload.to === "server")).toHaveLength(0);
      expect(harness.acknowledgements).toEqual([1, 2]);
    } finally {
      harness.finish();
      await running;
    }
  });

  it("a matching peer turn arriving after empty recovery follows normal Codex handoff", async () => {
    let firstTurn: { text: string; cids: readonly string[]; token: string } | undefined;
    const { harness, running, ready } = launchCodex(async (turn) => { firstTurn ??= turn; });
    try {
      await ready;
      harness.linkOptions.onInterAgentDeliveryStatus({ acked_seq: 0 });
      await harness.linkOptions.onInterAgentMessage(inbound(1, "peer.agent", "same-cid", 1, "first confirmed input"));
      await vi.waitFor(() => expect(harness.inputs).toHaveLength(1));
      const descriptor = (harness.hostOptions.toolDescriptors as Array<{ name: string; handler: (input: Record<string, unknown>, context?: unknown) => Promise<any> }>)
        .find(item => item.name === "send_to_agent");
      expect(descriptor).toBeDefined();
      const stale = await descriptor!.handler({ to: "peer.agent", conversation_id: "same-cid", kind: "response", body: "stale body" }, { origin: { token: firstTurn!.token } });
      const parsed = JSON.parse(stale.content[0]!.text);
      expect(parsed).toMatchObject({ error: "stale_reply_basis", recovery: [] });
      expect(parsed.guidance).toContain("does not prove delivery was lost");
      expect(parsed).not.toHaveProperty("awaiting_delivery");

      await harness.linkOptions.onInterAgentMessage(inbound(2, "peer.agent", "same-cid", 2, "later confirmed input"));
      harness.endTurn(firstTurn!);
      await vi.waitFor(() => expect(harness.inputs).toHaveLength(2));
      expect(harness.inputs[1]!.cids).toEqual(["same-cid"]);
      expect(harness.inputs[1]!.text).toContain("later confirmed input");
      expect(harness.inputs[1]!.text).toContain("turn_number=2");
      expect(harness.acknowledgements).toEqual([1, 2]);
      harness.endTurn(harness.inputs[1]!);
    } finally {
      harness.finish();
      await running;
    }
  });
});
