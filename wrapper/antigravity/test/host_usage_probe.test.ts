import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { PermissionBroker, type Envelope, type WrapperConfig } from "@kaoiro/agent-common";
import { AntigravityHost } from "../src/host.js";
import { parseAgyUsageOutput, USAGE_PROBE_INTERVAL_MS } from "../src/usage_probe.js";
import type { SignalTargetOperation } from "../src/subtree_termination.js";
import { createHarnessHost, type HarnessAgy } from "./host_test_harness.js";

const measuredUsageOutput = readFileSync(
  new URL("../../../docs/evidence/antigravity/usage-probe-raw-20261001.json", import.meta.url),
  "utf8",
);
const issue393TerminalCapture = JSON.parse(readFileSync(
  new URL("../../../docs/evidence/antigravity/issue-393-terminal-stream.json", import.meta.url),
  "utf8",
)) as { events: unknown[] };
const issue393Terminal429 = issue393TerminalCapture.events[0];
const issue393UsageOutput = readFileSync(
  new URL("../../../docs/evidence/antigravity/issue-393-usage-output.json", import.meta.url),
  "utf8",
);

function config(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    agent_id: "a1",
    persona: { id: "momo", name: "Momo", sprite_set: "momo" },
    display_name: "Momo",
    server_url: "ws://localhost:4000",
    sandbox: "workspace-write",
    network_access: false,
    model: "gemini-2.5-pro",
    ...overrides,
  };
}

class FakeUsageChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = null;
  readonly stdin = null;
  pid = 54321;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  finish(output = "", code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    if (output !== "") this.stdout.write(output);
    this.stdout.end();
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

function usageOutput(family: "gemini" | "3p", remaining5h = 0.6, remainingWeekly = 0.25): string {
  const prefix = family === "gemini" ? "gemini" : "3p";
  return JSON.stringify({
    status: "SUCCESS",
    command: {
      name: "usage",
      data: {
        groups: [{
          name: family === "gemini" ? "Gemini Models" : "Claude and GPT models",
          buckets: [
            { id: `${prefix}-5h`, window: "5h", remaining_fraction: remaining5h, reset_time: "2026-10-03T12:00:00Z" },
            { id: `${prefix}-weekly`, window: "weekly", remaining_fraction: remainingWeekly, reset_time: "2026-10-04T12:00:00Z" },
          ],
        }],
      },
    },
  });
}

function unknownBucketOutput(): string {
  return JSON.stringify({ status: "SUCCESS", command: { name: "usage", data: { groups: [] } } });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function makeHarness(options: {
  now?: () => string;
  usageProbeTimeoutMs?: number;
  usageProbeStopTimeoutMs?: number;
  usageProbeIntervalMs?: number;
  closeProbeOnSignal?: boolean;
  throwUsageProbeSpawn?: boolean;
  floorTimers?: {
    set(callback: () => void, delayMs: number): unknown;
    clear(timer: unknown): void;
  };
} = {}) {
  const states: Envelope[] = [];
  const logs: Envelope[] = [];
  const turns: HarnessAgy[] = [];
  const probes: FakeUsageChild[] = [];
  const turnStarts: string[] = [];
  const turnEnds: string[] = [];
  const turnEndErrors: Array<unknown> = [];
  const warnings: string[] = [];
  const signals: Array<{ target: unknown; destination: string; signal: string }> = [];
  const probeSignals: Array<{ destination: string; signal: string }> = [];
  const signalTarget: SignalTargetOperation = (target, destination, signal) => {
    signals.push({ target, destination, signal });
    const turn = turns.find((candidate) => candidate === target);
    if (turn !== undefined) queueMicrotask(() => turn.finish());
    const probe = probes.find((candidate) => candidate === target);
    if (probe !== undefined) {
      probeSignals.push({ destination, signal });
      if (options.closeProbeOnSignal !== false) {
        queueMicrotask(() => probe.finish("", null, signal));
      }
    }
    return true;
  };
  const cfg = config();
  const host = createHarnessHost(cfg, {
    cwd: process.cwd(),
    appendSystemPrompt: "persona",
    permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }),
    onState: (envelope) => states.push(envelope),
    onLog: (envelope) => logs.push(envelope),
    onTurnStart: ({ turnToken }) => turnStarts.push(turnToken),
    onTurnEnd: ({ turnToken, error }) => {
      turnEnds.push(turnToken);
      turnEndErrors.push(error);
    },
    runtimeAssetsAvailable: () => true,
    verifyGate: async () => true,
    agyPath: "/test/agy",
    signalTarget,
    warn: (message) => warnings.push(message),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.usageProbeTimeoutMs === undefined ? {} : { usageProbeTimeoutMs: options.usageProbeTimeoutMs }),
    ...(options.usageProbeStopTimeoutMs === undefined ? {} : { usageProbeStopTimeoutMs: options.usageProbeStopTimeoutMs }),
    ...(options.usageProbeIntervalMs === undefined ? {} : { usageProbeIntervalMs: options.usageProbeIntervalMs }),
    ...(options.floorTimers === undefined ? {} : {
      usageProbeFloorSetTimer: (callback: () => void, delayMs: number) => options.floorTimers!.set(callback, delayMs),
      usageProbeFloorClearTimer: (timer: unknown) => options.floorTimers!.clear(timer),
    }),
    usageProbeSpawn: () => {
      if (options.throwUsageProbeSpawn === true) throw new Error("fixture usage spawn throw");
      const child = new FakeUsageChild();
      probes.push(child);
      return child as unknown as ChildProcess;
    },
  }, { onAgySpawn: (child) => turns.push(child) });
  return { host, states, logs, turns, probes, turnStarts, turnEnds, turnEndErrors, warnings, signals, probeSignals };
}

async function completeTurn(
  harness: ReturnType<typeof makeHarness>,
  result: { status: "SUCCESS" | "ERROR" | "CANCELED"; response?: string; error?: string },
): Promise<void> {
  await completeEvent(harness, { event: "result", result: { response: "ok", ...result } });
}

async function completeEvent(harness: ReturnType<typeof makeHarness>, event: unknown): Promise<void> {
  const startCount = harness.turnStarts.length;
  const endCount = harness.turnEnds.length;
  await harness.host.send("test turn");
  await waitFor(() => harness.turnStarts.length > startCount);
  const child = harness.turns.at(-1)!;
  (child.stdout as PassThrough).write(`${JSON.stringify(event)}\n`);
  await waitFor(() => harness.turnEnds.length > endCount);
}

function statusRateLimits(harness: ReturnType<typeof makeHarness>):
  | Record<string, { utilization: number; status?: string; resets_at?: number }>
  | undefined {
  const value = harness.host.statusSnapshot().rate_limits;
  return typeof value === "object" && value !== null
    ? value as Record<string, { utilization: number; status?: string; resets_at?: number }>
    : undefined;
}

async function confirmStaleTerminal429(harness: ReturnType<typeof makeHarness>): Promise<void> {
  const previousProbeCount = harness.probes.length;
  const previousLogCount = harness.logs.length;
  await completeTurn(harness, {
    status: "ERROR",
    error: "RESOURCE_EXHAUSTED (code 429): quota reached. Resets in 0s",
  });
  await waitFor(() => harness.probes.length === previousProbeCount + 1);
  harness.probes.at(-1)!.finish(usageOutput("gemini"));
  await waitFor(() => harness.logs.slice(previousLogCount).some((entry) => JSON.stringify(entry).includes("Consider resetting the session")));
}

class FakeFloorTimers {
  #nextId = 1;
  #timers = new Map<number, { callback: () => void; deadlineMs: number }>();
  constructor(private readonly nowMs: () => number) {}
  set(callback: () => void, delayMs: number): unknown {
    const id = this.#nextId++;
    this.#timers.set(id, { callback, deadlineMs: this.nowMs() + delayMs });
    return id;
  }
  clear(timer: unknown): void {
    if (typeof timer === "number") this.#timers.delete(timer);
  }
  advance(): void {
    const now = this.nowMs();
    const due = [...this.#timers.entries()].filter(([, timer]) => timer.deadlineMs <= now);
    for (const [id, timer] of due) {
      this.#timers.delete(id);
      timer.callback();
    }
  }
  get size(): number {
    return this.#timers.size;
  }
}

const geminiLimits = {
  five_hour: { utilization: 0.4, resets_at: 1791028800 },
  seven_day: { utilization: 0.75, resets_at: 1791115200 },
};
const thirdPartyLimits = {
  five_hour: { utilization: 0.25, resets_at: 1791028800 },
  seven_day: { utilization: 0.5, resets_at: 1791115200 },
};
const measuredGeminiLimits = {
  five_hour: {
    utilization: 1 - 0.4947547912597656,
    resets_at: Math.floor(Date.parse("2026-10-01T16:06:46Z") / 1_000),
  },
  seven_day: {
    utilization: 1 - 0.6695590615272522,
    resets_at: Math.floor(Date.parse("2026-10-03T04:39:01Z") / 1_000),
  },
};

describe("AntigravityHost usage probe state transitions", () => {
  it("runs the captured terminal 429 and usage output through the default host with a fixture CLI", async () => {
    expect(issue393Terminal429).toMatchObject({
      event: "result",
      result: { status: "ERROR", error: expect.stringContaining("RESOURCE_EXHAUSTED") },
    });
    const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-issue393-fixture-"));
    const executable = join(root, "agy issue393 fixture.mjs");
    const callsFile = join(root, "calls.jsonl");
    const hook = `${process.execPath} ${new URL("../dist/hook.js", import.meta.url).pathname}`;
    writeFileSync(executable, `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + "\\n");
if (args[0] === "models") {
  process.stdout.write("gemini-2.5-pro\\tGemini 2.5 Pro\\n");
} else if (args[0] === "-p" && args[1] === "/hooks") {
  const customization = args[args.lastIndexOf("--add-dir") + 1];
  process.stdout.write(JSON.stringify({ hooks: [{ source: customization + "/.agents/hooks.json", actions: [{ event: "PreToolUse", matcher: "*", command: ${JSON.stringify(hook)}, timeout_seconds: 3600 }] }] }));
} else if (args[0] === "-p" && args[1] === "/usage") {
  process.stdout.write(${JSON.stringify(issue393UsageOutput)});
} else if (args[0] === "--print") {
  let input = "";
  let replied = false;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
    if (!input.includes("\\n") || replied) return;
    replied = true;
    process.stdout.write(JSON.stringify(${JSON.stringify(issue393Terminal429)}) + "\\n");
  });
} else {
  process.exitCode = 2;
}
`);
    chmodSync(executable, 0o755);
    const now = "2026-10-03T10:00:00.000Z";
    const cfg = config({ antigravity_cli_path: executable });
    const logs: Envelope[] = [];
    const states: Envelope[] = [];
    const turnErrors: unknown[] = [];
    const host = new AntigravityHost(cfg, {
      cwd: root,
      appendSystemPrompt: "persona",
      permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }),
      onState: (envelope) => states.push(envelope),
      onLog: (envelope) => logs.push(envelope),
      onTurnEnd: ({ error }) => turnErrors.push(error),
      now: () => now,
      runtimeAssetsAvailable: () => true,
    });
    try {
      await host.send("run one captured 429 fixture turn");
      await waitFor(() => logs.some((entry) => entry.type === "result"), 8_000);
      await waitFor(() => turnErrors.length === 1, 8_000);
      await waitFor(() => existsSync(callsFile) && readFileSync(callsFile, "utf8").includes("/usage"), 8_000);
      expect(turnErrors[0]).toEqual({ reason: "blocking_limit", rateLimitResetSeconds: 0 });
      expect(states.some((envelope) => {
        const limits = envelope.ext?.rate_limits as Record<string, { status?: string }> | undefined;
        return limits?.seven_day?.status === "blocked";
      })).toBe(true);

      const calls = readFileSync(callsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
      expect(calls.filter((args) => args[0] === "-p" && args[1] === "/usage")).toEqual([
        ["-p", "/usage", "--output-format", "json"],
      ]);
      await waitFor(() => {
        const limits = host.statusSnapshot().rate_limits as Record<string, { utilization?: number }> | undefined;
        return limits?.seven_day?.utilization === 1 - 0.461282342672348;
      }, 8_000);
      expect(states.at(-1)?.ext?.rate_limits).toEqual({
        five_hour: {
          utilization: 1 - 0.9920380711555481,
          resets_at: Math.floor(Date.parse("2026-10-03T00:03:33Z") / 1_000),
        },
        seven_day: {
          utilization: 1 - 0.461282342672348,
          resets_at: Math.floor(Date.parse("2026-10-03T04:39:01Z") / 1_000),
        },
      });
      expect(host.statusSnapshot().rate_limits).toEqual(states.at(-1)?.ext?.rate_limits);
      expect(logs.some((entry) => JSON.stringify(entry).includes("Consider resetting the session"))).toBe(true);
    } finally {
      await host.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps bucket ids and windows from the measured /usage output", () => {
    const payload = JSON.parse(measuredUsageOutput) as {
      command: {
        data: {
          groups: Array<{ buckets: Array<{ id: string; window: string }> }>;
        };
      };
    };
    expect(payload.command.data.groups.flatMap((group) => group.buckets.map(({ id, window }) => ({ id, window })))).toEqual([
      { id: "gemini-weekly", window: "weekly" },
      { id: "gemini-5h", window: "5h" },
      { id: "3p-weekly", window: "weekly" },
      { id: "3p-5h", window: "5h" },
    ]);

    expect(parseAgyUsageOutput(measuredUsageOutput, "gemini")).toEqual(new Map([
      ["seven_day", {
        utilization: 1 - 0.6695590615272522,
        resets_at: Math.floor(Date.parse("2026-10-03T04:39:01Z") / 1_000),
      }],
      ["five_hour", {
        utilization: 1 - 0.4947547912597656,
        resets_at: Math.floor(Date.parse("2026-10-01T16:06:46Z") / 1_000),
      }],
    ]));
    expect(parseAgyUsageOutput(measuredUsageOutput, "3p")).toEqual(new Map([
      ["seven_day", {
        utilization: 1 - 0.9866412281990051,
        resets_at: Math.floor(Date.parse("2026-10-01T15:47:19Z") / 1_000),
      }],
      ["five_hour", { utilization: 0 }],
    ]));
  });

  it("uses the production usage spawner only at a turn boundary, never while idle or pending a model", async () => {
    const root = mkdtempSync(join(tmpdir(), "momo384-no-turn-"));
    const executable = join(root, "agy-fixture.mjs");
    const callLog = join(root, "calls.jsonl");
    writeFileSync(executable, `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(callLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nif (process.argv[2] === "models") process.stdout.write("gemini-3.8-flash-high\\tGemini 3.8\\n");\nelse process.exitCode = 7;\n`);
    chmodSync(executable, 0o755);
    const cfg = config();
    const host = new AntigravityHost(cfg, {
      cwd: root,
      appendSystemPrompt: "persona",
      permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }),
      onState: () => {},
      agyPath: executable,
    });
    try {
      await waitFor(() => existsSync(callLog) && readFileSync(callLog, "utf8").includes("models"));
      await host.setModel("gpt-5");
      await new Promise((resolve) => setTimeout(resolve, 100));
      const calls = readFileSync(callLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
      expect(calls).toEqual([["models"]]);
    } finally {
      await host.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses default spawn and arguments to publish the fixture executable's /usage snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-default-usage-"));
    const executable = join(root, "agy fixture.mjs");
    const callsFile = join(root, "calls.jsonl");
    const hook = `${process.execPath} ${new URL("../dist/hook.js", import.meta.url).pathname}`;
    writeFileSync(executable, `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + "\\n");
if (args[0] === "models") {
  process.stdout.write("gemini-2.5-pro\\tGemini 2.5 Pro\\n");
} else if (args[0] === "-p" && args[1] === "/hooks") {
  const customization = args[args.lastIndexOf("--add-dir") + 1];
  process.stdout.write(JSON.stringify({ hooks: [{ source: customization + "/.agents/hooks.json", actions: [{ event: "PreToolUse", matcher: "*", command: ${JSON.stringify(hook)}, timeout_seconds: 3600 }] }] }));
} else if (args[0] === "-p" && args[1] === "/usage") {
  if (JSON.stringify(args) !== JSON.stringify(["-p", "/usage", "--output-format", "json"])) {
    process.exitCode = 2;
  } else {
    process.stdout.write(${JSON.stringify(measuredUsageOutput)});
  }
} else if (args[0] === "--print") {
  let input = "";
  let replied = false;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
    const newline = input.indexOf("\\n");
    if (newline === -1 || replied) return;
    replied = true;
    process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "default usage fixture" } }) + "\\n");
  });
} else {
  process.exitCode = 2;
}
`);
    chmodSync(executable, 0o755);
    const cfg = config({ antigravity_cli_path: executable });
    const logs: Envelope[] = [];
    const states: Envelope[] = [];
    const host = new AntigravityHost(cfg, {
      cwd: root,
      appendSystemPrompt: "persona",
      permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }),
      onState: (envelope) => states.push(envelope),
      onLog: (envelope) => logs.push(envelope),
      runtimeAssetsAvailable: () => true,
    });
    try {
      await host.send("run one fixture-backed turn");
      await waitFor(() => logs.some((envelope) => envelope.type === "result"), 8_000);
      await waitFor(() => existsSync(callsFile) && readFileSync(callsFile, "utf8").includes("/usage"), 8_000);

      const calls = readFileSync(callsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
      expect(calls.filter((args) => args[0] === "-p" && args[1] === "/usage")).toEqual([
        ["-p", "/usage", "--output-format", "json"],
      ]);
      await waitFor(() => states.some((envelope) => envelope.ext?.rate_limits !== undefined), 8_000);
      expect(states.at(-1)?.ext?.rate_limits).toEqual(measuredGeminiLimits);
      expect(host.statusSnapshot().rate_limits).toEqual(measuredGeminiLimits);
    } finally {
      await host.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("publishes the complete current-family snapshot only after the probe closes", async () => {
    const harness = makeHarness({ now: () => "2026-10-03T10:00:00.000Z" });
    try {
      await completeTurn(harness, { status: "SUCCESS" });
      expect(harness.probes).toHaveLength(1);
      expect(harness.host.statusSnapshot()).not.toHaveProperty("rate_limits");

      harness.probes[0]!.finish(usageOutput("gemini"));
      await waitFor(() => JSON.stringify(harness.host.statusSnapshot().rate_limits) === JSON.stringify(geminiLimits));
      expect(harness.states.at(-1)?.ext?.rate_limits).toEqual(geminiLimits);
      expect(harness.host.statusSnapshot().rate_limits).toEqual(geminiLimits);
    } finally {
      await harness.host.close();
    }
  });

  it("keeps a same-family snapshot and the throttle watermark after an unknown bucket", async () => {
    let now = "2026-10-03T10:00:00.000Z";
    const harness = makeHarness({ now: () => now });
    try {
      await completeTurn(harness, { status: "SUCCESS" });
      harness.probes[0]!.finish(usageOutput("gemini"));
      await waitFor(() => JSON.stringify(harness.host.statusSnapshot().rate_limits) === JSON.stringify(geminiLimits));

      await harness.host.setModel("gemini-3.8-flash-high");
      expect(harness.host.statusSnapshot().rate_limits).toEqual(geminiLimits);
      await completeTurn(harness, { status: "SUCCESS" });
      expect(harness.probes).toHaveLength(1);
      expect(harness.host.statusSnapshot().rate_limits).toEqual(geminiLimits);

      now = "2026-10-03T10:06:00.000Z";
      await completeTurn(harness, { status: "ERROR", error: "HTTP 500 backend unavailable" });
      expect(harness.probes).toHaveLength(2);
      harness.probes[1]!.finish(unknownBucketOutput());
      await waitFor(() => harness.warnings.some((warning) => warning.includes("unrecognized_or_empty_bucket_set")));
      expect(harness.host.statusSnapshot().rate_limits).toEqual(geminiLimits);

      await completeTurn(harness, { status: "SUCCESS" });
      expect(harness.probes).toHaveLength(2);
      now = "2026-10-03T10:10:59.999Z";
      await completeTurn(harness, { status: "SUCCESS" });
      expect(harness.probes).toHaveLength(2);
      now = "2026-10-03T10:11:00.000Z";
      await completeTurn(harness, { status: "SUCCESS" });
      expect(harness.probes).toHaveLength(3);
      harness.probes[2]!.finish(usageOutput("gemini"));
      await waitFor(() => JSON.stringify(harness.host.statusSnapshot().rate_limits) === JSON.stringify(geminiLimits));
    } finally {
      await harness.host.close();
    }
  });

  it("commits family, clears the overlay, publishes no stale value, then publishes the new probe snapshot", async () => {
    const harness = makeHarness({ now: () => "2026-10-03T10:00:00.000Z" });
    try {
      await completeTurn(harness, { status: "SUCCESS" });
      harness.probes[0]!.finish(usageOutput("gemini"));
      await waitFor(() => harness.host.statusSnapshot().rate_limits !== undefined);

      await completeTurn(harness, {
        status: "ERROR",
        error: "RESOURCE_EXHAUSTED (code 429): Quota reached. Resets in 10m",
      });
      expect(harness.host.statusSnapshot().rate_limits).toEqual({
        five_hour: geminiLimits.five_hour,
        seven_day: { status: "blocked", utilization: 1, resets_at: 1791022200 },
      });
      expect(harness.probes).toHaveLength(1);

      await harness.host.setModel("gpt-5");
      await completeTurn(harness, { status: "SUCCESS" });
      expect(harness.probes).toHaveLength(2);
      expect(harness.host.statusSnapshot()).not.toHaveProperty("rate_limits");

      harness.probes[1]!.finish(usageOutput("3p", 0.75, 0.5));
      await waitFor(() => harness.host.statusSnapshot().rate_limits !== undefined);
      expect(harness.host.statusSnapshot().rate_limits).toEqual(thirdPartyLimits);
      expect(harness.states.at(-1)?.ext?.rate_limits).toEqual(thirdPartyLimits);

      await harness.host.setModel("gemini-3.8-flash-high");
      await completeTurn(harness, { status: "SUCCESS" });
      expect(harness.probes).toHaveLength(3);
      expect(harness.host.statusSnapshot()).not.toHaveProperty("rate_limits");
      harness.probes[2]!.finish(usageOutput("gemini"));
      await waitFor(() => JSON.stringify(harness.host.statusSnapshot().rate_limits) === JSON.stringify(geminiLimits));
    } finally {
      await harness.host.close();
    }
  });

  it("keeps an expired 429 overlay authoritative while probing only at a later turn boundary", async () => {
    let now = "2026-10-03T10:00:00.000Z";
    const harness = makeHarness({ now: () => now });
    try {
      await completeTurn(harness, {
        status: "ERROR",
        error: "RESOURCE_EXHAUSTED (code 429): Quota reached. Resets in 10m",
      });
      expect(harness.probes).toHaveLength(0);

      now = "2026-10-03T10:11:00.000Z";
      await completeTurn(harness, { status: "ERROR", error: "HTTP 500 backend unavailable" });
      expect(harness.probes).toHaveLength(1);
      harness.probes[0]!.finish(usageOutput("gemini"));
      await waitFor(() => harness.host.statusSnapshot().rate_limits !== undefined);
      expect(harness.host.statusSnapshot().rate_limits).toEqual({
        five_hour: geminiLimits.five_hour,
        seven_day: { status: "blocked", utilization: 1, resets_at: 1791022200 },
      });
    } finally {
      await harness.host.close();
    }
  });

  it("does not revive a snapshot after leaving and returning to its family", async () => {
    const harness = makeHarness({ now: () => "2026-10-03T10:00:00.000Z" });
    try {
      await completeTurn(harness, { status: "SUCCESS" });
      harness.probes[0]!.finish(usageOutput("gemini"));
      await waitFor(() => harness.host.statusSnapshot().rate_limits !== undefined);

      await harness.host.setModel("gpt-5");
      await completeTurn(harness, { status: "SUCCESS" });
      expect(harness.host.statusSnapshot()).not.toHaveProperty("rate_limits");

      await harness.host.setModel("gemini-3.8-flash-high");
      await completeTurn(harness, { status: "SUCCESS" });
      await waitFor(() => harness.probes.length === 3);
      expect(harness.probes).toHaveLength(3);
      expect(harness.host.statusSnapshot()).not.toHaveProperty("rate_limits");
    } finally {
      await harness.host.close();
    }
  });

  it("does not invalidate a pending model, then suppresses the old snapshot after an unclassified model commits", async () => {
    const harness = makeHarness({ now: () => "2026-10-03T10:00:00.000Z" });
    try {
      await completeTurn(harness, { status: "SUCCESS" });
      harness.probes[0]!.finish(usageOutput("gemini"));
      await waitFor(() => harness.host.statusSnapshot().rate_limits !== undefined);

      await harness.host.setModel("experimental-model");
      expect(harness.host.statusSnapshot().rate_limits).toEqual(geminiLimits);
      await completeTurn(harness, { status: "SUCCESS" });
      expect(harness.host.statusSnapshot()).not.toHaveProperty("rate_limits");
      expect(harness.probes).toHaveLength(1);
    } finally {
      await harness.host.close();
    }
  });

  it("retains the snapshot after a failed model switch rolls back", async () => {
    const harness = makeHarness({ now: () => "2026-10-03T10:00:00.000Z" });
    try {
      await completeTurn(harness, { status: "SUCCESS" });
      harness.probes[0]!.finish(usageOutput("gemini"));
      await waitFor(() => harness.host.statusSnapshot().rate_limits !== undefined);

      await harness.host.setModel("gpt-5");
      await completeTurn(harness, { status: "ERROR", error: "HTTP 500 backend unavailable" });
      expect(harness.host.statusSnapshot().rate_limits).toEqual(geminiLimits);
      expect(harness.probes).toHaveLength(1);
    } finally {
      await harness.host.close();
    }
  });

  it("holds a stop timeout until late close, then allows the next successful boundary to retry", async () => {
    let nowMs = Date.parse("2026-10-03T10:00:00.000Z");
    const harness = makeHarness({
      now: () => new Date(nowMs).toISOString(),
      usageProbeTimeoutMs: 20,
      usageProbeStopTimeoutMs: 20,
      closeProbeOnSignal: false,
    });
    try {
      await completeTurn(harness, { status: "SUCCESS" });
      await waitFor(() => harness.warnings.some((warning) => warning.includes("did not close within the stop bound")));
      expect(harness.probes).toHaveLength(1);
      expect(harness.probeSignals).toEqual([{ destination: "pid", signal: "SIGKILL" }]);

      await completeTurn(harness, { status: "ERROR", error: "HTTP 500 before old child closes" });
      expect(harness.probes).toHaveLength(1);
      harness.probes[0]!.finish("", null, "SIGKILL");
      await waitFor(() => harness.warnings.some((warning) => warning.includes("stopped:timeout")));

      nowMs += 60_000;
      await completeTurn(harness, { status: "SUCCESS" });
      expect(harness.probes).toHaveLength(1);
      nowMs = Date.parse("2026-10-03T10:00:00.000Z") + USAGE_PROBE_INTERVAL_MS;
      await completeTurn(harness, { status: "SUCCESS" });
      expect(harness.probes).toHaveLength(2);
      harness.probes[1]!.finish(usageOutput("gemini"));
      await waitFor(() => harness.host.statusSnapshot().rate_limits !== undefined);
      expect(harness.host.statusSnapshot().rate_limits).toEqual(geminiLimits);
    } finally {
      await harness.host.close();
    }
  });

  it("starts the new family's probe when an already-stopping old-family probe closes", async () => {
    let nowMs = Date.parse("2026-10-03T10:00:00.000Z");
    const harness = makeHarness({
      now: () => new Date(nowMs).toISOString(),
      usageProbeTimeoutMs: 20,
      usageProbeStopTimeoutMs: 2_000,
      closeProbeOnSignal: false,
    });
    try {
      await completeTurn(harness, { status: "SUCCESS" });
      expect(harness.probes).toHaveLength(1);
      await waitFor(() => harness.probeSignals.length === 1);

      await harness.host.setModel("gpt-5");
      await completeTurn(harness, { status: "SUCCESS" });
      expect(harness.probes).toHaveLength(1);
      expect(harness.host.statusSnapshot()).not.toHaveProperty("rate_limits");

      harness.probes[0]!.finish("", null, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(harness.probes).toHaveLength(1);
      nowMs += USAGE_PROBE_INTERVAL_MS;
      await completeTurn(harness, { status: "SUCCESS" });
      expect(harness.probes).toHaveLength(2);
      expect(harness.warnings.some((warning) => warning.includes("stopped:timeout"))).toBe(false);
      harness.probes[1]!.finish(usageOutput("3p", 0.75, 0.5));
      await waitFor(() => harness.host.statusSnapshot().rate_limits !== undefined);
      expect(harness.host.statusSnapshot().rate_limits).toEqual(thirdPartyLimits);
    } finally {
      await harness.host.close();
    }
  });

  it("aborts an in-flight usage probe on interrupt and retries after a successful turn", async () => {
    let nowMs = Date.parse("2026-10-03T10:00:00.000Z");
    const harness = makeHarness({ now: () => new Date(nowMs).toISOString() });
    try {
      await completeTurn(harness, { status: "SUCCESS" });
      expect(harness.probes).toHaveLength(1);

      await harness.host.interrupt();
      expect(harness.probeSignals).toEqual([{ destination: "pid", signal: "SIGKILL" }]);
      await waitFor(() => harness.warnings.some((warning) => warning.includes("usage probe stopped: abort")));
      expect(harness.host.statusSnapshot()).not.toHaveProperty("rate_limits");

      nowMs += USAGE_PROBE_INTERVAL_MS;
      await completeTurn(harness, { status: "SUCCESS" });
      expect(harness.probes).toHaveLength(2);
      harness.probes[1]!.finish(usageOutput("gemini"));
      await waitFor(() => harness.host.statusSnapshot().rate_limits !== undefined);
      expect(harness.host.statusSnapshot().rate_limits).toEqual(geminiLimits);
    } finally {
      await harness.host.close();
    }
  });

  it("retries at the next successful turn after an interrupt abort without a failure floor", async () => {
    const harness = makeHarness({ now: () => "2026-10-03T10:00:00.000Z" });
    try {
      await completeTurn(harness, { status: "SUCCESS" });
      expect(harness.probes).toHaveLength(1);

      await harness.host.interrupt();
      await waitFor(() => harness.warnings.some((warning) => warning.includes("usage probe stopped: abort")));
      expect(harness.probeSignals).toEqual([{ destination: "pid", signal: "SIGKILL" }]);

      await completeTurn(harness, { status: "SUCCESS" });
      expect(harness.probes).toHaveLength(2);
      harness.probes[1]!.finish(usageOutput("gemini"));
      await waitFor(() => harness.host.statusSnapshot().rate_limits !== undefined);
      expect(harness.host.statusSnapshot().rate_limits).toEqual(geminiLimits);
    } finally {
      await harness.host.close();
    }
  });

  it("signals both children synchronously in close and awaits their bounded shutdown", async () => {
    const harness = makeHarness();
    await completeTurn(harness, { status: "SUCCESS" });
    expect(harness.probes).toHaveLength(1);
    let mainClosed = false;
    harness.turns[0]!.once("close", () => { mainClosed = true; });

    const closeWork = harness.host.close();
    void closeWork;
    expect(harness.signals).toContainEqual({
      target: harness.probes[0],
      destination: "pid",
      signal: "SIGKILL",
    });
    expect(harness.signals).toContainEqual({
      target: harness.turns[0],
      destination: "process_group",
      signal: "SIGTERM",
    });

    await expect(closeWork).resolves.toBeUndefined();
    expect(mainClosed).toBe(true);
    expect(harness.probes[0]!.signalCode).toBe("SIGKILL");
  });

  it("scopes failures to a family, suppresses after three, and lets success retry once", async () => {
    let nowMs = Date.parse("2026-10-03T10:00:00.000Z");
    const harness = makeHarness({ now: () => new Date(nowMs).toISOString() });
    try {
      for (let index = 0; index < 3; index += 1) {
        if (index > 0) nowMs += USAGE_PROBE_INTERVAL_MS;
        await completeTurn(harness, { status: "ERROR", error: "HTTP 500 backend unavailable" });
        expect(harness.probes).toHaveLength(index + 1);
        harness.probes[index]!.finish("", 1);
        await waitFor(() => harness.warnings.filter((warning) => warning.includes("exit_1")).length === index + 1);
      }

      await completeTurn(harness, { status: "ERROR", error: "HTTP 500 still failing" });
      expect(harness.probes).toHaveLength(3);

      nowMs += USAGE_PROBE_INTERVAL_MS;
      await completeTurn(harness, { status: "SUCCESS" });
      expect(harness.probes).toHaveLength(4);
      harness.probes[3]!.finish(usageOutput("gemini"));
      await waitFor(() => harness.host.statusSnapshot().rate_limits !== undefined);
      expect(harness.host.statusSnapshot().rate_limits).toEqual(geminiLimits);
    } finally {
      await harness.host.close();
    }
  });

  it("keeps the failed-attempt floor across successful turns and family changes", async () => {
    const startMs = Date.parse("2026-10-03T10:00:00.000Z");
    let nowMs = startMs;
    const harness = makeHarness({ now: () => new Date(nowMs).toISOString() });
    try {
      await completeTurn(harness, { status: "ERROR", error: "HTTP 500 usage unavailable" });
      expect(harness.probes).toHaveLength(1);
      harness.probes[0]!.finish("", 1);
      await waitFor(() => harness.warnings.some((warning) => warning.includes("exit_1")));

      await harness.host.setModel("gpt-5");
      nowMs = startMs + 60_000;
      await completeTurn(harness, { status: "SUCCESS" });
      expect(harness.probes).toHaveLength(1);
      expect(harness.host.statusSnapshot()).not.toHaveProperty("rate_limits");

      nowMs = startMs + USAGE_PROBE_INTERVAL_MS - 1;
      await completeTurn(harness, { status: "SUCCESS" });
      expect(harness.probes).toHaveLength(1);

      nowMs = startMs + USAGE_PROBE_INTERVAL_MS;
      await completeTurn(harness, { status: "SUCCESS" });
      await waitFor(() => harness.probes.length === 2);
      harness.probes[1]!.finish(usageOutput("3p", 0.75, 0.5));
      await waitFor(() => harness.host.statusSnapshot().rate_limits !== undefined);
      expect(harness.host.statusSnapshot().rate_limits).toEqual(thirdPartyLimits);
    } finally {
      await harness.host.close();
    }
  });

  it("starts the retry floor at a synchronous usage spawn throw", async () => {
    const startMs = Date.parse("2026-10-03T10:00:00.000Z");
    let nowMs = startMs;
    const harness = makeHarness({
      now: () => new Date(nowMs).toISOString(),
      throwUsageProbeSpawn: true,
    });
    try {
      await completeTurn(harness, { status: "SUCCESS" });
      expect(harness.warnings.filter((warning) => warning.includes("fixture usage spawn throw"))).toHaveLength(1);

      nowMs = startMs + USAGE_PROBE_INTERVAL_MS - 1;
      await completeTurn(harness, { status: "SUCCESS" });
      expect(harness.warnings.filter((warning) => warning.includes("fixture usage spawn throw"))).toHaveLength(1);

      nowMs = startMs + USAGE_PROBE_INTERVAL_MS;
      await completeTurn(harness, { status: "SUCCESS" });
      expect(harness.warnings.filter((warning) => warning.includes("fixture usage spawn throw"))).toHaveLength(2);
    } finally {
      await harness.host.close();
    }
  });

  it("keeps positive-delay 429s blocked without consuming stale confirmations", async () => {
    const now = "2026-10-03T10:00:00.000Z";
    const harness = makeHarness({ now: () => now });
    try {
      await confirmStaleTerminal429(harness);
      await confirmStaleTerminal429(harness);
      const probeCount = harness.probes.length;

      await completeTurn(harness, {
        status: "ERROR",
        error: "RESOURCE_EXHAUSTED (code 429): quota reached. Resets in 1m44s",
      });
      expect(harness.turnEndErrors.at(-1)).toEqual({ reason: "blocking_limit", rateLimitResetSeconds: 104 });
      expect(harness.probes).toHaveLength(probeCount);
      expect(harness.host.statusSnapshot().rate_limits).toEqual({
        ...geminiLimits,
        seven_day: {
          status: "blocked",
          utilization: 1,
          resets_at: Math.floor(Date.parse(now) / 1_000) + 104,
        },
      });

      await completeTurn(harness, {
        status: "ERROR",
        error: "RESOURCE_EXHAUSTED (code 429): quota reached. Resets in 0s",
      });
      expect(harness.turnEndErrors.at(-1)).toEqual({ reason: "api_error" });
      expect(harness.probes).toHaveLength(probeCount);
      expect(harness.host.statusSnapshot().rate_limits).toEqual(geminiLimits);
    } finally {
      await harness.host.close();
    }
  });

  it("classifies the third confirmed-stale terminal 429 as api_error", async () => {
    const harness = makeHarness({ now: () => "2026-10-03T10:00:00.000Z" });
    try {
      await confirmStaleTerminal429(harness);
      await confirmStaleTerminal429(harness);
      const probeCount = harness.probes.length;

      await completeTurn(harness, {
        status: "ERROR",
        error: "RESOURCE_EXHAUSTED (code 429): quota reached. Resets in 0s",
      });
      expect(harness.turnEndErrors.at(-1)).toEqual({ reason: "api_error" });
      expect(harness.probes).toHaveLength(probeCount);
      expect(harness.host.statusSnapshot().rate_limits).toEqual(geminiLimits);
      expect(harness.logs.some((entry) => JSON.stringify(entry).includes("Consider resetting the session"))).toBe(true);
    } finally {
      await harness.host.close();
    }
  });

  it("resets the stale-confirmation streak when a successful turn intervenes", async () => {
    const harness = makeHarness({ now: () => "2026-10-03T10:00:00.000Z" });
    try {
      await confirmStaleTerminal429(harness);
      await completeTurn(harness, { status: "SUCCESS" });
      await confirmStaleTerminal429(harness);

      const previousProbeCount = harness.probes.length;
      await completeTurn(harness, {
        status: "ERROR",
        error: "RESOURCE_EXHAUSTED (code 429): quota reached. Resets in 0s",
      });
      expect(harness.turnEndErrors.at(-1)).toEqual({ reason: "blocking_limit", rateLimitResetSeconds: 0 });
      expect(harness.probes).toHaveLength(previousProbeCount + 1);
    } finally {
      await harness.host.close();
    }
  });

  it("resets the stale-confirmation streak when an ordinary complete snapshot has an empty bucket", async () => {
    let nowMs = Date.parse("2026-10-03T10:00:00.000Z");
    const harness = makeHarness({ now: () => new Date(nowMs).toISOString() });
    try {
      await confirmStaleTerminal429(harness);
      await confirmStaleTerminal429(harness);

      nowMs += USAGE_PROBE_INTERVAL_MS;
      const probeCount = harness.probes.length;
      await completeTurn(harness, { status: "ERROR", error: "HTTP 500 backend unavailable" });
      await waitFor(() => harness.probes.length === probeCount + 1);
      harness.probes.at(-1)!.finish(usageOutput("gemini", 0, 0.25));
      await waitFor(() => statusRateLimits(harness)?.five_hour?.status === "blocked");

      const afterEmptySnapshot = harness.probes.length;
      await completeTurn(harness, {
        status: "ERROR",
        error: "RESOURCE_EXHAUSTED (code 429): quota reached. Resets in 0s",
      });
      expect(harness.turnEndErrors.at(-1)).toEqual({ reason: "blocking_limit", rateLimitResetSeconds: 0 });
      expect(harness.probes).toHaveLength(afterEmptySnapshot + 1);
    } finally {
      await harness.host.close();
    }
  });

  it("retries one pending confirmation when the failed-attempt floor expires", async () => {
    const startMs = Date.parse("2026-10-03T10:00:00.000Z");
    let nowMs = startMs;
    const floorTimers = new FakeFloorTimers(() => nowMs);
    const harness = makeHarness({
      now: () => new Date(nowMs).toISOString(),
      floorTimers,
    });
    try {
      await completeTurn(harness, { status: "ERROR", error: "HTTP 500 backend unavailable" });
      harness.probes[0]!.finish("", 1);
      await waitFor(() => harness.warnings.some((warning) => warning.includes("exit_1")));

      nowMs += 1;
      await completeTurn(harness, {
        status: "ERROR",
        error: "RESOURCE_EXHAUSTED (code 429): quota reached. Resets in 0s",
      });
      expect(harness.probes).toHaveLength(1);
      expect(floorTimers.size).toBe(1);

      nowMs = startMs + USAGE_PROBE_INTERVAL_MS - 1;
      floorTimers.advance();
      expect(harness.probes).toHaveLength(1);

      nowMs += 1;
      floorTimers.advance();
      await waitFor(() => harness.probes.length === 2);
      expect(floorTimers.size).toBe(0);
      harness.probes[1]!.finish(usageOutput("gemini"));
      await waitFor(() => statusRateLimits(harness)?.seven_day?.utilization === 0.75);
    } finally {
      await harness.host.close();
    }
  });

  it("cancels the pending-confirmation floor timer when a new turn is admitted or the host closes", async () => {
    async function withPendingTimer() {
      const startMs = Date.parse("2026-10-03T10:00:00.000Z");
      let nowMs = startMs;
      const floorTimers = new FakeFloorTimers(() => nowMs);
      const harness = makeHarness({ now: () => new Date(nowMs).toISOString(), floorTimers });
      await completeTurn(harness, { status: "ERROR", error: "HTTP 500 backend unavailable" });
      harness.probes[0]!.finish("", 1);
      await waitFor(() => harness.warnings.some((warning) => warning.includes("exit_1")));
      nowMs += 1;
      await completeTurn(harness, {
        status: "ERROR",
        error: "RESOURCE_EXHAUSTED (code 429): quota reached. Resets in 0s",
      });
      expect(floorTimers.size).toBe(1);
      return { harness, floorTimers };
    }

    const admitted = await withPendingTimer();
    const starts = admitted.harness.turnStarts.length;
    await admitted.harness.host.send("new turn");
    await waitFor(() => admitted.harness.turnStarts.length === starts + 1);
    expect(admitted.floorTimers.size).toBe(0);
    await admitted.harness.host.close();
    expect(admitted.floorTimers.size).toBe(0);

    const closing = await withPendingTimer();
    await closing.harness.host.close();
    expect(closing.floorTimers.size).toBe(0);
  });

  it("cancels the pending-confirmation floor timer when the committed family changes", async () => {
    const startMs = Date.parse("2026-10-03T10:00:00.000Z");
    let nowMs = startMs;
    const floorTimers = new FakeFloorTimers(() => nowMs);
    const harness = makeHarness({ now: () => new Date(nowMs).toISOString(), floorTimers });
    try {
      await completeTurn(harness, { status: "ERROR", error: "HTTP 500 backend unavailable" });
      harness.probes[0]!.finish("", 1);
      await waitFor(() => harness.warnings.some((warning) => warning.includes("exit_1")));

      nowMs += 1;
      await completeTurn(harness, {
        status: "ERROR",
        error: "RESOURCE_EXHAUSTED (code 429): quota reached. Resets in 0s",
      });
      expect(floorTimers.size).toBe(1);

      await harness.host.setModel("gpt-5");
      await completeTurn(harness, { status: "SUCCESS" });
      expect(harness.host.statusSnapshot()).not.toHaveProperty("rate_limits");
      expect(floorTimers.size).toBe(0);

      nowMs = startMs + USAGE_PROBE_INTERVAL_MS;
      floorTimers.advance();
      expect(harness.probes).toHaveLength(1);
    } finally {
      await harness.host.close();
    }
  });
});
