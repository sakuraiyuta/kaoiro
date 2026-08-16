import { describe, expect, it, vi } from "vitest";
import {
  INTER_AGENT_TOOL_FQN,
  InterAgentTool,
  LIST_AGENTS_TOOL_FQN,
  MAX_COALESCED_BYTES,
  MAX_COALESCED_MESSAGES,
  WHOAMI_TOOL_FQN,
  canAddToCoalescedBatch,
  classifyInterAgentError,
  formatInboundMessage,
  formatInboundMessages,
  isFormattedInterAgentMessage,
  type WhoamiSnapshot,
} from "../src/inter_agent.js";
import type {
  DirectoryEntry,
  InterAgentAcceptance,
  UserDirectoryEntry,
} from "@kaoiro/wrapper-core";
import type {
  Envelope,
  InterAgentErrorPayload,
  InterAgentMessagePayload,
  WrapperConfig,
} from "../src/types.js";

const PERSONA = { id: "mio", name: "澪", sprite_set: "mio" };
const TEST_TURN_TOKEN = "test-turn";

function configFor(agentId: string): WrapperConfig {
  return {
    agent_id: agentId,
    persona: PERSONA,
    display_name: PERSONA.name,
    server_url: "ws://localhost:4000/wrapper",
  };
}

interface Capture {
  envelopes: Envelope[];
  ids: string[];
  state: () => "tool_running";
  newId: () => string;
}

function makeTool(agentId: string): { tool: InterAgentTool; capture: Capture } {
  const capture: Capture = {
    envelopes: [],
    ids: [],
    state: () => "tool_running",
    newId: () => {
      const id = `cnv-${capture.envelopes.length}`;
      capture.ids.push(id);
      return id;
    },
  };
  const tool = new InterAgentTool({
    config: configFor(agentId),
    getState: capture.state,
    getActiveInterAgentTurnToken: () => TEST_TURN_TOKEN,
    send: (env) => capture.envelopes.push(env),
    now: () => "2026-06-29T12:34:56Z",
    newId: capture.newId,
  });
  return { tool, capture };
}

function notePending(tool: InterAgentTool, envelope: Envelope, turnToken = TEST_TURN_TOKEN): void {
  tool.notePendingInjection(envelope, turnToken);
}

function resolveTurn(
  tool: InterAgentTool,
  conversationIds: readonly string[],
  error?: InterAgentErrorPayload,
  turnToken = TEST_TURN_TOKEN,
): Envelope[] {
  return tool.resolveTurnEnd(turnToken, conversationIds, error);
}

function inboundEnvelope(
  conversationId: string,
  kind: InterAgentMessagePayload["kind"] = "response",
  error?: InterAgentErrorPayload,
  from = "peer.agent",
): Envelope {
  return {
    version: "0",
    agent_id: from,
    persona: PERSONA,
    display_name: PERSONA.name,
    ts: "2026-07-23T12:00:00Z",
    type: "inter_agent_message",
    state: "tool_running",
    payload: {
      to: "self.agent",
      conversation_id: conversationId,
      turn_number: 2,
      kind,
      body: "peer reply body",
      meta: { done: false, propose_next: "review this reply" },
      owner: { kind: "user", id: "operator" },
      ...(error ? { error } : {}),
    },
    ext: {},
  };
}

// Direct dispatch via the public invoke() entry point — the same handler the
// SDK MCP wiring runs once the operator approves the call. Going through
// invoke instead of the SDK transport keeps the test deterministic and
// independent of MCP plumbing.
async function callTool(
  tool: InterAgentTool,
  args: Parameters<InterAgentTool["invoke"]>[0],
): Promise<{ result: Awaited<ReturnType<InterAgentTool["invoke"]>> }> {
  return { result: await tool.invoke(args) };
}

describe("InterAgentTool", () => {
  it("exposes the SDK-side tool name as mcp__kaoiro__send_to_agent", () => {
    expect(INTER_AGENT_TOOL_FQN).toBe("mcp__kaoiro__send_to_agent");
  });

  it("conversation_id 未指定で新規 UUID を割当て、turn_number=1 を採番する", async () => {
    const { tool, capture } = makeTool("agent-a");
    const { result } = await callTool(tool, {
      to: "agent-b",
      body: "やあ",
      kind: "inform",
    });
    expect(result.isError).toBeFalsy();
    expect(capture.envelopes).toHaveLength(1);
    const env = capture.envelopes[0]!;
    expect(env.type).toBe("inter_agent_message");
    expect(env.agent_id).toBe("agent-a");
    expect(env.state).toBe("tool_running");
    const payload = env.payload as unknown as InterAgentMessagePayload;
    expect(payload.to).toBe("agent-b");
    expect(payload.turn_number).toBe(1);
    expect(payload.conversation_id).toBe(capture.ids[0]);
    expect(payload.owner).toEqual({ kind: "user", id: "operator" });
    expect(result.content[0]?.text).toContain(payload.conversation_id);
  });

  it("同じ conversation_id を再利用すると turn_number が単調増加する", async () => {
    const { tool, capture } = makeTool("agent-a");
    await callTool(tool, {
      to: "agent-b",
      body: "Q",
      kind: "query",
      conversation_id: "cnv-shared",
    });
    await callTool(tool, {
      to: "agent-b",
      body: "Q2",
      kind: "query",
      conversation_id: "cnv-shared",
    });
    expect(
      (capture.envelopes[0]!.payload as unknown as InterAgentMessagePayload)
        .turn_number,
    ).toBe(1);
    expect(
      (capture.envelopes[1]!.payload as unknown as InterAgentMessagePayload)
        .turn_number,
    ).toBe(2);
  });

  it("observeInbound で記録された turn_number 以降にローカル送信が並ぶ", async () => {
    const { tool, capture } = makeTool("agent-a");
    tool.observeInbound("cnv-x", 7); // ピアから 7 ターンまで受信済
    await callTool(tool, {
      to: "agent-b",
      body: "返信",
      kind: "response",
      conversation_id: "cnv-x",
    });
    expect(
      (capture.envelopes[0]!.payload as unknown as InterAgentMessagePayload)
        .turn_number,
    ).toBe(8);
  });

  it("wait_for_response は同一conversationの次inboundをtool resultへ返し二重注入用に消費する", async () => {
    const { tool, capture } = makeTool("self.agent");
    const pending = callTool(tool, {
      to: "peer.agent",
      body: "please reply",
      kind: "request",
      conversation_id: "cnv-wait",
      wait_for_response: true,
      timeout_ms: 1_000,
    });

    expect(capture.envelopes).toHaveLength(1);
    const inbound = inboundEnvelope("cnv-wait");
    expect((await tool.receiveInbound(inbound)).consumed).toBe(true);
    // issue #177 AC9: the exact same envelope delivered again is now also a
    // stale/duplicate turn_number (<= the one just observed) — dropped, not
    // just "not consumed". issue #222 欠陥3: since the duplicate is an
    // ordinary (non-error) envelope on a still-open track, a stale_turn
    // notice is also built — asserted separately below (its exact
    // envelope shape is covered by the dedicated stale-drop tests).
    const dup = await tool.receiveInbound(inbound);
    expect(dup.consumed).toBe(false);
    expect(dup.inject).toBe(false);
    expect(dup.mode).toBe("reply-owed");
    expect(dup.notice).toBeDefined();

    const { result } = await pending;
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      sent: { to: "peer.agent", conversation_id: "cnv-wait", turn_number: 1 },
      reply: inbound,
    });
  });

  it("wait_for_response timeout は送信ackとreply_pendingを返し、遅延inboundは通常注入用に残す", async () => {
    vi.useFakeTimers();
    try {
      const { tool } = makeTool("self.agent");
      const pending = callTool(tool, {
        to: "peer.agent",
        body: "please reply",
        kind: "query",
        conversation_id: "cnv-timeout",
        wait_for_response: true,
      });

      await vi.advanceTimersByTimeAsync(300_000);
      const { result } = await pending;
      expect(result.content[0]!.text).toContain("sent to peer.agent");
      expect(result.content[0]!.text).toContain("reply_pending=true");
      expect(result.content[0]!.text).toContain("timeout_ms=300000");
      expect(
        (await tool.receiveInbound(inboundEnvelope("cnv-timeout"))).consumed,
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("複数conversationと同tick timeout/reply の勝者を独立に確定する (#114 A1)", async () => {
    vi.useFakeTimers();
    try {
      const { tool } = makeTool("self.agent");
      let aConsumed = false;
      let bConsumed = true;
      // Registered before A's waiter: at the exact 1000ms boundary the reply
      // wins. B's reply is registered after its waiter: timeout wins.
      setTimeout(() => {
        void tool.receiveInbound(inboundEnvelope("cnv-a")).then((d) => {
          aConsumed = d.consumed;
        });
      }, 1_000);
      const timeoutFirst = callTool(tool, {
        to: "peer.agent", body: "A", kind: "query", conversation_id: "cnv-a",
        wait_for_response: true, timeout_ms: 1_000,
      });
      const replyFirst = callTool(tool, {
        to: "peer.agent", body: "B", kind: "query", conversation_id: "cnv-b",
        wait_for_response: true, timeout_ms: 1_000,
      });
      await Promise.resolve();
      setTimeout(() => {
        void tool.receiveInbound(inboundEnvelope("cnv-b")).then((d) => {
          bConsumed = d.consumed;
        });
      }, 1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(aConsumed).toBe(true);
      expect(bConsumed).toBe(false);
      expect((await timeoutFirst).result.content[0]!.text).toContain('"reply"');
      expect((await replyFirst).result.content[0]!.text).toContain("reply_pending=true");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    "request",
    "response",
    "query",
    "inform",
    "propose",
    "accept",
    "reject",
    "escalate-to-user",
    "done",
  ] as const)("全kindでwait_for_response入力schemaを受理する: %s", async (kind) => {
    const { tool } = makeTool("self.agent");
    const args = {
      to: "peer.agent",
      body: "schema coverage",
      kind,
      wait_for_response: false,
    };
    const result = await tool.invoke(
      kind === "reject" ? { ...args, reject_reason: "reason" } : args,
    );
    expect(result.isError).toBeFalsy();
  });

  it("自分自身を to に指定するとエラー結果を返し envelope を出さない", async () => {
    const { tool, capture } = makeTool("agent-a");
    const { result } = await callTool(tool, {
      to: "agent-a",
      body: "x",
      kind: "inform",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("cannot send to self");
    expect(capture.envelopes).toHaveLength(0);
  });

  it("kind=reject で reject_reason 欠落はエラーを返す", async () => {
    const { tool, capture } = makeTool("agent-a");
    const { result } = await callTool(tool, {
      to: "agent-b",
      body: "ng",
      kind: "reject",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("reject_reason");
    expect(capture.envelopes).toHaveLength(0);
  });

  it("wait_for_response は payload.error 付き inbound を peer_error として返し reply とは判別する (#131)", async () => {
    const { tool } = makeTool("self.agent");
    const pending = callTool(tool, {
      to: "peer.agent",
      body: "please reply",
      kind: "request",
      conversation_id: "cnv-err",
      wait_for_response: true,
      timeout_ms: 1_000,
    });

    const inbound = inboundEnvelope("cnv-err", "inform", {
      code: "rate_limit",
      message: "peer hit its rate limit",
    });
    expect((await tool.receiveInbound(inbound)).consumed).toBe(true);

    const { result } = await pending;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.reply).toBeUndefined();
    expect(parsed.peer_error).toEqual({
      code: "rate_limit",
      message: "peer hit its rate limit",
      from: "peer.agent",
    });
  });

  it("optional フィールド(confidence/reject_reason/propose_next)を payload.meta に反映する", async () => {
    const { tool, capture } = makeTool("agent-a");
    await callTool(tool, {
      to: "agent-b",
      body: "対案",
      kind: "reject",
      reject_reason: "ベンチ未収束",
      confidence: 0.4,
      propose_next: "別案を検討",
      done: true,
    });
    const meta = (
      capture.envelopes[0]!.payload as unknown as InterAgentMessagePayload
    ).meta;
    expect(meta.confidence).toBe(0.4);
    expect(meta.reject_reason).toBe("ベンチ未収束");
    expect(meta.propose_next).toBe("別案を検討");
    expect(meta.done).toBe(true);
  });
});

describe("issue #177: conversation lifecycle (done / close-proposal / terminal / stale / TTL)", () => {
  function doneInbound(conversationId: string, turnNumber: number): Envelope {
    const env = inboundEnvelope(conversationId, "inform");
    (env.payload as unknown as InterAgentMessagePayload).turn_number = turnNumber;
    (env.payload as unknown as InterAgentMessagePayload).meta = {
      done: true,
      propose_next: "",
    };
    return env;
  }

  it("peer 側のみの done=true は close-proposal (AC7): 返信はまだ owed", async () => {
    const { tool } = makeTool("self.agent");
    const disposition = await tool.receiveInbound(doneInbound("cnv-close", 1));
    expect(disposition).toEqual({
      consumed: false,
      inject: true,
      mode: "close-proposal",
    });
  });

  it("両側 done で terminal になり、以後の同一 CID 送信は AC10 で tool error", async () => {
    const { tool } = makeTool("self.agent");
    // 自分側が先に done=true を送信 (makeTool は sendInterAgent 未配線 =
    // fire-and-forget accepted 扱い)。
    const closing = await tool.invoke({
      to: "peer.agent",
      body: "bye",
      kind: "done",
      conversation_id: "cnv-terminal",
      done: true,
    });
    expect(closing.isError).toBeFalsy();

    // peer 側も done=true (turn_number は invoke() が消費した 1 より大きく
    // ないと stale 判定に落ちる)。両側揃って terminal。
    const disposition = await tool.receiveInbound(doneInbound("cnv-terminal", 2));
    expect(disposition).toEqual({
      consumed: false,
      // issue #221 direction 1: terminal owes no reply, so it must not be
      // injected into the SDK either — the track above already learned
      // `closed`, which is the actionable part.
      inject: false,
      mode: "terminal",
    });

    // AC10: closed CID を指定した send_to_agent は tool error。
    const retry = await tool.invoke({
      to: "peer.agent",
      body: "again?",
      kind: "inform",
      conversation_id: "cnv-terminal",
    });
    expect(retry.isError).toBe(true);
    expect(retry.content[0]!.text).toContain("already closed");

    // CID 省略なら新規 conversation として送信できる。
    const fresh = await tool.invoke({
      to: "peer.agent",
      body: "new one",
      kind: "inform",
    });
    expect(fresh.isError).toBeFalsy();
  });

  it("stale/duplicate turn_number は inject されない (AC9)", async () => {
    const { tool } = makeTool("self.agent");
    const first = inboundEnvelope("cnv-stale", "inform");
    (first.payload as unknown as InterAgentMessagePayload).turn_number = 3;
    expect(await tool.receiveInbound(first)).toEqual({
      consumed: false,
      inject: true,
      mode: "reply-owed",
    });

    // 同じ turn_number の再送 (duplicate) は stale。issue #222 欠陥3: 通常の
    // (非エラー) envelope・非closed trackなので stale_turn notice が付く —
    // notice 自体の形は専用テストで確認する。
    const duplicate = await tool.receiveInbound(first);
    expect(duplicate.consumed).toBe(false);
    expect(duplicate.inject).toBe(false);
    expect(duplicate.mode).toBe("reply-owed");
    expect(duplicate.notice).toBeDefined();

    // それより低い turn_number (out-of-order な遅延到着) も stale。
    const earlier = inboundEnvelope("cnv-stale", "inform");
    (earlier.payload as unknown as InterAgentMessagePayload).turn_number = 2;
    const late = await tool.receiveInbound(earlier);
    expect(late.consumed).toBe(false);
    expect(late.inject).toBe(false);
    expect(late.mode).toBe("reply-owed");
    expect(late.notice).toBeDefined();
  });

  it("issue #225: error notice の stale drop は agent-common が skip 理由を返す", async () => {
    const { tool } = makeTool("self.agent");
    const first = inboundEnvelope("cnv-stale-error-notice", "inform");
    (first.payload as unknown as InterAgentMessagePayload).turn_number = 2;
    await tool.receiveInbound(first);

    const staleError = inboundEnvelope("cnv-stale-error-notice", "inform");
    (staleError.payload as unknown as InterAgentMessagePayload).turn_number = 1;
    (staleError.payload as unknown as InterAgentMessagePayload).error = {
      code: "stale_turn",
      message: "already sent",
    };

    expect(await tool.receiveInbound(staleError)).toEqual({
      consumed: false,
      inject: false,
      mode: "reply-owed",
      noticeSkipReason: "envelope itself is a peer_error notice",
    });
  });

  it("server 合成 envelope (agent_id=server) の turn_number=0 は stale 判定から除外される (Stage 4)", async () => {
    const { tool } = makeTool("self.agent");
    const first = inboundEnvelope("cnv-synth", "inform");
    (first.payload as unknown as InterAgentMessagePayload).turn_number = 5;
    await tool.receiveInbound(first);

    const synth = inboundEnvelope("cnv-synth", "escalate-to-user");
    synth.agent_id = "server";
    (synth.payload as unknown as InterAgentMessagePayload).turn_number = 0;
    expect((await tool.receiveInbound(synth)).inject).toBe(true);
  });

  it("peer が agent_id=server を伴わず turn_number=0 を自称しても synthetic 扱いしない " +
       "(review must-fix M1: provenance を見ずに 0 だけで判定しない)", async () => {
    const { tool } = makeTool("self.agent");
    const first = inboundEnvelope("cnv-forged", "inform");
    (first.payload as unknown as InterAgentMessagePayload).turn_number = 3;
    await tool.receiveInbound(first);

    // agent_id は既定の "peer.agent" のまま — server ではない。
    const forged = inboundEnvelope("cnv-forged", "escalate-to-user");
    (forged.payload as unknown as InterAgentMessagePayload).turn_number = 0;
    (forged.payload as unknown as InterAgentMessagePayload).meta = {
      done: true,
      propose_next: "",
    };
    // isSynthetic は false になるので turn_number=0 <= track.turnNumber(3)
    // により stale として drop される — server=open のまま、この wrapper
    // 側だけが closed になる split-brain を起こさない。issue #222 欠陥3:
    // 通常の envelope・非closed track なので stale_turn notice も付く。
    const disposition = await tool.receiveInbound(forged);
    expect(disposition.consumed).toBe(false);
    expect(disposition.inject).toBe(false);
    expect(disposition.mode).toBe("reply-owed");
    expect(disposition.notice).toBeDefined();
  });

  it("issue #222 欠陥3: 既に closed な track への stale 到着は notice を" +
       "生成しない(遅延到着であり再送も再同期対象も無いため)", async () => {
    const { tool } = makeTool("self.agent");

    // 両側 done で terminal・closed にする。
    const closing = await tool.invoke({
      to: "peer.agent",
      body: "bye",
      kind: "done",
      conversation_id: "cnv-closed-stale",
      done: true,
    });
    expect(closing.isError).toBeFalsy();
    const peerDone = inboundEnvelope("cnv-closed-stale", "done");
    (peerDone.payload as unknown as InterAgentMessagePayload).turn_number = 2;
    (peerDone.payload as unknown as InterAgentMessagePayload).meta = {
      done: true,
      propose_next: "",
    };
    expect((await tool.receiveInbound(peerDone)).mode).toBe("terminal");

    // closed 後に届いた古い(stale な)遅延到着 — 通常の非エラー envelope
    // だが、track が既に closed なので notice は生成されない。stale
    // 判定自体は closed 判定より前に走るため mode は "terminal" ではなく
    // "reply-owed" のまま(AC9 と同じ経路)。
    const lateStale = inboundEnvelope("cnv-closed-stale", "inform");
    (lateStale.payload as unknown as InterAgentMessagePayload).turn_number = 1;
    const disposition = await tool.receiveInbound(lateStale);
    expect(disposition.inject).toBe(false);
    expect(disposition.mode).toBe("reply-owed");
    expect(disposition.notice).toBeUndefined();
    expect(disposition.noticeSkipReason).toBe("track already closed");
  });

  it("hard-limit の server 合成 escalate (agent_id=server, turn_number=0, done=true) は " +
       "terminal になり AC10 も働く (review must-fix)", async () => {
    const { tool } = makeTool("self.agent");
    // Neither side has sent done=true yet — a hard limit tripping on an
    // otherwise-open conversation, the common case in practice.
    const escalate = inboundEnvelope("cnv-hardlimit", "escalate-to-user");
    escalate.agent_id = "server";
    (escalate.payload as unknown as InterAgentMessagePayload).turn_number = 0;
    (escalate.payload as unknown as InterAgentMessagePayload).meta = {
      done: true,
      propose_next: "",
    };
    const disposition = await tool.receiveInbound(escalate);
    expect(disposition).toEqual({
      consumed: false,
      // issue #221 direction 1: terminal (including a server-synthesized
      // hard-limit close) owes no reply, so it is not injected either.
      inject: false,
      mode: "terminal",
    });

    // The server already tombstoned this conversation_id (Stage 1); the
    // local AC10 guard must reject a further send on it too, without a
    // round-trip.
    const retry = await tool.invoke({
      to: "peer.agent",
      body: "still there?",
      kind: "inform",
      conversation_id: "cnv-hardlimit",
    });
    expect(retry.isError).toBe(true);
    expect(retry.content[0]!.text).toContain("already closed");
  });

  it("markerLine は mode ごとに文言が変わり、全モードで isFormattedInterAgentMessage を満たす", () => {
    const closeProposalText = formatInboundMessage(doneInbound("cnv-mode", 1), {
      mode: "close-proposal",
    });
    expect(closeProposalText).toContain("proposing to close");
    expect(closeProposalText).not.toContain("to reply, call send_to_agent");
    expect(isFormattedInterAgentMessage(closeProposalText)).toBe(true);

    const terminalText = formatInboundMessage(doneInbound("cnv-mode", 1), {
      mode: "terminal",
    });
    expect(terminalText).toContain("now closed");
    expect(terminalText).not.toContain("to reply, call send_to_agent");
    expect(isFormattedInterAgentMessage(terminalText)).toBe(true);
  });

  it("closed track は TTL 経過後に GC され、同一 CID を新規会話として再利用できる", async () => {
    let clock = 0;
    const tool = new InterAgentTool({
      config: configFor("self.agent"),
      getState: () => "tool_running",
      send: () => {},
      now: () => "2026-08-08T00:00:00Z",
      newId: () => "cnv-fresh",
      nowMs: () => clock,
    });

    const closing = await tool.invoke({
      to: "peer.agent",
      body: "bye",
      kind: "done",
      conversation_id: "cnv-ttl",
      done: true,
    });
    expect(closing.isError).toBeFalsy();
    await tool.receiveInbound(doneInbound("cnv-ttl", 2));

    // まだ TTL 内: AC10 の closed 拒否が働く。
    const stillClosed = await tool.invoke({
      to: "peer.agent",
      body: "again",
      kind: "inform",
      conversation_id: "cnv-ttl",
    });
    expect(stillClosed.isError).toBe(true);

    // closed_at からの TTL (24h) を超えて経過させる。
    clock += 24 * 60 * 60 * 1000 + 1;

    // TTL 超過後は closed track が prune され、同じ CID を新規会話として
    // 送信できる — 完了済み conversation_id の永久ブロックにならない。
    const reused = await tool.invoke({
      to: "peer.agent",
      body: "new conversation, same id",
      kind: "inform",
      conversation_id: "cnv-ttl",
    });
    expect(reused.isError).toBeFalsy();
  });

  it("M3: closed track は maxClosedTracks を超えると最も古いものから evict される " +
       "(review must-fix, AC6)", async () => {
    let clock = 0;
    const tool = new InterAgentTool({
      config: configFor("self.agent"),
      getState: () => "tool_running",
      send: () => {},
      now: () => "2026-08-08T00:00:00Z",
      newId: () => "cnv-auto",
      nowMs: () => clock,
      maxClosedTracks: 2,
    });

    for (const cid of ["cnv-a", "cnv-b", "cnv-c"]) {
      clock += 1;
      const closing = await tool.invoke({
        to: "peer.agent",
        body: "x",
        kind: "done",
        conversation_id: cid,
        done: true,
      });
      expect(closing.isError).toBeFalsy();
      await tool.receiveInbound(doneInbound(cid, 2));
    }

    // 3 件 close させたが上限 2 件 — 最も古い cnv-a は evict され、CID は
    // 新規会話として再利用できる (完了済み扱いのまま残らない)。
    const oldest = await tool.invoke({
      to: "peer.agent",
      body: "y",
      kind: "inform",
      conversation_id: "cnv-a",
    });
    expect(oldest.isError).toBeFalsy();

    // 新しい 2 件 (cnv-b, cnv-c) はまだ closed のまま evict されない。
    const stillClosed = await tool.invoke({
      to: "peer.agent",
      body: "y",
      kind: "inform",
      conversation_id: "cnv-c",
    });
    expect(stillClosed.isError).toBe(true);
  });

  it(
    "M3: reject された brand-new conversation は turn_number が新規扱いに戻る " +
      "(review must-fix, AC6) — issue #175 review round 4: reject は " +
      "whitelist を確立しない (ふじ 条件 A)",
    async () => {
      const tool = new InterAgentTool({
        config: configFor("self.agent"),
        getState: () => "tool_running",
        send: () => {
          throw new Error("acceptance-aware sink must be used");
        },
        sendInterAgent: () =>
          Promise.resolve({ kind: "rejected", reason: "unknown_agent" }),
        now: () => "2026-08-08T00:00:00Z",
        newId: () => "cnv-auto",
      });

      const first = await tool.invoke({
        to: "peer.agent",
        body: "hi",
        kind: "inform",
        conversation_id: "cnv-phantom",
      });
      expect(first.isError).toBe(true);

      // turn_number が生きていれば turn_number=1 は既知の max として残るので
      // stale 判定されるはず。AC6 の reset により新規会話扱いに戻っていれば
      // stale にならない(= 拒否された brand-new 送信の turn_number は
      // 残らない)。
      const inbound = inboundEnvelope("cnv-phantom", "inform");
      (inbound.payload as unknown as InterAgentMessagePayload).turn_number = 1;
      expect((await tool.receiveInbound(inbound)).inject).toBe(true);

      // issue #175 review round 4 (ふじ design-review approve, #211 条件
      // A — 意図的に反転したアサーション): a rejected send never
      // establishes the whitelist under the round-4 design — only a
      // server-ACCEPTED ack does (see `autoAllowedPeer`'s doc comment).
      // Rounds 1-3 optimistically wrote it pre-dispatch and needed this
      // exact AC6 reset to "survive" a rejection; round 4 removes the
      // write itself, so there is nothing left to survive (failure
      // history: #211 comment 2715).
      expect(tool.isConversationAutoAllowed("cnv-phantom", "peer.agent")).toBe(false);
    },
  );

  it(
    "issue #175 review round 2: 同一 conversation_id への 2 回目以降の reject " +
      "retry でも turn_number は新規扱いに戻り続ける",
    async () => {
      const tool = new InterAgentTool({
        config: configFor("self.agent"),
        getState: () => "tool_running",
        send: () => {
          throw new Error("acceptance-aware sink must be used");
        },
        sendInterAgent: () =>
          Promise.resolve({ kind: "rejected", reason: "unknown_agent" }),
        now: () => "2026-08-08T00:00:00Z",
        newId: () => "cnv-auto",
      });

      // Two rejected sends on the SAME explicit conversation_id — the
      // round-1 fix's gate (`!trackExistedBefore`, map presence) reset
      // the track only on the FIRST rejection: after the reset left the
      // (blanked) track in the map instead of deleting it, the SECOND
      // call read `trackExistedBefore=true` and skipped the reset
      // entirely, leaving turn_number stuck at 1 forever. The fixed gate
      // (`wasBlank`, reading track fields instead of map presence) must
      // reset on every repeated failed retry, not just the first.
      await tool.invoke({
        to: "peer.agent",
        body: "hi",
        kind: "inform",
        conversation_id: "cnv-retry",
      });
      const second = await tool.invoke({
        to: "peer.agent",
        body: "hi again",
        kind: "inform",
        conversation_id: "cnv-retry",
      });
      expect(second.isError).toBe(true);

      // A genuine inbound turn_number=1 must still be accepted (not
      // dropped as a stale duplicate of the second rejected attempt's
      // own turn_number=1).
      const inbound = inboundEnvelope("cnv-retry", "inform");
      (inbound.payload as unknown as InterAgentMessagePayload).turn_number = 1;
      expect((await tool.receiveInbound(inbound)).inject).toBe(true);

      // issue #175 review round 4 (ふじ 条件 A): neither rejection ever
      // wrote the whitelist — both attempts were rejected, so
      // `autoAllowedPeer` was never set for this conversation_id at all.
      expect(tool.isConversationAutoAllowed("cnv-retry", "peer.agent")).toBe(false);
    },
  );

  // issue #177 review round 2 M3 ("open track の unbounded 経路"):
  // #pruneClosedTracks() only ever prunes tracks this wrapper itself
  // learned were CLOSED. The server's own periodic GC does not push a
  // tombstone notice to this wrapper when it closes a conversation on its
  // own (issue #209, deferred), so a track this wrapper never learned was
  // closed stayed OPEN — and therefore un-prunable — for the life of the
  // process. Mutation-tested: with #pruneStaleOpenTracks() removed, the
  // final assertion fails (turn_number=3, continuing the sequence, instead
  // of resetting to 1) — confirmed manually before finalizing.
  it(
    "round2 M3: OPEN track は idle TTL を超えると evict され、turn_number が " +
      "リセットされる (open track の unbounded 経路, review must-fix)",
    async () => {
      let clock = 0;
      const tool = new InterAgentTool({
        config: configFor("self.agent"),
        getState: () => "tool_running",
        send: () => {},
        now: () => "2026-08-08T00:00:00Z",
        newId: () => "cnv-auto",
        nowMs: () => clock,
      });

      const first = await tool.invoke({
        to: "peer.agent",
        body: "hi",
        kind: "inform",
        conversation_id: "cnv-open-idle",
      });
      expect(first.isError).toBeFalsy();
      expect(first.content[0]!.text).toContain("turn_number=1");

      // まだ TTL 内: 同じ track が生きているので turn_number は単調増加。
      const stillAlive = await tool.invoke({
        to: "peer.agent",
        body: "hi again",
        kind: "inform",
        conversation_id: "cnv-open-idle",
      });
      expect(stillAlive.content[0]!.text).toContain("turn_number=2");

      // OPEN track の idle TTL (24h) を超えて経過させる — 何も送受信しない
      // まま放置された open conversation を模す(server 側の tombstone 通知
      // は #209 まで届かない前提)。
      clock += 24 * 60 * 60 * 1000 + 1;

      // track が evict されていれば、turn_number は 1 から採番し直される —
      // ローカルの bookkeeping を失う代わりに map が無制限に育たない
      // (こはく承認済みの trade-off)。
      const afterIdle = await tool.invoke({
        to: "peer.agent",
        body: "hi once more",
        kind: "inform",
        conversation_id: "cnv-open-idle",
      });
      expect(afterIdle.isError).toBeFalsy();
      expect(afterIdle.content[0]!.text).toContain("turn_number=1");
    },
  );

  // Mutation-tested (my-code-review-cycle guard-shaped-fix rule): with
  // #enforceTrackCap() removed, the "oldest" assertion fails (turn_number=2,
  // continuing the sequence, instead of resetting to 1) — confirmed manually
  // before finalizing.
  it(
    "round2 M3: OPEN + CLOSED 合算の総数が maxTracks を超えると最も古い " +
      "track から evict される (open track の unbounded 経路, review " +
      "must-fix)",
    async () => {
      let clock = 0;
      const tool = new InterAgentTool({
        config: configFor("self.agent"),
        getState: () => "tool_running",
        send: () => {},
        now: () => "2026-08-08T00:00:00Z",
        newId: () => "cnv-auto",
        nowMs: () => clock,
        maxTracks: 2,
      });

      // 3 件、いずれも accepted / done=false のまま OPEN で残る経路。
      for (const cid of ["cnv-o1", "cnv-o2", "cnv-o3"]) {
        clock += 1;
        const opened = await tool.invoke({
          to: "peer.agent",
          body: "hi",
          kind: "inform",
          conversation_id: cid,
        });
        expect(opened.isError).toBeFalsy();
      }

      // 上限 2 件 — 最も古い cnv-o1 は evict され、turn_number は 1 から
      // 採番し直される。
      const oldest = await tool.invoke({
        to: "peer.agent",
        body: "again",
        kind: "inform",
        conversation_id: "cnv-o1",
      });
      expect(oldest.content[0]!.text).toContain("turn_number=1");

      // 新しい cnv-o3 はまだ残っている — turn_number は継続して 2。
      const newer = await tool.invoke({
        to: "peer.agent",
        body: "again",
        kind: "inform",
        conversation_id: "cnv-o3",
      });
      expect(newer.content[0]!.text).toContain("turn_number=2");
    },
  );
});

describe("pending-injection error notices (issue #131, turn-scoped resolveTurnEnd)", () => {
  it("resolveTurnEnd は notePendingInjection 済みの conversation を送信元宛の envelope にして返す", () => {
    const { tool, capture } = makeTool("self.agent");
    notePending(tool, inboundEnvelope("cnv-pending"));

    const notices = resolveTurn(tool, ["cnv-pending"], {
      code: "context_overflow",
      message: "prompt too long",
    });

    expect(capture.envelopes).toHaveLength(0); // resolveTurnEnd returns, doesn't send
    expect(notices).toHaveLength(1);
    const payload = notices[0]!.payload as unknown as InterAgentMessagePayload;
    expect(payload.to).toBe("peer.agent"); // the injected envelope's agent_id
    expect(payload.conversation_id).toBe("cnv-pending");
    expect(payload.kind).toBe("inform");
    expect(payload.meta.done).toBe(false);
    expect(payload.error).toEqual({
      code: "context_overflow",
      message: "prompt too long",
    });
    expect(payload.body).toContain("context_overflow");
  });

  it("conversationIds が空配列なら常に空配列 (操作者ターンのタグ無し)", () => {
    const { tool } = makeTool("self.agent");
    notePending(tool, inboundEnvelope("cnv-untouched"));
    expect(
      resolveTurn(tool, [], { code: "api_error", message: "x" }),
    ).toEqual([]);
    // untouched entry survives an empty-tagged turn resolution
    expect(
      resolveTurn(tool, ["cnv-untouched"], { code: "api_error", message: "y" }),
    ).toHaveLength(1);
  });

  it("成功ターン (error省略) は通知を出さず pending を消費するだけ", () => {
    const { tool } = makeTool("self.agent");
    notePending(tool, inboundEnvelope("cnv-quiet-success"));

    expect(resolveTurn(tool, ["cnv-quiet-success"])).toEqual([]);
    // already cleared — a LATER, unrelated turn's error must not resurrect it
    expect(
      resolveTurn(tool, ["cnv-quiet-success"], {
        code: "api_error",
        message: "unrelated later failure",
      }),
    ).toEqual([]);
  });

  it("異なる turn token の stale resolve は同じ CID を消費も通知もしない", () => {
    const { tool } = makeTool("self.agent");
    notePending(tool, inboundEnvelope("cnv-leased"), "turn-owned");

    expect(
      resolveTurn(
        tool,
        ["cnv-leased"],
        { code: "api_error", message: "stale callback" },
        "turn-stale",
      ),
    ).toEqual([]);
    // The exact lease still owns the entry. Removing the token comparison
    // would make the first resolve emit a peer_error and this one empty.
    expect(
      resolveTurn(
        tool,
        ["cnv-leased"],
        { code: "api_error", message: "owned callback" },
        "turn-owned",
      ),
    ).toHaveLength(1);
  });

  it("別 turn からの accepted reply は先行 inbound の lease を消さない", async () => {
    let activeToken = "turn-other";
    const tool = new InterAgentTool({
      config: configFor("self.agent"),
      getState: () => "tool_running",
      getActiveInterAgentTurnToken: () => activeToken,
      send: () => {},
      sendInterAgent: async () => ({ kind: "accepted", stamp: [1, 0] }),
    });
    tool.notePendingInjection(inboundEnvelope("cnv-reply-lease"), "turn-owned");

    await tool.invoke({
      to: "peer.agent",
      body: "unrelated reply",
      kind: "response",
      conversation_id: "cnv-reply-lease",
    });
    activeToken = "turn-owned";
    expect(
      tool.resolveTurnEnd("turn-owned", ["cnv-reply-lease"], {
        code: "api_error",
        message: "the owned turn failed",
      }),
    ).toHaveLength(1);
  });

  it("invoke() で同じ conversation に返信すると pending が解消し resolveTurnEnd は何も返さない", async () => {
    const { tool } = makeTool("self.agent");
    notePending(tool, inboundEnvelope("cnv-replied"));
    await tool.invoke({
      to: "peer.agent",
      body: "実は返信できた",
      kind: "response",
      conversation_id: "cnv-replied",
    });

    expect(
      resolveTurn(tool, ["cnv-replied"], { code: "api_error", message: "x" }),
    ).toEqual([]);
  });

  it("同じ conversationId を2回 resolve しても2回目は空配列 (二重通知防止)", () => {
    const { tool } = makeTool("self.agent");
    expect(
      resolveTurn(tool, ["cnv-none"], { code: "api_error", message: "x" }),
    ).toEqual([]);

    notePending(tool, inboundEnvelope("cnv-once"));
    const first = resolveTurn(tool, ["cnv-once"], {
      code: "api_error",
      message: "first",
    });
    expect(first).toHaveLength(1);
    const second = resolveTurn(tool, ["cnv-once"], {
      code: "api_error",
      message: "second",
    });
    expect(second).toEqual([]);
  });

  it("並存する複数 conversation は互いに独立して resolve される (must-fix 1: ターン非スコープの誤通知防止)", () => {
    const { tool } = makeTool("self.agent");
    // Two inbound injections queued before either turn completes — the bug
    // this regression test targets: resolving turn A's outcome must not
    // touch conversation B's still-pending entry, and vice versa.
    notePending(tool, inboundEnvelope("cnv-a"));
    notePending(tool, inboundEnvelope("cnv-b"));

    // Turn for cnv-a fails: only cnv-a gets a notice, cnv-b stays pending.
    const noticesA = resolveTurn(tool, ["cnv-a"], {
      code: "timeout",
      message: "no response",
    });
    expect(noticesA).toHaveLength(1);
    expect(
      (noticesA[0]!.payload as unknown as InterAgentMessagePayload)
        .conversation_id,
    ).toBe("cnv-a");

    // cnv-b's turn later succeeds quietly: cleared, no notice, no leftover
    // that a further-later unrelated failure could misattribute.
    expect(resolveTurn(tool, ["cnv-b"])).toEqual([]);
    expect(
      resolveTurn(tool, ["cnv-b"], { code: "api_error", message: "late" }),
    ).toEqual([]);
  });

  it("複数 cid を1回で resolve すると成功時は全件が黙って消費される (issue #221 段階3, 合流turn)", () => {
    const { tool } = makeTool("self.agent");
    notePending(tool, inboundEnvelope("cnv-x"));
    notePending(tool, inboundEnvelope("cnv-y"));
    notePending(tool, inboundEnvelope("cnv-z"));

    expect(resolveTurn(tool, ["cnv-x", "cnv-y", "cnv-z"])).toEqual([]);
    // already cleared — a later failed resolve of the same batch's cids
    // must not resurrect any of them.
    expect(
      resolveTurn(tool, ["cnv-x", "cnv-y", "cnv-z"], {
        code: "api_error",
        message: "late",
      }),
    ).toEqual([]);
  });

  it("複数 cid を1回で resolve し失敗すると cid ごとに個別の notice が出る (クロエ裁定: peer_error 全件波及)", () => {
    const { tool } = makeTool("self.agent");
    notePending(tool, inboundEnvelope("cnv-p", "response", undefined, "peer.p"));
    notePending(tool, inboundEnvelope("cnv-q", "response", undefined, "peer.q"));

    const notices = resolveTurn(tool, ["cnv-p", "cnv-q"], {
      code: "context_overflow",
      message: "batch too large",
    });

    // one bundled turn failing produces ONE notice PER cid in the batch —
    // the wrapper cannot tell which single message actually caused it, so
    // every peer whose message was bundled gets its own peer_error
    // (protocol-inter-agent.md「保留メッセージの合流」トレードオフ節).
    expect(notices).toHaveLength(2);
    const byConversation = new Map(
      notices.map((envelope) => [
        (envelope.payload as unknown as InterAgentMessagePayload)
          .conversation_id,
        envelope,
      ]),
    );
    const p = byConversation.get("cnv-p")!;
    const q = byConversation.get("cnv-q")!;
    expect(
      (p.payload as unknown as InterAgentMessagePayload).to,
    ).toBe("peer.p");
    expect(
      (q.payload as unknown as InterAgentMessagePayload).to,
    ).toBe("peer.q");
    for (const envelope of notices) {
      const payload = envelope.payload as unknown as InterAgentMessagePayload;
      expect(payload.error).toEqual({
        code: "context_overflow",
        message: "batch too large",
      });
    }
  });

  it("一部だけ未 resolve な cid を混在させても resolve 済みの cid には触れない", () => {
    const { tool } = makeTool("self.agent");
    notePending(tool, inboundEnvelope("cnv-live"));
    // cnv-already-gone has no pending entry at all (e.g. invoke() already
    // sent a reply on it during the same coalesced turn).
    const notices = resolveTurn(tool, ["cnv-live", "cnv-already-gone"], {
      code: "api_error",
      message: "x",
    });
    expect(notices).toHaveLength(1);
    expect(
      (notices[0]!.payload as unknown as InterAgentMessagePayload)
        .conversation_id,
    ).toBe("cnv-live");
  });
});

describe("canAddToCoalescedBatch / formatInboundMessages (issue #221 段階3)", () => {
  it("空 batch は候補の自前サイズに関わらず常に受理する (単独の巨大メッセージも捨てない)", () => {
    expect(canAddToCoalescedBatch(0, 0, MAX_COALESCED_BYTES + 1)).toBe(true);
  });

  it("件数上限ちょうどまでは受理し、超えると拒否する", () => {
    expect(
      canAddToCoalescedBatch(MAX_COALESCED_MESSAGES - 1, 10, 10),
    ).toBe(true);
    expect(canAddToCoalescedBatch(MAX_COALESCED_MESSAGES, 10, 10)).toBe(
      false,
    );
  });

  it("サイズ上限ちょうどまでは受理し、超えると拒否する", () => {
    expect(
      canAddToCoalescedBatch(1, MAX_COALESCED_BYTES - 10, 10),
    ).toBe(true);
    expect(
      canAddToCoalescedBatch(1, MAX_COALESCED_BYTES - 9, 10),
    ).toBe(false);
  });

  it("formatInboundMessages は単独1件なら formatInboundMessage と完全一致する", () => {
    const envelope = inboundEnvelope("cnv-solo");
    const viaSingle = formatInboundMessage(envelope, { mode: "reply-owed" });
    const viaBatch = formatInboundMessages([
      { envelope, mode: "reply-owed" },
    ]);
    expect(viaBatch).toBe(viaSingle);
  });

  it("formatInboundMessages は複数件を受信順に連結し、各自の conversation_id を保つ", () => {
    const first = inboundEnvelope("cnv-first");
    const second = inboundEnvelope("cnv-second");
    const text = formatInboundMessages([
      { envelope: first, mode: "reply-owed" },
      { envelope: second, mode: "reply-owed" },
    ]);
    const firstIndex = text.indexOf("cnv-first");
    const secondIndex = text.indexOf("cnv-second");
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBeGreaterThan(firstIndex);
    expect(text).toContain("2 pending inter-agent messages");
  });
});

describe("classifyInterAgentError (issue #131)", () => {
  it("既知の terminal_reason を対応する code へ写像する", () => {
    expect(classifyInterAgentError({ reason: "blocking_limit" }).code).toBe(
      "rate_limit",
    );
    expect(
      classifyInterAgentError({ reason: "rapid_refill_breaker" }).code,
    ).toBe("rate_limit");
    expect(classifyInterAgentError({ reason: "prompt_too_long" }).code).toBe(
      "context_overflow",
    );
    expect(classifyInterAgentError({ reason: "aborted_streaming" }).code).toBe(
      "interrupted",
    );
    expect(classifyInterAgentError({ reason: "api_error" }).code).toBe(
      "api_error",
    );
  });

  it("未知の reason は detail のキーワードで rate_limit/context_overflow を推定する", () => {
    expect(
      classifyInterAgentError({
        reason: "unknown_engine_reason",
        detail: "HTTP 429 Too Many Requests",
      }).code,
    ).toBe("rate_limit");
    expect(
      classifyInterAgentError({ detail: "context window exceeded" }).code,
    ).toBe("context_overflow");
  });

  it("分類不能な入力は api_error に縮退する (Codex の raw message 想定)", () => {
    const result = classifyInterAgentError({
      detail: "unexpected stream termination",
    });
    expect(result.code).toBe("api_error");
    expect(result.message).toBe("the peer reported an unspecified error");
  });

  it("disconnected はサーバ専管のため wrapper 側の分類結果には現れない", () => {
    const reasons = [
      "blocking_limit",
      "rapid_refill_breaker",
      "prompt_too_long",
      "aborted_streaming",
      "aborted_tools",
      "timeout",
      "api_error",
      "max_turns",
    ];
    for (const reason of reasons) {
      expect(classifyInterAgentError({ reason }).code).not.toBe("disconnected");
    }
  });

  it("message は常に固定テンプレートで、reason/detail の生テキストを一切含まない (issue #131 must-fix 2)", () => {
    const secretLike = "Error: ENOENT /Users/user/.ssh/id_ed25519 token=sk-abc123";
    const byReason = classifyInterAgentError({
      reason: "blocking_limit",
      detail: secretLike,
    });
    expect(byReason.message).toBe("the peer hit a rate limit");
    expect(byReason.message).not.toContain(secretLike);

    const byKeyword = classifyInterAgentError({
      detail: `rate limited — ${secretLike}`,
    });
    expect(byKeyword.code).toBe("rate_limit");
    expect(byKeyword.message).toBe("the peer hit a rate limit");
    expect(byKeyword.message).not.toContain(secretLike);

    const fallback = classifyInterAgentError({ detail: secretLike });
    expect(fallback.message).toBe("the peer reported an unspecified error");
    expect(fallback.message).not.toContain(secretLike);
    expect(fallback.message).not.toContain("id_ed25519");
    expect(fallback.message).not.toContain("sk-abc123");
  });

});

describe("formatInboundMessage", () => {
  it("基本フォーマットに role directive + from/kind/body/meta を含める", () => {
    const env: Envelope = {
      version: "0",
      agent_id: "agent-a",
      persona: PERSONA,
      display_name: PERSONA.name,
      ts: "2026-06-29T12:00:00Z",
      type: "inter_agent_message",
      state: "tool_running",
      payload: {
        to: "agent-b",
        conversation_id: "cnv-9",
        turn_number: 3,
        kind: "propose",
        body: "CSV にしよう",
        meta: { done: false, propose_next: "B の同意" },
        owner: { kind: "user", id: "operator" },
      },
      ext: {},
    };
    const text = formatInboundMessage(env);
    // Role directive must lead so the receiving model treats this as an
    // inter-agent reply and goes straight to send_to_agent (Phase 1 spec)
    // instead of asking the operator "should I respond with X?" first.
    expect(text).toMatch(
      /^\[Inter-agent message — to reply, call send_to_agent with conversation_id="cnv-9"\.\]/,
    );
    expect(text).toContain("[from agent-a] propose: CSV にしよう");
    expect(text).toContain("conversation_id=cnv-9");
    expect(text).toContain("turn_number=3");
    expect(text).toContain("done=false");
    expect(text).toContain("propose_next=B の同意");
    expect(isFormattedInterAgentMessage(text)).toBe(true);
  });

  it("SDK inject framing だけを識別し、通常文と文中引用は識別しない", () => {
    expect(isFormattedInterAgentMessage("通常の operator instruction")).toBe(
      false,
    );
    expect(
      isFormattedInterAgentMessage(
        '引用: [Inter-agent message — to reply, call send_to_agent with conversation_id="cnv-9".]',
      ),
    ).toBe(false);
  });

  it("数千字のbodyを無加工で保持する", () => {
    const body = "長文".repeat(2_000);
    const text = formatInboundMessage({
      version: "0",
      agent_id: "agent-a",
      persona: PERSONA,
      display_name: PERSONA.name,
      ts: "2026-06-29T12:00:00Z",
      type: "inter_agent_message",
      state: "tool_running",
      payload: {
        to: "agent-b",
        conversation_id: "cnv-long",
        turn_number: 1,
        kind: "inform",
        body,
        meta: { done: false, propose_next: "" },
        owner: { kind: "user", id: "operator" },
      },
      ext: {},
    });
    expect(text).toContain(body);
  });

  it("payload 欠損(server 合成 escalate skeleton)でも空値で頑健に整形する", () => {
    const env: Envelope = {
      version: "0",
      agent_id: "server",
      persona: PERSONA,
      display_name: PERSONA.name,
      ts: "2026-06-29T12:00:00Z",
      type: "inter_agent_message",
      state: "idle",
      payload: {
        to: "agent-a",
        conversation_id: "cnv-0",
        turn_number: 0,
        kind: "escalate-to-user",
        body: "conversation auto-terminated: max_turns",
        meta: { done: true, propose_next: "" },
        owner: { kind: "user", id: "system" },
      },
      ext: {},
    };
    const text = formatInboundMessage(env);
    expect(text).toContain("[from server] escalate-to-user");
    expect(text).toContain("done=true");
  });

  it("payload.error 付きは peer-error 専用行 + 行動指針で整形する (issue #131)", () => {
    const env = inboundEnvelope("cnv-notice", "inform", {
      code: "context_overflow",
      message: "context window exhausted",
    });
    const text = formatInboundMessage(env);
    expect(text).toContain(
      "[from peer.agent] peer-error(context_overflow): context window exhausted — retrying is pointless — summarize the context or escalate to the operator.",
    );
    expect(text).not.toContain("[from peer.agent] inform:");
  });

  it("未知の error code は既定の行動指針にフォールバックする", () => {
    const env = inboundEnvelope("cnv-unknown-code", "inform", {
      code: "some_future_code",
      message: "not yet catalogued",
    });
    const text = formatInboundMessage(env);
    expect(text).toContain(
      "peer-error(some_future_code): not yet catalogued — confirm the peer's state before retrying.",
    );
  });
});

describe("list_agents / whoami companion tools", () => {
  it("companion tool FQN を公開する", () => {
    expect(LIST_AGENTS_TOOL_FQN).toBe("mcp__kaoiro__list_agents");
    expect(WHOAMI_TOOL_FQN).toBe("mcp__kaoiro__whoami");
  });

  it("list_agents は requestDirectory の結果を JSON として返す", async () => {
    const directory: DirectoryEntry[] = [
      {
        agent_id: "lab.peer-1",
        persona: { id: "ao", name: "あお", sprite_set: "ao" },
        state: "idle",
        engine: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
      },
      {
        agent_id: "lab.peer-2",
        persona: { id: "kuroe", name: "クロエ", sprite_set: "kuroe" },
        state: "thinking",
      },
    ];
    const tool = new InterAgentTool({
      config: configFor("self.agent"),
      getState: () => "tool_running",
      send: () => {},
      requestDirectory: async () => ({ agents: directory, users: [] }),
    });

    const result = await tool.listAgents();
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0]!.text) as {
      agents: DirectoryEntry[];
      users: unknown[];
    };
    expect(parsed.agents).toEqual(directory);
    expect(parsed.users).toEqual([]);
  });

  it("list_agents は状況判断メタデータを欠落なく model へ渡す (#160)", async () => {
    const directory: DirectoryEntry[] = [
      {
        agent_id: "lab.peer-1",
        persona: { id: "ao", name: "あお", sprite_set: "ao" },
        state: "idle",
        context: {
          used_tokens: 132400,
          max_tokens: 200000,
          used_percentage: 66.2,
        },
        session_started_at: "2026-07-28T01:12:44Z",
        turns: 17,
        last_activity_at: "2026-07-28T03:41:09Z",
        conversation: { active: true, peers: ["lab.peer-2"] },
        rate_limits: {
          five_hour: {
            status: "allowed",
            utilization: 0.42,
            resets_at: 1785200000,
          },
          seven_day: { utilization: 0.71, resets_at: 1785600000 },
        },
      },
    ];
    const tool = new InterAgentTool({
      config: configFor("self.agent"),
      getState: () => "tool_running",
      send: () => {},
      requestDirectory: async () => ({ agents: directory, users: [] }),
    });

    const result = await tool.listAgents();
    const parsed = JSON.parse(result.content[0]!.text) as {
      agents: DirectoryEntry[];
    };
    // The tool is a pass-through: whatever the narrow admitted must reach the
    // model intact, since the delegation decision is made from these numbers.
    expect(parsed.agents).toEqual(directory);
  });

  it("list_agents の description は欠損 field の読み方を明示する (#160)", () => {
    const listAgents = new InterAgentTool({
      config: configFor("self.agent"),
      getState: () => "idle",
      send: () => {},
    })
      .descriptors()
      .find((descriptor) => descriptor.name === "list_agents");

    // An absent field means "unknown"; a model that reads it as zero would
    // delegate heavy work to an exhausted peer.
    expect(listAgents?.description).toContain("ABSENT means unknown");
    expect(listAgents?.description).toContain("resets_at");
  });

  it("list_agents は requestDirectory 未配線でエラー結果を返す", async () => {
    const tool = new InterAgentTool({
      config: configFor("self.agent"),
      getState: () => "tool_running",
      send: () => {},
    });
    const result = await tool.listAgents();
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("list_agents unavailable");
  });

  it("list_agents は requestDirectory の reject をエラー結果に変換する", async () => {
    const tool = new InterAgentTool({
      config: configFor("self.agent"),
      getState: () => "tool_running",
      send: () => {},
      requestDirectory: async () => {
        throw new Error("boom");
      },
    });
    const result = await tool.listAgents();
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("list_agents failed");
    expect(result.content[0]!.text).toContain("boom");
  });

  it("list_agents は users を agents と別 key で返す (issue #197 段階2)", async () => {
    const directory: DirectoryEntry[] = [
      {
        agent_id: "lab.peer-1",
        persona: { id: "ao", name: "あお", sprite_set: "ao" },
        state: "idle",
      },
    ];
    // director D7: 同じ id / 表示名を agent 側と共有していても、user は
    // agents 配列へ混入してはいけない — この構造そのものが保証。
    const users: UserDirectoryEntry[] = [
      { id: "lab.peer-1", kind: "user", display_name: "あお", role: "operator" },
    ];
    const tool = new InterAgentTool({
      config: configFor("self.agent"),
      getState: () => "tool_running",
      send: () => {},
      requestDirectory: async () => ({ agents: directory, users }),
    });

    const result = await tool.listAgents();
    const parsed = JSON.parse(result.content[0]!.text) as {
      agents: DirectoryEntry[];
      users: unknown[];
    };
    expect(parsed.agents).toEqual(directory);
    expect(parsed.users).toEqual(users);
    // agents 配列自体には user shape (kind/display_name/role) の entry が
    // 紛れ込んでいない。
    expect(parsed.agents.every((a) => !("kind" in a))).toBe(true);
  });

  it("list_agents の description は users が送信対象ではないことを明示する (issue #197 段階2)", () => {
    const listAgents = new InterAgentTool({
      config: configFor("self.agent"),
      getState: () => "idle",
      send: () => {},
    })
      .descriptors()
      .find((descriptor) => descriptor.name === "list_agents");

    expect(listAgents?.description).toContain("NOT valid");
    expect(listAgents?.description).toContain("send_to_agent");
  });

  it("whoami は getWhoami の snapshot を JSON として返す", () => {
    const snapshot: WhoamiSnapshot = {
      agent_id: "self.agent",
      persona: { id: "mio", name: "澪", sprite_set: "mio" },
      state: "thinking",
      engine: "codex",
      model: "claude-sonnet-4-6",
      effort: "high",
      model_source: "config",
      effort_source: "config",
      permission: { sandbox: "workspace-write", approval: "never" },
      network_access: true,
      cwd: "/home/user",
      permission_mode: "default",
    };
    const tool = new InterAgentTool({
      config: configFor("self.agent"),
      getState: () => "thinking",
      send: () => {},
      getWhoami: () => snapshot,
    });
    const result = tool.whoami();
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text)).toEqual(snapshot);
  });

  it("whoami は getWhoami 未配線で wrapper config からのフォールバックを返す", () => {
    const tool = new InterAgentTool({
      config: configFor("self.agent"),
      getState: () => "idle",
      send: () => {},
    });
    const result = tool.whoami();
    const parsed = JSON.parse(result.content[0]!.text) as WhoamiSnapshot;
    expect(parsed.agent_id).toBe("self.agent");
    expect(parsed.persona).toEqual(PERSONA);
    expect(parsed.state).toBe("idle");
    // SDK 由来のフィールドは存在しないので omit される
    expect(parsed.model).toBeUndefined();
  });
});

describe("descriptors (共通 Tool 記述層, ADR-0032 F5)", () => {
  it("send_to_agent handler は不正入力を isError で弾き invoke へ到達させない", async () => {
    const { tool, capture } = makeTool("self.agent");
    const send = tool.descriptors().find((d) => d.name === "send_to_agent")!;
    const bad = await send.handler({ to: "peer", body: "" });
    expect(bad.isError).toBe(true);
    expect(capture.envelopes).toHaveLength(0);
  });

  it("send_to_agent handler は有効入力で envelope を送出する", async () => {
    const { tool, capture } = makeTool("self.agent");
    const send = tool.descriptors().find((d) => d.name === "send_to_agent")!;
    const ok = await send.handler({
      to: "peer.agent",
      body: "hello",
      kind: "inform",
    });
    expect(ok.isError).toBeFalsy();
    expect(capture.envelopes).toHaveLength(1);
  });

  it("3 tool の inputSchema が JSON Schema object で揃う", () => {
    const { tool } = makeTool("self.agent");
    const descriptors = tool.descriptors();
    expect(descriptors.map((d) => d.name).sort()).toEqual([
      "list_agents",
      "send_to_agent",
      "whoami",
    ]);
    for (const d of descriptors) {
      expect((d.inputSchema as { type?: string }).type).toBe("object");
    }
    expect(
      descriptors.find((d) => d.name === "list_agents")?.description,
    ).toContain("engine/model/effort when reported");
    expect(descriptors.find((d) => d.name === "whoami")?.description).toContain(
      "engine-neutral permission",
    );
    expect(
      descriptors.find((d) => d.name === "list_agents")?.description,
    ).toContain("never spawn a same-named internal sub-agent");
    expect(
      descriptors.find((d) => d.name === "send_to_agent")?.description,
    ).toContain("do not spawn a same-named agent");
  });

  it("send_to_agent の description に peer_error の code→推奨行動を明記する (issue #131)", () => {
    const { tool } = makeTool("self.agent");
    const description = tool
      .descriptors()
      .find((d) => d.name === "send_to_agent")!.description;
    expect(description).toContain("peer_error: {code, message, from}");
    expect(description).toContain("rate_limit = wait before retrying");
    expect(description).toContain("context_overflow = retrying is pointless");
    expect(description).toContain("api_error = retry at most once");
    expect(description).toContain("disconnected = the peer is unreachable");
  });
});

// ふじ 30-10 must-fix M5: ADR-0051 D3-2 は「reject / timeout は tool result
// に出す」と決めているのに、送信は fire-and-forget で ack を読んでいなかった。
// server が unknown_agent などで明示的に拒否しても tool は "sent" を返す
// ため、model は届いていない委任を届いたものとして扱ってしまう。
describe("send_to_agent の acceptance ack 連動 (ADR-0051 D3-2)", () => {
  function makeAckTool(acceptance: InterAgentAcceptance): {
    tool: InterAgentTool;
    sent: Envelope[];
  } {
    const sent: Envelope[] = [];
    const tool = new InterAgentTool({
      config: configFor("self.agent"),
      getState: () => "tool_running",
      send: () => {
        throw new Error("acceptance-aware sink must be used");
      },
      sendInterAgent: (envelope) => {
        sent.push(envelope);
        return Promise.resolve(acceptance);
      },
      now: () => "2026-08-08T00:00:00Z",
      newId: () => "cnv-ack",
    });
    return { tool, sent };
  }

  it("accepted なら従来どおり sent を返す", async () => {
    const { tool, sent } = makeAckTool({ kind: "accepted", stamp: [1, 0] });

    const result = await tool.invoke({
      to: "peer.agent",
      body: "hi",
      kind: "inform",
    });

    expect(sent).toHaveLength(1);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("sent to peer.agent");
  });

  it("server が reject したら error result にし、reason を載せる", async () => {
    const { tool } = makeAckTool({ kind: "rejected", reason: "unknown_agent" });

    const result = await tool.invoke({
      to: "peer.agent",
      body: "hi",
      kind: "inform",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("unknown_agent");
    // 「送れた」と読める文言を混ぜない。
    expect(result.content[0]!.text).not.toMatch(/^sent to /);
  });

  it("participants_mismatch などの他の reject も同じ経路で error になる", async () => {
    for (const reason of [
      "participants_mismatch",
      "conversation_turn_limit",
      "payload_too_large",
      // issue #177: server 側 conversation_states.ex が新設した reason。
      "conversation_closed",
    ]) {
      const { tool } = makeAckTool({ kind: "rejected", reason });
      const result = await tool.invoke({
        to: "peer.agent",
        body: "hi",
        kind: "inform",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain(reason);
    }
  });

  it("ack 喪失 / timeout は「配送不明」— 失敗とも成功とも言わない", async () => {
    const { tool } = makeAckTool({ kind: "unknown", reason: "timeout" });

    const result = await tool.invoke({
      to: "peer.agent",
      body: "hi",
      kind: "inform",
    });

    // 再送は重複配送になり得るので、error にして model に再試行させない。
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("delivery unknown");
    expect(result.content[0]!.text).toContain("timeout");
    expect(result.content[0]!.text).toContain("duplicate");
  });

  it("reject 時は wait_for_response の待ちも即座に解除する", async () => {
    vi.useFakeTimers();
    try {
      const { tool } = makeAckTool({ kind: "rejected", reason: "unknown_agent" });

      // timer を一切進めないまま解決する = 待ちが張られたままではない。
      const result = await tool.invoke({
        to: "peer.agent",
        body: "hi",
        kind: "query",
        conversation_id: "cnv-reject-wait",
        wait_for_response: true,
      });

      expect(result.isError).toBe(true);
      // waiter が外れているので、後から届いた reply は誰も待っていない。
      expect(
        (await tool.receiveInbound(inboundEnvelope("cnv-reject-wait")))
          .consumed,
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sendInterAgent 未配線なら従来の fire-and-forget 動作 (unit test 用)", async () => {
    const { tool, capture } = makeTool("self.agent");

    const result = await tool.invoke({
      to: "peer.agent",
      body: "hi",
      kind: "inform",
    });

    expect(capture.envelopes).toHaveLength(1);
    expect(result.content[0]!.text).toContain("sent to peer.agent");
  });
});

// ふじ 30-10 2 巡目 R2 / R3。どちらも「acceptance が確定するまでは送信の
// 成否が分からない」ことの帰結で、M5 で ack を読むようにしたことで初めて
// 表に出た。
describe("acceptance と #131 pending injection / reply waiter の整合", () => {
  function makeDeferredAckTool(): {
    tool: InterAgentTool;
    settle: (acceptance: InterAgentAcceptance) => void;
    outbound: Envelope[];
  } {
    const outbound: Envelope[] = [];
    let resolveAck!: (acceptance: InterAgentAcceptance) => void;
    const pending = new Promise<InterAgentAcceptance>((resolve) => {
      resolveAck = resolve;
    });
    const tool = new InterAgentTool({
      config: configFor("self.agent"),
      getState: () => "tool_running",
      getActiveInterAgentTurnToken: () => TEST_TURN_TOKEN,
      send: (env) => outbound.push(env),
      sendInterAgent: (env) => {
        outbound.push(env);
        return pending;
      },
      now: () => "2026-08-08T00:00:00Z",
      newId: () => "cnv-deferred",
    });
    return { tool, settle: resolveAck, outbound };
  }

  // R2: reject は「返信した」ではない。pending injection を消してしまうと
  // #131 のエラー通知が出なくなり、相手は無応答のまま待ち続ける。
  it("R2: reject では pending injection を残し、turn 終了で error notice が出る", async () => {
    const { tool, settle } = makeDeferredAckTool();
    notePending(tool, inboundEnvelope("cnv-deferred", "request"));

    const pending = tool.invoke({
      to: "peer.agent",
      body: "hi",
      kind: "response",
      conversation_id: "cnv-deferred",
    });
    settle({ kind: "rejected", reason: "unknown_agent" });
    expect((await pending).isError).toBe(true);

    const notices = resolveTurn(tool, ["cnv-deferred"], {
      code: "api_error",
      message: "turn failed",
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]?.payload).toMatchObject({ to: "peer.agent" });
  });

  it("R2: accepted では pending injection を消す (通知を重ねない)", async () => {
    const { tool, settle } = makeDeferredAckTool();
    notePending(tool, inboundEnvelope("cnv-deferred", "request"));

    const pending = tool.invoke({
      to: "peer.agent",
      body: "hi",
      kind: "response",
      conversation_id: "cnv-deferred",
    });
    settle({ kind: "accepted", stamp: [1, 0] });
    await pending;

    expect(
      resolveTurn(tool, ["cnv-deferred"], {
        code: "api_error",
        message: "turn failed",
      }),
    ).toEqual([]);
  });

  it("R2: 配送不明でも pending injection は消す (二重返信を作らない)", async () => {
    const { tool, settle } = makeDeferredAckTool();
    notePending(tool, inboundEnvelope("cnv-deferred", "request"));

    const pending = tool.invoke({
      to: "peer.agent",
      body: "hi",
      kind: "response",
      conversation_id: "cnv-deferred",
    });
    settle({ kind: "unknown", reason: "timeout" });
    await pending;

    expect(
      resolveTurn(tool, ["cnv-deferred"], {
        code: "api_error",
        message: "turn failed",
      }),
    ).toEqual([]);
  });

  // R3: ack を取りこぼしても、peer reply が既に着いていればそれが配送の
  // 証拠。unknown を優先して reply を捨てると、同期待ちしていた呼び出しが
  // 届いている返答を見ないまま「配送不明」で終わる。
  it("R3: ack 喪失でも先に届いた reply があれば sent + reply を返す", async () => {
    const { tool, settle } = makeDeferredAckTool();

    const pending = tool.invoke({
      to: "peer.agent",
      body: "please reply",
      kind: "query",
      conversation_id: "cnv-deferred",
      wait_for_response: true,
    });
    // invoke() が waiter を張るまで 1 tick 待つ (dispatch は await 済み)。
    await Promise.resolve();

    // ack より先に peer reply が着く。
    expect(
      (await tool.receiveInbound(inboundEnvelope("cnv-deferred"))).consumed,
    ).toBe(true);
    settle({ kind: "unknown", reason: "timeout" });

    const result = await pending;
    const text = result.content[0]!.text;
    expect(result.isError).toBeUndefined();
    expect(text).not.toContain("delivery unknown");
    expect(text).toContain("peer reply body");
  });

  it("R3: reply がまだ来ていない ack 喪失は従来どおり配送不明で即返す", async () => {
    vi.useFakeTimers();
    try {
      const { tool, settle } = makeDeferredAckTool();

      const pending = tool.invoke({
        to: "peer.agent",
        body: "please reply",
        kind: "query",
        conversation_id: "cnv-deferred",
        wait_for_response: true,
        timeout_ms: 300_000,
      });
      settle({ kind: "unknown", reason: "timeout" });

      // timer を進めずに解決する = waiter は解除済み。
      const result = await pending;
      expect(result.content[0]!.text).toContain("delivery unknown");
      expect(
        (await tool.receiveInbound(inboundEnvelope("cnv-deferred"))).consumed,
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // issue #177 review M2: localDone was previously set only AFTER awaiting
  // the send ack. A peer's own closing reply arriving (via this wrapper's
  // independent receiveInbound() path) while that ack is still pending saw
  // localDone still false and misclassified a genuinely mutual close as a
  // one-sided close-proposal.
  //
  // issue #177 review round 2 (ふじ差し戻し, 理由2): revised — the ORIGINAL
  // version of this test asserted mode="terminal" SYNCHRONOUSLY, before the
  // pending done=true send's own acceptance had settled at all. That is
  // exactly the bug round 2 fixes: a "terminal, do not reply" disposition
  // handed to the adapter before the send is confirmed becomes wrong and
  // unrecoverable the moment that send is later rejected. receiveInbound()
  // now gates on the pending-done ack, so it settles ONLY once acceptance
  // is known — this test asserts that resolved value, not an intermediate
  // synchronous read.
  it(
    "M2: peer の closing reply は自分の pending done acceptance が確定するまで " +
      "分類を確定しない — 確定後 (accepted) は terminal になる (review " +
      "must-fix, round2 で修正)",
    async () => {
      const { tool, settle } = makeDeferredAckTool();

      const pending = tool.invoke({
        to: "peer.agent",
        body: "bye",
        kind: "done",
        conversation_id: "cnv-deferred",
        done: true,
      });
      // invoke() が dispatch を await するところまで 1 tick 待つ — この時点で
      // localDone は既に楽観的に true になっているが、pending-done gate も
      // 同時に張られているため receiveInbound() はまだ解決しない。
      await Promise.resolve();

      const closingReply = inboundEnvelope("cnv-deferred", "done");
      (closingReply.payload as unknown as InterAgentMessagePayload).turn_number = 2;
      (closingReply.payload as unknown as InterAgentMessagePayload).meta = {
        done: true,
        propose_next: "",
      };
      const receiving = tool.receiveInbound(closingReply);

      settle({ kind: "accepted", stamp: [1, 0] });
      expect((await pending).isError).toBeFalsy();
      // gate が外れて初めて — accepted で localDone が確定した後 — terminal
      // と分類される。
      expect((await receiving).mode).toBe("terminal");
    },
  );

  // Mutation-tested (my-code-review-cycle guard-shaped-fix rule): with the
  // rollback removed, this assertion fails with mode="terminal" instead of
  // "close-proposal" — confirmed manually before finalizing.
  it("M2: reject された送信は楽観的な localDone をロールバックする (review must-fix)", async () => {
    const { tool, settle } = makeDeferredAckTool();

    const pending = tool.invoke({
      to: "peer.agent",
      body: "bye",
      kind: "done",
      conversation_id: "cnv-deferred",
      done: true,
    });
    await Promise.resolve();
    settle({ kind: "rejected", reason: "unknown_agent" });
    expect((await pending).isError).toBe(true);

    // ロールバック後: この送信は届いていない扱いなので、peer 側の
    // done=true はまだ一方的な close 提案 — terminal ではない。
    const peerDone = inboundEnvelope("cnv-deferred", "done");
    (peerDone.payload as unknown as InterAgentMessagePayload).turn_number = 2;
    (peerDone.payload as unknown as InterAgentMessagePayload).meta = {
      done: true,
      propose_next: "",
    };
    expect((await tool.receiveInbound(peerDone)).mode).toBe("close-proposal");
  });

  // Like makeDeferredAckTool(), but each sendInterAgent call gets its OWN
  // independent deferred acceptance instead of sharing one — needed to
  // settle two concurrent invoke() calls on the same conversation_id in a
  // chosen order (review round 2 M1).
  function makeMultiDeferredAckTool(): {
    tool: InterAgentTool;
    outbound: Envelope[];
    settlers: ((acceptance: InterAgentAcceptance) => void)[];
  } {
    const outbound: Envelope[] = [];
    const settlers: ((acceptance: InterAgentAcceptance) => void)[] = [];
    const tool = new InterAgentTool({
      config: configFor("self.agent"),
      getState: () => "tool_running",
      send: (env) => outbound.push(env),
      sendInterAgent: (env) => {
        outbound.push(env);
        return new Promise((resolve) => {
          settlers.push(resolve);
        });
      },
      now: () => "2026-08-08T00:00:00Z",
    });
    return { tool, outbound, settlers };
  }

  // issue #177 review round 2 M1: two concurrent invoke() calls on the SAME
  // conversation_id previously each ran their synchronous prefix (turn
  // allocation, optimistic localDone flip / snapshot) against the SAME
  // shared track before either awaited its own #dispatch — so a REJECTED
  // call's rollback restored a pre-flip snapshot that predated a sibling
  // call's already-committed (accepted) mutation, silently erasing it.
  // Mutation-tested: with #withCidLock removed (each invoke() runs
  // unlocked), this test's final assertion fails with mode="close-proposal"
  // instead of "terminal" — confirmed manually before finalizing.
  it(
    "round2 M1: 並行 invoke の rollback が同一 CID の別 invoke の成功状態を " +
      "消さない (review must-fix)",
    async () => {
      const { tool, settlers } = makeMultiDeferredAckTool();

      // Seed an existing (non-brand-new) OPEN track — neither side has
      // signalled done yet, so neither invoke() below can short-circuit via
      // the AC10 "already closed" guard before reaching #dispatch.
      const seed = tool.invoke({
        to: "peer.agent",
        body: "hi",
        kind: "inform",
        conversation_id: "cnv-race",
      });
      settlers[0]!({ kind: "accepted", stamp: null });
      expect((await seed).isError).toBeFalsy();

      // Two invoke() calls with done=true on the SAME conversation_id,
      // kicked off before either settles — A will be rejected, B accepted.
      const pendingA = tool.invoke({
        to: "peer.agent",
        body: "bye (A)",
        kind: "done",
        conversation_id: "cnv-race",
        done: true,
      });
      const pendingB = tool.invoke({
        to: "peer.agent",
        body: "bye (B)",
        kind: "done",
        conversation_id: "cnv-race",
        done: true,
      });

      settlers[1]!({ kind: "rejected", reason: "participants_mismatch" });
      // B is queued behind the per-CID lock A currently holds — it only
      // reaches its own dispatch call (registering settlers[2]) once A's
      // lock section has fully released. Drain microtasks until then
      // instead of guessing a fixed tick count; bounded so a regression
      // that stalls B forever fails fast instead of hanging the run.
      for (let i = 0; settlers.length < 3; i++) {
        if (i > 100) {
          throw new Error("settlers[2] never registered — B stalled");
        }
        await Promise.resolve();
      }
      settlers[2]!({ kind: "accepted", stamp: null });

      expect((await pendingA).isError).toBe(true);
      expect((await pendingB).isError).toBeFalsy();

      // B's accepted done=true must have actually taken effect
      // (localDone=true) — A's later rejection rollback must not have
      // undone that shared commit. Probed indirectly: once the peer ALSO
      // signals done=true, the conversation must read as fully terminal
      // (both sides done), not a one-sided close-proposal.
      const peerDone = inboundEnvelope("cnv-race", "done");
      (peerDone.payload as unknown as InterAgentMessagePayload).turn_number = 10;
      (peerDone.payload as unknown as InterAgentMessagePayload).meta = {
        done: true,
        propose_next: "",
      };
      expect((await tool.receiveInbound(peerDone)).mode).toBe("terminal");
    },
  );

  // issue #177 review round 2 M2: a conversation_closed reject was
  // previously treated like any other reject (rolled back / brand-new track
  // discarded), so the wrapper never LEARNED the CID was closed — the next
  // identical explicit-CID attempt round-tripped to the server again, every
  // time, undermining the wrapper's 24h TTL as the real enforced CID-reuse
  // guard (protocol-inter-agent.md "CID 再利用は契約にしない").
  // Mutation-tested: with the conversation_closed branch removed (falling
  // through to the brand-new-delete branch), the second call's dispatchCount
  // assertion fails (2 instead of 1) and it no longer reports "already
  // closed" — confirmed manually before finalizing.
  it(
    "round2 M2: conversation_closed reject は local track に学習され、" +
      "以後は server へ round-trip せずローカルで拒否する (review must-fix)",
    async () => {
      let dispatchCount = 0;
      const tool = new InterAgentTool({
        config: configFor("self.agent"),
        getState: () => "tool_running",
        send: () => {
          throw new Error("acceptance-aware sink must be used");
        },
        sendInterAgent: () => {
          dispatchCount += 1;
          return Promise.resolve({
            kind: "rejected",
            reason: "conversation_closed",
          });
        },
        now: () => "2026-08-08T00:00:00Z",
      });

      // This wrapper never locally tracked "cnv-server-closed" before (a
      // brand-new local track) — e.g. after a restart, or a
      // hallucinated/reused id — yet the server says it is already closed.
      const first = await tool.invoke({
        to: "peer.agent",
        body: "hi",
        kind: "inform",
        conversation_id: "cnv-server-closed",
      });
      expect(first.isError).toBe(true);
      expect(dispatchCount).toBe(1);

      // Second attempt on the same CID is rejected by the LOCAL AC10 guard
      // — no second round-trip to the server.
      const second = await tool.invoke({
        to: "peer.agent",
        body: "hi again",
        kind: "inform",
        conversation_id: "cnv-server-closed",
      });
      expect(second.isError).toBe(true);
      expect(second.content[0]!.text).toContain("already closed");
      expect(dispatchCount).toBe(1);
    },
  );

  // issue #177 review round 2 (ふじ差し戻し、理由1): a done=true send's
  // rollback previously restored `closed`/`closedAtMs` unconditionally to a
  // pre-flip snapshot, even when a concurrently-arriving receiveInbound()
  // (here: a server-synthesized hard-limit escalate) had, in the interim,
  // legitimately set closed=true — a server=CLOSED / wrapper=OPEN
  // split-brain that also defeated the local AC10 guard. Mutation-tested:
  // with the pending-done gate removed (`#pendingDoneAcks` check deleted
  // from `receiveInbound()`), the escalate's receiveInbound() call resolves
  // BEFORE the reject's rollback, which then overwrites its closed=true —
  // the "already closed" retry assertion fails (isError becomes falsy, a
  // 3rd dispatch happens) — confirmed manually before finalizing.
  it(
    "round3(a): pending-done 中に server 合成 hard-limit が到着→送信が " +
      "generic reject されても CLOSED は保持され、次の同一 CID invoke は " +
      "ローカル拒否・dispatch count 不変 (review must-fix)",
    async () => {
      const { tool, settlers } = makeMultiDeferredAckTool();

      // Seed an existing (non-brand-new) OPEN track — an ongoing
      // conversation a hard limit later trips on, the realistic case.
      const seed = tool.invoke({
        to: "peer.agent",
        body: "hi",
        kind: "inform",
        conversation_id: "cnv-hardlimit-race",
      });
      settlers[0]!({ kind: "accepted", stamp: null });
      expect((await seed).isError).toBeFalsy();

      // Pending done=true send — registers the pending-done gate.
      const pendingDone = tool.invoke({
        to: "peer.agent",
        body: "bye",
        kind: "done",
        conversation_id: "cnv-hardlimit-race",
        done: true,
      });
      await Promise.resolve();

      // Server-synthesized hard-limit escalate arrives WHILE the send
      // above is still unconfirmed — gates on the pending-done ack
      // instead of computing (and mutating track state from) a
      // disposition immediately.
      const escalate = inboundEnvelope("cnv-hardlimit-race", "escalate-to-user");
      escalate.agent_id = "server";
      (escalate.payload as unknown as InterAgentMessagePayload).turn_number = 0;
      (escalate.payload as unknown as InterAgentMessagePayload).meta = {
        done: true,
        propose_next: "",
      };
      const receiving = tool.receiveInbound(escalate);

      // The pending send is REJECTED for an unrelated (generic) reason —
      // its rollback must not undo the authoritative CLOSED the escalate
      // is about to establish.
      settlers[1]!({ kind: "rejected", reason: "participants_mismatch" });
      expect((await pendingDone).isError).toBe(true);

      // Gate released — the escalate's own disposition settles now. The
      // server-synthesized branch is unconditional on localDone, so this
      // is terminal regardless of the reject above.
      expect((await receiving).mode).toBe("terminal");

      // The server already tombstoned this conversation (Stage 1) — a
      // further send on the same CID must be rejected LOCALLY (AC10),
      // without a second round-trip. Start it without awaiting first, so
      // a regression that DOES dispatch again can still be unblocked
      // (rather than hanging the test) before we assert on it.
      expect(settlers.length).toBe(2);
      const retryPromise = tool.invoke({
        to: "peer.agent",
        body: "still there?",
        kind: "inform",
        conversation_id: "cnv-hardlimit-race",
      });
      for (let i = 0; i < 10 && settlers.length < 3; i++) {
        await Promise.resolve();
      }
      if (settlers.length >= 3) {
        settlers[2]!({ kind: "accepted", stamp: null });
      }
      const retry = await retryPromise;
      expect(retry.isError).toBe(true);
      expect(retry.content[0]!.text).toContain("already closed");
      expect(settlers.length).toBe(2); // unchanged — no round-trip
    },
  );

  // issue #177 review round 2 (ふじ差し戻し、理由2): a receiveInbound() call
  // could previously compute and return a "terminal" disposition off of a
  // still-OPTIMISTIC (unconfirmed) localDone — the adapter (cli.ts) would
  // then inject "this conversation is closed, do not reply" into the SDK
  // queue and skip notePendingInjection. If that send was later rejected,
  // the peer's own done=true had in fact only ever been a one-sided close
  // proposal this side still owed a reply to — but the adapter had already
  // told the model otherwise, unrecoverably. Mutation-tested: with the
  // pending-done gate removed, this test's final assertion fails with
  // mode="terminal" instead of "close-proposal" — confirmed manually
  // before finalizing.
  it(
    "round3(b): pending-done 中に peer 自身の done が到着→送信が reject " +
      "されると adapter には terminal が確定注入されず close-proposal に " +
      "なる (review must-fix)",
    async () => {
      const { tool, settlers } = makeMultiDeferredAckTool();

      const pendingDone = tool.invoke({
        to: "peer.agent",
        body: "bye",
        kind: "done",
        conversation_id: "cnv-peer-race",
        done: true,
      });
      await Promise.resolve();

      // Peer's OWN done=true arrives while the send above is still
      // unconfirmed — gates instead of resolving off the optimistic,
      // still-unconfirmed localDone.
      const peerDone = inboundEnvelope("cnv-peer-race", "done");
      (peerDone.payload as unknown as InterAgentMessagePayload).turn_number = 2;
      (peerDone.payload as unknown as InterAgentMessagePayload).meta = {
        done: true,
        propose_next: "",
      };
      const receiving = tool.receiveInbound(peerDone);

      settlers[0]!({ kind: "rejected", reason: "participants_mismatch" });
      expect((await pendingDone).isError).toBe(true);

      // Gate released — this side's done never actually reached the peer,
      // so the peer's done=true correctly reads as a one-sided close
      // proposal, still owed a reply — never a confirmed terminal that
      // would have told the adapter not to reply.
      const disposition = await receiving;
      expect(disposition.mode).toBe("close-proposal");
      expect(disposition.inject).toBe(true);
    },
  );

  // issue #222 欠陥1: `invoke()`'s pre-dispatch `track.turnNumber += 1` was
  // never rolled back on reject — a rejected send never reached the peer,
  // so the number it claimed was never actually spent on the wire, but the
  // local track kept it anyway. Fixed by decrementing once, right after
  // entering the `rejected` branch, gated on `track.mutationGen ===
  // genAtDispatch` (no concurrent inbound activity raced in during the
  // `#dispatch()` await) — see that gate's own doc comment in inter_agent.ts
  // for why the comparison is safe. Three tests below cover the three
  // load-bearing cases; per the director's steer, weight is on the SECOND
  // (a `conversation_closed` reject can never be retried either way, so its
  // own rollback is "does not break anything", not "fixes the incident" —
  // the non-`conversation_closed` case is where an ongoing conversation
  // actually depended on this).
  it(
    "issue #222 欠陥1: conversation_closed reject でも rollback は無害 " +
      "(closed 学習と AC10 のローカル拒否は変わらない)",
    async () => {
      const { tool, settlers } = makeMultiDeferredAckTool();

      const seed = tool.invoke({
        to: "peer.agent",
        body: "hi",
        kind: "inform",
        conversation_id: "cnv-closed-rollback",
      });
      settlers[0]!({ kind: "accepted", stamp: null });
      expect((await seed).isError).toBeFalsy();

      const second = tool.invoke({
        to: "peer.agent",
        body: "still here?",
        kind: "inform",
        conversation_id: "cnv-closed-rollback",
      });
      settlers[1]!({ kind: "rejected", reason: "conversation_closed" });
      expect((await second).isError).toBe(true);

      // AC10 still rejects any further send on this cid LOCALLY, without a
      // 3rd round-trip — the rollback decrementing turnNumber alongside the
      // `closed` learning does not undermine that guard (AC10 keys on
      // `closed`, never on `turnNumber`).
      const third = await tool.invoke({
        to: "peer.agent",
        body: "again?",
        kind: "inform",
        conversation_id: "cnv-closed-rollback",
      });
      expect(third.isError).toBe(true);
      expect(third.content[0]!.text).toContain("already closed");
      expect(settlers.length).toBe(2); // no 3rd dispatch
    },
  );

  it(
    "issue #222 欠陥1: 履歴のある track で conversation_closed 以外の " +
      "reject 後、peer の次の正当な turn が stale drop されない (受け入れ条件1)",
    async () => {
      const { tool, settlers } = makeMultiDeferredAckTool();

      // Seed history: turn 1 accepted (track.turnNumber = 1) — the
      // conversation is genuinely ongoing, not a brand-new track.
      const seed = tool.invoke({
        to: "peer.agent",
        body: "hi",
        kind: "inform",
        conversation_id: "cnv-reject-rollback",
      });
      settlers[0]!({ kind: "accepted", stamp: null });
      expect((await seed).isError).toBeFalsy();

      // This side's own turn 2 attempt is rejected for a reason OTHER than
      // conversation_closed, with nothing racing in — the pre-dispatch bump
      // to turnNumber=2 must roll back to 1.
      const second = tool.invoke({
        to: "peer.agent",
        body: "you there?",
        kind: "inform",
        conversation_id: "cnv-reject-rollback",
      });
      settlers[1]!({ kind: "rejected", reason: "participants_mismatch" });
      expect((await second).isError).toBe(true);

      // The peer's own next legitimate reply — their real turn 2, entirely
      // unaffected by this side's failed send — must NOT be dropped as
      // stale. Before this fix it would have been: turnNumber stuck at 2
      // made `2 <= 2` read as a duplicate.
      const peerReply = inboundEnvelope("cnv-reject-rollback", "response");
      (peerReply.payload as unknown as InterAgentMessagePayload).turn_number = 2;
      const disposition = await tool.receiveInbound(peerReply);
      expect(disposition.inject).toBe(true);
      expect(disposition.mode).toBe("reply-owed");
    },
  );

  it(
    "issue #222 欠陥1: reject と concurrent inbound が競合した場合、" +
      "rollback は発動せず inbound 側の turnNumber が保持される (受け入れ条件2)",
    async () => {
      const { tool, settlers } = makeMultiDeferredAckTool();

      const seed = tool.invoke({
        to: "peer.agent",
        body: "hi",
        kind: "inform",
        conversation_id: "cnv-race-rollback",
      });
      settlers[0]!({ kind: "accepted", stamp: null });
      expect((await seed).isError).toBeFalsy();

      // This side's own turn 2 attempt — genAtDispatch is snapshotted here,
      // before the pre-dispatch bump to turnNumber=2 and before the peer's
      // race below.
      const second = tool.invoke({
        to: "peer.agent",
        body: "you there?",
        kind: "inform",
        conversation_id: "cnv-race-rollback",
      });
      await Promise.resolve();

      // While that send is still unconfirmed, the PEER's own message races
      // in and legitimately advances turnNumber to 3 — mutationGen bumps,
      // which is exactly what must stop the later rollback from firing.
      const peerRace = inboundEnvelope("cnv-race-rollback", "response");
      (peerRace.payload as unknown as InterAgentMessagePayload).turn_number = 3;
      expect((await tool.receiveInbound(peerRace)).inject).toBe(true);

      // NOW the pending send settles, rejected for an unrelated reason.
      settlers[1]!({ kind: "rejected", reason: "participants_mismatch" });
      expect((await second).isError).toBe(true);

      // If the rollback had incorrectly fired here, it would decrement past
      // the concurrent inbound's authoritative value (3 -> 2), and a
      // turn_number=3 duplicate would then misread as NOT stale (3 <= 2 is
      // false). It must still read as stale — proof turnNumber stayed at
      // the peer's own value, untouched by this call's failed send.
      const duplicate = inboundEnvelope("cnv-race-rollback", "response");
      (duplicate.payload as unknown as InterAgentMessagePayload).turn_number = 3;
      const disposition = await tool.receiveInbound(duplicate);
      expect(disposition.inject).toBe(false);
      expect(disposition.mode).toBe("reply-owed"); // AC9 stale-drop shape
    },
  );

  // issue #222 段階2 差し戻し MF-1 (ふじ): a stale-turn notice allocated by
  // `receiveInbound()` WHILE this side's own send is still in flight used to
  // escape the reject-rollback guard entirely — the notice's
  // `track.turnNumber += 1` was not paired with a `mutationGen` bump, so the
  // guard read `track.mutationGen === genAtDispatch` as "nothing raced in"
  // and rolled back UNDER the number the notice had already put on the
  // wire, reproducing the exact silent stale-drop this issue exists to fix.
  // Deterministic via `makeMultiDeferredAckTool()`'s per-call settlers —
  // the notice fires strictly between this call's dispatch and its
  // (later) reject settling.
  it(
    "issue #222 段階2差し戻し MF-1: 送信中に発火した stale_turn notice の採番は " +
      "reject rollback で消されない (次 outbound は turn 4)",
    async () => {
      const { tool, settlers, outbound } = makeMultiDeferredAckTool();

      // Seed history: turn 1 accepted (track.turnNumber = 1).
      const seed = tool.invoke({
        to: "peer.agent",
        body: "hi",
        kind: "inform",
        conversation_id: "cnv-mf1-notice-collision",
      });
      settlers[0]!({ kind: "accepted", stamp: null });
      expect((await seed).isError).toBeFalsy();

      // This side's own turn 2 attempt — genAtDispatch snapshotted here,
      // before the pre-dispatch bump to turnNumber=2 and before the stale
      // notice below.
      const second = tool.invoke({
        to: "peer.agent",
        body: "you there?",
        kind: "inform",
        conversation_id: "cnv-mf1-notice-collision",
      });
      await Promise.resolve();

      // While that send is still unconfirmed, a late/duplicate inbound
      // (turn_number=1, already <= the provisional track.turnNumber=2)
      // triggers the AC9 stale branch, which builds a `stale_turn` notice
      // consuming turnNumber=3.
      const staleInbound = inboundEnvelope("cnv-mf1-notice-collision", "response");
      (staleInbound.payload as unknown as InterAgentMessagePayload).turn_number = 1;
      const staleDisposition = await tool.receiveInbound(staleInbound);
      expect(staleDisposition.notice).toBeDefined();
      expect(
        (staleDisposition.notice!.payload as unknown as InterAgentMessagePayload)
          .turn_number,
      ).toBe(3);

      // NOW the pending second send settles, rejected for an unrelated
      // reason. Before the fix, `track.mutationGen === genAtDispatch` still
      // read true (the notice never bumped it), so the rollback fired and
      // decremented 3 -> 2 — UNDER the notice's already-sent turn_number=3.
      settlers[1]!({ kind: "rejected", reason: "participants_mismatch" });
      expect((await second).isError).toBe(true);

      // The fix: neither guard condition holds (mutationGen advanced, and
      // track.turnNumber=3 !== sentTurnNumber=2), so the rollback does not
      // fire — track.turnNumber stays at the notice's value.
      const third = tool.invoke({
        to: "peer.agent",
        body: "third",
        kind: "inform",
        conversation_id: "cnv-mf1-notice-collision",
      });
      settlers[2]!({ kind: "accepted", stamp: null });
      expect((await third).isError).toBeFalsy();
      const thirdPayload = outbound[outbound.length - 1]!
        .payload as unknown as InterAgentMessagePayload;
      expect(thirdPayload.turn_number).toBe(4);
    },
  );

  // issue #177 review round 3 must-fix: the pending-done gate was
  // registered before `await this.#dispatch(envelope)` but only released
  // from the two branches that assumed dispatch RESOLVED (accepted/
  // rejected) — a thrown/rejected #dispatch() (a transport failure, not a
  // server-level reject) skipped both, leaving the gate registered
  // forever and hanging every later receiveInbound() for that
  // conversation_id. Mutation-tested: with the try/finally removed (the
  // two explicit releaseGateIfHeld() calls restored in their old
  // branch-only positions), this test times out instead of completing —
  // confirmed manually before finalizing.
  it(
    "round3: #dispatch が reject/throw しても pending-done gate は解放され " +
      "receiveInbound() は永久停止しない (review must-fix)",
    async () => {
      const tool = new InterAgentTool({
        config: configFor("self.agent"),
        getState: () => "tool_running",
        send: () => {
          throw new Error("acceptance-aware sink must be used");
        },
        sendInterAgent: () => Promise.reject(new Error("transport exploded")),
        now: () => "2026-08-08T00:00:00Z",
      });

      await expect(
        tool.invoke({
          to: "peer.agent",
          body: "bye",
          kind: "done",
          conversation_id: "cnv-dispatch-throw",
          done: true,
        }),
      ).rejects.toThrow("transport exploded");

      // If the gate had leaked, this would hang forever (bounded only by
      // vitest's own test timeout) instead of resolving promptly.
      const disposition = await tool.receiveInbound(
        inboundEnvelope("cnv-dispatch-throw", "inform"),
      );
      expect(disposition.inject).toBe(true);
    },
  );
});

describe("isConversationAutoAllowed (issue #175, ADR-0044 F2 追補)", () => {
  it("未知の conversation_id は false", () => {
    const { tool } = makeTool("agent-a");
    expect(tool.isConversationAutoAllowed("never-sent", "agent-b")).toBe(false);
  });

  it(
    "issue #175 review round 3 (ふじ M1): idle TTL (24h) を超えた track は " +
      "次の invoke() を待たず、判定そのものが false になる",
    async () => {
      let clock = 0;
      const tool = new InterAgentTool({
        config: configFor("self.agent"),
        getState: () => "tool_running",
        send: () => {},
        now: () => "2026-08-08T00:00:00Z",
        newId: () => "cnv-auto",
        nowMs: () => clock,
      });

      await tool.invoke({
        to: "agent-b",
        kind: "query",
        body: "hi",
        conversation_id: "cid-idle",
      });
      expect(tool.isConversationAutoAllowed("cid-idle", "agent-b")).toBe(true);

      // 24h + 1ms 経過 — invoke() を一度も挟まず、判定を直接読む。
      clock += 24 * 60 * 60 * 1000 + 1;
      expect(tool.isConversationAutoAllowed("cid-idle", "agent-b")).toBe(false);
    },
  );

  it(
    "issue #175 review round 3 (ふじ M1): cap eviction の対象になった track も " +
      "次の invoke() を待たず、判定そのものが false になる",
    async () => {
      let clock = 0;
      const tool = new InterAgentTool({
        config: configFor("self.agent"),
        getState: () => "tool_running",
        send: () => {},
        now: () => "2026-08-08T00:00:00Z",
        newId: () => "cnv-auto",
        nowMs: () => clock,
        maxTracks: 2,
      });

      for (const cid of ["cid-o1", "cid-o2", "cid-o3"]) {
        clock += 1;
        await tool.invoke({
          to: "agent-b",
          kind: "query",
          body: "hi",
          conversation_id: cid,
        });
      }

      // maxTracks=2: 最も古い cid-o1 は 3 件目の invoke() の時点で既に
      // evict されている想定だが、次の invoke() を挟まず直接読んでも
      // false になっていなければ M1 は再発している。
      expect(tool.isConversationAutoAllowed("cid-o1", "agent-b")).toBe(false);
      // 新しい 2 件はまだ生きている。
      expect(tool.isConversationAutoAllowed("cid-o2", "agent-b")).toBe(true);
      expect(tool.isConversationAutoAllowed("cid-o3", "agent-b")).toBe(true);
    },
  );

  it(
    "issue #175 review round 4 (ふじ 条件 A/B、M2 brand-new reject の反転): " +
      "unknown_agent reject は (conversation_id, to) いずれの組も " +
      "auto-allow しない(両 peer false)",
    async () => {
      const rejecting = new InterAgentTool({
        config: configFor("agent-a"),
        getState: () => "tool_running",
        send: () => {
          throw new Error("acceptance-aware sink must be used");
        },
        sendInterAgent: () =>
          Promise.resolve({ kind: "rejected", reason: "unknown_agent" }),
        now: () => "2026-08-08T00:00:00Z",
        newId: () => "cnv-auto",
      });

      const first = await rejecting.invoke({
        to: "peer-x",
        kind: "inform",
        body: "hi",
        conversation_id: "cid-retarget",
      });
      expect(first.isError).toBe(true);
      // issue #175 review round 4 (ふじ 条件 A): reject された送信は
      // autoAllowedPeer を一切書かないため、実際に宛てた peer-x に対して
      // すら whitelist は成立していない — round 1-3 では pre-dispatch
      // 楽観書き込みにより ここが true になっていたが、その書き込み自体が
      // 廃止された。
      expect(
        rejecting.isConversationAutoAllowed("cid-retarget", "peer-x"),
      ).toBe(false);
      // 同一 conversation_id でも別 to (peer-y) には元々波及しない — これは
      // host.ts の canUseTool が判定する対象だが、InterAgentTool 自身の
      // 状態としても peer-y には紐付いていないことを確認する。
      expect(
        rejecting.isConversationAutoAllowed("cid-retarget", "peer-y"),
      ).toBe(false);
    },
  );

  it(
    "issue #175 review round 3 (内部レビュー、M2 follow-up): 確立済み peer への " +
      "auto-allow は、別 peer への reject された送信で上書きされない",
    async () => {
      let rejectNext = false;
      const tool = new InterAgentTool({
        config: configFor("agent-a"),
        getState: () => "tool_running",
        send: () => {
          throw new Error("acceptance-aware sink must be used");
        },
        sendInterAgent: () =>
          Promise.resolve(
            rejectNext
              ? { kind: "rejected", reason: "unknown_agent" }
              : { kind: "accepted", stamp: null },
          ),
        now: () => "2026-08-08T00:00:00Z",
        newId: () => "cnv-auto",
      });

      // peer-x への送信は成立し、(cid, peer-x) が auto-allow される。
      const established = await tool.invoke({
        to: "peer-x",
        kind: "inform",
        body: "hi",
        conversation_id: "cid-established",
      });
      expect(established.isError).toBeFalsy();
      expect(
        tool.isConversationAutoAllowed("cid-established", "peer-x"),
      ).toBe(true);

      // 同一 conversation_id へ別 peer (peer-y) への送信が (canUseTool の
      // dialog を経て) 承認され invoke() まで到達したが、server に
      // reject される。
      rejectNext = true;
      const toDifferentPeer = await tool.invoke({
        to: "peer-y",
        kind: "inform",
        body: "wrong peer?",
        conversation_id: "cid-established",
      });
      expect(toDifferentPeer.isError).toBe(true);

      // peer-x への auto-allow は生き残っているはず — 上書きされて
      // いなければならない。
      expect(
        tool.isConversationAutoAllowed("cid-established", "peer-x"),
      ).toBe(true);
      // peer-y は reject されており、auto-allow は成立しない。
      expect(
        tool.isConversationAutoAllowed("cid-established", "peer-y"),
      ).toBe(false);
    },
  );

  // issue #175 review round 4, ふじ round 2 (#211, S1): the preceding two
  // tests only exercise "accepted establishes" and "reject never touches" —
  // neither one pins condition A's OWN defining property, that a SECOND
  // accepted ack on the same conversation_id unconditionally REBINDS
  // autoAllowedPeer (not sticky-first). Confirmed by ふじ: swapping
  // `track.autoAllowedPeer = args.to` for `track.autoAllowedPeer ??= args.to`
  // (round 2's original sticky-first bug, reintroduced) leaves every
  // pre-existing regression green — only this test catches it. Mutation-
  // tested per that instruction (see conversation record): with `=` changed
  // to `??=`, ONLY this test fails.
  it(
    "issue #175 review round 4 (ふじ round 2, S1): 2 度目の accepted ack " +
      "(server restart 後の別 peer での再確立を想定) は autoAllowedPeer を " +
      "無条件に rebind する — sticky-first ではない",
    async () => {
      const tool = new InterAgentTool({
        config: configFor("agent-a"),
        getState: () => "tool_running",
        send: () => {
          throw new Error("acceptance-aware sink must be used");
        },
        // to に関わらず常に accepted — 実サーバーはどちらの peer への
        // 送信も受理し得る (再確立の是非を判定するのは server 側)。
        sendInterAgent: () => Promise.resolve({ kind: "accepted", stamp: null }),
        now: () => "2026-08-09T00:00:00Z",
        newId: () => "cnv-auto",
      });

      const first = await tool.invoke({
        to: "peer-a",
        kind: "inform",
        body: "hi",
        conversation_id: "cid-rebind",
      });
      expect(first.isError).toBeFalsy();
      expect(tool.isConversationAutoAllowed("cid-rebind", "peer-a")).toBe(true);

      // 同一 conversation_id への 2 回目の送信 (先方 wrapper の再起動等で
      // 別 peer として再確立された想定) も server に accepted される。
      const second = await tool.invoke({
        to: "peer-b",
        kind: "inform",
        body: "hi, this is actually peer-b now",
        conversation_id: "cid-rebind",
      });
      expect(second.isError).toBeFalsy();

      // 無条件 rebind — peer-a の whitelist は失われ、peer-b に付け替わる。
      // sticky-first (??=) だと peer-a が true のまま残り、この両方の
      // 期待が崩れる。
      expect(tool.isConversationAutoAllowed("cid-rebind", "peer-a")).toBe(
        false,
      );
      expect(tool.isConversationAutoAllowed("cid-rebind", "peer-b")).toBe(
        true,
      );
    },
  );

  it(
    "issue #175 review round 3 (内部レビュー、round 2 follow-up): typo で " +
      "reject された blank track の 1 回目送信は、訂正した 2 回目送信の " +
      "auto-allow を永久に阻害しない",
    async () => {
      let rejectFirst = true;
      const tool = new InterAgentTool({
        config: configFor("agent-a"),
        getState: () => "tool_running",
        send: () => {
          throw new Error("acceptance-aware sink must be used");
        },
        sendInterAgent: () =>
          Promise.resolve(
            rejectFirst
              ? { kind: "rejected", reason: "unknown_agent" }
              : { kind: "accepted", stamp: null },
          ),
        now: () => "2026-08-08T00:00:00Z",
        newId: () => "cnv-auto",
      });

      // 1 回目: typo った peer 名で送信、reject される (blank track のまま)。
      const typo = await tool.invoke({
        to: "peer-typo",
        kind: "inform",
        body: "hi",
        conversation_id: "cid-typo-fix",
      });
      expect(typo.isError).toBe(true);

      // 2 回目: 訂正した peer 名で再送し、成立する。
      rejectFirst = false;
      const corrected = await tool.invoke({
        to: "peer-correct",
        kind: "inform",
        body: "hi (corrected)",
        conversation_id: "cid-typo-fix",
      });
      expect(corrected.isError).toBeFalsy();

      // 訂正後の正しい peer が auto-allow されていなければならない —
      // 誤った 1 回目の peer が永久にスロットを占有してはいけない。
      expect(
        tool.isConversationAutoAllowed("cid-typo-fix", "peer-correct"),
      ).toBe(true);
    },
  );

  it("新規 conversation (id 省略) は 1 回目送信後、割り当てられた id が true になる", async () => {
    const { tool, capture } = makeTool("agent-a");
    await tool.invoke({ to: "agent-b", kind: "query", body: "hi" });
    const allocated = capture.ids[0]!;
    expect(tool.isConversationAutoAllowed(allocated, "agent-b")).toBe(true);
  });

  it("明示 conversation_id での送信後、その id が true になる", async () => {
    const { tool } = makeTool("agent-a");
    await tool.invoke({
      to: "agent-b",
      kind: "query",
      body: "hi",
      conversation_id: "cid-explicit",
    });
    expect(tool.isConversationAutoAllowed("cid-explicit", "agent-b")).toBe(true);
  });

  it("別の conversation_id には波及しない(conversation 単位)", async () => {
    const { tool } = makeTool("agent-a");
    await tool.invoke({
      to: "agent-b",
      kind: "query",
      body: "hi",
      conversation_id: "cid-a",
    });
    expect(tool.isConversationAutoAllowed("cid-a", "agent-b")).toBe(true);
    expect(tool.isConversationAutoAllowed("cid-b", "agent-b")).toBe(false);
  });

  it("wrapper インスタンスごとに独立する(同じ id でも別 InterAgentTool には波及しない)", async () => {
    const { tool: toolA } = makeTool("agent-a");
    const { tool: toolB } = makeTool("agent-b");
    await toolA.invoke({
      to: "agent-b",
      kind: "query",
      body: "hi",
      conversation_id: "shared-cid",
    });
    expect(toolA.isConversationAutoAllowed("shared-cid", "agent-b")).toBe(true);
    expect(toolB.isConversationAutoAllowed("shared-cid", "agent-b")).toBe(false);
  });

  it("AC10 のローカル reject (既に closed な会話への再送) は他 id へ波及しない", async () => {
    const { tool } = makeTool("agent-a");
    // Mutual done closes the conversation locally (turn_number=1 send +
    // turn_number=2 inbound done=true reply).
    await tool.invoke({
      to: "agent-b",
      kind: "done",
      body: "bye",
      conversation_id: "cid-closing",
      done: true,
    });
    await tool.receiveInbound({
      version: "0",
      agent_id: "peer.agent",
      persona: PERSONA,
      display_name: PERSONA.name,
      ts: "2026-07-23T12:00:00Z",
      type: "inter_agent_message",
      state: "tool_running",
      payload: {
        to: "agent-a",
        conversation_id: "cid-closing",
        turn_number: 2,
        kind: "done",
        body: "bye too",
        meta: { done: true, propose_next: "" },
        owner: { kind: "user", id: "operator" },
      },
      ext: {},
    });
    // A further send on the now-closed conversation is locally rejected
    // (AC10, an early return before any track mutation) — assert this
    // neither falsely marks an unrelated conversation NOR corrupts
    // cid-closing's own auto-allow status (established by the very
    // first — accepted — send above, review round 2: the prior version
    // of this test never checked the conversation it actually
    // exercises).
    const result = await tool.invoke({
      to: "agent-b",
      kind: "query",
      body: "too late",
      conversation_id: "cid-closing",
    });
    expect(JSON.stringify(result)).toContain("already closed");
    expect(tool.isConversationAutoAllowed("cid-closing", "agent-b")).toBe(true);
    expect(tool.isConversationAutoAllowed("cid-unrelated", "agent-b")).toBe(false);
  });
});

// issue #175 review round 4 (ふじ design-review approve, #211 comment
// 2719 条件 B): an `unknown` acceptance (ack never arrived — delivery
// unconfirmed) must never promote a (conversation_id, to) pair into the
// whitelist. Only `accepted` may. こはく/あお's provisional stance,
// confirmed by ふじ: the asymmetry is deliberate — `unknown`-as-success
// would let a send whose delivery is unconfirmed auto-allow every later
// send to that peer (permission-bypass direction), while `accepted`-only
// costs nothing worse than an extra operator dialog while `unknown`
// persists.
describe(
  "isConversationAutoAllowed — unknown acceptance は whitelist へ " +
    "昇格しない (issue #175 review round 4, ふじ 条件 B)",
  () => {
    it("brand-new conversation への unknown ack は whitelist を確立しない", async () => {
      const tool = new InterAgentTool({
        config: configFor("agent-a"),
        getState: () => "tool_running",
        send: () => {
          throw new Error("acceptance-aware sink must be used");
        },
        sendInterAgent: () =>
          Promise.resolve({ kind: "unknown", reason: "timeout" }),
        now: () => "2026-08-09T00:00:00Z",
        newId: () => "cnv-auto",
      });

      const first = await tool.invoke({
        to: "peer-x",
        kind: "inform",
        body: "hi",
        conversation_id: "cid-unknown-brand-new",
      });
      expect(first.isError).toBeFalsy();
      expect(
        tool.isConversationAutoAllowed("cid-unknown-brand-new", "peer-x"),
      ).toBe(false);
    });

    it(
      "accepted で確立済みの peer-x はそのまま — 別 to への operator-approved " +
        "unknown (peer-y) は peer-y を false のままにする",
      async () => {
        let ackKind: "accepted" | "unknown" = "accepted";
        const tool = new InterAgentTool({
          config: configFor("agent-a"),
          getState: () => "tool_running",
          send: () => {
            throw new Error("acceptance-aware sink must be used");
          },
          sendInterAgent: () =>
            Promise.resolve(
              ackKind === "accepted"
                ? { kind: "accepted", stamp: null }
                : { kind: "unknown", reason: "timeout" },
            ),
          now: () => "2026-08-09T00:00:00Z",
          newId: () => "cnv-auto",
        });

        const first = await tool.invoke({
          to: "peer-x",
          kind: "inform",
          body: "hi",
          conversation_id: "cid-unknown-b",
        });
        expect(first.isError).toBeFalsy();
        expect(
          tool.isConversationAutoAllowed("cid-unknown-b", "peer-x"),
        ).toBe(true);

        ackKind = "unknown";
        const second = await tool.invoke({
          to: "peer-y",
          kind: "inform",
          body: "different peer, ack unknown",
          conversation_id: "cid-unknown-b",
        });
        // unknown はエラーではない ("delivery unknown" の非エラーテキスト
        // — ADR-0051 D3-2)。
        expect(second.isError).toBeFalsy();

        expect(
          tool.isConversationAutoAllowed("cid-unknown-b", "peer-x"),
        ).toBe(true);
        expect(
          tool.isConversationAutoAllowed("cid-unknown-b", "peer-y"),
        ).toBe(false);
      },
    );

    it(
      "unknown の後に同一 (conversation_id, to) へ accepted が来て、その時点で " +
        "初めて true になる",
      async () => {
        let ackKind: "accepted" | "unknown" = "unknown";
        const tool = new InterAgentTool({
          config: configFor("agent-a"),
          getState: () => "tool_running",
          send: () => {
            throw new Error("acceptance-aware sink must be used");
          },
          sendInterAgent: () =>
            Promise.resolve(
              ackKind === "unknown"
                ? { kind: "unknown", reason: "timeout" }
                : { kind: "accepted", stamp: null },
            ),
          now: () => "2026-08-09T00:00:00Z",
          newId: () => "cnv-auto",
        });

        const first = await tool.invoke({
          to: "peer-x",
          kind: "inform",
          body: "hi",
          conversation_id: "cid-unknown-then-accept",
        });
        expect(first.isError).toBeFalsy();
        expect(
          tool.isConversationAutoAllowed("cid-unknown-then-accept", "peer-x"),
        ).toBe(false);

        ackKind = "accepted";
        const second = await tool.invoke({
          to: "peer-x",
          kind: "inform",
          body: "retry",
          conversation_id: "cid-unknown-then-accept",
        });
        expect(second.isError).toBeFalsy();
        expect(
          tool.isConversationAutoAllowed("cid-unknown-then-accept", "peer-x"),
        ).toBe(true);
      },
    );
  },
);

// issue #175 review round 3 (ふじ M3, gitea issue #211): #211's race —
// receiveInbound() legitimately mutating a track while a non-`done`
// invoke() is still awaiting #dispatch() — predates #175. Round 3 closed
// it for the `closed`/`turnNumber` fields via the `mutationGen` guard on
// the reject-cleanup branch (test (a) below, and the C1/C2/C3/C4/C5
// mutation tests further down). Round 4 (ふじ design-review approve,
// #211 comment 2719 条件 A) additionally closed a SEPARATE
// permission-bypass window round 3 had reintroduced specifically for
// `autoAllowedPeer` — by moving that field's write from an optimistic
// pre-dispatch guess (preserved across resets) to "written only on a
// server-accepted ack", a rejected send racing against this same
// terminal inbound no longer establishes the whitelist AT ALL, so there
// is nothing left for the race to leak past (test (b) below, now
// asserting the inverse of round 3's expectation).
describe(
  "issue #175 review round 3 (ふじ M3, #211): 非 done 送信の dispatch 中 " +
    "race から permission bypass を防ぐ",
  () => {
    function makeDeferredAckTool(agentId: string): {
      tool: InterAgentTool;
      settle: (acceptance: InterAgentAcceptance) => void;
    } {
      let resolveAck!: (acceptance: InterAgentAcceptance) => void;
      const pending = new Promise<InterAgentAcceptance>((resolve) => {
        resolveAck = resolve;
      });
      const tool = new InterAgentTool({
        config: configFor(agentId),
        getState: () => "tool_running",
        send: () => {
          throw new Error("acceptance-aware sink must be used");
        },
        sendInterAgent: () => pending,
        now: () => "2026-08-09T00:00:00Z",
        newId: () => "cnv-auto",
      });
      return { tool, settle: resolveAck };
    }

    function synthHardLimitClose(conversationId: string): Envelope {
      return {
        version: "0",
        agent_id: "server",
        persona: PERSONA,
        display_name: PERSONA.name,
        ts: "2026-08-09T00:00:01Z",
        type: "inter_agent_message",
        state: "tool_running",
        payload: {
          to: "self.agent",
          conversation_id: conversationId,
          turn_number: 0,
          kind: "escalate-to-user",
          body: "conversation auto-terminated: max_turns",
          meta: { done: true, propose_next: "" },
          owner: { kind: "user", id: "system" },
        },
        ext: {},
      };
    }

    // ふじ regression (a): ack 保留中に届いた terminal inbound は、その
    // 後 conversation_closed 以外の理由で reject されても CLOSED を保持する。
    // このシナリオ (synthetic terminal で closed が false→true に変化する)
    // は、round 4 ふじ 条件 C が要求する mutation test 5 本のうち「synthetic
    // terminal で closed false→true (cleanup 保全)」(C3) を兼ねる —
    // 別途複製しない。
    it(
      "ack 保留中の terminal inbound は、非 conversation_closed reject 後も " +
        "CLOSED を保持する (ふじ 条件 C mutation test C3 を兼ねる)",
      async () => {
        const { tool, settle } = makeDeferredAckTool("self.agent");

        const invokePromise = tool.invoke({
          to: "peer.agent",
          body: "hi",
          kind: "inform",
          conversation_id: "cid-race",
        });

        // #dispatch() 未解決のうちに、正当な server 合成 hard-limit close
        // が同じ conversation_id へ届く。
        const disposition = await tool.receiveInbound(
          synthHardLimitClose("cid-race"),
        );
        expect(disposition.mode).toBe("terminal");

        // 送信は conversation_closed 以外の理由で reject される。
        settle({ kind: "rejected", reason: "unknown_agent" });
        await invokePromise;

        // CLOSED は保持されているはず — 通常の inbound がまだ terminal
        // と判定されることで確認する。turn_number=2: race が正しく検知
        // されればこの送信の turnNumber=1 という自分自身の楽観的更新は
        // 巻き戻されない(reset 分岐が発火しないため)ので、次の inbound
        // は turn_number=1 では stale 判定されてしまう — 2 を使う。
        const after = await tool.receiveInbound({
          version: "0",
          agent_id: "peer.agent",
          persona: PERSONA,
          display_name: PERSONA.name,
          ts: "2026-08-09T00:00:02Z",
          type: "inter_agent_message",
          state: "tool_running",
          payload: {
            to: "self.agent",
            conversation_id: "cid-race",
            turn_number: 2,
            kind: "inform",
            body: "are you still there?",
            meta: { done: false, propose_next: "" },
            owner: { kind: "user", id: "operator" },
          },
          ext: {},
        });
        expect(after.mode).toBe("terminal");
      },
    );

    // ふじ regression (b) — issue #175 review round 4 (ふじ 条件 A、#211
    // M3 regression (b) の反転) で意図的に反転: round 3 の設計では reject
    // された送信でも autoAllowedPeer が pre-dispatch 楽観書き込みのまま
    // 生き残っていたため、ここは true だった。round 4 では reject が
    // 一切 whitelist を書かないため、whitelist はそもそも成立しない —
    // CLOSED guard (AC10) と合わせた二重防御になる。
    it(
      "reject された送信は whitelist を確立せず (条件 A)、CLOSED guard " +
        "(AC10) も別途迂回しない — 二重防御で再送はローカル reject される",
      async () => {
        const { tool, settle } = makeDeferredAckTool("self.agent");

        const invokePromise = tool.invoke({
          to: "peer.agent",
          body: "hi",
          kind: "inform",
          conversation_id: "cid-race-2",
        });
        await tool.receiveInbound(synthHardLimitClose("cid-race-2"));
        settle({ kind: "rejected", reason: "unknown_agent" });
        await invokePromise;

        // reject は autoAllowedPeer を一切書かない — whitelist はそもそも
        // 成立していない。
        expect(
          tool.isConversationAutoAllowed("cid-race-2", "peer.agent"),
        ).toBe(false);

        // whitelist 不成立に加え、CLOSED guard (AC10) も独立に再送を
        // ローカル reject する — server の tombstone TTL 経過後を想定した
        // 再送でも、無承認で dispatch まで進むことはない。
        const retry = await tool.invoke({
          to: "peer.agent",
          body: "still trying",
          kind: "inform",
          conversation_id: "cid-race-2",
        });
        expect(retry.isError).toBe(true);
        expect(JSON.stringify(retry)).toContain("already closed");
      },
    );

    // issue #175 review round 4 (ふじ 条件 C, #211 comment 2719): 5 本の
    // mutation test のうち、C3 は上の "ack 保留中の terminal inbound..."
    // テストが兼ねる。以下は残り 4 本 (C1/C2/C4/C5)。いずれも
    // `mutationGen` の加算条件 (turnNumber / remoteDone / closed の実変化)
    // を、invoke() の reject-cleanup ガードの発火有無という外部から観測
    // 可能な効果を通じて検証する — `mutationGen` 自体に公開アクセサは
    // ないため、これが唯一の観測経路。

    it(
      "mutation test C1: turnNumber のみ前進する inbound (done=false) は " +
        "gen を進め、reject-cleanup を止める(turnNumber は前進したまま残る)",
      async () => {
        const { tool, settle } = makeDeferredAckTool("self.agent");
        const invokePromise = tool.invoke({
          to: "peer.agent",
          body: "hi",
          kind: "inform",
          conversation_id: "cid-mut-c1",
        });
        // invoke() 自身の楽観的な turnNumber+=1 (0→1) が既に走っている
        // ため、turn_number=2 でなければ stale 判定されてしまう。
        await tool.receiveInbound({
          version: "0",
          agent_id: "peer.agent",
          persona: PERSONA,
          display_name: PERSONA.name,
          ts: "2026-08-09T00:00:01Z",
          type: "inter_agent_message",
          state: "tool_running",
          payload: {
            to: "self.agent",
            conversation_id: "cid-mut-c1",
            turn_number: 2,
            kind: "inform",
            body: "advance",
            meta: { done: false, propose_next: "" },
            owner: { kind: "user", id: "operator" },
          },
          ext: {},
        });
        settle({ kind: "rejected", reason: "unknown_agent" });
        await invokePromise;

        // turnNumber=2 が生き残っていれば(reset されていなければ)、
        // turn_number=2 の再送は stale として扱われる。
        const stale = await tool.receiveInbound({
          version: "0",
          agent_id: "peer.agent",
          persona: PERSONA,
          display_name: PERSONA.name,
          ts: "2026-08-09T00:00:02Z",
          type: "inter_agent_message",
          state: "tool_running",
          payload: {
            to: "self.agent",
            conversation_id: "cid-mut-c1",
            turn_number: 2,
            kind: "inform",
            body: "duplicate",
            meta: { done: false, propose_next: "" },
            owner: { kind: "user", id: "operator" },
          },
          ext: {},
        });
        expect(stale.inject).toBe(false);
      },
    );

    it(
      "mutation test C2: 通常 inbound の remoteDone false→true " +
        "(turnNumber 前進を伴う) は gen を進め、reject-cleanup を止める",
      async () => {
        const { tool, settle } = makeDeferredAckTool("self.agent");
        const invokePromise = tool.invoke({
          to: "peer.agent",
          body: "hi",
          kind: "inform",
          conversation_id: "cid-mut-c2",
        });
        // invoke() 自身の楽観的な turnNumber+=1 (0→1) があるため、ここも
        // turn_number=2 を使う。
        await tool.receiveInbound({
          version: "0",
          agent_id: "peer.agent",
          persona: PERSONA,
          display_name: PERSONA.name,
          ts: "2026-08-09T00:00:01Z",
          type: "inter_agent_message",
          state: "tool_running",
          payload: {
            to: "self.agent",
            conversation_id: "cid-mut-c2",
            turn_number: 2,
            kind: "done",
            body: "closing my side",
            meta: { done: true, propose_next: "" },
            owner: { kind: "user", id: "operator" },
          },
          ext: {},
        });
        settle({ kind: "rejected", reason: "unknown_agent" });
        await invokePromise;

        // remoteDone=true が生き残っていれば(reset されていなければ)、
        // 後続の inbound は close-proposal と判定される。
        const after = await tool.receiveInbound({
          version: "0",
          agent_id: "peer.agent",
          persona: PERSONA,
          display_name: PERSONA.name,
          ts: "2026-08-09T00:00:02Z",
          type: "inter_agent_message",
          state: "tool_running",
          payload: {
            to: "self.agent",
            conversation_id: "cid-mut-c2",
            turn_number: 3,
            kind: "inform",
            body: "still open?",
            meta: { done: false, propose_next: "" },
            owner: { kind: "user", id: "operator" },
          },
          ext: {},
        });
        expect(after.mode).toBe("close-proposal");
      },
    );

    it(
      "mutation test C4: synthetic disconnected 通知 (turn=0, done=false) " +
        "は 3 field とも不変 → gen 不変 → brand-new reject cleanup が実行 " +
        "され、後続 turn_number=1 は stale にならない",
      async () => {
        const { tool, settle } = makeDeferredAckTool("self.agent");
        const invokePromise = tool.invoke({
          to: "peer.agent",
          body: "hi",
          kind: "inform",
          conversation_id: "cid-mut-c4",
        });
        await tool.receiveInbound({
          version: "0",
          agent_id: "server",
          persona: PERSONA,
          display_name: PERSONA.name,
          ts: "2026-08-09T00:00:01Z",
          type: "inter_agent_message",
          state: "tool_running",
          payload: {
            to: "self.agent",
            conversation_id: "cid-mut-c4",
            turn_number: 0,
            kind: "inform",
            body: "peer disconnected",
            meta: { done: false, propose_next: "" },
            owner: { kind: "user", id: "system" },
          },
          ext: {},
        });
        settle({ kind: "rejected", reason: "unknown_agent" });
        await invokePromise;

        // reset が実行されていれば turnNumber は 0 に戻るので、
        // turn_number=1 は stale にならず注入される。
        const after = await tool.receiveInbound({
          version: "0",
          agent_id: "peer.agent",
          persona: PERSONA,
          display_name: PERSONA.name,
          ts: "2026-08-09T00:00:02Z",
          type: "inter_agent_message",
          state: "tool_running",
          payload: {
            to: "self.agent",
            conversation_id: "cid-mut-c4",
            turn_number: 1,
            kind: "inform",
            body: "hello?",
            meta: { done: false, propose_next: "" },
            owner: { kind: "user", id: "operator" },
          },
          ext: {},
        });
        expect(after.inject).toBe(true);
      },
    );

    it(
      "mutation test C5: mutationGen に触れない stale/duplicate な inbound " +
        "(通知対象外) は mutationGen に触れず (brand-new reject cleanup は " +
        "引き続き実行される)",
      async () => {
        const { tool, settle } = makeDeferredAckTool("self.agent");
        const invokePromise = tool.invoke({
          to: "peer.agent",
          body: "hi",
          kind: "inform",
          conversation_id: "cid-mut-c5",
        });
        // invoke() 自身の楽観的な turnNumber+=1 (0→1) により、
        // turn_number=1 の inbound はこの時点で duplicate/stale 扱いになる。
        // issue #222 段階2差し戻し MF-1 (ふじ) 後、通常の stale duplicate は
        // stale_turn notice を採番し mutationGen を bump するようになった
        // (その振る舞いは上の MF-1 専用テストが pin する) — この C5 テストは
        // 「stale delivery そのものが mutationGen に触れない no-op の場合」
        // を保つため、意図的に notice 対象外 (`payload.error` 付き = それ自体
        // が通知) の stale duplicate を使う。
        const staleDisposition = await tool.receiveInbound({
          version: "0",
          agent_id: "peer.agent",
          persona: PERSONA,
          display_name: PERSONA.name,
          ts: "2026-08-09T00:00:01Z",
          type: "inter_agent_message",
          state: "tool_running",
          payload: {
            to: "self.agent",
            conversation_id: "cid-mut-c5",
            turn_number: 1,
            kind: "inform",
            body: "duplicate",
            meta: { done: false, propose_next: "" },
            owner: { kind: "user", id: "operator" },
            error: { code: "stale_turn", message: "peer already sent this" },
          },
          ext: {},
        });
        expect(staleDisposition.inject).toBe(false);
        expect(staleDisposition.notice).toBeUndefined();

        settle({ kind: "rejected", reason: "unknown_agent" });
        await invokePromise;

        // reset が実行されていれば turnNumber は 0 に戻るので、
        // turn_number=1 はもはや stale ではない。
        const after = await tool.receiveInbound({
          version: "0",
          agent_id: "peer.agent",
          persona: PERSONA,
          display_name: PERSONA.name,
          ts: "2026-08-09T00:00:02Z",
          type: "inter_agent_message",
          state: "tool_running",
          payload: {
            to: "self.agent",
            conversation_id: "cid-mut-c5",
            turn_number: 1,
            kind: "inform",
            body: "hello?",
            meta: { done: false, propose_next: "" },
            owner: { kind: "user", id: "operator" },
          },
          ext: {},
        });
        expect(after.inject).toBe(true);
      },
    );
  },
);

// issue #177 review M4 (AC13): two independent InterAgentTool instances
// wired directly to each other — the routing a real server would do,
// without a network or process boundary. This proves the CROSS-WRAPPER
// termination behaviour AC13 cares about (does the exchange actually
// stop after both sides agree done, even when a late message follows) at
// the engine-agnostic agent-common level; a full 2-process/network E2E
// would need new test infrastructure this repo does not have. The
// adapter-level glue tests (claude-code/codex
// test/inter_agent_lifecycle_glue.test.ts) separately prove each
// engine's host wiring respects the same disposition contract this test
// exercises.
describe("issue #177 review M4: 2-agent in-process E2E (AC13)", () => {
  function makeAgent(
    agentId: string,
    outbound: Envelope[],
  ): InterAgentTool {
    return new InterAgentTool({
      config: configFor(agentId),
      getState: () => "tool_running",
      send: (env) => outbound.push(env),
      now: () => "2026-08-08T00:00:00Z",
      newId: () => "cnv-e2e",
    });
  }

  it("両側 done 合意後、重複再送された過去 turn は追加の send を 0 件で止める", async () => {
    const aOutbound: Envelope[] = [];
    const bOutbound: Envelope[] = [];
    const a = makeAgent("agent-a", aOutbound);
    const b = makeAgent("agent-b", bOutbound);

    // 1. A -> B: done=true (A が先に完了提案)。
    const aSend = await a.invoke({
      to: "agent-b",
      body: "done from A",
      kind: "done",
      conversation_id: "cnv-e2e",
      done: true,
    });
    expect(aSend.isError).toBeFalsy();
    expect(aOutbound).toHaveLength(1);
    const aToB = aOutbound[0]!;

    // 2. B receives A's done=true — close-proposal (B はまだ done してい
    // ない)。
    expect((await b.receiveInbound(aToB)).mode).toBe("close-proposal");

    // B、close proposal に応えて自分も done=true を返す。
    const bSend = await b.invoke({
      to: "agent-a",
      body: "done from B too",
      kind: "done",
      conversation_id: "cnv-e2e",
      done: true,
    });
    expect(bSend.isError).toBeFalsy();
    expect(bOutbound).toHaveLength(1);
    const bToA = bOutbound[0]!;

    // 3. A receives B's done=true — 両側揃って terminal。
    expect((await a.receiveInbound(bToA)).mode).toBe("terminal");

    // 4. 遅延到着: B から A への同じ turn がネットワークの遅延で重複
    // 配送されたとする。
    const staleRedelivery: Envelope = { ...bToA, payload: { ...bToA.payload } };
    expect((await a.receiveInbound(staleRedelivery)).inject).toBe(false);

    // A / B とも、ここまでに追加の send は一切発生していない
    // (追加往復 0 回で停止 — AC13)。
    expect(aOutbound).toHaveLength(1);
    expect(bOutbound).toHaveLength(1);
  });

  it("両側 done 合意後、stale ではない late message も terminal 分類され追加 send を誘発しない", async () => {
    const aOutbound: Envelope[] = [];
    const bOutbound: Envelope[] = [];
    const a = makeAgent("agent-a", aOutbound);
    const b = makeAgent("agent-b", bOutbound);

    await a.invoke({
      to: "agent-b",
      body: "done from A",
      kind: "done",
      conversation_id: "cnv-e2e-late",
      done: true,
    });
    const aToB = aOutbound[0]!;
    await b.receiveInbound(aToB);

    await b.invoke({
      to: "agent-a",
      body: "done from B too",
      kind: "done",
      conversation_id: "cnv-e2e-late",
      done: true,
    });
    const bToA = bOutbound[0]!;
    expect((await a.receiveInbound(bToA)).mode).toBe("terminal");

    // B が事前に(想定外に)もう 1 ターン多く送っていた場合の遅延到着を
    // 模す — turn_number は STALE ではない(新しい)が、A はもう
    // terminal。mode は "terminal" のまま、かつ issue #221 direction 1
    // により inject も false(track は更新されるが model は起こさない —
    // adapter-level glue test の "AC8" ケースと同じ契約)。
    const lateFresh = inboundEnvelope("cnv-e2e-late", "inform");
    (lateFresh.payload as unknown as InterAgentMessagePayload).turn_number =
      ((bToA.payload as unknown as InterAgentMessagePayload).turn_number ?? 0) + 1;
    lateFresh.agent_id = "agent-b";
    const lateDisposition = await a.receiveInbound(lateFresh);
    expect(lateDisposition.inject).toBe(false);
    expect(lateDisposition.mode).toBe("terminal");

    // terminal は receiveInbound() 自体が inject: false を返す(issue #221
    // direction 1)ので、A 側からの追加 send は起きない — 実際に
    // aOutbound は増えていない。
    expect(aOutbound).toHaveLength(1);
  });
});

// issue #222 段階2 (受け入れ条件3): 2-agent in-process E2E, same style as
// AC13 above. Desyncs B's track using the `unknown`-acceptance gap — the
// ONE residual desync path issue #222 explicitly does NOT close (段階1's
// rollback fix only covers `rejected`; an `unknown` ack means delivery is
// genuinely unconfirmed, so rolling back risks a real double-spend if the
// send actually landed — see `invoke()`'s own comment on why `unknown` is
// left alone). This is deliberate, not a weaker substitute for the
// original incident's shape: the ORIGINAL incident desynced the RECEIVING
// side's own track via its own earlier unrolled-back send, then collided
// with the peer's legitimate next turn — exactly reproduced here, just via
// the one gap 段階1 could not close rather than the one it did.
describe("issue #222 段階2: stale drop 時に stale_turn notice を送信側へ返す (受け入れ条件3)", () => {
  it("stale drop が発生したとき、送信側へ payload.error.code=stale_turn が届き、track が再同期される", async () => {
    const aOutbound: Envelope[] = [];
    const bOutbound: Envelope[] = [];
    const bAcks: InterAgentAcceptance[] = [
      { kind: "accepted", stamp: null },
      { kind: "unknown", reason: "ack timeout" },
    ];
    let bAckCall = 0;
    const a = new InterAgentTool({
      config: configFor("agent-a"),
      getState: () => "tool_running",
      send: (env) => aOutbound.push(env),
      now: () => "2026-08-08T00:00:00Z",
    });
    const b = new InterAgentTool({
      config: configFor("agent-b"),
      getState: () => "tool_running",
      send: (env) => bOutbound.push(env),
      sendInterAgent: (env) => {
        bOutbound.push(env);
        const ack = bAcks[bAckCall] ?? { kind: "accepted" as const, stamp: null };
        bAckCall += 1;
        return Promise.resolve(ack);
      },
      now: () => "2026-08-08T00:00:00Z",
    });

    // 1. A -> B: turn 1 (normal, accepted). B's track advances to 1.
    const aTurn1 = await a.invoke({
      to: "agent-b",
      body: "hi",
      kind: "inform",
      conversation_id: "cnv-resync",
    });
    expect(aTurn1.isError).toBeFalsy();
    expect((await b.receiveInbound(aOutbound[0]!)).inject).toBe(true);

    // 2. B -> A: turn 2 (normal, accepted). A's track advances to 2.
    const bTurn2 = await b.invoke({
      to: "agent-a",
      body: "hi back",
      kind: "inform",
      conversation_id: "cnv-resync",
    });
    expect(bTurn2.isError).toBeFalsy();
    expect((await a.receiveInbound(bOutbound[0]!)).inject).toBe(true);

    // 3. B attempts turn 3, but its ack is `unknown` (lost/timeout) — B's
    // OWN track still advances to 3 regardless (issue #222's documented,
    // deliberately unfixed residual). Simulate it NEVER actually reaching
    // A: bOutbound[1] is never forwarded to a.receiveInbound().
    const bTurn3 = await b.invoke({
      to: "agent-a",
      body: "still there?",
      kind: "inform",
      conversation_id: "cnv-resync",
    });
    expect(bTurn3.isError).toBeFalsy();
    expect(bOutbound).toHaveLength(2);

    // 4. A sends its OWN next legitimate turn (A's turn 3, correctly
    // following the turn 2 it received) — B's track is ALSO at 3 (from its
    // own phantom send), so this collides: B judges A's genuine turn 3
    // stale, exactly reproducing the incident's shape.
    const aTurn3 = await a.invoke({
      to: "agent-b",
      body: "you there?",
      kind: "inform",
      conversation_id: "cnv-resync",
    });
    expect(aTurn3.isError).toBeFalsy();
    const disposition = await b.receiveInbound(aOutbound[1]!);
    expect(disposition.inject).toBe(false);
    expect(disposition.notice).toBeDefined();

    // 5. The notice is the accept-criteria's own wording: payload.error.
    // code === "stale_turn", addressed back to the original sender (A).
    const noticePayload = disposition.notice!
      .payload as unknown as InterAgentMessagePayload;
    expect(noticePayload.to).toBe("agent-a");
    expect(noticePayload.error?.code).toBe("stale_turn");
    expect(disposition.notice!.agent_id).toBe("agent-b");

    // 6. Resync effect: A receives the notice as an ordinary (non-stale)
    // inbound — its own track is at 3, the notice's turn_number is 4 — and
    // advances to match. Verified indirectly: a duplicate of the SAME
    // notice, delivered again, is now stale on A's side too, AND (per the
    // payload.error exemption) does NOT trigger a further notice — proof
    // the notice/notice loop guard also holds end-to-end, not just in the
    // unit-level receiveInbound() tests.
    expect((await a.receiveInbound(disposition.notice!)).inject).toBe(true);
    const duplicateOfNotice: Envelope = {
      ...disposition.notice!,
      payload: { ...disposition.notice!.payload },
    };
    const resyncDrop = await a.receiveInbound(duplicateOfNotice);
    expect(resyncDrop.inject).toBe(false);
    expect(resyncDrop.notice).toBeUndefined();
  });
});
