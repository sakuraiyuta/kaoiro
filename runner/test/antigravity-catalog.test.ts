import { describe, expect, it, vi } from "vitest";
import {
  parseAgyModelsOutput,
  resolveAntigravityCatalog,
} from "../src/antigravity-catalog.js";

describe("parseAgyModelsOutput", () => {
  it("改行区切りの slug 一覧をパースする (measured 1.1.26)", () => {
    expect(
      parseAgyModelsOutput(
        "gemini-3.6-flash-high\ngemini-3.1-pro-high\nclaude-sonnet-4-6\n",
      ),
    ).toEqual(["gemini-3.6-flash-high", "gemini-3.1-pro-high", "claude-sonnet-4-6"]);
  });

  it("空行を drop する", () => {
    expect(parseAgyModelsOutput("a\n\nb\n\n\n")).toEqual(["a", "b"]);
  });

  it("空文字列は空配列を返す", () => {
    expect(parseAgyModelsOutput("")).toEqual([]);
    expect(parseAgyModelsOutput("\n\n")).toEqual([]);
  });
});

describe("resolveAntigravityCatalog (ADR-0057 F6)", () => {
  it("agy models 成功時は slug から account default つきの catalog を作る", async () => {
    const models = await resolveAntigravityCatalog(async () => ({
      stdout: "gemini-3.6-flash-high\nclaude-sonnet-4-6\n",
    }));
    expect(models[0]).toEqual({ value: "", display_name: "account default" });
    expect(models.map((m) => m.value)).toContain("gemini-3.6-flash-high");
    expect(models.map((m) => m.value)).toContain("claude-sonnet-4-6");
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

  it("空出力時も 1.1.26 snapshot にフォールバックし warn する", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const models = await resolveAntigravityCatalog(async () => ({
        stdout: "\n\n",
      }));
      expect(models[0]).toEqual({ value: "", display_name: "account default" });
      expect(models.length).toBeGreaterThan(1);
      const warning = stderr.mock.calls.flat().join("");
      expect(warning).toContain("returned no slugs");
    } finally {
      stderr.mockRestore();
    }
  });
});
