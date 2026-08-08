import { describe, expect, it, vi } from "vitest";
import {
  INTER_AGENT_TOOL_FQN,
  InterAgentTool,
  LIST_AGENTS_TOOL_FQN,
  WHOAMI_TOOL_FQN,
  classifyInterAgentError,
  formatInboundMessage,
  isFormattedInterAgentMessage,
  type WhoamiSnapshot,
} from "../src/inter_agent.js";
import type {
  DirectoryEntry,
  InterAgentAcceptance,
} from "@kaoiro/wrapper-core";
import type {
  Envelope,
  InterAgentErrorPayload,
  InterAgentMessagePayload,
  WrapperConfig,
} from "../src/types.js";

const PERSONA = { id: "mio", name: "澪", sprite_set: "mio" };

function configFor(agentId: string): WrapperConfig {
  return {
    agent_id: agentId,
    persona: PERSONA,
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
    send: (env) => capture.envelopes.push(env),
    now: () => "2026-06-29T12:34:56Z",
    newId: capture.newId,
  });
  return { tool, capture };
}

function inboundEnvelope(
  conversationId: string,
  kind: InterAgentMessagePayload["kind"] = "response",
  error?: InterAgentErrorPayload,
): Envelope {
  return {
    version: "0",
    agent_id: "peer.agent",
    persona: PERSONA,
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
    expect(tool.receiveInbound(inbound)).toBe(true);
    expect(tool.receiveInbound(inbound)).toBe(false);

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
      expect(tool.receiveInbound(inboundEnvelope("cnv-timeout"))).toBe(false);
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
        aConsumed = tool.receiveInbound(inboundEnvelope("cnv-a"));
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
        bConsumed = tool.receiveInbound(inboundEnvelope("cnv-b"));
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
    expect(tool.receiveInbound(inbound)).toBe(true);

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

describe("pending-injection error notices (issue #131, turn-scoped resolveTurnEnd)", () => {
  it("resolveTurnEnd は notePendingInjection 済みの conversation を送信元宛の envelope にして返す", () => {
    const { tool, capture } = makeTool("self.agent");
    tool.notePendingInjection(inboundEnvelope("cnv-pending"));

    const notices = tool.resolveTurnEnd("cnv-pending", {
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

  it("conversationId が null なら常に空配列 (操作者ターンのタグ無し)", () => {
    const { tool } = makeTool("self.agent");
    tool.notePendingInjection(inboundEnvelope("cnv-untouched"));
    expect(
      tool.resolveTurnEnd(null, { code: "api_error", message: "x" }),
    ).toEqual([]);
    // untouched entry survives a null-tagged turn resolution
    expect(
      tool.resolveTurnEnd("cnv-untouched", { code: "api_error", message: "y" }),
    ).toHaveLength(1);
  });

  it("成功ターン (error省略) は通知を出さず pending を消費するだけ", () => {
    const { tool } = makeTool("self.agent");
    tool.notePendingInjection(inboundEnvelope("cnv-quiet-success"));

    expect(tool.resolveTurnEnd("cnv-quiet-success")).toEqual([]);
    // already cleared — a LATER, unrelated turn's error must not resurrect it
    expect(
      tool.resolveTurnEnd("cnv-quiet-success", {
        code: "api_error",
        message: "unrelated later failure",
      }),
    ).toEqual([]);
  });

  it("invoke() で同じ conversation に返信すると pending が解消し resolveTurnEnd は何も返さない", async () => {
    const { tool } = makeTool("self.agent");
    tool.notePendingInjection(inboundEnvelope("cnv-replied"));
    await tool.invoke({
      to: "peer.agent",
      body: "実は返信できた",
      kind: "response",
      conversation_id: "cnv-replied",
    });

    expect(
      tool.resolveTurnEnd("cnv-replied", { code: "api_error", message: "x" }),
    ).toEqual([]);
  });

  it("同じ conversationId を2回 resolve しても2回目は空配列 (二重通知防止)", () => {
    const { tool } = makeTool("self.agent");
    expect(
      tool.resolveTurnEnd("cnv-none", { code: "api_error", message: "x" }),
    ).toEqual([]);

    tool.notePendingInjection(inboundEnvelope("cnv-once"));
    const first = tool.resolveTurnEnd("cnv-once", {
      code: "api_error",
      message: "first",
    });
    expect(first).toHaveLength(1);
    const second = tool.resolveTurnEnd("cnv-once", {
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
    tool.notePendingInjection(inboundEnvelope("cnv-a"));
    tool.notePendingInjection(inboundEnvelope("cnv-b"));

    // Turn for cnv-a fails: only cnv-a gets a notice, cnv-b stays pending.
    const noticesA = tool.resolveTurnEnd("cnv-a", {
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
    expect(tool.resolveTurnEnd("cnv-b")).toEqual([]);
    expect(
      tool.resolveTurnEnd("cnv-b", { code: "api_error", message: "late" }),
    ).toEqual([]);
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
      requestDirectory: async () => directory,
    });

    const result = await tool.listAgents();
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0]!.text) as {
      agents: DirectoryEntry[];
    };
    expect(parsed.agents).toEqual(directory);
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
      requestDirectory: async () => directory,
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
      expect(tool.receiveInbound(inboundEnvelope("cnv-reject-wait"))).toBe(false);
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
