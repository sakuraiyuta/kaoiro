// Adapter-level integration coverage for issue #177 review M4 (AC8/AC9/
// AC15) and issue #221 direction 1: proves the glue sequence cli.ts's
// onInterAgentMessage handler runs (receiveInbound() -> disposition branch
// -> conditional host.send() / notePendingInjection()) against the REAL
// AgentHost + REAL InterAgentTool, not just InterAgentTool in isolation
// (which inter_agent.test.ts already covers exhaustively). Mirrors the
// harness style of inter_agent_injection_failure.test.ts (issue #136) —
// cli.ts itself has no test harness (its onInterAgentMessage handler lives
// inline in run(), like every other ServerLink callback in that file), so
// this reproduces the exact glue sequence directly against the two real
// classes instead of constructing cli.ts.
//
// A full 2-agent E2E (two live wrapper processes exchanging real network
// traffic through a real server) would need new test infrastructure this
// repo does not have; this adapter-level harness proves the same
// disposition-driven branching AC13 depends on (stale dropped before
// send, terminal skips notePendingInjection) without it. The 2-agent
// round-trip *count* claim in AC13 is covered separately at the
// engine-agnostic level in agent-common (two InterAgentTool instances
// relaying to each other in-process, no host/adapter involved).
import { describe, expect, it, vi } from "vitest";
import {
  InterAgentTool,
  MAX_COALESCED_MESSAGES,
  canAddToCoalescedBatch,
  formatInboundMessage,
  formatInboundMessages,
} from "@kaoiro/agent-common";
import type {
  Envelope,
  InboundReplyMode,
  InterAgentMessagePayload,
  WrapperConfig,
} from "@kaoiro/agent-common";
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { AgentHost } from "../src/host.js";
import type { AgentHostOptions } from "../src/host.js";

// The host reads only a few SDK fields; build minimal shapes and cast (same
// convention as host.test.ts's own local helpers, not shared across files).
const msg = (shape: unknown): SDKMessage => shape as SDKMessage;
type QueryFn = NonNullable<AgentHostOptions["queryFn"]>;
type QueryArgs = { prompt: AsyncIterable<SDKUserMessage>; options: Options };
function asQuery(gen: AsyncGenerator<SDKMessage, void>): Query {
  return Object.assign(gen, { interrupt: async () => {} }) as unknown as Query;
}
function makeQueryFn(fn: (args: QueryArgs) => Query): QueryFn {
  return fn as unknown as QueryFn;
}

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

const PEER_PERSONA = { id: "peer", name: "Peer", sprite_set: "peer" };

function inboundEnvelope(
  conversationId: string,
  turnNumber: number,
  done = false,
): Envelope {
  return {
    version: "0",
    agent_id: "peer.agent",
    persona: PEER_PERSONA,
    display_name: PEER_PERSONA.name,
    ts: "2026-08-08T00:00:00Z",
    type: "inter_agent_message",
    state: "tool_running",
    payload: {
      to: config.agent_id,
      conversation_id: conversationId,
      turn_number: turnNumber,
      kind: "inform",
      body: "hi",
      meta: { done, propose_next: "" },
      owner: { kind: "user", id: "operator" },
    },
    ext: {},
  };
}

/** Reproduces cli.ts's onInterAgentMessage glue exactly — both engine
 *  adapters share this sequence (claude-code/src/cli.ts,
 *  codex/src/cli.ts): consumed waiters return early, a stale/duplicate
 *  turn is dropped before formatting or host.send() (AC9), and — issue
 *  #221 direction 1 — a terminal-mode inbound is now ALSO dropped before
 *  host.send() (it owes no reply, so no SDK turn is spent on it either;
 *  only the track above learns `closed`), never tracked via
 *  notePendingInjection (AC8) either way. Async since issue #177 review
 *  round 2 (ふじ差し戻し) made receiveInbound() async (it may gate briefly
 *  on a concurrently in-flight done=true send for the same
 *  conversation_id). */
async function runOnInterAgentMessageGlue(
  interAgent: InterAgentTool,
  host: AgentHost,
  envelope: Envelope,
): Promise<void> {
  const disposition = await interAgent.receiveInbound(envelope);
  if (disposition.consumed) return;
  if (!disposition.inject) return;
  const payload = envelope.payload as unknown as InterAgentMessagePayload;
  const text = `[glue] ${payload.body}`;
  if (disposition.mode !== "terminal") {
    interAgent.notePendingInjection(envelope);
  }
  const cids =
    typeof payload.conversation_id === "string" ? [payload.conversation_id] : [];
  void host.send(text, undefined, cids).catch(() => {});
}

describe("issue #177 review M4: adapter-level lifecycle glue (claude-code)", () => {
  it("AC9: stale/duplicate turn は host.send() を一切呼ばない", async () => {
    const host = new AgentHost(config, { onState: () => {} });
    const sendSpy = vi.spyOn(host, "send");
    const tool = new InterAgentTool({
      config,
      getState: () => host.state,
      send: () => {},
    });

    await runOnInterAgentMessageGlue(tool, host, inboundEnvelope("cnv-stale", 2));
    expect(sendSpy).toHaveBeenCalledTimes(1);
    sendSpy.mockClear();

    // 重複 (直前と同じ turn_number) — SDK 入力に一切触れない。
    await runOnInterAgentMessageGlue(tool, host, inboundEnvelope("cnv-stale", 2));
    expect(sendSpy).not.toHaveBeenCalled();

    // 遅延到着 (既知の最大値より低い) も同様。
    await runOnInterAgentMessageGlue(tool, host, inboundEnvelope("cnv-stale", 1));
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("AC8/issue #221 direction 1: terminal な inbound は host.send() も notePendingInjection も呼ばない", async () => {
    const host = new AgentHost(config, { onState: () => {} });
    const sendSpy = vi.spyOn(host, "send");
    const tool = new InterAgentTool({
      config,
      getState: () => host.state,
      send: () => {},
    });

    // 自分側が先に done=true を送信 (fire-and-forget accepted 前提)。
    const closing = await tool.invoke({
      to: "peer.agent",
      body: "bye",
      kind: "done",
      conversation_id: "cnv-terminal",
      done: true,
    });
    expect(closing.isError).toBeFalsy();

    // peer 側も done=true → 両側揃って terminal。issue #221 direction 1
    // により receiveInbound() が inject: false を返すため、track は
    // closed を学習するが SDK 入力への注入は一切起きない。
    await runOnInterAgentMessageGlue(
      tool,
      host,
      inboundEnvelope("cnv-terminal", 2, true),
    );

    expect(sendSpy).not.toHaveBeenCalled();

    // notePendingInjection が呼ばれていなければ resolveTurnEnd は即座に
    // 空配列を返す — 何も pending になっていない証拠(呼ばれていれば
    // エラー通知が 1 件返るはず)。
    expect(
      tool.resolveTurnEnd(["cnv-terminal"], { code: "api_error", message: "x" }),
    ).toEqual([]);
  });

  it("対照: reply-owed な inbound は host.send() も notePendingInjection も両方走る", async () => {
    const host = new AgentHost(config, { onState: () => {} });
    const sendSpy = vi.spyOn(host, "send");
    const tool = new InterAgentTool({
      config,
      getState: () => host.state,
      send: () => {},
    });

    await runOnInterAgentMessageGlue(tool, host, inboundEnvelope("cnv-normal", 1));

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(
      tool.resolveTurnEnd(["cnv-normal"], { code: "api_error", message: "x" }),
    ).toHaveLength(1);
  });
});

/** Holds the CURRENT turn's SDK "thinking" open until the test calls
 *  `releaseNext()` — the only way a test can actually exercise "busy" vs
 *  "free" the way issue #221 段階3's coalescing trigger depends on it
 *  (`onTurnEnd` firing, not merely `host.send()`'s own promise settling —
 *  see cli.ts's `trySendNextBatch` doc for why that distinction matters).
 *  Each release lets exactly the NEXT queued turn's result through. */
function makeControllableQueryFn(): {
  queryFn: QueryFn;
  releaseNext: () => void;
} {
  let release: (() => void) | null = null;
  const queryFn = makeQueryFn((args: QueryArgs) => {
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      for await (const _m of args.prompt) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield msg({ type: "result", subtype: "success", result: "ok" });
      }
    }
    return asQuery(gen());
  });
  return {
    queryFn,
    releaseNext: () => {
      release?.();
      release = null;
    },
  };
}

/** Reproduces cli.ts's issue #221 段階3 batching glue exactly — same-peer
 *  FIFO queue per peer, `inFlightPeers` / `inFlightCidPeer` gating on the
 *  turn's OWN completion (`onTurnEnd`), not on `host.send()`'s promise (see
 *  `@kaoiro/claude-code/src/cli.ts`'s `trySendNextBatch` for the production
 *  version this test-only copy tracks, and its doc comment for why
 *  `instructionChain` alone is the WRONG signal — `host.send()` resolves
 *  almost the instant its text reaches the SDK's OWN queue, well before the
 *  model finishes thinking). */
function makeCoalescingHarness(interAgent: InterAgentTool) {
  const pendingBatches = new Map<
    string,
    { items: { envelope: Envelope; mode: InboundReplyMode }[]; bytes: number }[]
  >();
  const inFlightPeers = new Set<string>();
  const inFlightCidPeer = new Map<string, string>();
  const sentBatches: { peer: string; cids: string[] }[] = [];
  let host!: AgentHost;

  function trySendNextBatch(peer: string): void {
    if (inFlightPeers.has(peer)) return;
    const queue = pendingBatches.get(peer);
    const batch = queue?.shift();
    if (batch === undefined) return;
    if (queue!.length === 0) pendingBatches.delete(peer);
    inFlightPeers.add(peer);
    const cids = batch.items
      .map(
        (item) =>
          (item.envelope.payload as Partial<InterAgentMessagePayload>)
            .conversation_id,
      )
      .filter((cid): cid is string => typeof cid === "string");
    for (const cid of cids) inFlightCidPeer.set(cid, peer);
    sentBatches.push({ peer, cids });
    void host.send(formatInboundMessages(batch.items), undefined, cids);
  }

  async function receive(envelope: Envelope): Promise<void> {
    const disposition = await interAgent.receiveInbound(envelope);
    if (disposition.consumed || !disposition.inject) return;
    if (disposition.mode !== "terminal") {
      interAgent.notePendingInjection(envelope);
    }
    const peer = envelope.agent_id;
    const itemText = formatInboundMessage(envelope, { mode: disposition.mode });
    const itemBytes = Buffer.byteLength(itemText, "utf8");
    let queue = pendingBatches.get(peer);
    if (queue === undefined) {
      queue = [];
      pendingBatches.set(peer, queue);
    }
    let open = queue[queue.length - 1];
    if (
      open === undefined ||
      !canAddToCoalescedBatch(open.items.length, open.bytes, itemBytes)
    ) {
      open = { items: [], bytes: 0 };
      queue.push(open);
    }
    open.items.push({ envelope, mode: disposition.mode });
    open.bytes += itemBytes;
    trySendNextBatch(peer);
  }

  function onTurnEnd(conversationIds: readonly string[]): void {
    const freedPeer =
      conversationIds.length > 0
        ? inFlightCidPeer.get(conversationIds[0]!)
        : undefined;
    if (freedPeer !== undefined) {
      for (const cid of conversationIds) inFlightCidPeer.delete(cid);
      inFlightPeers.delete(freedPeer);
      trySendNextBatch(freedPeer);
    }
  }

  return {
    receive,
    onTurnEnd,
    sentBatches,
    bindHost: (h: AgentHost) => {
      host = h;
    },
  };
}

describe("issue #221 段階3: 同一peer busy-trigger coalescing (claude-code glue)", () => {
  it("idle な間に届いた1件は単独 batch のまま即座に turn を起こす", async () => {
    const { queryFn, releaseNext } = makeControllableQueryFn();
    const tool = new InterAgentTool({ config, getState: () => "idle", send: () => {} });
    const harness = makeCoalescingHarness(tool);
    const host = new AgentHost(config, {
      onState: () => {},
      onTurnEnd: (info) => harness.onTurnEnd(info.conversationIds),
      queryFn,
      now: () => "T",
    });
    harness.bindHost(host);
    void host.run();

    await harness.receive(inboundEnvelope("cnv-solo", 1));
    expect(harness.sentBatches).toEqual([
      { peer: "peer.agent", cids: ["cnv-solo"] },
    ]);

    releaseNext();
  });

  it("turn が in-flight な間に同一peerから連続到着したメッセージは次の turn へ合流する", async () => {
    const { queryFn, releaseNext } = makeControllableQueryFn();
    const tool = new InterAgentTool({ config, getState: () => "idle", send: () => {} });
    const harness = makeCoalescingHarness(tool);
    const host = new AgentHost(config, {
      onState: () => {},
      onTurnEnd: (info) => harness.onTurnEnd(info.conversationIds),
      queryFn,
      now: () => "T",
    });
    harness.bindHost(host);
    void host.run();

    // First message arrives while idle — starts its own turn immediately,
    // and that turn is now in flight (the queryFn's gate is held open).
    await harness.receive(inboundEnvelope("cnv-1", 1));
    expect(harness.sentBatches).toHaveLength(1);

    // Two more arrive from the SAME peer while turn 1 is still "thinking" —
    // must accumulate into ONE pending batch, not start their own turns.
    await harness.receive(inboundEnvelope("cnv-2", 1));
    await harness.receive(inboundEnvelope("cnv-3", 1));
    expect(harness.sentBatches).toHaveLength(1); // still just turn 1

    // Let turn 1 finish — onTurnEnd should now flush the accumulated batch
    // as ONE coalesced turn 2, addressed to both remaining cids.
    releaseNext();
    await vi.waitFor(() => expect(harness.sentBatches).toHaveLength(2));
    expect(harness.sentBatches[1]).toEqual({
      peer: "peer.agent",
      cids: ["cnv-2", "cnv-3"],
    });

    releaseNext();
  });

  it("異なる peer からの到着は互いの batch に混ざらない", async () => {
    const { queryFn, releaseNext } = makeControllableQueryFn();
    const tool = new InterAgentTool({ config, getState: () => "idle", send: () => {} });
    const harness = makeCoalescingHarness(tool);
    const host = new AgentHost(config, {
      onState: () => {},
      onTurnEnd: (info) => harness.onTurnEnd(info.conversationIds),
      queryFn,
      now: () => "T",
    });
    harness.bindHost(host);
    void host.run();

    await harness.receive(inboundEnvelope("cnv-a", 1));
    await harness.receive({ ...inboundEnvelope("cnv-b", 1), agent_id: "other.peer" });

    // Both peers were free (no prior in-flight turn for either) — each
    // gets its own immediate turn, never merged with the other's.
    expect(harness.sentBatches).toEqual([
      { peer: "peer.agent", cids: ["cnv-a"] },
      { peer: "other.peer", cids: ["cnv-b"] },
    ]);

    releaseNext();
    releaseNext();
  });

  it("件数上限に達すると batch を締めて次の batch へ持ち越す (捨てない)", async () => {
    const { queryFn, releaseNext } = makeControllableQueryFn();
    const tool = new InterAgentTool({ config, getState: () => "idle", send: () => {} });
    const harness = makeCoalescingHarness(tool);
    const host = new AgentHost(config, {
      onState: () => {},
      onTurnEnd: (info) => harness.onTurnEnd(info.conversationIds),
      queryFn,
      now: () => "T",
    });
    harness.bindHost(host);
    void host.run();

    // First message starts turn 1 (in flight); the rest arrive while busy.
    const total = MAX_COALESCED_MESSAGES + 2;
    for (let i = 0; i < total; i++) {
      await harness.receive(inboundEnvelope(`cnv-${i}`, 1));
    }
    expect(harness.sentBatches).toHaveLength(1); // only turn 1 sent so far

    releaseNext(); // turn 1 completes -> flush the capped batch as turn 2
    await vi.waitFor(() => expect(harness.sentBatches).toHaveLength(2));
    expect(harness.sentBatches[1]!.cids).toHaveLength(MAX_COALESCED_MESSAGES);

    releaseNext(); // turn 2 completes -> flush the 1-item overflow as turn 3
    await vi.waitFor(() => expect(harness.sentBatches).toHaveLength(3));
    expect(harness.sentBatches[2]!.cids).toHaveLength(1);

    // Every cid appears exactly once across all three turns — none dropped.
    const allCids = harness.sentBatches.flatMap((b) => b.cids);
    expect(new Set(allCids).size).toBe(total);

    releaseNext();
  });
});
