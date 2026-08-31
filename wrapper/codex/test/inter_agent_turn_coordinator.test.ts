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
    const frozen = coordinator.freezeForWatchdogFailStop("turn-active");
    expect(frozen).toEqual({ droppedDispatched: 0, droppedPending: 1 });

    coordinator.dispatchNextForPeer("peer.agent");
    coordinator.receive(inbound("after-freeze"), "reply-owed");
    expect(dispatched).toHaveLength(1);
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
