import type { RunnerConfig } from "./config.js";
import type { SupervisorOptions } from "./supervisor.js";

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
