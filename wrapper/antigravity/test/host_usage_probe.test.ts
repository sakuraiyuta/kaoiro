import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { PermissionBroker, type Envelope, type WrapperConfig } from "@kaoiro/agent-common";
import { AntigravityHost, type AntigravityHostOptions, type SpawnedAgy } from "../src/host.js";
import { createHarnessHost } from "./host_test_harness.js";
import type { SignalTargetOperation } from "../src/subtree_termination.js";

function config(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    agent_id: "a1",
    persona: { id: "momo", name: "もも", sprite_set: "momo" },
    display_name: "もも",
    server_url: "ws://localhost:4000",
    sandbox: "workspace-write",
    network_access: false,
    model: "gemini-2.5-pro",
    ...overrides,
  };
}

class FakeTurnChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  killed: NodeJS.Signals | undefined;
  pid = 23456;

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = signal;
    return true;
  }

  finish(): void {
    this.stdout.end();
    this.emit("exit", 0, null);
    this.emit("close", 0, null);
  }
}

class FakeProbeProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid = 12345;
  exitCode: number | null = null;

  finish(code = 0): void {
    this.exitCode = code;
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }
}

function makeUsageStdout(remaining5h = 0.5, remainingWeekly = 0.7): string {
  return JSON.stringify({
    status: "SUCCESS",
    command: {
      name: "usage",
      data: {
        groups: [
          {
            name: "Gemini Models",
            buckets: [
              {
                id: "gemini-5h",
                window: "5h",
                remaining_fraction: remaining5h,
                reset_time: "2026-10-01T16:06:46Z",
              },
              {
                id: "gemini-weekly",
                window: "weekly",
                remaining_fraction: remainingWeekly,
                reset_time: "2026-10-03T04:39:01Z",
              },
            ],
          },
        ],
      },
    },
  });
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
  usageProbeSpawn?: AntigravityHostOptions["usageProbeSpawn"];
  signalTarget?: AntigravityHostOptions["signalTarget"];
  now?: () => string;
  usageProbeIntervalMs?: number;
  onState?: (envelope: Envelope) => void;
} = {}) {
  const states: Envelope[] = [];
  const calls: { child: FakeTurnChild }[] = [];
  const cfg = config();
  const broker = new PermissionBroker({ config: cfg, send: () => {} });
  const host = createHarnessHost(cfg, {
    cwd: process.cwd(),
    appendSystemPrompt: "persona",
    permissionBroker: broker,
    onState: (envelope) => {
      states.push(envelope);
      options.onState?.(envelope);
    },
    runtimeAssetsAvailable: () => true,
    verifyGate: async () => true,
    agyPath: "/test/agy",
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.usageProbeIntervalMs !== undefined ? { usageProbeIntervalMs: options.usageProbeIntervalMs } : {}),
    ...(options.usageProbeSpawn !== undefined ? { usageProbeSpawn: options.usageProbeSpawn } : {}),
    ...(options.signalTarget !== undefined ? { signalTarget: options.signalTarget } : {}),
    spawn: () => {
      const child = new FakeTurnChild();
      calls.push({ child });
      return child as unknown as SpawnedAgy;
    },
  });
  return { host, states, calls };
}

describe("AntigravityHost usage probe integration", () => {
  it("A constructed AntigravityHost with no turn spawns nothing (requirement 1)", async () => {
    let probeSpawnCount = 0;
    const cfg = config();
    const host = createHarnessHost(cfg, {
      cwd: process.cwd(),
      appendSystemPrompt: "persona",
      permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }),
      onState: () => {},
      agyPath: "/test/agy",
      usageProbeSpawn: () => {
        probeSpawnCount++;
        return new FakeProbeProcess() as unknown as ChildProcess;
      },
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(probeSpawnCount).toBe(0);

      // setModel before any turn must also not trigger a probe
      await host.setModel("gemini-2.5-pro");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(probeSpawnCount).toBe(0);
    } finally {
      await host.close();
    }
  });

  it("spawns usage probe on turn result and updates rate_limits in state envelope", async () => {
    let probeChild: FakeProbeProcess | null = null;
    const { host, states, calls } = makeHarness({
      usageProbeSpawn: () => {
        probeChild = new FakeProbeProcess();
        queueMicrotask(() => {
          probeChild!.stdout.write(makeUsageStdout(0.4, 0.6));
          probeChild!.finish();
        });
        return probeChild as unknown as ChildProcess;
      },
    });

    try {
      await host.send("hello");
      await waitFor(() => calls.length === 1);

      calls[0]!.child.stdout.write(
        '{"event":"init","conversation_id":"conv-1","init":{"model":"gemini-2.5-pro","tools":[]}}\n',
      );
      calls[0]!.child.stdout.write(
        '{"event":"result","result":{"status":"SUCCESS","response":"done"}}\n',
      );

      await waitFor(() => states.some((s) => s.ext?.rate_limits !== undefined));

      const stateWithLimits = states.find((s) => s.ext?.rate_limits !== undefined);
      expect(stateWithLimits).toBeDefined();
      const limits = stateWithLimits!.ext.rate_limits as Record<string, any>;
      expect(limits.five_hour).toBeDefined();
      expect(limits.five_hour.utilization).toBeCloseTo(0.6, 5);
      expect(limits.seven_day).toBeDefined();
      expect(limits.seven_day.utilization).toBeCloseTo(0.4, 5);
    } finally {
      await host.close();
    }
  });

  it("throttles usage probe with interval and skips if under interval", async () => {
    let currentTime = "2026-10-01T10:00:00Z";
    let probeCount = 0;

    const { host, calls } = makeHarness({
      now: () => currentTime,
      usageProbeIntervalMs: 5 * 60 * 1000,
      usageProbeSpawn: () => {
        probeCount++;
        const probe = new FakeProbeProcess();
        queueMicrotask(() => {
          probe.stdout.write(makeUsageStdout(0.5, 0.7));
          probe.finish();
        });
        return probe as unknown as ChildProcess;
      },
    });

    try {
      // Turn 1 triggers probe #1
      await host.send("turn 1");
      await waitFor(() => calls.length === 1);
      calls[0]!.child.stdout.write(
        '{"event":"init","conversation_id":"c1","init":{"model":"gemini-2.5-pro","tools":[]}}\n',
      );
      calls[0]!.child.stdout.write(
        '{"event":"result","result":{"status":"SUCCESS","response":"done 1"}}\n',
      );
      await waitFor(() => probeCount === 1);

      // Turn 2 after 1 minute (under 5 minute interval) does NOT trigger probe
      currentTime = "2026-10-01T10:01:00Z";
      await host.send("turn 2");
      // Epoch is reused, turn 2 arrives on same child
      calls[0]!.child.stdout.write(
        '{"event":"result","result":{"status":"SUCCESS","response":"done 2"}}\n',
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(probeCount).toBe(1);

      // Turn 3 after 6 minutes (exceeds interval) triggers probe #2
      currentTime = "2026-10-01T10:06:01Z";
      await host.send("turn 3");
      calls[0]!.child.stdout.write(
        '{"event":"result","result":{"status":"SUCCESS","response":"done 3"}}\n',
      );
      await waitFor(() => probeCount === 2);
    } finally {
      await host.close();
    }
  });

  it("retains 429 quota exhaustion block when usage probe runs", async () => {
    const { host, states, calls } = makeHarness({
      usageProbeSpawn: () => {
        const probe = new FakeProbeProcess();
        queueMicrotask(() => {
          // Probe reports unblocked values
          probe.stdout.write(makeUsageStdout(0.9, 0.9));
          probe.finish();
        });
        return probe as unknown as ChildProcess;
      },
    });

    try {
      // Turn 1 hits 429 error
      await host.send("turn 1");
      await waitFor(() => calls.length === 1);
      calls[0]!.child.stdout.write(
        '{"event":"init","conversation_id":"c1","init":{"model":"gemini-2.5-pro","tools":[]}}\n',
      );
      calls[0]!.child.stdout.write(
        '{"event":"result","result":{"status":"ERROR","error":"RESOURCE_EXHAUSTED: Quota exceeded. Resets in 10m"}}\n',
      );
      await waitFor(() => states.some((s) => (s.ext?.rate_limits as Record<string, any> | undefined)?.seven_day?.status === "blocked"));

      const blockedState = states.find((s) => (s.ext?.rate_limits as Record<string, any> | undefined)?.seven_day?.status === "blocked");
      expect(blockedState).toBeDefined();
      expect((blockedState!.ext.rate_limits as Record<string, any>).seven_day.status).toBe("blocked");

      // Turn 2 succeeds and clears 429 block
      await host.send("turn 2");
      calls[0]!.child.stdout.write(
        '{"event":"result","result":{"status":"SUCCESS","response":"done"}}\n',
      );
      await waitFor(() => {
        const last = states[states.length - 1];
        return (last?.ext?.rate_limits as Record<string, any> | undefined)?.seven_day?.status === undefined;
      });
    } finally {
      await host.close();
    }
  });

  it("signals probe with SIGKILL via signalTarget on host.close() (requirement 2 mutation)", async () => {
    const signals: Array<{ target: unknown; destination: string; signal: string }> = [];
    let probeChild: FakeProbeProcess | null = null;

    const fakeSignalTarget: SignalTargetOperation = (target, destination, signal) => {
      signals.push({ target, destination, signal });
      return true;
    };

    const { host, calls } = makeHarness({
      signalTarget: fakeSignalTarget,
      usageProbeSpawn: () => {
        probeChild = new FakeProbeProcess();
        // Never finishes on its own to keep probe in-flight
        return probeChild as unknown as ChildProcess;
      },
    });

    try {
      await host.send("trigger turn and probe");
      await waitFor(() => calls.length === 1);

      calls[0]!.child.stdout.write(
        '{"event":"init","conversation_id":"c1","init":{"model":"gemini-2.5-pro","tools":[]}}\n',
      );
      calls[0]!.child.stdout.write(
        '{"event":"result","result":{"status":"SUCCESS","response":"done"}}\n',
      );

      await waitFor(() => probeChild !== null);

      expect(signals.some((s) => s.target === probeChild)).toBe(false);
      await host.close();

      const probeSignal = signals.find((s) => s.target === probeChild);
      expect(probeSignal).toEqual({
        target: probeChild,
        destination: "pid",
        signal: "SIGKILL",
      });
    } finally {
      await host.close();
    }
  });
});
