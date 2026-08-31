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

describe("Codex watchdog host boundary", () => {
  it("fail-stop retains the active token and consumes a late terminal without settling it", async () => {
    const activeStarted = deferred<void>();
    const releaseActive = deferred<void>();
    const turnEnds: Array<Record<string, unknown>> = [];
    const states: string[] = [];
    const lifecycle: Array<Record<string, unknown>> = [];

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
      appendSystemPrompt: "p",
      codexFactory: () => client,
      now: () => "T",
    });

    const running = host.run("eof");
    await ended.promise;
    host.close();
    await running;

    expect(turnEnds).toHaveLength(1);
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
});
