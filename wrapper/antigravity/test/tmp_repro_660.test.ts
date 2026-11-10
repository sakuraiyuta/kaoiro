import "../../../scripts/test/fixtures/test-isolation.mjs";
import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { PermissionBroker, type Envelope, type WrapperConfig } from "@kaoiro/agent-common";
import { USAGE_PROBE_INTERVAL_MS } from "../src/usage_probe.js";
import { createHarnessHost, type HarnessAgy } from "./host_test_harness.js";
import type { SignalTargetOperation } from "../src/subtree_termination.js";

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

function usageOutput(): string {
  return JSON.stringify({
    status: "SUCCESS",
    command: {
      name: "usage",
      data: {
        groups: [{
          name: "Gemini Models",
          buckets: [
            { id: "gemini-5h", window: "5h", remaining_fraction: 0.6, reset_time: "2026-10-03T12:00:00Z" },
            { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.25, reset_time: "2026-10-04T12:00:00Z" },
          ],
        }],
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

function make(nowMsRef: { value: number }) {
  const states: Envelope[] = [];
  const probes: FakeUsageChild[] = [];
  const turns: HarnessAgy[] = [];
  const turnStarts: string[] = [];
  const turnEnds: string[] = [];
  const warnings: string[] = [];
  const floorSets: number[] = [];
  const signalTarget: SignalTargetOperation = (target, _destination, signal) => {
    const turn = turns.find((candidate) => candidate === target);
    if (turn !== undefined) queueMicrotask(() => turn.finish());
    const probe = probes.find((candidate) => candidate === target);
    if (probe !== undefined) queueMicrotask(() => probe.finish("", null, signal as NodeJS.Signals));
    return true;
  };
  const cfg: WrapperConfig = {
    agent_id: "a1",
    persona: { id: "momo", name: "Momo", sprite_set: "momo" },
    display_name: "Momo",
    server_url: "ws://localhost:4000",
    sandbox: "workspace-write",
    network_access: false,
    model: "gemini-2.5-pro",
  };
  const host = createHarnessHost(cfg, {
    cwd: process.cwd(),
    appendSystemPrompt: "persona",
    permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }),
    onState: (envelope) => states.push(envelope),
    onLog: () => {},
    onTurnStart: ({ turnToken }) => turnStarts.push(turnToken),
    onTurnEnd: ({ turnToken }) => turnEnds.push(turnToken),
    runtimeAssetsAvailable: () => true,
    verifyGate: async () => true,
    agyPath: "/test/agy",
    signalTarget,
    warn: (message) => warnings.push(message),
    now: () => new Date(nowMsRef.value).toISOString(),
    usageProbeTimeoutMs: 20,
    usageProbeFloorSetTimer: (_callback: () => void, delayMs: number) => {
      floorSets.push(delayMs);
      return floorSets.length;
    },
    usageProbeFloorClearTimer: () => {},
    usageProbeSpawn: () => {
      const child = new FakeUsageChild();
      probes.push(child);
      return child as unknown as ChildProcess;
    },
  }, { onAgySpawn: (child) => turns.push(child) });
  return { host, states, probes, turns, turnStarts, turnEnds, warnings, floorSets };
}

describe("issue 660 repro: a timed-out startup probe is never retried before the first turn", () => {
  it("records the timeout, arms no retry, and only the first turn starts another probe", async () => {
    const nowMsRef = { value: Date.parse("2026-11-10T10:29:27.000Z") };
    const h = make(nowMsRef);
    try {
      h.host.probeRateLimits();
      expect(h.probes).toHaveLength(1);
      await waitFor(() => h.warnings.some((warning) => warning.includes("stopped:timeout")));
      expect(h.host.statusExtSnapshot()).not.toHaveProperty("rate_limits");

      expect(h.floorSets).toEqual([]);

      nowMsRef.value += USAGE_PROBE_INTERVAL_MS * 10;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(h.probes).toHaveLength(1);
      expect(h.host.statusExtSnapshot()).not.toHaveProperty("rate_limits");

      await h.host.send("first turn");
      await waitFor(() => h.turnStarts.length === 1);
      (h.turns.at(-1)!.stdout as PassThrough).write(
        `${JSON.stringify({ event: "result", result: { response: "ok", status: "SUCCESS" } })}\n`,
      );
      await waitFor(() => h.turnEnds.length === 1);
      await waitFor(() => h.probes.length === 2);
      h.probes[1]!.finish(usageOutput());
      await waitFor(() => h.host.statusExtSnapshot().rate_limits !== undefined);
    } finally {
      await h.host.close();
    }
  });
});
