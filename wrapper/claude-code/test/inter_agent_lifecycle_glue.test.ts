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
  classifyInterAgentError,
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
 *  conversation_id).
 *
 *  issue #222 段階2 差し戻し MF-2 (ふじ): the `!disposition.inject` branch
 *  now mirrors cli.ts's THREE-way split exactly (terminal / notice /
 *  no-notice skip), not a single early `return`. Before this, removing
 *  cli.ts's own `link?.send(disposition.notice)` wiring left every test in
 *  this file green — this helper never touched `disposition.notice` at
 *  all, so it could not have caught that regression. `notices` (when
 *  passed) collects what cli.ts would have handed to `link.send()`, so a
 *  test CAN pin "sink called / not called" the same way `sendSpy` already
 *  pins `host.send()`. */
async function runOnInterAgentMessageGlue(
  interAgent: InterAgentTool,
  host: AgentHost,
  envelope: Envelope,
  notices?: Envelope[],
): Promise<void> {
  const disposition = await interAgent.receiveInbound(envelope);
  if (disposition.consumed) return;
  if (!disposition.inject) {
    if (disposition.mode !== "terminal" && disposition.notice) {
      notices?.push(disposition.notice);
    }
    return;
  }
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
  it("AC9: stale/duplicate turn は host.send() を一切呼ばない (stale_turn notice sink は毎回呼ばれる)", async () => {
    const host = new AgentHost(config, { onState: () => {} });
    const sendSpy = vi.spyOn(host, "send");
    const tool = new InterAgentTool({
      config,
      getState: () => host.state,
      send: () => {},
    });
    const notices: Envelope[] = [];

    await runOnInterAgentMessageGlue(
      tool,
      host,
      inboundEnvelope("cnv-stale", 2),
      notices,
    );
    expect(sendSpy).toHaveBeenCalledTimes(1);
    sendSpy.mockClear();

    // 重複 (直前と同じ turn_number) — SDK 入力に一切触れないが、issue #222
    // 段階2差し戻し MF-2 (ふじ): 通常の stale delivery (payload.error なし、
    // track も未 closed) は毎回 stale_turn notice を生成し、production の
    // `link?.send(disposition.notice)` 配線に相当する `notices` へ積まれる
    // — このテストは元々この notice 経路を一切見ていなかった。
    await runOnInterAgentMessageGlue(
      tool,
      host,
      inboundEnvelope("cnv-stale", 2),
      notices,
    );
    expect(sendSpy).not.toHaveBeenCalled();
    expect(notices).toHaveLength(1);
    expect(
      (notices[0]!.payload as unknown as InterAgentMessagePayload).error?.code,
    ).toBe("stale_turn");

    // 遅延到着 (既知の最大値より低い) も同様。
    await runOnInterAgentMessageGlue(
      tool,
      host,
      inboundEnvelope("cnv-stale", 1),
      notices,
    );
    expect(sendSpy).not.toHaveBeenCalled();
    expect(notices).toHaveLength(2);
  });

  it(
    "issue #222 段階2差し戻し MF-2: stale delivery が notice 対象外のとき " +
      "(それ自体が peer_error / track が既に closed) notice sink は呼ばれない",
    async () => {
      const host = new AgentHost(config, { onState: () => {} });
      const tool = new InterAgentTool({
        config,
        getState: () => host.state,
        send: () => {},
      });
      const notices: Envelope[] = [];

      // track.turnNumber=2 まで進める。
      await runOnInterAgentMessageGlue(tool, host, inboundEnvelope("cnv-stale-exempt", 2));

      // (a) stale delivery 自体が peer_error/stale_turn 通知 — notice を
      // 積むと通知の ping-pong になるため、production 同様スキップされる。
      const errorEnvelope = inboundEnvelope("cnv-stale-exempt", 1);
      (errorEnvelope.payload as unknown as InterAgentMessagePayload).error = {
        code: "stale_turn",
        message: "already sent",
      };
      await runOnInterAgentMessageGlue(tool, host, errorEnvelope, notices);
      expect(notices).toHaveLength(0);

      // (b) track が既に closed — 双方 done=true で terminal にした上で、
      // その後の stale delivery が notice を積まないことを確認する。
      const closeSelf = await tool.invoke({
        to: "peer.agent",
        body: "bye",
        kind: "done",
        conversation_id: "cnv-stale-exempt",
        done: true,
      });
      expect(closeSelf.isError).toBeFalsy();
      // `closeSelf` 自身の pre-dispatch bump で track.turnNumber=3 まで進んで
      // いる (自 sink は accepted 即時解決) — mutual done の peer 側 turn は
      // それより大きい 4 でなければ、この inbound 自体が stale 扱いになって
      // しまう。
      await runOnInterAgentMessageGlue(
        tool,
        host,
        inboundEnvelope("cnv-stale-exempt", 4, true),
      );
      await runOnInterAgentMessageGlue(
        tool,
        host,
        inboundEnvelope("cnv-stale-exempt", 1),
        notices,
      );
      expect(notices).toHaveLength(0);
    },
  );

  it("AC8/issue #221 direction 1: terminal な inbound は host.send() も notePendingInjection も notice sink も呼ばない", async () => {
    const host = new AgentHost(config, { onState: () => {} });
    const sendSpy = vi.spyOn(host, "send");
    const tool = new InterAgentTool({
      config,
      getState: () => host.state,
      send: () => {},
    });
    const notices: Envelope[] = [];

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
      notices,
    );

    expect(sendSpy).not.toHaveBeenCalled();
    expect(notices).toHaveLength(0);

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
 *  Each release lets exactly the NEXT queued turn's result through, with
 *  the given outcome ("success" by default — MF-1's regression test needs
 *  to force a specific turn to end in error). */
function makeControllableQueryFn(): {
  queryFn: QueryFn;
  releaseNext: (outcome?: "success" | "error") => void;
} {
  let release: ((outcome: "success" | "error") => void) | null = null;
  const queryFn = makeQueryFn((args: QueryArgs) => {
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      for await (const _m of args.prompt) {
        const outcome = await new Promise<"success" | "error">((resolve) => {
          release = resolve;
        });
        yield outcome === "error"
          ? msg({
              type: "result",
              subtype: "error_during_execution",
              errors: ["boom"],
            })
          : msg({ type: "result", subtype: "success", result: "ok" });
      }
    }
    return asQuery(gen());
  });
  return {
    queryFn,
    releaseNext: (outcome: "success" | "error" = "success") => {
      release?.(outcome);
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
  /** Envelopes production's onInterAgentMessage/onTurnEnd glue would hand
   *  straight to `link?.send()`, never routed through invoke()/#dispatch():
   *  `resolveTurnEnd()`'s peer_error notices on a failed turn (issue #221
   *  段階3 MF-1's regression test reads this), AND — issue #222 段階2
   *  差し戻し MF-2 (ふじ) — `receiveInbound()`'s AC9 `stale_turn` notices,
   *  pushed by `receive()` below. Both kinds share this one array because
   *  production sends both through the SAME `link?.send()` sink. */
  const notices: Envelope[] = [];
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
    // issue #221 段階3 MF-1 (ふじレビュー差し戻し): register at DISPATCH
    // time — mirrors the production fix in cli.ts's trySendNextBatch. Moved
    // out of receive() below, which used to register at receipt time and
    // let a later batch's same-cid registration clobber an earlier,
    // still-in-flight batch's entry.
    for (const item of batch.items) {
      interAgent.notePendingInjection(item.envelope);
    }
    sentBatches.push({ peer, cids });
    void host.send(formatInboundMessages(batch.items), undefined, cids);
  }

  async function receive(envelope: Envelope): Promise<void> {
    const disposition = await interAgent.receiveInbound(envelope);
    if (disposition.consumed) return;
    if (!disposition.inject) {
      // issue #222 段階2 差し戻し MF-2 (ふじ): mirrors cli.ts's
      // onInterAgentMessage exactly (see `runOnInterAgentMessageGlue`'s
      // doc above for the full three-way split) — before this, `receive()`
      // discarded a `stale_turn` notice the same way, so removing
      // production's `link?.send(disposition.notice)` wiring would not
      // have failed any test using THIS harness either.
      if (disposition.mode !== "terminal" && disposition.notice) {
        notices.push(disposition.notice);
      }
      return;
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

  function onTurnEnd(
    conversationIds: readonly string[],
    error?: { reason?: string; detail?: string },
  ): void {
    const classified = error ? classifyInterAgentError(error) : undefined;
    for (const notice of interAgent.resolveTurnEnd(conversationIds, classified)) {
      notices.push(notice);
    }
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
    notices,
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
      onTurnEnd: (info) => harness.onTurnEnd(info.conversationIds, info.error),
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
      onTurnEnd: (info) => harness.onTurnEnd(info.conversationIds, info.error),
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
      onTurnEnd: (info) => harness.onTurnEnd(info.conversationIds, info.error),
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
      onTurnEnd: (info) => harness.onTurnEnd(info.conversationIds, info.error),
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

  it("MF-1 (ふじレビュー差し戻し): 同一cidのturn1がin-flight中にturn2が次batchへ載る → turn1成功 → turn2失敗でxへpeer_errorが1件出る", async () => {
    const { queryFn, releaseNext } = makeControllableQueryFn();
    const tool = new InterAgentTool({ config, getState: () => "idle", send: () => {} });
    const harness = makeCoalescingHarness(tool);
    const host = new AgentHost(config, {
      onState: () => {},
      onTurnEnd: (info) => harness.onTurnEnd(info.conversationIds, info.error),
      queryFn,
      now: () => "T",
    });
    harness.bindHost(host);
    void host.run();

    // turn 1 (cid=x, turn_number=1) starts immediately — peer was idle.
    await harness.receive(inboundEnvelope("x", 1));
    expect(harness.sentBatches).toEqual([{ peer: "peer.agent", cids: ["x"] }]);

    // Same cid arrives again (turn_number=2) while turn 1 is still
    // in-flight — must accumulate into the NEXT batch, not dispatch yet
    // (AC9 turn_number monotonicity: 2 > 1, so this is accepted, not
    // stale). Before MF-1, receipt-time notePendingInjection() here would
    // already overwrite turn 1's still-pending map entry for "x", even
    // though turn 1 has not completed and this second batch has not even
    // been dispatched yet.
    await harness.receive(inboundEnvelope("x", 2));
    expect(harness.sentBatches).toHaveLength(1);

    // turn 1 completes successfully — resolves turn 1's own pending entry
    // (no notice expected) and flushes the accumulated batch as turn 2.
    releaseNext("success");
    await vi.waitFor(() => expect(harness.sentBatches).toHaveLength(2));
    expect(harness.sentBatches[1]).toEqual({ peer: "peer.agent", cids: ["x"] });
    expect(harness.notices).toHaveLength(0);

    // turn 2 fails — resolveTurnEnd() must find x's entry (registered at
    // turn 2's OWN dispatch under MF-1) and emit exactly 1 peer_error
    // notice. Pre-MF-1, turn 1's success-path resolution above would
    // already have deleted turn 2's not-yet-dispatched entry (receipt-time
    // clobber), silently producing 0 notices here instead.
    releaseNext("error");
    await vi.waitFor(() => expect(harness.notices).toHaveLength(1));
    const payload = harness.notices[0]!.payload as unknown as InterAgentMessagePayload;
    expect(payload.to).toBe("peer.agent");
    expect(payload.conversation_id).toBe("x");
    expect(payload.error).toBeDefined();
  });

  it(
    "issue #222 段階2差し戻し MF-2: stale/duplicate delivery を receive() " +
      "経由で送っても host.send() を呼ばず、代わりに stale_turn notice が " +
      "harness.notices へ積まれる (production の link.send() 相当)",
    async () => {
      const { queryFn, releaseNext } = makeControllableQueryFn();
      const tool = new InterAgentTool({ config, getState: () => "idle", send: () => {} });
      const harness = makeCoalescingHarness(tool);
      const host = new AgentHost(config, {
        onState: () => {},
        onTurnEnd: (info) => harness.onTurnEnd(info.conversationIds, info.error),
        queryFn,
        now: () => "T",
      });
      harness.bindHost(host);
      void host.run();

      await harness.receive(inboundEnvelope("cnv-stale-coalesce", 2));
      expect(harness.sentBatches).toHaveLength(1);

      // 重複到着 — batch には積まれず、代わりに stale_turn notice が
      // production の link.send() 経路相当 (harness.notices) へ積まれる。
      await harness.receive(inboundEnvelope("cnv-stale-coalesce", 2));
      expect(harness.sentBatches).toHaveLength(1); // 変わらず
      expect(harness.notices).toHaveLength(1);
      expect(
        (harness.notices[0]!.payload as unknown as InterAgentMessagePayload)
          .error?.code,
      ).toBe("stale_turn");

      releaseNext();
    },
  );
});
