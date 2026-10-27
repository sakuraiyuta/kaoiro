import "../../../scripts/test/fixtures/test-isolation.mjs";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  ReplyBasis, FOLLOWUP_AUTHORIZATION_GUIDANCE, bindToolResultHandoff,
  appendToolResultHandoff, handoffToolResult, discardToolResult,
  type ReplyAuthorization, type ReplyAttempt,
} from "../src/reply_basis.js";
import { InterAgentTool, type InterAgentToolOptions } from "../src/inter_agent.js";
import type { Envelope } from "../src/types.js";
import type { ToolResult } from "../src/tooling.js";

const config = { agent_id: "self", persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P", server_url: "ws://localhost" };
const args = { to: "peer", conversation_id: "c", kind: "response" as const, body: "reply" };
const context = { origin: { token: "T" } };
const accepted = { kind: "accepted" as const, stamp: null };
const stale = { kind: "rejected" as const, reason: "stale_reply_basis", details: { expected_peer_turn: 4 } };

function inbound(n: number, cid = "c", peer = "peer"): Envelope {
  return { version: "0", agent_id: peer, persona: config.persona, display_name: "P", ts: "2026-10-18T00:00:00Z",
    type: "inter_agent_message", state: "thinking", payload: { to: "self", conversation_id: cid,
      turn_number: n, kind: "response", body: `input ${n}`, meta: { done: false, propose_next: "" } }, ext: {} };
}
function makeTool(options: Partial<InterAgentToolOptions> = {}): InterAgentTool {
  const tool = new InterAgentTool({ config, getState: () => "thinking", send: () => {},
    replyBasisMode: () => "v1", sendInterAgent: async () => accepted, ...options });
  tool.prepareReplyInput("T", [inbound(1)]); tool.beginReplyInput("T");
  return tool;
}
function authorize(tool: InterAgentTool, n = 4, token = "T", cid = "c", peer = "peer"): ReplyAuthorization {
  const ticket = tool.replyBasis.prepare({ token }, cid, peer, n)!;
  expect(ticket.activate()).toBe(true);
  return ticket.authorization;
}
function parts(result: ToolResult): Record<string, any>[] {
  return result.content.flatMap(part => { try { return [JSON.parse(part.text)]; } catch { return []; } });
}
function followup(result: ToolResult): ReplyAuthorization {
  const metadata = parts(result).filter(part => part.reply_authorization_source === "accepted_reply");
  expect(metadata).toHaveLength(1);
  expect(metadata[0]!.reply_authorization_guidance).toBe(FOLLOWUP_AUTHORIZATION_GUIDANCE);
  return metadata[0]!.reply_authorization;
}
function noFollowup(result: ToolResult): void {
  expect(parts(result).some(part => part.reply_authorization_source === "accepted_reply")).toBe(false);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe("accepted-reply follow-up authorization", () => {
  it("keeps the handed-off usage guidance in the current contract and tool description", () => {
    const reference = readFileSync(new URL("../../../docs/reference/inter-agent/reply-basis.md", import.meta.url), "utf8");
    expect(reference).toContain(FOLLOWUP_AUTHORIZATION_GUIDANCE);
    expect(makeTool().descriptors().find(descriptor => descriptor.name === "send_to_agent")!.description)
      .toContain("An accepted ticket-authorized reply may return a fresh `reply_authorization`");
  });
  it("recovers, replies, and sends a distinct follow-up without changing the root default", async () => {
    const recovered = inbound(4);
    const claim = { envelopes: [recovered], commit: vi.fn(), rollback: vi.fn() };
    const handed = vi.fn(), prepared = vi.fn();
    const wire: Envelope[] = [];
    const tool = makeTool({ onInputHandoff: handed, onTicketPrepared: prepared,
      claimRecovery: () => wire.length === 1 ? claim : undefined,
      sendInterAgent: async envelope => { wire.push(envelope); return [1, 3].includes(wire.length) ? stale : accepted; } });
    const recovery = await tool.invoke(args, context);
    const original = parts(recovery)[0]!.reply_authorization;
    expect(handoffToolResult(recovery, () => {})).toBe(true);
    expect(claim.commit).toHaveBeenCalledOnce();
    const reply = await tool.invoke({ ...args, ...original }, context);
    const next = followup(reply);
    expect(next.in_reply_to).toBe(4);
    expect(next.reply_ticket).not.toBe(original.reply_ticket);
    expect(tool.replyBasis.capture(context.origin, "c", "peer", 4, next.reply_ticket)).toBe("invalid_reply_ticket");
    expect(handoffToolResult(reply, () => {})).toBe(true);
    expect(tool.replyBasis.capture(context.origin, "c", "peer")).toMatchObject({ basis: 1 });
    const omitted = await tool.invoke({ ...args, body: "follow-up" }, context);
    expect(parts(omitted)[0]!.guidance).toContain("already handed off in this SDK turn");
    expect(parts(omitted)[0]!.guidance).toContain("copy in_reply_to and reply_ticket");
    expect(parts(omitted)[0]!).not.toHaveProperty("reply_authorization");
    expect(parts(omitted)[0]!).not.toHaveProperty("unread_remaining");
    const sent = await tool.invoke({ ...args, body: "follow-up", ...next }, context);
    expect(sent.isError).toBeUndefined();
    expect(wire.map(envelope => envelope.payload.in_reply_to)).toEqual([1, 4, 1, 4]);
    expect(wire.map(envelope => envelope.payload.body)).toEqual(["reply", "reply", "follow-up", "follow-up"]);
    const third = followup(sent);
    expect(third.reply_ticket).not.toBe(next.reply_ticket);
    expect(handoffToolResult(sent, () => {})).toBe(true);
    expect((await tool.invoke({ ...args, ...next }, context)).isError).toBe(true);
    expect(wire).toHaveLength(4);
    expect(handed).toHaveBeenCalledOnce(); expect(prepared).toHaveBeenCalledOnce();
  });

  it("keeps an omitted call queued behind the accepted reply on its captured old basis", async () => {
    const gate = deferred<typeof accepted>(); const entered = deferred<void>();
    const wire: number[] = [];
    const tool = makeTool({ sendInterAgent: async envelope => {
      wire.push(envelope.payload.in_reply_to as number);
      if (wire.length === 1) { entered.resolve(); return gate.promise; }
      return stale;
    } });
    const first = tool.invoke({ ...args, ...authorize(tool) }, context);
    await entered.promise;
    const queued = tool.invoke({ ...args, body: "old call" }, context);
    gate.resolve(accepted);
    const result = await first; handoffToolResult(result, () => {});
    expect((await queued).isError).toBe(true);
    expect(wire).toEqual([4, 1]);
    expect(tool.replyBasis.capture(context.origin, "c", "peer")).toMatchObject({ basis: 1 });
  });

  it.each(["peer", "cid", "token", "unbound", "retired", "reset", "forgotten", "expired", "spent"] as const)(
    "does not transfer a success ticket across %s", async change => {
      let now = 0; const sink = vi.fn(async () => accepted);
      const tool = makeTool({ replyTicketClock: () => now, sendInterAgent: sink });
      const result = await tool.invoke({ ...args, ...authorize(tool) }, context);
      const next = followup(result); handoffToolResult(result, () => {});
      let target = args, owner: typeof context | undefined = context;
      if (change === "peer") target = { ...args, to: "other" };
      if (change === "cid") target = { ...args, conversation_id: "other" };
      if (change === "token") { tool.beginReplyInput("T2"); owner = { origin: { token: "T2" } }; }
      if (change === "unbound") owner = undefined;
      if (change === "retired") tool.endReplyInput("T");
      if (change === "reset") tool.resetReplyInput();
      if (change === "forgotten") tool.replyBasis.forget("c");
      if (change === "expired") now = 300_000;
      if (change === "spent") expect(typeof tool.replyBasis.capture(context.origin, "c", "peer", 4, next.reply_ticket)).toBe("object");
      const refused = await tool.invoke({ ...target, ...next }, owner);
      expect(refused.isError).toBe(true); expect(sink).toHaveBeenCalledOnce();
    });

  it.each(["newer", "closed", "retired", "forgotten"] as const)(
    "keeps the receipt and removes optional metadata if %s before serialization", async change => {
      const tool = makeTool();
      const result = await tool.invoke({ ...args, done: true, ...authorize(tool) }, context);
      const next = followup(result);
      let newer: ReplyAuthorization | undefined;
      if (change === "newer") newer = authorize(tool, 6);
      if (change === "closed") {
        const terminal = inbound(6); terminal.payload.meta = { done: true, propose_next: "" };
        await tool.receiveInbound(terminal);
      }
      if (change === "retired") tool.endReplyInput("T");
      if (change === "forgotten") tool.replyBasis.forget("c");
      let serialized = "";
      expect(handoffToolResult(result, () => { serialized = JSON.stringify(result); })).toBe(true);
      expect(serialized).toContain("sent to peer");
      expect(serialized).not.toContain(next.reply_ticket);
      noFollowup(JSON.parse(serialized));
      expect(parts(result).some(part => part.followup_authorization_unavailable === true)).toBe(true);
      if (newer) expect(tool.replyBasis.capture(context.origin, "c", "peer", 6, newer.reply_ticket)).toMatchObject({ basis: 6 });
      if (newer) expect(tool.replyBasis.ticketCountForTurn("T")).toBe(2);
    });

  it.each(["discard", "throw"] as const)("does not activate a follow-up on %s", async failure => {
    const tool = makeTool();
    const result = await tool.invoke({ ...args, ...authorize(tool) }, context);
    const next = followup(result);
    if (failure === "discard") discardToolResult(result);
    else expect(() => handoffToolResult(result, () => { throw Error("write failed"); })).toThrow("write failed");
    expect(tool.replyBasis.capture(context.origin, "c", "peer", 4, next.reply_ticket)).toBe("invalid_reply_ticket");
    expect(tool.replyBasis.capture(context.origin, "c", "peer")).toMatchObject({ basis: 1 });
  });

  it.each(["unknown", "rejected", "throw", "legacy", "mode-absent", "fallback"] as const)(
    "does not issue success authorization for %s", async outcome => {
      const options = { config, getState: () => "thinking" as const, send: vi.fn() };
      const sink = vi.fn(async () => {
        if (outcome === "throw") throw Error("transport error");
        return outcome === "unknown" ? { kind: "unknown" as const, reason: "timeout" } : outcome === "rejected"
          ? { kind: "rejected" as const, reason: "quota" } : accepted;
      });
      const tool = new InterAgentTool({ ...options,
        ...(outcome === "mode-absent" ? {} : { replyBasisMode: () => outcome === "legacy" ? "legacy" as const : "v1" as const }),
        ...(outcome === "fallback" ? {} : { sendInterAgent: sink }),
      });
      tool.prepareReplyInput("T", [inbound(1)]); tool.beginReplyInput("T");
      const promise = tool.invoke({ ...args, ...authorize(tool) }, context);
      if (outcome === "throw") await expect(promise).rejects.toThrow("transport error");
      else noFollowup(await promise);
    });

  it.each(["v1", "legacy"] as const)("uses the actual dispatch mode, initially %s", async initial => {
    let mode: "v1" | "legacy" = initial;
    const tool = makeTool({ replyBasisMode: () => mode,
      sendInterAgent: async () => { mode = initial === "v1" ? "legacy" : "v1"; return accepted; } });
    const result = await tool.invoke({ ...args, ...authorize(tool) }, context);
    if (initial === "v1") followup(result); else noFollowup(result);
    discardToolResult(result);
  });

  it("omits unavailable follow-up when this call's done closes the conversation", async () => {
    const tool = makeTool();
    const remote = inbound(2);
    remote.payload.meta = { done: true, propose_next: "" };
    await tool.receiveInbound(remote);
    const result = await tool.invoke({ ...args, done: true, ...authorize(tool) }, context);
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.text).toContain("sent to peer");
    noFollowup(result);
    expect(parts(result).some(part => part.followup_authorization_unavailable === true)).toBe(false);
    expect(handoffToolResult(result, () => {})).toBe(true);
    expect(parts(result).some(part => part.followup_authorization_unavailable === true)).toBe(false);
  });

  it("still reports unavailable when a synthetic close lands before the ack", async () => {
    let tool!: InterAgentTool;
    tool = makeTool({ sendInterAgent: async () => {
      const terminal = inbound(0);
      terminal.agent_id = "server";
      terminal.payload.meta = { done: true, propose_next: "" };
      await tool.receiveInbound(terminal);
      return accepted;
    } });
    const result = await tool.invoke({ ...args, ...authorize(tool) }, context);
    expect(result.content[0]!.text).toContain("sent to peer");
    noFollowup(result);
    const unavailable = parts(result).filter(part => part.followup_authorization_unavailable === true);
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]!.followup_guidance).toBe(
      "The previous send was accepted. No follow-up authorization is available in this result; use a newer handed-off authorization or a new confirmed input, and do not resend the accepted body.",
    );
  });

  it.each(["capacity", "entropy"] as const)("keeps unavailable when this call sends done but preparation fails through %s", async failure => {
    const tool = makeTool(); const original = authorize(tool);
    if (failure === "capacity") for (let n = 0; n < 255; n++) tool.replyBasis.prepare(context.origin, `other-${n}`, "peer", 2);
    else vi.spyOn(tool.replyBasis, "prepareFollowup").mockImplementation(() => { throw Error("entropy unavailable"); });
    const result = await tool.invoke({ ...args, done: true, ...original }, context);
    expect(result.isError).toBeUndefined(); expect(result.content[0]!.text).toContain("sent to peer");
    noFollowup(result);
    expect(parts(result).filter(part => part.followup_authorization_unavailable === true)).toHaveLength(1);
    handoffToolResult(result, () => {});
  });

  it("needs no follow-up ticket when the accepted explicit basis equals the default", async () => {
    const tool = makeTool();
    const result = await tool.invoke({ ...args, ...authorize(tool, 1) }, context);
    noFollowup(result);
    expect(parts(result).some(part => part.followup_authorization_unavailable === true)).toBe(false);
  });

  it.each(["capacity", "entropy"] as const)("preserves acceptance if preparation fails through %s", async failure => {
    const tool = makeTool(); const original = authorize(tool);
    if (failure === "capacity") for (let n = 0; n < 255; n++) tool.replyBasis.prepare(context.origin, `other-${n}`, "peer", 2);
    else vi.spyOn(tool.replyBasis, "prepareFollowup").mockImplementation(() => { throw Error("entropy unavailable"); });
    const result = await tool.invoke({ ...args, ...original }, context);
    expect(result.isError).toBeUndefined(); expect(result.content[0]!.text).toContain("sent to peer");
    noFollowup(result);
    expect(parts(result).some(part => part.followup_authorization_unavailable === true)).toBe(true);
    handoffToolResult(result, () => {});
  });

  it("starts a new lifetime at handoff even when the original accepted ticket has aged out", async () => {
    let now = 0;
    const tool = makeTool({ replyTicketClock: () => now, sendInterAgent: async () => { now = 300_001; return accepted; } });
    const result = await tool.invoke({ ...args, ...authorize(tool) }, context);
    const next = followup(result); now += 5_000; handoffToolResult(result, () => {});
    now += 299_999;
    expect(tool.replyBasis.hasMatchingAuthorization(context.origin, "c", "peer", 4)).toBe(true);
    now++;
    expect(tool.replyBasis.capture(context.origin, "c", "peer", 4, next.reply_ticket)).toBe("expired_reply_ticket");
  });

  it("does not supersede a newer input authorization while constructing a success result", async () => {
    let newer!: ReplyAuthorization; let tool!: InterAgentTool;
    tool = makeTool({ sendInterAgent: async () => { newer = authorize(tool, 6); return accepted; } });
    const result = await tool.invoke({ ...args, ...authorize(tool) }, context);
    noFollowup(result); handoffToolResult(result, () => {});
    expect(tool.replyBasis.capture(context.origin, "c", "peer", 6, newer.reply_ticket)).toMatchObject({ basis: 6 });
  });

  it("preserves acceptance when the owner retires before its acknowledgement arrives", async () => {
    let tool!: InterAgentTool;
    tool = makeTool({ sendInterAgent: async () => { tool.endReplyInput("T"); return accepted; } });
    const result = await tool.invoke({ ...args, ...authorize(tool) }, context);
    expect(result.isError).toBeUndefined(); expect(result.content[0]!.text).toContain("sent to peer");
    noFollowup(result);
  });

  it.each(["reply", "peer-error"] as const)("preserves newer ordinary waiter %s instead of adding an old follow-up ticket", async kind => {
    const ack = vi.fn(); let tool!: InterAgentTool;
    const newer = inbound(6);
    if (kind === "peer-error") newer.payload.error = { code: "api_error", message: "legacy peer error" };
    tool = makeTool({ onInputHandoff: ack, sendInterAgent: async () => {
      queueMicrotask(() => { void tool.receiveInbound(newer); }); return accepted;
    } });
    const result = await tool.invoke({ ...args, ...authorize(tool), wait_for_response: true, timeout_ms: 50 }, context);
    noFollowup(result);
    const metadata = parts(result)[0]!;
    expect((metadata.reply ?? metadata.peer_error_envelope).payload.turn_number).toBe(6);
    expect(metadata.reply_authorization.in_reply_to).toBe(6);
    expect(ack).not.toHaveBeenCalled(); handoffToolResult(result, () => {});
    expect(ack).toHaveBeenCalledOnce();
    expect(tool.replyBasis.capture(context.origin, "c", "peer", 6, metadata.reply_authorization.reply_ticket)).toMatchObject({ basis: 6 });
  });

  it("hands off follow-up authorization on waiter timeout without claiming a new input", async () => {
    const ack = vi.fn(); const tool = makeTool({ onInputHandoff: ack });
    const result = await tool.invoke({ ...args, ...authorize(tool), wait_for_response: true, timeout_ms: 1 }, context);
    const next = followup(result);
    expect(result.content[0]!.text).toContain("reply_pending=true");
    handoffToolResult(result, () => {}); expect(ack).not.toHaveBeenCalled();
    expect(tool.replyBasis.capture(context.origin, "c", "peer", 4, next.reply_ticket)).toMatchObject({ basis: 4 });
  });

  it.each([false, true].flatMap(error => ["handoff", "discard", "serialization", "invalid-owner"].map(outcome => ({ error, outcome }))))(
    "composes status-notice ownership on $outcome with error=$error", async ({ error, outcome }) => {
      const ack = vi.fn(), returned = vi.fn(); let tool!: InterAgentTool;
      const status = inbound(0); status.agent_id = "server";
      if (error) status.payload.error = { code: "delivery_lost", message: "status", peer: "peer" };
      tool = makeTool({ onInputHandoff: ack, returnInput: returned, sendInterAgent: async () => {
        queueMicrotask(() => { void tool.receiveInbound(status); }); return accepted;
      } });
      const result = await tool.invoke({ ...args, ...authorize(tool), wait_for_response: true, timeout_ms: 50 }, context);
      const next = followup(result);
      expect(parts(result)[0]!.status_notice.agent_id).toBe("server");
      expect(next.in_reply_to).toBe(4);
      expect(ack).not.toHaveBeenCalled();
      if (outcome === "discard") discardToolResult(result);
      else if (outcome === "serialization") expect(() => handoffToolResult(result, () => { throw Error("serialization"); })).toThrow("serialization");
      else if (outcome === "invalid-owner") {
        tool.endReplyInput("T"); expect(handoffToolResult(result, () => { throw Error("must not write"); })).toBe(false);
      } else expect(handoffToolResult(result, () => {})).toBe(true);
      if (outcome === "handoff") {
        expect(ack).toHaveBeenCalledOnce(); expect(returned).not.toHaveBeenCalled();
        expect(tool.replyBasis.capture(context.origin, "c", "peer", 4, next.reply_ticket)).toMatchObject({ basis: 4 });
      } else {
        expect(ack).not.toHaveBeenCalled(); expect(returned).toHaveBeenCalledOnce();
      }
    });

  it("keeps independent new waiter input authorization when the send ack is unknown", async () => {
    let tool!: InterAgentTool;
    tool = makeTool({ sendInterAgent: async () => {
      await tool.receiveInbound(inbound(6));
      return { kind: "unknown", reason: "lost acknowledgement" };
    } });
    const result = await tool.invoke({ ...args, ...authorize(tool), wait_for_response: true, timeout_ms: 50 }, context);
    noFollowup(result);
    const metadata = parts(result)[0]!;
    expect(metadata.reply_authorization.in_reply_to).toBe(6);
    handoffToolResult(result, () => {});
    expect(tool.replyBasis.capture(context.origin, "c", "peer", 6, metadata.reply_authorization.reply_ticket)).toMatchObject({ basis: 6 });
  });

  it("does not treat a status notice as acceptance when the send ack is unknown", async () => {
    let tool!: InterAgentTool;
    const status = inbound(0); status.agent_id = "server";
    tool = makeTool({ sendInterAgent: async () => {
      await tool.receiveInbound(status);
      return { kind: "unknown", reason: "lost acknowledgement" };
    } });
    const result = await tool.invoke({ ...args, ...authorize(tool), wait_for_response: true, timeout_ms: 50 }, context);
    expect(parts(result)[0]!.status_notice.agent_id).toBe("server");
    noFollowup(result); handoffToolResult(result, () => {});
    expect(tool.replyBasis.ticketCountForTurn("T")).toBe(1);
  });
});

describe("follow-up eligibility and matching authorization", () => {
  it.each([undefined, null, "4", -1, 0, 4.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "does not use an invalid expected peer turn %s for guidance", value => {
      const tool = makeTool(); authorize(tool);
      expect(tool.replyBasis.hasMatchingAuthorization(context.origin, "c", "peer", value)).toBe(false);
    });
  function consumed(): { basis: ReplyBasis; attempt: ReplyAttempt } {
    const basis = new ReplyBasis(); basis.begin("T", [inbound(1)]);
    const lease = basis.prepare(context.origin, "c", "peer", 4)!; lease.activate();
    return { basis, attempt: basis.capture(context.origin, "c", "peer", 4, lease.authorization.reply_ticket) as ReplyAttempt };
  }
  it.each(["unused", "unregistered", "token", "cid", "peer", "basis", "retired"] as const)(
    "refuses an ineligible consumed attempt: %s", change => {
      const { basis, attempt } = consumed();
      let candidate = attempt;
      if (change === "unused") attempt.ticket!.state = "unused";
      if (change === "unregistered") candidate = { ...attempt, ticket: { ...attempt.ticket! } };
      if (change === "token") { basis.begin("T2", [inbound(1)]); candidate = { ...attempt, origin: { token: "T2" } }; }
      if (change === "cid") candidate = { ...attempt, cid: "other" };
      if (change === "peer") candidate = { ...attempt, peer: "other" };
      if (change === "basis") candidate = { ...attempt, basis: 6 };
      if (change === "retired") basis.retire("T");
      expect(basis.prepareFollowup(candidate)).toBeUndefined();
    });

  it.each(["matching", "wrong-basis", "wrong-peer", "wrong-cid", "wrong-token", "provisional", "spent", "expired", "retired", "missing", "unsafe"] as const)(
    "uses existing authorization guidance only for %s", async status => {
      let now = 0;
      const tool = makeTool({ replyTicketClock: () => now, sendInterAgent: async () => status === "unsafe"
        ? { ...stale, details: { expected_peer_turn: Number.MAX_SAFE_INTEGER + 1 } } : stale });
      if (status === "wrong-token") tool.beginReplyInput("other");
      const lease = status === "missing" ? undefined : tool.replyBasis.prepare({ token: status === "wrong-token" ? "other" : "T" },
        status === "wrong-cid" ? "other" : "c", status === "wrong-peer" ? "other" : "peer", status === "wrong-basis" ? 6 : 4)!;
      if (status !== "provisional") lease?.activate();
      if (status === "spent") tool.replyBasis.capture(context.origin, "c", "peer", 4, lease!.authorization.reply_ticket);
      if (status === "expired") now = 300_000;
      const result = await tool.invoke(args, context);
      if (status === "retired") { tool.endReplyInput("T"); expect(tool.replyBasis.hasMatchingAuthorization(context.origin, "c", "peer", 4)).toBe(false); return; }
      const metadata = parts(result)[0]!;
      expect(metadata.guidance.includes("already handed off in this SDK turn")).toBe(status === "matching");
      expect(metadata).not.toHaveProperty("reply_authorization");
      expect(metadata).not.toHaveProperty("unread_remaining");
    });

  it("does not renew a ticket or its lifetime by showing empty-recovery guidance", async () => {
    let now = 0; let calls = 0;
    const tool = makeTool({ replyTicketClock: () => now, sendInterAgent: async () => ++calls === 1 ? accepted : stale });
    const result = await tool.invoke({ ...args, ...authorize(tool) }, context);
    const next = followup(result); handoffToolResult(result, () => {});
    const count = tool.replyBasis.ticketCountForTurn("T");
    now = 299_999;
    expect(parts(await tool.invoke(args, context))[0]!.guidance).toContain("already handed off");
    expect(tool.replyBasis.ticketCountForTurn("T")).toBe(count);
    now++;
    expect(parts(await tool.invoke(args, context))[0]!.guidance).not.toContain("already handed off");
    expect(tool.replyBasis.capture(context.origin, "c", "peer", 4, next.reply_ticket)).toBe("expired_reply_ticket");
  });

  it("does not mint another ticket after the follow-up outcome becomes unknown", async () => {
    let calls = 0;
    const tool = makeTool({ sendInterAgent: async () => ++calls === 1 ? accepted
      : calls === 2 ? { kind: "unknown", reason: "ack timeout" } : stale });
    const result = await tool.invoke({ ...args, ...authorize(tool) }, context);
    const next = followup(result); handoffToolResult(result, () => {});
    noFollowup(await tool.invoke({ ...args, ...next }, context));
    const count = tool.replyBasis.ticketCountForTurn("T");
    const refused = await tool.invoke(args, context);
    expect(parts(refused)[0]!.guidance).not.toContain("already handed off");
    expect(parts(refused)[0]!).not.toHaveProperty("reply_authorization");
    expect(tool.replyBasis.ticketCountForTurn("T")).toBe(count);
  });

  it("prepares before serialization and preserves the original handoff once", () => {
    const order: string[] = [];
    const result = bindToolResultHandoff({ content: [{ type: "text", text: "before" }] }, {
      prepare: () => { order.push("original-prepare"); }, live: () => true,
      commit: () => { order.push("original-commit"); }, rollback: vi.fn(),
    });
    appendToolResultHandoff(result, { prepare: () => { result.content[0]!.text = "after"; order.push("optional-prepare"); },
      live: () => true, commit: () => { order.push("optional-commit"); }, rollback: vi.fn() });
    expect(handoffToolResult(result, () => { expect(JSON.stringify(result)).toContain("after"); order.push("write"); })).toBe(true);
    expect(order).toEqual(["original-prepare", "optional-prepare", "write", "optional-commit", "original-commit"]);
  });

  it("rechecks the owning handoff after preparation and rolls it back once", () => {
    const owner = new AbortController(), rollback = vi.fn(), optionalRollback = vi.fn(), write = vi.fn();
    const result = bindToolResultHandoff({ content: [] }, {
      live: () => !owner.signal.aborted, commit: vi.fn(), rollback,
    });
    appendToolResultHandoff(result, { prepare: () => { owner.abort(); }, live: () => true, commit: vi.fn(), rollback: optionalRollback });
    expect(handoffToolResult(result, write)).toBe(false);
    expect(write).not.toHaveBeenCalled(); expect(rollback).toHaveBeenCalledOnce(); expect(optionalRollback).toHaveBeenCalledOnce();
  });

  it("releases both ownership components if preparation throws", () => {
    const rollback = vi.fn(), optionalRollback = vi.fn(), write = vi.fn();
    const result = bindToolResultHandoff({ content: [] }, { live: () => true, commit: vi.fn(), rollback });
    appendToolResultHandoff(result, { prepare: () => { throw Error("preparation failed"); }, live: () => true, commit: vi.fn(), rollback: optionalRollback });
    expect(() => handoffToolResult(result, write)).toThrow("preparation failed");
    expect(write).not.toHaveBeenCalled(); expect(rollback).toHaveBeenCalledOnce(); expect(optionalRollback).toHaveBeenCalledOnce();
  });

  it("retains the appended component's own liveness check", () => {
    const rollback = vi.fn(), optionalRollback = vi.fn(), write = vi.fn();
    const result = bindToolResultHandoff({ content: [] }, { live: () => true, commit: vi.fn(), rollback });
    appendToolResultHandoff(result, { live: () => false, commit: vi.fn(), rollback: optionalRollback });
    expect(handoffToolResult(result, write)).toBe(false);
    expect(write).not.toHaveBeenCalled(); expect(rollback).toHaveBeenCalledOnce(); expect(optionalRollback).toHaveBeenCalledOnce();
  });
});
