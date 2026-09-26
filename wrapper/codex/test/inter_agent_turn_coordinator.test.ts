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
    expect(coordinator.claimRecovery("recover", "peer.agent", "T1", () => false)?.oversizedPending).toBe(true);
    expect(coordinator.unreadCount("T1")).toBe(2);
    const lease = coordinator.claimRecovery("recover", "peer.agent", "T1", e => e.length <= 1)!;
    expect(lease.envelopes).toEqual([first]); expect(coordinator.unreadCount("T1")).toBe(2);
    lease.rollback(); lease.rollback(); expect(coordinator.unreadCount("T1")).toBe(2);
    coordinator.settle("T1"); coordinator.dispatchNextForPeer("peer.agent");
    expect(coordinator.prepareInput("T2")?.batch?.items[0]?.envelope).toBe(first);
  });
});
