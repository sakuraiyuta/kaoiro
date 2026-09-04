import type { RunnerConfig } from "./config.js";

/** Config-reload diff: which top-level fields differ. `codex` and
 * `antigravity` are whole-object compares so any change inside either
 * block — `auth_mode` (Phase-24), `chatgpt_plan`, `internal_subagents`,
 * `extra_models` (issue #292) — surfaces as one entry (`"codex"` /
 * `"antigravity"`) and drives one reload. Uses JSON.stringify equality —
 * parseRunnerConfig builds fields in a stable order so a byte-identical
 * config produces byte-identical JSON.
 *
 * Kept outside the CLI entry point so its complete reload allowlist can be
 * tested without starting a runner process. */
export function changedFields(
  prev: RunnerConfig,
  next: RunnerConfig,
): string[] {
  const fields: (keyof RunnerConfig)[] = [
    "host_id",
    "server_url",
    "cwd_allowlist",
    "context_work_budget_percent",
    "capabilities",
    "personas",
    "allowed_personas",
    "blocked_personas",
    "codex",
    "antigravity",
  ];
  const changed: string[] = [];
  for (const field of fields) {
    if (JSON.stringify(prev[field]) !== JSON.stringify(next[field])) {
      changed.push(field);
    }
  }
  return changed;
}
