import { describe, expect, it, vi } from "vitest";
import { resolveCodexCatalog } from "../src/catalog.js";

const values = (authMode: "chatgpt" | "apikey" | "unknown", plan?:
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "business"
  | "enterprise") =>
  resolveCodexCatalog(authMode, plan).map((model) => model.value);

describe("resolveCodexCatalog", () => {
  it.each([
    [
      "gpt-5.6-sol",
      ["low", "medium", "high", "xhigh", "max", "ultra"],
      "low",
    ],
    [
      "gpt-5.6-terra",
      ["low", "medium", "high", "xhigh", "max", "ultra"],
      "medium",
    ],
    [
      "gpt-5.6-luna",
      ["low", "medium", "high", "xhigh", "max"],
      "medium",
    ],
  ] as const)(
    "%s の curated effort metadata が一次情報と一致する",
    (value, effortLevels, defaultEffort) => {
      const model = resolveCodexCatalog("chatgpt", "plus").find(
        (entry) => entry.value === value,
      );
      expect(model?.effort_levels).toEqual(effortLevels);
      expect(model?.default_effort).toBe(defaultEffort);
    },
  );

  it.each(["free", "go"] as const)("ChatGPT %s は Terra のみ", (plan) => {
    expect(values("chatgpt", plan)).toEqual(["gpt-5.6-terra"]);
  });

  it.each(["plus", "pro", "business", "enterprise"] as const)(
    "ChatGPT %s は Sol / Terra / Luna",
    (plan) => {
      expect(values("chatgpt", plan)).toEqual([
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
      ]);
    },
  );

  it("API-key auth は plan と別の curated catalog を返す", () => {
    expect(values("apikey")).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4-mini",
    ]);
  });

  it.each(["gpt-5.5", "gpt-5.4-mini"])(
    "API-key model %s に取得済みeffort metadataを載せる",
    (value) => {
      const model = resolveCodexCatalog("apikey").find(
        (entry) => entry.value === value,
      );
      expect(model?.effort_levels).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
      ]);
      expect(model?.default_effort).toBe("medium");
    },
  );

  it.each([
    ["chatgpt", undefined],
    ["unknown", "plus"],
  ] as const)("%s / %s は warnして空catalog", (authMode, plan) => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      expect(values(authMode, plan)).toEqual([]);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("warn"));
    } finally {
      stderr.mockRestore();
    }
  });

  it("API-key auth の chatgpt_plan は warnして無視する", () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      expect(values("apikey", "plus")).toEqual(values("apikey"));
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("ignored"));
    } finally {
      stderr.mockRestore();
    }
  });

  it("呼び出し間でmodel entryを共有しない", () => {
    const first = resolveCodexCatalog("chatgpt", "plus");
    first[0]!.display_name = "mutated";
    expect(resolveCodexCatalog("chatgpt", "plus")[0]?.display_name).toBe(
      "GPT-5.6-Sol",
    );
  });
});
