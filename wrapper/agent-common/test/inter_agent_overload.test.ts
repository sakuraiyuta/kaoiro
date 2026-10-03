import { describe, expect, it, vi } from "vitest";
import { settleOverloadedInbound } from "../src/inter_agent_overload.js";
import type { InterAgentDeliveryIdentity } from "../src/inter_agent_admission.js";
import type { Envelope } from "../src/types.js";

const envelope = {
  version: "0",
  agent_id: "peer.agent",
  persona: { id: "peer", name: "Peer", sprite_set: "peer" },
  display_name: "Peer",
  ts: "2026-10-03T00:00:00Z",
  type: "inter_agent_message",
  state: "thinking",
  payload: {
    to: "self.agent",
    conversation_id: "cid",
    turn_number: 4,
    kind: "inform",
    body: "input",
    meta: { done: false, propose_next: "" },
    owner: { kind: "user", id: "operator" },
  },
  ext: {},
  delivery_seq: 12,
} as Envelope;

describe("settleOverloadedInbound", () => {
  it("acknowledges only after the notice is accepted", async () => {
    const order: string[] = [];
    await settleOverloadedInbound({
      envelope,
      notice: envelope,
      sendNotice: async () => { order.push("notice"); return "accepted"; },
      acknowledgeDelivery: () => order.push("ack"),
      retireDelivery: () => { order.push("retire"); return true; },
      retirementCapability: () => "supported",
    });
    expect(order).toEqual(["notice", "ack"]);
  });

  it.each(["rejected", "unknown"] as const)("requests negotiated retirement after a %s notice outcome without ACK", async outcome => {
    const acknowledged = vi.fn();
    const retired = vi.fn(() => true);
    await settleOverloadedInbound({
      envelope,
      notice: envelope,
      sendNotice: async () => outcome,
      acknowledgeDelivery: acknowledged,
      retireDelivery: retired,
      retirementCapability: () => "supported",
    });
    expect(retired).toHaveBeenCalledWith(envelope);
    expect(acknowledged).not.toHaveBeenCalled();
  });

  it("holds ACK when retirement capability or its request outcome is unresolved", async () => {
    const acknowledged = vi.fn();
    const retireDelivery = vi.fn(() => false);
    for (const capability of ["pending", "supported"] as const) {
      await settleOverloadedInbound({
        envelope,
        notice: envelope,
        sendNotice: async () => "unknown",
        acknowledgeDelivery: acknowledged,
        retireDelivery,
        retirementCapability: () => capability,
      });
    }
    expect(acknowledged).not.toHaveBeenCalled();
    expect(retireDelivery).toHaveBeenCalledTimes(1);
  });

  it("records the explicit legacy ACK as unconfirmed and without automatic recovery", async () => {
    const acknowledged = vi.fn();
    const retired = vi.fn(() => true);
    const logs: string[] = [];
    await settleOverloadedInbound({
      envelope,
      notice: envelope,
      lossId: "loss-4",
      retirementAttemptCount: 3,
      controlReservationCount: 16,
      deliveryIdentity: { incarnation: "join-a", generation: "gen-3", delivery_seq: 12 } satisfies InterAgentDeliveryIdentity,
      sendNotice: async () => "rejected",
      acknowledgeDelivery: acknowledged,
      retireDelivery: retired,
      retirementCapability: () => "unsupported",
      log: line => logs.push(line),
    });
    expect(acknowledged).toHaveBeenCalledWith(envelope);
    expect(retired).not.toHaveBeenCalled();
    expect(JSON.parse(logs[0]!)).toMatchObject({
      event: "receiver_overloaded",
      reason: "loss_notice_control_allowance_exhausted",
      delivery_seq: 12,
      delivery_identity: { incarnation: "join-a", generation: "gen-3", delivery_seq: 12 },
      loss_id: "loss-4",
      retirement_attempt_count: 3,
      control_reservations: 16,
      control_limit: 16,
      notification_outcome: "not_confirmed",
      retirement_capability: "unsupported",
      acknowledgement_outcome: "intentional_non_injection_retirement_unsupported",
      retirement_unsupported: true,
      automatic_loss_recovery_available: false,
    });
  });
});
