import { describe, expect, it } from "vitest";
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

    expect(coordinator.freezeForWatchdogFailStop("active")).toEqual({
      droppedDispatched: 0,
      droppedPending: 1,
    });
    coordinator.dispatchNextForPeer("peer.agent");
    coordinator.receive(inbound("after-freeze"), "reply-owed");
    expect(dispatched).toHaveLength(1);
  });
});
