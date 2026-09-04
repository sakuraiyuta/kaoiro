import type { ModelSource, WrapperConfig } from "@kaoiro/protocol";

export interface AntigravitySourceResolution {
  modelSource: ModelSource | undefined;
  effortSource: ModelSource | undefined;
}

export function resolveAntigravitySources(
  config: WrapperConfig,
  envDefaultModel: string | undefined,
): AntigravitySourceResolution {
  return {
    modelSource:
      config.model !== undefined
        ? (config.model_source ?? "config")
        : envDefaultModel !== undefined
          ? "env"
          : undefined,
    effortSource:
      config.effort !== undefined ? (config.effort_source ?? "config") : undefined,
  };
}

export function applyAntigravityEnvDefaultModel(
  config: WrapperConfig,
  envDefaultModel: string | undefined,
): void {
  if (config.model === undefined && envDefaultModel !== undefined) {
    config.model = envDefaultModel;
  }
}
