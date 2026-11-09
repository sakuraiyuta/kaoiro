import type { Messages } from "../ja";

export const workCapacitySettings = {
  nominatedLimit: "Limit on nominated work (per requester and assignee)",
  activeLimit: "Limit on active work (per assignee)",
  sourceDashboard: "Dashboard",
  sourceConfig: "Server configuration",
  sourceDefault: "Default",
  revisionConflict:
    "Another change was saved. Check the latest values and enter them again.",
  title: "Work admission limits",
  intro:
    "0 means unlimited. Saved values persist across restarts. Lowering a limit does not cancel existing work.",
  docsLink: "About these settings",
  stateUnknown: "Cannot confirm the saved state",
  repairLink: "Recovery steps",
  unavailable:
    "The settings are not loaded, not connected, or the server does not support them.",
  unlimited: "unlimited (0)",
  effective: ({ value, source, fallback }) =>
    `Effective: ${value} / Source: ${source} / Server setting: ${fallback}`,
  resetToServer: ({ label }) => `Reset to the server setting: ${label}`,
  save: "Save",
  reload: "Reload settings and change history",
  newerSettings:
    "The server settings were updated. Your input is kept. Check the effective values before saving.",
  uncertain:
    "The result is unknown. Do not repeat the save; reload the settings.",
  lastChange: ({ at, actor, revision }) =>
    `Last change: ${at} / ${actor} / revision ${revision}`,
  recentChanges: "Recent changes (up to 100)",
} satisfies Messages["workCapacitySettings"];
