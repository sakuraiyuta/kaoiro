// Engine-agnostic launch-catalog helpers shared by every wrapper host
// (ADR-0017 / ADR-0032 F1). `mergeExtraModels` layers an operator's
// runner.config.json `<engine>.extra_models` declaration (issue #292) on
// top of an engine's own resolved catalog -- the runner applies the SAME
// merge to the register payload it advertises to LaunchDialog
// (runner/src/config.ts), so a spawned host's ext.models / effort-switch
// availability / setModel validation agree with what the operator was
// offered before spawn.
//
// This is intentionally NOT shared code with the runner's own copy of the
// same logic: the runner and the wrapper packages do not have a dependency
// edge for a cross-cutting util this small (runner is a separate process
// layer, ADR-0023), so each keeps its own ~10-line copy. Keep the two
// behaviourally identical.

import type { EngineModelInfo } from "./types.js";

/** Merges operator-declared extra models on top of a resolved base
 *  catalog. Declared entries win on a `value` collision (operator override
 *  of a curated entry's display_name / effort_levels / etc.) while keeping
 *  the base catalog's ordering; new values are appended in declaration
 *  order. */
export function mergeExtraModels(
  base: readonly EngineModelInfo[],
  extra: readonly EngineModelInfo[] | undefined,
): EngineModelInfo[] {
  if (extra === undefined || extra.length === 0) return [...base];
  const extraByValue = new Map(extra.map((model) => [model.value, model]));
  const merged = base.map((model) => extraByValue.get(model.value) ?? model);
  const baseValues = new Set(base.map((model) => model.value));
  for (const model of extra) {
    if (!baseValues.has(model.value)) merged.push(model);
  }
  return merged;
}
