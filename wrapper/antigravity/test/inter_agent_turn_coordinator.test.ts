import { describe, expect, it } from "vitest";
import { createDeliveryAcknowledgementWiring, InterAgentTool } from "@kaoiro/agent-common";
import type { Envelope } from "@kaoiro/agent-common";
import {
  AntigravityInterAgentTurnCoordinator,
  type DispatchedAntigravityInterAgentBatch,
} from "../src/inter_agent_turn_coordinator.js";

function inbound(cid: string, deliverySeq?: number): Envelope {
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
    ...(deliverySeq === undefined ? {} : { delivery_seq: deliverySeq }),
  } as unknown as Envelope;
}

describe("AntigravityInterAgentTurnCoordinator", () => {
  it("rechecks a dispatched host-queued proposal through the real conversation track", async () => {
    const tool = new InterAgentTool({
      config: { agent_id: "self.agent", persona: { id: "self", name: "Self", sprite_set: "self" }, display_name: "Self", server_url: "ws://localhost:4000/wrapper" },
      getState: () => "idle", send: () => {},
    });
    const dispatched: DispatchedAntigravityInterAgentBatch[] = [];
    const removed: Envelope[] = [];
    let token = 0;
    const coordinator = new AntigravityInterAgentTurnCoordinator({
      createTurnToken: () => `turn-${++token}`,
      reclassifyQueued: (item) => tool.queuedInboundMode(item.envelope, item.mode),
      onTerminalQueued: (item) => removed.push(item.envelope),
      onDispatch: (batch) => dispatched.push(batch),
    });
    const first = inbound("active");
    coordinator.receive(first, (await tool.receiveInbound(first)).mode);
    const proposal = inbound("closed");
    proposal.payload.meta = { done: true, propose_next: "" };
    coordinator.receive(proposal, (await tool.receiveInbound(proposal)).mode);
    coordinator.settle("turn-1");
    coordinator.dispatchNextForPeer("peer.agent");
    expect(dispatched).toHaveLength(2);
    await tool.invoke({ to: "peer.agent", kind: "done", body: "done", conversation_id: "closed", done: true });
    const prepared = coordinator.prepareInput("turn-2");
    expect(prepared?.batch).toBeNull();
    expect(prepared?.removedConversationIds).toEqual(["closed"]);
    expect(removed).toEqual([proposal]);
  });

  it("suppresses an old queued proposal through the real conversation track and acknowledges it", async () => {
    const tool = new InterAgentTool({
      config: {
        agent_id: "self.agent",
        persona: { id: "self", name: "Self", sprite_set: "self" },
        display_name: "Self",
        server_url: "ws://localhost:4000/wrapper",
      },
      getState: () => "idle",
      send: () => {},
    });
    const dispatched: DispatchedAntigravityInterAgentBatch[] = [];
    const acknowledgements: number[] = [];
    const suppressed: Envelope[] = [];
    let tokens = 0;
    const coordinator = new AntigravityInterAgentTurnCoordinator({
      createTurnToken: () => `turn-${++tokens}`,
      reclassifyQueued: (item) => tool.queuedInboundMode(item.envelope, item.mode),
      onTerminalQueued: (item) => {
        suppressed.push(item.envelope);
        delivery.acknowledgeDelivery(item.envelope);
      },
      onDispatch: (batch) => dispatched.push(batch),
    });
    const delivery = createDeliveryAcknowledgementWiring(
      (seq) => acknowledgements.push(seq), coordinator,
    );
    delivery.onInterAgentDeliveryStatus({ acked_seq: 0 });
    const active = inbound("active", 1);
    coordinator.receive(active, (await tool.receiveInbound(active)).mode);
    const queued = inbound("queued", 2);
    queued.payload.meta = { done: true, propose_next: "" };
    coordinator.receive(queued, (await tool.receiveInbound(queued)).mode);
    await tool.invoke({ to: "peer.agent", kind: "done", body: "done", conversation_id: "queued", done: true });
    delivery.onTurnStart(dispatched[0]!.turnToken);
    const settled = coordinator.settle(dispatched[0]!.turnToken);
    coordinator.dispatchNextForPeer(settled!.peer);
    expect(dispatched).toHaveLength(1);
    expect(tokens).toBe(1);
    expect(suppressed).toEqual([queued]);
    expect(acknowledgements).toEqual([1, 2]);
  });

  it("binds a delivery sequence to the exact dispatched agy turn", () => {
    const coordinator = new AntigravityInterAgentTurnCoordinator({
      createTurnToken: () => "turn-1",
      onDispatch: () => {},
    });
    coordinator.receive(inbound("dispatch", 9), "reply-owed");

    expect(coordinator.deliverySequencesForTurn("not-started")).toEqual([]);
    expect(coordinator.deliverySequencesForTurn("turn-1")).toEqual([9]);
    expect(coordinator.deliverySequenceRangeForTurn("turn-1")).toEqual({
      first: 9,
      last: 9,
    });
    expect(coordinator.turnTokenForDeliverySequence(9)).toBe("turn-1");
  });

  it("does not let a stale same-conversation token release the active batch", () => {
    const dispatched: DispatchedAntigravityInterAgentBatch[] = [];
    const tokens = ["turn-1", "turn-2"];
    const coordinator = new AntigravityInterAgentTurnCoordinator({
      createTurnToken: () => tokens.shift()!,
      onDispatch: (batch) => dispatched.push(batch),
    });
    coordinator.receive(inbound("shared"), "reply-owed");
    coordinator.receive(inbound("shared"), "reply-owed");

    expect(coordinator.settle("stale-turn")).toBeUndefined();
    coordinator.dispatchNextForPeer("peer.agent");
    expect(dispatched).toHaveLength(1);

    expect(coordinator.settle("turn-1")?.turnToken).toBe("turn-1");
    coordinator.dispatchNextForPeer("peer.agent");
    expect(dispatched.map((batch) => batch.turnToken)).toEqual(["turn-1", "turn-2"]);
  });

  it("freezes unstarted work while retaining the active batch for recovery", () => {
    const dispatched: DispatchedAntigravityInterAgentBatch[] = [];
    const coordinator = new AntigravityInterAgentTurnCoordinator({
      createTurnToken: () => "active",
      onDispatch: (batch) => dispatched.push(batch),
    });
    coordinator.receive(inbound("active"), "reply-owed");
    coordinator.receive(inbound("pending"), "reply-owed");

    const retired: Envelope[] = [];
    expect(coordinator.freezeForWatchdogFailStop("active", (envelopes) => retired.push(...envelopes))).toEqual({
      droppedDispatched: 0,
      droppedPending: 1,
    });
    expect(retired.map((envelope) => envelope.payload.conversation_id)).toEqual(["pending"]);
    coordinator.dispatchNextForPeer("peer.agent");
    coordinator.receive(inbound("after-freeze"), "reply-owed");
    expect(dispatched).toHaveLength(1);
    expect(retired.map((envelope) => envelope.payload.conversation_id)).toEqual(["pending", "after-freeze"]);
  });
});


describe("recovery ownership", () => {
  const message = (cid: string) => inbound(cid);
  it("removes host-queued bodies before input preparation and preserves unrelated CIDs", () => {
    let next = 0;
    const coordinator = new AntigravityInterAgentTurnCoordinator({ createTurnToken: () => `T${++next}`, onDispatch: () => {} });
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
    const coordinator = new AntigravityInterAgentTurnCoordinator({ createTurnToken: () => `T${++next}`, onDispatch: () => {} });
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
    const coordinator = new AntigravityInterAgentTurnCoordinator({ createTurnToken: () => `T${++next}`, onDispatch: () => {} });
    coordinator.receive(message("active"), "reply-owed"); coordinator.receive(message("A"), "reply-owed"); coordinator.receive(message("B"), "reply-owed");
    coordinator.settle("T1"); coordinator.dispatchNextForPeer("peer.agent");
    const a = coordinator.claimRecovery("A", "peer.agent", "operator", () => true)!;
    const b = coordinator.claimRecovery("B", "peer.agent", "operator", () => true)!;
    for (const lease of reverse ? [b, a] : [a, b]) lease.rollback();
    expect(coordinator.prepareInput("T2")?.batch?.conversationIds).toEqual(["A", "B"]);
  });
  it("never skips an oversized oldest body and returns cancelled ownership once", () => {
    let next = 0;
    const coordinator = new AntigravityInterAgentTurnCoordinator({ createTurnToken: () => `T${++next}`, onDispatch: () => {} });
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
