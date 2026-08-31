import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { ThreadEvent } from "@openai/codex-sdk";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { CodexHost } from "../src/host.js";
import type { CodexClientLike, CodexThreadLike } from "../src/host.js";

const CONFIG: WrapperConfig = {
  agent_id: "watchdog.codex",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

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

function clientFor(events: () => AsyncIterable<ThreadEvent>): CodexClientLike {
  const thread: CodexThreadLike = {
    async runStreamed() {
      return { events: events() };
    },
  };
  return {
    startThread: () => thread,
    resumeThread: () => thread,
  };
}

function imageChunk(uploadId: string): Uint8Array {
  const id = new TextEncoder().encode(uploadId);
  const payload = new Uint8Array(4 + id.byteLength + 4 + 1);
  const view = new DataView(payload.buffer);
  view.setUint32(0, id.byteLength, false);
  payload.set(id, 4);
  view.setUint32(4 + id.byteLength, 0, false);
  payload[payload.byteLength - 1] = 1;
  return payload;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("Codex watchdog host boundary", () => {
  it("fail-stop retains the active token and consumes a late terminal without settling it", async () => {
    const activeStarted = deferred<void>();
    const releaseActive = deferred<void>();
    const turnEnds: Array<Record<string, unknown>> = [];
    const states: string[] = [];
    const lifecycle: Array<Record<string, unknown>> = [];
    const finalized: string[] = [];

    const client = clientFor(async function* events() {
      yield { type: "thread.started", thread_id: "watchdog-session" };
      await releaseActive.promise;
      yield { type: "turn.completed", usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        output_tokens: 1,
        reasoning_output_tokens: 0,
      } };
    });
    const host = new CodexHost(CONFIG, {
      onState: (envelope: Envelope) => states.push(envelope.state),
      onTurnStart: () => activeStarted.resolve(),
      onTurnEnd: (info) => turnEnds.push(info as Record<string, unknown>),
      onLifecycle: (event) => lifecycle.push(event as Record<string, unknown>),
      onTurnFinalized: ({ turnToken }) => finalized.push(turnToken),
      appendSystemPrompt: "p",
      codexFactory: () => client,
      now: () => "T",
    });

    const running = host.run();
    await host.send("first", undefined, ["cid-first"], "turn-first");
    await activeStarted.promise;
    await host.send("second", undefined, ["cid-second"], "turn-second");

    expect(host.activeInterAgentTurnToken()).toBe("turn-first");
    expect(host.failStopTurnForWatchdog("wrong-token")).toBe(false);
    expect(host.failStopTurnForWatchdog("turn-first")).toBe(true);
    expect(host.activeInterAgentTurnToken()).toBe("turn-first");
    expect(turnEnds).toEqual([
      {
        turnToken: "turn-second",
        conversationIds: ["cid-second"],
        error: {
          detail:
            "turn watchdog interrupt grace expired; host admission stopped pending operator recovery",
        },
        cancellation: { kind: "watchdog_fail_stop", started: false },
      },
    ]);
    expect(states).toEqual(["sending", "error"]);

    releaseActive.resolve();
    await running;

    // No normal terminal result or state transition may be manufactured for
    // the active token after the watchdog has made its outcome unknown.
    expect(turnEnds).toHaveLength(1);
    expect(states).toEqual(["sending", "error"]);
    expect(finalized).toEqual(["turn-first"]);
    expect(lifecycle).toEqual([
      { kind: "turn_start", turnToken: "turn-first" },
      { kind: "sdk_event", turnToken: "turn-first", type: "thread.started" },
      { kind: "sdk_event", turnToken: "turn-first", type: "turn.completed" },
      {
        kind: "terminal",
        turnToken: "turn-first",
        type: "turn.completed",
        authoritative: false,
      },
      {
        kind: "stream_eof",
        turnToken: "turn-first",
        terminalSeen: true,
      },
    ]);
  });

  it("stream_eof records terminalSeen=false when the SDK ends before a terminal", async () => {
    const ended = deferred<void>();
    const lifecycle: Array<Record<string, unknown>> = [];
    const turnEnds: Array<Record<string, unknown>> = [];
    const finalized: string[] = [];
    const client = clientFor(async function* events() {
      yield { type: "thread.started", thread_id: "eof-session" };
    });
    const host = new CodexHost(CONFIG, {
      onState: () => {},
      onTurnEnd: (info) => {
        turnEnds.push(info as Record<string, unknown>);
        ended.resolve();
      },
      onLifecycle: (event) => lifecycle.push(event as Record<string, unknown>),
      onTurnFinalized: ({ turnToken }) => finalized.push(turnToken),
      appendSystemPrompt: "p",
      codexFactory: () => client,
      now: () => "T",
    });

    const running = host.run("eof");
    await ended.promise;
    host.close();
    await running;

    expect(turnEnds).toHaveLength(1);
    expect(finalized).toEqual([lifecycle[0]!.turnToken as string]);
    expect(lifecycle.at(-1)).toEqual({
      kind: "stream_eof",
      turnToken: expect.any(String),
      terminalSeen: false,
    });
  });

  it("fail-stop also suppresses synthetic settlement when the stream reaches EOF without a terminal", async () => {
    const activeStarted = deferred<void>();
    const releaseActive = deferred<void>();
    const turnEnds: Array<Record<string, unknown>> = [];
    const client = clientFor(async function* events() {
      yield { type: "thread.started", thread_id: "watchdog-eof-session" };
      await releaseActive.promise;
    });
    const host = new CodexHost(CONFIG, {
      onState: () => {},
      onTurnStart: () => activeStarted.resolve(),
      onTurnEnd: (info) => turnEnds.push(info as Record<string, unknown>),
      appendSystemPrompt: "p",
      codexFactory: () => client,
      now: () => "T",
    });

    const running = host.run();
    await host.send("first", undefined, ["cid-first"], "turn-first");
    await activeStarted.promise;
    expect(host.failStopTurnForWatchdog("turn-first")).toBe(true);
    releaseActive.resolve();
    await running;

    expect(turnEnds).toEqual([]);
  });

  it("fail-stop cleans queued image directories but retains the active directory", async () => {
    const activeStarted = deferred<void>();
    const releaseActive = deferred<void>();
    const activeDir = await mkdtemp(join(tmpdir(), "momo-284-active-"));
    const queuedDir = await mkdtemp(join(tmpdir(), "momo-284-queued-"));
    let materialization = 0;
    const client = clientFor(async function* events() {
      yield { type: "thread.started", thread_id: "watchdog-image-session" };
      await releaseActive.promise;
    });
    const host = new CodexHost(CONFIG, {
      onState: () => {},
      onTurnStart: () => activeStarted.resolve(),
      onTurnEnd: () => {},
      appendSystemPrompt: "p",
      codexFactory: () => client,
      materializeImages: async (_agentId, _uploads, lifecycle) => {
        const dir = materialization++ === 0 ? activeDir : queuedDir;
        lifecycle.onDirectoryCreated(dir);
        return { dir, paths: [`${dir}/image.png`] };
      },
      now: () => "T",
    });

    host.attachOpen({ upload_id: "active", filename: "a.png", mime: "image/png", size: 1, chunks: 1 });
    host.attachChunk(imageChunk("active"));
    host.attachClose("active");
    host.attachOpen({ upload_id: "queued", filename: "q.png", mime: "image/png", size: 1, chunks: 1 });
    host.attachChunk(imageChunk("queued"));
    host.attachClose("queued");

    const running = host.run();
    try {
      await host.send("active", ["active"], ["cid-active"], "turn-active");
      await host.send("queued", ["queued"], ["cid-queued"], "turn-queued");
      await activeStarted.promise;

      expect(host.failStopTurnForWatchdog("turn-active")).toBe(true);
      await host.waitForWatchdogCleanup();

      expect(await exists(activeDir)).toBe(true);
      expect(await exists(queuedDir)).toBe(false);
      releaseActive.resolve();
      await running;
      expect(await exists(activeDir)).toBe(false);
    } finally {
      releaseActive.resolve();
      host.close();
      await running;
      await rm(activeDir, { recursive: true, force: true });
      await rm(queuedDir, { recursive: true, force: true });
    }
  });
});
