// CLI source resolution pure helper (ADR-0014 F1 追補「P1 pair-aware apply」,
// phase-23). Kept as a testable helper so the priority rules can be pinned
// without executing the whole CLI process — the CLI itself is an entry-point
// composition root with no unit-test surface. Mirrors the runner-side
// `computePair` semantics: resume-relayed `config.model_source` /
// `config.effort_source` is authoritative when set, otherwise the CLI stamps
// its own transport provenance from the resolved config / env tier.

import type { ModelSource, WrapperConfig } from "@kaoiro/protocol";

export interface CodexSourceResolution {
  /** Origin stamped for ext.model_source. Priority:
   *  - `config.model_source` (runner-relayed pair, Case 3 preserve) when set
   *    alongside `config.model`
   *  - `"config"` when `config.model` is set with no explicit source (Case 4
   *    legacy transport provenance / fresh spawn config)
   *  - `"env"` when only the env-tier default resolved
   *  - `undefined` when neither is set (host stamps `"default"` on first init) */
  modelSource: ModelSource | undefined;
  /** Origin stamped for ext.effort_source; same semantics, no env tier on Codex. */
  effortSource: ModelSource | undefined;
}

/** Resolves Codex CLI source provenance for the startup summary and host
 *  options. Pure — no stderr / env reads happen here; the CLI performs its
 *  own `KAOIRO_CODEX_DEFAULT_MODEL` read and passes the result in. */
export function resolveCodexSources(
  config: WrapperConfig,
  envDefaultModel: string | undefined,
): CodexSourceResolution {
  const modelSource: ModelSource | undefined =
    config.model !== undefined
      ? (config.model_source ?? "config")
      : envDefaultModel !== undefined
        ? "env"
        : undefined;
  const effortSource: ModelSource | undefined =
    config.effort !== undefined
      ? (config.effort_source ?? "config")
      : undefined;
  return { modelSource, effortSource };
}
