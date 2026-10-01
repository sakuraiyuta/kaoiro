import { describe, expect, it } from "vitest";
import type { Envelope } from "@kaoiro/agent-common";
import {
  CodexInterAgentTurnCoordinator,
  type DispatchedCodexInterAgentBatch,
} from "../src/inter_agent_turn_coordinator.js";

function inbound(cid: string): Envelope {
  return {
    version: "0",
    agent_id: "peer.agent",
    persona: { id: "peer", name: "Peer", sprite_set: "peer" },
    display_name: "Peer",
    ts: "T",
    type: "inter_agent_message",
    state: "idle",
    payload: {
      to: "self.agent",
      conversation_id: cid,
      turn_number: 1,
      kind: "inform",
      body: cid,
      meta: { done: false, propose_next: "" },
      owner: { kind: "user", id: "operator" },
    },
    ext: {},
  };
}

describe("CodexInterAgentTurnCoordinator lease ownership (issue #255)", () => {
  it("replaces a host-queued batch with survivors at the final input boundary", () => {
    const dispatched: DispatchedCodexInterAgentBatch[] = [];
    const removed: string[] = [];
    let closed = false;
    let token = 0;
    const coordinator = new CodexInterAgentTurnCoordinator({
      createTurnToken: () => `turn-${++token}`,
      reclassifyQueued: (item) => closed && item.envelope.payload.conversation_id === "closed"
        ? "terminal" : item.mode,
      onTerminalQueued: (item) => removed.push(String(item.envelope.payload.conversation_id)),
      onDispatch: (batch) => dispatched.push(batch),
    });
    coordinator.receive(inbound("active"), "reply-owed");
    coordinator.receive(inbound("closed"), "close-proposal");
    coordinator.receive(inbound("survivor"), "reply-owed");
    coordinator.settle("turn-1");
    coordinator.dispatchNextForPeer("peer.agent");
    expect(dispatched[1]?.conversationIds).toEqual(["closed", "survivor"]);
    closed = true;
    const prepared = coordinator.prepareInput("turn-2");
    expect(prepared?.batch?.conversationIds).toEqual(["survivor"]);
    expect(prepared?.removedConversationIds).toEqual(["closed"]);
    expect(coordinator.settle("turn-2")?.conversationIds).toEqual(["survivor"]);
    expect(removed).toEqual(["closed"]);
  });

  it("delivery sequence belongs to the exact dispatched turn", () => {
    const coordinator = new CodexInterAgentTurnCoordinator({
      createTurnToken: () => "turn-1",
      onDispatch: () => {},
    });
    const message = inbound("dispatch");
    (message as Envelope & { delivery_seq: number }).delivery_seq = 9;
    coordinator.receive(message, "reply-owed");
    expect(coordinator.deliverySequencesForTurn("not-started")).toEqual([]);
    expect(coordinator.deliverySequencesForTurn("turn-1")).toEqual([9]);
    expect(coordinator.deliverySequenceRangeForTurn("turn-1")).toEqual({
      first: 9,
      last: 9,
    });
    expect(coordinator.turnTokenForDeliverySequence(9)).toBe("turn-1");
  });

  it("watchdog freeze retains only the active batch and closes future dispatch", () => {
    const dispatched: DispatchedCodexInterAgentBatch[] = [];
    const tokens = ["turn-active", "turn-other"];
    const coordinator = new CodexInterAgentTurnCoordinator({
      createTurnToken: () => tokens.shift()!,
      onDispatch: (batch) => dispatched.push(batch),
    });

    coordinator.receive(inbound("active"), "reply-owed");
    coordinator.receive(inbound("pending"), "reply-owed");
    expect(dispatched).toHaveLength(1);
    const retired: Envelope[] = [];
    const frozen = coordinator.freezeForWatchdogFailStop("turn-active", (envelopes) => retired.push(...envelopes));
    expect(frozen).toEqual({ droppedDispatched: 0, droppedPending: 1 });
    expect(retired.map((envelope) => envelope.payload.conversation_id)).toEqual(["pending"]);

    coordinator.dispatchNextForPeer("peer.agent");
    coordinator.receive(inbound("after-freeze"), "reply-owed");
    expect(dispatched).toHaveLength(1);
    expect(retired.map((envelope) => envelope.payload.conversation_id)).toEqual(["pending", "after-freeze"]);
  });

  it("same CID の stale token は active batch を settle できず後続を dispatch しない", () => {
    const dispatched: DispatchedCodexInterAgentBatch[] = [];
    const tokens = ["turn-1", "turn-2"];
    const coordinator = new CodexInterAgentTurnCoordinator({
      createTurnToken: () => tokens.shift()!,
      onDispatch: (batch) => dispatched.push(batch),
    });

    coordinator.receive(inbound("shared"), "reply-owed");
    coordinator.receive(inbound("shared"), "reply-owed");
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.turnToken).toBe("turn-1");

    expect(coordinator.settle("stale-turn")).toBeUndefined();
    coordinator.dispatchNextForPeer("peer.agent");
    expect(dispatched).toHaveLength(1);

    expect(coordinator.settle("turn-1")?.turnToken).toBe("turn-1");
    coordinator.dispatchNextForPeer("peer.agent");
    expect(dispatched).toHaveLength(2);
    expect(dispatched[1]?.turnToken).toBe("turn-2");
  });
});


describe("recovery ownership", () => {
  const message = (cid: string) => inbound(cid);
  it("re-hands only an activated steer body to its exact peer turn and retires it on credit, newer input, and reset", () => {
    const coordinator = new CodexInterAgentTurnCoordinator({ onDispatch: () => {} });
    const first = message("cid");
    coordinator.retainSteeredBody([first]);
    expect(coordinator.claimRecovery("cid", "peer.agent", "active", () => false, 1))
      .toMatchObject({ oversizedPending: true, foldedEarlier: true, recoverySource: "retained_fold" });
    expect(coordinator.claimRecovery("cid", "other.agent", "active", () => true, 1)).toBeUndefined();
    expect(coordinator.claimRecovery("cid", "peer.agent", "active", () => true, 2)).toBeUndefined();
    expect(coordinator.claimRecovery("cid", "peer.agent", "active", () => true, 1))
      .toMatchObject({ envelopes: [first], foldedEarlier: true, recoverySource: "retained_fold" });
    coordinator.creditSteeredBody([first]);
    expect(coordinator.claimRecovery("cid", "peer.agent", "active", () => true, 1)).toBeUndefined();
    coordinator.retainSteeredBody([first]);
    const newer = message("cid"); newer.payload.turn_number = 2;
    coordinator.retireSteeredBeforeConfirmed([newer]);
    expect(coordinator.claimRecovery("cid", "peer.agent", "active", () => true, 1)).toBeUndefined();
    coordinator.retainSteeredBody([newer]);
    coordinator.resetSteeredRecovery();
    expect(coordinator.claimRecovery("cid", "peer.agent", "active", () => true, 2)).toBeUndefined();
  });
  it("counts bounded steered-body recovery evictions", () => {
    const coordinator = new CodexInterAgentTurnCoordinator({ onDispatch: () => {} });
    for (let index = 0; index <= 256; index += 1) {
      coordinator.retainSteeredBody([message(`cid-${index}`)]);
    }
    expect(coordinator.steerRecoveryEvictions).toBe(1);
    expect(coordinator.claimRecovery("cid-0", "peer.agent", "active", () => true, 1)).toBeUndefined();
    expect(coordinator.claimRecovery("cid-256", "peer.agent", "active", () => true, 1)?.foldedEarlier).toBe(true);
  });
  it("removes host-queued bodies before input preparation and preserves unrelated CIDs", () => {
    let next = 0;
    const coordinator = new CodexInterAgentTurnCoordinator({ createTurnToken: () => `T${++next}`, onDispatch: () => {} });
    coordinator.receive(message("first"), "reply-owed");
    coordinator.receive(message("recover"), "reply-owed"); coordinator.receive(message("other"), "reply-owed");
    coordinator.settle("T1"); coordinator.dispatchNextForPeer("peer.agent");
    const lease = coordinator.claimRecovery("recover", "peer.agent", "operator-turn", () => true)!;
    expect(lease.envelopes).toHaveLength(1); lease.commit();
    const prepared = coordinator.prepareInput("T2")!;
    expect(prepared.removedConversationIds).toEqual(["recover"]);
    expect(prepared.batch?.conversationIds).toEqual(["other"]);
    expect(prepared.batch?.text).not.toContain('conversation_id="recover"');
    expect(coordinator.claimRecovery("other", "peer.agent", "T2", () => true)).toBeUndefined();
  });
  it("returns a cancelled claim to its original unstarted host batch", () => {
    let next = 0;
    const coordinator = new CodexInterAgentTurnCoordinator({ createTurnToken: () => `T${++next}`, onDispatch: () => {} });
    coordinator.receive(message("active"), "reply-owed"); coordinator.receive(message("recover"), "reply-owed"); coordinator.receive(message("other"), "reply-owed");
    coordinator.settle("T1"); coordinator.dispatchNextForPeer("peer.agent");
    const lease = coordinator.claimRecovery("recover", "peer.agent", "operator", () => true)!;
    lease.rollback();
    expect(coordinator.prepareInput("T2")?.batch?.conversationIds).toEqual(["recover", "other"]);
    expect(coordinator.unreadCount("T2")).toBe(0);
    expect(coordinator.claimRecovery("recover", "peer.agent", null, () => true)).toBeUndefined();
  });
  it.each([false, true])("restores overlapping claims without losing the other's body (reverse=%s)", reverse => {
    let next = 0;
    const coordinator = new CodexInterAgentTurnCoordinator({ createTurnToken: () => `T${++next}`, onDispatch: () => {} });
    coordinator.receive(message("active"), "reply-owed"); coordinator.receive(message("A"), "reply-owed"); coordinator.receive(message("B"), "reply-owed");
    coordinator.settle("T1"); coordinator.dispatchNextForPeer("peer.agent");
    const a = coordinator.claimRecovery("A", "peer.agent", "operator", () => true)!;
    const b = coordinator.claimRecovery("B", "peer.agent", "operator", () => true)!;
    for (const lease of reverse ? [b, a] : [a, b]) lease.rollback();
    expect(coordinator.prepareInput("T2")?.batch?.conversationIds).toEqual(["A", "B"]);
  });
  it("never skips an oversized oldest body and returns cancelled ownership once", () => {
    let next = 0;
    const coordinator = new CodexInterAgentTurnCoordinator({ createTurnToken: () => `T${++next}`, onDispatch: () => {} });
    coordinator.receive(message("active"), "reply-owed");
    const first = message("recover"), second = message("recover"); second.payload.turn_number = 3;
    coordinator.receive(first, "reply-owed"); coordinator.receive(second, "reply-owed");
    expect(coordinator.claimRecovery("recover", "peer.agent", "T1", () => false))
      .toMatchObject({ oversizedPending: true, recoverySource: "handoff_queue" });
    expect(coordinator.unreadCount("T1")).toBe(2);
    const lease = coordinator.claimRecovery("recover", "peer.agent", "T1", e => e.length <= 1)!;
    expect(lease.envelopes).toEqual([first]); expect(coordinator.unreadCount("T1")).toBe(2);
    lease.rollback(); lease.rollback(); expect(coordinator.unreadCount("T1")).toBe(2);
    coordinator.settle("T1"); coordinator.dispatchNextForPeer("peer.agent");
    expect(coordinator.prepareInput("T2")?.batch?.items[0]?.envelope).toBe(first);
  });
});

describe("steer fallback reservations", () => {
  it("dispatches one ordinary root ahead of successors without offering fallback to recovery", () => {
    const dispatched: DispatchedCodexInterAgentBatch[] = [];
    const slots = new Set<string>();
    let next = 0;
    const coordinator = new CodexInterAgentTurnCoordinator({
      createTurnToken: () => `T${++next}`,
      createPlaceholder: id => { slots.add(id); return true; },
      removePlaceholder: id => { slots.delete(id); },
      onDispatch: batch => { dispatched.push(batch); if (batch.fallbackId) { slots.delete(batch.fallbackId); return true; } },
    });
    const fallback = inbound("fallback");
    coordinator.reserveSteer("S", fallback, "reply-owed", 1);
    coordinator.attachSteerPlaceholder("S");
    coordinator.receive(inbound("successor"), "reply-owed");
    expect(dispatched).toHaveLength(0);
    coordinator.settleSteerReservation("S", true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ fallbackId: "S", conversationIds: ["fallback"] });
    expect(dispatched[0]?.text).toContain("fallback");
    expect(dispatched[0]?.text).not.toContain("Mid-turn peer delivery");
    expect(coordinator.claimRecovery("fallback", "peer.agent", null, () => true)).toBeUndefined();
    expect(coordinator.unreadCount(null)).toBe(1);
    expect(coordinator.pendingSteerReservationCount).toBe(0);
    expect(slots.size).toBe(0);
    coordinator.settle("T1");
    coordinator.dispatchNextForPeer("peer.agent");
    expect(dispatched[1]?.conversationIds).toEqual(["successor"]);
  });

  it("does not advertise a pending fallback as unread or claimable", () => {
    let blocked = true;
    const dispatched: DispatchedCodexInterAgentBatch[] = [];
    const slots = new Set<string>();
    const coordinator = new CodexInterAgentTurnCoordinator({
      canDispatchPeer: () => !blocked,
      createPlaceholder: id => { slots.add(id); return true; },
      removePlaceholder: id => { slots.delete(id); },
      onDispatch: batch => { dispatched.push(batch); slots.delete(batch.fallbackId!); return true; },
    });
    const envelope = inbound("pending");
    coordinator.reserveSteer("S", envelope, "reply-owed", 1);
    coordinator.attachSteerPlaceholder("S");
    coordinator.settleSteerReservation("S", true);
    expect(dispatched).toHaveLength(0);
    expect(coordinator.unreadCount(null)).toBe(0);
    expect(coordinator.claimRecovery("pending", "peer.agent", null, () => true)).toBeUndefined();
    blocked = false;
    coordinator.dispatchNextForPeer("peer.agent");
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.items.map(item => item.envelope)).toEqual([envelope]);
    expect(coordinator.unreadCount(null)).toBe(0);
    expect(coordinator.pendingSteerReservationCount).toBe(0);
    expect(slots.size).toBe(0);
  });

  it("holds a later fallback until every earlier steer has settled", () => {
    const dispatched: DispatchedCodexInterAgentBatch[] = [];
    const slots = new Set<string>();
    const coordinator = new CodexInterAgentTurnCoordinator({
      createPlaceholder: id => { slots.add(id); return true; },
      removePlaceholder: id => { slots.delete(id); },
      onDispatch: batch => { dispatched.push(batch); if (batch.fallbackId) { slots.delete(batch.fallbackId); return true; } },
    });
    coordinator.reserveSteer("first", inbound("first"), "reply-owed", 1);
    coordinator.reserveSteer("second", inbound("second"), "reply-owed", 2);
    coordinator.attachSteerPlaceholder("second");
    coordinator.settleSteerReservation("second", true);
    expect(dispatched).toHaveLength(0);
    coordinator.settleSteerReservation("first", true);
    expect(dispatched.map(batch => batch.conversationIds)).toEqual([["first"]]);
    expect(coordinator.pendingSteerReservationCount).toBe(1);
    coordinator.settle(dispatched[0]!.turnToken);
    coordinator.dispatchNextForPeer("peer.agent");
    expect(dispatched.map(batch => batch.conversationIds)).toEqual([["first"], ["second"]]);
    expect(coordinator.pendingSteerReservationCount).toBe(0);
    expect(slots.size).toBe(0);
  });

  it("removes a terminal fallback slot before dispatch and ignores late attachment", () => {
    const slots = new Set<string>();
    const terminal: string[] = [];
    const dispatched: DispatchedCodexInterAgentBatch[] = [];
    let closed = false;
    const coordinator = new CodexInterAgentTurnCoordinator({
      createPlaceholder: id => { slots.add(id); return true; },
      removePlaceholder: id => { slots.delete(id); },
      reclassifyQueued: item => closed && item.envelope.payload.conversation_id === "ended" ? "terminal" : item.mode,
      onTerminalQueued: item => terminal.push(String(item.envelope.payload.conversation_id)),
      onDispatch: batch => { dispatched.push(batch); return true; },
    });
    coordinator.reserveSteer("S", inbound("ended"), "reply-owed", 1);
    coordinator.attachSteerPlaceholder("S");
    closed = true;
    coordinator.settleSteerReservation("S", true);
    expect(terminal).toEqual(["ended"]);
    expect(dispatched).toHaveLength(0);
    expect(coordinator.attachSteerPlaceholder("S")).toBe(false);
    expect(coordinator.pendingSteerReservationCount).toBe(0);
    expect(slots.size).toBe(0);
  });

  it("drops a fallback reclassified terminal while pending behind dispatch", () => {
    const slots = new Set<string>();
    const terminal: string[] = [];
    let blocked = true, closed = false;
    const coordinator = new CodexInterAgentTurnCoordinator({
      createPlaceholder: id => { slots.add(id); return true; },
      removePlaceholder: id => { slots.delete(id); },
      canDispatchPeer: () => !blocked,
      reclassifyQueued: item => closed && item.envelope.payload.conversation_id === "ended" ? "terminal" : item.mode,
      onTerminalQueued: item => terminal.push(String(item.envelope.payload.conversation_id)),
      onDispatch: () => { throw new Error("terminal fallback must not dispatch"); },
    });
    coordinator.reserveSteer("S", inbound("ended"), "reply-owed", 1);
    coordinator.attachSteerPlaceholder("S");
    coordinator.settleSteerReservation("S", true);
    expect(coordinator.pendingSteerReservationCount).toBe(1);
    closed = true; blocked = false;
    coordinator.dispatchNextForPeer("peer.agent");
    expect(terminal).toEqual(["ended"]);
    expect(coordinator.pendingSteerReservationCount).toBe(0);
    expect(slots.size).toBe(0);
  });

  it("removes a fallback at the final input boundary after its slot was consumed", () => {
    const slots = new Set<string>();
    const terminal: string[] = [];
    let closed = false, token = "";
    const coordinator = new CodexInterAgentTurnCoordinator({
      createPlaceholder: id => { slots.add(id); return true; },
      removePlaceholder: id => { slots.delete(id); },
      reclassifyQueued: () => closed ? "terminal" : "reply-owed",
      onTerminalQueued: item => terminal.push(String(item.envelope.payload.conversation_id)),
      onDispatch: batch => { token = batch.turnToken; slots.delete(batch.fallbackId!); return true; },
    });
    coordinator.reserveSteer("S", inbound("ended"), "reply-owed", 1);
    coordinator.attachSteerPlaceholder("S");
    coordinator.settleSteerReservation("S", true);
    closed = true;
    expect(coordinator.prepareInput(token)).toMatchObject({ batch: null, removedConversationIds: ["ended"] });
    expect(terminal).toEqual(["ended"]);
    expect(coordinator.pendingSteerReservationCount).toBe(0);
    expect(slots.size).toBe(0);
  });

  it("retires an admitted unwritten fallback when its arrival slot cannot be made", () => {
    const retired: Envelope[] = [];
    const envelope = inbound("unwritten");
    const coordinator = new CodexInterAgentTurnCoordinator({
      createPlaceholder: () => false,
      retireDiscarded: envelopes => { retired.push(...envelopes); },
      onDispatch: () => { throw new Error("slotless fallback must not dispatch"); },
    });
    coordinator.reserveSteer("S", envelope, "reply-owed", 1);
    coordinator.settleSteerReservation("S", true);
    expect(retired).toEqual([envelope]);
    expect(coordinator.pendingSteerReservationCount).toBe(0);
  });

  it("retires a failed replacement once, removes its slot, then releases the peer", () => {
    const slots = new Set<string>();
    const retired: Envelope[] = [];
    const failed: DispatchedCodexInterAgentBatch[] = [];
    const dispatched: DispatchedCodexInterAgentBatch[] = [];
    const first = inbound("failed");
    const coordinator = new CodexInterAgentTurnCoordinator({
      createPlaceholder: id => { slots.add(id); return true; },
      removePlaceholder: id => { slots.delete(id); },
      retireDiscarded: envelopes => { retired.push(...envelopes); },
      onFallbackDispatchFailure: batch => { failed.push(batch); },
      onDispatch: batch => { dispatched.push(batch); return batch.fallbackId === undefined; },
    });
    coordinator.reserveSteer("S", first, "reply-owed", 1);
    coordinator.attachSteerPlaceholder("S");
    coordinator.receive(inbound("next"), "reply-owed");
    coordinator.settleSteerReservation("S", true);
    expect(failed).toHaveLength(1);
    expect(retired).toEqual([first]);
    expect(dispatched.map(batch => batch.conversationIds)).toEqual([["failed"], ["next"]]);
    expect(coordinator.pendingSteerReservationCount).toBe(0);
    expect(slots.size).toBe(0);
    coordinator.retireEnvelopes([first]);
    expect(retired).toEqual([first]);
  });

  it("freezes steering without retirement and retires queued fallback once", () => {
    const slots = new Set<string>();
    const retired: Envelope[] = [];
    const first = inbound("first"), second = inbound("second");
    const coordinator = new CodexInterAgentTurnCoordinator({
      createPlaceholder: id => { slots.add(id); return true; },
      removePlaceholder: id => { slots.delete(id); },
      retireDiscarded: envelopes => { retired.push(...envelopes); },
      onDispatch: () => true,
    });
    coordinator.reserveSteer("first", first, "reply-owed", 1);
    coordinator.reserveSteer("second", second, "reply-owed", 2);
    coordinator.attachSteerPlaceholder("first");
    coordinator.attachSteerPlaceholder("second");
    coordinator.settleSteerReservation("second", true);
    expect(coordinator.pendingSteerReservationCount).toBe(2);
    coordinator.freezeForWatchdogFailStop();
    expect(retired).toEqual([second]);
    expect(coordinator.pendingSteerReservationCount).toBe(0);
    expect(slots.size).toBe(0);
    expect(coordinator.attachSteerPlaceholder("first")).toBe(false);
  });

  it("keeps an undispatched fallback visible to peer and conversation admission", () => {
    const coordinator = new CodexInterAgentTurnCoordinator({
      canDispatchPeer: () => false,
      createPlaceholder: () => true,
      removePlaceholder: () => {},
      onDispatch: () => true,
    });
    coordinator.reserveSteer("S", inbound("pending-cid"), "reply-owed", 1);
    coordinator.attachSteerPlaceholder("S");
    coordinator.settleSteerReservation("S", true);
    expect(coordinator.hasQueuedForPeer("peer.agent")).toBe(true);
    expect(coordinator.hasRootConversation("pending-cid")).toBe(true);
    coordinator.discardSteerReservation("S");
  });

  it("retires a definite fallback if watchdog closes during reclassification", () => {
    const retired: Envelope[] = [];
    const envelope = inbound("reentrant");
    let coordinator!: CodexInterAgentTurnCoordinator;
    coordinator = new CodexInterAgentTurnCoordinator({
      createPlaceholder: () => true,
      removePlaceholder: () => {},
      retireDiscarded: envelopes => { retired.push(...envelopes); },
      reclassifyQueued: item => {
        coordinator.freezeForWatchdogFailStop();
        return item.mode;
      },
      onDispatch: () => true,
    });
    coordinator.reserveSteer("S", envelope, "reply-owed", 1);
    coordinator.attachSteerPlaceholder("S");
    coordinator.settleSteerReservation("S", true);
    expect(retired).toEqual([envelope]);
    expect(coordinator.pendingSteerReservationCount).toBe(0);
  });

  it("does not retire a cancelled queued fallback twice at watchdog freeze", () => {
    const slots = new Set<string>();
    const retired: Envelope[] = [];
    const envelope = inbound("cancelled");
    let token = "";
    const coordinator = new CodexInterAgentTurnCoordinator({
      createPlaceholder: id => { slots.add(id); return true; },
      removePlaceholder: id => { slots.delete(id); },
      retireDiscarded: envelopes => { retired.push(...envelopes); },
      onDispatch: batch => { token = batch.turnToken; slots.delete(batch.fallbackId!); return true; },
    });
    coordinator.reserveSteer("S", envelope, "reply-owed", 1);
    coordinator.attachSteerPlaceholder("S");
    coordinator.settleSteerReservation("S", true);
    expect(coordinator.pendingSteerReservationCount).toBe(0);
    const cancelled = coordinator.settle(token)!;
    coordinator.retireEnvelopes(cancelled.items.map(item => item.envelope));
    coordinator.freezeForWatchdogFailStop();
    expect(retired).toEqual([envelope]);
    expect(slots.size).toBe(0);
  });
});
