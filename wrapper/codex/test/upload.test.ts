import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  sweepOrphanLocalImages,
  tempDirPrefix,
  validateOpen,
} from "../src/upload.js";

describe("Codex local_image upload", () => {
  it("agent namespace は短いprefix・先頭80文字共有でも衝突しない (#112 M4)", async () => {
    const longPrefix = "x".repeat(80);
    expect(tempDirPrefix("a")).not.toBe(tempDirPrefix("a-b"));
    expect(tempDirPrefix(`${longPrefix}1`)).not.toBe(tempDirPrefix(`${longPrefix}2`));

    const own = await mkdtemp(join(tmpdir(), tempDirPrefix("a")));
    const other = await mkdtemp(join(tmpdir(), tempDirPrefix("a-b")));
    try {
      await sweepOrphanLocalImages("a", () => {});
      await expect(access(own)).rejects.toThrow();
      await expect(access(other)).resolves.toBeUndefined();
    } finally {
      await rm(own, { recursive: true, force: true });
      await rm(other, { recursive: true, force: true });
    }
  });

  it("dynamic preserve set は materialize 中の自dirを startup sweep から守る (#112 M5)", async () => {
    const agentId = "materializing-agent";
    const dir = await mkdtemp(join(tmpdir(), tempDirPrefix(agentId)));
    try {
      await sweepOrphanLocalImages(agentId, () => {}, () => new Set([dir]));
      await expect(access(dir)).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    { size: -1, chunks: 1 },
    { size: 1.5, chunks: 1 },
    { size: Number.NaN, chunks: 1 },
    { size: Number.POSITIVE_INFINITY, chunks: 1 },
    { size: 1, chunks: 0 },
    { size: 1, chunks: -1 },
    { size: 1, chunks: 1.5 },
    { size: 1, chunks: Number.NaN },
  ])("rejects invalid finite integer metadata %#", ({ size, chunks }) => {
    expect(validateOpen({ upload_id: "u", filename: "x.png", mime: "image/png", size, chunks })).toMatchObject({ ok: false, reason: "size_over" });
  });
});
