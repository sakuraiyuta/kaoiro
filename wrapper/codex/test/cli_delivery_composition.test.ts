import { describe, expect, it, vi } from "vitest";
import { handoffToolResult } from "@kaoiro/agent-common";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { runCodexCli } from "../src/cli.js";
import { phoenixLoopback } from "./fixtures/phoenix_loopback.js";

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
  it("reports a consumed waiter reply at the CLI's committed tool-result handoff", async () => {
    const wire = await phoenixLoopback(() => ({
      inter_agent_reply_basis: "v1",
      inter_agent_delivery_modes: "v1",
      inter_agent_delivery_incarnation: "server-incarnation",
      work_control: "v1",
    }));
    let hostOptions!: Record<string, any>;
    let finishHost!: () => void;
    let startHost!: () => void;
    const finished = new Promise<void>(resolve => { finishHost = resolve; });
    const started = new Promise<void>(resolve => { startHost = resolve; });
    const running = runCodexCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config, server_url: wire.url }),
      createHost: (_config, options) => {
        hostOptions = options as unknown as Record<string, any>;
        return {
          state: "idle", statusExtSnapshot: () => ({}),
          activeInterAgentTurnToken: () => "waiter-turn",
          run: async () => { startHost(); await finished; },
          send: async () => {}, close: () => {},
        } as never;
      },
      prepareStartup: async () => {},
    });
    try {
      await vi.waitFor(() => expect(wire.joins).toBe(1));
      wire.push("persona_prompt", { prompt: "system prompt" });
      await started;
      hostOptions.onTurnStart({ turnToken: "waiter-turn", conversationIds: [] });
      const sendTool = (hostOptions.toolDescriptors as Array<{ name: string; handler: (input: Record<string, unknown>, context?: unknown) => Promise<any> }>)
        .find(descriptor => descriptor.name === "send_to_agent");
      expect(sendTool).toBeDefined();

      const waiting = sendTool!.handler({
        to: "peer.agent", conversation_id: "waiter-cli", kind: "query", body: "question",
        wait_for_response: true, timeout_ms: 2_000,
      }, { origin: { token: "waiter-turn" } });
      await vi.waitFor(() => expect(wire.received.some(item =>
        item.event === "envelope" && item.payload.type === "inter_agent_message",
      )).toBe(true));
      const reply = inboundEnvelope(1, 2);
      reply.payload.conversation_id = "waiter-cli";
      reply.payload.kind = "response";
      wire.push("envelope", reply as unknown as Record<string, unknown>);
      const result = await waiting;
      const stages = () => wire.received.filter(item => item.event === "delivery_stage").map(item => item.payload);
      await vi.waitFor(() => expect(stages().map(stage => stage.stage)).toEqual(["queued"]));
      expect(wire.received.filter(item => item.event === "delivery_ack")).toHaveLength(0);

      expect(handoffToolResult(result, () => {})).toBe(true);
      await vi.waitFor(() => expect(stages().map(stage => stage.stage)).toEqual(["queued", "submitted"]));
      expect(stages()[1]).toMatchObject({ delivery_seq: 1, handoff: "tool_result" });
      await vi.waitFor(() => expect(wire.received.filter(item => item.event === "delivery_ack")).toHaveLength(1));

      hostOptions.onTurnEnd({ turnToken: "waiter-turn", conversationIds: ["waiter-cli"] });
      await vi.waitFor(() => expect(stages().map(stage => stage.stage)).toEqual(["queued", "submitted", "settled"]));
      expect(stages()[2]).toMatchObject({ delivery_seq: 1, reason: "turn_end" });
      hostOptions.onTurnFinalized({ turnToken: "waiter-turn" });
    } finally {
      finishHost();
      await running;
      await wire.close();
    }
  });

  it("captures a delivery before receiveInbound waits across an identity change", async () => {
    let identity = "old-incarnation";
    const reports: Array<Record<string, unknown>> = [];
    let releaseDone!: (value: { kind: "rejected"; reason: string }) => void;
    const doneAcceptance = new Promise<{ kind: "rejected"; reason: string }>(resolve => { releaseDone = resolve; });
    let linkOptions!: Record<string, any>;
    let hostOptions!: Record<string, any>;
    let finishHost!: () => void;
    let startHost!: () => void;
    const finished = new Promise<void>(resolve => { finishHost = resolve; });
    const started = new Promise<void>(resolve => { startHost = resolve; });
    const running = runCodexCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      createServerLink: (_url, _agentId, options) => {
        linkOptions = options as unknown as Record<string, any>;
        queueMicrotask(() => { options.onReplyBasisMode!("v1"); options.onPersonaPrompt!("system prompt"); });
        return {
          sendInterAgent: async (envelope: Envelope) =>
            envelope.payload.kind === "done" ? doneAcceptance : { kind: "accepted", stamp: null },
          send: () => {}, close: () => {}, currentSessionId: () => null,
          deliveryIncarnation: () => identity,
          deliveryGeneration: () => "generation",
          reportDeliveryStage: (report: Record<string, unknown>) => { reports.push(report); return true; },
          acknowledgeInterAgentDelivery: () => {},
          retireInterAgentDeliveries: () => true,
          flushInterAgentRetirements: async () => {},
          reportDisconnectIntent: async () => true,
        } as never;
      },
      createHost: (_config, options) => {
        hostOptions = options as unknown as Record<string, any>;
        return {
          state: "tool_running", statusExtSnapshot: () => ({}),
          activeInterAgentTurnToken: () => "identity-turn",
          run: async () => { startHost(); await finished; },
          send: async () => {}, close: () => {},
        } as never;
      },
      prepareStartup: async () => {},
    });
    let doneAttempt: Promise<unknown> | undefined;
    try {
      await started;
      hostOptions.onTurnStart({ turnToken: "identity-turn", conversationIds: [] });
      const sendTool = (hostOptions.toolDescriptors as Array<{ name: string; handler: (input: Record<string, unknown>, context?: unknown) => Promise<any> }>)
        .find(descriptor => descriptor.name === "send_to_agent");
      expect(sendTool).toBeDefined();
      doneAttempt = sendTool!.handler({
        to: "peer.agent", conversation_id: "done-gate", kind: "done", body: "close", done: true,
      }, { origin: { token: "identity-turn" } });

      const oldDelivery = inboundEnvelope(7, 2);
      oldDelivery.payload.conversation_id = "done-gate";
      const oldReceive = (linkOptions.onInterAgentMessage as (envelope: Envelope) => Promise<void>)(oldDelivery);
      identity = "new-incarnation";
      const newDelivery = inboundEnvelope(7, 2);
      newDelivery.payload.conversation_id = "separate-conversation";
      await (linkOptions.onInterAgentMessage as (envelope: Envelope) => Promise<void>)(newDelivery);
      releaseDone({ kind: "rejected", reason: "unknown_agent" });
      await doneAttempt;
      await oldReceive;

      expect(reports.filter(report => report.stage === "queued")).toEqual([
        expect.objectContaining({ incarnation: "new-incarnation", generation: "generation", delivery_seq: 7 }),
      ]);
    } finally {
      releaseDone({ kind: "rejected", reason: "unknown_agent" });
      await doneAttempt;
      finishHost();
      await running;
    }
  });

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
    const hostFinished = deferred();
    const hostStarted = deferred();
    let running: Promise<void> | undefined;
    const host = {
      state: "idle",
      statusExtSnapshot: () => ({}),
      run: async () => { hostStarted.resolve(); await hostFinished.promise; },
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
      running = runCodexCli({
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
      await hostStarted.promise;

    expect(linkOptions.onInterAgentDeliveryStatus).toBeTypeOf("function");
    expect(linkOptions.onInterAgentMessage).toBeTypeOf("function");
    expect(hostOptions.onTurnStart).toBeTypeOf("function");
    expect(hostOptions.prepareInput).toBeTypeOf("function");

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
      hostFinished.resolve();
      await running;
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
    const hostFinished = deferred();
    const hostStarted = deferred();
    let running: Promise<void> | undefined;
    const host = {
      state: "idle",
      statusExtSnapshot: () => ({}),
      run: async () => { hostStarted.resolve(); await hostFinished.promise; },
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
      running = runCodexCli({
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
      await hostStarted.promise;

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
      hostFinished.resolve();
      await running;
      stderr.mockRestore();
    }
  });

  it("retires unstarted CLI-owned batches on fail-stop before closing the link", async () => {
    const initialSigint = new Set(process.listeners("SIGINT"));
    const started = deferred();
    const finished = deferred();
    const retired: number[] = [];
    const sends: Array<{ text: string; token: string }> = [];
    let options!: Record<string, any>;
    let hostOptions!: Record<string, any>;
    const closing: string[] = [];
    const running = runCodexCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      prepareStartup: async () => {},
      createServerLink: (_url, _id, callbacks) => {
        options = callbacks;
        queueMicrotask(() => callbacks.onPersonaPrompt?.("system"));
        return {
          currentSessionId: () => null, send: () => {},
          acknowledgeInterAgentDelivery: () => {},
          retireInterAgentDeliveries: (envelopes: Envelope[]) => retired.push(...envelopes.map((envelope) => (envelope as Envelope & { delivery_seq: number }).delivery_seq)),
          flushInterAgentRetirements: async () => { closing.push("flush"); },
          close: () => { closing.push("close"); },
        } as never;
      },
      createHost: (_config, callbacks) => {
        hostOptions = callbacks;
        return {
          state: "idle", statusExtSnapshot: () => ({}),
          run: async () => { started.resolve(); await finished.promise; },
          send: async (text: string, _attachments: unknown, _cids: string[], token: string) => { sends.push({ text, token }); },
        } as never;
      },
    });
    void running.catch(() => {});
    try {
      await started.promise;
      options.onInterAgentDeliveryStatus({ acked_seq: 0 });
      await options.onInterAgentMessage(inboundEnvelope(1, 1));
      await vi.waitFor(() => expect(sends).toHaveLength(1));
      hostOptions.onTurnStart({ turnToken: sends[0]!.token });
      await options.onInterAgentMessage(inboundEnvelope(2, 1));
      await options.onInterAgentMessage(inboundEnvelope(3, 1, "queued", "other.peer"));
      await vi.waitFor(() => expect(sends).toHaveLength(2));
      // Real Host cancels its queued turns before notifying the coordinator freeze.
      hostOptions.onTurnEnd({ turnToken: sends[1]!.token, conversationIds: ["c-3"],
        error: { detail: "watchdog" }, cancellation: { kind: "watchdog_fail_stop", started: false } });
      hostOptions.onWatchdogFailStop({ turnToken: sends[0]!.token, attribution: "exact" });
      expect(retired.sort()).toEqual([2, 3]);
      expect(sends).toHaveLength(2);
    } finally {
      finished.resolve();
      try { await running; } finally {
        for (const listener of process.listeners("SIGINT")) {
          if (!initialSigint.has(listener)) process.off("SIGINT", listener);
        }
      }
    }
    expect(closing).toEqual(["flush", "close"]);
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

describe("permission gate cancellation notice composition", () => {
  it("real Host timeout reaches the sending peer without delivery acknowledgement or SDK dispatch", async () => {
    const { CodexHost } = await import("../src/host.js");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "fuji340-cli-notice-"));
    const wire = await phoenixLoopback(() => ({
      delivery_resync: "skip-v1",
      delivery: { issued_seq: 0, acked_seq: 0 },
      permission_sync: true,
    }));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // The CLI builds its real ServerLink, coordinator, classifier, notice
    // resolver and Host. Only the provider client remains at its documented
    // external-I/O seam.
    let host: InstanceType<typeof CodexHost> | undefined;
    let sdkCalls = 0;
    const originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;
    let running: Promise<void> | undefined;
    try {
      running = runCodexCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config, server_url: wire.url, sandbox: "read-only", network_access: false }),
      createHost: (cfg, options) => {
        host = new CodexHost(cfg, { ...options, permissionGateTimeoutMs: 50,
          turnTraceDir: root, permissionRolloutRoot: root,
          rateLimitResolver: async () => new Map(),
          codexFactory: () => {
            const unexpected = () => { sdkCalls++; throw new Error("SDK must not start"); };
            return { startThread: unexpected, resumeThread: unexpected };
          },
        });
        const next = { revision: 4, requested: { sandbox: "read-only" as const, network_access: false } };
        host.applyPermissionSync({ version: "0", next, control: { ...next,
          status: "unknown", reason: "observation_unavailable",
          submitted: { ...next, execution_id: "previous-execution" },
          constraints: { approval: "never", enforcement: "os" },
        } });
        return host;
      },
      prepareStartup: async () => {},
      });
      await vi.waitFor(() => expect(wire.joins).toBe(1));
      wire.push("persona_prompt", { version: "0", prompt: "test" });
      wire.push("permission_sync", { version: "0", control: null, next: null });
      await vi.waitFor(() => expect(host).toBeDefined());
      wire.push("envelope", inboundEnvelope(1) as unknown as Record<string, unknown>);
      await vi.waitFor(() => expect(wire.received.some(item =>
        item.event === "envelope" && JSON.stringify(item.payload).includes('"permission_gate_blocked"'),
      )).toBe(true));
      const notices = wire.received
        .filter(item => item.event === "envelope" && item.payload.type === "inter_agent_message")
        .map(item => item.payload as unknown as Envelope);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ payload: { to: "peer.agent", conversation_id: "c-1",
        error: { code: "permission_gate_blocked", message: expect.stringContaining("reapply the same sandbox/network") } } });
      expect(wire.received.filter(item => item.event === "delivery_ack")).toEqual([]); expect(sdkCalls).toBe(0);
      expect(host!.state).toBe("waiting_input");
      const output = stderr.mock.calls.map(([text]) => String(text)).join("");
      expect(output).toContain('"event":"permission_gate_timeout"');
      expect(output).toContain('"revision":4');
      expect(output).toContain('"reason":"observation_unavailable"');
    } finally {
      host?.close();
      try {
        if (running !== undefined) await running;
      } finally {
        try {
          await wire.close();
        } finally {
          if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
          else process.env.CODEX_HOME = originalCodexHome;
          stderr.mockRestore(); await rm(root, { recursive: true, force: true });
        }
      }
    }
  });
});
