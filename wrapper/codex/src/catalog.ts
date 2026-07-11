// Codex engine launch catalog (ADR-0032 F4bc, revised 2026-07-11 after live
// verification). The bundled codex-cli catalog (gpt-5.6-sol/terra/luna, …)
// is the API-key model set; under ChatGPT-plan auth (the project's primary
// path, ADR-0032 F7) the server accepts ONLY the account's default model and
// rejects every explicit `--model` with 400/404 — and which model is the
// default is account/plan-specific and not enumerable via the SDK. Shipping
// a fixed list therefore mislabels a broken launch as available.
//
// So kaoiro ships NO codex model catalog: the LaunchDialog shows no model
// select for codex, the wrapper sends no `model`, and the account default
// applies (always works, both auth modes). Explicit model / effort selection
// for codex is deferred until there is a reliable per-auth catalog source
// (tracked in the model-effort open question).

import type { EngineModelInfo } from "@kaoiro/protocol";

/** Empty: the account default is used (see file header). */
export const CODEX_MODELS: EngineModelInfo[] = [];

/** EngineCapability の codex 実装 (ADR-0032 F4bc)。 */
export const CODEX_ENGINE = {
  id: "codex" as const,
  supportedModels(): EngineModelInfo[] {
    return CODEX_MODELS;
  },
};
