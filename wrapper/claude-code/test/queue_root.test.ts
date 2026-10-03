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

function harness(overrides: Partial<QueueRootDeps> = {}, refuse: Record<string, string> = {}) {
  const sent: Record<string, unknown>[] = [];
  const lines: string[] = [];
  const sends: Array<{ text: string; token: string }> = [];
  let idle = true;
  let root!: ClaudeQueueRoot;
  const lease = new QueueLease({
    transport: async (payload) => {
      sent.push(payload);
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
    log: (line) => lines.push(line),
    defer: (task) => task(),
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
  return { root, lease, sent, lines, sends, offer, ops, creditToken, setIdle: (value: boolean) => { idle = value; } };
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

  it("a reply a waiting tool consumed is observed at its tool-result handoff, or unknown once the host is idle", async () => {
    const consumedEnvelope = inbound("c-wait");
    const h = harness({
      classify: async (envelope) => envelope === consumedEnvelope
        ? { consumed: true, inject: false, mode: "reply-owed" }
        : { consumed: false, inject: true, mode: "reply-owed" },
    });
    h.root.checkReadiness();
    await settle();
    h.offer([consumedEnvelope]);
    await settle();
    expect(h.ops("begin_native")[0]).toMatchObject({ queue_ids: ["1"] });
    expect(h.sends).toEqual([]);
    h.root.inputHandoff([consumedEnvelope]);
    await settle();
    expect(h.ops("dispose")[0]).toMatchObject({ items: [{ queue_id: "1", outcome: "observed", witness: "tool_result" }] });

    const lost = inbound("c-lost");
    const h2 = harness({ classify: async () => ({ consumed: true, inject: false, mode: "reply-owed" }) });
    h2.root.checkReadiness();
    await settle();
    h2.offer([lost]);
    await settle();
    h2.root.checkReadiness();
    await settle();
    expect(h2.ops("dispose")[0]).toMatchObject({ items: [{ queue_id: "1", outcome: "unknown", reason: "waiter_result_not_observed" }] });
  });

  it("a rejoin forgets the outstanding credit and asks again", async () => {
    const h = harness();
    h.root.checkReadiness();
    await settle();
    h.root.rejoined();
    await settle();
    expect(h.ops("credit")).toHaveLength(2);
  });

  it("does not sweep a consumed reply while a turn runs or a root is held", async () => {
    const waiting = inbound("c-wait");
    const h = harness({
      classify: async (envelope) => envelope === waiting
        ? { consumed: true, inject: false, mode: "reply-owed" }
        : { consumed: false, inject: true, mode: "reply-owed" },
    });
    h.root.checkReadiness();
    await settle();
    // One offer: a reply a waiting tool takes, and a root input held as T.
    h.offer([waiting, inbound("c-root")]);
    await settle();
    expect(h.sends).toHaveLength(1);
    h.root.checkReadiness();
    await settle();
    expect(h.ops("dispose")).toEqual([]);

    // The next turn is already running when this one ends.
    h.setIdle(false);
    h.root.turnEnded(h.creditToken(), true);
    await settle();
    expect(h.ops("dispose").filter((p) => (p.items as { reason?: string }[])[0]!.reason === "waiter_result_not_observed")).toEqual([]);
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
});

