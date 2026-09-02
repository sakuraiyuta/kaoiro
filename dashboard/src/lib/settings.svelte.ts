// Client-side settings (#85): notification sound on/off + volume, persisted
// to localStorage under a single namespaced key. `settings` is the shared
// reactive source read by SettingsDrawer (writer) and notify.ts (reader).

export interface Settings {
  notificationSoundEnabled: boolean;
  notificationSoundVolume: number;
  /** AgentCard の engine・model・effort / ctx・5h・7day 追加表示 (issue #193)。
   *  agent_id 行は #193 以前からの既存表示でこのトグルの対象外 — 常に表示
   *  する (envelope の top-level フィールドで viewer にも配信されるため
   *  ext の有無ではそもそも gate できない)。ext はそもそも viewer に配信
   *  されない (ADR-0021) ので、この設定は operator 限定表示を別途判定せず
   *  自然に満たす。既定 on。 */
  agentCardStatsEnabled: boolean;
  /** AgentDetail のログから tool_use/tool_result kind を隠す (issue #228)。
   *  system・ターン境界・assistant/user 本文は対象外で常時表示 — この設定
   *  では gate しない。既定 off (導入前の表示を変えない)。 */
  hideNonMessageLogEntries: boolean;
}

export const SETTINGS_STORAGE_KEY = "kaoiro:settings:v1";

export const DEFAULT_SETTINGS: Settings = {
  notificationSoundEnabled: true,
  notificationSoundVolume: 0.7,
  agentCardStatsEnabled: true,
  hideNonMessageLogEntries: false,
};

function clampVolume(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Reads and validates persisted settings, falling back to defaults on a
 *  missing key, malformed JSON, or an invalid field. */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw === null) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const enabled =
      typeof parsed.notificationSoundEnabled === "boolean"
        ? parsed.notificationSoundEnabled
        : DEFAULT_SETTINGS.notificationSoundEnabled;
    const volume =
      typeof parsed.notificationSoundVolume === "number" &&
      Number.isFinite(parsed.notificationSoundVolume)
        ? clampVolume(parsed.notificationSoundVolume)
        : DEFAULT_SETTINGS.notificationSoundVolume;
    const agentCardStatsEnabled =
      typeof parsed.agentCardStatsEnabled === "boolean"
        ? parsed.agentCardStatsEnabled
        : DEFAULT_SETTINGS.agentCardStatsEnabled;
    const hideNonMessageLogEntries =
      typeof parsed.hideNonMessageLogEntries === "boolean"
        ? parsed.hideNonMessageLogEntries
        : DEFAULT_SETTINGS.hideNonMessageLogEntries;
    return {
      notificationSoundEnabled: enabled,
      notificationSoundVolume: volume,
      agentCardStatsEnabled,
      hideNonMessageLogEntries,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Persists settings to localStorage; a write failure (quota, private mode)
 *  is swallowed so a settings change never breaks the UI. */
export function saveSettings(next: Settings): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // best-effort persistence
  }
}

/** The live settings object. Read directly (`settings.notificationSoundEnabled`);
 *  write via updateSettings() so changes persist. */
export const settings = $state<Settings>(loadSettings());

/** Applies a partial update (clamping volume), then persists the result. */
export function updateSettings(patch: Partial<Settings>): void {
  if (patch.notificationSoundEnabled !== undefined) {
    settings.notificationSoundEnabled = patch.notificationSoundEnabled;
  }
  if (patch.notificationSoundVolume !== undefined) {
    settings.notificationSoundVolume = clampVolume(patch.notificationSoundVolume);
  }
  if (patch.agentCardStatsEnabled !== undefined) {
    settings.agentCardStatsEnabled = patch.agentCardStatsEnabled;
  }
  if (patch.hideNonMessageLogEntries !== undefined) {
    settings.hideNonMessageLogEntries = patch.hideNonMessageLogEntries;
  }
  saveSettings(settings);
}
