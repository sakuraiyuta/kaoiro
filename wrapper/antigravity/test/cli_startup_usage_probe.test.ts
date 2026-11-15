import "../../../scripts/test/fixtures/test-isolation.mjs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { InterAgentTool, type Envelope, type WrapperConfig } from "@kaoiro/agent-common";
import { AntigravityHost, type SpawnedAgy } from "../src/host.js";
import { createHarnessHost } from "./host_test_harness.js";
import { runAntigravityCli } from "../src/cli.js";

class FakeAgy extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();

  kill(): boolean {
    return true;
  }

  finish(): void {
    this.stdout.end();
    this.emit("exit", 0, null);
    this.emit("close", 0, null);
  }
}

const config: WrapperConfig = {
  agent_id: "test.agent",
  persona: { id: "momo", name: "Momo", sprite_set: "momo" },
  display_name: "Momo",
  server_url: "ws://localhost:4000",
};

async function runCli(args: { prompt?: string; resume?: string }): Promise<{
  events: string[];
  probeCalls: number;
}> {
  const events: string[] = [];
  let probeCalls = 0;
  let host!: AntigravityHost;
  let hostResolve!: () => void;
  const hostReady = new Promise<void>((resolve) => {
    hostResolve = resolve;
  });
  const children: FakeAgy[] = [];
  const link = {
    close: () => {},
    send: (envelope: Envelope) => {
      if (envelope.type === "state_change") events.push(`state:${envelope.state}`);
    },
    setSessionId: () => {},
    reportDisconnectIntent: async () => true,
  };
  const cliPromise = runAntigravityCli({
    parseCliArgs: () => ({ configPath: "test", prompt: args.prompt, resume: args.resume }),
    loadConfig: () => config,
    createServerLink: (_url, _agentId, options) => {
      queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
      return link as never;
    },
    createHost: (cfg, options) => {
      host = createHarnessHost(cfg, {
        ...options,
        verifyGate: async () => true,
        runtimeAssetsAvailable: () => true,
        agyPath: "/test/agy",
        spawn: () => {
          const child = new FakeAgy();
          children.push(child);
          return child as unknown as SpawnedAgy;
        },
      });
      vi.spyOn(host, "probeRateLimits").mockImplementation(() => {
        probeCalls += 1;
        events.push("probe");
      });
      hostResolve();
      return host;
    },
  });
  await hostReady;
  try {
    if (args.prompt !== undefined) await vi.waitFor(() => expect(children.length).toBe(1));
    else await new Promise((resolve) => setTimeout(resolve, 50));
    return { events: [...events], probeCalls };
  } finally {
    for (const child of children) child.finish();
    host.close();
    await cliPromise;
  }
}

describe("Antigravity CLI startup usage probe (issue #660)", () => {
  it("probes once, right after the initial state, on a fresh idle-wait start", async () => {
    const { events, probeCalls } = await runCli({});
    expect(probeCalls).toBe(1);
    const probeAt = events.indexOf("probe");
    expect(probeAt).toBeGreaterThan(0);
    expect(events[probeAt - 1]).toMatch(/^state:/);
  });

  it("probes once on a resumed idle-wait start", async () => {
    const { events, probeCalls } = await runCli({ resume: "session-660" });
    expect(probeCalls).toBe(1);
    expect(events[events.indexOf("probe") - 1]).toMatch(/^state:/);
  });

  it("does not probe at startup when an initial prompt starts a turn", async () => {
    const { probeCalls } = await runCli({ prompt: "hello" });
    expect(probeCalls).toBe(0);
  });
});

describe("Antigravity CLI shutdown releases reply waiters (issue #1130)", () => {
  it("closes this invocation's InterAgentTool when the CLI stops", async () => {
    const close = vi.spyOn(InterAgentTool.prototype, "close");
    try {
      await runCli({});
      expect(close).toHaveBeenCalledTimes(1);
      expect(close.mock.contexts[0]).toBeInstanceOf(InterAgentTool);
    } finally {
      close.mockRestore();
    }
  });
});
