import { describe, expect, it, vi } from "vitest";
import { InterAgentAdmission, InterAgentInputLifecycle, InterAgentTool } from "@kaoiro/agent-common";
import type { Envelope, InterAgentMessagePayload, WrapperConfig } from "@kaoiro/agent-common";
import { handleAntigravityInterAgentMessage } from "../src/inter_agent_message_handler.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

function inbound(conversationId: string, turnNumber: number, deliverySeq: number): Envelope {
  return {
    version: "0",
    agent_id: "peer.agent",
    persona: { id: "peer", name: "Peer", sprite_set: "peer" },
    display_name: "Peer",
    ts: "2026-10-03T00:00:00Z",
    type: "inter_agent_message",
    state: "thinking",
    payload: {
      to: config.agent_id,
      conversation_id: conversationId,
      turn_number: turnNumber,
      kind: "inform",
      body: "peer input",
      meta: { done: false, propose_next: "" },
      owner: { kind: "user", id: "operator" },
    },
    ext: {},
    delivery_seq: deliverySeq,
  } as Envelope;
}

describe("Antigravity receiver overload handling", () => {
  it("accepts the overload notice before acknowledging the refused original", async () => {
    const notices: Envelope[] = [];
    const injected: Envelope[] = [];
    const acknowledged: Envelope[] = [];
    const stages: string[] = [];
    const retired = vi.fn(() => true);
    const inputLifecycle = new InterAgentInputLifecycle({
      maxPendingItems: 1,
      currentIdentity: () => ({ incarnation: "inc", generation: "gen" }),
      sendNotice: async notice => { notices.push(notice); return "accepted"; },
      acknowledgeDelivery: envelope => { acknowledged.push(envelope); },
      settleStage: (_envelope, reason) => { stages.push(reason); },
    });
    const tool = new InterAgentTool({
      inputLifecycle,
      config: { ...config, inter_agent_backlog_max_items: 1 },
      getState: () => "thinking",
      replyBasisMode: () => "v1",
      send: () => {},
      sendInterAgent: async () => ({ kind: "accepted", stamp: null }),
    });
    const receive = (envelope: Envelope) => handleAntigravityInterAgentMessage({
      interAgent: tool,
      send: () => {},
      acknowledgeDelivery: item => acknowledged.push(item),
      retirementCapability: () => "supported",
      retireDelivery: retired,
      settleStage: (_item, reason) => stages.push(reason),
      inject: item => injected.push(item),
      log: () => {},
    }, envelope);
    const first = inbound("overload-handler", 1, 10);
    const refused = inbound("overload-handler", 2, 11);

    await receive(first);
    await receive(refused);

    expect(injected).toEqual([first]);
    expect(notices).toHaveLength(1);
    expect((notices[0]!.payload as unknown as InterAgentMessagePayload).error?.code).toBe("receiver_overloaded");
    expect(acknowledged).toEqual([refused]);
    expect(retired).not.toHaveBeenCalled();
    expect(stages).toEqual(["receiver_overloaded"]);
    expect(tool.inputLifecycle.reservationFor(first)).toBeDefined();
  });

  it("bounds a null-tool fallback with the production shared admission instance", async () => {
    const admission = new InterAgentAdmission(1);
    const earlier = inbound("null-tool-earlier", 1, 20);
    const reservation = admission.admit(earlier);
    expect(reservation.kind).toBe("reserved");
    const acknowledged: Envelope[] = [];
    const injected: Envelope[] = [];
    const retired = vi.fn(() => true);
    const refused = inbound("null-tool-refused", 1, 21);

    await handleAntigravityInterAgentMessage({
      interAgent: null,
      inputLifecycle: new InterAgentInputLifecycle({
        admission,
        currentIdentity: () => ({ incarnation: "inc", generation: "gen" }),
        retirementCapability: () => "supported",
        acknowledgeDelivery: item => acknowledged.push(item),
        retireDelivery: retired,
      }),
      send: () => {},
      acknowledgeDelivery: item => acknowledged.push(item),
      inject: item => injected.push(item),
      log: () => {},
    }, refused);

    expect(injected).toEqual([]);
    expect(retired).toHaveBeenCalledWith(refused);
    expect(acknowledged).toEqual([]);
    expect(admission.counts().total).toBe(1);
  });
});
