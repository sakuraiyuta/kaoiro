// ADR-0057 F6: `agy models` register-time probe for the Antigravity engine
// launch catalog. Quota-free CLI call, run once at register time (and on
// config reload). Unlike Claude (ADR-0039 Option E) this engine carries no
// TTL cache or manual refresh — it is deliberately absent from
// LIVE_PROBE_ENGINES (engine_catalog_refresh.ts), so a fresh probe simply
// runs on the next register.

import { execFile } from "node:child_process";
import type { EngineModelInfo } from "@kaoiro/protocol";
import {
  antigravityCatalogSnapshot,
  parseAgyModelsOutput,
} from "@kaoiro/antigravity";

interface AgyModelsResult {
  stdout: string;
}

type RunAgyModels = () => Promise<AgyModelsResult>;

function runAgyModels(): Promise<AgyModelsResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "agy",
      ["models"],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 10_000,
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
 *  itself). Falls back to the pinned 1.1.26 snapshot with a stderr warn on
 *  any failure: binary absent, non-zero exit, timeout, or output the parser
 *  cannot make sense of (docs/specs/antigravity-cli-events.md — the format
 *  drifts with the vendor). */
export async function resolveAntigravityCatalog(
  runModels: RunAgyModels = runAgyModels,
): Promise<EngineModelInfo[]> {
  let stdout: string;
  try {
    ({ stdout } = await runModels());
  } catch {
    process.stderr.write(
      "runner: warn — antigravity `agy models` probe failed; " +
        "publishing the pinned 1.1.26 snapshot\n",
    );
    return antigravityCatalogSnapshot();
  }
  const models = parseAgyModelsOutput(stdout);
  if (models === null) {
    process.stderr.write(
      "runner: warn — antigravity `agy models` output had no parseable " +
        "models; publishing the pinned 1.1.26 snapshot\n",
    );
    return antigravityCatalogSnapshot();
  }
  return models;
}
