import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { parseProbeStdout, runClaudeProbe } from "../src/claude_probe.js";

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
    expect(out?.source).toBe("init");
  });

  it("失敗 JSON の reason を closed-vocab に正規化する", () => {
    const out = parseProbeStdout(
      JSON.stringify({ ok: false, reason: "auth_failed", elapsed_ms: 5 }),
    );
    expect(out?.ok).toBe(false);
    expect(out?.reason).toBe("auth_failed");
  });

  it("未知 reason は cli_error に落とす", () => {
    const out = parseProbeStdout(
      JSON.stringify({ ok: false, reason: "made_up", elapsed_ms: 5 }),
    );
    expect(out?.reason).toBe("cli_error");
  });

  it("空 stdout / 不正 JSON は null", () => {
    expect(parseProbeStdout("")).toBeNull();
    expect(parseProbeStdout("not json")).toBeNull();
    expect(parseProbeStdout("{oops")).toBeNull();
  });

  it("複数行 stdout は最後の 1 行だけを解析する", () => {
    const out = parseProbeStdout(
      "some noise\n" +
        JSON.stringify({
          ok: true,
          models: [{ value: "x", display_name: "X", description: "" }],
          elapsed_ms: 1,
        }) +
        "\n",
    );
    expect(out?.ok).toBe(true);
  });

  it("ok:true でも models: [] は invalid_output に落とす (藤 review 3-E 境界防御)", () => {
    // 空 catalog が cache / register に入る経路を probe と runner の二重で塞ぐ
    const out = parseProbeStdout(
      JSON.stringify({ ok: true, models: [], elapsed_ms: 10, source: "init" }),
    );
    expect(out?.ok).toBe(false);
    expect(out?.reason).toBe("invalid_output");
    expect(out?.detail).toContain("0 valid model rows");
  });

  it("ok:true でも全 row 不正 (isEngineModelInfo false) は invalid_output に落とす", () => {
    // value / display_name の欠落は projectModel 相当の isEngineModelInfo で
    // 弾かれる → filter 後 length 0 → invalid_output
    const out = parseProbeStdout(
      JSON.stringify({
        ok: true,
        models: [{ value: 42 }, { foo: "bar" }, null],
        elapsed_ms: 5,
      }),
    );
    expect(out?.ok).toBe(false);
    expect(out?.reason).toBe("invalid_output");
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

  it("hard timeout で SIGTERM を送り、closed=true が来なければ SIGKILL escalation する", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const p = runClaudeProbe({
        spawnProbe: () => child,
        hardTimeoutMs: 100,
        killEscalateMs: 200,
      });
      // Advance past hard timeout — should send SIGTERM and resolve outcome.
      await vi.advanceTimersByTimeAsync(100);
      expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      // Advance past escalate — child never emitted 'close', so SIGKILL fires.
      await vi.advanceTimersByTimeAsync(200);
      expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      // The outcome is timeout regardless of the later escalate.
      const outcome = await p;
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("timeout 後に close が来たら SIGKILL escalation を撃たない", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const p = runClaudeProbe({
        spawnProbe: () => child,
        hardTimeoutMs: 100,
        killEscalateMs: 200,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(child.kill).toHaveBeenCalledTimes(1); // SIGTERM only
      // Child cleanly exits before escalate fires.
      child.emit("close", null);
      await vi.advanceTimersByTimeAsync(200);
      expect(child.kill).toHaveBeenCalledTimes(1); // still just SIGTERM
      const outcome = await p;
      expect(outcome.reason).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stdout が空 (probe crashed) なら invalid_output を返す", async () => {
    const child = fakeChild();
    const p = runClaudeProbe({ spawnProbe: () => child });
    child.emit("close", 1);
    const outcome = await p;
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("invalid_output");
  });

  it("spawn error は spawn_failed で resolve する", async () => {
    const child = fakeChild();
    const p = runClaudeProbe({ spawnProbe: () => child });
    child.emit("error", new Error("ENOENT"));
    const outcome = await p;
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("spawn_failed");
  });
});
