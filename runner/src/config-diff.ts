import type { RunnerConfig } from "./config.js";

/** Config-reload diff: which top-level fields differ. `codex` and
 * `antigravity` are whole-object compares so any change inside either
 * block, including `codex.backend`, surfaces as one entry (`"codex"` /
 * `"antigravity"`) and drives one reload. Uses JSON.stringify equality —
 * parseRunnerConfig builds fields in a stable order so a byte-identical
 * config produces byte-identical JSON.
 *
 * Kept outside the CLI entry point so its complete reload allowlist can be
 * tested without starting a runner process. */
/** Every top-level RunnerConfig key. A key added to RunnerConfig without an
 *  entry here is a compile error, so a new setting cannot be silently left
 *  out of the reload diff (an empty diff skips the whole reload). */
const RELOAD_FIELDS: Record<keyof RunnerConfig, true> = {
  host_id: true,
  server_url: true,
  cwd_allowlist: true,
  context_work_budget_percent: true,
  capabilities: true,
  personas: true,
  allowed_personas: true,
  blocked_personas: true,
  codex: true,
  antigravity: true,
  claude_code: true,
  permission_timeout_ms: true,
  log_phoenix_heartbeats: true,
};

export function changedFields(
  prev: RunnerConfig,
  next: RunnerConfig,
): string[] {
  const changed: string[] = [];
  for (const field of Object.keys(RELOAD_FIELDS) as (keyof RunnerConfig)[]) {
    if (JSON.stringify(prev[field]) !== JSON.stringify(next[field])) {
      changed.push(field);
    }
  }
  return changed;
}
