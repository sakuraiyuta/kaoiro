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

/** Applies `KAOIRO_CODEX_DEFAULT_MODEL` to `config.model` IN PLACE, when
 *  `config.model` is unset and the env var is set (issue #197 段階3, ふじ
 *  MF-1 レビュー指摘). Mutates rather than returning a clone deliberately:
 *  the CLI passes this SAME `config` object to every producer
 *  (`CodexHost`, `QuestionBroker`, `InterAgentTool`, `makeLog` /
 *  `makeStateChange` call sites) — a `{ ...config, model: ... }` shallow
 *  clone would still share `config.persona`'s object reference at
 *  construction time, but `CodexHost.renamePersona` REASSIGNS
 *  `#config.persona` (not an in-place field mutation) whenever a rename
 *  applies, which severs that shared reference. Two config objects meant
 *  two independently-diverging persona sources of truth: whichever
 *  producers held the clone saw the renamed persona, and whichever held
 *  the original did not. Mutating the ONE config object in place, before
 *  any producer is constructed from it, makes that split structurally
 *  impossible — there is only ever one object for any of them to close
 *  over.
 *
 *  MUST be called AFTER `resolveCodexSources` reads `config.model`
 *  (source attribution needs to see the pre-mutation state — "config" vs
 *  "env" provenance only means something before this fills the field in).
 *
 *  Returns nothing; callers read `config.model` directly afterward, same
 *  as every other resolved field on this object. */
export function applyEnvDefaultModel(
  config: WrapperConfig,
  envDefaultModel: string | undefined,
): void {
  if (config.model === undefined && envDefaultModel !== undefined) {
    config.model = envDefaultModel;
  }
}
