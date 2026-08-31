import { describe, expect, it, vi } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { runCodexCli } from "../src/cli.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

function inboundEnvelope(
  deliverySeq: number,
  turnNumber = 1,
  body = "hello",
): Envelope {
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
      body,
    },
    delivery_seq: deliverySeq,
  } as unknown as Envelope;
}

describe("Codex CLI delivery composition (issue #247)", () => {
  it("actual entrypoint connects status, handler, and host turn-start to one acknowledgement flow", async () => {
    const acknowledgements: number[] = [];
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
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
        hostOptions.onLifecycle({ kind: "turn_start", turnToken });
        hostOptions.onTurnStart({ turnToken });
        hostOptions.onLifecycle({
          kind: "sdk_event",
          turnToken,
          type: "thread.started",
        });
        hostOptions.onLifecycle({
          kind: "terminal",
          turnToken,
          type: "turn.completed",
          authoritative: true,
        });
        hostOptions.onTurnEnd({
          turnToken,
          conversationIds: ["c-3"],
        });
        hostOptions.onLifecycle({
          kind: "stream_eof",
          turnToken,
          terminalSeen: true,
        });
      },
    };

    try {
      await runCodexCli({
        parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
        loadConfig: () => ({ ...config }),
        createServerLink: (_url, _agentId, options) => {
          linkOptions = options as unknown as Record<string, any>;
          queueMicrotask(() => {
            (linkOptions.onPersonaPrompt as (prompt: string) => void)("system prompt");
          });
          return link as never;
        },
        createHost: (_config, options) => {
          hostOptions = options as unknown as Record<string, any>;
          return host as never;
        },
        prepareStartup: async () => {},
      });

    expect(linkOptions.onInterAgentDeliveryStatus).toBeTypeOf("function");
    expect(linkOptions.onInterAgentMessage).toBeTypeOf("function");
    expect(hostOptions.onTurnStart).toBeTypeOf("function");

    (linkOptions.onInterAgentDeliveryStatus as (status: { acked_seq: number }) => void)({
      acked_seq: 1,
    });
    // The actual production handler drops the stale turn before injection,
    // then injects the next fresh turn through the production coordinator.
    await (linkOptions.onInterAgentMessage as (envelope: Envelope) => Promise<void>)(
      inboundEnvelope(2, 0),
    );
    await (linkOptions.onInterAgentMessage as (envelope: Envelope) => Promise<void>)(
      inboundEnvelope(3, 1, "INBOUND_BODY_SENTINEL"),
    );

      await vi.waitFor(() => expect(acknowledgements).toEqual([2, 3]));
      const lifecycleLines = stderr.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.startsWith("[kaoiro][codex-lifecycle] "))
        .map((line) => JSON.parse(line.slice("[kaoiro][codex-lifecycle] ".length)));
      expect(lifecycleLines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: "delivery_ack", seq: 2 }),
          expect.objectContaining({
            event: "dispatch_queued",
            seq_first: 3,
            seq_last: 3,
          }),
          expect.objectContaining({
            event: "delivery_ack",
            seq: 3,
            seq_first: 3,
            seq_last: 3,
          }),
          expect.objectContaining({
            event: "turn_start",
            turn_token: expect.any(String),
            seq_first: 3,
            seq_last: 3,
          }),
          expect.objectContaining({
            event: "sdk_event",
            type: "thread.started",
            seq_first: 3,
            seq_last: 3,
          }),
          expect.objectContaining({
            event: "terminal",
            type: "turn.completed",
            authoritative: true,
            seq_first: 3,
            seq_last: 3,
          }),
          expect.objectContaining({
            event: "stream_eof",
            terminal_seen: true,
            seq_first: 3,
            seq_last: 3,
          }),
        ]),
      );
      const expectedKeys: Record<string, string[]> = {
        dispatch_queued: ["at", "event", "seq_first", "seq_last", "turn_token"],
        delivery_ack: ["at", "event", "seq"],
        turn_start: ["at", "event", "seq_first", "seq_last", "turn_token"],
        sdk_event: ["at", "event", "seq_first", "seq_last", "turn_token", "type"],
        terminal: [
          "at",
          "authoritative",
          "event",
          "seq_first",
          "seq_last",
          "turn_token",
          "type",
        ],
        stream_eof: [
          "at",
          "event",
          "seq_first",
          "seq_last",
          "terminal_seen",
          "turn_token",
        ],
      };
      for (const record of lifecycleLines) {
        const expected =
          record.event === "delivery_ack" && record.turn_token !== undefined
            ? ["at", "event", "seq", "seq_first", "seq_last", "turn_token"]
            : expectedKeys[record.event as string];
        expect(expected).toBeDefined();
        expect(Object.keys(record).sort()).toEqual(expected!.slice().sort());
        expect(JSON.stringify(record)).not.toContain("INBOUND_BODY_SENTINEL");
      }
    } finally {
      stderr.mockRestore();
    }
  });

  it.each([
    {
      label: "authoritative terminal",
      finish: (options: Record<string, any>, token: string) => {
        options.onLifecycle({
          kind: "terminal",
          turnToken: token,
          type: "turn.completed",
          authoritative: true,
        });
        options.onTurnEnd({ turnToken: token, conversationIds: [] });
      },
    },
    {
      label: "terminal-less error",
      finish: (options: Record<string, any>, token: string) => {
        options.onTurnEnd({
          turnToken: token,
          conversationIds: [],
          error: { detail: "stream rejected" },
        });
      },
    },
  ])(
    "$label の後に次 turn を watchdog attribution failure なしで開始できる",
    async ({ finish }) => {
      let hostOptions!: Record<string, any>;
      let fallbackStops = 0;
      const link = { close: () => {}, currentSessionId: () => null, send: () => {} };
      const host = {
        state: "idle",
        statusExtSnapshot: () => ({}),
        requestInterruptForTurn: () => true,
        failStopTurnForWatchdog: () => true,
        failStopForWatchdogAttributionUnknown: () => {
          fallbackStops += 1;
          return true;
        },
        run: async () => {
          hostOptions.onTurnStart({ turnToken: "normal-a" });
          finish(hostOptions, "normal-a");
          hostOptions.onTurnStart({ turnToken: "normal-b" });
          finish(hostOptions, "normal-b");
        },
      };

      await runCodexCli({
        parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
        loadConfig: () => ({ ...config }),
        createServerLink: (_url, _agentId, options) => {
          queueMicrotask(() => {
            (options.onPersonaPrompt as (prompt: string) => void)("system prompt");
          });
          return link as never;
        },
        createHost: (_config, options) => {
          hostOptions = options as unknown as Record<string, any>;
          return host as never;
        },
        prepareStartup: async () => {},
      });

      expect(fallbackStops).toBe(0);
    },
  );

  it("runCodexCli の実組成が watchdog を turn-start に接続し、attribution failure を host へ返す", async () => {
    let hostOptions!: Record<string, any>;
    let fallbackStops = 0;
    const link = {
      close: () => {},
      currentSessionId: () => null,
      send: () => {},
    };
    const host = {
      state: "idle",
      statusExtSnapshot: () => ({}),
      requestInterruptForTurn: () => true,
      failStopTurnForWatchdog: () => true,
      failStopForWatchdogAttributionUnknown: () => {
        fallbackStops += 1;
        return true;
      },
      run: async () => {
        hostOptions.onTurnStart({ turnToken: "composition-a" });
        // A second active token is an attribution invariant failure. The
        // production CLI must route that failure to the real host callback.
        hostOptions.onTurnStart({ turnToken: "composition-b" });
      },
    };

    await runCodexCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      createServerLink: (_url, _agentId, options) => {
        queueMicrotask(() => {
          (options.onPersonaPrompt as (prompt: string) => void)("system prompt");
        });
        return link as never;
      },
      createHost: (_config, options) => {
        hostOptions = options as unknown as Record<string, any>;
        return host as never;
      },
      prepareStartup: async () => {},
    });

    expect(hostOptions.onTurnProgress).toBeTypeOf("function");
    expect(hostOptions.onWatchdogFailStop).toBeTypeOf("function");
    expect(fallbackStops).toBe(1);
  });
});
