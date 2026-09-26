import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { ReplyBasis, handoffToolResult, discardToolResult } from "../src/reply_basis.js";
import { ToolOrigins } from "../src/tool_origins.js";
import { InterAgentTool, classifyInterAgentError } from "../src/inter_agent.js";
import type { Envelope } from "../src/types.js";

const config = { agent_id: "self", persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P", server_url: "ws://localhost" };
function inbound(n: number, cid = "c"): Envelope {
  return { version: "0", agent_id: "peer", persona: config.persona, display_name: "P", ts: "2026-09-26T00:00:00Z", type: "inter_agent_message", state: "thinking", payload: { to: "self", conversation_id: cid, turn_number: n, kind: "response", body: `input ${n}`, meta: { done: false, propose_next: "" }, owner: { kind: "user", id: "operator" }, new_conversation: false }, ext: {} };
}

describe("input-bound reply tickets", () => {
  it("carries confirmed notification handoffs forward without borrowing queued input", () => {
    const basis = new ReplyBasis();
    basis.begin("T", [inbound(1)]); basis.retire("T");
    basis.beginFromCompleted("N");
    expect(basis.capture({ token: "N" }, "c", "peer")).toMatchObject({ basis: 1 });
    const oldTicket = basis.prepare({ token: "N" }, "c", "peer", 3)!;
    oldTicket.activate();
    basis.observe([inbound(3)], "N");
    expect(basis.capture({ token: "N" }, "c", "peer")).toMatchObject({ basis: 1 });
    basis.retire("N");
    basis.begin("queued", [inbound(5)], undefined, true);
    basis.beginFromCompleted("N2");
    expect(basis.capture({ token: "N2" }, "c", "peer")).toMatchObject({ basis: 3 });
    expect(basis.capture({ token: "N2" }, "c", "peer", 3, oldTicket.authorization.reply_ticket)).toBe("invalid_reply_ticket");
    basis.retire("queued");
    basis.retire("N2");
    basis.beginFromCompleted("N3");
    expect(basis.capture({ token: "N3" }, "c", "peer")).toMatchObject({ basis: 3 });
  });
  it("merges by CID and peer monotonically, and reset excludes retired handoffs", () => {
    const basis = new ReplyBasis();
    basis.begin("T", [inbound(3), inbound(2, "other")]); basis.retire("T");
    basis.beginFromCompleted("N");
    basis.observe([inbound(1), inbound(4, "other")], "N");
    basis.retire("N");
    basis.beginFromCompleted("N2");
    expect(basis.capture({ token: "N2" }, "c", "peer")).toMatchObject({ basis: 3 });
    expect(basis.capture({ token: "N2" }, "other", "peer")).toMatchObject({ basis: 4 });
    basis.reset();
    basis.observe([inbound(9)], "N2");
    basis.beginFromCompleted("fresh");
    expect(basis.capture({ token: "fresh" }, "c", "peer")).toMatchObject({ basis: 0 });
    expect(basis.capture({ token: "fresh" }, "other", "peer")).toMatchObject({ basis: 0 });
  });
  it("keeps unconfirmed wrapper input out of later notification snapshots", () => {
    const basis = new ReplyBasis();
    basis.begin("T", [inbound(5)], undefined, true);
    expect(basis.capture({ token: "T" }, "c", "peer")).toMatchObject({ basis: 5 });
    basis.retire("T");
    basis.beginFromCompleted("N");
    expect(basis.capture({ token: "N" }, "c", "peer")).toMatchObject({ basis: 0 });
  });
  it("freezes coalesced defaults and authorizes only after handoff, once, in the bound CID", () => {
    const basis = new ReplyBasis(); const origin = { token: "T" };
    basis.begin("T", [inbound(1), inbound(3)]);
    expect(basis.capture(origin, "c", "peer")).toMatchObject({ basis: 3 });
    basis.observe([inbound(5)]);
    expect(basis.capture(origin, "c", "peer")).toMatchObject({ basis: 3 });
    const receipt = basis.prepare(origin, "c", "peer", 5)!;
    expect(receipt.authorization.reply_ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(basis.capture(origin, "c", "peer", 5)).toBe("reply_ticket_required");
    expect(basis.capture(origin, "c", "peer", 5, receipt.authorization.reply_ticket)).toBe("invalid_reply_ticket");
    expect(receipt.activate()).toBe(true);
    expect(basis.capture(origin, "other", "peer", 5, receipt.authorization.reply_ticket)).toBe("invalid_reply_ticket");
    expect(basis.capture(origin, "c", "peer", 5, "typo")).toBe("invalid_reply_ticket");
    expect(basis.capture(origin, "c", "peer", 5, receipt.authorization.reply_ticket)).toMatchObject({ basis: 5 });
    expect(basis.capture(origin, "c", "peer", 5, receipt.authorization.reply_ticket)).toBe("spent_reply_ticket");
    basis.retire("T"); basis.begin("T2", []);
    expect(basis.capture(origin, "c", "peer")).toBe("stale_tool_call");
    expect(basis.capture({ token: "T2" }, "c", "peer")).toMatchObject({ basis: 5 });
  });
  it("expires by the handoff clock and prevents old renewal superseding newer input", () => {
    let now = 0; const basis = new ReplyBasis(() => now); const origin = { token: "T" };
    basis.begin("T", []);
    const old = basis.prepare(origin, "c", "peer", 1)!; now = 50; old.activate();
    now = 300050;
    expect(basis.capture(origin, "c", "peer", 1, old.authorization.reply_ticket)).toBe("expired_reply_ticket");
    const newer = basis.prepare(origin, "c", "peer", 3)!; newer.activate();
    expect(basis.prepare(origin, "c", "peer", 1, true)).toBeUndefined();
  });
  it("default construction starts with unknown input; cancel retires actual captured origins", async () => {
    const origins = new ToolOrigins(); origins.begin("T");
    const pending = origins.resolve("tool-B"); origins.observe("tool-B");
    const captured = await pending; expect(captured?.token).toBe("T");
    origins.begin("T2");
    expect((await origins.resolve("tool-B"))?.signal?.aborted).toBe(true);
    const basis = new ReplyBasis(); basis.begin("T2", []);
    expect(basis.capture(undefined, "c", "peer")).toBe("unbound_tool_call");
    expect(basis.capture(captured, "c", "peer")).toBe("stale_tool_call");
    expect(basis.capture({ token: "T2" }, "c", "peer")).toMatchObject({ basis: 0 });
  });
  it("binds a notification call only to its prompt owner and retires it independently", async () => {
    const origins = new ToolOrigins();
    origins.begin("wrapper");
    origins.beginIndependent("notification");
    const pending = origins.resolveBound("call");
    origins.bind("call", "notification");
    expect((await pending)?.token).toBe("notification");
    origins.bind("call", "wrapper");
    expect((await origins.resolveBound("call"))?.signal?.aborted).toBe(true);
    const neverBound = origins.resolveBound("child-call");
    origins.retireIndependent("notification");
    expect(await neverBound).toBeUndefined();
  });
});

describe("actual shared send path", () => {
  it("rejects an unbound call with actionable guidance and no transport send", async () => {
    const sendInterAgent = vi.fn(async () => ({ kind: "accepted" as const, stamp: null }));
    const tool = new InterAgentTool({ config, getState: () => "thinking", send: () => {}, replyBasisMode: () => "v1", sendInterAgent });
    const result = await tool.invoke({ to: "peer", conversation_id: "c", kind: "response", body: "reply" });
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      error: "unbound_tool_call",
      send_not_attempted: true,
      guidance: "This tool call is not bound to a confirmed live input. No message was sent. Wait for a new confirmed input before sending again. Retrying in this continuation, changing conversation_id, or adding a reply ticket cannot bind this call.",
    });
    expect(sendInterAgent).not.toHaveBeenCalled();
  });
  it("rejects a retired call with distinct guidance and no transport send", async () => {
    const sendInterAgent = vi.fn(async () => ({ kind: "accepted" as const, stamp: null }));
    const tool = new InterAgentTool({ config, getState: () => "thinking", send: () => {}, replyBasisMode: () => "v1", sendInterAgent });
    tool.beginReplyInput("T"); tool.endReplyInput("T");
    const result = await tool.invoke({ to: "peer", conversation_id: "c", kind: "response", body: "reply" }, { origin: { token: "T" } });
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      error: "stale_tool_call",
      send_not_attempted: true,
      guidance: "The input that owned this tool call has ended or been cancelled. No message was sent. Do not retry this call; send from a new live wrapper-delivered input.",
    });
    expect(sendInterAgent).not.toHaveBeenCalled();
  });
  it("stale rejection hands off a body once; B before receipt fails, C and a fresh transient retry succeed", async () => {
    const envelopes: Envelope[] = []; let reject = "stale_reply_basis";
    const commit = vi.fn(); const rollback = vi.fn(); const ack = vi.fn();
    const tool = new InterAgentTool({ config, getState: () => "thinking", send: () => {}, replyBasisMode: () => "v1",
      onInputHandoff: ack,
      claimRecovery: () => ({ envelopes: [inbound(3)], commit, rollback }),
      sendInterAgent: async e => { envelopes.push(e); return reject ? { kind: "rejected", reason: reject } : { kind: "accepted", stamp: null }; },
    });
    tool.prepareReplyInput("T", [inbound(1)]); tool.beginReplyInput("T");
    const context = { origin: { token: "T" } };
    const args = { to: "peer", conversation_id: "c", kind: "response" as const, body: "reply" };
    const a = await tool.invoke(args, context);
    const auth = JSON.parse(a.content[0]!.text).reply_authorization;
    const b = await tool.invoke({ ...args, in_reply_to: 3 }, context);
    expect(JSON.parse(b.content[0]!.text).send_not_attempted).toBe(true);
    expect(envelopes).toHaveLength(1); expect(ack).not.toHaveBeenCalled();
    expect(handoffToolResult(a, () => {})).toBe(true); expect(commit).toHaveBeenCalledOnce(); expect(ack).toHaveBeenCalledOnce();
    reject = "delivery_backlog";
    const c = await tool.invoke({ ...args, ...auth }, context);
    expect(envelopes[1]!.payload.in_reply_to).toBe(3);
    const renewed = JSON.parse(c.content[0]!.text).reply_authorization;
    expect(renewed.reply_ticket).not.toBe(auth.reply_ticket);
    handoffToolResult(c, () => {});
    reject = "";
    const d = await tool.invoke({ ...args, ...renewed }, context);
    expect(d.isError).toBeUndefined(); expect(envelopes).toHaveLength(3);
    const replay = await tool.invoke({ ...args, ...renewed }, context);
    expect(JSON.parse(replay.content[0]!.text).error).toBe("spent_reply_ticket"); expect(envelopes).toHaveLength(3);
    expect(rollback).not.toHaveBeenCalled();
  });
  it("a broken result adapter restores ownership without making its ticket usable", async () => {
    const rollback = vi.fn(); const ack = vi.fn();
    const tool = new InterAgentTool({ config, getState: () => "thinking", send: () => {}, replyBasisMode: () => "v1", onInputHandoff: ack,
      claimRecovery: () => ({ envelopes: [inbound(3)], commit: vi.fn(), rollback }),
      sendInterAgent: async () => ({ kind: "rejected", reason: "stale_reply_basis" }),
    });
    tool.beginReplyInput("T");
    const args = { to: "peer", conversation_id: "c", kind: "response" as const, body: "reply" }; const context = { origin: { token: "T" } };
    const result = await tool.invoke(args, context); const auth = JSON.parse(result.content[0]!.text).reply_authorization;
    discardToolResult(result); expect(rollback).toHaveBeenCalledOnce(); expect(ack).not.toHaveBeenCalled();
    const retry = await tool.invoke({ ...args, ...auth }, context);
    expect(JSON.parse(retry.content[0]!.text).error).toBe("invalid_reply_ticket");
  });
});

it("wrapper notice producers match protocol-owned canonical fixtures", () => {
  const fixtures = JSON.parse(readFileSync(new URL("../../../protocol/fixtures/inter-agent-internal-notices.json", import.meta.url), "utf8")) as Array<{ code: string; message: string; notice_type: string; reset_delay_seconds?: number }>;
  for (const fixture of fixtures) {
    if (fixture.notice_type === "stale_delivery") continue;
    const error = classifyInterAgentError({ reason: fixture.code === "rate_limit" ? "blocking_limit" : fixture.code === "context_overflow" ? "prompt_too_long" : fixture.code, ...(fixture.reset_delay_seconds === undefined ? {} : { rateLimitResetSeconds: fixture.reset_delay_seconds }) });
    expect(error).toEqual({ code: fixture.code, message: fixture.message, ...(fixture.reset_delay_seconds === undefined ? {} : { reset_delay_seconds: fixture.reset_delay_seconds }) });
    const tool = new InterAgentTool({ config, getState: () => "thinking", send: () => {}, replyBasisMode: () => "v1" });
    tool.notePendingInjection(inbound(1), "T");
    const [notice] = tool.resolveTurnEnd("T", ["c"], error);
    expect(notice!.payload).toMatchObject({ notice_type: fixture.notice_type, body: `peer error (${fixture.code}): ${fixture.message}`, error });
  }
});

it("a notification settles only recovery CIDs handed to its own token", () => {
  const tool = new InterAgentTool({ config, getState: () => "thinking", send: () => {}, replyBasisMode: () => "v1" });
  const notification = inbound(3, "notification-cid");
  const wrapper = inbound(2, "wrapper-cid");
  tool.beginNotificationReplyInput("N");
  tool.notePendingInjection(notification, "N");
  tool.notePendingInjection(wrapper, "W");
  expect(tool.pendingConversationIdsForTurn("N")).toEqual(["notification-cid"]);
  const notices = tool.resolveTurnEnd("N", tool.pendingConversationIdsForTurn("N"), classifyInterAgentError({ reason: "api_error" }));
  expect(notices).toHaveLength(1);
  expect((notices[0]!.payload as { conversation_id: string }).conversation_id).toBe("notification-cid");
  expect(tool.pendingConversationIdsForTurn("W")).toEqual(["wrapper-cid"]);
  tool.endReplyInput("N");
});

it("a queued call cannot borrow the next turn after waiting for the CID lock", async () => {
  let release!: () => void;
  const sink = vi.fn(async () => { await new Promise<void>(r => { release = r; }); return { kind: "accepted" as const, stamp: null }; });
  const tool = new InterAgentTool({ config, getState: () => "thinking", send: () => {}, sendInterAgent: sink, replyBasisMode: () => "v1" });
  tool.prepareReplyInput("T", [inbound(1)]); tool.beginReplyInput("T");
  const args = { to: "peer", conversation_id: "c", kind: "response" as const, body: "held" };
  const a = tool.invoke(args, { origin: { token: "T" } });
  await vi.waitFor(() => expect(sink).toHaveBeenCalledOnce());
  const b = tool.invoke(args, { origin: { token: "T" } });
  tool.endReplyInput("T"); tool.prepareReplyInput("T2", [inbound(3)]); tool.beginReplyInput("T2"); release(); await a;
  expect(JSON.parse((await b).content[0]!.text)).toMatchObject({ error: "stale_tool_call", send_not_attempted: true });
  expect(sink).toHaveBeenCalledOnce();
});

it.each(["peer_reconnecting_capacity", "delivery_backlog", "reply_basis_connection_changed", "unknown"])("waiter input can retry only a definite transient rejection: %s", async reason => {
  let count = 0;
  let tool!: InterAgentTool;
  tool = new InterAgentTool({ config, getState: () => "thinking", send: () => {}, replyBasisMode: () => "v1",
    sendInterAgent: async () => {
      if (++count === 1) { queueMicrotask(() => { void tool.receiveInbound(inbound(3)); }); return { kind: "accepted", stamp: null }; }
      if (count === 2) return reason === "unknown" ? { kind: "unknown", reason: "ack_timeout" } : { kind: "rejected", reason, ...(reason === "reply_basis_connection_changed" ? { send_not_attempted: true as const } : {}) };
      return { kind: "accepted", stamp: null };
    },
  });
  tool.beginReplyInput("T");
  const context = { origin: { token: "T" } };
  const args = { to: "peer", conversation_id: "c", kind: "response" as const, body: "reply" };
  const first = await tool.invoke({ ...args, wait_for_response: true, timeout_ms: 100 }, context);
  handoffToolResult(first, () => {});
  const authorization = JSON.parse(first.content[0]!.text).reply_authorization;
  const rejected = await tool.invoke({ ...args, ...authorization }, context);
  if (reason === "unknown") { expect(JSON.stringify(rejected)).not.toContain("reply_authorization"); expect(count).toBe(2); return; }
  expect(JSON.parse(rejected.content[0]!.text).send_not_attempted).toBe(reason === "reply_basis_connection_changed");
  const next = JSON.parse(rejected.content[0]!.text).reply_authorization;
  expect(next.reply_ticket).not.toBe(authorization.reply_ticket); handoffToolResult(rejected, () => {});
  expect((await tool.invoke({ ...args, ...next }, context)).isError).toBeUndefined(); expect(count).toBe(3);
});

it.each([undefined, "turn_failure"])("waiter peer errors acknowledge at handoff and authorize only ordinary legacy input (%s)", async notice => {
  const ack = vi.fn(); let tool!: InterAgentTool;
  const error = { ...inbound(3), payload: { ...inbound(3).payload, kind: "inform", body: "failed", error: { code: "api_error", message: "failed" }, ...(notice ? { notice_type: notice } : {}) } } as Envelope;
  tool = new InterAgentTool({ config, getState: () => "thinking", send: () => {}, replyBasisMode: () => "v1", onInputHandoff: ack,
    sendInterAgent: async () => { queueMicrotask(() => { void tool.receiveInbound(error); }); return { kind: "accepted", stamp: null }; },
  });
  tool.beginReplyInput("T");
  const result = await tool.invoke({ to: "peer", conversation_id: "c", kind: "query", body: "question", wait_for_response: true, timeout_ms: 100 }, { origin: { token: "T" } });
  const parsed = JSON.parse(result.content[0]!.text);
  expect(parsed.peer_error.code).toBe("api_error"); expect(Boolean(parsed.reply_authorization)).toBe(notice === undefined);
  expect(ack).not.toHaveBeenCalled(); handoffToolResult(result, () => {}); expect(ack).toHaveBeenCalledOnce();
});

it("a retired turn restores a pending recovery even if its adapter has not returned", async () => {
  const rollback = vi.fn(), ack = vi.fn();
  const tool = new InterAgentTool({ config, getState: () => "thinking", send: () => {}, replyBasisMode: () => "v1", onInputHandoff: ack,
    claimRecovery: () => ({ envelopes: [inbound(3)], commit: vi.fn(), rollback }), sendInterAgent: async () => ({ kind: "rejected", reason: "stale_reply_basis" }) });
  tool.beginReplyInput("T");
  const result = await tool.invoke({ to: "peer", conversation_id: "c", kind: "response", body: "reply" }, { origin: { token: "T" } });
  tool.endReplyInput("T"); expect(rollback).toHaveBeenCalledOnce();
  expect(handoffToolResult(result, () => { throw Error("must not write"); })).toBe(false); expect(ack).not.toHaveBeenCalled(); expect(rollback).toHaveBeenCalledOnce();
});

it("oversized recovery stays queued and recovery budgets include the actual result and advice", async () => {
  const huge = inbound(3); huge.payload.body = "あ".repeat(10000);
  const tool = new InterAgentTool({ config, getState: () => "thinking", send: () => {}, replyBasisMode: () => "v1", unreadCount: () => 12,
    claimRecovery: (_cid, _peer, fit) => { expect(fit([huge])).toBe(false); expect(fit(Array.from({ length: 11 }, () => inbound(3)))).toBe(false); return { envelopes: [], oversizedPending: true, commit: vi.fn(), rollback: vi.fn() }; },
    sendInterAgent: async () => ({ kind: "rejected", reason: "stale_reply_basis" }) });
  tool.beginReplyInput("T");
  const result = await tool.invoke({ to: "peer", conversation_id: "c", kind: "response", body: "reply" }, { origin: { token: "T" } });
  expect(JSON.parse(result.content[0]!.text)).toMatchObject({ oversized_pending: true, recovery: [], unread_remaining: 12, more_pending: true });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16384);
});

it("native ID admission waits within one turn, rejects reuse, and bounds pending and remembered IDs", async () => {
  const origins = new ToolOrigins(); origins.begin("T");
  const waiting = origins.resolve("early-permission"); origins.observe("early-permission");
  expect((await waiting)?.token).toBe("T");
  const pending = Array.from({ length: 64 }, () => origins.resolve("not-yet-observed"));
  expect(await origins.resolve("overflow")).toBeUndefined(); origins.retire();
  expect(await Promise.all(pending)).toEqual(Array(64).fill(undefined));
  origins.begin("T2"); origins.observe("early-permission");
  expect((await origins.resolve("early-permission"))?.signal?.aborted).toBe(true);
  for (let i = 0; i < 8192; i++) origins.observe(`id-${i}`);
  expect(await origins.resolve("id-0")).toBeUndefined();
  origins.reset(); origins.begin("fresh-session"); origins.observe("id-0");
  expect((await origins.resolve("id-0"))?.token).toBe("fresh-session");
});
