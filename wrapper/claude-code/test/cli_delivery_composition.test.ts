import { describe, expect, it, vi } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { runClaudeCli } from "../src/cli.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

function inboundEnvelope(deliverySeq: number, turnNumber = 1): Envelope {
  return {
    version: "0",
    agent_id: "peer.agent",
    persona: { id: "peer", name: "Peer", sprite_set: "peer" },
    display_name: "Peer",
    ts: "2026-08-17T00:00:00Z",
    type: "inter_agent_message",
    state: "tool_running",
    payload: {
      to: config.agent_id,
      conversation_id: `c-${deliverySeq}`,
      turn_number: turnNumber,
      kind: "inform",
      body: "hello",
    },
    delivery_seq: deliverySeq,
  } as unknown as Envelope;
}

describe("Claude CLI delivery composition (issue #247)", () => {
  it("actual entrypoint connects status, handler, and host turn-start to one acknowledgement flow", async () => {
    const acknowledgements: number[] = [];
    let linkOptions!: Record<string, any>;
    let hostOptions!: Record<string, any>;

    const link = {
      acknowledgeInterAgentDelivery: (seq: number) => acknowledgements.push(seq),
      close: () => {},
      currentSessionId: () => null,
      send: () => {},
    };
    const host = {
      state: "idle",
      statusExtSnapshot: () => ({}),
      run: async () => {},
      send: async (
        _text: string,
        _attachments: unknown,
        _conversationIds: readonly string[],
        turnToken: string,
      ) => {
        hostOptions.onTurnStart({ turnToken });
      },
    };

    await runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      createServerLink: (_url, _agentId, options) => {
        linkOptions = options as unknown as Record<string, any>;
        queueMicrotask(() => {
          linkOptions.onPersonaPrompt("system prompt");
        });
        return link as never;
      },
      createHost: (_config, options) => {
        hostOptions = options as unknown as Record<string, any>;
        return host as never;
      },
    });

    expect(linkOptions.onInterAgentDeliveryStatus).toBeTypeOf("function");
    expect(linkOptions.onInterAgentMessage).toBeTypeOf("function");
    expect(hostOptions.onTurnStart).toBeTypeOf("function");

    linkOptions.onInterAgentDeliveryStatus({ acked_seq: 1 });
    // The actual production handler drops the stale turn before injection,
    // then injects the next fresh turn through the production coordinator.
    await linkOptions.onInterAgentMessage(inboundEnvelope(2, 0));
    await linkOptions.onInterAgentMessage(inboundEnvelope(3));

    await vi.waitFor(() => expect(acknowledgements).toEqual([2, 3]));
    hostOptions.onHostEnd({ error: {} });
  });
});
