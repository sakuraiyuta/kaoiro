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
  agentId = "peer.agent",
): Envelope {
  return {
    version: "0",
    agent_id: agentId,
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

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
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

  it("lifecycle sink failure does not block delivery ack or dispatch to host.send", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      if (String(chunk).startsWith("[kaoiro][codex-lifecycle] ")) {
        throw new Error("diagnostic sink unavailable");
      }
      return true;
    });
    const acknowledgements: number[] = [];
    const sends: string[] = [];
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
        text: string,
        _attachments: unknown,
        _conversationIds: readonly string[],
        turnToken: string,
      ) => {
        sends.push(text);
        hostOptions.onTurnStart({ turnToken });
      },
    };

    try {
      await runCodexCli({
        parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
        loadConfig: () => ({ ...config }),
        createServerLink: (_url, _agentId, options) => {
          linkOptions = options as unknown as Record<string, any>;
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

      (linkOptions.onInterAgentDeliveryStatus as (status: { acked_seq: number }) => void)({
        acked_seq: 19,
      });
      await (linkOptions.onInterAgentMessage as (envelope: Envelope) => Promise<void>)(
        inboundEnvelope(20),
      );
      await vi.waitFor(() => {
        expect(acknowledgements).toEqual([20]);
        expect(sends).toHaveLength(1);
      });
      expect(sends[0]).toContain("hello");
    } finally {
      stderr.mockRestore();
    }
  });

  it.each([
    {
      label: "authoritative terminal",
      finish: (options: Record<string, any>, token: string) => {
        options.onTurnBoundary({ turnToken: token });
        options.onLifecycle({
          kind: "terminal",
          turnToken: token,
          type: "turn.completed",
          authoritative: true,
        });
      },
    },
    {
      label: "terminal-less EOF",
      finish: (options: Record<string, any>, token: string) => {
        options.onTurnBoundary({ turnToken: token });
        options.onLifecycle({
          kind: "stream_eof",
          turnToken: token,
          terminalSeen: false,
        });
      },
    },
    {
      label: "runStreamed rejection",
      finish: (options: Record<string, any>, token: string) => {
        options.onTurnBoundary({ turnToken: token });
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

  it.each([
    {
      label: "terminal-less EOF",
      detect: (options: Record<string, any>, token: string) => {
        options.onTurnBoundary({ turnToken: token });
        options.onLifecycle({
          kind: "stream_eof",
          turnToken: token,
          terminalSeen: false,
        });
      },
    },
    {
      label: "runStreamed rejection",
      detect: (options: Record<string, any>, token: string) => {
        options.onTurnBoundary({ turnToken: token });
      },
    },
  ])(
    "$label の boundary 後に遅延 diagnostics を待っても watchdog timer が発火しない",
    async ({ detect }) => {
      vi.useFakeTimers();
      try {
        let hostOptions!: Record<string, any>;
        let interrupts = 0;
        let failStops = 0;
        const link = { close: () => {}, currentSessionId: () => null, send: () => {} };
        const host = {
          state: "idle",
          statusExtSnapshot: () => ({}),
          requestInterruptForTurn: () => {
            interrupts += 1;
            return true;
          },
          failStopTurnForWatchdog: () => {
            failStops += 1;
            return true;
          },
          failStopForWatchdogAttributionUnknown: () => {
            failStops += 1;
            return true;
          },
          run: async () => {
            hostOptions.onTurnStart({ turnToken: "delayed" });
            detect(hostOptions, "delayed");
            await vi.advanceTimersByTimeAsync(31 * 60 * 1_000 + 1);
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

        expect(interrupts).toBe(0);
        expect(failStops).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("lifecycle stderr write failure does not alter turn outcome or watchdog ownership", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      if (String(chunk).startsWith("[kaoiro][codex-lifecycle] ")) {
        throw new Error("diagnostic sink unavailable");
      }
      return true;
    });
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
        hostOptions.onTurnStart({ turnToken: "telemetry-a" });
        hostOptions.onTurnBoundary({ turnToken: "telemetry-a" });
        hostOptions.onLifecycle({
          kind: "terminal",
          turnToken: "telemetry-a",
          type: "turn.completed",
          authoritative: true,
        });
        hostOptions.onTurnStart({ turnToken: "telemetry-b" });
      },
    };

    try {
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
    } finally {
      stderr.mockRestore();
    }

    expect(fallbackStops).toBe(0);
  });

  it("queued fail-stop finalization removes the CLI lifecycle range", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runGate = deferred<void>();
    const hostReady = deferred<void>();
    const lifecycle: Record<string, unknown>[] = [];
    let hostOptions!: Record<string, any>;
    let linkOptions!: Record<string, any>;
    const sentTokens: string[] = [];
    const link = {
      close: () => {},
      currentSessionId: () => null,
      send: () => {},
    };
    const host = {
      state: "idle",
      statusExtSnapshot: () => ({}),
      send: async (
        _text: string,
        _attachments: unknown,
        _conversationIds: readonly string[],
        turnToken: string,
      ) => {
        sentTokens.push(turnToken);
        if (sentTokens.length === 1) hostOptions.onTurnStart({ turnToken });
      },
      run: async () => {
        hostReady.resolve();
        await runGate.promise;
      },
    };

    try {
      const running = runCodexCli({
        parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
        loadConfig: () => ({ ...config }),
        createServerLink: (_url, _agentId, options) => {
          linkOptions = options as unknown as Record<string, any>;
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
      await hostReady.promise;
      await (linkOptions.onInterAgentMessage as (envelope: Envelope) => Promise<void>)(
        inboundEnvelope(10, 1, "one", "peer.one"),
      );
      await (linkOptions.onInterAgentMessage as (envelope: Envelope) => Promise<void>)(
        inboundEnvelope(11, 1, "two", "peer.two"),
      );
      await vi.waitFor(() => expect(sentTokens).toHaveLength(2));

      const activeToken = sentTokens[0]!;
      const queuedToken = sentTokens[1]!;
      hostOptions.onTurnEnd({
        turnToken: queuedToken,
        conversationIds: ["c-11"],
        error: { detail: "watchdog fail-stop" },
        cancellation: { kind: "watchdog_fail_stop", started: false },
      });
      hostOptions.onLifecycle({
        kind: "sdk_event",
        turnToken: queuedToken,
        type: "thread.started",
      });
      const beforeFinalization = stderr.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.startsWith("[kaoiro][codex-lifecycle] "))
        .map((line) => JSON.parse(line.slice("[kaoiro][codex-lifecycle] ".length)))
        .at(-1);
      expect(beforeFinalization).toMatchObject({ seq_first: 11, seq_last: 11 });

      hostOptions.onWatchdogFailStop({ turnToken: activeToken, attribution: "exact" });
      hostOptions.onTurnFinalized({ turnToken: queuedToken });
      hostOptions.onLifecycle({
        kind: "sdk_event",
        turnToken: queuedToken,
        type: "thread.started",
      });
      const afterFinalization = stderr.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.startsWith("[kaoiro][codex-lifecycle] "))
        .map((line) => JSON.parse(line.slice("[kaoiro][codex-lifecycle] ".length)))
        .at(-1);
      expect(afterFinalization).not.toHaveProperty("seq_first");
      expect(afterFinalization).not.toHaveProperty("seq_last");

      runGate.resolve();
      await running;
    } finally {
      runGate.resolve();
      stderr.mockRestore();
    }
  });

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
