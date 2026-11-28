import { isMuseEffort, isMuseModelId } from "@kaoiro/muse";
import type { EngineModelInfo } from "@kaoiro/protocol";
import {
  MuseProbeAborted, MuseProbeError, readMuseModelList, type MuseProbeOptions,
} from "./muse_acp_probe.js";

const defaultModel: EngineModelInfo = {
  value: "default", display_name: "Account default",
};

class InvalidCatalog extends Error {}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export async function probeMuseCatalog(
  options: MuseProbeOptions,
): Promise<EngineModelInfo[] | undefined> {
  try {
    const result = record(await readMuseModelList(options));
    if (result?.providerId !== "meta" || result.source !== "providerCatalog") {
      throw new InvalidCatalog("unsupported catalog source");
    }
    if (!Array.isArray(result.models) || result.models.length === 0) {
      throw new InvalidCatalog("empty or invalid model list");
    }
    const ids = new Set<string>();
    const models = result.models.map((entry: unknown): EngineModelInfo => {
      const row = record(entry);
      const id = row?.modelId;
      if (!isMuseModelId(id) || ids.has(id)) {
        throw new InvalidCatalog("invalid or duplicate model id");
      }
      ids.add(id);
      const variants: unknown = row?.variants;
      const levels = Array.isArray(variants)
        ? [...new Set(variants.filter(isMuseEffort))] : [];
      return {
        value: id, display_name: id,
        ...(levels.length ? { effort_levels: levels } : {}),
      };
    });
    return [defaultModel, ...models];
  } catch (error) {
    if (error instanceof MuseProbeAborted || options.signal?.aborted) return;
    const reason = error instanceof MuseProbeError ||
      error instanceof InvalidCatalog ? error.message : "unexpected failure";
    process.stderr.write(
      `runner: Muse catalog failed (${reason}); using Default only\n`,
    );
  }
}
