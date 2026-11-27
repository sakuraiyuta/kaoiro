// ADR-0057 F6: `agy models` register-time probe for the Antigravity engine
// launch catalog. The runner probes once at startup. Catalog refresh and
// socket reconnection reuse the result for the lifetime of the process.

import { execFile } from "node:child_process";
import type { EngineModelInfo } from "@kaoiro/protocol";
import {
  DEFAULT_AGY_PROBE_TIMEOUT_MS,
  agyFailureDetail,
  antigravityCatalogSnapshot,
  parseAgyModelsOutput,
  type AgyExecutableResolution,
} from "@kaoiro/antigravity";

interface AgyModelsResult {
  stdout: string;
}

export type RunAgyModels = (
  path: string,
  timeoutMs: number,
) => Promise<AgyModelsResult>;

function runAgyModels(
  path: string,
  timeoutMs: number,
): Promise<AgyModelsResult> {
  return new Promise((resolve, reject) => {
    execFile(
      path,
      ["models"],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: timeoutMs,
      },
      (error, stdout) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve({ stdout });
      },
    );
  });
}

/** Register-time probe (ADR-0057 F6). Runs `agy models` and resolves the
 *  launch catalog via `parseAgyModelsOutput` (shared with the wrapper —
 *  it prepends the `{ value: "", display_name: "account default" }` entry
 *  itself). Falls back to the pinned 1.3.1 snapshot with a stderr warn on
 *  any failure: binary absent, non-zero exit, timeout, or output the parser
 *  cannot make sense of (docs/reference/engines/antigravity-events.md — the format
 *  drifts with the vendor). */
export async function resolveAntigravityCatalog(
  executable: AgyExecutableResolution,
  probeTimeoutMs: number = DEFAULT_AGY_PROBE_TIMEOUT_MS,
  runModels: RunAgyModels = runAgyModels,
): Promise<EngineModelInfo[]> {
  if (!executable.ok) {
    process.stderr.write(
      "runner: warn — antigravity `agy models` probe unavailable: " +
        `${agyFailureDetail(executable.reason)}; publishing the pinned 1.3.1 snapshot\n`,
    );
    return antigravityCatalogSnapshot();
  }
  let stdout: string;
  try {
    ({ stdout } = await runModels(executable.path, probeTimeoutMs));
  } catch {
    process.stderr.write(
      "runner: warn — antigravity `agy models` probe failed; " +
        "publishing the pinned 1.3.1 snapshot\n",
    );
    return antigravityCatalogSnapshot();
  }
  const models = parseAgyModelsOutput(stdout);
  if (models === null) {
    process.stderr.write(
      "runner: warn — antigravity `agy models` output had no parseable " +
        "models; publishing the pinned 1.3.1 snapshot\n",
    );
    return antigravityCatalogSnapshot();
  }
  return models;
}
