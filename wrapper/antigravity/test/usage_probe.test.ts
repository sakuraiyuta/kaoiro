import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import {
  killChildGroup,
  modelToBucketPrefix,
  parseAgyUsageOutput,
  runAgyUsageProbe,
} from "../src/usage_probe.js";

const rawFixture = readFileSync(
  new URL("../../../docs/evidence/antigravity/usage-probe-raw-20261001.json", import.meta.url),
  "utf8",
);

describe("modelToBucketPrefix", () => {
  it("resolves gemini prefix for gemini models", () => {
    expect(modelToBucketPrefix("gemini-2.5-pro")).toBe("gemini-");
    expect(modelToBucketPrefix("gemini-3.8-flash-high")).toBe("gemini-");
  });

  it("resolves 3p prefix for claude and gpt models", () => {
    expect(modelToBucketPrefix("claude-sonnet-4-6")).toBe("3p-");
    expect(modelToBucketPrefix("gpt-oss-120b-medium")).toBe("3p-");
  });

  it("returns null for empty or unclassifiable models (should 5)", () => {
    expect(modelToBucketPrefix("")).toBeNull();
    expect(modelToBucketPrefix(undefined)).toBeNull();
    expect(modelToBucketPrefix("custom-fine-tuned-model")).toBeNull();
  });
});

describe("parseAgyUsageOutput", () => {
  it("parses Gemini buckets from real measurement fixture", () => {
    const limits = parseAgyUsageOutput(rawFixture, "gemini-3.8-flash-high");
    expect(limits).not.toBeNull();
    expect(limits!.has("five_hour")).toBe(true);
    expect(limits!.has("seven_day")).toBe(true);

    const fiveHour = limits!.get("five_hour")!;
    expect(fiveHour.utilization).toBeCloseTo(1 - 0.4947547912597656, 5);
    expect(fiveHour.resets_at).toBe(Math.floor(Date.parse("2026-10-01T16:06:46Z") / 1000));
    expect(fiveHour.status).toBeUndefined(); // nit 1: omitted on unblocked

    const sevenDay = limits!.get("seven_day")!;
    expect(sevenDay.utilization).toBeCloseTo(1 - 0.6695590615272522, 5);
    expect(sevenDay.resets_at).toBe(Math.floor(Date.parse("2026-10-03T04:39:01Z") / 1000));
    expect(sevenDay.status).toBeUndefined();
  });

  it("parses 3p buckets and omits resets_at when remaining_fraction >= 1.0 (should 3)", () => {
    const limits = parseAgyUsageOutput(rawFixture, "claude-sonnet-4-6");
    expect(limits).not.toBeNull();
    expect(limits!.has("five_hour")).toBe(true);
    expect(limits!.has("seven_day")).toBe(true);

    const fiveHour = limits!.get("five_hour")!;
    expect(fiveHour.utilization).toBe(0);
    expect(fiveHour.resets_at).toBeUndefined(); // should 3: placeholder omitted for unused bucket

    const sevenDay = limits!.get("seven_day")!;
    expect(sevenDay.utilization).toBeCloseTo(1 - 0.9866412281990051, 5);
    expect(sevenDay.resets_at).toBe(Math.floor(Date.parse("2026-10-01T15:47:19Z") / 1000));
  });

  it("returns null when model is unclassifiable (should 5)", () => {
    expect(parseAgyUsageOutput(rawFixture, "")).toBeNull();
    expect(parseAgyUsageOutput(rawFixture, "custom-model")).toBeNull();
  });

  it("marks status as blocked when remaining_fraction is zero or negative", () => {
    const exhaustedJson = JSON.stringify({
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
                  remaining_fraction: 0,
                  reset_time: "2026-10-01T16:06:46Z",
                },
              ],
            },
          ],
        },
      },
    });

    const limits = parseAgyUsageOutput(exhaustedJson, "gemini-2.5-pro");
    expect(limits).not.toBeNull();
    const fiveHour = limits!.get("five_hour")!;
    expect(fiveHour.utilization).toBe(1);
    expect(fiveHour.status).toBe("blocked");
  });

  it("returns null on malformed json or error payload", () => {
    expect(parseAgyUsageOutput("not json", "gemini-2.5-pro")).toBeNull();
    expect(parseAgyUsageOutput(JSON.stringify({ status: "ERROR" }), "gemini-2.5-pro")).toBeNull();
  });
});

describe("runAgyUsageProbe", () => {
  it("resolves stdout on exit 0", async () => {
    const fakeSpawn = (() => {
      const child = new EventEmitter() as ChildProcess;
      const stdout = new EventEmitter();
      child.stdout = stdout as any;
      setTimeout(() => {
        stdout.emit("data", Buffer.from("probe output"));
        child.emit("close", 0);
      }, 10);
      return child;
    }) as any;

    const res = await runAgyUsageProbe("/fake/bin", { spawn: fakeSpawn });
    expect(res).toBe("probe output");
  });

  it("rejects on non-zero exit code", async () => {
    const fakeSpawn = (() => {
      const child = new EventEmitter() as ChildProcess;
      setTimeout(() => {
        child.emit("close", 1);
      }, 10);
      return child;
    }) as any;

    await expect(runAgyUsageProbe("/fake/bin", { spawn: fakeSpawn })).rejects.toThrow("usage_probe_exit_1");
  });

  it("times out and kills child with SIGKILL on timeout", async () => {
    let killSignal: string | null = null;
    const fakeSpawn = (() => {
      const child = new EventEmitter() as ChildProcess;
      child.kill = ((sig: string) => {
        killSignal = sig;
        return true;
      }) as any;
      return child;
    }) as any;

    await expect(
      runAgyUsageProbe("/fake/bin", { timeoutMs: 20, spawn: fakeSpawn }),
    ).rejects.toThrow("usage_probe_timeout:20ms");
    expect(killSignal).toBe("SIGKILL");
  });

  it("spawns with detached: true and stdio ignoring stderr", async () => {
    let capturedOptions: unknown;
    const fakeSpawn = ((_exec: string, _args: string[], opts: unknown) => {
      capturedOptions = opts;
      const child = new EventEmitter() as ChildProcess;
      child.stdout = new PassThrough() as any;
      setTimeout(() => {
        child.emit("close", 0);
      }, 5);
      return child;
    }) as any;

    await runAgyUsageProbe("/fake/bin", { spawn: fakeSpawn });
    expect(capturedOptions).toMatchObject({
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  });

  it("aborts and kills child group when AbortSignal is triggered", async () => {
    let killSignal: string | null = null;
    const fakeSpawn = (() => {
      const child = new EventEmitter() as ChildProcess;
      child.kill = ((sig: string) => {
        killSignal = sig;
        return true;
      }) as any;
      return child;
    }) as any;

    const controller = new AbortController();
    const probePromise = runAgyUsageProbe("/fake/bin", {
      spawn: fakeSpawn,
      signal: controller.signal,
    });

    controller.abort();
    await expect(probePromise).rejects.toThrow("usage_probe_aborted");
    expect(killSignal).toBe("SIGKILL");
  });

  it("kills child group and rejects when stdout exceeds 1MB limit", async () => {
    let killSignal: string | null = null;
    const fakeSpawn = (() => {
      const child = new EventEmitter() as ChildProcess;
      child.stdout = new PassThrough() as any;
      child.kill = ((sig: string) => {
        killSignal = sig;
        return true;
      }) as any;
      queueMicrotask(() => {
        const largeChunk = Buffer.alloc(1024 * 1024 + 10, "x");
        child.stdout!.emit("data", largeChunk);
      });
      return child;
    }) as any;

    await expect(
      runAgyUsageProbe("/fake/bin", { spawn: fakeSpawn }),
    ).rejects.toThrow("usage_probe_stdout_overflow");
    expect(killSignal).toBe("SIGKILL");
  });
});

describe("killChildGroup", () => {
  it("kills process group when pid is a positive number", () => {
    const processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);
    const child = { pid: 4321, kill: vi.fn() } as unknown as ChildProcess;

    killChildGroup(child, "SIGKILL");

    expect(processKillSpy).toHaveBeenCalledWith(-4321, "SIGKILL");
    expect(child.kill).not.toHaveBeenCalled();
    processKillSpy.mockRestore();
  });

  it("falls back to child.kill when pid is not present or non-positive", () => {
    const processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);
    const child = { kill: vi.fn() } as unknown as ChildProcess;

    killChildGroup(child, "SIGTERM");

    expect(processKillSpy).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    processKillSpy.mockRestore();
  });
});


