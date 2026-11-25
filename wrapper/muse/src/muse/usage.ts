import type { SessionConfigOption } from "@agentclientprotocol/sdk";

export interface MuseModel {
  value: string;
  display_name: string;
}

export interface MuseSelection {
  /** The session's model catalog, from the `model` config option. */
  models: MuseModel[];
  /** Effort levels offered by the `thought_level` config option, if any. */
  effortLevels: string[];
  model?: string;
  effort?: string;
  /** The config option ids switches must use, as the agent named them. */
  modelConfigId?: string;
  effortConfigId?: string;
}

function selectValues(option: SessionConfigOption): { value: string; name: string }[] {
  if (option.type !== "select") return [];
  const out: { value: string; name: string }[] = [];
  for (const entry of option.options) {
    if ("options" in entry) {
      for (const inner of entry.options) out.push({ value: inner.value, name: inner.name });
    } else {
      out.push({ value: entry.value, name: entry.name });
    }
  }
  return out;
}

/** Reads the model / effort selection out of a session's config options.
 *  Options are matched by ACP category (`model` / `thought_level`), not by
 *  id, so an agent-side rename of the ids does not break the reading. */
export function parseSelection(
  configOptions: SessionConfigOption[] | undefined,
): MuseSelection {
  const selection: MuseSelection = { models: [], effortLevels: [] };
  for (const option of configOptions ?? []) {
    if (option.type !== "select") continue;
    const values = selectValues(option);
    if (option.category === "model") {
      selection.modelConfigId = option.id;
      selection.models = values.map(({ value, name }) => ({
        value,
        display_name: name,
      }));
      if (typeof option.currentValue === "string") selection.model = option.currentValue;
    } else if (option.category === "thought_level") {
      selection.effortConfigId = option.id;
      selection.effortLevels = values.map(({ value }) => value);
      if (typeof option.currentValue === "string") selection.effort = option.currentValue;
    }
  }
  return selection;
}
