import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  parseProbeStdout,
  runClaudeProbe,
} from "../src/probe-client.js";

/** Minimal ChildProcess double: EventEmitter with .stdout / .stderr streams
 *  as EventEmitters and a kill() spy. Enough for runClaudeProbe's paths. */
function fakeChild(): ChildProcess & {
  stdoutEmit: (chunk: string) => void;
  stderrEmit: (chunk: string) => void;
  kill: ReturnType<typeof vi.fn>;
} {
  const ee = new EventEmitter() as ChildProcess & {
    stdoutEmit: (chunk: string) => void;
    stderrEmit: (chunk: string) => void;
    kill: ReturnType<typeof vi.fn>;
  };
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  ee.stdout = stdout as unknown as ChildProcess["stdout"];
  ee.stderr = stderr as unknown as ChildProcess["stderr"];
  ee.stdoutEmit = (chunk) => stdout.emit("data", Buffer.from(chunk, "utf8"));
  ee.stderrEmit = (chunk) => stderr.emit("data", Buffer.from(chunk, "utf8"));
  ee.kill = vi.fn(() => true);
  return ee;
}

describe("parseProbeStdout", () => {
  it("成功 JSON をそのまま返す", () => {
    const out = parseProbeStdout(
      JSON.stringify({
        ok: true,
        models: [{ value: "sonnet", display_name: "Sonnet", description: "" }],
        elapsed_ms: 100,
        source: "init",
      }) + "\n",
    );
    expect(out?.ok).toBe(true);
    expect(out?.models?.[0]?.value).toBe("sonnet");
  });

  it("ok:true でも空 models は invalid_output に落とす", () => {
    const out = parseProbeStdout(
      JSON.stringify({ ok: true, models: [], elapsed_ms: 10 }),
    );
    expect(out?.ok).toBe(false);
    expect(out?.reason).toBe("invalid_output");
  });

  it("失敗 JSON の reason を closed-vocab に正規化する", () => {
    const out = parseProbeStdout(
      JSON.stringify({ ok: false, reason: "auth_failed", elapsed_ms: 5 }),
    );
    expect(out?.ok).toBe(false);
    expect(out?.reason).toBe("auth_failed");
  });

  it("空 / 不正 JSON は null", () => {
    expect(parseProbeStdout("")).toBeNull();
    expect(parseProbeStdout("not json")).toBeNull();
  });
});

describe("runClaudeProbe (spawn injection)", () => {
  it("close event の stdout を parse して ProbeOutcome を返す", async () => {
    const child = fakeChild();
    const p = runClaudeProbe({ spawnProbe: () => child });
    child.stdoutEmit(
      JSON.stringify({
        ok: true,
        models: [{ value: "sonnet", display_name: "Sonnet", description: "" }],
        elapsed_ms: 42,
        source: "init",
      }),
    );
    child.emit("close", 0);
    const outcome = await p;
    expect(outcome.ok).toBe(true);
    expect(outcome.models?.[0]?.value).toBe("sonnet");
  });

  it("hard timeout で SIGTERM を送り、close 未達なら SIGKILL escalation", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const p = runClaudeProbe({
        spawnProbe: () => child,
        hardTimeoutMs: 100,
        killEscalateMs: 200,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      await vi.advanceTimersByTimeAsync(200);
      expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      const outcome = await p;
      expect(outcome.reason).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("timeout 後に close が来たら SIGKILL は撃たない", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const p = runClaudeProbe({
        spawnProbe: () => child,
        hardTimeoutMs: 100,
        killEscalateMs: 200,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(child.kill).toHaveBeenCalledTimes(1);
      child.emit("close", null);
      await vi.advanceTimersByTimeAsync(200);
      expect(child.kill).toHaveBeenCalledTimes(1);
      const outcome = await p;
      expect(outcome.reason).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stdout 空は invalid_output", async () => {
    const child = fakeChild();
    const p = runClaudeProbe({ spawnProbe: () => child });
    child.emit("close", 1);
    const outcome = await p;
    expect(outcome.reason).toBe("invalid_output");
  });

  it("spawn error は spawn_failed", async () => {
    const child = fakeChild();
    const p = runClaudeProbe({ spawnProbe: () => child });
    child.emit("error", new Error("ENOENT"));
    const outcome = await p;
    expect(outcome.reason).toBe("spawn_failed");
  });
});
