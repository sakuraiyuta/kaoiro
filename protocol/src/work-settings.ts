export type WorkCapacityKey = "work_nominated_per_principal" | "work_active_per_assignee";
export type WorkCapacityValues = Record<WorkCapacityKey, number>;
export type WorkCapacityPatch = Partial<Record<WorkCapacityKey, number | null>>;
export type WorkSettingsFailure = "work_settings_corrupt" | "work_settings_unknown";
export interface WorkSettingsChange {
  revision: number;
  at: string;
  actor: { kind: "user"; id: string };
  old_overrides: Partial<WorkCapacityValues>;
  new_overrides: Partial<WorkCapacityValues>;
  old_effective: WorkCapacityValues;
  new_effective: WorkCapacityValues;
}
export interface ReadyWorkSettings {
  version: "0";
  state: "ready";
  revision: number;
  effective: WorkCapacityValues;
  overrides: Partial<WorkCapacityValues>;
  fallbacks: WorkCapacityValues;
  sources: Record<WorkCapacityKey, "dashboard" | "config" | "default">;
  last_change: WorkSettingsChange | null;
  changes?: WorkSettingsChange[];
}
export type WorkSettingsSnapshot = ReadyWorkSettings | {
  version: "0"; state: "unavailable"; reason: WorkSettingsFailure; message: string;
};
export interface WorkCapacityDiagnostic {
  limit: string;
  scope: string;
  maximum: number;
}
