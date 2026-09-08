import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export const DEFAULT_AGY_PROBE_TIMEOUT_MS = 30_000;
export const MIN_AGY_PROBE_TIMEOUT_MS = 1_000;
export const MAX_AGY_PROBE_TIMEOUT_MS = 120_000;

export type AgyExecutableFailureReason =
  | "executable_missing"
  | "permission_denied"
  | "spawn_failure";

export type AgyExecutableResolution =
  | { ok: true; path: string }
  | { ok: false; reason: AgyExecutableFailureReason };

type CandidateResult = "ready" | "missing" | "denied" | "failed";

function inspectCandidate(path: string): CandidateResult {
  try {
    if (!statSync(path).isFile()) return "denied";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    if (code === "EACCES" || code === "EPERM") return "denied";
    return "failed";
  }
  try {
    accessSync(path, constants.X_OK);
    return "ready";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EACCES" || code === "EPERM" ? "denied" : "failed";
  }
}

/** Resolves a CLI once from a launch-config snapshot. Relative and empty PATH
 * entries are deliberately ignored so a caller's cwd never changes which
 * executable is selected. The returned spelling is preserved for shims. */
export function resolveAgyExecutable(
  cliPath: string | undefined,
  pathValue: string | undefined = process.env.PATH,
): AgyExecutableResolution {
  if (cliPath !== undefined) {
    const candidate = inspectCandidate(cliPath);
    if (candidate === "ready") return { ok: true, path: cliPath };
    return {
      ok: false,
      reason:
        candidate === "missing"
          ? "executable_missing"
          : candidate === "denied"
            ? "permission_denied"
            : "spawn_failure",
    };
  }

  let sawDenied = false;
  let sawFailure = false;
  for (const directory of (pathValue ?? "").split(delimiter)) {
    if (directory === "" || !isAbsolute(directory)) continue;
    const candidate = join(directory, "agy");
    const result = inspectCandidate(candidate);
    if (result === "ready") return { ok: true, path: candidate };
    if (result === "denied") sawDenied = true;
    if (result === "failed") sawFailure = true;
  }
  return {
    ok: false,
    reason: sawFailure
      ? "spawn_failure"
      : sawDenied
        ? "permission_denied"
        : "executable_missing",
  };
}

export function agyFailureDetail(reason: AgyExecutableFailureReason): string {
  switch (reason) {
    case "executable_missing":
      return "antigravity CLI executable is missing";
    case "permission_denied":
      return "antigravity CLI executable is not permitted";
    case "spawn_failure":
      return "antigravity CLI executable could not be inspected";
  }
}
