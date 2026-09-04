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
  catalogFromAgyModels,
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

/** Parses `agy models` stdout into a slug list (one slug per line, measured
 *  1.1.26 — the subcommand rejects `--output-format`). Blank lines are
 *  dropped; no other structure is assumed. */
export function parseAgyModelsOutput(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** Register-time probe (ADR-0057 F6). Runs `agy models` and resolves the
 *  launch catalog via `catalogFromAgyModels` (which itself prepends the
 *  `{ value: "", display_name: "account default" }` entry — the measured
 *  account default slug is not part of the printed list). Falls back to
 *  the pinned 1.1.26 snapshot with a stderr warn on any failure: binary
 *  absent, non-zero exit, timeout, or empty output. */
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
  const slugs = parseAgyModelsOutput(stdout);
  if (slugs.length === 0) {
    process.stderr.write(
      "runner: warn — antigravity `agy models` returned no slugs; " +
        "publishing the pinned 1.1.26 snapshot\n",
    );
    return antigravityCatalogSnapshot();
  }
  return catalogFromAgyModels(slugs);
}
