import { describe, expect, it } from "vitest";
import { QueueLease } from "@kaoiro/wrapper-core";
import { InterAgentTool } from "../src/inter_agent.js";
import { QueueInput } from "../src/queue_input.js";
import { discardToolResult, handoffToolResult } from "../src/reply_basis.js";
import type { Envelope } from "../src/types.js";

// credit-v1 inline recovery (r8 §6.3): a `stale_reply_basis` refusal carries
// the refused sender's queued input; the tool returns it inline after taking
// the permit under its own turn.

const PERSONA = { id: "mio", name: "澪", sprite_set: "mio" };
const policy = { batch_max_items: 10, backlog_max_items: 100, backlog_max_bytes: 524_288 };
const counts = { queued: 0, offered: 0, native_pending: 0, waiter: 0, control: 0, charged_bytes: 0, policy };

function peerInput(turn: number, body = "newer input"): Envelope {
  return {
    version: "0", agent_id: "peer.agent", persona: PERSONA, display_name: PERSONA.name,
    ts: "2026-10-04T00:00:00Z", type: "inter_agent_message", state: "idle",
    payload: {
      to: "self.agent", conversation_id: "cnv-r", turn_number: turn, kind: "inform", body,
      meta: { done: false, propose_next: "" }, owner: { kind: "user", id: "operator" },
    },
    ext: {},
  } as Envelope;
}

function harness(options: { refuse?: Record<string, string>; recovery?: boolean; body?: string } = {}) {
  const sent: Record<string, unknown>[] = [];
  const legacyClaims: string[] = [];
  const lease = new QueueLease({
    transport: async (payload) => {
      sent.push(payload);
      const reason = options.refuse?.[payload.op as string];
      if (reason !== undefined) throw { reason };
      const base = { op: payload.op, operation_id: payload.operation_id, queue: counts };
      switch (payload.op) {
        case "begin_native": return { ...base, permitted_queue_ids: payload.queue_ids };
        case "return": return { ...base, returned_ranges: [] };
        case "dispose": return { ...base, disposed: (payload.items as { queue_id: string }[]).map((i) => i.queue_id), resolved_ranges: [], returned_ranges: [] };
        default: return base;
      }
    },
    onOffer: () => {},
  });
  lease.join({
    inter_agent_queue: "credit-v1", inter_agent_queue_policy: policy,
    inter_agent_queue_epoch: "e1", inter_agent_queue_resume_required: false,
  }, "i1", "g1");
  let input!: QueueInput;
  const tool = new InterAgentTool({
    config: { agent_id: "self.agent", persona: PERSONA, display_name: PERSONA.name, server_url: "ws://x" },
    getState: () => "tool_running",
    getActiveInterAgentTurnToken: () => "tool-turn",
    send: () => {},
    replyBasisMode: () => "v1",
    claimRecovery: (cid) => { legacyClaims.push(cid); return undefined; },
    sendInterAgent: async () => ({
      kind: "rejected", reason: "stale_reply_basis",
      details: { conversation_id: "cnv-r", expected_peer_turn: 3, supplied_basis: 1 },
      queue_recovery: lease.receiveRecovery({
        lease_id: "5",
        items: [{ queue_id: "q1", attempt_id: "q1.1", delivery_seq: 7, class: "ordinary", byte_charge: 1, envelope: peerInput(3, options.body) }],
      })!,
    }),
    ...(options.recovery === false ? {} : {
      queueRecovery: (offer, turn, fit) => input.recover(offer, turn, fit),
    }),
    now: () => "2026-10-04T00:00:00Z",
    newId: () => "cnv-new",
  });
  input = new QueueInput({
    classify: (envelope) => tool.receiveInbound(envelope),
    reclassify: (envelope, mode) => tool.queuedInboundMode(envelope, mode),
    sendNotice: () => {},
    tracked: (cid) => tool.hasConversationTrack(cid),
  });
  // The calling tool's turn is a live input.
  tool.beginNotificationReplyInput("tool-turn", new AbortController().signal);
  tool.observeInbound("cnv-r", 1);
  const reply = () => tool.invoke(
    { to: "peer.agent", body: "my reply", kind: "response", conversation_id: "cnv-r" },
    { origin: { token: "tool-turn" } },
  );
  const ops = (op: string) => sent.filter((p) => p.op === op);
  return { tool, input, lease, sent, ops, reply, legacyClaims };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("credit-v1 inline recovery", () => {
  it("returns the claimed input inline, permitted under the tool's turn, and observes it at the return", async () => {
    const h = harness();
    const result = await h.reply();
    const body = JSON.parse(result.content[0]!.text);
    expect(body.error).toBe("stale_reply_basis");
    expect(body.recovery.map((e: Envelope) => (e.payload as { body: string }).body)).toEqual(["newer input"]);
    expect(h.ops("begin_native")[0]).toMatchObject({ lease_id: "5", queue_ids: ["q1"], native_turn_token: "tool-turn" });
    expect(handoffToolResult(result, () => {})).toBe(true);
    await settle();
    expect(h.ops("dispose")[0]).toMatchObject({ lease_id: "5", items: [{ queue_id: "q1", outcome: "observed", witness: "tool_result" }] });
  });

  it("returns the input recovery_abandoned when the result is not returned", async () => {
    const h = harness();
    const result = await h.reply();
    discardToolResult(result);
    await settle();
    expect(h.ops("return")[0]).toMatchObject({ items: [{ queue_id: "q1", reason: "recovery_abandoned" }] });
  });

  it("returns input too large for the inline result, with the no-recovery guidance", async () => {
    const h = harness({ body: "x".repeat(20_000) });
    const result = await h.reply();
    const body = JSON.parse(result.content[0]!.text);
    expect(body.recovery).toEqual([]);
    expect(body.guidance).toContain("No matching input is available for inline recovery");
    await settle();
    expect(h.ops("begin_native")).toEqual([]);
    expect(h.ops("return")[0]).toMatchObject({ items: [{ queue_id: "q1", reason: "recovery_abandoned" }] });
  });

  it("a refused permit gives no inline recovery and releases the input", async () => {
    const h = harness({ refuse: { begin_native: "queue_resume_required" } });
    const result = await h.reply();
    expect(JSON.parse(result.content[0]!.text).recovery).toEqual([]);
    await settle();
    expect(h.ops("return")[0]).toMatchObject({ items: [{ queue_id: "q1", reason: "turn_abandoned" }] });
    // The server claimed this conversation's input: the legacy coordinator holds none to add.
    expect(h.legacyClaims).toEqual([]);
  });

  it("a wrapper without the queue recovery wiring releases what the server claimed", async () => {
    const h = harness({ recovery: false });
    const result = await h.reply();
    expect(JSON.parse(result.content[0]!.text).recovery).toEqual([]);
    await settle();
    expect(h.ops("begin_native")).toEqual([]);
    expect(h.ops("return")[0]).toMatchObject({ items: [{ queue_id: "q1", reason: "turn_abandoned" }] });
  });
});
