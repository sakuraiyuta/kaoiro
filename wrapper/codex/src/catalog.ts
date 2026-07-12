import type { EngineModelInfo } from "@kaoiro/protocol";

export type CodexAuthMode = "chatgpt" | "apikey" | "unknown";

export type ChatGptPlan =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "business"
  | "enterprise";

// Snapshot from openai/codex main (2026-07-13). openai_models.rs defines
// the ReasoningEffort wire vocabulary and ModelInfo fields; per-model values
// live in codex-rs/models-manager/models.json and are copied here so catalog
// advertisement never depends on a runtime model/list probe (ADR-0035 H3).
const SOL: EngineModelInfo = {
  value: "gpt-5.6-sol",
  display_name: "GPT-5.6-Sol",
  description: "Latest frontier agentic coding model.",
  effort_levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
  default_effort: "low",
};

const TERRA: EngineModelInfo = {
  value: "gpt-5.6-terra",
  display_name: "GPT-5.6-Terra",
  description: "Balanced agentic coding model for everyday work.",
  effort_levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
  default_effort: "medium",
};

const LUNA: EngineModelInfo = {
  value: "gpt-5.6-luna",
  display_name: "GPT-5.6-Luna",
  description: "Fast and affordable agentic coding model.",
  effort_levels: ["low", "medium", "high", "xhigh", "max"],
  default_effort: "medium",
};

const CHATGPT_TRIO = [SOL, TERRA, LUNA];
const CHATGPT_TERRA = [TERRA];

const APIKEY_MODELS: EngineModelInfo[] = [
  ...CHATGPT_TRIO,
  {
    value: "gpt-5.5",
    display_name: "GPT-5.5",
    description: "Frontier model for complex coding and research.",
    effort_levels: ["low", "medium", "high", "xhigh"],
    default_effort: "medium",
  },
  {
    value: "gpt-5.4-mini",
    display_name: "GPT-5.4-Mini",
    description: "Small, fast, and cost-efficient coding model.",
    effort_levels: ["low", "medium", "high", "xhigh"],
    default_effort: "medium",
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
