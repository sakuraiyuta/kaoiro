// Startup selection of unified native continuation ownership (issue #426,
// ADR-0063). Read once per wrapper lifetime; there is no live switch.

export const NATIVE_CONTINUATIONS_ENV = "KAOIRO_CLAUDE_NATIVE_CONTINUATIONS";

/** Native continuations are on unless the variable is exactly `0`. `1` keeps
 *  its earlier opt-in meaning. Any other value also selects on, with one
 *  warning, so a mistyped value never silently turns the feature off. */
export function resolveNativeContinuations(
  env: Readonly<Record<string, string | undefined>>,
  warn: (message: string) => void,
): boolean {
  const value = env[NATIVE_CONTINUATIONS_ENV];
  if (value === undefined || value === "1") return true;
  if (value === "0") return false;
  warn(
    `[kaoiro] ${NATIVE_CONTINUATIONS_ENV}=${JSON.stringify(value)} is neither ` +
      `0 nor 1; using the default (native continuations on)\n`,
  );
  return true;
}
