// The permission-request no-response window (WrapperConfig.permission_timeout_ms),
// shared by the wrapper's config reader and the runner's validation of
// KAOIRO_WRAPPER_PERMISSION_TIMEOUT_MS (issue #469).

export const PERMISSION_TIMEOUT_ENV = "KAOIRO_WRAPPER_PERMISSION_TIMEOUT_MS";

/** Exactly "" is unset; a whitespace-only value is set and then invalid. */
export function isPermissionTimeoutEnvSet(raw: string | undefined): raw is string {
  return raw !== undefined && raw !== "";
}

/** The legacy grammar for the variable: `Number()` must yield an integer of at
 *  least 1. Undefined means invalid. */
export function parsePermissionTimeoutEnv(raw: string): number | undefined {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
