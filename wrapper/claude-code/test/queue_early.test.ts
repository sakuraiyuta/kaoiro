import { describe, expect, it } from "vitest";
import { QueueLease, type QueueOffer } from "@kaoiro/wrapper-core";
import { QueueInput, type Envelope, type QueueInputDeps } from "@kaoiro/agent-common";
import { CreditSlot } from "../src/queue_credit.js";
import { ClaudeQueueEarly, FOLD_RECEIPT_WAIT_MS, type QueueEarlyDeps } from "../src/queue_early.js";

const policy = { batch_max_items: 10, backlog_max_items: 100, backlog_max_bytes: 524_288 };
const counts = { queued: 0, offered: 0, native_pending: 0, waiter: 0, control: 0, charged_bytes: 0, policy };

function inbound(cid: string, turn = 1, granted = "early"): Envelope {
  return {
    version: "0", agent_id: "peer.agent", persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P",
    ts: "2026-10-04T00:00:00Z", type: "inter_agent_message", state: "idle",
    payload: {
      to: "self.agent", conversation_id: cid, turn_number: turn, kind: "inform", body: "hi",
      meta: { done: false, propose_next: "" }, delivery_authority: { requested: granted, granted },
    },
    ext: {},
  } as unknown as Envelope;
}

function reply(payload: Record<string, unknown>): unknown {
  const base = { op: payload.op, operation_id: payload.operation_id, queue: counts };
  switch (payload.op) {
    case "credit": return { ...base, credit_revision: String(payload.operation_id) };
    case "begin_native": return { ...base, permitted_queue_ids: payload.queue_ids };
    case "return": return { ...base, returned_ranges: [] };
    case "dispose": return { ...base, disposed: (payload.items as { queue_id: string }[]).map((i) => i.queue_id), resolved_ranges: [], returned_ranges: [] };
    case "withdraw": return { ...base, withdrawn: true };
    default: return { ...base };
  }
}

interface Pushed {
  text: (foldId: string) => string;
  envelopes: readonly Envelope[];
}

function harness(options: {
  deps?: Partial<QueueEarlyDeps>;
  classify?: QueueInputDeps["classify"];
  refuse?: Record<string, string>;
  gates?: Record<string, Promise<void>>;
} = {}) {
  const refuse = options.refuse ?? {};
  const gates = options.gates ?? {};
  const sent: Record<string, unknown>[] = [];
  const lines: string[] = [];
  const pushes: Pushed[] = [];
  const timers: Array<{ task: () => void; ms: number }> = [];
  const book: string[] = [];
  const state = { turn: "T" as string | null, canFold: true, foldsLeft: true, receipt: false, pushOk: true };
  let classified = 0;
  let early!: ClaudeQueueEarly;
  const lease = new QueueLease({
    transport: async (payload) => {
      sent.push(payload);
      await gates[payload.op as string];
      const reason = refuse[payload.op as string];
      if (reason !== undefined) throw { reason };
      return reply(payload);
    },
    onOffer: (offer: QueueOffer) => void early.onOffer(offer),
  });
  lease.join({
    inter_agent_queue: "credit-v1", inter_agent_queue_policy: policy,
    inter_agent_queue_epoch: "e1", inter_agent_queue_resume_required: false,
  }, "i1", "g1");
  const input = new QueueInput({
    classify: async (envelope) => {
      classified++;
      return options.classify ? options.classify(envelope) : { consumed: false, inject: true, mode: "reply-owed" };
    },
    reclassify: (_envelope, mode) => mode,
    sendNotice: () => {},
    tracked: () => true,
  });
  const slot = new CreditSlot();
  const tickets = { activated: 0, discarded: 0, activateOk: true };
  early = new ClaudeQueueEarly({
    input,
    slot,
    lease: () => lease,
    ready: async () => {},
    negotiated: () => true,
    activeTurn: () => state.turn,
    hasFoldsLeft: () => state.turn !== null && state.foldsLeft,
    canFold: () => state.turn !== null && state.canFold && state.foldsLeft && !state.receipt,
    receiptPending: () => state.receipt,
    waitForReceipt: async () => true,
    prepareTicket: () => ({
      authorizations: [{ reply_ticket: "ticket-1" }],
      activate: () => { tickets.activated++; return tickets.activateOk; },
      discard: () => { tickets.discarded++; },
    }),
    fits: () => true,
    push: (pushed) => { pushes.push(pushed); return state.pushOk; },
    folded: (turn) => book.push(`folded:${turn}`),
    adopted: (turn) => book.push(`adopted:${turn}`),
    unknown: (_envelopes, reason) => book.push(`unknown:${reason}`),
    log: (line) => lines.push(line),
    schedule: (task, ms) => { timers.push({ task, ms }); },
    ...options.deps,
  });
  let leaseId = 0;
  const offer = (envelope: Envelope, id = "1", kind: "early" | "root" = "early") => {
    leaseId += 1;
    return lease.receiveBatch({
      version: "0", queue_epoch: "e1", incarnation: "i1", generation: "g1", lease_id: String(leaseId), kind,
      credit_revision: "1",
      items: [{ queue_id: id, attempt_id: `${id}.${leaseId}`, delivery_seq: leaseId, class: "ordinary", byte_charge: 1, envelope }],
    });
  };
  const ops = (op: string) => sent.filter((p) => p.op === op);
  return {
    early, input, slot, lease, sent, lines, pushes, timers, book, state, tickets, offer, ops,
    classified: () => classified,
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("ClaudeQueueEarly", () => {
  it("credits under the running turn, folds the offer into it and disposes it observed at the fold hook", async () => {
    const h = harness();
    h.early.check();
    await settle();
    expect(h.ops("credit")).toEqual([expect.objectContaining({ kind: "early", mechanism: "fold", native_turn_token: "T" })]);
    h.offer(inbound("c1"));
    await settle();
    expect(h.ops("begin_native")[0]).toMatchObject({ native_turn_token: "T", queue_ids: ["1"] });
    expect(h.pushes).toHaveLength(1);
    const text = h.pushes[0]!.text("f".repeat(32));
    expect(text).toContain("Mid-turn peer delivery");
    expect(text).toContain("conversation_id=c1");
    expect(text).toContain("reply_authorization");
    expect(h.ops("credit")).toHaveLength(1);
    expect(h.early.pushedDecision({ kind: "fold", turnToken: "T", envelopes: h.pushes[0]!.envelopes })).toBe(true);
    await settle();
    expect(h.ops("dispose")).toEqual([expect.objectContaining({ items: [{ queue_id: "1", outcome: "observed", witness: "fold_hook" }] })]);
    expect(h.book).toEqual(["folded:T"]);
    expect(h.tickets.activated).toBe(1);
    expect(h.ops("credit")).toHaveLength(2);
  });

  it("folds a yield-granted item like an early one and reports no yield disposition until the yield path exists", async () => {
    const h = harness();
    h.early.check();
    await settle();
    h.offer(inbound("c1", 1, "yield"));
    await settle();
    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]!.text("f".repeat(32))).toContain("Mid-turn peer delivery");
  });

  it("disposes pushed input the SDK started as a root turn observed at the prompt hook", async () => {
    const h = harness();
    h.early.check();
    await settle();
    h.offer(inbound("c1"));
    await settle();
    h.early.pushedDecision({ kind: "root", turnToken: "U", envelopes: h.pushes[0]!.envelopes });
    await settle();
    expect(h.ops("dispose")[0]).toMatchObject({ items: [{ queue_id: "1", outcome: "observed", witness: "prompt_hook" }] });
    expect(h.book).toEqual(["adopted:U"]);
    expect(h.tickets.discarded).toBe(1);
  });

  it("disposes pushed input of unknown fate unknown with the host's reason", async () => {
    const h = harness();
    h.early.check();
    await settle();
    h.offer(inbound("c1"));
    await settle();
    h.early.pushedDecision({ kind: "unknown", reason: "stream_eof", envelopes: h.pushes[0]!.envelopes });
    await settle();
    expect(h.ops("dispose")[0]).toMatchObject({ items: [{ queue_id: "1", outcome: "unknown", reason: "stream_eof" }] });
    expect(h.book).toEqual(["unknown:stream_eof"]);
  });

  it("a fold the hook saw is observed even when its reply authorization lapsed", async () => {
    const h = harness();
    h.tickets.activateOk = false;
    h.early.check();
    await settle();
    h.offer(inbound("c1"));
    await settle();
    h.early.pushedDecision({ kind: "fold", turnToken: "T", envelopes: h.pushes[0]!.envelopes });
    await settle();
    expect(h.ops("dispose")[0]).toMatchObject({ items: [{ queue_id: "1", outcome: "observed", witness: "fold_hook" }] });
    expect(h.book).toEqual([]);
    expect(h.lines.join("")).toContain("without its reply authorization");
  });

  it("ignores a decision for input it did not push", () => {
    const h = harness();
    expect(h.early.pushedDecision({ kind: "fold", turnToken: "T", envelopes: [] })).toBe(false);
  });

  describe("declines return the item with its typed reason", () => {
    it("an offer whose credit is not for the running turn", async () => {
      const h = harness();
      h.offer(inbound("c1"));
      await settle();
      expect(h.ops("return")[0]).toMatchObject({ items: [{ queue_id: "1", reason: "early_ineligible", sub_reason: "fold_unavailable" }] });
      expect(h.classified()).toBe(0);
    });

    it("a turn that cannot fold and has no pushed input pending", async () => {
      const h = harness();
      h.early.check();
      await settle();
      h.state.canFold = false;
      h.offer(inbound("c1"));
      await settle();
      expect(h.ops("return")[0]).toMatchObject({ items: [{ queue_id: "1", sub_reason: "fold_unavailable" }] });
      expect(h.classified()).toBe(0);
    });

    it("waits a bounded time for another pushed input's decision, then folds", async () => {
      const waits: number[] = [];
      let h!: ReturnType<typeof harness>;
      h = harness({ deps: { waitForReceipt: async (_turn, ms) => { waits.push(ms); h.state.receipt = false; return true; } } });
      h.early.check();
      await settle();
      h.state.receipt = true;
      h.offer(inbound("c1"));
      await settle();
      expect(waits).toEqual([FOLD_RECEIPT_WAIT_MS]);
      expect(h.pushes).toHaveLength(1);
      expect(h.ops("return")).toEqual([]);
    });

    it("declines when the pushed input is still undecided after the wait", async () => {
      const h = harness({ deps: { waitForReceipt: async () => false } });
      h.early.check();
      await settle();
      h.state.receipt = true;
      h.offer(inbound("c1"));
      await settle();
      expect(h.ops("return")[0]).toMatchObject({ items: [{ queue_id: "1", sub_reason: "fold_unavailable" }] });
    });

    it("B7: the fold window closed while the permit was in flight", async () => {
      let open!: () => void;
      const gate = new Promise<void>((resolve) => { open = resolve; });
      const h = harness({ gates: { begin_native: gate } });
      h.early.check();
      await settle();
      h.offer(inbound("c1"));
      await settle();
      h.state.turn = null;
      open();
      await settle();
      expect(h.pushes).toEqual([]);
      expect(h.ops("return")[0]).toMatchObject({ items: [{ queue_id: "1", reason: "early_ineligible", sub_reason: "fold_unavailable" }] });
    });

    it("no fold ticket for the turn", async () => {
      const h = harness({ deps: { prepareTicket: () => undefined } });
      h.early.check();
      await settle();
      h.offer(inbound("c1"));
      await settle();
      expect(h.ops("return")[0]).toMatchObject({ items: [{ queue_id: "1", sub_reason: "conversation_pending" }] });
    });

    it("an input too large to push", async () => {
      const h = harness({ deps: { fits: () => false } });
      h.early.check();
      await settle();
      h.offer(inbound("c1"));
      await settle();
      expect(h.ops("return")[0]).toMatchObject({ items: [{ queue_id: "1", sub_reason: "oversize" }] });
      expect(h.tickets.discarded).toBe(1);
      expect(h.pushes).toEqual([]);
    });
  });

  it("a push the host refused is definitely unstarted", async () => {
    const h = harness();
    h.state.pushOk = false;
    h.early.check();
    await settle();
    h.offer(inbound("c1"));
    await settle();
    expect(h.ops("dispose")[0]).toMatchObject({ items: [{ queue_id: "1", outcome: "definitely_unstarted", reason: "fold_refused" }] });
    expect(h.tickets.discarded).toBe(1);
  });

  it("a declined item comes back in a root batch classified once (shared classifier)", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const h = harness({ gates: { begin_native: gate } });
    h.early.check();
    await settle();
    h.offer(inbound("c1"));
    await settle();
    h.state.canFold = false;
    open();
    await settle();
    expect(h.ops("return")).toHaveLength(1);
    const prepared = await h.input.prepare({
      leaseId: "x", kind: "root", items: [{ queueId: "1", deliverySeq: 9, class: "ordinary", envelope: inbound("c1") as never }],
      begin: async () => null, release: () => {}, return: async () => ({ ok: true }) as never, dispose: async () => ({ ok: true }) as never,
    });
    expect(prepared.injected).toHaveLength(1);
    expect(h.classified()).toBe(1);
  });

  describe("liveness: a running turn that can fold has early credit coming", () => {
    it("re-checks with backoff while the turn cannot fold yet", async () => {
      const h = harness();
      h.state.canFold = false;
      h.early.check();
      await settle();
      expect(h.ops("credit")).toEqual([]);
      expect(h.timers.map((t) => t.ms)).toEqual([250]);
      h.state.canFold = true;
      h.timers[0]!.task();
      await settle();
      expect(h.ops("credit")).toHaveLength(1);
    });

    it("stops when the turn has no folds left or is not a fold-capable turn", async () => {
      const h = harness();
      h.state.foldsLeft = false;
      h.early.check();
      await settle();
      expect(h.ops("credit")).toEqual([]);
      expect(h.timers).toEqual([]);
    });

    it("schedules no re-check while its own push awaits the host's decision", async () => {
      const h = harness();
      h.early.check();
      await settle();
      h.offer(inbound("c1"));
      await settle();
      expect(h.pushes).toHaveLength(1);
      h.state.receipt = true;
      h.early.check();
      await settle();
      expect(h.timers).toEqual([]);
    });

    it("retries a refused credit, but not one refused because the queue is frozen", async () => {
      const refuse: Record<string, string> = { credit: "queue_unavailable" };
      const h = harness({ refuse });
      h.early.check();
      await settle();
      expect(h.timers.map((t) => t.ms)).toEqual([250]);
      delete refuse.credit;
      h.timers[0]!.task();
      await settle();
      expect(h.ops("credit")).toHaveLength(2);
      const frozen = harness({ refuse: { credit: "queue_frozen" } });
      frozen.early.check();
      await settle();
      expect(frozen.timers).toEqual([]);
    });

    it("asks again after a settlement that used up the credit", async () => {
      const h = harness({ classify: async () => ({ consumed: false, inject: false, mode: "terminal" }) });
      h.early.check();
      await settle();
      h.offer(inbound("c1"));
      await settle();
      expect(h.ops("dispose")[0]).toMatchObject({ items: [{ queue_id: "1", outcome: "intentional_non_injection" }] });
      expect(h.ops("credit")).toHaveLength(2);
    });

    it("asks for no second credit while one is outstanding or an offer is held", async () => {
      let open!: () => void;
      const gate = new Promise<void>((resolve) => { open = resolve; });
      const h = harness({ gates: { begin_native: gate } });
      h.early.check();
      h.early.check();
      await settle();
      expect(h.ops("credit")).toHaveLength(1);
      h.offer(inbound("c1"));
      await settle();
      h.early.check();
      await settle();
      expect(h.ops("credit")).toHaveLength(1);
      open();
      await settle();
      expect(h.pushes).toHaveLength(1);
      h.early.check();
      await settle();
      expect(h.ops("credit")).toHaveLength(1);
    });

    it("withdraws the early credit at the turn end and asks for none afterwards", async () => {
      const h = harness();
      h.early.check();
      await settle();
      h.state.turn = null;
      h.early.turnEnded("T");
      await settle();
      expect(h.ops("withdraw")).toHaveLength(1);
      expect(h.slot.token("early")).toBeNull();
      h.early.check();
      await settle();
      expect(h.ops("credit")).toHaveLength(1);
    });

    it("a turn end leaves another turn's credit alone", async () => {
      const h = harness();
      h.early.check();
      await settle();
      h.early.turnEnded("other");
      expect(h.slot.token("early")).toBe("T");
    });
  });

  describe("an item a waiting tool consumed", () => {
    const consumed: QueueInputDeps["classify"] = async () => ({ consumed: true, inject: false, mode: "reply-owed" });

    it("is observed at the tool-result handoff after its permit", async () => {
      const h = harness({ classify: consumed });
      h.early.check();
      await settle();
      h.offer(inbound("c1"));
      await settle();
      expect(h.ops("begin_native")).toHaveLength(1);
      expect(h.ops("dispose")).toEqual([]);
      h.input.noteHandoff([inbound("c1")]);
      h.early.handoff();
      await settle();
      expect(h.ops("dispose")[0]).toMatchObject({ items: [{ queue_id: "1", outcome: "observed", witness: "tool_result" }] });
    });

    it("is observed when the handoff came before the permit", async () => {
      let open!: () => void;
      const gate = new Promise<void>((resolve) => { open = resolve; });
      const h = harness({ classify: consumed, gates: { begin_native: gate } });
      h.early.check();
      await settle();
      h.offer(inbound("c1"));
      await settle();
      h.input.noteHandoff([inbound("c1")]);
      h.early.handoff();
      open();
      await settle();
      expect(h.ops("dispose")[0]).toMatchObject({ items: [{ queue_id: "1", outcome: "observed", witness: "tool_result" }] });
    });

    it("is unknown when the turn ends without a handoff", async () => {
      const h = harness({ classify: consumed });
      h.early.check();
      await settle();
      h.offer(inbound("c1"));
      await settle();
      h.early.turnEnded("T");
      await settle();
      expect(h.ops("dispose")[0]).toMatchObject({ items: [{ queue_id: "1", outcome: "unknown", reason: "consumed_unhandled" }] });
    });
  });
});
