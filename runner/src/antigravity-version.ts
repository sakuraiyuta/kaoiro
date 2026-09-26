// ADR-0057 F6 / phase-34 B4 (issue #387): `agy --version` probe, run
// alongside the `agy models` catalog probe (antigravity-catalog.ts). Quota-
// free CLI call. Returns null on any failure (binary absent, non-zero exit,
// timeout) -- callers use this for operator-facing reporting only, never to
// gate startup (that gate is the setup wizard's presence check instead).

import { execFile } from "node:child_process";
import {
  DEFAULT_AGY_PROBE_TIMEOUT_MS,
  type AgyExecutableResolution,
} from "@kaoiro/antigravity";

export type RunAgyVersion = (path: string, timeoutMs: number) => Promise<string>;

const MAX_AGY_VERSION_BYTES = 256;
const AGY_VERSION_CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

export function normalizeAgyCliVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const version = value.trim();
  if (
    version === "" ||
    AGY_VERSION_CONTROL_CHARS.test(version) ||
    new TextEncoder().encode(version).byteLength > MAX_AGY_VERSION_BYTES
  ) {
    return undefined;
  }
  return version;
}

/** issue #387 review must-fix S2: `execFile`'s own `timeout` option only
 *  SENDS `killSignal` (default SIGTERM) when the deadline passes -- if the
 *  child ignores it, the child process never exits, so execFile's callback
 *  never fires and the caller hangs forever (Node docs, child_process
 *  timeout). A watchdog independent of that callback frees the caller on
 *  the deadline regardless of whether the child actually dies, and forces
 *  the point with SIGKILL (which cannot be ignored) so the child does not
 *  linger. */
function runAgyVersion(path: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = execFile(
      path,
      ["--version"],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      },
    );
    const watchdog = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`agy --version timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

export async function resolveAgyVersion(
  executable: AgyExecutableResolution,
  probeTimeoutMs: number = DEFAULT_AGY_PROBE_TIMEOUT_MS,
  runVersion: RunAgyVersion = runAgyVersion,
): Promise<string | null> {
  if (!executable.ok) return null;
  try {
    return await runVersion(executable.path, probeTimeoutMs);
  } catch {
    return null;
  }
}
