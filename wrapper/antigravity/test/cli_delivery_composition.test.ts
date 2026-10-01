import { describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { runAntigravityCli } from "../src/cli.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

function inbound(deliverySeq: number, turnNumber: number, body = "hello"): Envelope {
  return {
    version: "0",
    agent_id: "peer.agent",
    persona: { id: "peer", name: "Peer", sprite_set: "peer" },
    display_name: "Peer",
    ts: "2026-09-10T00:00:00Z",
    type: "inter_agent_message",
    state: "thinking",
    payload: {
      to: config.agent_id,
      conversation_id: `c-${deliverySeq}`,
      turn_number: turnNumber,
      kind: "inform",
      body,
      meta: { done: false, propose_next: "" },
      owner: { kind: "user", id: "operator" },
    },
    ext: {},
    delivery_seq: deliverySeq,
  } as unknown as Envelope;
}

describe("Antigravity CLI delivery composition", () => {
  it("drains work notices received before host construction through the instruction chain", async () => {
    const sends: string[] = [];
    let linkOptions!: Record<string, any>;
    let finishHost!: () => void;
    const finished = new Promise<void>(resolve => { finishHost = resolve; });
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let running: Promise<void> | undefined;
    const notice = {
      version: "0",
      op: "assign",
      reason: "assignment_created",
      work: { work_id: "wrk_1" },
    };
    const link = {
      close: () => {},
      send: () => {},
      reportDisconnectIntent: async () => true,
    };
    const host = {
      state: "idle",
      statusExtSnapshot: () => ({}),
      activeInterAgentTurnToken: () => null,
      requestInterruptForTurn: () => true,
      failStopTurnForWatchdog: () => true,
      failStopForWatchdogAttributionUnknown: () => true,
      send: async (text: string) => { sends.push(text); },
      run: async () => { started(); await finished; },
    };
    running = runAntigravityCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      createServerLink: (_url, _agentId, options) => {
        linkOptions = options as unknown as Record<string, any>;
        options.onWorkNotice?.(notice as never);
        queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
        return link as never;
      },
      createHost: () => host as never,
    });

    try {
      await ready;
      await vi.waitFor(() => expect(sends).toHaveLength(1));
      expect(sends[0]).toContain("Work notice:");
      expect(sends[0]).toContain("assignment_created");
      expect(linkOptions.onWorkNotice).toBeTypeOf("function");
    } finally {
      finishHost();
      await running;
    }
  });

  it("connects the server handler, agy turn start, token, and delivery acknowledgement", async () => {
    const acknowledgements: number[] = [];
    const disconnectReasons: string[] = [];
    const sends: Array<{ text: string; conversationIds: readonly string[]; turnToken: string }> = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let linkOptions!: Record<string, any>;
    let hostOptions!: Record<string, any>;
    const link = {
      close: () => {},
      send: () => {},
      reportDisconnectIntent: async (reason: string) => {
        disconnectReasons.push(reason);
        return true;
      },
      acknowledgeInterAgentDelivery: (sequence: number) => acknowledgements.push(sequence),
    };
    let startHost!: () => void;
    let finishHost!: () => void;
    const ready = new Promise<void>((resolve) => { startHost = resolve; });
    const finished = new Promise<void>((resolve) => { finishHost = resolve; });
    let running: Promise<void> | undefined;
    const host = {
      state: "idle",
      statusExtSnapshot: () => ({}),
      activeInterAgentTurnToken: () => null,
      requestInterruptForTurn: () => true,
      failStopTurnForWatchdog: () => true,
      failStopForWatchdogAttributionUnknown: () => true,
      run: async () => { startHost(); await finished; },
      send: async (
        text: string,
        _attachments: unknown,
        conversationIds: readonly string[],
        turnToken: string,
      ) => {
        sends.push({ text, conversationIds, turnToken });
        // Queue admission must not acknowledge delivery. The child-spawn boundary does.
        expect(acknowledgements).toEqual([2]);
        hostOptions.onTurnStart({ turnToken, conversationIds });
        hostOptions.onTurnEnd({ turnToken, conversationIds });
        hostOptions.onTurnBoundary({ turnToken });
      },
    };

    try {
      running = runAntigravityCli({
        parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
        loadConfig: () => ({ ...config }),
        createServerLink: (_url, _agentId, options) => {
          linkOptions = options as unknown as Record<string, any>;
          queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
          return link as never;
        },
        createHost: (_config, options) => {
          hostOptions = options as unknown as Record<string, any>;
          return host as never;
        },
      });
      await ready;
      expect(hostOptions.prepareInput).toBeTypeOf("function");

      (linkOptions.onInterAgentDeliveryStatus as (status: { acked_seq: number }) => void)({
        acked_seq: 1,
      });
      // A stale delivery is intentionally non-injected and therefore acked immediately.
      await (linkOptions.onInterAgentMessage as (envelope: Envelope) => Promise<void>)(
        inbound(2, 0),
      );
      expect(acknowledgements).toEqual([2]);
      expect(sends).toEqual([]);

      await (linkOptions.onInterAgentMessage as (envelope: Envelope) => Promise<void>)(
        inbound(3, 1, "INBOUND_BODY_SENTINEL"),
      );
      await vi.waitFor(() => expect(acknowledgements).toEqual([2, 3]));
      expect(sends).toEqual([
        expect.objectContaining({
          text: expect.stringContaining("INBOUND_BODY_SENTINEL"),
          conversationIds: ["c-3"],
          turnToken: expect.any(String),
        }),
      ]);
      expect(stderr.mock.calls.map(([line]) => String(line))).toContainEqual(
        expect.stringMatching(/^\[kaoiro\]\[antigravity-lifecycle\] .*"event":"turn_start"/),
      );
    } finally {
      finishHost();
      await running;
      stderr.mockRestore();
    }
    expect(disconnectReasons).toEqual(["stop"]);
  });

  /** Runs the production CLI against a link that reports a delivery identity.
   *  `incarnation: null` models a detected disconnect. */
  async function startWithDeliveryIdentity() {
    const acknowledgements: number[] = [];
    const turnStarts: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const state = { incarnation: "old" as string | null, holdTurn: null as Promise<void> | null };
    let linkOptions!: Record<string, any>;
    let hostOptions!: Record<string, any>;
    const link = {
      close: () => {},
      send: () => {},
      reportDisconnectIntent: async () => true,
      acknowledgeInterAgentDelivery: (sequence: number) => acknowledgements.push(sequence),
      deliveryIncarnation: () => state.incarnation,
      deliveryGeneration: () => "generation",
    };
    let startHost!: () => void;
    let finishHost!: () => void;
    const ready = new Promise<void>((resolve) => { startHost = resolve; });
    const finished = new Promise<void>((resolve) => { finishHost = resolve; });
    const host = {
      state: "idle",
      statusExtSnapshot: () => ({}),
      activeInterAgentTurnToken: () => null,
      requestInterruptForTurn: () => true,
      failStopTurnForWatchdog: () => true,
      failStopForWatchdogAttributionUnknown: () => true,
      run: async () => { startHost(); await finished; },
      send: async (
        _text: string,
        _attachments: unknown,
        conversationIds: readonly string[],
        turnToken: string,
      ) => {
        await state.holdTurn;
        hostOptions.onTurnStart({ turnToken, conversationIds });
        turnStarts.push(turnToken);
        hostOptions.onTurnEnd({ turnToken, conversationIds });
        hostOptions.onTurnBoundary({ turnToken });
      },
    };
    const running = runAntigravityCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      createServerLink: (_url, _agentId, options) => {
        linkOptions = options as unknown as Record<string, any>;
        queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
        return link as never;
      },
      createHost: (_config, options) => {
        hostOptions = options as unknown as Record<string, any>;
        return host as never;
      },
    });
    await ready;
    return {
      acknowledgements,
      turnStarts,
      state,
      deliver: (envelope: Envelope) =>
        (linkOptions.onInterAgentMessage as (envelope: Envelope) => Promise<void>)(envelope),
      status: (ackedSeq: number) =>
        (linkOptions.onInterAgentDeliveryStatus as (status: { acked_seq: number }) => void)({
          acked_seq: ackedSeq,
        }),
      stop: async () => {
        finishHost();
        await running;
        stderr.mockRestore();
      },
    };
  }

  function heldTurn(): { held: Promise<void>; release: () => void } {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    return { held, release };
  }

  it("acknowledges a new delivery incarnation's sequence space from 1", async () => {
    const cli = await startWithDeliveryIdentity();
    try {
      cli.status(2);
      await cli.deliver(inbound(3, 1));
      await vi.waitFor(() => expect(cli.acknowledgements).toEqual([3]));

      // The server lost its ledger entry: a new incarnation restarts at 0.
      cli.state.incarnation = "new";
      cli.status(0);
      await cli.deliver(inbound(1, 1));
      await vi.waitFor(() => expect(cli.acknowledgements).toEqual([3, 1]));
    } finally {
      await cli.stop();
    }
  });

  it("does not acknowledge an input received under a replaced delivery identity", async () => {
    const cli = await startWithDeliveryIdentity();
    const turn = heldTurn();
    try {
      cli.status(2);
      cli.state.holdTurn = turn.held;
      await cli.deliver(inbound(3, 1));

      // The new incarnation continues the sequence and still reports 3 as
      // unacknowledged, so only the identity fence can withhold the ACK.
      cli.state.incarnation = "new";
      cli.status(2);
      turn.release();
      await vi.waitFor(() => expect(cli.turnStarts).toHaveLength(1));
      expect(cli.acknowledgements).toEqual([]);
    } finally {
      turn.release();
      await cli.stop();
    }
  });

  it("holds a completion made while disconnected and sends it once after a same-identity rejoin", async () => {
    const cli = await startWithDeliveryIdentity();
    const turn = heldTurn();
    try {
      cli.status(2);
      cli.state.holdTurn = turn.held;
      await cli.deliver(inbound(3, 1));

      cli.state.incarnation = null;
      turn.release();
      await vi.waitFor(() => expect(cli.turnStarts).toHaveLength(1));
      expect(cli.acknowledgements).toEqual([]);

      cli.state.incarnation = "old";
      cli.status(2);
      await vi.waitFor(() => expect(cli.acknowledgements).toEqual([3]));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(cli.acknowledgements).toEqual([3]);
    } finally {
      turn.release();
      await cli.stop();
    }
  });

  it("runs an inbound delivery through the production default CLI and host to an agy child", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-inbound-default-"));
    const executable = join(root, "agy-fixture.mjs");
    const configPath = join(root, "wrapper.config.json");
    const hook = `${process.execPath} ${new URL("../dist/hook.js", import.meta.url).pathname}`;
    writeFileSync(executable, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "models") {
  process.stdout.write("fixture-model\\tFixture Model\\n");
} else if (args[0] === "-p" && args[1] === "/hooks") {
  const customization = args[args.lastIndexOf("--add-dir") + 1];
  process.stdout.write(JSON.stringify({ hooks: [{ source: customization + "/.agents/hooks.json", actions: [{ event: "PreToolUse", matcher: "*", command: ${JSON.stringify(hook)}, timeout_seconds: 3600 }] }] }));
} else if (args[0] === "--print") {
  process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "inbound child turn" } }) + "\\n");
} else {
  process.exitCode = 2;
}
`);
    chmodSync(executable, 0o755);
    writeFileSync(configPath, JSON.stringify({
      ...config,
      antigravity_cli_path: executable,
      antigravity_probe_timeout_ms: 45_000,
    }));
    const acknowledgements: number[] = [];
    let options!: Record<string, any>;
    let host: { close(): void } | undefined;
    let resultSeen!: () => void;
    const result = new Promise<void>((resolve) => { resultSeen = resolve; });

    try {
      const run = runAntigravityCli({
        parseCliArgs: () => ({ configPath, prompt: undefined, resume: undefined }),
        onHostCreated: (created) => {
          host = created;
          queueMicrotask(() => {
            void (options.onInterAgentMessage as (envelope: Envelope) => Promise<void>)(
              inbound(1, 1, "DEFAULT_COMPOSITION_SENTINEL"),
            );
          });
        },
        createServerLink: (_url, _agentId, createdOptions) => {
          options = createdOptions as unknown as Record<string, any>;
          queueMicrotask(() => {
            options.onPersonaPrompt("persona");
            options.onInterAgentDeliveryStatus({ acked_seq: 0 });
          });
          return {
            close: () => {},
            setSessionId: () => {},
            acknowledgeInterAgentDelivery: (sequence: number) => acknowledgements.push(sequence),
            send: (envelope: Envelope) => {
              if (envelope.type === "result") resultSeen();
            },
          } as never;
        },
      });

      await result;
      host?.close();
      await run;
      expect(acknowledgements).toEqual([1]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("acknowledges a caught fatal disconnect intent before closing the link", async () => {
    const events: string[] = [];

    await expect(runAntigravityCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      createServerLink: (_url, _agentId, options) => {
        queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
        return {
          close: () => events.push("close"),
          send: () => {},
          reportDisconnectIntent: async (reason: string) => {
            events.push(`intent:${reason}`);
            return true;
          },
        } as never;
      },
      createHost: () => ({
        state: "idle",
        statusExtSnapshot: () => ({}),
        run: async () => { throw new Error("caught fatal"); },
      }) as never,
    })).rejects.toThrow("caught fatal");

    expect(events).toEqual(["intent:crash", "close"]);
  });
});
