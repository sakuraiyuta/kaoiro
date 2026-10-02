// The runner's behaviour settings (issue #469): the one table that drives the
// runner.config.json parse, the validation of the deprecated KAOIRO_* variable
// that overrides each key, the relay of file values to the wrapper, and the
// reload diff. A variable that is set is never copied into the wrapper
// config: the runner relays nothing for that key, so the wrapper reads the
// inherited variable through its own reader and the two sides cannot
// disagree about whether it is set.

import {
  CLAUDE_SCHEDULER_SETTINGS,
  claudeSchedulerRangeMessage,
  isClaudeSchedulerEnvSet,
  parseClaudeSchedulerNumber,
} from "@kaoiro/claude-code/settings";
import type { EngineKind, WrapperConfig } from "@kaoiro/protocol";
import { ConfigError } from "./config-error.js";
import type { RunnerConfig } from "./config.js";

export type BehaviourBlock = "claude_code";
export type BehaviourValue = number;

export interface ClaudeCodeConfig {
  yield_claim_timeout_ms?: number;
  pending_receipt_root_timeout_ms?: number;
  urgent_overtake_limit?: number;
  folds_per_turn?: number;
}

interface BehaviourRow {
  readonly block: BehaviourBlock;
  readonly key: string;
  readonly wrapperField: keyof WrapperConfig;
  readonly engine: EngineKind;
  readonly env: string;
  readonly envIsSet: (raw: string | undefined) => boolean;
  /** Parses a runner.config.json value; throws ConfigError. */
  readonly parseFile: (value: unknown) => BehaviourValue;
  /** Parses a set variable through the wrapper's own grammar; throws. */
  readonly parseEnv: (raw: string) => BehaviourValue;
}

const CLAUDE_SCHEDULER_ROWS: readonly BehaviourRow[] =
  CLAUDE_SCHEDULER_SETTINGS.map((setting): BehaviourRow => ({
    block: "claude_code",
    key: setting.field,
    wrapperField: setting.field,
    engine: "claude-code",
    env: setting.env,
    envIsSet: isClaudeSchedulerEnvSet,
    parseFile: (value) => {
      const parsed =
        typeof value === "number"
          ? parseClaudeSchedulerNumber(value, setting.max)
          : undefined;
      if (parsed === undefined) {
        throw new ConfigError(
          `claude_code.${claudeSchedulerRangeMessage(setting)}`,
        );
      }
      return parsed;
    },
    parseEnv: (raw) => {
      const parsed = parseClaudeSchedulerNumber(raw, setting.max);
      if (parsed === undefined) {
        throw new ConfigError(
          `${setting.env} must be an integer from 1 through ${setting.max}`,
        );
      }
      return parsed;
    },
  }));

export const BEHAVIOUR_ROWS: readonly BehaviourRow[] = [
  ...CLAUDE_SCHEDULER_ROWS,
];

/** The "block.key" spelling used in warnings and in the reference table. */
export function behaviourConfigPath(row: BehaviourRow): string {
  return `${row.block}.${row.key}`;
}

/** Parses one engine block of runner.config.json. Unknown keys are ignored,
 *  as in the other blocks. */
export function parseBehaviourBlock(
  block: "claude_code",
  raw: Record<string, unknown>,
): ClaudeCodeConfig {
  const parsed: Record<string, BehaviourValue> = {};
  for (const row of BEHAVIOUR_ROWS) {
    if (row.block !== block) continue;
    const value = raw[row.key];
    if (value !== undefined) parsed[row.key] = row.parseFile(value);
  }
  return parsed;
}

function fileValue(
  config: RunnerConfig | undefined,
  row: BehaviourRow,
): BehaviourValue | undefined {
  const block = config?.[row.block] as Record<string, unknown> | undefined;
  return block?.[row.key] as BehaviourValue | undefined;
}

function isEnabled(config: RunnerConfig, engine: EngineKind): boolean {
  // Absent capabilities = every bundled engine (config.ts BUNDLED_ENGINES).
  return config.capabilities?.includes(engine) ?? true;
}

interface SetVariable {
  row: BehaviourRow;
  value: BehaviourValue;
}

/** The deprecated variables that are set for engines this config enables,
 *  each parsed by the wrapper's own grammar. Throws ConfigError naming the
 *  variable. A variable of a disabled engine is neither read nor validated. */
export function readSetVariables(
  config: RunnerConfig,
  env: NodeJS.ProcessEnv,
): SetVariable[] {
  const set: SetVariable[] = [];
  for (const row of BEHAVIOUR_ROWS) {
    if (!isEnabled(config, row.engine)) continue;
    const raw = env[row.env];
    if (!row.envIsSet(raw)) continue;
    set.push({ row, value: row.parseEnv(raw as string) });
  }
  return set;
}

/** Per-engine wrapper config fields to relay: the file value of every key
 *  whose variable is not set. */
export type BehaviourRelay = Partial<
  Record<EngineKind, Partial<WrapperConfig>>
>;

export function computeBehaviourRelay(
  config: RunnerConfig,
  env: NodeJS.ProcessEnv,
): BehaviourRelay {
  const relay: Record<string, Record<string, BehaviourValue>> = {};
  for (const row of BEHAVIOUR_ROWS) {
    if (row.envIsSet(env[row.env])) continue;
    const value = fileValue(config, row);
    if (value === undefined) continue;
    (relay[row.engine] ??= {})[row.wrapperField] = value;
  }
  return relay as BehaviourRelay;
}

/** Deprecation and shadow warnings for the variables that are set. The
 *  deprecation line is emitted once per variable (`seen` carries that state
 *  across reloads). The shadow line is emitted when the file also sets the
 *  key to a different value and the file value is new (startup, or changed
 *  since `previous`), so an edit that a variable hides is never silent. */
export function behaviourWarnings(
  previous: RunnerConfig | undefined,
  next: RunnerConfig,
  set: readonly SetVariable[],
  seen: Set<string>,
): string[] {
  const lines: string[] = [];
  for (const { row, value } of set) {
    const path = behaviourConfigPath(row);
    if (!seen.has(row.env)) {
      seen.add(row.env);
      lines.push(
        `runner: warn - ${row.env} is deprecated; set "${path}" in ` +
          "runner.config.json (the variable still overrides the file)\n",
      );
    }
    const file = fileValue(next, row);
    if (file !== undefined && file !== value && file !== fileValue(previous, row)) {
      lines.push(
        `runner: warn - "${path}" in runner.config.json is shadowed by ` +
          `${row.env}\n`,
      );
    }
  }
  return lines;
}

/** Stable one-line summary of a relay, for the reload receipt. */
export function describeBehaviourRelay(relay: BehaviourRelay): string {
  const parts: string[] = [];
  for (const [engine, fields] of Object.entries(relay)) {
    for (const [field, value] of Object.entries(fields ?? {})) {
      parts.push(`${engine}.${field}=${String(value)}`);
    }
  }
  return parts.length === 0 ? "none" : parts.join(", ");
}
