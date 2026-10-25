import type { WorkCapacityKey, WorkCapacityValues, WorkSettingsChange, ReadyWorkSettings, WorkSettingsSnapshot } from "@kaoiro/protocol";
export const WORK_CAPACITY_KEYS = ["work_nominated_per_principal", "work_active_per_assignee"] as const;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function isWorkCapacityValue(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 2147483647;
}
function values(value: unknown, partial = false): boolean {
  return object(value) && Object.keys(value).every(key =>
    WORK_CAPACITY_KEYS.includes(key as WorkCapacityKey) && isWorkCapacityValue(value[key])) &&
    (partial || WORK_CAPACITY_KEYS.every(key => Object.hasOwn(value, key)));
}
function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function change(value: unknown): value is WorkSettingsChange {
  return object(value) && revision(value.revision) && value.revision > 0 &&
    typeof value.at === "string" && value.at.length <= 40 && Number.isFinite(Date.parse(value.at)) &&
    object(value.actor) && value.actor.kind === "user" && typeof value.actor.id === "string" &&
    value.actor.id.length > 0 && value.actor.id.length <= 256 &&
    values(value.old_overrides, true) && values(value.new_overrides, true) &&
    values(value.old_effective) && values(value.new_effective);
}
export function parseWorkSettings(value: unknown): WorkSettingsSnapshot | null {
  if (!object(value)) return null;
  if (value.state === "unavailable") {
    if ((value.reason !== "work_settings_corrupt" && value.reason !== "work_settings_unknown") ||
        typeof value.message !== "string" || value.message.length > 1024) return null;
    return { version: "0", state: "unavailable", reason: value.reason, message: value.message };
  }
  if (value.state !== "ready" || !revision(value.revision) || !values(value.effective) ||
      !values(value.fallbacks) || !values(value.overrides, true) || !object(value.sources) ||
      !WORK_CAPACITY_KEYS.every(key => ["dashboard", "config", "default"].includes(String((value.sources as Record<string, unknown>)[key]))) ||
      !(value.last_change === null || change(value.last_change)) ||
      (value.changes !== undefined && (!Array.isArray(value.changes) || value.changes.length > 100 || !value.changes.every(change)))) return null;
  return { version: "0", state: "ready", revision: value.revision,
    effective: value.effective as WorkCapacityValues, fallbacks: value.fallbacks as WorkCapacityValues,
    overrides: value.overrides as Partial<WorkCapacityValues>, sources: value.sources as ReadyWorkSettings["sources"],
    last_change: value.last_change as WorkSettingsChange | null,
    ...(value.changes === undefined ? {} : { changes: value.changes as WorkSettingsChange[] }) };
}
