import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { resolveAntigravityCatalog } from "../src/antigravity-catalog.js";

const AGY_MODELS_FIXTURE = readFileSync(
  new URL("./fixtures/agy-models.stdout", import.meta.url),
  "utf8",
);

describe("resolveAntigravityCatalog (ADR-0057 F6)", () => {
  it("agy models 成功時は実出力 (slug<TAB>display name, 一部 bare slug) を account default つき catalog にする", async () => {
    const models = await resolveAntigravityCatalog(async () => ({
      stdout: AGY_MODELS_FIXTURE,
    }));
    expect(models[0]).toEqual({ value: "", display_name: "account default" });
    expect(models).toContainEqual({
      value: "gemini-3.6-flash-high",
      display_name: "Gemini 3.6 Flash High",
    });
    // Bare-slug line (no TAB): display name falls back to the slug itself.
    expect(models).toContainEqual({
      value: "gpt-oss-120b-medium",
      display_name: "gpt-oss-120b-medium",
    });
  });

  it("実行失敗時は 1.1.26 snapshot にフォールバックし warn する", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const models = await resolveAntigravityCatalog(async () =>
        Promise.reject(new Error("ENOENT: agy not found")),
      );
      expect(models[0]).toEqual({ value: "", display_name: "account default" });
      // Pinned snapshot's non-default entries (catalog.ts SNAPSHOT_1_1_26).
      expect(models.map((m) => m.value)).toContain("gemini-3.6-flash-high");
      const warning = stderr.mock.calls.flat().join("");
      expect(warning).toContain("agy models` probe failed");
      expect(warning).toContain("1.1.26 snapshot");
    } finally {
      stderr.mockRestore();
    }
  });

  it("出力が不正な形 (3列以上) のときも 1.1.26 snapshot にフォールバックし warn する", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const models = await resolveAntigravityCatalog(async () => ({
        stdout: "gemini-3.6-flash-high\tDisplay\textra\n",
      }));
      expect(models[0]).toEqual({ value: "", display_name: "account default" });
      expect(models.length).toBeGreaterThan(1);
      const warning = stderr.mock.calls.flat().join("");
      expect(warning).toContain("no parseable models");
      expect(warning).toContain("1.1.26 snapshot");
    } finally {
      stderr.mockRestore();
    }
  });

  it("空出力時も 1.1.26 snapshot にフォールバックし warn する", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const models = await resolveAntigravityCatalog(async () => ({
        stdout: "",
      }));
      expect(models[0]).toEqual({ value: "", display_name: "account default" });
      expect(models.length).toBeGreaterThan(1);
      const warning = stderr.mock.calls.flat().join("");
      expect(warning).toContain("no parseable models");
    } finally {
      stderr.mockRestore();
    }
  });
});
