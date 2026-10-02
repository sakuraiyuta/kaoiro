import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { PermissionBroker, type Envelope, type WrapperConfig } from "@kaoiro/agent-common";
import { AntigravityHost } from "../src/host.js";
import type { SignalTargetOperation } from "../src/subtree_termination.js";
import { createHarnessHost, type HarnessAgy } from "./host_test_harness.js";

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
} = {}) {
  const states: Envelope[] = [];
  const turns: HarnessAgy[] = [];
  const probes: FakeUsageChild[] = [];
  const turnStarts: string[] = [];
  const turnEnds: string[] = [];
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
    onTurnStart: ({ turnToken }) => turnStarts.push(turnToken),
    onTurnEnd: ({ turnToken }) => turnEnds.push(turnToken),
    runtimeAssetsAvailable: () => true,
    verifyGate: async () => true,
    agyPath: "/test/agy",
    signalTarget,
    warn: (message) => warnings.push(message),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.usageProbeTimeoutMs === undefined ? {} : { usageProbeTimeoutMs: options.usageProbeTimeoutMs }),
    ...(options.usageProbeStopTimeoutMs === undefined ? {} : { usageProbeStopTimeoutMs: options.usageProbeStopTimeoutMs }),
    ...(options.usageProbeIntervalMs === undefined ? {} : { usageProbeIntervalMs: options.usageProbeIntervalMs }),
    usageProbeSpawn: () => {
      const child = new FakeUsageChild();
      probes.push(child);
      return child as unknown as ChildProcess;
    },
  }, { onAgySpawn: (child) => turns.push(child) });
  return { host, states, turns, probes, turnStarts, turnEnds, warnings, signals, probeSignals };
}

async function completeTurn(
  harness: ReturnType<typeof makeHarness>,
  result: { status: "SUCCESS" | "ERROR" | "CANCELED"; response?: string; error?: string },
): Promise<void> {
  const startCount = harness.turnStarts.length;
  const endCount = harness.turnEnds.length;
  await harness.host.send("test turn");
  await waitFor(() => harness.turnStarts.length > startCount);
  const child = harness.turns.at(-1)!;
  (child.stdout as PassThrough).write(`${JSON.stringify({ event: "result", result: { response: "ok", ...result } })}\n`);
  await waitFor(() => harness.turnEnds.length > endCount);
}

const geminiLimits = {
  five_hour: { utilization: 0.4, resets_at: 1791028800 },
  seven_day: { utilization: 0.75, resets_at: 1791115200 },
};
const thirdPartyLimits = {
  five_hour: { utilization: 0.25, resets_at: 1791028800 },
  seven_day: { utilization: 0.5, resets_at: 1791115200 },
};

describe("AntigravityHost usage probe state transitions", () => {
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
      await new Promise((resolve) => setTimeout(resolve, 40));
      const calls = readFileSync(callLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
      expect(calls).toEqual([["models"]]);
    } finally {
      await host.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

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
    const harness = makeHarness({
      now: () => "2026-10-03T10:00:00.000Z",
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

      await completeTurn(harness, { status: "SUCCESS" });
      expect(harness.probes).toHaveLength(2);
      harness.probes[1]!.finish(usageOutput("gemini"));
      await waitFor(() => harness.host.statusSnapshot().rate_limits !== undefined);
      expect(harness.host.statusSnapshot().rate_limits).toEqual(geminiLimits);
    } finally {
      await harness.host.close();
    }
  });

  it("aborts an in-flight usage probe on interrupt and retries after a successful turn", async () => {
    const harness = makeHarness({ now: () => "2026-10-03T10:00:00.000Z" });
    try {
      await completeTurn(harness, { status: "SUCCESS" });
      expect(harness.probes).toHaveLength(1);

      await harness.host.interrupt();
      expect(harness.probeSignals).toEqual([{ destination: "pid", signal: "SIGKILL" }]);
      await waitFor(() => harness.warnings.some((warning) => warning.includes("stopped:abort")));
      expect(harness.host.statusSnapshot()).not.toHaveProperty("rate_limits");

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
    const harness = makeHarness({ now: () => "2026-10-03T10:00:00.000Z" });
    try {
      for (let index = 0; index < 3; index += 1) {
        await completeTurn(harness, { status: "ERROR", error: "HTTP 500 backend unavailable" });
        expect(harness.probes).toHaveLength(index + 1);
        harness.probes[index]!.finish("", 1);
        await waitFor(() => harness.warnings.filter((warning) => warning.includes("exit_1")).length === index + 1);
      }

      await completeTurn(harness, { status: "ERROR", error: "HTTP 500 still failing" });
      expect(harness.probes).toHaveLength(3);

      await completeTurn(harness, { status: "SUCCESS" });
      expect(harness.probes).toHaveLength(4);
      harness.probes[3]!.finish(usageOutput("gemini"));
      await waitFor(() => harness.host.statusSnapshot().rate_limits !== undefined);
      expect(harness.host.statusSnapshot().rate_limits).toEqual(geminiLimits);
    } finally {
      await harness.host.close();
    }
  });
});
