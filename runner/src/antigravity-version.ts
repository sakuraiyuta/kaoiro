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

function runAgyVersion(path: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      path,
      ["--version"],
      { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: timeoutMs },
      (error, stdout) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      },
    );
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
