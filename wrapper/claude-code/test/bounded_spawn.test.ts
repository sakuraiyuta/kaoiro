import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { spawnBoundedClaudeProcess } from "../src/bounded_spawn.js";

const base = { command: process.execPath, cwd: process.cwd(), env: process.env };

describe("bounded Claude CLI spawn", () => {
  it("drains stderr, forwards it to the caller, and redacts a bounded exit diagnostic", async () => {
    const seen: string[] = [];
    const warnings: string[] = [];
    const child = spawnBoundedClaudeProcess(
      {
        ...base,
        args: ["-e", "process.stderr.write('api_key=abcdef123456');process.exit(1)"],
        signal: new AbortController().signal,
      },
      {
        hostAbort: new AbortController().signal,
        deadlineMs: 20,
        stderr: (value) => seen.push(value),
        warn: (value) => warnings.push(value),
      },
    );
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(seen.join("")).toContain("api_key=abcdef123456");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("api_key=********3456");
    expect(warnings[0]).not.toContain("abcdef123456");
  });

  it("does not send a late SIGKILL after a child exits before host abort", async () => {
    const controller = new AbortController();
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.resume();
    const kill = vi.spyOn(child, "kill");
    spawnBoundedClaudeProcess(
      { ...base, args: [], signal: new AbortController().signal },
      {
        hostAbort: controller.signal,
        deadlineMs: 20,
        spawnOverride: () => child,
        warn: () => { throw new Error("unexpected warning"); },
      },
    );
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(kill).not.toHaveBeenCalled();
  });
});
