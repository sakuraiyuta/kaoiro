import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll } from "vitest";

// S1: Lock process.kill against any mutation, assignment, or vi.spyOn at runtime
try {
  Object.defineProperty(process, "kill", {
    writable: false,
    configurable: false,
  });
} catch {
  // Already locked in worker or same process
}

let initialTmp: string | undefined;

export function setupTestTmpdir(): string {
  if (!initialTmp) {
    const envTmp = process.env.TMPDIR;
    initialTmp = envTmp && !envTmp.includes("yuta384-vitest-scratch-") ? envTmp : "/tmp";
  }

  // S2: Prefix clearly marks owner (yuta), issue (384), and is disjoint from kaoiro-agy-
  const scratchRoot = mkdtempSync(join(initialTmp, "yuta384-vitest-scratch-"));
  process.env.TMPDIR = scratchRoot;

  const cleanup = () => {
    try {
      rmSync(scratchRoot, { recursive: true, force: true });
    } catch {}
  };

  afterAll(cleanup);
  process.on("exit", cleanup);

  return scratchRoot;
}

// M1: Execute immediately upon loading setupFiles module in worker
setupTestTmpdir();
