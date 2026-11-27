import { resolveStandardTurnWatchdogSettings } from "@kaoiro/wrapper-core";

export interface WatchdogSettings {
  inactivityMs: number;
  abortGraceMs: number;
}
export function resolveTurnWatchdogSettings(
  env: Readonly<Record<string, string | undefined>>,
  warn: (message: string) => void,
  config?: {
    turn_watchdog_inactivity_ms?: number;
    turn_watchdog_abort_grace_ms?: number;
  },
) {
  return resolveStandardTurnWatchdogSettings(env, warn, {
    inactivity: "KAOIRO_GROK_TURN_WATCHDOG_INACTIVITY_MS",
    abortGrace: "KAOIRO_GROK_TURN_WATCHDOG_ABORT_GRACE_MS",
  }, config);
}
export function readTurnWatchdogSettings(
  env: Readonly<Record<string, string | undefined>>,
  warn: (message: string) => void,
  config?: {
    turn_watchdog_inactivity_ms?: number;
    turn_watchdog_abort_grace_ms?: number;
  },
): WatchdogSettings {
  return resolveTurnWatchdogSettings(env, warn, config).settings;
}
