import { describe, expect, it, vi } from "vitest";
import { InterAgentAdmission, InterAgentInputLifecycle } from "../src/index.js";
import type { Envelope } from "../src/types.js";

function receipt(
  sequence: number,
  options: { agentId?: string; turn?: number; lossId?: string } = {},
): Envelope {
  return {
    version: "0",
    agent_id: options.agentId ?? "peer.agent",
    persona: { id: "peer", name: "Peer", sprite_set: "peer" },
    display_name: "Peer",
    ts: "2026-10-03T00:00:00.000Z",
    type: "inter_agent_message",
    state: "thinking",
    payload: {
      to: "self.agent",
      conversation_id: `lifecycle-${sequence}`,
      turn_number: options.turn ?? 1,
      kind: "inform",
      body: "receipt",
      meta: { done: false, propose_next: "" },
      ...(options.lossId === undefined ? {} : { loss_id: options.lossId }),
    },
    delivery_seq: sequence,
    ext: {},
  } as unknown as Envelope;
}

const identity = () => ({ incarnation: "incarnation-a", generation: "generation-a" });

describe("InterAgentInputLifecycle", () => {
  it("owns the ledger privately and completes a handle once at an observed boundary", () => {
    const acknowledge = vi.fn();
    const lifecycle = new InterAgentInputLifecycle({
      admission: new InterAgentAdmission(1),
      currentIdentity: identity,
      acknowledgeDelivery: acknowledge,
    });
    const envelope = receipt(1);
    const lease = lifecycle.beginIngress(envelope);
    const reserved = lifecycle.reserve(lease, { kind: "ordinary" });

    expect(reserved.kind).toBe("reserved");
    if (reserved.kind !== "reserved") return;
    expect(lifecycle.pending()).toEqual([
      expect.objectContaining({ handle: reserved.handle, envelope, reservationClass: "ordinary" }),
    ]);
    expect("release" in lifecycle).toBe(false);
    expect("admission" in lifecycle).toBe(false);

    const witness = { kind: "observed", boundary: "prompt_hook", ownerToken: "turn-1" } as const;
    expect(lifecycle.finish(reserved.handle, witness)).toEqual({ kind: "completed", witness: "observed" });
    expect(lifecycle.finish(reserved.handle, witness)).toEqual({ kind: "already_finished" });
    expect(lifecycle.pending()).toEqual([]);
    expect(lifecycle.admissionCounts.total).toBe(0);
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it("turns an invalid observed batch into a sticky diagnostic and intentional ACK without retirement", () => {
    const acknowledge = vi.fn();
    const retire = vi.fn(() => true);
    const diagnostics: Record<string, unknown>[] = [];
    const lifecycle = new InterAgentInputLifecycle({
      admission: new InterAgentAdmission(1),
      currentIdentity: identity,
      acknowledgeDelivery: acknowledge,
      retirementCapability: () => "supported",
      retireDelivery: retire,
      onInvariantViolation: event => diagnostics.push({ ...event }),
    });
    const envelope = receipt(2);
    const lease = lifecycle.beginIngress(envelope);
    const reserved = lifecycle.reserve(lease, { kind: "ordinary" });
    expect(reserved.kind).toBe("reserved");
    if (reserved.kind !== "reserved") return;

    expect(lifecycle.completeBatch([reserved.handle], { kind: "already_observed", ownerToken: "turn-2" })).toEqual({
      kind: "recovered_invariant_violation",
      pendingHandles: 1,
      token: "turn-2",
    });
    expect(lifecycle.invariantViolationCount).toBe(1);
    expect(lifecycle.pendingCount).toBe(0);
    expect(acknowledge).toHaveBeenCalledWith(envelope);
    expect(retire).not.toHaveBeenCalled();
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: "observed_settlement_with_pending_input",
      owner_token: "turn-2",
      pending_handle_count: 1,
    }));
    expect(lifecycle.finish(reserved.handle, { kind: "abandoned", reason: "late callback" })).toEqual({ kind: "already_finished" });
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it("retires abandonment only when the captured transport identity is still current", () => {
    let current = identity();
    const retire = vi.fn(() => true);
    const acknowledge = vi.fn();
    const lifecycle = new InterAgentInputLifecycle({
      admission: new InterAgentAdmission(1),
      currentIdentity: () => current,
      retirementCapability: () => "supported",
      retireDelivery: retire,
      acknowledgeDelivery: acknowledge,
    });
    const envelope = receipt(3);
    const lease = lifecycle.beginIngress(envelope);
    const reserved = lifecycle.reserve(lease, { kind: "ordinary" });
    expect(reserved.kind).toBe("reserved");
    if (reserved.kind !== "reserved") return;
    current = { incarnation: "incarnation-b", generation: "generation-b" };

    lifecycle.finish(reserved.handle, { kind: "abandoned", reason: "native input never started" });
    expect(retire).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
    expect(lifecycle.pendingCount).toBe(0);
  });

  it("disposes accepted refusals through one common notice/ACK path", async () => {
    const envelope = receipt(4);
    const notice = receipt(5);
    const acknowledge = vi.fn();
    const retire = vi.fn(() => true);
    const sendNotice = vi.fn(async () => "accepted" as const);
    const lifecycle = new InterAgentInputLifecycle({
      admission: new InterAgentAdmission(1),
      currentIdentity: identity,
      acknowledgeDelivery: acknowledge,
      retirementCapability: () => "supported",
      retireDelivery: retire,
      sendNotice,
    });
    const lease = lifecycle.beginIngress(envelope);

    await lifecycle.refuse(lease, { notice });

    expect(sendNotice).toHaveBeenCalledWith(notice, expect.any(AbortSignal));
    expect(acknowledge).toHaveBeenCalledWith(envelope);
    expect(retire).not.toHaveBeenCalled();
    expect(lifecycle.pendingCount).toBe(0);
  });

  it("keeps a rejected refusal behind original retirement when supported", async () => {
    const envelope = receipt(6);
    const notice = receipt(7);
    const acknowledge = vi.fn();
    const retire = vi.fn(() => true);
    const lifecycle = new InterAgentInputLifecycle({
      admission: new InterAgentAdmission(1),
      currentIdentity: identity,
      acknowledgeDelivery: acknowledge,
      retirementCapability: () => "supported",
      retireDelivery: retire,
      sendNotice: async () => "rejected",
    });
    const lease = lifecycle.beginIngress(envelope);

    await lifecycle.refuse(lease, { notice });

    expect(retire).toHaveBeenCalledWith(envelope);
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("completes terminal loss inline but only ACKs a duplicate receipt", () => {
    const acknowledge = vi.fn();
    const lifecycle = new InterAgentInputLifecycle({
      currentIdentity: identity,
      acknowledgeDelivery: acknowledge,
    });
    const lossId = "loss-1";
    const first = receipt(8, { agentId: "server", turn: 0, lossId });
    const firstLease = lifecycle.beginIngress(first);
    const reserved = lifecycle.reserve(firstLease, { kind: "loss", lossId });
    expect(reserved.kind).toBe("reserved");
    expect(lifecycle.finishInline(firstLease, "terminal_skip")).toEqual({ kind: "completed", witness: "inline" });
    expect(lifecycle.lossDisposition(lossId)).toBe("completed");

    const regenerated = receipt(9, { agentId: "server", turn: 0, lossId });
    const duplicateLease = lifecycle.beginIngress(regenerated);
    expect(lifecycle.reserve(duplicateLease, { kind: "loss", lossId })).toEqual({ kind: "duplicate_loss" });
    expect(lifecycle.finishInline(duplicateLease, "duplicate_loss")).toEqual({ kind: "completed", witness: "inline" });
    expect(lifecycle.lossDisposition(lossId)).toBe("completed");
    expect(lifecycle.pendingCount).toBe(0);
    expect(acknowledge).toHaveBeenCalledTimes(2);
  });

  it("closes leased input from the authoritative pending snapshot before awaiting executors", async () => {
    const retire = vi.fn(() => true);
    const lifecycle = new InterAgentInputLifecycle({
      currentIdentity: identity,
      retirementCapability: () => "supported",
      retireDelivery: retire,
    });
    const envelope = receipt(10);
    const lease = lifecycle.beginIngress(envelope);
    const reserved = lifecycle.reserve(lease, { kind: "ordinary" });
    expect(reserved.kind).toBe("reserved");
    if (reserved.kind !== "reserved") return;

    await lifecycle.close({ preserveInFlight: [], reason: "wrapper_closed" });

    expect(lifecycle.pendingCount).toBe(0);
    expect(retire).toHaveBeenCalledWith(envelope);
    expect(lifecycle.ingressOpen(lease)).toBe(false);
  });

  it("cancels a refusal at the receipt cutoff and holds the preserved native input", async () => {
    const first = receipt(11);
    const overloaded = receipt(12);
    const notice = receipt(13);
    const acknowledge = vi.fn();
    const retire = vi.fn(() => true);
    let resolveNotice!: (outcome: "accepted" | "rejected" | "unknown") => void;
    let refusalSignal: AbortSignal | undefined;
    const lifecycle = new InterAgentInputLifecycle({
      admission: new InterAgentAdmission(1),
      currentIdentity: identity,
      acknowledgeDelivery: acknowledge,
      retirementCapability: () => "supported",
      retireDelivery: retire,
      unknownInput: vi.fn(),
      sendNotice: (_notice, signal) => {
        refusalSignal = signal;
        return new Promise(resolve => { resolveNotice = resolve; });
      },
    });
    const firstLease = lifecycle.beginIngress(first);
    const reserved = lifecycle.reserve(firstLease, { kind: "ordinary" });
    expect(reserved.kind).toBe("reserved");
    if (reserved.kind !== "reserved") return;
    const overloadedLease = lifecycle.beginIngress(overloaded);
    const refusal = lifecycle.refuse(overloadedLease, { notice });

    await lifecycle.close({
      preserveInFlight: [reserved.handle],
      reason: "wrapper_closed",
      finalizeBy: performance.now() + 5,
    });

    expect(refusalSignal?.aborted).toBe(true);
    expect(lifecycle.pendingCount).toBe(0);
    expect(retire).toHaveBeenCalledWith(overloaded);
    expect(retire).not.toHaveBeenCalledWith(first);
    expect(acknowledge).not.toHaveBeenCalled();

    resolveNotice("accepted");
    await refusal;
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("does not retire receipts that arrive after the shutdown flush cutoff", async () => {
    const acknowledge = vi.fn();
    const retire = vi.fn(() => true);
    const lifecycle = new InterAgentInputLifecycle({
      currentIdentity: identity,
      acknowledgeDelivery: acknowledge,
      retirementCapability: () => "supported",
      retireDelivery: retire,
    });
    await lifecycle.close({ preserveInFlight: [], reason: "wrapper_closed" });
    lifecycle.stopRetirementRequests();

    const late = receipt(14);
    const lease = lifecycle.beginIngress(late);
    lifecycle.finishIngress(lease);
    await lifecycle.close({ preserveInFlight: [], reason: "wrapper_closed" });

    expect(retire).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
  });
});
