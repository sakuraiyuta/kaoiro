import { describe, expect, it } from "vitest";
import { QueueLease, type QueueOffer } from "../src/queue_lease.js";

const policy = { batch_max_items: 10, backlog_max_items: 100, backlog_max_bytes: 524_288 };
const counts = { queued: 0, offered: 0, native_pending: 0, waiter: 0, control: 0, charged_bytes: 0, policy };
const joinReply = {
  inter_agent_queue: "credit-v1" as const,
  inter_agent_queue_policy: policy,
  inter_agent_queue_epoch: "e1",
  inter_agent_queue_resume_required: false,
};
const envelope = { version: "0", type: "inter_agent_message", agent_id: "peer", payload: { body: "hi" } };

function batch(leaseId = "1", queueIds = ["10"], overrides: Record<string, unknown> = {}) {
  return {
    version: "0",
    queue_epoch: "e1",
    incarnation: "i1",
    generation: "g1",
    lease_id: leaseId,
    kind: "root",
    credit_revision: "1",
    items: queueIds.map((id, index) => ({
      queue_id: id,
      attempt_id: `${id}.1`,
      delivery_seq: index + 1,
      class: "ordinary",
      byte_charge: 2,
      envelope,
    })),
    ...overrides,
  };
}

/** A fake server: answers each control op from `respond`, recording payloads. */
function harness(respond: (payload: Record<string, unknown>) => unknown = defaultReply) {
  const sent: Record<string, unknown>[] = [];
  const offers: QueueOffer[] = [];
  const pending: Array<() => void> = [];
  let hold = false;
  const lease = new QueueLease({
    transport: (payload) => {
      sent.push(payload);
      const run = () => {
        const reply = respond(payload);
        if (reply instanceof Error) throw (reply as Error & { payload: unknown }).payload;
        return reply;
      };
      if (!hold) return Promise.resolve().then(run);
      return new Promise((resolve, reject) => pending.push(() => {
        try { resolve(run()); } catch (error) { reject(error); }
      }));
    },
    onOffer: (offer) => offers.push(offer),
  });
  lease.join(joinReply, "i1", "g1");
  return {
    lease, sent, offers,
    holdReplies: () => { hold = true; },
    release: () => { for (const next of pending.splice(0)) next(); },
  };
}

function defaultReply(payload: Record<string, unknown>): unknown {
  const base = { op: payload.op, operation_id: payload.operation_id, queue: counts };
  switch (payload.op) {
    case "credit": return { ...base, credit_revision: "1" };
    case "begin_native": return { ...base, permitted_queue_ids: payload.queue_ids };
    case "return": return { ...base, returned_ranges: [[1, 1]] };
    case "dispose": return { ...base, disposed: (payload.items as { queue_id: string }[]).map((i) => i.queue_id), resolved_ranges: [[1, 1]], returned_ranges: [] };
    case "freeze": return { ...base, frozen: true };
    case "resume": return { ...base, leases: [], registrations: [] };
    default: return { ...base, withdrawn: true };
  }
}

function refusal(reason: string): Error {
  return Object.assign(new Error(reason), { payload: { reason } });
}

describe("QueueLease", () => {
  it("fences every control op with the binding and increasing operation ids", async () => {
    const { lease, sent } = harness();
    await lease.credit("root", "t1");
    await lease.credit("early", "t1", "fold");
    expect(sent.map((p) => p.operation_id)).toEqual(["1", "2"]);
    expect(sent[0]).toMatchObject({ version: "0", queue_epoch: "e1", incarnation: "i1", generation: "g1", op: "credit", kind: "root" });
    expect(sent[1]).toMatchObject({ kind: "early", mechanism: "fold" });
  });

  it("accepts a batch only for the current binding, once", () => {
    const { lease, offers } = harness();
    expect(lease.receiveBatch(batch("1", ["10"], { queue_epoch: "old" }))).toBe(false);
    expect(lease.receiveBatch(batch("1", ["10"], { generation: "g0" }))).toBe(false);
    expect(lease.receiveBatch({ junk: true })).toBe(false);
    expect(lease.receiveBatch(batch())).toBe(true);
    expect(lease.receiveBatch(batch())).toBe(false);
    expect(offers).toHaveLength(1);
    expect(offers[0]!.items[0]).toMatchObject({ queueId: "10", deliverySeq: 1, class: "ordinary" });
  });

  it("submits once through the permit, then only a disposition settles", async () => {
    const { lease, offers, sent } = harness();
    lease.receiveBatch(batch());
    const offer = offers[0]!;
    const submit = await offer.begin(["10"], "t1");
    expect(submit).not.toBeNull();

    let calls = 0;
    expect(submit!.invoke(() => { calls++; })).toBe(true);
    expect(submit!.invoke(() => { calls++; })).toBe(false);
    expect(calls).toBe(1);

    expect(await offer.return([{ queue_id: "10", reason: "shutdown" }])).toMatchObject({ ok: false });
    expect(sent.some((p) => p.op === "return")).toBe(false);

    const result = await offer.dispose([{ queue_id: "10", outcome: "observed", witness: "prompt_hook" }]);
    expect(result.ok).toBe(true);
    expect(lease.heldLeaseIds()).toEqual([]);
  });

  it("a return while the permit is in flight wins over the late permit", async () => {
    const h = harness();
    h.lease.receiveBatch(batch());
    const offer = h.offers[0]!;
    h.holdReplies();
    const begin = offer.begin(["10"], "t1");
    const returned = offer.return([{ queue_id: "10", reason: "host_rejected_before_start" }]);
    h.release();
    expect(await begin).toBeNull();
    expect((await returned).ok).toBe(true);
  });

  it("a freeze stops the permit from being used and new credit", async () => {
    const { lease, offers } = harness();
    lease.receiveBatch(batch());
    const submit = await offers[0]!.begin(["10"], "t1");
    void lease.freeze("shutdown");
    expect(lease.frozen).toBe(true);
    let called = false;
    expect(submit!.invoke(() => { called = true; })).toBe(false);
    expect(called).toBe(false);
    expect(await lease.credit("root", "t2")).toEqual({ ok: false, error: { reason: "queue_frozen" } });
    expect(lease.receiveBatch(batch("2", ["11"]))).toBe(false);
  });

  it("a refused permit leaves the item offered and typed", async () => {
    const { lease, offers } = harness((payload) =>
      payload.op === "begin_native" ? refusal("queue_resume_required") : defaultReply(payload));
    lease.receiveBatch(batch());
    expect(await offers[0]!.begin(["10"], "t1")).toBeNull();
    const result = await offers[0]!.dispose([{ queue_id: "10", outcome: "intentional_non_injection", reason: "stale_skip" }]);
    expect(result.ok).toBe(true);
  });

  it("surfaces a typed control error", async () => {
    const { lease } = harness(() => refusal("previous_root_pending"));
    expect(await lease.credit("root", "t")).toEqual({ ok: false, error: { reason: "previous_root_pending" } });
  });

  it("a new generation drops held leases and restarts operation ids; resume names held leases", async () => {
    const { lease, sent } = harness();
    lease.receiveBatch(batch("7", ["10"]));
    await lease.resume();
    expect(sent.at(-1)).toMatchObject({ op: "resume", leases: [{ lease_id: "7", queue_ids: ["10"] }], registration_ids: [] });

    lease.join(joinReply, "i1", "g2");
    expect(lease.heldLeaseIds()).toEqual([]);
    await lease.credit("root", "t");
    expect(sent.at(-1)).toMatchObject({ operation_id: "1", generation: "g2" });
  });
});
