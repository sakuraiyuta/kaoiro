import { describe, expect, it } from "vitest";
import { InterAgentAdmission, MAX_PENDING_LOSS_NOTICE_ITEMS } from "../src/inter_agent_admission.js";
import type { Envelope } from "../src/types.js";

function envelope(id: number, agentId = "peer", turnNumber = id): Envelope {
  return {
    type: "inter_agent_message",
    agent_id: agentId,
    ts: "2026-10-03T00:00:00.000Z",
    payload: {
      to: "receiver",
      conversation_id: `conversation-${id}`,
      turn_number: turnNumber,
      kind: "inform",
      body: `message-${id}`,
      meta: { done: false, propose_next: "" },
      owner: { kind: "user", id: "operator" },
      new_conversation: false,
    },
  } as unknown as Envelope;
}

function lossEnvelope(id: number): Envelope {
  const item = envelope(id, "server", 0);
  (item.payload as { loss_id?: string }).loss_id = `loss-${id}`;
  return item;
}

function reserve(admission: InterAgentAdmission, item: Envelope, options?: { waiter?: boolean; lossId?: string }) {
  const result = admission.admit(item, options);
  if (result.kind !== "reserved") throw new Error(`unexpected ${result.kind}`);
  return result.reservation;
}

describe("InterAgentAdmission", () => {
  it("admits the configured number of items and refuses the next one", () => {
    const admission = new InterAgentAdmission(2);
    const first = reserve(admission, envelope(1));
    const second = reserve(admission, envelope(2));

    expect(admission.counts()).toEqual({ total: 2, ordinary: 2, waiter: 0, control: 0 });
    expect(admission.admit(envelope(3))).toEqual({ kind: "refused" });
    expect(admission.release(first, "handed_off")).toBe(true);
    const fourth = reserve(admission, envelope(4));
    expect(admission.release(fourth, "retired")).toBe(true);
    expect(admission.release(second, "retired")).toBe(true);
  });

  it("default admission counts 100 individual items across peers and refuses item 101", () => {
    const admission = new InterAgentAdmission();
    const reservations = Array.from({ length: 100 }, (_, index) =>
      reserve(admission, envelope(index + 1, `peer-${index % 4}`)),
    );
    expect(admission.counts()).toEqual({ total: 100, ordinary: 100, waiter: 0, control: 0 });
    expect(admission.admit(envelope(101, "peer-0"))).toEqual({ kind: "refused" });
    for (const reservation of reservations) admission.release(reservation, "handed_off");
  });

  it.each([17, 100])("admits a non-saturated burst of %i loss notices as ordinary work", count => {
    const admission = new InterAgentAdmission(100);
    const reservations = Array.from({ length: count }, (_, index) => {
      const item = lossEnvelope(index + 1);
      const result = admission.admit(item, { lossId: `loss-${index + 1}` });
      if (result.kind !== "reserved") throw new Error(`unexpected ${result.kind}`);
      return result.reservation;
    });

    expect(admission.counts()).toEqual({ total: count, ordinary: count, waiter: 0, control: 0 });
    expect(admission.refusedLosses).toBe(0);
    for (const reservation of reservations) admission.release(reservation, "handed_off");
  });

  it("counts waiter replies above the ordinary threshold", () => {
    const admission = new InterAgentAdmission(1);
    reserve(admission, envelope(1));
    const waiter = reserve(admission, envelope(2), { waiter: true });

    expect(admission.counts()).toEqual({ total: 2, ordinary: 1, waiter: 1, control: 0 });
    expect(admission.admit(envelope(3))).toEqual({ kind: "refused" });
    admission.release(waiter, "handed_off");
    expect(admission.counts().total).toBe(1);
  });

  it("uses ordinary capacity for loss notices before the bounded overflow allowance", () => {
    const admission = new InterAgentAdmission(2);
    const one = reserve(admission, lossEnvelope(1), { lossId: "loss-1" });
    const two = reserve(admission, lossEnvelope(2), { lossId: "loss-2" });
    const overflow = reserve(admission, lossEnvelope(3), { lossId: "loss-3" });

    expect(admission.counts()).toEqual({ total: 3, ordinary: 2, waiter: 0, control: 1 });
    admission.release(one, "retired");
    admission.release(two, "retired");
    const returnedToOrdinary = reserve(admission, lossEnvelope(4), { lossId: "loss-4" });
    expect(admission.counts()).toEqual({ total: 2, ordinary: 1, waiter: 0, control: 1 });
    admission.release(overflow, "retired");
    admission.release(returnedToOrdinary, "retired");
  });

  it("refuses loss notice 17 at Q=P with all control slots used, without claiming its ID", () => {
    const admission = new InterAgentAdmission(1);
    reserve(admission, envelope(1));
    const controls = Array.from({ length: MAX_PENDING_LOSS_NOTICE_ITEMS }, (_, index) => {
      const id = index + 2;
      return reserve(admission, lossEnvelope(id), { lossId: `loss-${id}` });
    });
    const refused = lossEnvelope(MAX_PENDING_LOSS_NOTICE_ITEMS + 2);
    const refusedId = (refused.payload as { loss_id: string }).loss_id;

    expect(admission.admit(refused, { lossId: refusedId })).toEqual({ kind: "refused" });
    expect(admission.isLossDuplicate(refusedId)).toBe(false);
    admission.release(controls[0]!, "retired");
    expect(admission.admit(refused, { lossId: refusedId }).kind).toBe("reserved");
  });

  it("keeps malformed and null-tool fallback ordinary and never grants the control allowance", () => {
    const admission = new InterAgentAdmission(1);
    reserve(admission, envelope(1));
    const refused = lossEnvelope(2);
    expect(admission.admitFallback(refused)).toMatchObject({ kind: "refused", lossId: "loss-2", retirementAttemptCount: 1 });
    expect(admission.counts()).toEqual({ total: 1, ordinary: 1, waiter: 0, control: 0 });
  });

  it("deduplicates pending and completed loss IDs, while retirement leaves retry eligible", () => {
    const admission = new InterAgentAdmission(2);
    const first = lossEnvelope(1);
    const firstReservation = reserve(admission, first, { lossId: "loss-1" });
    const duplicate = lossEnvelope(2);
    (duplicate.payload as { loss_id?: string }).loss_id = "loss-1";
    expect(admission.admit(duplicate, { lossId: "loss-1" })).toEqual({ kind: "duplicate_loss" });
    admission.release(firstReservation, "retired");

    const retry = lossEnvelope(3);
    (retry.payload as { loss_id?: string }).loss_id = "loss-1";
    const retryReservation = reserve(admission, retry, { lossId: "loss-1" });
    admission.release(retryReservation, "handed_off");
    const completedDuplicate = lossEnvelope(4);
    (completedDuplicate.payload as { loss_id?: string }).loss_id = "loss-1";
    expect(admission.admit(completedDuplicate, { lossId: "loss-1" })).toEqual({ kind: "duplicate_loss" });
  });

  it("keeps reservation release idempotent and rejects forged loss provenance", () => {
    const admission = new InterAgentAdmission(1);
    const item = envelope(1);
    const reservation = reserve(admission, item);
    expect(admission.owns(reservation, item)).toBe(true);
    expect(admission.release(reservation, "completed")).toBe(true);
    expect(admission.release(reservation, "completed")).toBe(false);
    expect(admission.owns(reservation, item)).toBe(false);
    expect(() => admission.admit(item, { lossId: "forged" })).toThrow("server provenance");
  });

  it("captures transport generation and sequence on the receipt before admission", () => {
    const admission = new InterAgentAdmission(1);
    const item = envelope(1) as Envelope & { delivery_seq: number };
    item.delivery_seq = 7;
    expect(admission.captureDeliveryIdentity(item, { incarnation: "join-a", generation: "gen-3" })).toEqual({
      incarnation: "join-a",
      generation: "gen-3",
      delivery_seq: 7,
    });
    const reserved = admission.admit(item);
    expect(reserved.kind).toBe("reserved");
    expect(admission.deliveryIdentityFor(item)).toEqual({
      incarnation: "join-a",
      generation: "gen-3",
      delivery_seq: 7,
    });
  });
});
