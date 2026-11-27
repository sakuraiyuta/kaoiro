import {
  resolveDigitsMs,
  type SettingSource,
  type TurnWatchdogSettings,
} from "@kaoiro/wrapper-core";

export { TurnWatchdog } from "@kaoiro/wrapper-core";
export type {
  TurnWatchdogOptions,
  TurnWatchdogSettings,
  TurnWatchdogWarning,
} from "@kaoiro/wrapper-core";

export const DEFAULT_TURN_WATCHDOG_INACTIVITY_MS = 30 * 60 * 1_000;
export const DEFAULT_TURN_WATCHDOG_ABORT_GRACE_MS = 60 * 1_000;
export const MIN_TURN_WATCHDOG_INACTIVITY_MS = 60 * 1_000;
export const MAX_TURN_WATCHDOG_DELAY_MS = 2_147_483_647;

export const TURN_WATCHDOG_INACTIVITY_ENV =
  "KAOIRO_CODEX_TURN_WATCHDOG_INACTIVITY_MS";
export const TURN_WATCHDOG_ABORT_GRACE_ENV =
  "KAOIRO_CODEX_TURN_WATCHDOG_ABORT_GRACE_MS";

/** The runner-relayed values (WrapperConfig fields), when present. */
export interface TurnWatchdogConfigValues {
  turn_watchdog_inactivity_ms?: number;
  turn_watchdog_abort_grace_ms?: number;
}

export interface ResolvedTurnWatchdog {
  settings: TurnWatchdogSettings;
  sources: { inactivityMs: SettingSource; abortGraceMs: SettingSource };
}

/** Resolves each value as config field, then the environment variable, then
 *  the default (issue #469). Returning the sources with the settings lets the
 *  startup line report exactly what the watchdog is given. */
export function resolveTurnWatchdogSettings(
  env: Readonly<Record<string, string | undefined>>,
  warn: (message: string) => void,
  config?: TurnWatchdogConfigValues,
): ResolvedTurnWatchdog {
  const inactivity = resolveDigitsMs(
    env,
    TURN_WATCHDOG_INACTIVITY_ENV,
    config?.turn_watchdog_inactivity_ms,
    DEFAULT_TURN_WATCHDOG_INACTIVITY_MS,
    MIN_TURN_WATCHDOG_INACTIVITY_MS,
    MAX_TURN_WATCHDOG_DELAY_MS,
  );
  const abortGrace = resolveDigitsMs(
    env,
    TURN_WATCHDOG_ABORT_GRACE_ENV,
    config?.turn_watchdog_abort_grace_ms,
    DEFAULT_TURN_WATCHDOG_ABORT_GRACE_MS,
    1,
    MAX_TURN_WATCHDOG_DELAY_MS,
  );
  if (inactivity.value < DEFAULT_TURN_WATCHDOG_INACTIVITY_MS) {
    const name =
      inactivity.source === "config"
        ? "turn_watchdog_inactivity_ms"
        : TURN_WATCHDOG_INACTIVITY_ENV;
    warn(
      `[kaoiro] ${name}=${inactivity.value}ms is below ` +
        `the 30-minute default; choose the shorter inactivity value deliberately.\n`,
    );
  }
  return {
    settings: {
      inactivityMs: inactivity.value,
      abortGraceMs: abortGrace.value,
    },
    sources: {
      inactivityMs: inactivity.source,
      abortGraceMs: abortGrace.source,
    },
  };
}

export function readTurnWatchdogSettings(
  env: Readonly<Record<string, string | undefined>>,
  warn: (message: string) => void,
  config?: TurnWatchdogConfigValues,
): TurnWatchdogSettings {
  return resolveTurnWatchdogSettings(env, warn, config).settings;
}
