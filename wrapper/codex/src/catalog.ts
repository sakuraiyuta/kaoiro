import { createRequire } from "node:module";
import { mergeExtraModels } from "@kaoiro/agent-common";
import type { EngineModelInfo } from "@kaoiro/protocol";

export type CodexAuthMode = "chatgpt" | "apikey" | "unknown";

export type ChatGptPlan =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "business"
  | "enterprise";

// Snapshot from openai/codex main (2026-07-13, gpt-6-astra added from a
// 2026-09-05 re-fetch — issue #292). openai_models.rs defines the
// ReasoningEffort wire vocabulary and ModelInfo fields; per-model values
// live in codex-rs/models-manager/models.json and are copied here so catalog
// advertisement never depends on a runtime model/list probe (ADR-0035 H3).
const SOL: EngineModelInfo = {
  value: "gpt-5.6-sol",
  display_name: "GPT-5.6-Sol",
  description: "Latest frontier agentic coding model.",
  effort_levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
  default_effort: "low",
  minimal_client_version: "0.144.0",
};

const TERRA: EngineModelInfo = {
  value: "gpt-5.6-terra",
  display_name: "GPT-5.6-Terra",
  description: "Balanced agentic coding model for everyday work.",
  effort_levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
  default_effort: "medium",
  minimal_client_version: "0.144.0",
};

const LUNA: EngineModelInfo = {
  value: "gpt-5.6-luna",
  display_name: "GPT-5.6-Luna",
  description: "Fast and affordable agentic coding model.",
  effort_levels: ["low", "medium", "high", "xhigh", "max"],
  default_effort: "medium",
  minimal_client_version: "0.144.0",
};

const ASTRA: EngineModelInfo = {
  value: "gpt-6-astra",
  display_name: "GPT-6-Astra",
  description: "Our most capable model for complex, demanding work.",
  effort_levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
  default_effort: "low",
  minimal_client_version: "0.153.0",
};

const CHATGPT_PLUS_MODELS = [SOL, TERRA, LUNA, ASTRA];
// Free/Go exclusions follow the Plan × available-model table in
// docs/specs/codex-model-catalog.md.
const CHATGPT_TERRA = [TERRA];

const APIKEY_MODELS: EngineModelInfo[] = [
  ...CHATGPT_PLUS_MODELS,
  {
    value: "gpt-5.5",
    display_name: "GPT-5.5",
    description: "Frontier model for complex coding and research.",
    effort_levels: ["low", "medium", "high", "xhigh"],
    default_effort: "medium",
    minimal_client_version: "0.124.0",
  },
  {
    value: "gpt-5.4-mini",
    display_name: "GPT-5.4-Mini",
    description: "Small, fast, and cost-efficient coding model.",
    effort_levels: ["low", "medium", "high", "xhigh"],
    default_effort: "medium",
    minimal_client_version: "0.98.0",
  },
];

const CURATED_MODELS = APIKEY_MODELS;

function copyCatalog(models: EngineModelInfo[]): EngineModelInfo[] {
  return models.map((model) => ({
    ...model,
    ...(model.effort_levels === undefined
      ? {}
      : { effort_levels: [...model.effort_levels] }),
  }));
}

type CoreVersion = readonly [number, number, number];

const CORE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+].*)?$/;

function parseCoreVersion(value: string, source: string): CoreVersion {
  const match = CORE_VERSION.exec(value);
  if (match === null) {
    throw new Error(`${source} must be a major.minor.patch version`);
  }
  const parts = match.slice(1, 4).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    throw new Error(`${source} has an unsafe version component`);
  }
  // The catalog's minima are stable release thresholds, so prerelease/build
  // metadata does not participate in compatibility decisions.
  return [parts[0]!, parts[1]!, parts[2]!];
}

function isAtLeast(version: string, minimum: string): boolean {
  const actual = parseCoreVersion(version, "bundled Codex version");
  const required = parseCoreVersion(minimum, "minimal_client_version");
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index]! !== required[index]!) {
      return actual[index]! > required[index]!;
    }
  }
  return true;
}

function bundledCodexVersion(): string {
  const codexPackage = createRequire(import.meta.url)(
    "@openai/codex/package.json",
  ) as { version?: unknown };
  if (typeof codexPackage.version !== "string") {
    throw new Error("bundled @openai/codex package.json has no version");
  }
  parseCoreVersion(codexPackage.version, "bundled Codex version");
  return codexPackage.version;
}

export const BUNDLED_CODEX_VERSION = bundledCodexVersion();

const warnedUndeclaredOperatorModels = new Set<string>();

function restoreCuratedMinimums(
  base: readonly EngineModelInfo[],
  merged: readonly EngineModelInfo[],
  operatorExtraModels: readonly EngineModelInfo[] | undefined,
): EngineModelInfo[] {
  if (operatorExtraModels === undefined) return [...merged];
  const curatedMinimums = new Map(
    base.flatMap((model) =>
      model.minimal_client_version === undefined
        ? []
        : [[model.value, model.minimal_client_version] as const],
    ),
  );
  const operatorValuesWithoutMinimum = new Set(
    operatorExtraModels
      .filter((model) => model.minimal_client_version === undefined)
      .map((model) => model.value),
  );
  return merged.map((model) => {
    const minimum = curatedMinimums.get(model.value);
    if (
      minimum === undefined ||
      !operatorValuesWithoutMinimum.has(model.value)
    ) {
      return model;
    }
    return { ...model, minimal_client_version: minimum };
  });
}

/** Rejects a static model pin that the bundled CLI cannot execute. An
 * operator may explicitly provide a minimum for an override, making its
 * compatibility declaration authoritative instead of the curated one. */
export function assertCuratedModelCompatible(
  value: string | null,
  operatorExtraModels: readonly EngineModelInfo[] | undefined,
  clientVersion = BUNDLED_CODEX_VERSION,
): void {
  if (value === null) return;
  const operatorOverride = operatorExtraModels?.find(
    (model) => model.value === value,
  );
  if (operatorOverride?.minimal_client_version !== undefined) return;
  const curated = CURATED_MODELS.find((model) => model.value === value);
  const minimum = curated?.minimal_client_version;
  if (minimum === undefined || isAtLeast(clientVersion, minimum)) return;
  throw new Error(
    `codex: model ${value} requires Codex >= ${minimum}, bundled version is ${clientVersion}`,
  );
}

function filterCatalogByClientVersion(
  catalog: readonly EngineModelInfo[],
  operatorExtraModels: readonly EngineModelInfo[] | undefined,
  clientVersion: string,
): EngineModelInfo[] {
  const operatorValues = new Set(
    operatorExtraModels?.map((model) => model.value),
  );
  return catalog.filter((model) => {
    if (model.minimal_client_version === undefined) {
      if (
        operatorValues.has(model.value) &&
        !warnedUndeclaredOperatorModels.has(model.value)
      ) {
        warnedUndeclaredOperatorModels.add(model.value);
        process.stderr.write(
          `codex: warn — minimal_client_version is not declared for operator model ${model.value}; CLI compatibility is the operator's responsibility\n`,
        );
      }
      return true;
    }
    if (isAtLeast(clientVersion, model.minimal_client_version)) return true;
    process.stderr.write(
      `codex: warn — excluding ${model.value}: requires Codex >= ${model.minimal_client_version}, bundled version is ${clientVersion}\n`,
    );
    return false;
  });
}

export function resolveCodexCatalog(
  authMode: CodexAuthMode,
  plan?: ChatGptPlan,
  extraModels?: readonly EngineModelInfo[],
  clientVersion = BUNDLED_CODEX_VERSION,
): EngineModelInfo[] {
  let catalog: EngineModelInfo[];
  if (authMode === "unknown") {
    process.stderr.write(
      "codex: warn — auth mode is unknown; model catalog is empty\n",
    );
    catalog = [];
  } else if (authMode === "apikey") {
    if (plan !== undefined) {
      process.stderr.write(
        "codex: warn — chatgpt_plan is ignored for API-key auth\n",
      );
    }
    catalog = copyCatalog(APIKEY_MODELS);
  } else if (plan === undefined) {
    process.stderr.write(
      "codex: warn — chatgpt_plan is not configured; " +
        "model catalog is empty\n",
    );
    catalog = [];
  } else if (plan === "free" || plan === "go") {
    catalog = copyCatalog(CHATGPT_TERRA);
  } else {
    catalog = copyCatalog(CHATGPT_PLUS_MODELS);
  }
  const merged = restoreCuratedMinimums(
    catalog,
    mergeExtraModels(catalog, extraModels),
    extraModels,
  );
  return filterCatalogByClientVersion(
    merged,
    extraModels,
    clientVersion,
  );
}

export const CODEX_ENGINE = {
  id: "codex" as const,
  supportedModels(
    authMode: CodexAuthMode = "unknown",
    plan?: ChatGptPlan,
  ): EngineModelInfo[] {
    return resolveCodexCatalog(authMode, plan);
  },
};

/** Effort levels available for a given model against the resolved catalog.
 *  Three-tier lookup (Phase-23 dogfood 再回帰対策 / 藤 修正版方針 5 + G1):
 *
 *  1. **concrete key exact hit** (`model !== null` かつ catalog に該当 entry) →
 *     その effort_levels を返す (欠落 = 空、tier 2/3 に fallback しない)。
 *     model の explicit context (operator 選択 / hint 復元) が catalog に
 *     存在するときの通常経路。
 *  2. **exact miss または `model === null`** で real `value="default"`
 *     entry があれば → その effort_levels を返す (欠落 = 空)。SDK が返す
 *     「account default effort domain」の正式 fallback。
 *  3. **model 未報告 (`model === null`)** かつ real default 無しの場合
 *     のみ → catalog 全 entry の effort_levels の **intersection** を
 *     first entry の順で返す (1 件でも effort_levels 欠落なら `[]`
 *     fail-closed)。「どの model でも accept される effort」だけを提示
 *     するので ADR-0035 の silent downgrade 禁止に反しない。
 *  4. **concrete key があるが exact miss かつ real default 無し** →
 *     `[]` fail-closed (藤 G1)。unknown / future / stale concrete model
 *     が catalog 候補のいずれかであることは保証されないため、intersection
 *     に fallback すると「現在 model に必ず valid」を主張できない可能性が
 *     ある。安全側で button を非表示にする。
 *
 *  Union は採用しない (「どれかの model が accept する effort」を出すと
 *  現在の model にとって invalid な pair を提示することになる = ADR-0035
 *  違反)。synthetic "default" catalog entry も追加しない (model 切替 menu
 *  に "default" が出て `setModel("default")` を明示送信し得る責務汚染)。
 *  real default entry と synthetic default の違い: real は engine の
 *  supportedModels() 応答に含まれる正式 alias、synthetic はローカル catalog
 *  helper が合成した「架空 entry」で model 切替に露出する。前者は fallback
 *  として使えるが後者は禁止。
 *  Empty catalog (auth mode="unknown" の fail-closed 領域) は `[]` を維持。 */
export function effortLevelsForModel(
  catalog: readonly EngineModelInfo[],
  model: string | null,
): readonly string[] {
  // Tier 1: exact match (no fallback on missing effort_levels)
  if (model !== null) {
    const active = catalog.find((entry) => entry.value === model);
    if (active !== undefined) return active.effort_levels ?? [];
  }
  // Tier 2: real `value="default"` entry, if present (exact miss / null 両方)
  const realDefault = catalog.find((entry) => entry.value === "default");
  if (realDefault !== undefined) return realDefault.effort_levels ?? [];
  // Tier 4 (藤 G1): concrete key で exact miss かつ real default 無し →
  // [] fail-closed。future/stale concrete model が catalog に対して安全な
  // effort を保証できないため intersection に fallback しない。
  if (model !== null) return [];
  // Tier 3: model=null のみ intersection fail-closed
  if (catalog.length === 0) return [];
  const first = catalog[0]!;
  if (first.effort_levels === undefined) return [];
  const rest = catalog.slice(1);
  return first.effort_levels.filter((level) =>
    rest.every(
      (entry) =>
        entry.effort_levels !== undefined &&
        entry.effort_levels.includes(level),
    ),
  );
}
