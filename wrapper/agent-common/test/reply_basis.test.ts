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
  it("activates a fold ticket only after its hook and credits a used ticket without changing the live default", async () => {
    const prepared = vi.fn();
    const used = vi.fn();
    let tool!: InterAgentTool;
    tool = new InterAgentTool({
      config, getState: () => "thinking", send: () => {}, replyBasisMode: () => "v1",
      onTicketPrepared: prepared,
      onTicketUsed: (ticket, token) => {
        used(ticket, token);
        tool.creditFoldedInput(token, [inbound(2)]);
      },
      sendInterAgent: async () => ({ kind: "accepted", stamp: null }),
    });
    tool.prepareReplyInput("T", [inbound(1)]);
    tool.beginReplyInput("T");
    const folded = inbound(2);
    const fold = tool.prepareFoldInput("T", [folded])!;
    const auth = fold.authorizations[0]!;
    expect(tool.replyBasis.capture({ token: "T" }, "c", "peer", auth.in_reply_to, auth.reply_ticket)).toBe("invalid_reply_ticket");
    expect(tool.replyBasis.capture({ token: "T" }, "c", "peer")).toMatchObject({ basis: 1 });
    expect(fold.activate()).toBe(true);
    expect(prepared).toHaveBeenCalledWith(auth.reply_ticket, "T", [folded]);
    expect(tool.replyBasis.capture({ token: "T" }, "c", "peer")).toMatchObject({ basis: 1 });
    const result = await tool.invoke({
      to: "peer", conversation_id: "c", kind: "response", body: "reply",
      in_reply_to: auth.in_reply_to, reply_ticket: auth.reply_ticket,
    }, { origin: { token: "T" } });
    expect(result.isError).toBeUndefined();
    expect(used).toHaveBeenCalledWith(auth.reply_ticket, "T");
    tool.endReplyInput("T");
    tool.beginNotificationReplyInput("N");
    expect(tool.replyBasis.capture({ token: "N" }, "c", "peer")).toMatchObject({ basis: 2 });
  });
  it("retires activated fold tickets with their owning turn", () => {
    const basis = new ReplyBasis();
    basis.begin("T", [inbound(1)]);
    const ticket = basis.prepare({ token: "T" }, "c", "peer", 1)!;
    expect(ticket.activate()).toBe(true);
    expect(basis.ticketCountForTurn("T")).toBe(1);
    basis.retire("T");
    expect(basis.ticketCountForTurn("T")).toBe(0);
  });
  it("freezes captured and independent call origins without rearming on session reset", async () => {
    const origins = new ToolOrigins();
    origins.begin("T"); origins.bind("captured", "T");
    origins.beginIndependent("N"); origins.bind("independent", "N");
    const captured = await origins.resolveBound("captured");
    const independent = await origins.resolveBound("independent");
    origins.freeze();
    expect(captured?.signal?.aborted).toBe(true);
    expect(independent?.signal?.aborted).toBe(true);
    origins.bind("late", "T");
    expect(await origins.resolveBound("late")).toBeUndefined();
    origins.reset(); origins.begin("T2"); origins.bind("after-reset", "T2");
    expect(await origins.resolveBound("after-reset")).toBeUndefined();
  });
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
  it("keeps folded input out of completed snapshots until its ticket is used", () => {
    const basis = new ReplyBasis();
    basis.begin("T", [inbound(1)]);
    basis.observeFolded([inbound(2)]);
    expect(basis.capture({ token: "T" }, "c", "peer")).toMatchObject({ basis: 1 });
    basis.retire("T");
    basis.beginFromCompleted("N");
    expect(basis.capture({ token: "N" }, "c", "peer")).toMatchObject({ basis: 1 });
    basis.creditFolded([inbound(2)], "N");
    basis.retire("N");
    basis.beginFromCompleted("N2");
    expect(basis.capture({ token: "N2" }, "c", "peer")).toMatchObject({ basis: 2 });
  });
  it.each([
    ["receipt root", true],
    ["ordinary root", false],
  ] as const)("builds the next %s from credited context and its own input", (_name, receiptRoot) => {
    for (const ticketUsed of [false, true]) {
      const basis = new ReplyBasis();
      basis.begin("T", [inbound(1)]);
      basis.observeFolded([inbound(2)]);
      expect(basis.capture({ token: "T" }, "c", "peer")).toMatchObject({ basis: 1 });
      if (ticketUsed) basis.creditFolded([inbound(2)], "T");
      basis.retire("T");
      basis.beginFromCompleted("N");
      expect(basis.capture({ token: "N" }, "c", "peer")).toMatchObject({ basis: ticketUsed ? 2 : 1 });
      basis.retire("N");
      basis.begin("F", [inbound(3, "own")], undefined, receiptRoot);
      expect(basis.capture({ token: "F" }, "c", "peer")).toMatchObject({ basis: ticketUsed ? 2 : 1 });
      expect(basis.capture({ token: "F" }, "own", "peer")).toMatchObject({ basis: 3 });
    }
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

describe("missing-ticket guidance matrix", () => {
  const defaultGuidance = "Copy both fields from the original reply_authorization; an unspent, unexpired ticket can be retried.";
  const plainGuidance = "This in_reply_to matches the frozen basis for a confirmed input in this turn, and no reply authorization has been handed off for this tuple. Resend as a normal reply with both in_reply_to and reply_ticket omitted.";
  const sent = vi.fn(async () => ({ kind: "accepted" as const, stamp: null }));

  function makeGuidanceTool(frozen: number | null = 1) {
    const tool = new InterAgentTool({ config, getState: () => "thinking", send: () => {}, replyBasisMode: () => "v1", sendInterAgent: sent });
    tool.prepareReplyInput("T", frozen === null ? [] : [inbound(frozen)]);
    tool.beginReplyInput("T");
    return tool;
  }

  async function reject(tool: InterAgentTool, supplied: number, cid = "c", token = "T") {
    const result = await tool.invoke({ to: "peer", conversation_id: cid, kind: "response", body: "reply", in_reply_to: supplied }, { origin: { token } });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toMatchObject({ error: "reply_ticket_required", send_not_attempted: true });
    expect(sent).not.toHaveBeenCalled();
    return parsed as { guidance: string };
  }

  it.each([
    ["no issued ticket, P equals a positive frozen basis", 1, 1, "plain"] as const,
    ["no issued ticket, P differs from frozen basis", 1, 2, "mismatch"] as const,
    ["no issued ticket, both bases are zero", null, 0, "zero"] as const,
  ])("selects exactly one unsaturated no-issuance row: %s", async (_name, frozen, supplied, expected) => {
    const tool = makeGuidanceTool(frozen);
    const result = await reject(tool, supplied);
    if (expected === "plain") expect(result.guidance).toBe(plainGuidance);
    else if (expected === "mismatch") expect(result.guidance).toBe("No handed-off authorization for in_reply_to=2 matches this turn's frozen basis. Wait for new confirmed input or a handed-off reply_authorization matching in_reply_to=2.");
    else expect(result.guidance).toBe("No ordinary peer input is confirmed for this conversation and peer. Wait for confirmed input; do not describe this send as a reply.");
    tool.endReplyInput("T");
  });

  it("does not treat a provisional ticket as issued history or authorization", async () => {
    const tool = makeGuidanceTool(1);
    const provisional = tool.replyBasis.prepare({ token: "T" }, "c", "peer", 2)!;
    expect((await reject(tool, 2)).guidance).toBe("No handed-off authorization for in_reply_to=2 matches this turn's frozen basis. Wait for new confirmed input or a handed-off reply_authorization matching in_reply_to=2.");
    provisional.discard();
    expect((await reject(tool, 1)).guidance).toBe(plainGuidance);
    tool.endReplyInput("T");
  });

  it.each([
    ["another CID", "other-cid", "peer", "T"],
    ["another peer", "c", "other-peer", "T"],
    ["another turn", "c", "peer", "other-turn"],
  ] as const)("ignores issued tickets for %s", async (_name, cid, peer, token) => {
    const tool = makeGuidanceTool(1);
    if (token === "other-turn") tool.replyBasis.begin(token, [inbound(1)]);
    const ticket = tool.replyBasis.prepare({ token }, cid, peer, 1)!;
    expect(ticket.activate()).toBe(true);
    tool.replyBasis.forget(cid);
    expect((await reject(tool, 1)).guidance).toBe(plainGuidance);
    tool.endReplyInput("T");
    if (token === "other-turn") tool.endReplyInput(token);
  });

  it("does not record an authorization when activation fails", async () => {
    const tool = makeGuidanceTool(1);
    const provisional = tool.replyBasis.prepare({ token: "T" }, "c", "peer", 1)!;
    tool.replyBasis.forget("c");
    expect(provisional.activate()).toBe(false);
    expect((await reject(tool, 1)).guidance).toBe(plainGuidance);
    tool.endReplyInput("T");
  });

  it("keeps legacy guidance for other malformed authorization shapes", async () => {
    const tool = makeGuidanceTool(1);
    const ticketOnly = await tool.invoke({ to: "peer", conversation_id: "c", kind: "response", body: "reply", reply_ticket: "stray" }, { origin: { token: "T" } });
    expect(JSON.parse(ticketOnly.content[0]!.text)).toEqual({ error: "reply_ticket_required", send_not_attempted: true, guidance: defaultGuidance });
    const invalid = await tool.invoke({ to: "peer", conversation_id: "c", kind: "response", body: "reply", in_reply_to: 1, reply_ticket: "stray" }, { origin: { token: "T" } });
    expect(JSON.parse(invalid.content[0]!.text)).toEqual({ error: "invalid_reply_ticket", send_not_attempted: true, guidance: defaultGuidance });
    expect(sent).not.toHaveBeenCalled();
    tool.endReplyInput("T");
  });

  it.each([
    ["matching usable ticket even when it differs from frozen basis", 1, 2, 2, defaultGuidance] as const,
    ["different usable ticket when supplied basis equals frozen basis", 1, 2, 1, "A usable reply_authorization exists for a different in_reply_to. Do not use it or omit both fields. Wait for a new confirmed input or a handed-off reply_authorization matching in_reply_to=1."] as const,
    ["different usable ticket when supplied basis differs from both", 1, 2, 3, "A usable reply_authorization exists for a different in_reply_to. Do not use it or omit both fields. Wait for a new confirmed input or a handed-off reply_authorization matching in_reply_to=3."] as const,
  ])("classifies usable-ticket basis relations: %s", async (_name, frozen, ticketBasis, supplied, expected) => {
    const tool = makeGuidanceTool(frozen);
    const ticket = tool.replyBasis.prepare({ token: "T" }, "c", "peer", ticketBasis)!;
    expect(ticket.activate()).toBe(true);
    expect((await reject(tool, supplied)).guidance).toBe(expected);
    tool.endReplyInput("T");
  });

  it.each(["spent", "expired", "superseded", "forgotten"] as const)("requires fresh authorization after issued ticket becomes %s", async status => {
    const tool = makeGuidanceTool(1);
    const old = tool.replyBasis.prepare({ token: "T" }, "c", "peer", 2)!;
    expect(old.activate()).toBe(true);
    if (status === "spent") {
      expect(tool.replyBasis.capture({ token: "T" }, "c", "peer", 2, old.authorization.reply_ticket)).toMatchObject({ basis: 2 });
    } else if (status === "expired") {
      const clock = vi.spyOn(performance, "now").mockReturnValue(Number.MAX_SAFE_INTEGER);
      try {
        expect((await reject(tool, 2)).guidance).toBe("No unused, unexpired authorization remains for in_reply_to=2. Wait for a fresh reply_authorization for this basis or a new confirmed input.");
        expect((await reject(tool, 1)).guidance).toBe("No unused, unexpired authorization remains for in_reply_to=1. Wait for a fresh reply_authorization for this basis or a new confirmed input.");
        expect((await reject(tool, 3)).guidance).toBe("No unused, unexpired authorization remains for in_reply_to=3. Wait for a fresh reply_authorization for this basis or a new confirmed input.");
      }
      finally { clock.mockRestore(); }
      tool.endReplyInput("T");
      return;
    } else if (status === "superseded") {
      const newer = tool.replyBasis.prepare({ token: "T" }, "c", "peer", 3)!;
      expect(newer.activate()).toBe(true);
      expect(tool.replyBasis.capture({ token: "T" }, "c", "peer", 3, newer.authorization.reply_ticket)).toMatchObject({ basis: 3 });
    } else {
      tool.replyBasis.forget("c");
    }
    expect((await reject(tool, 2)).guidance).toBe("No unused, unexpired authorization remains for in_reply_to=2. Wait for a fresh reply_authorization for this basis or a new confirmed input.");
    expect((await reject(tool, 1)).guidance).toBe("No unused, unexpired authorization remains for in_reply_to=1. Wait for a fresh reply_authorization for this basis or a new confirmed input.");
    expect((await reject(tool, 3)).guidance).toBe("No unused, unexpired authorization remains for in_reply_to=3. Wait for a fresh reply_authorization for this basis or a new confirmed input.");
    tool.endReplyInput("T");
  });

  it("does not point at a newer usable basis when the supplied basis was superseded", async () => {
    const tool = makeGuidanceTool(1);
    const old = tool.replyBasis.prepare({ token: "T" }, "c", "peer", 2)!;
    expect(old.activate()).toBe(true);
    const newer = tool.replyBasis.prepare({ token: "T" }, "c", "peer", 3)!;
    expect(newer.activate()).toBe(true);
    expect((await reject(tool, 2)).guidance).toBe("A usable reply_authorization exists for a different in_reply_to. Do not use it or omit both fields. Wait for a new confirmed input or a handed-off reply_authorization matching in_reply_to=2.");
    tool.endReplyInput("T");
  });

  it("keeps issued-history saturation conservative while a retained ticket record still wins", async () => {
    const tool = makeGuidanceTool(1);
    const envelopes = Array.from({ length: 257 }, (_, i) => inbound(1, `c${i}`));
    tool.endReplyInput("T");
    tool.prepareReplyInput("T2", envelopes);
    tool.beginReplyInput("T2");
    const origin = { token: "T2" };
    for (let i = 0; i < 256; i++) {
      const cid = `c${i}`;
      const ticket = tool.replyBasis.prepare(origin, cid, "peer", 1)!;
      expect(ticket.activate()).toBe(true);
      tool.replyBasis.forget(cid);
    }
    const retained = tool.replyBasis.prepare(origin, "c256", "peer", 1)!;
    expect(retained.activate()).toBe(true);
    expect((await reject(tool, 1, "c256", "T2")).guidance).toBe(defaultGuidance);
    expect((await reject(tool, 2, "c256", "T2")).guidance).toBe("A usable reply_authorization exists for a different in_reply_to. Do not use it or omit both fields. Wait for a new confirmed input or a handed-off reply_authorization matching in_reply_to=2.");
    expect(tool.replyBasis.capture(origin, "c256", "peer", 1, retained.authorization.reply_ticket)).toMatchObject({ basis: 1 });
    expect((await reject(tool, 1, "c256", "T2")).guidance).toBe("No unused, unexpired authorization remains for in_reply_to=1. Wait for a fresh reply_authorization for this basis or a new confirmed input.");
    tool.replyBasis.forget("c256");
    expect((await reject(tool, 1, "c256", "T2")).guidance).toBe("Reply authorization history for this turn is saturated, so the wrapper cannot determine whether this tuple was previously authorized. Wait for confirmed input or a handed-off reply_authorization matching in_reply_to=1; do not omit both fields.");
    expect((await reject(tool, 2, "c256", "T2")).guidance).toBe("Reply authorization history for this turn is saturated, so the wrapper cannot determine whether this tuple was previously authorized. Wait for confirmed input or a handed-off reply_authorization matching in_reply_to=2; do not omit both fields.");
    expect((await reject(tool, 1, "c0", "T2")).guidance).toBe("No unused, unexpired authorization remains for in_reply_to=1. Wait for a fresh reply_authorization for this basis or a new confirmed input.");
    tool.endReplyInput("T2");

    tool.prepareReplyInput("T2", [inbound(1, "c256")]);tool.beginReplyInput("T2");
    expect((await reject(tool, 1, "c256", "T2")).guidance).toBe(plainGuidance);
    const issuedBeforeReset = tool.replyBasis.prepare({ token: "T2" }, "c256", "peer", 1)!;
    expect(issuedBeforeReset.activate()).toBe(true);
    tool.replyBasis.forget("c256");
    tool.resetReplyInput();
    tool.prepareReplyInput("T2", [inbound(1, "c256")]);tool.beginReplyInput("T2");
    expect((await reject(tool, 1, "c256", "T2")).guidance).toBe(plainGuidance);
    tool.endReplyInput("T2");
  });
});

it("checks host send admission for wrapper and independent notification tokens", async () => {
  let allowed = true;
  const sink = vi.fn(async () => ({ kind: "accepted" as const, stamp: null }));
  const tool = new InterAgentTool({ config, getState: () => "thinking", send: () => {}, replyBasisMode: () => "v1",
    canSendInterAgent: () => allowed, sendInterAgent: sink });
  tool.prepareReplyInput("T", [inbound(3)]); tool.beginReplyInput("T");
  tool.beginNotificationReplyInput("N");
  const args = { to: "peer", conversation_id: "c", kind: "response" as const, body: "reply" };
  expect((await tool.invoke(args, { origin: { token: "T" } })).isError).toBeUndefined();
  expect((await tool.invoke(args, { origin: { token: "N" } })).isError).toBeUndefined();
  allowed = false;
  for (const token of ["T", "N"]) {
    const result = await tool.invoke(args, { origin: { token } });
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ error: "admission_fail_stop", send_not_attempted: true });
  }
  expect(sink).toHaveBeenCalledTimes(2);
});

it("rechecks host send admission after a call waits behind the CID lock", async () => {
  let allowed = true;
  let release!: () => void;
  let calls = 0;
  const sink = vi.fn(async () => {
    if (++calls === 1) await new Promise<void>(resolve => { release = resolve; });
    return { kind: "accepted" as const, stamp: null };
  });
  const tool = new InterAgentTool({ config, getState: () => "thinking", send: () => {}, replyBasisMode: () => "v1",
    canSendInterAgent: () => allowed, sendInterAgent: sink });
  tool.prepareReplyInput("T", [inbound(3)]); tool.beginReplyInput("T");
  const args = { to: "peer", conversation_id: "c", kind: "response" as const, body: "reply" };
  const first = tool.invoke(args, { origin: { token: "T" } });
  await vi.waitFor(() => expect(sink).toHaveBeenCalledOnce());
  const second = tool.invoke(args, { origin: { token: "T" } });
  allowed = false; release(); await first;
  const result = await second;
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0]!.text)).toMatchObject({ error: "admission_fail_stop", send_not_attempted: true });
  expect(sink).toHaveBeenCalledOnce();
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

it("a live CID obligation cannot move to a later root before its owner resolves", () => {
  const tool = new InterAgentTool({ config, getState: () => "thinking", send: () => {}, replyBasisMode: () => "v1" });
  const first = inbound(1);
  const later = inbound(2);
  expect(tool.notePendingInjection(first, "T")).toBe(true);
  expect(tool.notePendingInjection(later, "F")).toBe(false);
  expect(tool.pendingConversationIdsForTurn("T")).toEqual(["c"]);
  expect(tool.pendingConversationIdsForTurn("F")).toEqual([]);
  expect(tool.resolveTurnEnd("T", ["c"], classifyInterAgentError({ reason: "api_error" }))).toHaveLength(1);
  expect(tool.notePendingInjection(later, "F")).toBe(true);
  expect(tool.pendingConversationIdsForTurn("F")).toEqual(["c"]);
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

it.each([
  { name: "errorless status", error: undefined, rollback: false },
  { name: "errorful status", error: { code: "delivery_lost", message: "not dispatched", peer: "peer" }, rollback: false },
  { name: "errorless status rollback", error: undefined, rollback: true },
  { name: "errorful status rollback", error: { code: "delivery_lost", message: "not dispatched", peer: "peer" }, rollback: true },
])("waiter server $name returns status_notice and defers acknowledgement", async ({ error, rollback }) => {
  const ack = vi.fn(); const returned = vi.fn(); let tool!: InterAgentTool;
  const status = inbound(0);
  status.agent_id = "server";
  status.payload = { ...status.payload, kind: "inform", body: "peer status", ...(error === undefined ? {} : { error }) };
  tool = new InterAgentTool({ config, getState: () => "thinking", send: () => {}, replyBasisMode: () => "v1",
    onInputHandoff: ack, returnInput: returned,
    sendInterAgent: async () => { queueMicrotask(() => { void tool.receiveInbound(status); }); return { kind: "accepted", stamp: null }; },
  });
  tool.beginReplyInput("T");
  const result = await tool.invoke({ to: "peer", conversation_id: "c", kind: "query", body: "question", wait_for_response: true, timeout_ms: 100 }, { origin: { token: "T" } });
  const parsed = JSON.parse(result.content[0]!.text);
  expect(parsed.status_notice).toEqual(status);
  expect(parsed).not.toHaveProperty("reply");
  expect(parsed).not.toHaveProperty("reply_authorization");
  if (error === undefined) expect(parsed).not.toHaveProperty("peer_error");
  else expect(parsed.peer_error).toMatchObject({ code: "delivery_lost", message: "not dispatched", from: "peer" });
  expect(ack).not.toHaveBeenCalled();
  if (rollback) {
    discardToolResult(result);
    expect(returned).toHaveBeenCalledOnce();
    expect(ack).not.toHaveBeenCalled();
  } else {
    expect(handoffToolResult(result, () => {})).toBe(true);
    expect(ack).toHaveBeenCalledOnce();
  }
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
  const huge = inbound(3); huge.payload.body = "x".repeat(15_700);
  const tool = new InterAgentTool({ config, getState: () => "thinking", send: () => {}, replyBasisMode: () => "v1", unreadCount: () => 12,
    claimRecovery: (_cid, _peer, fit) => { expect(fit([huge])).toBe(false); expect(fit(Array.from({ length: 11 }, () => inbound(3)))).toBe(false); return { envelopes: [], oversizedPending: true, recoverySource: "handoff_queue", commit: vi.fn(), rollback: vi.fn() }; },
    sendInterAgent: async () => ({ kind: "rejected", reason: "stale_reply_basis" }) });
  tool.beginReplyInput("T");
  const result = await tool.invoke({ to: "peer", conversation_id: "c", kind: "response", body: "reply" }, { origin: { token: "T" } });
  const parsed = JSON.parse(result.content[0]!.text);
  expect(parsed).toMatchObject({ oversized_pending: true, recovery: [] });
  expect(parsed.guidance).toContain("still queued for normal handoff");
  expect(parsed.guidance).toContain("Do not resend the failed body");
  expect(parsed.guidance).toContain("wait for the item to be handed off");
  expect(parsed.guidance).toContain("If it arrives as a normal root input, send a normal reply with both in_reply_to and reply_ticket omitted");
  expect(parsed.guidance).toContain("If it arrives in a Claude fold with reply_authorization, copy both fields");
  expect(parsed.guidance).not.toContain("use its reply authorization");
  expect(parsed).not.toHaveProperty("awaiting_delivery");
  expect(parsed).not.toHaveProperty("unread_remaining");
  expect(parsed).not.toHaveProperty("more_pending");
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16384);
});

it("empty recovery is indeterminate and omits unrelated unread counts", async () => {
  const tool = new InterAgentTool({ config, getState: () => "thinking", send: () => {}, replyBasisMode: () => "v1", unreadCount: () => 12,
    sendInterAgent: async () => ({ kind: "rejected", reason: "stale_reply_basis" }) });
  tool.beginReplyInput("T");
  const result = await tool.invoke({ to: "peer", conversation_id: "c", kind: "response", body: "reply" }, { origin: { token: "T" } });
  const parsed = JSON.parse(result.content[0]!.text);
  expect(parsed).toMatchObject({ recovery: [] });
  expect(parsed.guidance).toContain("does not prove delivery was lost");
  expect(parsed.guidance).toContain("Do not retry this failed send with its stale basis on this conversation");
  expect(parsed.guidance).not.toContain("Do not retry on this conversation");
  expect(parsed.guidance).toContain("when it arrives as a normal root input, reply in this conversation with both in_reply_to and reply_ticket omitted");
  expect(parsed.guidance).toContain("if it arrives in a Claude fold with reply_authorization, copy both fields");
  expect(parsed.guidance).toContain("omit conversation_id");
  expect(parsed).not.toHaveProperty("awaiting_delivery");
  expect(parsed).not.toHaveProperty("unread_remaining");
  expect(parsed).not.toHaveProperty("more_pending");
});

it("accepts a later matching peer turn through ordinary inbound handling after empty recovery", async () => {
  const tool = new InterAgentTool({ config, getState: () => "thinking", send: () => {}, replyBasisMode: () => "v1",
    sendInterAgent: async () => ({ kind: "rejected", reason: "stale_reply_basis" }) });
  tool.beginReplyInput("T");
  const failed = await tool.invoke({ to: "peer", conversation_id: "c", kind: "response", body: "reply" }, { origin: { token: "T" } });
  expect(JSON.parse(failed.content[0]!.text)).toMatchObject({ recovery: [] });
  const later = inbound(3);
  expect(await tool.receiveInbound(later)).toMatchObject({ consumed: false, inject: true });
  expect(tool.notePendingInjection(later, "later-confirmed-turn")).toBe(true);
});

it("oversized retained folds get conservative guidance even when the matching record exists", async () => {
  const tool = new InterAgentTool({ config, getState: () => "thinking", send: () => {}, replyBasisMode: () => "v1",
    claimRecovery: () => ({ envelopes: [], oversizedPending: true, foldedEarlier: true, recoverySource: "retained_fold", commit: vi.fn(), rollback: vi.fn() }),
    sendInterAgent: async () => ({ kind: "rejected", reason: "stale_reply_basis" }) });
  tool.beginReplyInput("T");
  const result = await tool.invoke({ to: "peer", conversation_id: "c", kind: "response", body: "reply" }, { origin: { token: "T" } });
  const parsed = JSON.parse(result.content[0]!.text);
  expect(parsed).toMatchObject({ oversized_pending: true, recovery: [] });
  expect(parsed.guidance).toContain("may belong to an earlier SDK turn");
  expect(parsed.guidance).toContain("do not assume its body is visible");
  expect(parsed.guidance).toContain("Do not retry this failed send with its stale basis on this conversation");
  expect(parsed.guidance).toContain("if it arrives as a normal root input, reply in this conversation with both in_reply_to and reply_ticket omitted");
  expect(parsed.guidance).toContain("if it arrives in a Claude fold with reply_authorization, copy both fields");
});

it("an oversized result without a known source falls back to generic empty-recovery guidance", async () => {
  const tool = new InterAgentTool({ config, getState: () => "thinking", send: () => {}, replyBasisMode: () => "v1",
    claimRecovery: () => ({ envelopes: [], oversizedPending: true, commit: vi.fn(), rollback: vi.fn() }),
    sendInterAgent: async () => ({ kind: "rejected", reason: "stale_reply_basis" }) });
  tool.beginReplyInput("T");
  const result = await tool.invoke({ to: "peer", conversation_id: "c", kind: "response", body: "reply" }, { origin: { token: "T" } });
  const parsed = JSON.parse(result.content[0]!.text);
  expect(parsed).toMatchObject({ oversized_pending: true, recovery: [] });
  expect(parsed.guidance).toContain("does not prove delivery was lost");
  expect(parsed.guidance).not.toContain("still queued for normal handoff");
  expect(parsed.guidance).not.toContain("folded input was retained");
});

it("a non-empty recovery keeps its handoff authorization and aggregate shape", async () => {
  const recovered = inbound(3);
  const tool = new InterAgentTool({ config, getState: () => "thinking", send: () => {}, replyBasisMode: () => "v1", unreadCount: () => 5,
    claimRecovery: () => ({ envelopes: [recovered], commit: vi.fn(), rollback: vi.fn() }),
    sendInterAgent: async () => ({ kind: "rejected", reason: "stale_reply_basis" }) });
  tool.beginReplyInput("T");
  const result = await tool.invoke({ to: "peer", conversation_id: "c", kind: "response", body: "reply" }, { origin: { token: "T" } });
  const parsed = JSON.parse(result.content[0]!.text);
  expect(parsed).toMatchObject({ recovery: [recovered], unread_remaining: 4, more_pending: true, reply_authorization: { in_reply_to: 3 } });
  expect(parsed).not.toHaveProperty("guidance");
  expect(parsed).not.toHaveProperty("awaiting_delivery");
  expect(handoffToolResult(result, () => {})).toBe(true);
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
