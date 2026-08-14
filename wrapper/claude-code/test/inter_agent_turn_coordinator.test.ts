import { describe, expect, it } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { InterAgentTurnCoordinator } from "../src/inter_agent_turn_coordinator.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

function inbound(peer: string, conversationId: string, turnNumber: number): Envelope {
  return {
    version: "0",
    agent_id: peer,
    persona: { id: peer, name: peer, sprite_set: peer },
    display_name: peer,
    ts: "2026-08-14T00:00:00Z",
    type: "inter_agent_message",
    state: "tool_running",
    payload: {
      to: config.agent_id,
      conversation_id: conversationId,
      turn_number: turnNumber,
      kind: "inform",
      body: "hello",
      meta: { done: false, propose_next: "" },
      owner: { kind: "user", id: "operator" },
    },
    ext: {},
  };
}

describe("InterAgentTurnCoordinator (issue #246)", () => {
  it("same-CID successor は先行 token の CID resolve 後まで dispatch しない", () => {
    const dispatched: { token: string; cids: readonly string[] }[] = [];
    let sequence = 0;
    const coordinator = new InterAgentTurnCoordinator({
      createTurnToken: () => `token-${++sequence}`,
      onDispatch: (batch) => {
        dispatched.push({ token: batch.turnToken, cids: batch.conversationIds });
      },
    });

    coordinator.receive(inbound("peer", "same-cid", 1), "reply-owed");
    coordinator.receive(inbound("peer", "same-cid", 2), "reply-owed");
    expect(dispatched).toEqual([{ token: "token-1", cids: ["same-cid"] }]);

    const first = coordinator.settle("token-1");
    expect(first).toMatchObject({
      kind: "settled",
      batch: { conversationIds: ["same-cid"] },
    });
    // The caller must resolve this old CID before dispatching its successor.
    // This pins the order that prevents InterAgentTool's one-CID pending map
    // from being overwritten before the prior turn is resolved.
    expect(dispatched).toHaveLength(1);
    coordinator.dispatchNextForPeer("peer");
    expect(dispatched).toEqual([
      { token: "token-1", cids: ["same-cid"] },
      { token: "token-2", cids: ["same-cid"] },
    ]);
  });

  it("late old-token settlement は同じ peer の新 generation を解放しない", () => {
    const dispatched: string[] = [];
    let sequence = 0;
    const coordinator = new InterAgentTurnCoordinator({
      createTurnToken: () => `token-${++sequence}`,
      onDispatch: (batch) => dispatched.push(batch.turnToken),
    });

    coordinator.receive(inbound("peer", "cid", 1), "reply-owed");
    const first = coordinator.settle("token-1");
    expect(first.kind).toBe("settled");
    coordinator.dispatchNextForPeer("peer");
    coordinator.receive(inbound("peer", "cid", 2), "reply-owed");
    // token-2 is now active; the third message queues behind it.
    coordinator.receive(inbound("peer", "cid", 3), "reply-owed");
    expect(dispatched).toEqual(["token-1", "token-2"]);

    expect(coordinator.settle("token-1")).toEqual({
      kind: "stale",
      turnToken: "token-1",
    });
    expect(dispatched).toEqual(["token-1", "token-2"]);

    const second = coordinator.settle("token-2");
    expect(second.kind).toBe("settled");
    coordinator.dispatchNextForPeer("peer");
    expect(dispatched).toEqual(["token-1", "token-2", "token-3"]);
  });

  it("closeAndDrain は peer ごとに dispatched generation を先にし、FIFO pending を一度ずつ返す", () => {
    const dispatched: string[] = [];
    let sequence = 0;
    const coordinator = new InterAgentTurnCoordinator({
      createTurnToken: () => `token-${++sequence}`,
      onDispatch: (batch) => dispatched.push(batch.turnToken),
    });

    coordinator.receive(inbound("peer-a", "a1", 1), "reply-owed");
    coordinator.receive(inbound("peer-a", "a2", 1), "reply-owed");
    coordinator.receive(inbound("peer-b", "b1", 1), "reply-owed");
    coordinator.receive(inbound("peer-b", "b2", 1), "reply-owed");

    expect(dispatched).toEqual(["token-1", "token-2"]);
    expect(
      coordinator.closeAndDrain().map((batch) => ({
        peer: batch.peer,
        cids: batch.conversationIds,
      })),
    ).toEqual([
      { peer: "peer-a", cids: ["a1"] },
      { peer: "peer-a", cids: ["a2"] },
      { peer: "peer-b", cids: ["b1"] },
      { peer: "peer-b", cids: ["b2"] },
    ]);
    expect(coordinator.closeAndDrain()).toEqual([]);
    expect(coordinator.settle("token-1")).toEqual({
      kind: "stale",
      turnToken: "token-1",
    });
    coordinator.dispatchNextForPeer("peer-a");
    expect(dispatched).toEqual(["token-1", "token-2"]);
    expect(() => coordinator.receive(inbound("peer-a", "a3", 1), "reply-owed")).toThrow(
      "inter-agent turn coordinator is closed",
    );
  });

  it("issue #248: watchdog fail-stop は started token を未確定のまま残し、未開始の coordinator work だけを凍結する", () => {
    const dispatched: string[] = [];
    let sequence = 0;
    const coordinator = new InterAgentTurnCoordinator({
      createTurnToken: () => `token-${++sequence}`,
      onDispatch: (batch) => dispatched.push(batch.turnToken),
    });
    // Different peers may both be dispatched, but AgentHost's input barrier
    // has only yielded token-1. The same peer's successor stays pending.
    coordinator.receive(inbound("peer-a", "cid-a1", 1), "reply-owed");
    coordinator.receive(inbound("peer-a", "cid-a2", 2), "reply-owed");
    coordinator.receive(inbound("peer-b", "cid-b1", 1), "reply-owed");
    expect(dispatched).toEqual(["token-1", "token-2"]);

    expect(coordinator.freezeForWatchdogFailStop("token-1")).toEqual({
      droppedDispatched: 1,
      droppedPending: 1,
    });
    // The terminal result can still settle the exact started generation, but
    // no peer becomes dispatchable and no successor is created afterwards.
    expect(coordinator.settle("token-1")).toMatchObject({
      kind: "settled",
      batch: { conversationIds: ["cid-a1"] },
    });
    expect(coordinator.settle("token-2")).toEqual({
      kind: "stale",
      turnToken: "token-2",
    });
    coordinator.dispatchNextForPeer("peer-a");
    expect(dispatched).toEqual(["token-1", "token-2"]);
    expect(() => coordinator.receive(inbound("peer-c", "cid-c1", 1), "reply-owed")).toThrow(
      "inter-agent turn coordinator is closed",
    );
  });

  it("issue #248: active token が不明なら dispatched / pending を全凍結し、古い token は全て stale になる", () => {
    const dispatched: string[] = [];
    let sequence = 0;
    const coordinator = new InterAgentTurnCoordinator({
      createTurnToken: () => `token-${++sequence}`,
      onDispatch: (batch) => dispatched.push(batch.turnToken),
    });
    coordinator.receive(inbound("peer-a", "a1", 1), "reply-owed");
    coordinator.receive(inbound("peer-a", "a2", 2), "reply-owed");
    coordinator.receive(inbound("peer-b", "b1", 1), "reply-owed");
    coordinator.receive(inbound("peer-b", "b2", 2), "reply-owed");
    expect(dispatched).toEqual(["token-1", "token-2"]);

    expect(coordinator.freezeForWatchdogFailStop()).toEqual({
      droppedDispatched: 2,
      droppedPending: 2,
    });
    for (const token of ["token-1", "token-2"]) {
      expect(coordinator.settle(token)).toEqual({ kind: "stale", turnToken: token });
    }
    coordinator.dispatchNextForPeer("peer-a");
    coordinator.dispatchNextForPeer("peer-b");
    expect(dispatched).toEqual(["token-1", "token-2"]);
    expect(() => coordinator.receive(inbound("peer-c", "c1", 1), "reply-owed")).toThrow(
      "inter-agent turn coordinator is closed",
    );
  });
});
