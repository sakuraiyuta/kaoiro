import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadWrapperBuildInfo } from "../src/build_info.js";

describe("loadWrapperBuildInfo", () => {
  it("reads the wrapper artifact's complete build identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-wrapper-build-info-test-"));
    const file = join(dir, "build-info.json");
    try {
      writeFileSync(
        file,
        JSON.stringify({
          revision: "0123456789012345678901234567890123456789",
          dirty: true,
          built_at: "2026-09-01T00:00:00.000Z",
          version: "2026.9.0",
          channel: "dev",
        }),
      );

      expect(loadWrapperBuildInfo(file)).toEqual({
        revision: "0123456789012345678901234567890123456789",
        dirty: true,
        version: "2026.9.0",
        channel: "dev",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed to unknown when the artifact is malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-wrapper-build-info-test-"));
    const file = join(dir, "build-info.json");
    try {
      writeFileSync(
        file,
        JSON.stringify({ revision: "not-a-revision", dirty: false }),
      );

      expect(loadWrapperBuildInfo(file)).toEqual({
        revision: "unknown",
        dirty: false,
        version: "unknown",
        channel: "dev",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when release provenance is contradictory", () => {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-wrapper-build-info-test-"));
    const file = join(dir, "build-info.json");
    try {
      writeFileSync(
        file,
        JSON.stringify({
          revision: "unknown",
          dirty: true,
          built_at: "2026-09-01T00:00:00.000Z",
          version: "2026.9.0",
          channel: "release",
        }),
      );

      expect(loadWrapperBuildInfo(file)).toEqual({
        revision: "unknown",
        dirty: false,
        version: "unknown",
        channel: "dev",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
