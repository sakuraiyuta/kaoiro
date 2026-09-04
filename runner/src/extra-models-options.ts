// Config -> Supervisor mapping for the `*.extra_models` fields (issue #292
// SF-2), factored out of cli.ts's `main()` / reload path into their own
// side-effect-free module so a test can import and exercise the mapping
// directly -- cli.ts itself runs `main()` unconditionally at import time
// (it is the runner's process entry point), which makes it unsafe to
// import from a test.

import type { RunnerConfig } from "./config.js";
import type { SupervisorOptions, SupervisorRuntimeUpdate } from "./supervisor.js";

/** Pure config -> Supervisor-options mapping for the `*.extra_models`
 *  fields, extracted so a test can exercise the mapping itself rather than
 *  only a fixture that injects the Supervisor field directly — a dropped
 *  call site here would otherwise stay green. Used identically at both the
 *  initial construction and the reload call in cli.ts, so the two never
 *  drift apart. */
export function extraModelsOptions(
  config: RunnerConfig,
): Pick<SupervisorOptions, "codexExtraModels" | "antigravityExtraModels"> {
  return {
    ...(config.codex?.extra_models === undefined
      ? {}
      : { codexExtraModels: config.codex.extra_models }),
    ...(config.antigravity?.extra_models === undefined
      ? {}
      : { antigravityExtraModels: config.antigravity.extra_models }),
  };
}

/** Same mapping as `extraModelsOptions` above, but shaped for
 *  `SupervisorRuntimeUpdate` — that interface requires every field's KEY
 *  present (an `undefined` value is how a reload clears it), unlike
 *  `SupervisorOptions`'s omit-to-leave-unset convention, so the two
 *  mappers cannot share one return shape. */
export function extraModelsRuntimeUpdate(
  config: RunnerConfig,
): Pick<SupervisorRuntimeUpdate, "codexExtraModels" | "antigravityExtraModels"> {
  return {
    codexExtraModels: config.codex?.extra_models,
    antigravityExtraModels: config.antigravity?.extra_models,
  };
}
