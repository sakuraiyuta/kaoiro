import { describe, expect, it, vi } from "vitest";
import type { QueueOffer, QueueOfferItem } from "@kaoiro/wrapper-core";
import { InterAgentTool, formatInboundMessages } from "../src/inter_agent.js";
import { QUEUE_INPUT_FORMAT_BUDGET, QueueInput } from "../src/queue_input.js";
import type { Envelope } from "../src/types.js";

const PERSONA = { id: "mio", name: "澪", sprite_set: "mio" };

function inbound(conversationId: string, turn = 2, body = "hello", done = false): Envelope {
  return {
    version: "0",
    agent_id: "peer.agent",
    persona: PERSONA,
    display_name: PERSONA.name,
    ts: "2026-10-04T00:00:00Z",
    type: "inter_agent_message",
    state: "tool_running",
    payload: {
      to: "self.agent",
      conversation_id: conversationId,
      turn_number: turn,
      kind: "inform",
      body,
      meta: { done, propose_next: "" },
      owner: { kind: "user", id: "operator" },
    },
    ext: {},
  } as Envelope;
}

/** A recorded offer: return and dispose resolve at once. */
function offerOf(envelopes: Envelope[], ids = envelopes.map((_, index) => String(index + 1))) {
  const returned: unknown[] = [];
  const disposed: unknown[] = [];
  const items: QueueOfferItem[] = envelopes.map((envelope, index) => ({
    queueId: ids[index]!, deliverySeq: index + 1, class: "ordinary", envelope: envelope as QueueOfferItem["envelope"],
  }));
  const offer: QueueOffer = {
    leaseId: "1",
    kind: "root",
    items,
    begin: async () => null,
    release: () => {},
    return: async (entries) => { returned.push(...entries); return { ok: true }; },
    dispose: async (entries) => { disposed.push(...entries); return { ok: true }; },
  };
  return { offer, returned, disposed };
}

function harness() {
  const notices: Envelope[] = [];
  const tool = new InterAgentTool({
    config: { agent_id: "self.agent", persona: PERSONA, display_name: PERSONA.name, server_url: "ws://x" },
    getState: () => "idle",
    getActiveInterAgentTurnToken: () => "turn",
    send: (envelope) => notices.push(envelope),
    now: () => "2026-10-04T00:00:00Z",
    newId: () => "cnv-new",
  });
  const input = new QueueInput({
    classify: (envelope) => tool.receiveInbound(envelope),
    reclassify: (envelope, mode) => tool.queuedInboundMode(envelope, mode),
    sendNotice: (notice) => notices.push(notice),
    tracked: (conversationId) => tool.hasConversationTrack(conversationId),
  });
  return { input, notices, tool };
}

describe("QueueInput", () => {
  it("formats the offered items into one native input in offer order", async () => {
    const { input } = harness();
    const envelopes = [inbound("c1"), inbound("c2")];
    const { offer, returned, disposed } = offerOf(envelopes);
    const prepared = await input.prepare(offer);
    expect(prepared.injected.map(({ item }) => item.queueId)).toEqual(["1", "2"]);
    expect(prepared.text).toBe(formatInboundMessages(envelopes.map((envelope) => ({ envelope, mode: "reply-owed" }))));
    expect([returned, disposed]).toEqual([[], []]);
  });

  it("classifies an item once: a re-offer after a return is injected again, not dropped as stale", async () => {
    const { input } = harness();
    const first = offerOf([inbound("c1")]);
    expect((await input.prepare(first.offer)).injected).toHaveLength(1);
    const again = offerOf([inbound("c1")]);
    const prepared = await input.prepare(again.offer);
    expect(prepared.injected).toHaveLength(1);
    expect(again.disposed).toEqual([]);
  });

  it("classifies again when a queue id comes back with a different message", async () => {
    const { input } = harness();
    await input.prepare(offerOf([inbound("c1", 3)]).offer);
    // Same queue id, an older turn of the same conversation: a fresh
    // classification reads it as stale; the remembered one must not apply.
    const reused = offerOf([inbound("c1", 2)]);
    expect((await input.prepare(reused.offer)).injected).toEqual([]);
    expect(reused.disposed).toEqual([{ queue_id: "1", outcome: "intentional_non_injection", reason: "stale_skip" }]);
  });

  it("returns the suffix past the formatted budget; a large first item is a singleton", async () => {
    const { input } = harness();
    const pad = (n: number) => "x".repeat(n);
    // Two items whose formatted text is exactly the budget, then one more.
    const base = Buffer.byteLength(formatInboundMessages([
      { envelope: inbound("c1", 2, ""), mode: "reply-owed" },
      { envelope: inbound("c2", 2, ""), mode: "reply-owed" },
    ]), "utf8");
    const fill = QUEUE_INPUT_FORMAT_BUDGET - base;
    const fits = [inbound("c1", 2, pad(fill)), inbound("c2", 2, ""), inbound("c3", 2, "")];
    const atBudget = offerOf(fits);
    const prepared = await input.prepare(atBudget.offer);
    expect(Buffer.byteLength(prepared.text, "utf8")).toBe(QUEUE_INPUT_FORMAT_BUDGET);
    expect(prepared.injected.map(({ item }) => item.queueId)).toEqual(["1", "2"]);
    expect(atBudget.returned).toEqual([{ queue_id: "3", reason: "format_budget" }]);

    const { input: other } = harness();
    const over = offerOf([inbound("c1", 2, pad(fill + 1)), inbound("c2", 2, "")]);
    const one = await other.prepare(over.offer);
    expect(one.injected.map(({ item }) => item.queueId)).toEqual(["1"]);
    expect(over.returned).toEqual([{ queue_id: "2", reason: "format_budget" }]);

    const huge = offerOf([inbound("c1", 2, pad(QUEUE_INPUT_FORMAT_BUDGET * 2))]);
    const alone = await harness().input.prepare(huge.offer);
    expect(alone.injected).toHaveLength(1);
    expect(Buffer.byteLength(alone.text, "utf8")).toBeGreaterThan(QUEUE_INPUT_FORMAT_BUDGET);
  });

  it("disposes a stale item without injecting it and sends its notice", async () => {
    const { input, notices } = harness();
    await input.prepare(offerOf([inbound("c1", 3)], ["1"]).offer);
    const stale = offerOf([inbound("c1", 3)], ["2"]);
    const prepared = await input.prepare(stale.offer);
    expect(prepared.injected).toEqual([]);
    expect(prepared.text).toBe("");
    expect(stale.disposed).toEqual([{ queue_id: "2", outcome: "intentional_non_injection", reason: "stale_skip" }]);
    expect(notices).toHaveLength(1);
  });

  it("forgets a skipped item once its disposal is settled", async () => {
    const { input, tool } = harness();
    const classify = vi.spyOn(tool, "receiveInbound");
    await input.prepare(offerOf([inbound("c1", 3)], ["1"]).offer);
    await input.prepare(offerOf([inbound("c1", 3)], ["2"]).offer);
    await new Promise((resolve) => setImmediate(resolve));
    await input.prepare(offerOf([inbound("c1", 3)], ["2"]).offer);
    expect(classify).toHaveBeenCalledTimes(3);
  });

  it("partitions terminal and consumed items; a re-offered item whose conversation closed is terminal", async () => {
    const answers = [
      { consumed: false, inject: false, mode: "terminal" },
      { consumed: true, inject: false, mode: "reply-owed" },
      { consumed: false, inject: true, mode: "reply-owed" },
    ] as const;
    let reclassified: "reply-owed" | "terminal" = "reply-owed";
    let next = 0;
    const input = new QueueInput({
      classify: async () => answers[next++]!,
      reclassify: () => reclassified,
      sendNotice: () => {},
      tracked: () => true,
    });
    const offer = offerOf([inbound("c1"), inbound("c2"), inbound("c3")]);
    const prepared = await input.prepare(offer.offer);
    expect(offer.disposed).toEqual([{ queue_id: "1", outcome: "intentional_non_injection", reason: "terminal_skip" }]);
    expect(prepared.consumed.map((item) => item.queueId)).toEqual(["2"]);
    expect(prepared.injected.map(({ item }) => item.queueId)).toEqual(["3"]);

    reclassified = "terminal";
    const again = offerOf([inbound("c3")], ["3"]);
    expect((await input.prepare(again.offer)).injected).toEqual([]);
    expect(again.disposed).toEqual([{ queue_id: "3", outcome: "intentional_non_injection", reason: "terminal_skip" }]);
  });

  it("keeps a classification while its conversation track is held, and forgets it once the track is gone", async () => {
    let classified = 0;
    let held = true;
    const input = new QueueInput({
      classify: async () => { classified++; return { consumed: false, inject: true, mode: "reply-owed" }; },
      reclassify: (_envelope, mode) => mode,
      sendNotice: () => {},
      tracked: () => held,
    });
    for (let n = 0; n < 3; n++) await input.prepare(offerOf([inbound("c1")]).offer);
    expect(classified).toBe(1);
    held = false;
    await input.prepare(offerOf([inbound("c1")]).offer);
    expect(classified).toBe(2);
  });
});
