import { describe, expect, it } from "vitest";
import { QueueLease, type QueueOffer } from "@kaoiro/wrapper-core";
import type { Envelope } from "@kaoiro/agent-common";
import { ClaudeQueueRoot, type QueueRootDeps } from "../src/queue_root.js";

const policy = { batch_max_items: 10, backlog_max_items: 100, backlog_max_bytes: 524_288 };
const counts = { queued: 0, offered: 0, native_pending: 0, waiter: 0, control: 0, charged_bytes: 0, policy };

function inbound(cid: string, turn = 1): Envelope {
  return {
    version: "0", agent_id: "peer.agent", persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P",
    ts: "2026-10-04T00:00:00Z", type: "inter_agent_message", state: "idle",
    payload: { to: "self.agent", conversation_id: cid, turn_number: turn, kind: "inform", body: "hi", meta: { done: false, propose_next: "" } },
    ext: {},
  } as unknown as Envelope;
}

function reply(payload: Record<string, unknown>): unknown {
  const base = { op: payload.op, operation_id: payload.operation_id, queue: counts };
  switch (payload.op) {
    case "credit": return { ...base, credit_revision: "1" };
    case "begin_native": return { ...base, permitted_queue_ids: payload.queue_ids };
    case "return": return { ...base, returned_ranges: [] };
    case "dispose": return { ...base, disposed: (payload.items as { queue_id: string }[]).map((i) => i.queue_id), resolved_ranges: [], returned_ranges: [] };
    default: return { ...base };
  }
}

function harness(overrides: Partial<QueueRootDeps> = {}, refuse: Record<string, string> = {}, gates: Record<string, Promise<void>> = {}) {
  const sent: Record<string, unknown>[] = [];
  const lines: string[] = [];
  const sends: Array<{ text: string; token: string }> = [];
  const timers: Array<{ task: () => void; ms: number }> = [];
  let idle = true;
  let root!: ClaudeQueueRoot;
  const lease = new QueueLease({
    transport: async (payload) => {
      sent.push(payload);
      await gates[payload.op as string];
      const reason = refuse[payload.op as string];
      if (reason !== undefined) throw { reason };
      return reply(payload);
    },
    onOffer: (offer: QueueOffer) => void root.onOffer(offer),
  });
  lease.join({
    inter_agent_queue: "credit-v1", inter_agent_queue_policy: policy,
    inter_agent_queue_epoch: "e1", inter_agent_queue_resume_required: false,
  }, "i1", "g1");
  root = new ClaudeQueueRoot({
    lease: () => lease,
    ready: async () => {},
    isIdle: () => idle,
    enqueue: (task) => task(),
    send: async (text, _cids, token) => { sends.push({ text, token }); },
    preparePending: () => {},
    classify: async () => ({ consumed: false, inject: true, mode: "reply-owed" }),
    reclassify: (_envelope, mode) => mode,
    sendNotice: () => {},
    tracked: () => true,
    log: (line) => lines.push(line),
    defer: (task) => task(),
    schedule: (task, ms) => { timers.push({ task, ms }); },
    ...overrides,
  });
  let leaseId = 0;
  const offer = (envelopes: Envelope[], ids = envelopes.map((_, i) => String(i + 1))) => {
    leaseId += 1;
    return lease.receiveBatch({
      version: "0", queue_epoch: "e1", incarnation: "i1", generation: "g1", lease_id: String(leaseId), kind: "root",
      credit_revision: "1",
      items: envelopes.map((envelope, i) => ({ queue_id: ids[i], attempt_id: `${ids[i]}.1`, delivery_seq: i + 1, class: "ordinary", byte_charge: 1, envelope })),
    });
  };
  const ops = (op: string) => sent.filter((p) => p.op === op);
  const creditToken = () => ops("credit").at(-1)?.native_turn_token as string;
  return { root, lease, sent, lines, sends, timers, offer, ops, creditToken, setIdle: (value: boolean) => { idle = value; } };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("ClaudeQueueRoot", () => {
  it("credits at readiness, sends the offer as turn T and disposes it observed at the prompt hook", async () => {
    const h = harness();
    h.root.checkReadiness();
    await settle();
    const token = h.creditToken();
    expect(token).toEqual(expect.any(String));
    h.offer([inbound("c1")]);
    await settle();
    expect(h.ops("begin_native")[0]).toMatchObject({ native_turn_token: token, queue_ids: ["1"] });
    expect(h.sends).toEqual([{ text: expect.stringContaining("conversation_id=c1"), token }]);
    expect(h.root.prepareInput(token)).toEqual({ text: h.sends[0]!.text, conversationIds: ["c1"] });
    h.root.promptAdmitted(token);
    await settle();
    expect(h.ops("dispose")).toEqual([expect.objectContaining({ items: [{ queue_id: "1", outcome: "observed", witness: "prompt_hook" }] })]);
    expect(h.root.prepareInput("other")).toBeUndefined();
  });

  it("requests no credit while busy, while a root is held, or while a credit is outstanding", async () => {
    const h = harness();
    h.setIdle(false);
    h.root.checkReadiness();
    await settle();
    expect(h.ops("credit")).toEqual([]);
    h.setIdle(true);
    h.root.checkReadiness();
    h.root.checkReadiness();
    await settle();
    expect(h.ops("credit")).toHaveLength(1);
    h.offer([inbound("c1")]);
    await settle();
    h.root.checkReadiness();
    await settle();
    expect(h.ops("credit")).toHaveLength(1);
    h.root.turnEnded(h.creditToken(), true);
    await settle();
    expect(h.ops("credit")).toHaveLength(2);
  });

  it("disposes a root turn that ended without a witness as unknown and logs the violation (r9 S1)", async () => {
    const h = harness();
    h.root.checkReadiness();
    await settle();
    const token = h.creditToken();
    h.offer([inbound("c1")]);
    await settle();
    h.root.turnEnded(token, true);
    await settle();
    expect(h.ops("dispose")).toEqual([expect.objectContaining({ items: [{ queue_id: "1", outcome: "unknown", reason: "root_turn_unwitnessed" }] })]);
    expect(h.lines.join("")).toContain("invariant violation");
  });

  it("a turn cancelled before it started is definitely unstarted", async () => {
    const h = harness();
    h.root.checkReadiness();
    await settle();
    const token = h.creditToken();
    h.offer([inbound("c1")]);
    await settle();
    h.root.turnEnded(token, false);
    await settle();
    expect(h.ops("dispose")[0]).toMatchObject({ items: [{ queue_id: "1", outcome: "definitely_unstarted", reason: "host_cancelled_before_start" }] });
  });

  it("a host that rejects the send before queueing makes the input definitely unstarted", async () => {
    const h = harness({ send: async () => { throw new Error("host closed"); } });
    h.root.checkReadiness();
    await settle();
    h.offer([inbound("c1")]);
    await settle();
    expect(h.ops("dispose")[0]).toMatchObject({ items: [{ queue_id: "1", outcome: "definitely_unstarted", reason: "host_rejected_before_start" }] });
  });

  it("a refused permit releases the items for a later offer", async () => {
    const h = harness({}, { begin_native: "queue_resume_required" });
    h.root.checkReadiness();
    await settle();
    h.offer([inbound("c1")]);
    await settle();
    expect(h.sends).toEqual([]);
    expect(h.ops("return")[0]).toMatchObject({ items: [{ queue_id: "1", reason: "turn_abandoned" }] });
  });

  it("an offer that no credit of this wrapper asked for is released", async () => {
    const h = harness();
    h.offer([inbound("c1")]);
    await settle();
    expect(h.ops("begin_native")).toEqual([]);
    expect(h.ops("return")[0]).toMatchObject({ items: [{ queue_id: "1", reason: "turn_abandoned" }] });
  });

  it("a rejoin forgets the outstanding credit and asks again", async () => {
    const h = harness();
    h.root.checkReadiness();
    await settle();
    h.root.rejoined();
    await settle();
    expect(h.ops("credit")).toHaveLength(2);
  });

  it("re-checks readiness after waiting for the link: a host that became busy gets no credit", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let idle = true;
    const h = harness({ ready: () => gate, isIdle: () => idle });
    h.root.checkReadiness();
    idle = false;
    open();
    await settle();
    expect(h.ops("credit")).toEqual([]);
  });

  it("asks for no second credit while one is outstanding", async () => {
    const h = harness();
    h.root.checkReadiness();
    await settle();
    h.root.checkReadiness();
    await settle();
    expect(h.ops("credit")).toHaveLength(1);
  });

  it("another turn starting withdraws the outstanding root credit", async () => {
    const h = harness();
    h.root.checkReadiness();
    await settle();
    h.root.turnStarted();
    await settle();
    expect(h.ops("withdraw")).toEqual([expect.objectContaining({ credit_revision: "1" })]);
    h.root.turnStarted();
    await settle();
    expect(h.ops("withdraw")).toHaveLength(1);
  });

  it("a credit reply that lands after another turn started is withdrawn", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const h = harness({}, {}, { credit: gate });
    h.root.checkReadiness();
    await settle();
    expect(h.ops("credit")).toHaveLength(1);
    h.root.turnStarted();
    open();
    await settle();
    expect(h.ops("withdraw")).toEqual([expect.objectContaining({ credit_revision: "1" })]);
  });

  it("a root offer that arrives while the host is busy is returned before classification", async () => {
    let classified = 0;
    const h = harness({ classify: async () => { classified++; return { consumed: false, inject: true, mode: "reply-owed" }; } });
    h.root.checkReadiness();
    await settle();
    h.setIdle(false);
    h.offer([inbound("c1")]);
    await settle();
    expect(classified).toBe(0);
    expect(h.ops("return")[0]).toMatchObject({ items: [{ queue_id: "1", reason: "credit_withdrawn" }] });
  });

  it("a root item consumed by a waiting tool is an invariant violation, disposed unknown", async () => {
    const h = harness({ classify: async () => ({ consumed: true, inject: false, mode: "reply-owed" }) });
    h.root.checkReadiness();
    await settle();
    h.offer([inbound("c1")]);
    await settle();
    expect(h.ops("dispose")[0]).toMatchObject({ items: [{ queue_id: "1", outcome: "unknown", reason: "consumed_outside_waiter" }] });
    expect(h.lines.join("")).toContain("invariant violation");
  });

  describe("an idle host without a root always has a credit coming (liveness)", () => {
    it.each(["queue_unavailable", "previous_root_pending", "transport"])(
      "retries a credit refused with %s after a backoff", async (reason) => {
        const refuse: Record<string, string> = { credit: reason };
        const h = harness({}, refuse);
        h.root.checkReadiness();
        await settle();
        expect(h.ops("credit")).toHaveLength(1);
        expect(h.timers.map((t) => t.ms)).toEqual([250]);
        h.timers[0]!.task();
        await settle();
        expect(h.timers.map((t) => t.ms)).toEqual([250, 500]);
        delete refuse.credit;
        h.timers[1]!.task();
        await settle();
        expect(h.ops("credit")).toHaveLength(3);
        h.offer([inbound("c1")]);
        await settle();
        expect(h.sends).toHaveLength(1);
      });

    it("starts the backoff over after a granted credit", async () => {
      const refuse: Record<string, string> = { credit: "queue_unavailable" };
      const h = harness({}, refuse);
      h.root.checkReadiness();
      await settle();
      delete refuse.credit;
      h.timers[0]!.task();
      await settle();
      refuse.credit = "queue_unavailable";
      h.root.rejoined();
      await settle();
      expect(h.timers.map((t) => t.ms)).toEqual([250, 250]);
    });

    it("re-checks a busy host with backoff, since busy may end without a turn end", async () => {
      const h = harness();
      h.setIdle(false);
      h.root.checkReadiness();
      await settle();
      expect(h.ops("credit")).toEqual([]);
      expect(h.timers.map((t) => t.ms)).toEqual([250]);
      h.setIdle(true);
      h.timers[0]!.task();
      await settle();
      expect(h.ops("credit")).toHaveLength(1);
    });

    it("logs a refusal streak at its start and once near the backoff cap", async () => {
      const h = harness({}, { credit: "stale_queue_epoch" });
      h.root.checkReadiness();
      await settle();
      for (let i = 0; i < 6; i++) {
        h.timers[i]!.task();
        await settle();
      }
      expect(h.ops("credit")).toHaveLength(7);
      expect(h.lines.filter((line) => line.includes("credit refused"))).toHaveLength(2);
    });

    it("logs a new refusal streak after a granted credit", async () => {
      const refuse: Record<string, string> = { credit: "queue_unavailable" };
      const h = harness({}, refuse);
      h.root.checkReadiness();
      await settle();
      h.timers[0]!.task();
      await settle();
      delete refuse.credit;
      h.timers[1]!.task();
      await settle();
      refuse.credit = "queue_unavailable";
      h.root.rejoined();
      await settle();
      expect(h.lines.filter((line) => line.includes("credit refused (1 in a row)"))).toHaveLength(2);
    });

    it("does not retry a credit refused because the queue is frozen", async () => {
      const h = harness({}, { credit: "queue_frozen" });
      h.root.checkReadiness();
      await settle();
      expect(h.timers).toEqual([]);
    });

    it("asks again when a root dropped by a new join leaves the host idle", async () => {
      let open!: () => void;
      const chain = new Promise<void>((resolve) => { open = resolve; });
      const h = harness({ enqueue: async (task) => { await chain; await task(); } });
      h.root.checkReadiness();
      await settle();
      h.offer([inbound("c1")]);
      await settle();
      expect(h.ops("begin_native")).toHaveLength(1);
      h.lease.join({
        inter_agent_queue: "credit-v1", inter_agent_queue_policy: policy,
        inter_agent_queue_epoch: "e1", inter_agent_queue_resume_required: false,
      }, "i1", "g2");
      h.root.rejoined();
      await settle();
      expect(h.ops("credit")).toHaveLength(1);
      open();
      await settle();
      expect(h.sends).toEqual([]);
      expect(h.ops("credit")).toHaveLength(2);
    });

    it("returns a permitted root unsent when the host turned busy before the send", async () => {
      let open!: () => void;
      const gate = new Promise<void>((resolve) => { open = resolve; });
      let classified = 0;
      const h = harness({
        classify: async () => { classified++; return { consumed: false, inject: true, mode: "reply-owed" }; },
      }, {}, { begin_native: gate });
      h.root.checkReadiness();
      await settle();
      h.offer([inbound("c1")]);
      await settle();
      h.setIdle(false);
      h.root.turnStarted();
      open();
      await settle();
      expect(h.sends).toEqual([]);
      expect(h.ops("return")).toEqual([expect.objectContaining({ items: [{ queue_id: "1", reason: "turn_abandoned" }] })]);
      h.setIdle(true);
      h.root.turnEnded("operator-turn", true);
      await settle();
      h.offer([inbound("c1")], ["1"]);
      await settle();
      expect(classified).toBe(1);
      expect(h.sends).toHaveLength(1);
    });
  });

  it("an offer that crossed the withdrawal is returned as credit_withdrawn", async () => {
    const h = harness();
    h.root.checkReadiness();
    await settle();
    h.root.turnStarted();
    h.offer([inbound("c1")]);
    await settle();
    expect(h.ops("return")).toEqual([expect.objectContaining({ items: [{ queue_id: "1", reason: "credit_withdrawn" }] })]);
    expect(h.lines.join("")).not.toContain("without a matching credit");
  });

  it("forgets an observed item's classification", async () => {
    let classified = 0;
    const h = harness({ classify: async () => { classified++; return { consumed: false, inject: true, mode: "reply-owed" }; } });
    h.root.checkReadiness();
    await settle();
    const token = h.creditToken();
    h.offer([inbound("c1")]);
    await settle();
    h.root.promptAdmitted(token);
    h.root.turnEnded(token, true);
    await settle();
    h.offer([inbound("c1")], ["1"]);
    await settle();
    expect(classified).toBe(2);
  });
});
