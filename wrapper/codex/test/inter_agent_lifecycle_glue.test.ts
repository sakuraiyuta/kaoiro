// Adapter-level integration coverage for issue #177 review M4 (AC8/AC9/
// AC15): proves the glue sequence cli.ts's onInterAgentMessage handler
// runs (receiveInbound() -> disposition branch -> conditional host.send()
// / notePendingInjection()) against the REAL CodexHost + REAL
// InterAgentTool, not just InterAgentTool in isolation (which
// inter_agent.test.ts already covers exhaustively). Mirrors
// claude-code/test/inter_agent_lifecycle_glue.test.ts — same glue, same
// assertions, CodexHost in place of AgentHost — to demonstrate AC15
// (both engine adapters share identical lifecycle behaviour) is not just
// a claim about the shared agent-common code but is observably true
// through each engine's own host too. codex/src/cli.ts has no test
// harness of its own (like claude-code's cli.ts), so this reproduces its
// exact glue directly. CodexHost.send() only needs to reach its internal
// queue (#queue.push + #wake?.(), host.ts) — no live thread / run() is
// required, the same reason the claude-code AgentHost variant does not
// call run() either.
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
import type { ThreadEvent } from "@openai/codex-sdk";
import { CodexHost } from "../src/host.js";
import type { CodexClientLike, CodexThreadLike } from "../src/host.js";

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

function makeHost(): CodexHost {
  return new CodexHost(config, { onState: () => {}, appendSystemPrompt: "p" });
}

/** Reproduces cli.ts's onInterAgentMessage glue exactly — identical to
 *  claude-code's cli.ts (and to the sibling helper in
 *  claude-code/test/inter_agent_lifecycle_glue.test.ts), modulo the host
 *  type. issue #221 direction 1: `mode === "terminal"` now returns
 *  `inject: false` from `receiveInbound()` too, so it is caught by the
 *  same early return as AC9's stale/duplicate case above — the track
 *  still learns `closed`, but no SDK turn is spent on it. Async since
 *  issue #177 review round 2 (ふじ差し戻し) made receiveInbound() async
 *  (it may gate briefly on a concurrently in-flight done=true send for
 *  the same conversation_id). */
async function runOnInterAgentMessageGlue(
  interAgent: InterAgentTool,
  host: CodexHost,
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

describe("issue #177 review M4: adapter-level lifecycle glue (codex)", () => {
  it("AC9: stale/duplicate turn は host.send() を一切呼ばない", async () => {
    const host = makeHost();
    const sendSpy = vi.spyOn(host, "send");
    const tool = new InterAgentTool({
      config,
      getState: () => "tool_running",
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
    const host = makeHost();
    const sendSpy = vi.spyOn(host, "send");
    const tool = new InterAgentTool({
      config,
      getState: () => "tool_running",
      send: () => {},
    });

    const closing = await tool.invoke({
      to: "peer.agent",
      body: "bye",
      kind: "done",
      conversation_id: "cnv-terminal",
      done: true,
    });
    expect(closing.isError).toBeFalsy();

    await runOnInterAgentMessageGlue(
      tool,
      host,
      inboundEnvelope("cnv-terminal", 2, true),
    );

    expect(sendSpy).not.toHaveBeenCalled();
    expect(
      tool.resolveTurnEnd(["cnv-terminal"], { code: "api_error", message: "x" }),
    ).toEqual([]);
  });

  it("対照: reply-owed な inbound は host.send() も notePendingInjection も両方走る", async () => {
    const host = makeHost();
    const sendSpy = vi.spyOn(host, "send");
    const tool = new InterAgentTool({
      config,
      getState: () => "tool_running",
      send: () => {},
    });

    await runOnInterAgentMessageGlue(tool, host, inboundEnvelope("cnv-normal", 1));

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(
      tool.resolveTurnEnd(["cnv-normal"], { code: "api_error", message: "x" }),
    ).toHaveLength(1);
  });
});

/** Holds the CURRENT turn's stream open until the test calls
 *  `releaseNext()` — mirrors claude-code's `makeControllableQueryFn` for
 *  the same reason (see that file's doc): a test needs a way to actually
 *  exercise "busy" (turn in flight) vs "free" (`onTurnEnd` fired), which
 *  is what issue #221 段階3's coalescing trigger depends on, not merely
 *  `host.send()`'s own promise settling.
 *
 *  Release-count based, NOT a single nullable resolver: `CodexHost.run()`
 *  awaits a real fs sweep (`sweepOrphanLocalImages`) before its turn loop
 *  even starts, so a test's `receive()` calls (pure microtask chains, no
 *  I/O) routinely finish and call `releaseNext()` BEFORE `runStreamed()`
 *  has been invoked for turn 1 at all — a naive "resolve the one pending
 *  promise" design silently no-ops on that early call and the turn then
 *  hangs forever waiting for a release that already happened. Banking an
 *  early `releaseNext()` as a pending credit, consumed by the next
 *  `runStreamed()` call before it ever awaits, makes this race-proof. */
function makeControllableClient(): {
  client: CodexClientLike;
  releaseNext: () => void;
} {
  let waiter: (() => void) | null = null;
  let pendingReleases = 0;
  const thread: CodexThreadLike = {
    async runStreamed() {
      async function* gen(): AsyncGenerator<ThreadEvent> {
        if (pendingReleases > 0) {
          pendingReleases -= 1;
        } else {
          await new Promise<void>((resolve) => {
            waiter = resolve;
          });
        }
        yield {
          type: "turn.completed",
          usage: {
            input_tokens: 1,
            cached_input_tokens: 0,
            output_tokens: 1,
            reasoning_output_tokens: 0,
          },
        };
      }
      return { events: gen() };
    },
  };
  const client: CodexClientLike = {
    startThread: () => thread,
    resumeThread: () => thread,
  };
  return {
    client,
    releaseNext: () => {
      if (waiter !== null) {
        const resolve = waiter;
        waiter = null;
        resolve();
      } else {
        pendingReleases += 1;
      }
    },
  };
}

/** Reproduces cli.ts's issue #221 段階3 batching glue exactly — same-peer
 *  FIFO queue per peer, `inFlightPeers` / `inFlightCidPeer` gating on the
 *  turn's OWN completion (`onTurnEnd`), not on `instructionChain`'s promise
 *  (see `@kaoiro/codex/src/cli.ts`'s `trySendNextBatch` for the production
 *  version this test-only copy tracks, and the identical rationale in
 *  claude-code's sibling test file). */
function makeCoalescingHarness(interAgent: InterAgentTool) {
  const pendingBatches = new Map<
    string,
    { items: { envelope: Envelope; mode: InboundReplyMode }[]; bytes: number }[]
  >();
  const inFlightPeers = new Set<string>();
  const inFlightCidPeer = new Map<string, string>();
  const sentBatches: { peer: string; cids: string[] }[] = [];
  let host!: CodexHost;

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
    bindHost: (h: CodexHost) => {
      host = h;
    },
  };
}

describe("issue #221 段階3: 同一peer busy-trigger coalescing (codex glue)", () => {
  it("idle な間に届いた1件は単独 batch のまま即座に turn を起こす", async () => {
    const { client, releaseNext } = makeControllableClient();
    const tool = new InterAgentTool({ config, getState: () => "idle", send: () => {} });
    const harness = makeCoalescingHarness(tool);
    const host = new CodexHost(config, {
      onState: () => {},
      appendSystemPrompt: "p",
      codexFactory: () => client,
      onTurnEnd: (info) => harness.onTurnEnd(info.conversationIds),
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
    const { client, releaseNext } = makeControllableClient();
    const tool = new InterAgentTool({ config, getState: () => "idle", send: () => {} });
    const harness = makeCoalescingHarness(tool);
    const host = new CodexHost(config, {
      onState: () => {},
      appendSystemPrompt: "p",
      codexFactory: () => client,
      onTurnEnd: (info) => harness.onTurnEnd(info.conversationIds),
    });
    harness.bindHost(host);
    void host.run();

    await harness.receive(inboundEnvelope("cnv-1", 1));
    expect(harness.sentBatches).toHaveLength(1);

    await harness.receive(inboundEnvelope("cnv-2", 1));
    await harness.receive(inboundEnvelope("cnv-3", 1));
    expect(harness.sentBatches).toHaveLength(1); // still just turn 1

    releaseNext();
    await vi.waitFor(() => expect(harness.sentBatches).toHaveLength(2));
    expect(harness.sentBatches[1]).toEqual({
      peer: "peer.agent",
      cids: ["cnv-2", "cnv-3"],
    });

    releaseNext();
  });

  it("異なる peer からの到着は互いの batch に混ざらない", async () => {
    const { client, releaseNext } = makeControllableClient();
    const tool = new InterAgentTool({ config, getState: () => "idle", send: () => {} });
    const harness = makeCoalescingHarness(tool);
    const host = new CodexHost(config, {
      onState: () => {},
      appendSystemPrompt: "p",
      codexFactory: () => client,
      onTurnEnd: (info) => harness.onTurnEnd(info.conversationIds),
    });
    harness.bindHost(host);
    void host.run();

    await harness.receive(inboundEnvelope("cnv-a", 1));
    await harness.receive({ ...inboundEnvelope("cnv-b", 1), agent_id: "other.peer" });

    expect(harness.sentBatches).toEqual([
      { peer: "peer.agent", cids: ["cnv-a"] },
      { peer: "other.peer", cids: ["cnv-b"] },
    ]);

    releaseNext();
    releaseNext();
  });

  it("件数上限に達すると batch を締めて次の batch へ持ち越す (捨てない)", async () => {
    const { client, releaseNext } = makeControllableClient();
    const tool = new InterAgentTool({ config, getState: () => "idle", send: () => {} });
    const harness = makeCoalescingHarness(tool);
    const host = new CodexHost(config, {
      onState: () => {},
      appendSystemPrompt: "p",
      codexFactory: () => client,
      onTurnEnd: (info) => harness.onTurnEnd(info.conversationIds),
    });
    harness.bindHost(host);
    void host.run();

    const total = MAX_COALESCED_MESSAGES + 2;
    for (let i = 0; i < total; i++) {
      await harness.receive(inboundEnvelope(`cnv-${i}`, 1));
    }
    expect(harness.sentBatches).toHaveLength(1);

    releaseNext();
    await vi.waitFor(() => expect(harness.sentBatches).toHaveLength(2));
    expect(harness.sentBatches[1]!.cids).toHaveLength(MAX_COALESCED_MESSAGES);

    releaseNext();
    await vi.waitFor(() => expect(harness.sentBatches).toHaveLength(3));
    expect(harness.sentBatches[2]!.cids).toHaveLength(1);

    const allCids = harness.sentBatches.flatMap((b) => b.cids);
    expect(new Set(allCids).size).toBe(total);

    releaseNext();
  });
});
