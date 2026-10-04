import { describe, expect, it } from "vitest";
import { QueueLease, type QueueOffer } from "@kaoiro/wrapper-core";
import { QueueInput, type Envelope, type QueueInputDeps } from "@kaoiro/agent-common";
import { CreditSlot } from "../src/queue_credit.js";
import { ClaudeQueueEarly, FOLD_RECEIPT_WAIT_MS, type QueueEarlyDeps } from "../src/queue_early.js";

const policy = { batch_max_items: 10, backlog_max_items: 100, backlog_max_bytes: 524_288 };
const counts = { queued: 0, offered: 0, native_pending: 0, waiter: 0, control: 0, charged_bytes: 0, policy };

function inbound(cid: string, turn = 1, granted = "early"): Envelope {
  const yieldFields = granted === "yield" ? { yield_token: "yt", work_id: "w1", authority_epoch: 1 } : {};
  return {
    version: "0", agent_id: "peer.agent", persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P",
    ts: "2026-10-04T00:00:00Z", type: "inter_agent_message", state: "idle",
    payload: {
      to: "self.agent", conversation_id: cid, turn_number: turn, kind: "inform", body: "hi",
      meta: { done: false, propose_next: "" }, delivery_authority: { requested: granted, granted, ...yieldFields },
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
  const inputTimers: Array<{ task: () => void; ms: number }> = [];
  const book: string[] = [];
  const state = { turn: "T" as string | null, canFold: true, foldsLeft: true, receipt: false, pushOk: true };
  const yieldState = {
    negotiated: false, eligibility: null as string | null, overtake: true, matches: true, fitsCut: true,
    claim: { granted: true } as { granted: boolean; reason?: string }, cutOk: true,
    onClaim: undefined as (() => void) | undefined,
    captured: true,
  };
  const yields: Array<{ seq: number; outcome: string; reason?: string }> = [];
  const order: string[] = [];
  const cuts: Pushed[] = [];
  let classified = 0;
  let early!: ClaudeQueueEarly;
  const lease = new QueueLease({
    transport: async (payload) => {
      sent.push(payload);
      order.push(payload.op as string);
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
    schedule: (task, ms) => { inputTimers.push({ task, ms }); return () => {}; },
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
    fits: (text) => yieldState.fitsCut || !text.startsWith("[Director yield"),
    push: (pushed) => { pushes.push(pushed); return state.pushOk; },
    folded: (turn) => book.push(`folded:${turn}`),
    adopted: (turn) => book.push(`adopted:${turn}`),
    unknown: (_envelopes, reason) => book.push(`unknown:${reason}`),
    yieldNegotiated: () => yieldState.negotiated,
    yield: {
      eligibility: () => yieldState.eligibility,
      canOvertake: () => yieldState.overtake,
      capture: () => (yieldState.captured ? { context: true } : null),
      matches: () => yieldState.matches && state.turn === "T",
      canPush: () => state.turn !== null && !state.receipt,
      claim: async () => { order.push("claim"); yieldState.onClaim?.(); return yieldState.claim; },
      push: (pushed) => { cuts.push(pushed); return yieldState.cutOk; },
      receiptTimeoutMs: 2_000,
      now: () => 0,
    },
    reportYield: (seq, disposition) => yields.push({ seq, ...disposition }),
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
    yieldState, yields, order, cuts, inputTimers,
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

  it("folds a yield-granted item like an early one when yield is not negotiated, with no yield disposition", async () => {
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

    it("is not begun by the early path; it waits for its tool and asks for credit again", async () => {
      const h = harness({ classify: consumed });
      h.early.check();
      await settle();
      h.offer(inbound("c1"));
      await settle();
      expect(h.ops("begin_native")).toEqual([]);
      expect(h.pushes).toEqual([]);
      expect(h.ops("credit")).toHaveLength(2);
    });

    it("is permitted under its tool's turn and observed at the tool-result return", async () => {
      const h = harness({ classify: consumed });
      h.early.check();
      await settle();
      h.offer(inbound("c1"));
      await settle();
      const lease = await h.input.handoff([inbound("c1")], "tool-turn");
      expect(h.ops("begin_native")[0]).toMatchObject({ queue_ids: ["1"], native_turn_token: "tool-turn" });
      lease!.commit();
      await settle();
      expect(h.ops("dispose")[0]).toMatchObject({ items: [{ queue_id: "1", outcome: "observed", witness: "tool_result" }] });
    });

    it("goes back as W when the tool result is not returned", async () => {
      const h = harness({ classify: consumed });
      h.early.check();
      await settle();
      h.offer(inbound("c1"));
      await settle();
      const lease = await h.input.handoff([inbound("c1")], "tool-turn");
      lease!.rollback();
      await settle();
      expect(h.ops("return")[0]).toMatchObject({ items: [{ queue_id: "1", reason: "waiter_abandoned" }] });
      // Nothing reached the model: offered again, it is injected.
      const again = await h.input.prepare({
        leaseId: "x", kind: "root", items: [{ queueId: "1", deliverySeq: 9, class: "waiter", envelope: inbound("c1") as never }],
        begin: async () => null, release: () => {}, return: async () => ({ ok: true }) as never, dispose: async () => ({ ok: true }) as never,
      });
      expect(again.injected).toHaveLength(1);
      expect(again.consumed).toEqual([]);
    });

    it("goes back to be injected when no tool asks for it in time", async () => {
      const h = harness({ classify: consumed });
      h.early.check();
      await settle();
      h.offer(inbound("c1"));
      await settle();
      h.inputTimers[0]!.task();
      await settle();
      expect(h.ops("return")[0]).toMatchObject({ items: [{ queue_id: "1", reason: "turn_abandoned" }] });
      expect(await h.input.handoff([inbound("c1")], "tool-turn")).toBeUndefined();
    });
  });

  it("releases an offer whose classification threw, so it cannot hold the lease slot", async () => {
    const h = harness({ classify: async () => { throw new Error("classifier down"); } });
    h.early.check();
    await settle();
    h.offer(inbound("c1"));
    await settle();
    expect(h.ops("return")[0]).toMatchObject({ items: [{ queue_id: "1", reason: "turn_abandoned" }] });
    expect(h.lines.join("")).toContain("queue early offer failed");
  });

  it("asks no credit for a turn that ended while it waited for the link", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const h = harness({ deps: { ready: () => gate } });
    h.early.check();
    h.state.turn = "T2";
    h.early.turnEnded("T");
    open();
    await settle();
    expect(h.ops("credit")).toEqual([]);
    h.early.check();
    await settle();
    expect(h.ops("credit")).toEqual([expect.objectContaining({ native_turn_token: "T2" })]);
  });

  it("starts the backoff over for a new turn", async () => {
    const h = harness({ refuse: { credit: "queue_unavailable" } });
    h.early.check();
    await settle();
    h.timers[0]!.task();
    await settle();
    expect(h.timers.map((t) => t.ms)).toEqual([250, 500]);
    h.state.turn = "T2";
    h.timers[1]!.task();
    await settle();
    expect(h.timers.map((t) => t.ms)).toEqual([250, 500, 250]);
  });

  describe("yield-granted items (yield negotiated)", () => {
    const ready = async (setup?: (h: ReturnType<typeof harness>) => void) => {
      const h = harness();
      h.yieldState.negotiated = true;
      setup?.(h);
      h.early.check();
      await settle();
      h.offer(inbound("c1", 1, "yield"));
      await settle();
      return h;
    };

    it("cuts the item into the turn after the permit and the claim, and reports cut once", async () => {
      const h = await ready();
      expect(h.order.filter((op) => op === "begin_native" || op === "claim")).toEqual(["begin_native", "claim"]);
      expect(h.cuts).toHaveLength(1);
      expect(h.cuts[0]!.text("f".repeat(32))).toContain("[Director yield after the running tool]");
      expect(h.pushes).toEqual([]);
      expect(h.yields).toEqual([{ seq: 1, outcome: "cut" }]);
      h.early.pushedDecision({ kind: "fold", turnToken: "T", envelopes: h.cuts[0]!.envelopes });
      await settle();
      expect(h.ops("dispose")[0]).toMatchObject({ items: [{ queue_id: "1", outcome: "observed", witness: "fold_hook" }] });
    });

    it("a refused claim is downgraded with its reason and folded under the same permit", async () => {
      const h = await ready((h) => { h.yieldState.claim = { granted: false, reason: "work_closed" }; });
      expect(h.yields).toEqual([{ seq: 1, outcome: "downgraded", reason: "work_closed" }]);
      expect(h.ops("begin_native")).toHaveLength(1);
      expect(h.pushes).toHaveLength(1);
      expect(h.cuts).toEqual([]);
    });

    it("an ineligible turn is downgraded before any claim and folded", async () => {
      const h = await ready((h) => { h.yieldState.eligibility = "mixed_turn"; });
      expect(h.yields).toEqual([{ seq: 1, outcome: "downgraded", reason: "mixed_turn" }]);
      expect(h.order).not.toContain("claim");
      expect(h.pushes).toHaveLength(1);
    });

    it("an exhausted overtake budget is downgraded and folded", async () => {
      const h = await ready((h) => { h.yieldState.overtake = false; });
      expect(h.yields).toEqual([{ seq: 1, outcome: "downgraded", reason: "overtake_budget" }]);
      expect(h.pushes).toHaveLength(1);
    });

    it("a grant without its yield fields is downgraded grant_changed and folded", async () => {
      const h = harness();
      h.yieldState.negotiated = true;
      h.early.check();
      await settle();
      const envelope = inbound("c1", 1, "yield");
      delete (envelope.payload as { delivery_authority: Record<string, unknown> }).delivery_authority.yield_token;
      h.offer(envelope);
      await settle();
      expect(h.yields).toEqual([{ seq: 1, outcome: "downgraded", reason: "grant_changed" }]);
      expect(h.order).not.toContain("claim");
      expect(h.pushes).toHaveLength(1);
    });

    it("a turn whose live input context cannot be captured is downgraded and folded", async () => {
      const h = await ready((h) => { h.yieldState.captured = false; });
      expect(h.yields).toEqual([{ seq: 1, outcome: "downgraded", reason: "eligibility_changed" }]);
      expect(h.order).not.toContain("claim");
      expect(h.pushes).toHaveLength(1);
    });

    it("a cut text too large is downgraded and returned, not folded", async () => {
      const h = await ready((h) => { h.yieldState.fitsCut = false; });
      expect(h.yields).toEqual([{ seq: 1, outcome: "downgraded", reason: "oversized_input" }]);
      expect(h.ops("begin_native")).toEqual([]);
      expect(h.ops("return")[0]).toMatchObject({ items: [{ queue_id: "1", sub_reason: "oversize" }] });
    });

    it("a refused permit is downgraded and spends no claim", async () => {
      const h = harness({ refuse: { begin_native: "queue_resume_required" } });
      h.yieldState.negotiated = true;
      h.early.check();
      await settle();
      h.offer(inbound("c1", 1, "yield"));
      await settle();
      expect(h.yields).toEqual([{ seq: 1, outcome: "downgraded", reason: "eligibility_changed" }]);
      expect(h.order).not.toContain("claim");
    });

    it("a receipt still undecided at the bound is downgraded receipt_wait_timeout", async () => {
      const h = harness({ deps: { waitForReceipt: async () => false } });
      h.yieldState.negotiated = true;
      // Another pushed input became pending while the claim was in flight.
      h.yieldState.onClaim = () => { h.state.receipt = true; };
      h.early.check();
      await settle();
      h.offer(inbound("c1", 1, "yield"));
      await settle();
      expect(h.yields).toEqual([{ seq: 1, outcome: "downgraded", reason: "receipt_wait_timeout" }]);
      expect(h.cuts).toEqual([]);
      expect(h.ops("return")[0]).toMatchObject({ items: [{ queue_id: "1", sub_reason: "fold_unavailable" }] });
    });

    it("a turn that ended during the claim is downgraded, and the fold path declines", async () => {
      const h = await ready((h) => { h.yieldState.onClaim = () => { h.state.turn = null; }; });
      expect(h.yields).toEqual([{ seq: 1, outcome: "downgraded", reason: "eligibility_changed" }]);
      expect(h.cuts).toEqual([]);
      expect(h.ops("return")[0]).toMatchObject({ items: [{ queue_id: "1", sub_reason: "fold_unavailable" }] });
    });

    it("a live input context that changed during the claim is downgraded, not cut", async () => {
      // Same turn, but its session or query changed while the claim was in flight.
      const h = await ready((h) => { h.yieldState.onClaim = () => { h.yieldState.matches = false; }; });
      expect(h.yields).toEqual([{ seq: 1, outcome: "downgraded", reason: "eligibility_changed" }]);
      expect(h.cuts).toEqual([]);
      expect(h.pushes).toHaveLength(1);
    });

    it("a cut the host refused is downgraded and definitely unstarted", async () => {
      const h = await ready((h) => { h.yieldState.cutOk = false; });
      expect(h.yields).toEqual([{ seq: 1, outcome: "downgraded", reason: "eligibility_changed" }]);
      expect(h.ops("dispose")[0]).toMatchObject({ items: [{ queue_id: "1", outcome: "definitely_unstarted", reason: "cut_refused" }] });
    });

    it("an item whose yield was decided is folded when offered again, with no second report", async () => {
      const h = await ready((h) => {
        h.yieldState.claim = { granted: false, reason: "work_closed" };
        h.yieldState.onClaim = () => { h.state.canFold = false; };
      });
      expect(h.ops("return")).toHaveLength(1);
      h.state.canFold = true;
      h.yieldState.claim = { granted: true };
      h.early.check();
      await settle();
      h.offer(inbound("c1", 1, "yield"), "1");
      await settle();
      expect(h.pushes).toHaveLength(1);
      expect(h.cuts).toEqual([]);
      expect(h.yields).toEqual([{ seq: 1, outcome: "downgraded", reason: "work_closed" }]);
    });
  });
});
