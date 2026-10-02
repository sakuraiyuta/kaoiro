// The permission-request no-response window (WrapperConfig.permission_timeout_ms),
// shared by the wrapper's config reader and the runner's validation of
// KAOIRO_WRAPPER_PERMISSION_TIMEOUT_MS (issue #469).

import { TURN_WATCHDOG_MAX_DELAY_MS } from "./turn_watchdog_settings.js";

export const PERMISSION_TIMEOUT_ENV = "KAOIRO_WRAPPER_PERMISSION_TIMEOUT_MS";

/** Exactly "" is unset; a whitespace-only value is set and then invalid. */
export function isPermissionTimeoutEnvSet(raw: string | undefined): raw is string {
  return raw !== undefined && raw !== "";
}

/** The legacy grammar for the variable: `Number()` must yield an integer from
 *  1 through Node's maximum timer delay. Undefined means invalid. */
export function parsePermissionTimeoutEnv(raw: string): number | undefined {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= TURN_WATCHDOG_MAX_DELAY_MS
    ? parsed
    : undefined;
}
