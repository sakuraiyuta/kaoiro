// issue #391: the SIGTERM handler must register exactly once per
// runClaudeCli() invocation and be removed in `finally`, mirroring issue
// #379's lesson (a listener left behind after `run()` settles accumulates
// across repeated invocations in the same process -- the exact shape that
// broke vitest teardown there). A fake host (not a fake queryFn) is enough
// here: this pin is about listener bookkeeping, not the SDK subprocess
// escalation, which the real-process pin covers separately.
import { describe, expect, it } from "vitest";
import type { WrapperConfig } from "@kaoiro/agent-common";
import { runClaudeCli } from "../src/cli.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

async function runOnceAndSigterm(): Promise<{ closed: boolean }> {
  let finishHost!: () => void;
  const finished = new Promise<void>((resolve) => {
    finishHost = resolve;
  });
  let startedRun!: () => void;
  const started = new Promise<void>((resolve) => {
    startedRun = resolve;
  });
  let closed = false;
  const host = {
    state: "idle",
    statusExtSnapshot: () => ({}),
    run: async () => {
      startedRun();
      await finished;
    },
    close: () => {
      closed = true;
      finishHost();
    },
  };
  const running = runClaudeCli({
    parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
    loadConfig: () => ({ ...config }),
    createServerLink: (_url, _agentId, options) => {
      queueMicrotask(() => {
        (options as unknown as Record<string, any>).onPersonaPrompt?.("system prompt");
      });
      return {
        close: () => {},
        currentSessionId: () => null,
        send: () => {},
        reportSessionLifecycle: () => {},
        setSessionId: () => {},
        acknowledgeInterAgentDelivery: () => {},
        flushInterAgentRetirements: async () => {},
        reportDisconnectIntent: async () => {},
      } as never;
    },
    createHost: () => host as never,
  });
  // The SIGTERM handler is registered just before host.run() is awaited;
  // wait for that to avoid a race where the signal fires too early.
  await started;
  // Same in-process technique as the real-process pins: fires the listener
  // `runClaudeCli` itself registered, standing in for a real OS signal.
  process.emit("SIGTERM" as never);
  await running;
  return { closed };
}

describe("Claude CLI SIGTERM handler lifecycle (issue #391)", () => {
  it("registers once per invocation and removes it in finally across repeated runs", async () => {
    const before = process.listenerCount("SIGTERM");
    const first = await runOnceAndSigterm();
    expect(first.closed).toBe(true);
    expect(process.listenerCount("SIGTERM")).toBe(before);
    const second = await runOnceAndSigterm();
    expect(second.closed).toBe(true);
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});
