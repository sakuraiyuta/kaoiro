// The Claude phase-2 input-scheduler settings, shared by the wrapper's config
// reader (persona.ts) and the runner, which validates the same variables at
// start so grammar and bounds come from one implementation.

export const CLAUDE_SCHEDULER_SETTINGS = [
  {
    field: "yield_claim_timeout_ms",
    env: "KAOIRO_CLAUDE_YIELD_CLAIM_TIMEOUT_MS",
    max: 60_000,
  },
  {
    field: "pending_receipt_root_timeout_ms",
    env: "KAOIRO_CLAUDE_PENDING_RECEIPT_ROOT_TIMEOUT_MS",
    max: 60_000,
  },
  {
    field: "urgent_overtake_limit",
    env: "KAOIRO_CLAUDE_URGENT_OVERTAKE_LIMIT",
    max: 64,
  },
  {
    field: "folds_per_turn",
    env: "KAOIRO_CLAUDE_FOLDS_PER_TURN",
    max: 64,
  },
] as const;

export type ClaudeSchedulerSetting = (typeof CLAUDE_SCHEDULER_SETTINGS)[number];
export type ClaudeSchedulerField = ClaudeSchedulerSetting["field"];

/** Whether an environment value counts as set: exactly "" is unset, a
 *  whitespace-only value is set (and then fails to parse). */
export function isClaudeSchedulerEnvSet(raw: string | undefined): raw is string {
  return raw !== undefined && raw !== "";
}

/** The legacy grammar: a non-number is coerced with `Number()`, and the result
 *  must be a safe integer from 1 through `max`. Undefined means invalid. */
export function parseClaudeSchedulerNumber(
  value: unknown,
  max: number,
): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    return undefined;
  }
  return parsed;
}

export function claudeSchedulerRangeMessage(
  setting: ClaudeSchedulerSetting,
): string {
  return `${setting.field} must be an integer from 1 through ${setting.max}`;
}
