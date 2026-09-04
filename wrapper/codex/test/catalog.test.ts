import { describe, expect, it, vi } from "vitest";
import type { EngineModelInfo } from "@kaoiro/protocol";
import {
  effortLevelsForModel,
  resolveCodexCatalog,
} from "../src/catalog.js";

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
    [
      "gpt-6-astra",
      ["low", "medium", "high", "xhigh", "max", "ultra"],
      "low",
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
    "ChatGPT %s は Sol / Terra / Luna / Astra (issue #292)",
    (plan) => {
      expect(values("chatgpt", plan)).toEqual([
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-6-astra",
      ]);
    },
  );

  it("API-key auth は plan と別の curated catalog を返す", () => {
    expect(values("apikey")).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-6-astra",
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

// Phase-23 dogfood 再回帰対策 (藤 修正版方針 3): exact→miss で intersection
// fail-closed helper。account default / catalog 更新後の乖離 / auth 情報
// 欠落など model 未確定シナリオでも invalid pair を UI に載せない (union は
// ADR-0035 silent downgrade 禁止に反するため不採用)。
describe("effortLevelsForModel (intersection fail-closed helper)", () => {
  it("exact match: 該当 model の effort_levels をそのまま返す", () => {
    const catalog = resolveCodexCatalog("chatgpt", "plus");
    expect(effortLevelsForModel(catalog, "gpt-5.6-sol")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(effortLevelsForModel(catalog, "gpt-5.6-luna")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("chatgpt plus (SOL+TERRA+LUNA+ASTRA) intersection = low..max (ultra は LUNA に無い)", () => {
    const catalog = resolveCodexCatalog("chatgpt", "plus");
    expect(effortLevelsForModel(catalog, null)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("apikey (+gpt-6-astra, +gpt-5.5, +gpt-5.4-mini) intersection = low..xhigh (max/ultra 除外)", () => {
    const catalog = resolveCodexCatalog("apikey");
    expect(effortLevelsForModel(catalog, null)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it.each([["free"], ["go"]] as const)(
    "chatgpt %s (Terra 単一) intersection = Terra 全 levels",
    (plan) => {
      const catalog = resolveCodexCatalog("chatgpt", plan);
      expect(effortLevelsForModel(catalog, null)).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
      ]);
    },
  );

  it("unknown auth の空 catalog は intersection も [] (fail-closed 継承)", () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const catalog = resolveCodexCatalog("unknown");
      expect(effortLevelsForModel(catalog, null)).toEqual([]);
      expect(effortLevelsForModel(catalog, "gpt-5.6-sol")).toEqual([]);
    } finally {
      stderr.mockRestore();
    }
  });

  it("(藤 G1) concrete key の exact miss で real default 無しなら [] fail-closed (intersection に fallback しない)", () => {
    // future / stale concrete model が catalog 候補のいずれかである保証が
    // ないため、intersection を「現在 model に必ず valid」と主張できない。
    // 安全側で [] を返す (button 非表示)。
    const catalog = resolveCodexCatalog("chatgpt", "plus");
    expect(effortLevelsForModel(catalog, "unknown-future-model")).toEqual([]);
  });

  it("first entry の順序を保持 (intersection の並びが安定)", () => {
    const catalog: EngineModelInfo[] = [
      {
        value: "m1",
        display_name: "M1",
        effort_levels: ["max", "low", "high"],
      },
      { value: "m2", display_name: "M2", effort_levels: ["low", "high"] },
    ];
    // first entry (m1) の順序: max, low, high。intersection: low, high。
    expect(effortLevelsForModel(catalog, null)).toEqual(["low", "high"]);
  });

  it("欠落 effort_levels entry が 1 件でも有れば全体 fail-closed", () => {
    const catalog: EngineModelInfo[] = [
      {
        value: "m1",
        display_name: "M1",
        effort_levels: ["low", "medium", "high"],
      },
      { value: "m2", display_name: "M2" }, // effort_levels 欠落
    ];
    expect(effortLevelsForModel(catalog, null)).toEqual([]);
    // exact miss でも fail-closed
    expect(effortLevelsForModel(catalog, "unknown")).toEqual([]);
    // first entry が欠落なら他 entry の状態に関わらず fail-closed
    const catalog2: EngineModelInfo[] = [
      { value: "m1", display_name: "M1" },
      { value: "m2", display_name: "M2", effort_levels: ["low"] },
    ];
    expect(effortLevelsForModel(catalog2, null)).toEqual([]);
  });

  it("exact match の effort_levels 欠落は [] (exact match は fallback しない)", () => {
    const catalog: EngineModelInfo[] = [
      { value: "m1", display_name: "M1" },
      { value: "m2", display_name: "M2", effort_levels: ["low"] },
    ];
    expect(effortLevelsForModel(catalog, "m1")).toEqual([]);
  });

  // Tier 2: real default entry (Codex 現 curated catalog には無いが、将来
  // SDK / probe が返した場合の forward-compat)。exact miss または model=null
  // で real `value="default"` entry があれば、そちらの effort_levels を返す
  // (欠落なら []、intersection tier 3 に進まない)。
  it("Tier 2: exact miss + real default entry 有 → default entry の effort_levels (intersection より優先)", () => {
    const catalog: EngineModelInfo[] = [
      {
        value: "default",
        display_name: "Default",
        effort_levels: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        value: "specific-a",
        display_name: "Specific A",
        effort_levels: ["high", "xhigh"],
      },
      // levels 欠落 entry がいても tier 2 で解決するので影響しない
      { value: "specific-b", display_name: "Specific B" },
    ];
    // exact miss (specific-a と specific-b 以外の名前) → tier 2 hit
    expect(effortLevelsForModel(catalog, "unknown-model")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    // model=null でも同じ tier 2
    expect(effortLevelsForModel(catalog, null)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("Tier 2: real default entry の effort_levels 欠落は [] (tier 3 に進まない)", () => {
    const catalog: EngineModelInfo[] = [
      { value: "default", display_name: "Default" }, // levels 欠落
      {
        value: "specific-a",
        display_name: "Specific A",
        effort_levels: ["low", "medium"],
      },
    ];
    // exact miss → tier 2 hit → default entry levels 欠落 → [] (intersection
    // tier 3 に fallback しない、藤修正版方針の fail-fast)
    expect(effortLevelsForModel(catalog, "unknown")).toEqual([]);
  });

  it("Tier 3: model=null かつ real default entry 無 → intersection (現 Codex catalog の挙動)", () => {
    // 現在の Codex curated catalog は "default" alias entry を持たない
    // (synthetic entry 追加禁止)。model=null (account default) 経路のみ
    // tier 3 intersection に進む。concrete miss は G1 で tier 4 fail-closed
    // (別 test で pin)。
    const catalog: EngineModelInfo[] = [
      { value: "m1", display_name: "M1", effort_levels: ["low", "medium"] },
      { value: "m2", display_name: "M2", effort_levels: ["medium", "high"] },
    ];
    // model=null + "default" entry 無 → tier 3 intersection = ["medium"]
    expect(effortLevelsForModel(catalog, null)).toEqual(["medium"]);
  });

  // 藤 G1: concrete key で exact miss かつ real default 無しなら intersection
  // に進まず [] fail-closed。unknown/future/stale concrete model が catalog
  // 候補のいずれかである保証がないため、intersection を「必ず valid」と
  // 主張できないので安全側で空を返す。
  it("(藤 G1) Tier 4: concrete key exact miss + real default 無 → [] (intersection に fallback しない)", () => {
    const catalog: EngineModelInfo[] = [
      { value: "m1", display_name: "M1", effort_levels: ["low", "medium"] },
      { value: "m2", display_name: "M2", effort_levels: ["medium", "high"] },
    ];
    // "default" entry 無、concrete miss → tier 4 fail-closed
    expect(effortLevelsForModel(catalog, "unknown-model")).toEqual([]);
  });

  it("Tier 1 の exact match は tier 2/3 より優先 (default entry があっても)", () => {
    const catalog: EngineModelInfo[] = [
      {
        value: "default",
        display_name: "Default",
        effort_levels: ["low", "medium"],
      },
      {
        value: "specific",
        display_name: "Specific",
        effort_levels: ["high", "xhigh", "ultra"],
      },
    ];
    // exact match で specific の levels を返し、default の subset に落ちない
    expect(effortLevelsForModel(catalog, "specific")).toEqual([
      "high",
      "xhigh",
      "ultra",
    ]);
  });
});
