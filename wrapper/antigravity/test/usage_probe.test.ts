import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  modelToUsageFamily,
  parseAgyUsageOutput,
  startAgyUsageProbe,
} from "../src/usage_probe.js";

class FakeProbeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = null;
  readonly stdin = null;
  pid = 43210;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  finish(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
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
        groups: [
          {
            name: "Gemini Models",
            buckets: [
              { id: "gemini-5h", window: "5h", remaining_fraction: 0.6, reset_time: "2026-10-03T12:00:00Z" },
              { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.25, reset_time: "2026-10-04T12:00:00Z" },
            ],
          },
          {
            name: "Claude and GPT models",
            buckets: [
              { id: "3p-5h", window: "5h", remaining_fraction: 0.8, reset_time: "2026-10-03T12:00:00Z" },
              { id: "3p-weekly", window: "weekly", remaining_fraction: 0.5, reset_time: "2026-10-04T12:00:00Z" },
            ],
          },
        ],
      },
    },
  });
}

describe("Antigravity usage probe parsing and process settlement", () => {
  it("classifies only committed model families", () => {
    expect(modelToUsageFamily("gemini-3.8-flash-high")).toBe("gemini");
    expect(modelToUsageFamily("claude-sonnet-4")).toBe("3p");
    expect(modelToUsageFamily("gpt-5")).toBe("3p");
    expect(modelToUsageFamily("unknown-model")).toBeNull();
    expect(modelToUsageFamily(undefined)).toBeNull();
  });

  it("parses a complete snapshot for one bucket family only", () => {
    expect(parseAgyUsageOutput(usageOutput(), "gemini")).toEqual(new Map([
      ["five_hour", { utilization: 0.4, resets_at: 1791028800 }],
      ["seven_day", { utilization: 0.75, resets_at: 1791115200 }],
    ]));
    const thirdParty = parseAgyUsageOutput(usageOutput(), "3p");
    expect(thirdParty?.get("five_hour")?.utilization).toBeCloseTo(0.2, 12);
    expect(thirdParty?.get("five_hour")?.resets_at).toBe(1791028800);
    expect(thirdParty?.get("seven_day")).toEqual({ utilization: 0.5, resets_at: 1791115200 });
  });

  it("treats malformed and unknown bucket output as an unusable sample", () => {
    expect(parseAgyUsageOutput("not-json", "gemini")).toBeNull();
    expect(parseAgyUsageOutput(JSON.stringify({ status: "SUCCESS", command: { name: "usage", data: { groups: [] } } }), "gemini")).toBeNull();
    expect(parseAgyUsageOutput(JSON.stringify({
      status: "SUCCESS",
      command: { name: "usage", data: { groups: [null] } },
    }), "gemini")).toBeNull();
    expect(parseAgyUsageOutput(JSON.stringify({
      status: "SUCCESS",
      command: { name: "usage", data: { groups: [{ buckets: [null] }] } },
    }), "gemini")).toBeNull();
  });

  it("waits for close after exit before settling a requested stop", async () => {
    const child = new FakeProbeChild();
    const signals: Array<{ target: unknown; destination: string; signal: string }> = [];
    const run = startAgyUsageProbe("fake-agy", {
      args: ["probe"],
      timeoutMs: 10_000,
      stopTimeoutMs: 500,
      spawn: () => child as unknown as ChildProcess,
      signalTarget: (target, destination, signal) => {
        signals.push({ target, destination, signal });
        return true;
      },
    });
    let completionSettled = false;
    void run.completion.then(() => { completionSettled = true; });

    run.requestStop("abort");
    child.exitCode = null;
    child.signalCode = "SIGKILL";
    child.emit("exit", null, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(completionSettled).toBe(false);
    expect(signals).toEqual([{ target: child, destination: "pid", signal: "SIGKILL" }]);

    child.finish(null, "SIGKILL");
    await expect(run.completion).resolves.toMatchObject({
      kind: "closed",
      result: { code: null, signal: "SIGKILL", stopReason: "abort" },
    });
  });

  it("reports a bounded stop timeout, then still observes a late close", async () => {
    const child = new FakeProbeChild();
    const run = startAgyUsageProbe("fake-agy", {
      args: ["probe"],
      timeoutMs: 10_000,
      stopTimeoutMs: 10,
      spawn: () => child as unknown as ChildProcess,
      signalTarget: () => true,
    });
    run.requestStop("host_close");
    await expect(run.completion).resolves.toEqual({ kind: "stop_timed_out", reason: "host_close" });
    expect(run.state).toBe("stop_timed_out");

    child.finish(null, "SIGKILL");
    await expect(run.closed).resolves.toMatchObject({ code: null, signal: "SIGKILL", stopReason: "host_close" });
    expect(run.state).toBe("closed");
  });

  it("waits for close after an asynchronous spawn error and does not signal a missing PID", async () => {
    const child = new FakeProbeChild();
    let signalCount = 0;
    const run = startAgyUsageProbe("missing-agy", {
      args: ["probe"],
      timeoutMs: 1_000,
      stopTimeoutMs: 50,
      spawn: () => {
        queueMicrotask(() => {
          child.emit("error", Object.assign(new Error("not found"), { code: "ENOENT" }));
          child.finish(-2);
        });
        return child as unknown as ChildProcess;
      },
      signalTarget: () => { signalCount += 1; return false; },
    });
    await expect(run.completion).resolves.toMatchObject({
      kind: "closed",
      result: { code: -2, spawnError: { message: "not found" } },
    });
    expect(signalCount).toBe(0);
  });

  it("leaves a synchronous spawn throw outside the running lifecycle", () => {
    expect(() => startAgyUsageProbe("bad-agy", {
      spawn: () => { throw new Error("synchronous spawn failure"); },
    })).toThrow("synchronous spawn failure");
  });

  it("sends SIGKILL to its own held child PID and settles on the real close event", async () => {
    const run = startAgyUsageProbe(process.execPath, {
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 30_000,
      stopTimeoutMs: 1_000,
      spawn: (command, args, options) => spawn(command, args, options),
    });
    const ownedPid = run.child.pid;
    expect(Number.isInteger(ownedPid)).toBe(true);
    expect(ownedPid).toBeGreaterThan(1);
    expect(ownedPid).not.toBe(process.pid);

    run.requestStop("abort");
    await expect(run.completion).resolves.toMatchObject({
      kind: "closed",
      result: { code: null, signal: "SIGKILL", stopReason: "abort" },
    });
    expect(run.child.pid).toBe(ownedPid);
    expect(run.child.signalCode).toBe("SIGKILL");
  });
});
