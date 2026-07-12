import type { EngineModelInfo } from "@kaoiro/protocol";

export type CodexAuthMode = "chatgpt" | "apikey" | "unknown";

export type ChatGptPlan =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "business"
  | "enterprise";

const SOL: EngineModelInfo = {
  value: "gpt-5.6-sol",
  display_name: "GPT-5.6 Sol",
  description: "最新の汎用フラッグシップ",
};

const TERRA: EngineModelInfo = {
  value: "gpt-5.6-terra",
  display_name: "GPT-5.6 Terra",
  description: "5.6 系の高推論バリアント",
};

const LUNA: EngineModelInfo = {
  value: "gpt-5.6-luna",
  display_name: "GPT-5.6 Luna",
  description: "5.6 系の軽量バリアント",
};

const CHATGPT_TRIO = [SOL, TERRA, LUNA];
const CHATGPT_TERRA = [TERRA];

const APIKEY_MODELS: EngineModelInfo[] = [
  ...CHATGPT_TRIO,
  {
    value: "gpt-5.5",
    display_name: "GPT-5.5",
    description: "前世代フラッグシップ",
  },
  {
    value: "gpt-5.4-mini",
    display_name: "GPT-5.4 mini",
    description: "低コスト・低レイテンシ",
  },
];

function copyCatalog(models: EngineModelInfo[]): EngineModelInfo[] {
  return models.map((model) => ({
    ...model,
    ...(model.effort_levels === undefined
      ? {}
      : { effort_levels: [...model.effort_levels] }),
  }));
}

export function resolveCodexCatalog(
  authMode: CodexAuthMode,
  plan?: ChatGptPlan,
): EngineModelInfo[] {
  if (authMode === "unknown") {
    process.stderr.write(
      "codex: warn — auth mode is unknown; model catalog is empty\n",
    );
    return [];
  }
  if (authMode === "apikey") {
    if (plan !== undefined) {
      process.stderr.write(
        "codex: warn — chatgpt_plan is ignored for API-key auth\n",
      );
    }
    return copyCatalog(APIKEY_MODELS);
  }
  if (plan === undefined) {
    process.stderr.write(
      "codex: warn — chatgpt_plan is not configured; " +
        "model catalog is empty\n",
    );
    return [];
  }
  if (plan === "free" || plan === "go") {
    return copyCatalog(CHATGPT_TERRA);
  }
  return copyCatalog(CHATGPT_TRIO);
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
