import { describe, expect, it } from "vitest";
import { InterAgentTool, classifyInterAgentError, handoffToolResult } from "@kaoiro/agent-common";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { InterAgentIngressGate, InterAgentTurnCoordinator } from "../src/inter_agent_turn_coordinator.js";

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
  it("keeps T's same-CID obligation while folded y needs a recovery ticket", async () => {
    const coordinator = new InterAgentTurnCoordinator({ onDispatch: () => {}, createTurnToken: () => "T" });
    const old = inbound("peer", "same-cid", 1);
    const folded = inbound("peer", "same-cid", 2);
    coordinator.receive(old, "reply-owed");
    coordinator.prepareInput("T");
    const tool = new InterAgentTool({
      config, getState: () => "thinking", send: () => {}, replyBasisMode: () => "v1",
      claimRecovery: (cid, peer, fit, expectedTurn) => coordinator.claimRecovery(cid, peer, "T", fit, expectedTurn),
      sendInterAgent: async envelope => {
        expect(envelope.payload.in_reply_to).toBe(1);
        return { kind: "rejected", reason: "stale_reply_basis", details: { expected_peer_turn: 2 } };
      },
    });
    tool.prepareReplyInput("T", [old]);
    tool.beginReplyInput("T");
    tool.confirmReplyInput("T");
    expect(tool.notePendingInjection(old, "T")).toBe(true);
    const lease = tool.prepareFoldInput("T", [folded])!;
    expect(lease.activate()).toBe(true);
    coordinator.retainFolded([folded], "T");
    expect(tool.notePendingInjection(folded, "T")).toBe(true);
    const result = await tool.invoke({ to: "peer", conversation_id: "same-cid", kind: "response", body: "default reply" }, { origin: { token: "T" } });
    const fields = JSON.parse(result.content[0]!.text);
    expect(fields).toMatchObject({ error: "stale_reply_basis", folded_earlier: true, recovery: [folded], reply_authorization: { in_reply_to: 2 } });
    expect(handoffToolResult(result, () => {})).toBe(true);
    expect(tool.resolveTurnEnd("T", ["same-cid"], classifyInterAgentError({ reason: "api_error" }))).toHaveLength(1);
    expect(tool.pendingConversationIdsForTurn("T")).toEqual([]);
  });

  it("dispatches a same-peer priority lease while T is live and holds the ordinary successor", () => {
    const dispatched: string[] = [];
    let sequence = 0;
    const coordinator = new InterAgentTurnCoordinator({
      createTurnToken: () => `token-${++sequence}`,
      onDispatch: batch => dispatched.push(batch.turnToken),
    });
    coordinator.receive(inbound("peer", "work", 1), "reply-owed");
    coordinator.receive(inbound("peer", "yield", 1), "reply-owed", true);
    coordinator.receive(inbound("peer", "ordinary", 1), "reply-owed");
    expect(dispatched).toEqual(["token-1", "token-2"]);
    coordinator.prepareInput("token-2", false);
    coordinator.markPushed("token-2");
    expect(coordinator.settle("token-1").kind).toBe("settled");
    coordinator.dispatchNextForPeer("peer");
    expect(dispatched).toHaveLength(2);
    expect(coordinator.settle("token-2").kind).toBe("settled");
    coordinator.dispatchNextForPeer("peer");
    expect(dispatched).toEqual(["token-1", "token-2", "token-3"]);
  });

  it("offers ordinary input to the root scheduler beside an unpushed priority lease", () => {
    const dispatched: string[] = [];
    let sequence = 0;
    const coordinator = new InterAgentTurnCoordinator({
      createTurnToken: () => `token-${++sequence}`,
      onDispatch: batch => dispatched.push(batch.turnToken),
    });
    coordinator.receive(inbound("peer", "T", 1), "reply-owed");
    coordinator.receive(inbound("peer", "early", 1), "reply-owed", true);
    coordinator.receive(inbound("peer", "ordinary", 1), "reply-owed");
    coordinator.settle("token-1");
    coordinator.dispatchNextForPeer("peer");
    expect(dispatched).toEqual(["token-1", "token-2", "token-3"]);
    expect(coordinator.prepareInput("token-3")?.batch?.conversationIds).toEqual(["ordinary"]);
    expect(coordinator.settle("token-3").kind).toBe("settled");
    expect(coordinator.prepareInput("token-2")?.batch?.conversationIds).toEqual(["early"]);
  });

  it("turns a matched priority root into the peer's active batch and settles its envelopes", () => {
    const dispatched: string[] = [];
    let sequence = 0;
    const coordinator = new InterAgentTurnCoordinator({
      createTurnToken: () => `token-${++sequence}`,
      onDispatch: batch => dispatched.push(batch.turnToken),
    });
    coordinator.receive(inbound("peer", "work", 1), "reply-owed");
    coordinator.receive(inbound("peer", "cut", 1), "reply-owed", true);
    coordinator.receive(inbound("peer", "later", 1), "reply-owed");
    coordinator.markPushed("token-2");
    coordinator.settle("token-1");
    coordinator.dispatchNextForPeer("peer");
    expect(dispatched).toHaveLength(2);
    const root = coordinator.adoptPushedRoot("token-2", "root-F");
    expect(root).toMatchObject({ turnToken: "root-F", conversationIds: ["cut"] });
    expect(coordinator.deliveryEnvelopesForTurn("root-F")).toEqual(root!.items.map(item => item.envelope));
    coordinator.dispatchNextForPeer("peer");
    expect(dispatched).toHaveLength(2);
    expect(coordinator.settle("root-F")).toMatchObject({ kind: "settled", batch: { turnToken: "root-F" } });
    coordinator.dispatchNextForPeer("peer");
    expect(dispatched).toEqual(["token-1", "token-2", "token-3"]);
  });

  it("restores an already queued ordinary batch after a pushed root ends", () => {
    const dispatched: string[] = [];
    let sequence = 0;
    const coordinator = new InterAgentTurnCoordinator({
      createTurnToken: () => `token-${++sequence}`,
      onDispatch: batch => dispatched.push(batch.turnToken),
    });
    coordinator.receive(inbound("peer", "ordinary", 1), "reply-owed");
    coordinator.receive(inbound("peer", "cut", 1), "reply-owed", true);
    coordinator.receive(inbound("peer", "after", 1), "reply-owed");
    coordinator.markPushed("token-2");
    coordinator.adoptPushedRoot("token-2", "root-F");
    expect(coordinator.settle("root-F").kind).toBe("settled");
    coordinator.dispatchNextForPeer("peer");
    expect(dispatched).toHaveLength(2);
    expect(coordinator.settle("token-1").kind).toBe("settled");
    coordinator.dispatchNextForPeer("peer");
    expect(dispatched).toEqual(["token-1", "token-2", "token-3"]);
  });

  it("settles a cancelled suspended ordinary batch without releasing its live pushed root", () => {
    let sequence = 0;
    const coordinator = new InterAgentTurnCoordinator({
      createTurnToken: () => `token-${++sequence}`,
      onDispatch: () => {},
    });
    coordinator.receive(inbound("peer", "ordinary", 1), "reply-owed");
    coordinator.receive(inbound("peer", "cut", 1), "reply-owed", true);
    coordinator.markPushed("token-2");
    coordinator.adoptPushedRoot("token-2", "root-F");
    expect(coordinator.settle("token-1")).toMatchObject({ kind: "settled", batch: { conversationIds: ["ordinary"] } });
    expect(coordinator.settle("root-F")).toMatchObject({ kind: "settled", batch: { conversationIds: ["cut"] } });
  });

  it("drains a priority lease and ordinary peer work in arrival order after T retires", () => {
    let sequence = 0;
    const coordinator = new InterAgentTurnCoordinator({
      createTurnToken: () => `token-${++sequence}`,
      onDispatch: () => {},
    });
    coordinator.receive(inbound("peer", "T", 1), "reply-owed");
    coordinator.receive(inbound("peer", "early", 1), "reply-owed", true);
    coordinator.receive(inbound("peer", "ordinary", 1), "reply-owed");
    coordinator.settle("token-1");
    expect(coordinator.closeAndDrain().map(batch => batch.conversationIds)).toEqual([["early"], ["ordinary"]]);
  });

  it("re-hands a folded body after its original turn retires until confirmed input supersedes it", () => {
    const coordinator = new InterAgentTurnCoordinator({ onDispatch: () => {} });
    const folded = inbound("peer", "folded-cid", 2);
    coordinator.retainFolded([folded], "original-turn");

    expect(coordinator.claimRecovery("folded-cid", "peer", "notification-turn", () => false, 2))
      .toMatchObject({ envelopes: [], oversizedPending: true, recoverySource: "retained_fold" });
    const rehand = coordinator.claimRecovery("folded-cid", "peer", "notification-turn", () => true, 2);
    expect(rehand).toMatchObject({ envelopes: [folded], foldedEarlier: true });
    rehand?.commit();
    expect(coordinator.claimRecovery("folded-cid", "peer", "later-turn", () => true, 2)?.envelopes).toEqual([folded]);

    coordinator.retireFoldedBeforeConfirmed([inbound("peer", "folded-cid", 3)]);
    expect(coordinator.claimRecovery("folded-cid", "peer", "later-turn", () => true, 2)).toBeUndefined();
  });

  it("retires a folded recovery body once its ticket is used", () => {
    const coordinator = new InterAgentTurnCoordinator({ onDispatch: () => {} });
    const folded = inbound("peer", "folded-cid", 2);
    coordinator.retainFolded([folded], "original-turn");
    coordinator.creditFolded([folded]);
    expect(coordinator.claimRecovery("folded-cid", "peer", "later-turn", () => true, 2)).toBeUndefined();
  });

  it("bounds retained folded recovery bodies and counts capacity eviction by reason", () => {
    const reasons: string[] = [];
    const coordinator = new InterAgentTurnCoordinator({
      onDispatch: () => {}, onFoldRecoveryEvicted: reason => reasons.push(reason),
    });
    for (let index = 0; index < 257; index += 1) {
      coordinator.retainFolded([inbound("peer", `cid-${index}`, 1)], "T");
    }
    expect(reasons).toEqual(["fold_recovery_capacity"]);
    expect(coordinator.claimRecovery("cid-0", "peer", "N", () => true, 1)).toBeUndefined();
    expect(coordinator.claimRecovery("cid-256", "peer", "N", () => true, 1)?.foldedEarlier).toBe(true);
  });

  it("retires pending and late ingress after its terminal generation closes", () => {
    const ingress = new InterAgentIngressGate();
    const first = inbound("peer", "pending", 1);
    const late = inbound("peer", "late", 2);
    const retired: Envelope[] = [];
    const lease = ingress.begin(first);
    expect(ingress.close((envelopes) => retired.push(...envelopes))).toBe(1);
    expect(ingress.isTerminal(lease)).toBe(true);
    ingress.begin(late);
    expect(retired).toEqual([first, late]);
    ingress.finish(lease);
  });

  it("delivery sequence belongs to the exact dispatched turn", () => {
    const coordinator = new InterAgentTurnCoordinator({
      createTurnToken: () => "turn-1",
      onDispatch: () => {},
    });
    const message = inbound("peer", "dispatch", 1);
    (message as Envelope & { delivery_seq: number }).delivery_seq = 9;
    coordinator.receive(message, "reply-owed");
    expect(coordinator.deliverySequencesForTurn("not-started")).toEqual([]);
    expect(coordinator.deliverySequencesForTurn("turn-1")).toEqual([9]);
  });

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

    const retired: Envelope[] = [];
    expect(coordinator.freezeForWatchdogFailStop("token-1", (envelopes) => retired.push(...envelopes))).toEqual({
      droppedDispatched: 1,
      droppedPending: 1,
    });
    expect(retired.map((envelope) => envelope.payload.conversation_id)).toEqual(["cid-b1", "cid-a2"]);
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


describe("recovery ownership", () => {
  const message = (cid: string) => inbound("peer.agent", cid, 1);
  it("removes host-queued bodies before input preparation and preserves unrelated CIDs", () => {
    let next = 0;
    const coordinator = new InterAgentTurnCoordinator({ createTurnToken: () => `T${++next}`, onDispatch: () => {} });
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
    const coordinator = new InterAgentTurnCoordinator({ createTurnToken: () => `T${++next}`, onDispatch: () => {} });
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
    const coordinator = new InterAgentTurnCoordinator({ createTurnToken: () => `T${++next}`, onDispatch: () => {} });
    coordinator.receive(message("active"), "reply-owed"); coordinator.receive(message("A"), "reply-owed"); coordinator.receive(message("B"), "reply-owed");
    coordinator.settle("T1"); coordinator.dispatchNextForPeer("peer.agent");
    const a = coordinator.claimRecovery("A", "peer.agent", "operator", () => true)!;
    const b = coordinator.claimRecovery("B", "peer.agent", "operator", () => true)!;
    for (const lease of reverse ? [b, a] : [a, b]) lease.rollback();
    expect(coordinator.prepareInput("T2")?.batch?.conversationIds).toEqual(["A", "B"]);
  });
  it("never skips an oversized oldest body and returns cancelled ownership once", () => {
    let next = 0;
    const coordinator = new InterAgentTurnCoordinator({ createTurnToken: () => `T${++next}`, onDispatch: () => {} });
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
