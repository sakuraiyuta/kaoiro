// CLI source resolution pure helper (ADR-0014 F1 追補「P1 pair-aware apply」,
// phase-23). Same rationale as the codex twin (source_resolution.ts): pins
// the CLI's priority rules and the Claude-only invalid-effort pair drop
// (value + source undefined together) without executing the whole CLI
// process. Mirrors the runner-side `computePair` semantics: resume-relayed
// `config.model_source` / `config.effort_source` is authoritative when set,
// otherwise the CLI stamps its own transport provenance.

import type { ModelSource, WrapperConfig } from "@kaoiro/protocol";

export interface ClaudeSourceResolution {
  /** Origin stamped for ext.model_source. Priority:
   *  - `config.model_source` (runner-relayed pair) when set alongside
   *    `config.model`
   *  - `"config"` when `config.model` is set with no explicit source
   *  - `"env"` when only the env-tier default resolved
   *  - `undefined` (host stamps `"default"` on first init) */
  modelSource: ModelSource | undefined;
  /** Validated effort against the caller-supplied catalog (usually
   *  `CLAUDE_EFFORT_LEVELS`). `undefined` when `config.effort` was absent OR
   *  outside the catalog — in the latter case `effortSource` is also
   *  undefined (pair drop) and a warning is appended. */
  effort: string | undefined;
  /** Origin stamped for ext.effort_source; `undefined` whenever `effort` is
   *  undefined (pair drop invariant). */
  effortSource: ModelSource | undefined;
  /** stderr warn lines the CLI should emit. Populated only when
   *  `config.effort` was set but rejected by the catalog. */
  warnings: string[];
}

/** Resolves Claude CLI source provenance for the startup summary and host
 *  options. Pure — no stderr / env reads happen here; the CLI performs its
 *  own env read and passes the result in. The catalog (typically
 *  `CLAUDE_EFFORT_LEVELS`) is passed in so this helper stays decoupled from
 *  the SDK's own effort enum evolution. */
export function resolveClaudeSources(
  config: WrapperConfig,
  envDefaultModel: string | undefined,
  effortCatalog: readonly string[],
): ClaudeSourceResolution {
  const modelSource: ModelSource | undefined =
    config.model !== undefined
      ? (config.model_source ?? "config")
      : envDefaultModel !== undefined
        ? "env"
        : undefined;
  const effortValid =
    config.effort !== undefined && effortCatalog.includes(config.effort);
  const effort: string | undefined = effortValid ? config.effort : undefined;
  // pair drop invariant: invalid effort → value AND source both undefined.
  const effortSource: ModelSource | undefined = effortValid
    ? (config.effort_source ?? "config")
    : undefined;
  const warnings: string[] = [];
  if (config.effort !== undefined && !effortValid) {
    warnings.push(
      `config warn: unsupported claude-code effort '${config.effort}', ` +
        `ignored (value and source both dropped)\n`,
    );
  }
  return { modelSource, effort, effortSource, warnings };
}
