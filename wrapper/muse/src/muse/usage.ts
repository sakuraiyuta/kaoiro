import type { SessionConfigOption, SessionModeState } from "@agentclientprotocol/sdk";

export interface MuseMode {
  id: string;
  name: string;
}

export interface MuseModes {
  current: string;
  available: MuseMode[];
}

/** Reads the ACP session mode state (the approval-mode selector) out of a
 *  session/new, session/load or session/resume response. */
export function parseModes(modes: SessionModeState | null | undefined): MuseModes | undefined {
  if (!modes) return undefined;
  return {
    current: modes.currentModeId,
    available: modes.availableModes.map((mode) => ({ id: mode.id, name: mode.name })),
  };
}

export function preferredApprovalMode(modes: MuseModes): MuseMode | undefined {
  return modes.available.find((mode) => mode.id === "promptUnmatched");
}

export interface MuseSelection {
  model?: string;
  effort?: string;
}

/** Reads the model / effort selection out of a session's config options.
 *  Options are matched by ACP category (`model` / `thought_level`), not by
 *  id, so an agent-side rename of the ids does not break the reading. */
export function parseSelection(
  configOptions: SessionConfigOption[] | undefined,
): MuseSelection {
  const selection: MuseSelection = {};
  for (const option of configOptions ?? []) {
    if (option.type !== "select") continue;
    if (option.category === "model") {
      if (typeof option.currentValue === "string") selection.model = option.currentValue;
    } else if (option.category === "thought_level") {
      if (typeof option.currentValue === "string") selection.effort = option.currentValue;
    }
  }
  return selection;
}
