import { describe, expect, it, vi } from "vitest";
import { QueueLease, type QueueOffer } from "@kaoiro/wrapper-core";
import type { WaiterRegistrationRequest } from "@kaoiro/protocol";
import { InterAgentTool } from "../src/inter_agent.js";
import { QUEUE_HANDOFF_PERMIT_WAIT_MS, QueueInput } from "../src/queue_input.js";
import type { Envelope } from "../src/types.js";

// credit-v1 W path (r8 §6.1, §6.2): a waiting send registers a server-side
// waiter, its reply arrives as a `waiter` offer, and the waiting tool takes
// the permit under its own turn before the result goes out.

const PERSONA = { id: "mio", name: "澪", sprite_set: "mio" };
const policy = { batch_max_items: 10, backlog_max_items: 100, backlog_max_bytes: 524_288 };
const counts = { queued: 0, offered: 0, native_pending: 0, waiter: 0, control: 0, charged_bytes: 0, policy };

function reply(cid: string, turn = 2): Envelope {
  return {
    version: "0", agent_id: "peer.agent", persona: PERSONA, display_name: PERSONA.name,
    ts: "2026-10-04T00:00:00Z", type: "inter_agent_message", state: "idle",
    payload: {
      to: "self.agent", conversation_id: cid, turn_number: turn, kind: "response", body: "answer",
      meta: { done: false, propose_next: "" }, owner: { kind: "user", id: "operator" },
    },
    ext: {},
  } as Envelope;
}

function harness(options: {
  queue?: boolean; registrationId?: string; gates?: Record<string, Promise<void>>; refuse?: Record<string, string>;
  onOp?: (payload: Record<string, unknown>) => void;
} = {}) {
  const sent: Record<string, unknown>[] = [];
  const outers: Array<{ waiter_registration?: WaiterRegistrationRequest } | undefined> = [];
  const closed: string[] = [];
  const timers: Array<{ task: () => void; ms: number }> = [];
  let classified = 0;
  let input!: QueueInput;
  const lease = new QueueLease({
    transport: async (payload) => {
      sent.push(payload);
      options.onOp?.(payload);
      await options.gates?.[payload.op as string];
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
    onOffer: (offer: QueueOffer) => void (offer.kind === "waiter" ? input.acceptWaiter(offer) : input.prepare(offer)),
  });
  lease.join({
    inter_agent_queue: "credit-v1", inter_agent_queue_policy: policy,
    inter_agent_queue_epoch: "e1", inter_agent_queue_resume_required: false,
  }, "i1", "g1");
  const tool = new InterAgentTool({
    config: { agent_id: "self.agent", persona: PERSONA, display_name: PERSONA.name, server_url: "ws://x" },
    getState: () => "tool_running",
    getActiveInterAgentTurnToken: () => "tool-turn",
    send: () => {},
    sendInterAgent: async (_envelope, _generation, outer) => {
      outers.push(outer);
      return { kind: "accepted", stamp: null, ...(options.registrationId === undefined ? {} : { waiter_registration_id: options.registrationId }) };
    },
    ...(options.queue === false ? {} : {
      queueWaiters: () => true,
      closeWaiter: (id: string) => closed.push(id),
      queueHandoff: (envelopes: readonly Envelope[], turn: string) => input.handoff(envelopes, turn),
    }),
    now: () => "2026-10-04T00:00:00Z",
    newId: () => "cnv-new",
  });
  input = new QueueInput({
    classify: async (envelope) => { classified++; return tool.receiveInbound(envelope); },
    reclassify: (envelope, mode) => tool.queuedInboundMode(envelope, mode),
    sendNotice: () => {},
    tracked: (cid) => tool.hasConversationTrack(cid),
    schedule: (task, ms) => { timers.push({ task, ms }); return () => {}; },
  });
  let leaseId = 0;
  const offer = (envelope: Envelope, kind: "waiter" | "root" = "waiter", id = "1") => {
    leaseId += 1;
    return lease.receiveBatch({
      version: "0", queue_epoch: "e1", incarnation: "i1", generation: "g1", lease_id: String(leaseId), kind,
      ...(kind === "root" ? { credit_revision: "1" } : { registration_id: "r1" }),
      items: [{ queue_id: id, attempt_id: `${id}.${leaseId}`, delivery_seq: leaseId, class: kind === "waiter" ? "waiter" : "ordinary", byte_charge: 1, envelope }],
    });
  };
  const ops = (op: string) => sent.filter((p) => p.op === op);
  const wait = (timeout_ms = 1_000) => tool.invoke(
    { to: "peer.agent", body: "please", kind: "request", conversation_id: "cnv-w", wait_for_response: true, timeout_ms },
    { origin: { token: "tool-turn" } },
  );
  return { tool, input, lease, sent, outers, closed, timers, offer, ops, wait, classified: () => classified };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("credit-v1 waiter registration", () => {
  it("a waiting send carries a private registration; a plain send and a legacy wrapper carry none", async () => {
    const h = harness();
    void h.wait(5_000);
    await settle();
    expect(h.outers[0]?.waiter_registration).toEqual({
      token: expect.stringMatching(/^[0-9a-f]{32}$/), call_token: "tool-turn", expires_in_ms: 5_000,
    });
    await h.tool.invoke({ to: "peer.agent", body: "fyi", kind: "inform", conversation_id: "cnv-x" });
    expect(h.outers[1]).toBeUndefined();
    const legacy = harness({ queue: false });
    void legacy.wait();
    await settle();
    expect(legacy.outers[0]).toBeUndefined();
  });

  it("closes the registration when the wait times out, not when the reply matched", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ registrationId: "reg-1" });
      const pending = h.wait(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;
      expect(result.content[0]!.text).toContain("reply_pending=true");
      expect(h.closed).toEqual(["reg-1"]);
    } finally {
      vi.useRealTimers();
    }
    const matched = harness({ registrationId: "reg-2" });
    const pending = matched.wait();
    await settle();
    matched.offer(reply("cnv-w"));
    await pending;
    expect(matched.closed).toEqual([]);
  });
});

describe("credit-v1 W offers through the waiting tool", () => {
  it("permits the reply under the tool's turn before the result goes out, and observes it at the return", async () => {
    const h = harness();
    const pending = h.wait();
    await settle();
    h.offer(reply("cnv-w"));
    const result = await pending;
    expect(JSON.parse(result.content[0]!.text).reply.payload.body).toBe("answer");
    expect(h.ops("begin_native")[0]).toMatchObject({ queue_ids: ["1"], native_turn_token: "tool-turn" });
    await settle();
    expect(h.ops("dispose")[0]).toMatchObject({ items: [{ queue_id: "1", outcome: "observed", witness: "tool_result" }] });
  });

  it("a refused permit answers as a wait with no reply, and the reply is injected when offered again", async () => {
    const h = harness({ refuse: { begin_native: "queue_resume_required" } });
    const pending = h.wait();
    await settle();
    h.offer(reply("cnv-w"));
    const result = await pending;
    expect(result.content[0]!.text).toContain("reply_pending=true");
    await settle();
    expect(h.ops("return")[0]).toMatchObject({ items: [{ queue_id: "1", reason: "turn_abandoned" }] });
    const again = await h.input.prepare({
      leaseId: "x", kind: "root", items: [{ queueId: "1", deliverySeq: 9, class: "waiter", envelope: reply("cnv-w") as never }],
      begin: async () => null, release: () => {}, return: async () => ({ ok: true }) as never, dispose: async () => ({ ok: true }) as never,
    });
    expect(again.injected).toHaveLength(1);
    expect(again.consumed).toEqual([]);
    expect(h.classified()).toBe(1);
  });

  it("a permit wait past its bound rewrites the classification before the release goes out", async () => {
    let open!: () => void;
    const late = new Promise<void>((resolve) => { open = resolve; });
    let reoffer: Promise<{ injected: readonly unknown[]; consumed: readonly unknown[] }> | undefined;
    let h!: ReturnType<typeof harness>;
    h = harness({
      gates: { begin_native: late },
      // The re-offer is classified in the very tick the release is sent.
      onOp: (payload) => {
        if (payload.op !== "return") return;
        reoffer = h.input.prepare({
          leaseId: "x", kind: "root", items: [{ queueId: "1", deliverySeq: 9, class: "waiter", envelope: reply("cnv-w") as never }],
          begin: async () => null, release: () => {}, return: async () => ({ ok: true }) as never, dispose: async () => ({ ok: true }) as never,
        });
      },
    });
    const pending = h.wait();
    await settle();
    h.offer(reply("cnv-w"));
    await settle();
    expect(h.ops("begin_native")).toHaveLength(1);
    h.timers.at(-1)!.task();
    const result = await pending;
    expect(result.content[0]!.text).toContain("reply_pending=true");
    // The permit lands after the bound: it is returned, never used.
    open();
    await settle();
    expect(h.ops("return")[0]).toMatchObject({ items: [{ queue_id: "1", reason: "turn_abandoned" }] });
    const again = await reoffer!;
    expect(again.injected).toHaveLength(1);
    expect(again.consumed).toEqual([]);
    expect(h.classified()).toBe(1);
  });

  it("a reply no waiter took (the wait ended first) goes back as W, not injected", async () => {
    const h = harness();
    h.offer(reply("cnv-other"));
    await settle();
    expect(h.ops("return")[0]).toMatchObject({ items: [{ queue_id: "1", reason: "waiter_abandoned" }] });
    expect(h.ops("begin_native")).toEqual([]);
  });

  it("a consumed reply no tool asks for in time goes back to be injected", async () => {
    const timers: Array<() => void> = [];
    const released: string[][] = [];
    let classified = 0;
    const input = new QueueInput({
      classify: async () => { classified++; return { consumed: true, inject: false, mode: "reply-owed" }; },
      reclassify: (_envelope, mode) => mode,
      sendNotice: () => {},
      tracked: () => true,
      schedule: (task) => { timers.push(task); return () => {}; },
    });
    const offerOf = (): QueueOffer => ({
      leaseId: "1", kind: "waiter", items: [{ queueId: "1", deliverySeq: 1, class: "waiter", envelope: reply("cnv-w") as never }],
      begin: async () => null, release: (ids) => { released.push([...ids]); },
      return: async () => ({ ok: true }) as never, dispose: async () => ({ ok: true }) as never,
    });
    const first = await input.prepare(offerOf());
    expect(first.consumed).toHaveLength(1);
    timers[0]!();
    expect(released).toEqual([["1"]]);
    const again = await input.prepare(offerOf());
    expect(again.injected).toHaveLength(1);
    expect(classified).toBe(1);
  });
});
