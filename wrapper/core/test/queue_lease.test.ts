import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
function harness(
  respond: (payload: Record<string, unknown>) => unknown = defaultReply,
  log?: (line: string) => void,
) {
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
    ...(log === undefined ? {} : { log }),
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

describe("QueueLease — unknown outcomes", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const ops = (sent: Record<string, unknown>[], op: string) => sent.filter((p) => p.op === op);
  const phases = (items: [string, string][]) => (payload: Record<string, unknown>) => ({
    op: "resume", operation_id: payload.operation_id, queue: counts,
    leases: [{ lease_id: "1", items: items.map(([queue_id, phase]) => ({ queue_id, phase })) }],
    registrations: [],
  });

  /** Answers each op from a per-op script, falling back to the default. */
  function scripted(script: Record<string, Array<(payload: Record<string, unknown>) => unknown>>) {
    return (payload: Record<string, unknown>) => {
      const next = script[payload.op as string]?.shift();
      return next === undefined ? defaultReply(payload) : next(payload);
    };
  }
  const unavailable = () => refusal("queue_unavailable");
  const lost = () => Object.assign(new Error("timeout"), { payload: { reason: "timeout" } });

  it("resends an unanswered return once under its own id, then settles", async () => {
    const h = harness(scripted({ return: [unavailable] }));
    h.lease.receiveBatch(batch());
    const settled = h.offers[0]!.return([{ queue_id: "10", reason: "format_budget" }]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await settled).toMatchObject({ ok: true, reply: { op: "return" } });
    const returns = ops(h.sent, "return");
    expect(returns.map((p) => p.operation_id)).toEqual(["1", "1"]);
    expect(h.lease.heldLeaseIds()).toEqual([]);
  });

  it("re-issues under a new id a return the resume shows not applied, never the old id", async () => {
    const h = harness(scripted({ return: [unavailable, unavailable], resume: [phases([["10", "offered"]])] }));
    h.lease.receiveBatch(batch());
    const settled = h.offers[0]!.return([{ queue_id: "10", reason: "format_budget" }]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await settled).toMatchObject({ ok: true });
    const resumeId = Number(ops(h.sent, "resume")[0]!.operation_id);
    const returns = ops(h.sent, "return").map((p) => Number(p.operation_id));
    expect(returns.slice(0, 2)).toEqual([1, 1]);
    expect(returns.slice(2)).toHaveLength(1);
    expect(returns[2]).toBeGreaterThan(resumeId);
    expect(ops(h.sent, "resume")[0]).toMatchObject({ leases: [{ lease_id: "1", queue_ids: ["10"] }] });
  });

  it("settles a parked return the resume shows applied, without a re-issue", async () => {
    const unknownOp = () => refusal("unknown_operation");
    const h = harness(scripted({ return: [lost, unknownOp], resume: [phases([["10", "queued"]])] }));
    h.lease.receiveBatch(batch());
    const settled = h.offers[0]!.return([{ queue_id: "10", reason: "format_budget" }]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await settled).toEqual({ ok: true });
    expect(ops(h.sent, "return")).toHaveLength(2);
    expect(h.lease.heldLeaseIds()).toEqual([]);
  });

  it.each([
    ["native_pending", true, ["1"]],
    ["offered", false, ["1"]],
    ["queued", false, []],
  ] as const)("a parked begin resolves from the resume phase %s", async (phase, permitted, held) => {
    const h = harness(scripted({ begin_native: [unavailable, unavailable], resume: [phases([["10", phase]])] }));
    h.lease.receiveBatch(batch());
    const begin = h.offers[0]!.begin(["10"], "t1");
    await vi.advanceTimersByTimeAsync(1_000);
    const submit = await begin;
    expect(submit !== null).toBe(permitted);
    if (submit !== null) {
      expect(submit.nativeTurnToken).toBe("t1");
      expect(submit.invoke(() => {})).toBe(true);
    }
    expect(h.lease.heldLeaseIds()).toEqual(held);
  });

  it("a refused begin is final: the item is offered again", async () => {
    const h = harness(scripted({ begin_native: [() => refusal("unknown_queue_item")] }));
    h.lease.receiveBatch(batch());
    expect(await h.offers[0]!.begin(["10"], "t1")).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ops(h.sent, "begin_native")).toHaveLength(1);
    expect(await h.offers[0]!.begin(["10"], "t1")).not.toBeNull();
  });

  it("logs a disposition refused as a wrapper bug and leaves the item visible", async () => {
    const lines: string[] = [];
    const h = harness(scripted({ dispose: [() => refusal("conflicting_disposition")] }), (line) => lines.push(line));
    h.lease.receiveBatch(batch());
    const result = await h.offers[0]!.dispose([{ queue_id: "10", outcome: "intentional_non_injection", reason: "stale_skip" }]);
    expect(result).toEqual({ ok: false, error: { reason: "conflicting_disposition" } });
    expect(lines.join("\n")).toContain("dispose refused");
    expect(h.lease.heldLeaseIds()).toEqual(["1"]);
    expect(await h.offers[0]!.return([{ queue_id: "10", reason: "shutdown" }])).toMatchObject({ ok: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ops(h.sent, "dispose")).toHaveLength(1);
  });

  it("an abandoned begin that turns out permitted is returned as permit_unused", async () => {
    const h = harness();
    h.lease.receiveBatch(batch());
    h.holdReplies();
    const begin = h.offers[0]!.begin(["10"], "t1");
    h.offers[0]!.abandonBegin(["10"]);
    h.release();
    expect(await begin).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    h.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(ops(h.sent, "return")).toEqual([
      expect.objectContaining({ items: [{ queue_id: "10", reason: "permit_unused" }] }),
    ]);
    expect(h.lease.heldLeaseIds()).toEqual([]);
  });

  it("abandoning a permitted item returns it and voids the permit", async () => {
    const h = harness();
    h.lease.receiveBatch(batch());
    const submit = await h.offers[0]!.begin(["10"], "t1");
    h.offers[0]!.abandonBegin(["10"]);
    expect(submit!.invoke(() => {})).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(ops(h.sent, "return")).toEqual([
      expect.objectContaining({ items: [{ queue_id: "10", reason: "permit_unused" }] }),
    ]);
  });

  it("a rejoin reconciles whenever a lease is held, without resending old ids", async () => {
    const h = harness(scripted({ return: [lost], resume: [phases([["10", "offered"]])] }));
    h.lease.receiveBatch(batch());
    const settled = h.offers[0]!.return([{ queue_id: "10", reason: "format_budget" }]);
    await vi.advanceTimersByTimeAsync(0);
    h.lease.join(joinReply, "i1", "g1");
    await h.lease.rejoined(false);
    expect(await settled).toMatchObject({ ok: true });
    const returns = ops(h.sent, "return").map((p) => p.operation_id);
    expect(returns).toHaveLength(2);
    expect(new Set(returns).size).toBe(2);
  });

  it("nothing held and no resume required: a rejoin sends nothing", async () => {
    const h = harness();
    await h.lease.rejoined(false);
    expect(h.sent).toEqual([]);
  });

  it("a generation change ends parked operations as stale", async () => {
    const h = harness(scripted({ return: [lost], begin_native: [lost] }));
    h.lease.receiveBatch(batch("1", ["10", "11"]));
    const settled = h.offers[0]!.return([{ queue_id: "10", reason: "format_budget" }]);
    const begin = h.offers[0]!.begin(["11"], "t1");
    await vi.advanceTimersByTimeAsync(0);
    h.lease.join(joinReply, "i1", "g2");
    expect(await settled).toEqual({ ok: false, error: { reason: "stale_channel" } });
    expect(await begin).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ops(h.sent, "resume")).toEqual([]);
  });
});

