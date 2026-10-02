// Shared pieces of the per-engine turn watchdog settings (issue #469): the
// bounds, the digits-only environment grammar and the selection of
// config field, then environment variable, then default. The three engines
// keep their own variable names and defaults; the runner validates a set
// variable by calling the engine's own reader, so grammar and bounds live
// here once.

export const TURN_WATCHDOG_MIN_INACTIVITY_MS = 60_000;
export const TURN_WATCHDOG_MIN_ABORT_GRACE_MS = 1;
export const TURN_WATCHDOG_MAX_DELAY_MS = 2_147_483_647;

export type SettingSource = "config" | "env" | "default";

export interface ResolvedMs {
  value: number;
  source: SettingSource;
}

/** The digits-only grammar: an undefined or exactly empty variable is unset,
 *  anything else must be decimal digits within [min, max]. */
export function readDigitsMs(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`${name} must be an integer number of milliseconds`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer >= ${min} and <= ${max}`);
  }
  return value;
}

/** config field (already validated by parseConfig), else the variable, else
 *  the default. */
export function resolveDigitsMs(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  configValue: number | undefined,
  fallback: number,
  min: number,
  max: number,
): ResolvedMs {
  if (configValue !== undefined) return { value: configValue, source: "config" };
  const raw = env[name];
  const unset = raw === undefined || raw === "";
  return {
    value: readDigitsMs(env, name, fallback, min, max),
    source: unset ? "default" : "env",
  };
}

/** The startup line each wrapper prints from the resolved watchdog object it
 *  hands to its TurnWatchdog, with each value's source. The pid lets an
 *  integration test confirm termination of exactly the process it observed. */
export function formatTurnWatchdogLine(
  engine: string,
  pid: number,
  resolved: {
    settings: { inactivityMs: number; abortGraceMs: number };
    sources: { inactivityMs: SettingSource; abortGraceMs: SettingSource };
  },
  permissionTimeoutMs: number | undefined,
  /** Engine-specific values with their sources, appended after the common ones. */
  extra: ReadonlyArray<readonly [name: string, resolved: ResolvedMs]> = [],
): string {
  const { settings, sources } = resolved;
  return (
    `[kaoiro] ${engine} behaviour: pid=${pid} ` +
    `turn_watchdog_inactivity_ms=${settings.inactivityMs}(${sources.inactivityMs}) ` +
    `turn_watchdog_abort_grace_ms=${settings.abortGraceMs}(${sources.abortGraceMs}) ` +
    `permission_timeout_ms=${permissionTimeoutMs ?? "none"}` +
    extra
      .map(([name, { value, source }]) => ` ${name}=${value}(${source})`)
      .join("") +
    "\n"
  );
}
