// Codex engine launch catalog (ADR-0032 F4bc, decided 2026-07-10): a curated
// static list — the Codex CLI derives its own picker from a server-refreshed
// catalog with no public enumeration API, so the wrapper pins the bundled-
// catalog entries of codex-cli 0.144 and follows upstream by updates here.
// The shape matches ext.models[] (#54) so the dashboard reuses one renderer
// for the launch cascade and the running-agent switcher.

import type { EngineModelInfo } from "@kaoiro/protocol";

/** Effort vocabulary of codex-cli 0.144 (model_reasoning_effort). The
 *  5.6 family additionally accepts max (all) and ultra (sol/terra). */
const EFFORT_BASE = ["low", "medium", "high", "xhigh"];

export const CODEX_MODELS: EngineModelInfo[] = [
  {
    value: "gpt-5.6-sol",
    display_name: "GPT-5.6 Sol",
    description: "Codex CLI 既定。最新の汎用フラッグシップ",
    effort_levels: [...EFFORT_BASE, "max", "ultra"],
  },
  {
    value: "gpt-5.6-terra",
    display_name: "GPT-5.6 Terra",
    description: "5.6 系の高推論バリアント",
    effort_levels: [...EFFORT_BASE, "max", "ultra"],
  },
  {
    value: "gpt-5.6-luna",
    display_name: "GPT-5.6 Luna",
    description: "5.6 系の軽量バリアント",
    effort_levels: [...EFFORT_BASE, "max"],
  },
  {
    value: "gpt-5.5",
    display_name: "GPT-5.5",
    description: "前世代フラッグシップ",
    effort_levels: EFFORT_BASE,
  },
  {
    value: "gpt-5.4-mini",
    display_name: "GPT-5.4 mini",
    description: "低コスト・低レイテンシ",
    effort_levels: EFFORT_BASE,
  },
];

/** EngineCapability の codex 実装 (ADR-0032 F4bc)。 */
export const CODEX_ENGINE = {
  id: "codex" as const,
  supportedModels(): EngineModelInfo[] {
    return CODEX_MODELS;
  },
};
