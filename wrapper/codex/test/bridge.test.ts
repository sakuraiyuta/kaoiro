import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reportStderr } from "../src/bridge.js";

describe("Codex bridge stderr diagnostics", () => {
  it("masks a replaced stderr writer and its local mirror", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kaoiro-codex-bridge-"));
    const mirror = join(directory, "stderr.log");
    const originalPath = process.env.KAOIRO_BRIDGE_STDERR_PATH;
    const originalWrite = process.stderr.write.bind(process.stderr);
    const writes: string[] = [];
    process.env.KAOIRO_BRIDGE_STDERR_PATH = mirror;
    process.stderr.write = ((chunk: string) => {
      writes.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      reportStderr("bridge failure: api_key=abcdef123456\n");
    } finally {
      process.stderr.write = originalWrite;
      if (originalPath === undefined) delete process.env.KAOIRO_BRIDGE_STDERR_PATH;
      else process.env.KAOIRO_BRIDGE_STDERR_PATH = originalPath;
    }

    try {
      const mirrored = await readFile(mirror, "utf8");
      expect(writes.join("")).toBe("bridge failure: api_key=********3456\n");
      expect(mirrored).toBe(writes.join(""));
      expect(mirrored).not.toContain("abcdef123456");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
