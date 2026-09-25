import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { CodexHost } from "../src/host.js";
import { prepareCodexStartup } from "../src/startup.js";
import { AppServerTransport } from "../src/app_server_transport.js";
import { readStartupRateLimits } from "../src/startup_rate_limits.js";
import type {
  CodexRateLimitSnapshot,
  CodexRateLimitWindow,
} from "../src/rollout.js";

const config: WrapperConfig = {
  agent_id: "startup.codex",
  persona: { id: "momo", name: "もも", sprite_set: "momo" },
  display_name: "もも",
  server_url: "ws://localhost:4000/wrapper",
};

function rateLimitRpcChild() {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough(), stderr = new PassThrough();
  const methods: string[] = [];
  const stdin = new Writable({ write(chunk, _encoding, done) {
    const request = JSON.parse(String(chunk)) as { id?: number; method: string };
    methods.push(request.method);
    if (request.method === "initialize") {
      stdout.write(JSON.stringify({ id: request.id, result: { userAgent: "fake/1" } }) + "\n");
    } else if (request.method === "account/rateLimits/read") {
      stdout.write(JSON.stringify({ id: request.id, result: { rateLimitsByLimitId: {
        codex: { limitId: "codex", primary: { usedPercent: 23, windowDurationMins: 10080, resetsAt: 1790908233 } },
        other: { limitId: "other", primary: { usedPercent: 90, windowDurationMins: 300, resetsAt: 1790908233 } },
      } } }) + "\n");
    }
    done();
  } });
  Object.assign(child, { stdin, stdout, stderr, exitCode: null, signalCode: null });
  const finish = () => {
    if (child.exitCode !== null) return;
    Object.assign(child, { exitCode: 0 });
    child.emit("exit", 0, null);
    stdout.end(); stderr.end();
    queueMicrotask(() => child.emit("close", 0, null));
  };
  stdin.on("finish", finish);
  child.kill = () => { finish(); return true; };
  return { child, methods };
}

describe("prepareCodexStartup (issue #251)", () => {
  it("uses readStartupRateLimits as the default fresh-idle resolver", async () => {
    const { child, methods } = rateLimitRpcChild();
    const sent: Envelope[] = [];
    const host = new CodexHost(config, {
      onState: (event) => sent.push(event), appendSystemPrompt: "p", now: () => "T",
      startupRateLimitTransportFactory: () => new AppServerTransport({ spawnChild: () => child }),
    });
    await prepareCodexStartup({ config, prompt: undefined, resumeSessionId: undefined, host,
      link: { setSessionId: () => {}, send: (event) => sent.push(event) },
      sidecar: { bind: () => {} }, printState: () => {}, now: () => "T" });
    expect(sent[0]?.ext).not.toHaveProperty("rate_limits");
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(methods).toEqual(["initialize", "initialized", "account/rateLimits/read"]);
    expect(host.statusSnapshot().rate_limits).toEqual({ seven_day: { utilization: 0.23, resets_at: 1790908233 } });
    host.close();
  });

  it("converts the codex bucket from an RPC child through readStartupRateLimits", async () => {
    const { child, methods } = rateLimitRpcChild();
    const windows = await readStartupRateLimits(undefined,
      () => new AppServerTransport({ spawnChild: () => child }));
    expect(methods).toEqual(["initialize", "initialized", "account/rateLimits/read"]);
    expect(windows).toEqual(new Map([["seven_day", { utilization: 0.23, resets_at: 1790908233 }]]));
  });

  it("fresh idle is immediate and the account snapshot follows before any turn", async () => {
    const sent: Envelope[] = [];
    const hostStates: Envelope[] = [];
    let release!: (value: Map<CodexRateLimitWindow, CodexRateLimitSnapshot>) => void;
    const pending = new Promise<Map<CodexRateLimitWindow, CodexRateLimitSnapshot>>((resolve) => { release = resolve; });
    const resolver = vi.fn(() => pending);
    const host = new CodexHost(config, {
      onState: (event) => hostStates.push(event),
      appendSystemPrompt: "p",
      startupRateLimitResolver: resolver,
      now: () => "T",
    });
    await prepareCodexStartup({
      config, prompt: undefined, resumeSessionId: undefined, host,
      link: { setSessionId: () => {}, send: (event) => sent.push(event) },
      sidecar: { bind: () => {} }, printState: () => {}, now: () => "T",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.ext).not.toHaveProperty("rate_limits");
    expect(hostStates).toHaveLength(0);
    expect(resolver).toHaveBeenCalledTimes(1);
    release(new Map([["seven_day", { utilization: 0.19, resets_at: 1790908233 }]]));
    await vi.waitFor(() => expect(hostStates).toHaveLength(1));
    expect(hostStates[0]?.ext.rate_limits).toEqual({ seven_day: { utilization: 0.19, resets_at: 1790908233 } });
    expect(host.statusSnapshot().rate_limits).toEqual(hostStates[0]?.ext.rate_limits);
  });

  it("a source-free account probe leaves the rate limit field absent", async () => {
    const hostStates: Envelope[] = [];
    const host = new CodexHost(config, {
      onState: (event) => hostStates.push(event),
      appendSystemPrompt: "p",
      startupRateLimitResolver: async () => new Map(),
      now: () => "T",
    });
    await host.probeAccountRateLimits();
    expect(hostStates).toEqual([]);
    expect(host.statusSnapshot()).not.toHaveProperty("rate_limits");
  });

  it("cancels the startup read when the host closes", async () => {
    let signal: AbortSignal | undefined;
    const host = new CodexHost(config, {
      onState: () => {}, appendSystemPrompt: "p",
      startupRateLimitResolver: async (received) => {
        signal = received;
        return new Map();
      },
    });
    await host.probeAccountRateLimits();
    expect(signal?.aborted).toBe(false);
    host.close();
    expect(signal?.aborted).toBe(true);
  });

  it("a late account probe cannot replace a native rollout snapshot", async () => {
    let release!: (value: Map<CodexRateLimitWindow, CodexRateLimitSnapshot>) => void;
    const pending = new Promise<Map<CodexRateLimitWindow, CodexRateLimitSnapshot>>((resolve) => { release = resolve; });
    const host = new CodexHost(config, {
      onState: () => {}, resumeSessionId: "native-session",
      appendSystemPrompt: "p",
      startupRateLimitResolver: () => pending,
      rateLimitResolver: async () => new Map([["seven_day", { utilization: 0.31 }]]),
      now: () => "T",
    });
    const probe = host.probeAccountRateLimits();
    await host.initializeRateLimits();
    release(new Map([["seven_day", { utilization: 0.07 }]]));
    await probe;
    expect(host.statusSnapshot().rate_limits).toEqual({ seven_day: { utilization: 0.31 } });
  });

  it("resume bind 後、production startup は初回 idle 前に snapshot を一度だけ取得する", async () => {
    const hostStates: Envelope[] = [];
    const sent: Envelope[] = [];
    const printed: Envelope[] = [];
    const operations: string[] = [];
    const snapshot = new Map<CodexRateLimitWindow, CodexRateLimitSnapshot>([
      ["seven_day", { utilization: 0.28, resets_at: 1787371200 }],
    ]);
    const resolver = vi.fn(async () => {
      operations.push("resolver");
      return snapshot;
    });
    const host = new CodexHost(config, {
      onState: (event) => hostStates.push(event),
      appendSystemPrompt: "p",
      resumeSessionId: "uuid-resume-startup",
      rateLimitResolver: resolver,
      now: () => "T",
    });

    await prepareCodexStartup({
      config,
      prompt: undefined,
      resumeSessionId: "uuid-resume-startup",
      host,
      link: {
        setSessionId: (id) => operations.push(`link:${id}`),
        send: (envelope) => sent.push(envelope),
      },
      sidecar: { bind: (id) => operations.push(`sidecar:${id}`) },
      printState: (envelope) => printed.push(envelope),
      now: () => "T",
    });

    expect(operations).toEqual([
      "link:uuid-resume-startup",
      "sidecar:uuid-resume-startup",
      "resolver",
    ]);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith("uuid-resume-startup");
    expect(hostStates).toHaveLength(1);
    expect(hostStates[0]).toMatchObject({
      state: "idle",
      ext: {
        rate_limits: {
          seven_day: { utilization: 0.28, resets_at: 1787371200 },
        },
      },
    });
    expect(printed).toHaveLength(1);
    expect(sent).toEqual(printed);
    expect(sent[0]).toMatchObject({
      state: "idle",
      ext: {
        rate_limits: {
          seven_day: { utilization: 0.28, resets_at: 1787371200 },
        },
      },
    });
  });

  it("empty startup snapshot は idle を送るが ext.rate_limits を省略する", async () => {
    const hostStates: Envelope[] = [];
    const sent: Envelope[] = [];
    const resolver = vi.fn(async () =>
      new Map<CodexRateLimitWindow, CodexRateLimitSnapshot>(),
    );
    const host = new CodexHost(config, {
      onState: (event) => hostStates.push(event),
      appendSystemPrompt: "p",
      resumeSessionId: "uuid-resume-empty-startup",
      rateLimitResolver: resolver,
      now: () => "T",
    });

    await prepareCodexStartup({
      config,
      prompt: undefined,
      resumeSessionId: "uuid-resume-empty-startup",
      host,
      link: { setSessionId: () => {}, send: (envelope) => sent.push(envelope) },
      sidecar: { bind: () => {} },
      printState: () => {},
      now: () => "T",
    });

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(hostStates).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.ext).not.toHaveProperty("rate_limits");
  });
});
