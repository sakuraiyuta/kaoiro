// Adapter-level integration coverage for issue #177 review M4 (AC8/AC9/
// AC15) and issue #221 direction 1: executes the production inbound handler
// (receiveInbound() -> disposition branch -> conditional injection) against the REAL
// AgentHost + REAL InterAgentTool, not just InterAgentTool in isolation
// (which inter_agent.test.ts already covers exhaustively). Mirrors the
// harness style of inter_agent_injection_failure.test.ts (issue #136). The
// handler is a production module with explicit transport/coordinator edges,
// so this test imports and invokes it directly.
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
  DeliveryAcknowledgement,
  MAX_COALESCED_MESSAGES,
  classifyInterAgentError,
} from "@kaoiro/agent-common";
import type {
  Envelope,
  InterAgentMessagePayload,
  WrapperConfig,
} from "@kaoiro/agent-common";
import type { InterAgentAcceptance } from "@kaoiro/wrapper-core";
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { AgentHost } from "../src/host.js";
import type { AgentHostOptions } from "../src/host.js";
import { handleInterAgentMessage } from "../src/inter_agent_message_handler.js";
import {
  InterAgentIngressGate,
  InterAgentTurnCoordinator,
} from "../src/inter_agent_turn_coordinator.js";

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

/** Calls the production Claude inbound handler. The test controls only its
 * transport and injection edges; every disposition branch is production code. */
async function runOnInterAgentMessageGlue(
  interAgent: InterAgentTool,
  host: AgentHost,
  envelope: Envelope,
  notices?: Envelope[],
  logs?: string[],
): Promise<void> {
  await handleInterAgentMessage(
    {
      interAgent,
      ingress: new InterAgentIngressGate(),
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
      expect((await tool.receiveInbound(errorEnvelope)).noticeSkipReason).toBe(
        "envelope itself is a peer_error notice",
      );
      const errorLogs: string[] = [];
      await runOnInterAgentMessageGlue(tool, host, errorEnvelope, notices, errorLogs);
      expect(notices).toHaveLength(0);
      expect(errorLogs).toEqual([
        "  inter_agent_message stale/duplicate turn dropped, no notice " +
          "(envelope itself is a peer_error notice): peer.agent\n",
      ]);

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
      expect(closedLogs).toEqual([
        "  inter_agent_message stale/duplicate turn dropped, no notice " +
          "(track already closed): peer.agent\n",
      ]);
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
      tool.resolveTurnEnd("glue-turn", ["cnv-terminal"], { code: "api_error", message: "x" }),
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
        ingress: new InterAgentIngressGate(),
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
        ingress: new InterAgentIngressGate(),
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
    expect(logs).toEqual(["  inter_agent_message terminal, no reply owed: peer.agent\n"]);
  });

  it("issue #226: close 済み ingress は receive 前に handler が止まり lease を完了する", async () => {
    const ingress = new InterAgentIngressGate();
    ingress.close();
    const receiveInbound = vi.fn(async () => ({
      consumed: false as const,
      inject: true as const,
      mode: "reply-owed" as const,
    }));
    const recordInboundIa = vi.fn();
    const send = vi.fn();
    const inject = vi.fn();
    const acknowledgeDelivery = vi.fn();
    const logs: string[] = [];
    const finish = vi.spyOn(ingress, "finish");

    await handleInterAgentMessage(
      {
        interAgent: { receiveInbound },
        ingress,
        recordInboundIa,
        send,
        acknowledgeDelivery,
        inject,
        log: (line) => logs.push(line),
      },
      inboundEnvelope("cnv-pre-await-terminal", 1),
    );

    expect(recordInboundIa).toHaveBeenCalledTimes(1);
    expect(receiveInbound).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(inject).not.toHaveBeenCalled();
    expect(acknowledgeDelivery).toHaveBeenCalledWith(expect.any(Object));
    expect(logs).toEqual([
      "  inter_agent_message terminal ingress skipped before receive: peer.agent\n",
    ]);
    expect(finish).toHaveBeenCalledTimes(1);
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
  let queuedOutcome: "success" | "error" | null = null;
  const queryFn = makeQueryFn((args: QueryArgs) => {
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      for await (const _m of args.prompt) {
        const outcome =
          queuedOutcome ??
          (await new Promise<"success" | "error">((resolve) => {
            release = resolve;
          }));
        queuedOutcome = null;
        release = null;
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
      if (release !== null) {
        release(outcome);
        release = null;
      } else {
        queuedOutcome = outcome;
      }
    },
  };
}

/** Adapter glue around the production turn coordinator. Batch ownership and
 * same-peer scheduling are deliberately NOT reproduced here: issue #246
 * extracted that state into InterAgentTurnCoordinator so these tests exercise
 * the same implementation used by cli.ts. */
function makeCoalescingHarness(interAgent: InterAgentTool) {
  const sentBatches: { peer: string; cids: string[] }[] = [];
  const terminalIngressSkips: string[] = [];
  /** Envelopes production's onInterAgentMessage/onTurnEnd glue would hand
   *  straight to `link?.send()`, never routed through invoke()/#dispatch():
   *  `resolveTurnEnd()`'s peer_error notices on a failed turn (issue #221
   *  段階3 MF-1's regression test reads this), AND — issue #222 段階2
   *  差し戻し MF-2 (ふじ) — `receiveInbound()`'s AC9 `stale_turn` notices,
   *  pushed by `receive()` below. Both kinds share this one array because
   *  production sends both through the SAME `link?.send()` sink. */
  const notices: Envelope[] = [];
  const deliveryAcks: number[] = [];
  const deliveryAcknowledgement = new DeliveryAcknowledgement((seq) => deliveryAcks.push(seq));
  deliveryAcknowledgement.observe({ acked_seq: 0 });
  let host!: AgentHost;
  let tokenSequence = 0;
  let watchdogFailStopped = false;
  let sessionResetCalls = 0;
  const ingressGate = new InterAgentIngressGate();
  const coordinator = new InterAgentTurnCoordinator({
    createTurnToken: () => `test-token-${++tokenSequence}`,
    onDispatch: (batch) => {
      for (const item of batch.items) {
        interAgent.notePendingInjection(item.envelope, batch.turnToken);
      }
      sentBatches.push({ peer: batch.peer, cids: [...batch.conversationIds] });
      void host.send(
        batch.text,
        undefined,
        batch.conversationIds,
        batch.turnToken,
      );
    },
  });

  async function receive(envelope: Envelope): Promise<void> {
    await handleInterAgentMessage(
      {
        interAgent,
        ingress: ingressGate,
        recordInboundIa: () => {},
        send: (notice) => notices.push(notice),
        acknowledgeDelivery: deliveryAcknowledgement.acknowledgeEnvelope,
        inject: (inbound, mode) => coordinator.receive(inbound, mode),
        log: (line) => terminalIngressSkips.push(line),
      },
      envelope,
    );
  }

  function onTurnStart(turnToken: string): void {
    deliveryAcknowledgement.acknowledgeTurnStart(turnToken, coordinator);
  }

  function onTurnEnd(
    turnToken: string | undefined,
    error?: { reason?: string; detail?: string },
    cancellation?: {
      kind: "stream_eof" | "watchdog_fail_stop";
      started: boolean;
    },
  ): void {
    if (turnToken === undefined) return;
    const settlement = coordinator.settle(turnToken);
    if (settlement.kind !== "settled") return;
    const classified = error ? classifyInterAgentError(error) : undefined;
    for (const notice of interAgent.resolveTurnEnd(
      settlement.batch.turnToken,
      settlement.batch.conversationIds,
      classified,
    )) {
      notices.push(notice);
    }
    if (cancellation === undefined && !watchdogFailStopped) {
      coordinator.dispatchNextForPeer(settlement.batch.peer);
      sessionResetCalls += 1;
    }
  }

  function onWatchdogFailStop(turnToken: string | undefined): void {
    watchdogFailStopped = true;
    ingressGate.close();
    coordinator.freezeForWatchdogFailStop(turnToken);
  }

  function onHostEnd(error: { reason?: string; detail?: string }): void {
    ingressGate.close();
    for (const batch of coordinator.closeAndDrain()) {
      for (const item of batch.items) {
        interAgent.notePendingInjection(item.envelope, batch.turnToken);
      }
      const classified = classifyInterAgentError(error);
      for (const notice of interAgent.resolveTurnEnd(
        batch.turnToken,
        batch.conversationIds,
        classified,
      )) {
        notices.push(notice);
      }
    }
  }

  return {
    receive,
    onTurnEnd,
    onHostEnd,
    sentBatches,
    notices,
    deliveryAcks,
    onTurnStart,
    get sessionResetCalls(): number {
      return sessionResetCalls;
    },
    terminalIngressSkips,
    onWatchdogFailStop,
    bindHost: (h: AgentHost) => {
      host = h;
    },
  };
}

describe("issue #221 段階3: 同一peer busy-trigger coalescing (claude-code glue)", () => {
  it("idle な間に届いた1件は単独 batch のまま即座に turn を起こす", async () => {
    const { queryFn, releaseNext } = makeControllableQueryFn();
    const tool = new InterAgentTool({
      config,
      getState: () => "idle",
      send: () => {},
    });
    const harness = makeCoalescingHarness(tool);
    const host = new AgentHost(config, {
      onState: () => {},
      onTurnEnd: (info) => harness.onTurnEnd(info.turnToken, info.error),
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

  it("issue #247: inject は coordinator 受理時でなく実 SDK turn start で ack する", async () => {
    const { queryFn, releaseNext } = makeControllableQueryFn();
    const tool = new InterAgentTool({ config, getState: () => "idle", send: () => {} });
    const harness = makeCoalescingHarness(tool);
    const host = new AgentHost(config, {
      onState: () => {},
      onTurnStart: ({ turnToken }) => harness.onTurnStart(turnToken),
      onTurnEnd: (info) => harness.onTurnEnd(info.turnToken, info.error),
      queryFn,
      now: () => "T",
    });
    harness.bindHost(host);

    await harness.receive(inboundEnvelope("cnv-delivery-start", 1, false, 1));
    expect(harness.deliveryAcks).toEqual([]);

    void host.run();
    await vi.waitFor(() => expect(harness.deliveryAcks).toEqual([1]));
    releaseNext();
  });

  it("issue #246: EOF は active を解決後、coordinator pending の failure notice を link close 前に enqueue する", async () => {
    let firstInputRead!: () => void;
    const firstInput = new Promise<void>((resolve) => {
      firstInputRead = resolve;
    });
    let endStream!: () => void;
    const streamHeld = new Promise<void>((resolve) => {
      endStream = resolve;
    });
    const queryFn = makeQueryFn((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await args.prompt[Symbol.asyncIterator]().next();
        firstInputRead();
        await streamHeld;
        // EOF with no ResultMessage for the active batch.
      }
      return asQuery(gen());
    });
    const tool = new InterAgentTool({ config, getState: () => "idle", send: () => {} });
    const harness = makeCoalescingHarness(tool);
    const host = new AgentHost(config, {
      onState: () => {},
      onTurnEnd: (info) =>
        harness.onTurnEnd(info.turnToken, info.error, info.cancellation),
      onHostEnd: (info) => harness.onHostEnd(info.error),
      queryFn,
      now: () => "T",
    });
    harness.bindHost(host);
    const done = host.run();

    await harness.receive(inboundEnvelope("cid-a", 1));
    await firstInput;
    // Same CID's later generation remains coordinator-owned, not host-queued,
    // when EOF occurs. This also proves terminal draining resolves the active
    // generation before registering/resolving its FIFO successor.
    await harness.receive(inboundEnvelope("cid-a", 2));
    expect(harness.sentBatches).toEqual([
      { peer: "peer.agent", cids: ["cid-a"] },
    ]);

    endStream();
    await done;

    expect(harness.sentBatches).toEqual([
      { peer: "peer.agent", cids: ["cid-a"] },
    ]);
    expect(
      harness.notices.map(
        (notice) =>
          (notice.payload as unknown as InterAgentMessagePayload).conversation_id,
      ),
    ).toEqual(["cid-a", "cid-a"]);
    for (const notice of harness.notices) {
      const payload = notice.payload as unknown as InterAgentMessagePayload;
      expect(payload.error?.code).toBeDefined();
    }
  });

  it("issue #246: pending-done gate 中に EOF なら late ingress は coordinator へ渡さず正常終了する", async () => {
    let resolveAcceptance!: (acceptance: InterAgentAcceptance) => void;
    const acceptance = new Promise<InterAgentAcceptance>((resolve) => {
      resolveAcceptance = resolve;
    });
    const tool = new InterAgentTool({
      config,
      getState: () => "idle",
      send: () => {},
      sendInterAgent: () => acceptance,
    });
    const harness = makeCoalescingHarness(tool);
    let endStream!: () => void;
    const streamHeld = new Promise<void>((resolve) => {
      endStream = resolve;
    });
    const queryFn = makeQueryFn(() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await streamHeld;
        // EOF while the transport's fire-and-forget handler is awaiting
        // InterAgentTool#pendingDoneAcks for this CID.
      }
      return asQuery(gen());
    });
    const host = new AgentHost(config, {
      onState: () => {},
      onTurnEnd: (info) =>
        harness.onTurnEnd(info.turnToken, info.error, info.cancellation),
      onHostEnd: (info) => harness.onHostEnd(info.error),
      queryFn,
      now: () => "T",
    });
    harness.bindHost(host);
    const hostDone = host.run();

    // The outbound done=true call creates InterAgentTool's per-CID gate.
    // `receive()` has already taken the production ingress lease before its
    // own first await, but remains held at receiveInbound() below.
    const outboundDone = tool.invoke({
      to: "peer.agent",
      body: "bye",
      kind: "done",
      conversation_id: "cid-ingress-gate",
      done: true,
    });
    await Promise.resolve();
    const receiving = harness.receive(inboundEnvelope("cid-ingress-gate", 1, false, 1));
    // Production transport deliberately drops this Promise. Observe its
    // outcome without awaiting it, so a coordinator-closed exception would
    // surface as the unhandled-rejection failure this regression prevents.
    let ingressSettled = false;
    let ingressFailure: unknown;
    void receiving.then(
      () => {
        ingressSettled = true;
      },
      (error: unknown) => {
        ingressFailure = error;
        ingressSettled = true;
      },
    );
    await Promise.resolve();
    expect(harness.sentBatches).toEqual([]);

    // Terminal teardown closes the ingress generation before coordinator
    // draining and before the delayed receiveInbound() can resume.
    endStream();
    await hostDone;
    resolveAcceptance({ kind: "accepted", stamp: null });

    const outboundResult = await outboundDone;
    expect(outboundResult.isError).toBeUndefined();
    await Promise.resolve();
    expect(ingressSettled).toBe(true);
    expect(ingressFailure).toBeUndefined();
    expect(harness.sentBatches).toEqual([]);
    expect(harness.terminalIngressSkips).toEqual([
      "  inter_agent_message terminal ingress skipped after receive: peer.agent\n",
    ]);
    expect(harness.deliveryAcks).toEqual([1]);
  });

  it("turn が in-flight な間に同一peerから連続到着したメッセージは次の turn へ合流する", async () => {
    const { queryFn, releaseNext } = makeControllableQueryFn();
    const tool = new InterAgentTool({ config, getState: () => "idle", send: () => {} });
    const harness = makeCoalescingHarness(tool);
    const host = new AgentHost(config, {
      onState: () => {},
      onTurnEnd: (info) => harness.onTurnEnd(info.turnToken, info.error),
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
      onTurnEnd: (info) => harness.onTurnEnd(info.turnToken, info.error),
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
      onTurnEnd: (info) => harness.onTurnEnd(info.turnToken, info.error),
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
      onTurnEnd: (info) => harness.onTurnEnd(info.turnToken, info.error),
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

  it("issue #248: fail-stop は active A・host queue B・same-peer pending C を凍結し、late A 終端で successor / reset / CID 二重resolve を起こさない", async () => {
    const { queryFn, releaseNext } = makeControllableQueryFn();
    const tool = new InterAgentTool({ config, getState: () => "idle", send: () => {} });
    const harness = makeCoalescingHarness(tool);
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const host = new AgentHost(config, {
      onState: () => {},
      onTurnStart: () => started(),
      onTurnEnd: (info) =>
        harness.onTurnEnd(info.turnToken, info.error, info.cancellation),
      onWatchdogFailStop: (info) => harness.onWatchdogFailStop(info.turnToken),
      onHostEnd: (info) => harness.onHostEnd(info.error),
      queryFn,
      now: () => "T",
    });
    harness.bindHost(host);
    const done = host.run();

    // A is active. Different-peer B can already be coordinator-dispatched
    // and host-queued, while same-peer C remains coordinator-pending.
    await harness.receive(inboundEnvelope("cid-a", 1));
    await startedPromise;
    await harness.receive({ ...inboundEnvelope("cid-b", 1), agent_id: "peer-b" });
    await harness.receive(inboundEnvelope("cid-a", 2));
    expect(harness.sentBatches).toEqual([
      { peer: "peer.agent", cids: ["cid-a"] },
      { peer: "peer-b", cids: ["cid-b"] },
    ]);

    expect(host.failStopTurnForWatchdog("test-token-1")).toBe(true);
    // B was never yielded, so it receives one exact failure notice. C never
    // becomes dispatchable: because A's cid is still unresolved, C must not
    // overwrite/resolve A's pending injection speculatively.
    expect(harness.notices).toHaveLength(1);
    expect(
      (harness.notices[0]!.payload as unknown as InterAgentMessagePayload)
        .conversation_id,
    ).toBe("cid-b");

    releaseNext("success");
    await done;
    expect(harness.sentBatches).toHaveLength(2);
    expect(harness.notices).toHaveLength(1);
    expect(harness.sessionResetCalls).toBe(0);
    // A's success cleared only A. C was never registered behind the unknown
    // active cid, so no delayed second resolve can manufacture a duplicate.
    expect(
      tool.resolveTurnEnd("test-token-1", ["cid-a"], { code: "api_error", message: "late" }),
    ).toEqual([]);
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
        onTurnEnd: (info) => harness.onTurnEnd(info.turnToken, info.error),
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
