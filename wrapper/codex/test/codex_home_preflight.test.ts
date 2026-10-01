import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("rejects an inherited home before loading tests or changing the canary", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "fuji464-preflight-"));
  const home = join(scratch, "canary");
  const marker = join(scratch, "executed");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(home);
  try {
    let exitCode = 0, output = "";
    try {
      const result = await promisify(execFile)("pnpm", ["exec", "vitest", "run", "test/fixtures/codex_home_sentinel.test.ts"], {
        cwd: process.cwd(),
        env: { ...process.env, CODEX_HOME: home, FUJI464_SENTINEL: marker },
        timeout: 30_000,
      });
      output = result.stdout + result.stderr;
    } catch (error) {
      const result = error as Error & { code?: number; stdout?: string; stderr?: string };
      exitCode = typeof result.code === "number" ? result.code : -1;
      output = (result.stdout ?? "") + (result.stderr ?? "");
    }
    expect(exitCode).not.toBe(0);
    expect(output).toContain("Vitest inherited CODEX_HOME");
    expect(output).not.toMatch(/Tests\s+1 passed/);
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(home)).toEqual([]);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 40_000);
