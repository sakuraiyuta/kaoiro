// Adapter-level integration coverage for issue #177 review M4 (AC8/AC9/
// AC15): executes the production inbound handler (receiveInbound() ->
// disposition branch -> conditional injection) against the REAL CodexHost + REAL
// InterAgentTool, not just InterAgentTool in isolation (which
// inter_agent.test.ts already covers exhaustively). Mirrors
// claude-code/test/inter_agent_lifecycle_glue.test.ts — same glue, same
// assertions, CodexHost in place of AgentHost — to demonstrate AC15
// (both engine adapters share identical lifecycle behaviour) is not just
// a claim about the shared agent-common code but is observably true
// through each engine's own host too. The production handler is imported
// directly. CodexHost.send() only needs to reach its internal
// queue (#queue.push + #wake?.(), host.ts) — no live thread / run() is
// required, the same reason the claude-code AgentHost variant does not
// call run() either.
import { describe, expect, it, vi } from "vitest";
import {
  InterAgentAdmission,
  InterAgentInputLifecycle,
  InterAgentTool,
  DeliveryStageReporter,
  createDeliveryAcknowledgementWiring,
  handoffToolResult,
  MAX_COALESCED_MESSAGES,
  classifyInterAgentError,
} from "@kaoiro/agent-common";
import type {
  Envelope,
  InterAgentMessagePayload,
  WrapperConfig,
} from "@kaoiro/agent-common";
import type { ThreadEvent } from "@openai/codex-sdk";
import type { InterAgentAcceptance } from "@kaoiro/wrapper-core";
import { CodexHost } from "../src/host.js";
import type { CodexClientLike, CodexThreadLike } from "../src/host.js";
import { handleInterAgentMessage } from "../src/inter_agent_message_handler.js";
import { CodexInterAgentTurnCoordinator } from "../src/inter_agent_turn_coordinator.js";

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
  deliverySeq?: number,
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
    ...(deliverySeq === undefined ? {} : { delivery_seq: deliverySeq }),
  } as Envelope;
}

function makeHost(): CodexHost {
  return new CodexHost(config, { onState: () => {}, appendSystemPrompt: "p" });
}

/** Calls the production Codex inbound handler. The callback context supplies
 * only host/transport edges, so its disposition branches cannot drift from
 * the CLI implementation. */
async function runOnInterAgentMessageGlue(
  interAgent: InterAgentTool,
  host: CodexHost,
  envelope: Envelope,
  notices?: Envelope[],
  logs?: string[],
): Promise<void> {
  await handleInterAgentMessage(
    {
      interAgent,
      recordInboundIa: () => {},
      send: (notice) => notices?.push(notice),
      inject: (inbound) => {
        const payload = inbound.payload as unknown as InterAgentMessagePayload;
        const cids =
          typeof payload.conversation_id === "string" ? [payload.conversation_id] : [];
        interAgent.notePendingInjection(inbound, "glue-turn");
        void host.send(`[glue] ${payload.body}`, undefined, cids, "glue-turn").catch(() => {});
      },
      log: (line) => logs?.push(line),
    },
    envelope,
  );
}

describe("issue #177 review M4: adapter-level lifecycle glue (codex)", () => {
  it("AC9: stale/duplicate turn は host.send() を一切呼ばない (stale_turn notice sink は毎回呼ばれる)", async () => {
    const host = makeHost();
    const sendSpy = vi.spyOn(host, "send");
    const tool = new InterAgentTool({
      config,
      getState: () => "tool_running",
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
      const host = makeHost();
      const tool = new InterAgentTool({
        config,
        getState: () => "tool_running",
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
      expect((await tool.receiveInbound(errorEnvelope)).noticeSkipReason).toBe(
        "envelope itself is a peer_error notice",
      );
      const errorLogs: string[] = [];
      await runOnInterAgentMessageGlue(tool, host, errorEnvelope, notices, errorLogs);
      expect(notices).toHaveLength(0);
      expect(errorLogs).toEqual(["  inter_agent_message stale/duplicate, no input: peer.agent\n"]);

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
      const closedStale = inboundEnvelope("cnv-stale-exempt", 1);
      expect((await tool.receiveInbound(closedStale)).noticeSkipReason).toBe(
        "track already closed",
      );
      const closedLogs: string[] = [];
      await runOnInterAgentMessageGlue(tool, host, closedStale, notices, closedLogs);
      expect(notices).toHaveLength(0);
      expect(closedLogs).toEqual(["  inter_agent_message stale/duplicate, no input: peer.agent\n"]);
    },
  );

  it("AC8/issue #221 direction 1: terminal な inbound は host.send() も notePendingInjection も notice sink も呼ばない", async () => {
    const host = makeHost();
    const sendSpy = vi.spyOn(host, "send");
    const tool = new InterAgentTool({
      config,
      getState: () => "tool_running",
      send: () => {},
    });
    const notices: Envelope[] = [];

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
      notices,
    );

    expect(sendSpy).not.toHaveBeenCalled();
    expect(notices).toHaveLength(0);
    expect(
      tool.resolveTurnEnd("glue-turn", ["cnv-terminal"], { code: "api_error", message: "x" }),
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
      tool.resolveTurnEnd("glue-turn", ["cnv-normal"], { code: "api_error", message: "x" }),
    ).toHaveLength(1);
  });

  it("issue #226: production handler は consumed reply を transport に流さない", async () => {
    const sent: Envelope[] = [];
    const injected = vi.fn();
    const logs: string[] = [];
    const acknowledgeDelivery = vi.fn();
    await handleInterAgentMessage(
      {
        interAgent: {
          receiveInbound: async () => ({
            consumed: true,
            inject: false,
            mode: "reply-owed",
          }),
        },
        recordInboundIa: () => {},
        send: (notice) => sent.push(notice),
        acknowledgeDelivery,
        inject: injected,
        log: (line) => logs.push(line),
      },
      inboundEnvelope("cnv-consumed", 1),
    );

    expect(injected).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(acknowledgeDelivery).toHaveBeenCalledWith(expect.any(Object));
    expect(logs).toEqual(["  inter_agent_message reply consumed: peer.agent\n"]);
  });

  it.each(["commit", "rollback"] as const)("waiter reply stage follows the tool-result %s (deferred ack)", async outcome => {
    const reply = inboundEnvelope("waiter-stage", 2, false, 41);
    const reports: Record<string, unknown>[] = [];
    const acknowledgements: Envelope[] = [];
    const returned: Envelope[] = [];
    const stages = new DeliveryStageReporter({
      send: report => { reports.push(report); },
      identity: () => ({ incarnation: "inc", generation: "gen" }),
      turns: { deliveryEnvelopesForTurn: () => [] },
      now: () => "T",
    });
    let tool!: InterAgentTool;
    tool = new InterAgentTool({
      config,
      getState: () => "tool_running",
      send: () => {},
      replyBasisMode: () => "v1",
      returnInput: envelope => { returned.push(envelope); return true; },
      onInputHandoff: (envelopes, token) => {
        for (const envelope of envelopes) acknowledgements.push(envelope);
        stages.submittedEnvelopes(token, envelopes, "tool_result");
      },
      sendInterAgent: async () => {
        queueMicrotask(() => {
          void handleInterAgentMessage({
            interAgent: tool,
            recordInboundIa: () => {},
            send: () => {},
            acknowledgeDelivery: envelope => acknowledgements.push(envelope),
            reportQueued: envelope => stages.queued(envelope),
            settleStage: (envelope, reason) => stages.settleEnvelope(envelope, reason),
            inject: () => { throw new Error("waiter reply must not enter the root queue"); },
            log: () => {},
          }, reply);
        });
        return { kind: "accepted", stamp: [1, 1] };
      },
    });
    tool.beginReplyInput("tool-turn");
    const result = await tool.invoke({
      to: "peer.agent",
      conversation_id: "waiter-stage",
      kind: "query",
      body: "question",
      wait_for_response: true,
      timeout_ms: 500,
    }, { origin: { token: "tool-turn" } });

    expect(reports.map(report => report.stage)).toEqual(["queued"]);
    expect(acknowledgements).toEqual([]);
    if (outcome === "commit") {
      expect(handoffToolResult(result, () => {})).toBe(true);
      expect(acknowledgements).toEqual([reply]);
      expect(reports.map(report => report.stage)).toEqual(["queued", "submitted"]);
      expect(reports.at(-1)).toMatchObject({ handoff: "tool_result" });
      stages.settled("tool-turn");
      expect(reports.at(-1)).toMatchObject({ stage: "settled", reason: "turn_end" });
    } else {
      expect(() => handoffToolResult(result, () => { throw new Error("write failed"); })).toThrow("write failed");
      expect(returned).toEqual([reply]);
      expect(acknowledgements).toEqual([]);
      expect(reports.map(report => report.stage)).toEqual(["queued"]);
    }
    tool.endReplyInput("tool-turn");
  });

  it("issue #226: production handler は terminal inbound を明示して注入しない", async () => {
    const injected = vi.fn();
    const logs: string[] = [];
    const acknowledgeDelivery = vi.fn();
    await handleInterAgentMessage(
      {
        interAgent: {
          receiveInbound: async () => ({
            consumed: false,
            inject: false,
            mode: "terminal",
          }),
        },
        recordInboundIa: () => {},
        send: () => {},
        acknowledgeDelivery,
        inject: injected,
        log: (line) => logs.push(line),
      },
      inboundEnvelope("cnv-terminal-branch", 1),
    );

    expect(injected).not.toHaveBeenCalled();
    expect(acknowledgeDelivery).toHaveBeenCalledWith(expect.any(Object));
    expect(logs).toEqual(["  inter_agent_message terminal, no input: peer.agent\n"]);
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
 *  `runStreamed()` call before it ever awaits, makes this race-proof.
 *
 *  `releaseNext(outcome)` also picks which terminal event the released turn
 *  yields — "success" (default) a `turn.completed`, "error" a `turn.failed`
 *  — so MF-1's regression test can force a specific turn to end in error. */
function makeControllableClient(): {
  client: CodexClientLike;
  releaseNext: (outcome?: "success" | "error") => void;
} {
  let waiter: ((outcome: "success" | "error") => void) | null = null;
  const pendingReleases: ("success" | "error")[] = [];
  const thread: CodexThreadLike = {
    async runStreamed() {
      async function* gen(): AsyncGenerator<ThreadEvent> {
        const outcome =
          pendingReleases.length > 0
            ? pendingReleases.shift()!
            : await new Promise<"success" | "error">((resolve) => {
                waiter = resolve;
              });
        yield outcome === "error"
          ? { type: "turn.failed", error: { message: "boom" } }
          : {
              type: "turn.completed",
              usage: {
                input_tokens: 1,
                cached_input_tokens: 0,
                output_tokens: 1,
                reasoning_output_tokens: 0,
                cache_write_input_tokens: 0,
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
    releaseNext: (outcome: "success" | "error" = "success") => {
      if (waiter !== null) {
        const resolve = waiter;
        waiter = null;
        resolve(outcome);
      } else {
        pendingReleases.push(outcome);
      }
    },
  };
}

/** Adapter harness around the production Codex batching coordinator. */
function makeCoalescingHarness(interAgent: InterAgentTool) {
  const sentBatches: { peer: string; cids: string[] }[] = [];
  /** Envelopes production's onInterAgentMessage/onTurnEnd glue would hand
   *  straight to `link?.send()`, never routed through invoke()/#dispatch():
   *  `resolveTurnEnd()`'s peer_error notices on a failed turn (issue #221
   *  段階3 MF-1's regression test reads this), AND — issue #222 段階2
   *  差し戻し MF-2 (ふじ) — `receiveInbound()`'s AC9 `stale_turn` notices,
   *  pushed by `receive()` below. Both kinds share this one array because
   *  production sends both through the SAME `link?.send()` sink. */
  const notices: Envelope[] = [];
  const deliveryAcks: number[] = [];
  let host!: CodexHost;
  const coordinator = new CodexInterAgentTurnCoordinator({
    inputLifecycle: interAgent.inputLifecycle,
    onDispatch: (batch) => {
      for (const item of batch.items) {
        interAgent.notePendingInjection(item.envelope, batch.turnToken);
      }
      sentBatches.push({ peer: batch.peer, cids: [...batch.conversationIds] });
      void host.send(batch.text, undefined, batch.conversationIds, batch.turnToken);
    },
  });
  const deliveryAcknowledgementWiring = createDeliveryAcknowledgementWiring(
    (seq) => deliveryAcks.push(seq),
    coordinator,
  );
  deliveryAcknowledgementWiring.onInterAgentDeliveryStatus({ acked_seq: 0 });

  async function receive(envelope: Envelope): Promise<void> {
    await handleInterAgentMessage(
      {
        interAgent,
        recordInboundIa: () => {},
        send: (notice) => notices.push(notice),
        acknowledgeDelivery: deliveryAcknowledgementWiring.acknowledgeDelivery,
        inject: (inbound, mode, reservation) => { coordinator.receive(inbound, mode, reservation); },
        log: () => {},
      },
      envelope,
    );
  }

  function onTurnStart(turnToken: string): void {
    coordinator.handoff(turnToken, "exec_input_written");
    deliveryAcknowledgementWiring.onTurnStart(turnToken);
  }

  function onTurnEnd(
    turnToken: string,
    conversationIds: readonly string[],
    error?: { reason?: string; detail?: string },
  ): void {
    const classified = error ? classifyInterAgentError(error) : undefined;
    for (const notice of interAgent.resolveTurnEnd(turnToken, conversationIds, classified)) {
      notices.push(notice);
    }
    const settled = coordinator.settle(turnToken, { kind: "abandoned", reason: "test_cleanup" });
    if (settled !== undefined) {
      coordinator.dispatchNextForPeer(settled.peer);
    }
  }

  return {
    receive,
    onTurnEnd,
    sentBatches,
    notices,
    deliveryAcks,
    onTurnStart,
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
      onTurnEnd: (info) => harness.onTurnEnd(info.turnToken, info.conversationIds, info.error),
    });
    harness.bindHost(host);
    void host.run();

    await harness.receive(inboundEnvelope("cnv-solo", 1));
    expect(harness.sentBatches).toEqual([
      { peer: "peer.agent", cids: ["cnv-solo"] },
    ]);

    releaseNext();
  });

  it("issue #247: inject は coordinator 受理時でなく実 SDK turn start で ack する", async () => {
    const { client, releaseNext } = makeControllableClient();
    const tool = new InterAgentTool({ config, getState: () => "idle", send: () => {} });
    const harness = makeCoalescingHarness(tool);
    const host = new CodexHost(config, {
      onState: () => {},
      appendSystemPrompt: "p",
      codexFactory: () => client,
      onTurnStart: ({ turnToken }) => harness.onTurnStart(turnToken),
      onTurnEnd: (info) => harness.onTurnEnd(info.turnToken, info.conversationIds, info.error),
    });
    harness.bindHost(host);

    await harness.receive(inboundEnvelope("cnv-delivery-start", 1, false, 1));
    expect(harness.deliveryAcks).toEqual([]);

    void host.run();
    await vi.waitFor(() => expect(harness.deliveryAcks).toEqual([1]));
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
      onTurnEnd: (info) => harness.onTurnEnd(info.turnToken, info.conversationIds, info.error),
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
      onTurnEnd: (info) => harness.onTurnEnd(info.turnToken, info.conversationIds, info.error),
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
      onTurnEnd: (info) => harness.onTurnEnd(info.turnToken, info.conversationIds, info.error),
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

  it("MF-1 (ふじレビュー差し戻し): 同一cidのturn1がin-flight中にturn2が次batchへ載る → turn1成功 → turn2失敗でxへpeer_errorが1件出る", async () => {
    const { client, releaseNext } = makeControllableClient();
    const tool = new InterAgentTool({ config, getState: () => "idle", send: () => {} });
    const harness = makeCoalescingHarness(tool);
    const host = new CodexHost(config, {
      onState: () => {},
      appendSystemPrompt: "p",
      codexFactory: () => client,
      onTurnEnd: (info) => harness.onTurnEnd(info.turnToken, info.conversationIds, info.error),
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
      const { client, releaseNext } = makeControllableClient();
      const tool = new InterAgentTool({ config, getState: () => "idle", send: () => {} });
      const harness = makeCoalescingHarness(tool);
      const host = new CodexHost(config, {
        onState: () => {},
        appendSystemPrompt: "p",
        codexFactory: () => client,
        onTurnEnd: (info) => harness.onTurnEnd(info.turnToken, info.conversationIds, info.error),
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
describe("queued inbound mode is rechecked at Codex dispatch", () => {
  function rig(sendInterAgent?: (envelope: Envelope) => Promise<InterAgentAcceptance>) {
    const tool = new InterAgentTool({
      config,
      getState: () => "idle",
      send: () => {},
      ...(sendInterAgent === undefined ? {} : { sendInterAgent }),
    });
    const dispatched: Array<{ turnToken: string; text: string; cids: readonly string[]; items: readonly { envelope: Envelope; mode: string }[] }> = [];
    const suppressed: Array<{ cid: unknown; mode: string }> = [];
    const acknowledgements: number[] = [];
    let nextToken = 0;
    const coordinator = new CodexInterAgentTurnCoordinator({
      createTurnToken: () => `queued-${++nextToken}`,
      reclassifyQueued: (item) => tool.queuedInboundMode(item.envelope, item.mode),
      onTerminalQueued: (item) => {
        suppressed.push({ cid: item.envelope.payload.conversation_id, mode: item.mode });
        delivery.acknowledgeDelivery(item.envelope);
      },
      onDispatch: (batch) => dispatched.push({
        turnToken: batch.turnToken,
        text: batch.text,
        cids: batch.conversationIds,
        items: batch.items,
      }),
    });
    const delivery = createDeliveryAcknowledgementWiring(
      (seq) => acknowledgements.push(seq), coordinator,
    );
    delivery.onInterAgentDeliveryStatus({ acked_seq: 0 });
    const receive = (envelope: Envelope) => handleInterAgentMessage({
      interAgent: tool,
      recordInboundIa: () => {},
      send: () => {},
      acknowledgeDelivery: delivery.acknowledgeDelivery,
      inject: (inbound, mode) => { coordinator.receive(inbound, mode); },
      log: () => {},
    }, envelope);
    const advance = () => {
      const first = coordinator.settle(dispatched[0]!.turnToken, { kind: "abandoned", reason: "test_cleanup" });
      expect(first).toBeDefined();
      if (first) coordinator.dispatchNextForPeer(first.peer);
    };
    return { tool, receive, advance, dispatched, suppressed, acknowledgements,
      get tokensCreated() { return nextToken; },
      start: (token: string) => delivery.onTurnStart(token),
    };
  }

  it("acks an old close proposal without another SDK turn or delivery retirement", async () => {
    const r = rig();
    await r.receive(inboundEnvelope("cid-close", 2, true, 1));
    await r.receive(inboundEnvelope("cid-close", 3, true, 2));
    expect((await r.tool.invoke({ to: "peer.agent", kind: "done", body: "done", conversation_id: "cid-close", done: true })).isError).toBeFalsy();
    r.start(r.dispatched[0]!.turnToken);
    r.advance();
    expect(r.dispatched).toHaveLength(1);
    expect(r.tokensCreated).toBe(1);
    expect(r.suppressed).toEqual([{ cid: "cid-close", mode: "close-proposal" }]);
    expect(r.acknowledgements).toEqual([1, 2]);
  });

  it("keeps an open close proposal actionable", async () => {
    const r = rig();
    await r.receive(inboundEnvelope("cid-open", 2, true));
    await r.receive(inboundEnvelope("cid-open", 3, true));
    r.advance();
    expect(r.dispatched[1]?.text).toContain("the peer signalled done=true");
    expect(r.suppressed).toEqual([]);
  });

  it("does not discard while local done is pending and later rejected", async () => {
    let rejectSend: ((value: InterAgentAcceptance) => void) | undefined;
    const r = rig(() => new Promise((resolve) => { rejectSend = resolve; }));
    await r.receive(inboundEnvelope("cid-pending", 2, true));
    await r.receive(inboundEnvelope("cid-pending", 3, true));
    const pending = r.tool.invoke({ to: "peer.agent", kind: "done", body: "done", conversation_id: "cid-pending", done: true });
    await vi.waitFor(() => expect(rejectSend).toBeDefined());
    r.advance();
    expect(r.dispatched[1]?.text).toContain("the peer signalled done=true");
    rejectSend!({ kind: "rejected", reason: "stale_turn" });
    expect((await pending).isError).toBe(true);
    expect(r.suppressed).toEqual([]);
  });

  it("filters a closed item from a mixed batch while preserving the other delivery", async () => {
    const r = rig();
    await r.receive(inboundEnvelope("active", 1, false, 1));
    await r.receive(inboundEnvelope("closed", 1, true, 2));
    await r.receive(inboundEnvelope("open", 1, false, 3));
    await r.tool.invoke({ to: "peer.agent", kind: "done", body: "done", conversation_id: "closed", done: true });
    r.start(r.dispatched[0]!.turnToken);
    r.advance();
    expect(r.dispatched[1]?.cids).toEqual(["open"]);
    expect(r.dispatched[1]?.text).toContain("conversation_id=open");
    expect(r.dispatched[1]?.text).not.toContain("conversation_id=closed");
    expect(r.suppressed).toEqual([{ cid: "closed", mode: "close-proposal" }]);
    expect(r.acknowledgements).toEqual([1, 2]);
    r.start(r.dispatched[1]!.turnToken);
    expect(r.acknowledgements).toEqual([1, 2, 3]);
  });

  it.each(["mutual", "synthetic"] as const)("drops queued reply-owed after %s closure", async (closure) => {
    const r = rig();
    await r.receive(inboundEnvelope("active", 1));
    await r.receive(inboundEnvelope("later", 1, false));
    if (closure === "mutual") {
      await r.tool.invoke({ to: "peer.agent", kind: "done", body: "done", conversation_id: "later", done: true });
      await r.receive(inboundEnvelope("later", 3, true));
    } else {
      const synthetic = inboundEnvelope("later", 0, true);
      synthetic.agent_id = "server";
      await r.receive(synthetic);
    }
    r.advance();
    expect(r.dispatched).toHaveLength(1);
    expect(r.suppressed).toEqual([{ cid: "later", mode: "reply-owed" }]);
  });
});

describe("receiver overload handler settlement", () => {
  it("notifies before acknowledging a refused delivery and keeps accepted work queued", async () => {
    const notices: Envelope[] = [];
    const injected: Envelope[] = [];
    const acknowledged: Envelope[] = [];
    const stages: string[] = [];
    const retired = vi.fn(() => true);
    const overloadConfig = { ...config, inter_agent_backlog_max_items: 1 };
    const inputLifecycle = new InterAgentInputLifecycle({
      maxPendingItems: 1,
      currentIdentity: () => ({ incarnation: "inc", generation: "gen" }),
      sendNotice: async notice => { notices.push(notice); return "accepted"; },
      acknowledgeDelivery: envelope => { acknowledged.push(envelope); },
      settleStage: (_envelope, reason) => { stages.push(reason); },
    });
    const tool = new InterAgentTool({
      inputLifecycle,
      config: overloadConfig,
      getState: () => "thinking",
      replyBasisMode: () => "v1",
      send: () => {},
      sendInterAgent: async () => ({ kind: "accepted", stamp: null }),
    });
    const receive = (item: Envelope) => handleInterAgentMessage({
      interAgent: tool,
      recordInboundIa: () => {},
      send: () => {},
      acknowledgeDelivery: item => acknowledged.push(item),
      retirementCapability: () => "supported",
      retireDelivery: retired,
      settleStage: (_item, reason) => stages.push(reason),
      inject: item => { injected.push(item); },
      log: () => {},
    }, item);
    const first = inboundEnvelope("overload-handler", 1, false, 10);
    const refused = inboundEnvelope("overload-handler", 2, false, 11);

    await receive(first);
    await receive(refused);

    expect(injected).toEqual([first]);
    expect(notices).toHaveLength(1);
    expect((notices[0]!.payload as unknown as InterAgentMessagePayload).error?.code).toBe("receiver_overloaded");
    expect(acknowledged).toEqual([refused]);
    expect(retired).not.toHaveBeenCalled();
    expect(stages).toEqual(["receiver_overloaded"]);
    expect(tool.inputLifecycle.reservationFor(first)).toBeDefined();
  });

  it("bounds a null-tool fallback with the production shared admission instance", async () => {
    const admission = new InterAgentAdmission(1);
    const earlier = inboundEnvelope("null-tool-earlier", 1, false, 20);
    const reservation = admission.admit(earlier);
    expect(reservation.kind).toBe("reserved");
    const acknowledged: Envelope[] = [];
    const injected: Envelope[] = [];
    const retired = vi.fn(() => true);
    const refused = inboundEnvelope("null-tool-refused", 1, false, 21);

    await handleInterAgentMessage({
      interAgent: null,
      inputLifecycle: new InterAgentInputLifecycle({
        admission,
        currentIdentity: () => ({ incarnation: "inc", generation: "gen" }),
        retirementCapability: () => "supported",
        acknowledgeDelivery: item => acknowledged.push(item),
        retireDelivery: retired,
      }),
      recordInboundIa: () => {},
      send: () => {},
      acknowledgeDelivery: item => acknowledged.push(item),
      inject: item => { injected.push(item); },
      log: () => {},
    }, refused);

    expect(injected).toEqual([]);
    expect(retired).toHaveBeenCalledWith(refused);
    expect(acknowledged).toEqual([]);
    expect(admission.counts().total).toBe(1);
  });
});
