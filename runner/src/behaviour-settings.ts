// The runner's behaviour settings (issue #469): the one table that drives the
// runner.config.json parse, the validation of the deprecated KAOIRO_* variable
// that overrides each key, the relay of file values to the wrapper, and the
// reload diff. A variable that is set is never copied into the wrapper
// config: the runner relays nothing for that key, so the wrapper reads the
// inherited variable through its own reader and the two sides cannot
// disagree about whether it is set.

import { readTurnWatchdogSettings as readCodexWatchdog } from "@kaoiro/codex";
import {
  readEpochIdleMs,
  readTurnWatchdogSettings as readAntigravityWatchdog,
} from "@kaoiro/antigravity";
import {
  CLAUDE_SCHEDULER_SETTINGS,
  PERMISSION_TIMEOUT_ENV,
  TURN_WATCHDOG_MAX_DELAY_MS,
  TURN_WATCHDOG_MIN_ABORT_GRACE_MS,
  TURN_WATCHDOG_MIN_INACTIVITY_MS,
  claudeSchedulerRangeMessage,
  isClaudeSchedulerEnvSet,
  isPermissionTimeoutEnvSet,
  parseClaudeSchedulerNumber,
  parsePermissionTimeoutEnv,
  readTurnWatchdogSettings as readClaudeWatchdog,
} from "@kaoiro/claude-code/settings";
import type { EngineKind, WrapperConfig } from "@kaoiro/protocol";
import { ConfigError } from "./config-error.js";
import { DELIVERY_ENGINE_SETTINGS } from "@kaoiro/agent-common";
import type { RunnerConfig } from "./config.js";

export type BehaviourBlock = "claude_code" | "codex" | "antigravity";
export type BehaviourValue = number | boolean | string;

export const HOST_DELIVERY_ROWS = DELIVERY_ENGINE_SETTINGS;
export type InFlightDeliveryConfig = Partial<Record<EngineKind, { enabled?: boolean; default?: boolean }>>;

export function parseInFlightDelivery(value: unknown): InFlightDeliveryConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError("in_flight_delivery must be an object");
  }
  const parsed: InFlightDeliveryConfig = {};
  for (const [engine, raw] of Object.entries(value)) {
    if (!HOST_DELIVERY_ROWS.some(row => row.engine === engine)) {
      throw new ConfigError("in_flight_delivery has an unknown engine key");
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new ConfigError(`in_flight_delivery.${engine} must be an object`);
    }
    const entry: { enabled?: boolean; default?: boolean } = {};
    for (const [key, item] of Object.entries(raw)) {
      if (key !== "enabled" && key !== "default") {
        throw new ConfigError(`in_flight_delivery.${engine} has an unknown key`);
      }
      if (typeof item !== "boolean") throw new ConfigError(`in_flight_delivery.${engine}.${key} must be a boolean`);
      entry[key] = item;
    }
    parsed[engine as EngineKind] = entry;
  }
  return parsed;
}

/** Environment variables of the runner's own settings. Defined here, not in
 *  config.ts, because the registry below is built at module load and config.ts
 *  imports this module. */
export const SERVER_URL_ENV = "KAOIRO_RUNNER_SERVER_URL";
export const PHOENIX_HEARTBEAT_LOGS_ENV = "KAOIRO_RUNNER_LOG_PHOENIX_HEARTBEATS";

/** Turn watchdog keys, present in every engine block. */
export interface WatchdogConfig {
  turn_watchdog_inactivity_ms?: number;
  turn_watchdog_abort_grace_ms?: number;
}

/** Antigravity-only timing keys, next to its watchdog keys. */
export interface AntigravityBehaviourConfig extends WatchdogConfig {
  tool_timeout_ms?: number;
  epoch_idle_ms?: number;
}

/** Codex global opt-ins next to its watchdog keys. */
export interface CodexBehaviourConfig extends WatchdogConfig {
  operator_steer?: boolean;
  approval_axis?: boolean;
}

export interface ClaudeCodeConfig extends WatchdogConfig {
  phase2_delivery?: boolean;
  yield_claim_timeout_ms?: number;
  pending_receipt_root_timeout_ms?: number;
  urgent_overtake_limit?: number;
  folds_per_turn?: number;
}

interface BehaviourRow {
  /** Engine block of runner.config.json; absent for a top-level key. */
  readonly block: BehaviourBlock | undefined;
  readonly key: string;
  /** Absent for a setting of the runner itself, which is never relayed. */
  readonly wrapperField: keyof WrapperConfig | undefined;
  /** The engine whose wrappers receive it; "all" for every engine, "runner"
   *  for a setting the runner itself acts on. */
  readonly engine: EngineKind | "all" | "runner";
  /** The file key is parsed by parseRunnerConfig itself, not by this table. */
  readonly fileParsedElsewhere?: true;
  /** A file value of `false` is the same as an absent key (global opt-in
   *  flags): it is neither relayed nor reported as shadowed. */
  readonly falseIsAbsent?: true;
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

const WATCHDOG_RANGES = {
  turn_watchdog_inactivity_ms: [
    TURN_WATCHDOG_MIN_INACTIVITY_MS,
    TURN_WATCHDOG_MAX_DELAY_MS,
  ],
  turn_watchdog_abort_grace_ms: [
    TURN_WATCHDOG_MIN_ABORT_GRACE_MS,
    TURN_WATCHDOG_MAX_DELAY_MS,
  ],
} as const;

type WatchdogKey = keyof typeof WATCHDOG_RANGES;

/** Each engine keeps its own variable names; the grammar and bounds of a set
 *  variable come from that engine's own reader. */
const WATCHDOG_ENGINES = [
  {
    block: "claude_code",
    engine: "claude-code",
    read: readClaudeWatchdog,
    inactivity: "KAOIRO_CLAUDE_TURN_WATCHDOG_INACTIVITY_MS",
    abortGrace: "KAOIRO_CLAUDE_TURN_WATCHDOG_ABORT_GRACE_MS",
  },
  {
    block: "codex",
    engine: "codex",
    read: readCodexWatchdog,
    inactivity: "KAOIRO_CODEX_TURN_WATCHDOG_INACTIVITY_MS",
    abortGrace: "KAOIRO_CODEX_TURN_WATCHDOG_ABORT_GRACE_MS",
  },
  {
    block: "antigravity",
    engine: "antigravity",
    read: readAntigravityWatchdog,
    inactivity: "KAOIRO_ANTIGRAVITY_TURN_WATCHDOG_INACTIVITY_MS",
    abortGrace: "KAOIRO_ANTIGRAVITY_TURN_WATCHDOG_ABORT_GRACE_MS",
  },
] as const;

function integerInRange(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}

const WATCHDOG_ROWS: readonly BehaviourRow[] = WATCHDOG_ENGINES.flatMap(
  (spec) =>
    (Object.keys(WATCHDOG_RANGES) as WatchdogKey[]).map((key): BehaviourRow => {
      const [min, max] = WATCHDOG_RANGES[key];
      const env =
        key === "turn_watchdog_inactivity_ms" ? spec.inactivity : spec.abortGrace;
      return {
        block: spec.block,
        key,
        wrapperField: key,
        engine: spec.engine,
        env,
        // Same test as the readers: undefined or exactly "" is unset.
        envIsSet: (raw) => raw !== undefined && raw !== "",
        parseFile: (value) => {
          if (!integerInRange(value, min, max)) {
            throw new ConfigError(
              `${spec.block}.${key} must be an integer from ${min} through ${max}`,
            );
          }
          return value;
        },
        parseEnv: (raw) => {
          let settings;
          try {
            settings = spec.read({ [env]: raw }, () => {});
          } catch (error) {
            throw new ConfigError(
              error instanceof Error ? error.message : String(error),
            );
          }
          return key === "turn_watchdog_inactivity_ms"
            ? settings.inactivityMs
            : settings.abortGraceMs;
        },
      };
    }),
);

const PERMISSION_TIMEOUT_ROW: BehaviourRow = {
  block: undefined,
  key: "permission_timeout_ms",
  wrapperField: "permission_timeout_ms",
  engine: "all",
  env: PERMISSION_TIMEOUT_ENV,
  envIsSet: isPermissionTimeoutEnvSet,
  parseFile: (value) => {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > TURN_WATCHDOG_MAX_DELAY_MS
    ) {
      throw new ConfigError(
        `permission_timeout_ms must be an integer from 1 through ${TURN_WATCHDOG_MAX_DELAY_MS}`,
      );
    }
    return value;
  },
  parseEnv: (raw) => {
    const parsed = parsePermissionTimeoutEnv(raw);
    if (parsed === undefined) {
      throw new ConfigError(
        `${PERMISSION_TIMEOUT_ENV} must be an integer from 1 through ${TURN_WATCHDOG_MAX_DELAY_MS}`,
      );
    }
    return parsed;
  },
};

const ANTIGRAVITY_MIN_TIMING_MS = 1_000;

/** The three global opt-in flags. Config `true` is the global opt-in, the same
 *  as the variable being exactly "1"; `false` is the same as absent. A set
 *  variable is not relayed (the wrapper's flag argument takes the variable
 *  first, so omission and "variable first" agree). */
function flagRow(
  block: BehaviourBlock,
  engine: EngineKind,
  key: "operator_steer" | "approval_axis" | "phase2_delivery",
  env: string,
): BehaviourRow {
  return {
    block,
    key,
    wrapperField: key,
    engine,
    falseIsAbsent: true,
    env,
    envIsSet: (raw) => raw !== undefined && raw !== "",
    parseFile: (value) => {
      if (typeof value !== "boolean") {
        throw new ConfigError(`${block}.${key} must be a boolean`);
      }
      return value;
    },
    // Exactly "1" is the global opt-in; any other set value is not.
    parseEnv: (raw) => raw === "1",
  };
}

const FLAG_ROWS: readonly BehaviourRow[] = [
  flagRow("codex", "codex", "operator_steer", "KAOIRO_CODEX_OPERATOR_STEER"),
  flagRow("codex", "codex", "approval_axis", "KAOIRO_CODEX_APPROVAL_AXIS"),
  flagRow(
    "claude_code",
    "claude-code",
    "phase2_delivery",
    "KAOIRO_CLAUDE_PHASE2_DELIVERY",
  ),
];

/** Antigravity's two timing keys beside the watchdog. A set variable is parsed
 *  by the wrapper's own readers. */
const ANTIGRAVITY_TIMING_ROWS: readonly BehaviourRow[] = [
  {
    block: "antigravity",
    key: "tool_timeout_ms",
    wrapperField: "antigravity_tool_timeout_ms",
    engine: "antigravity",
    env: "KAOIRO_ANTIGRAVITY_TOOL_TIMEOUT_MS",
    envIsSet: (raw) => raw !== undefined && raw !== "",
    parseFile: (value) => {
      if (!integerInRange(value, ANTIGRAVITY_MIN_TIMING_MS, TURN_WATCHDOG_MAX_DELAY_MS)) {
        throw new ConfigError(
          `antigravity.tool_timeout_ms must be an integer from ` +
            `${ANTIGRAVITY_MIN_TIMING_MS} through ${TURN_WATCHDOG_MAX_DELAY_MS}`,
        );
      }
      return value;
    },
    parseEnv: (raw) => {
      try {
        return readAntigravityWatchdog(
          { KAOIRO_ANTIGRAVITY_TOOL_TIMEOUT_MS: raw },
          () => {},
        ).toolTimeoutMs;
      } catch (error) {
        throw new ConfigError(error instanceof Error ? error.message : String(error));
      }
    },
  },
  {
    block: "antigravity",
    key: "epoch_idle_ms",
    wrapperField: "antigravity_epoch_idle_ms",
    engine: "antigravity",
    env: "KAOIRO_ANTIGRAVITY_EPOCH_IDLE_MS",
    envIsSet: (raw) => raw !== undefined && raw !== "",
    parseFile: (value) => {
      if (!integerInRange(value, ANTIGRAVITY_MIN_TIMING_MS, TURN_WATCHDOG_MAX_DELAY_MS)) {
        throw new ConfigError(
          `antigravity.epoch_idle_ms must be an integer from ` +
            `${ANTIGRAVITY_MIN_TIMING_MS} through ${TURN_WATCHDOG_MAX_DELAY_MS}`,
        );
      }
      return value;
    },
    parseEnv: (raw) => {
      try {
        return readEpochIdleMs({ KAOIRO_ANTIGRAVITY_EPOCH_IDLE_MS: raw });
      } catch (error) {
        throw new ConfigError(error instanceof Error ? error.message : String(error));
      }
    },
  },
];

/** Settings the runner acts on itself. Their variables are deprecated like the
 *  others and still win; nothing is relayed to a wrapper. */
const RUNNER_ROWS: readonly BehaviourRow[] = [
  {
    block: undefined,
    key: "server_url",
    wrapperField: undefined,
    engine: "runner",
    fileParsedElsewhere: true,
    env: SERVER_URL_ENV,
    envIsSet: (raw) => raw !== undefined && raw !== "",
    parseFile: (value) => String(value),
    parseEnv: (raw) => {
      if (!raw.startsWith("ws://") && !raw.startsWith("wss://")) {
        throw new ConfigError(`${SERVER_URL_ENV} must start with ws:// or wss://`);
      }
      return raw;
    },
  },
  {
    block: undefined,
    key: "log_phoenix_heartbeats",
    wrapperField: undefined,
    engine: "runner",
    env: PHOENIX_HEARTBEAT_LOGS_ENV,
    envIsSet: (raw) => raw !== undefined && raw !== "",
    parseFile: (value) => {
      if (typeof value !== "boolean") {
        throw new ConfigError("log_phoenix_heartbeats must be a boolean");
      }
      return value;
    },
    // Exactly "1" turns it on; anything else is off, as before.
    parseEnv: (raw) => raw === "1",
  },
];

export const BEHAVIOUR_ROWS: readonly BehaviourRow[] = [
  ...CLAUDE_SCHEDULER_ROWS,
  ...WATCHDOG_ROWS,
  ...ANTIGRAVITY_TIMING_ROWS,
  PERMISSION_TIMEOUT_ROW,
  ...FLAG_ROWS,
  ...RUNNER_ROWS,
];

/** The "block.key" spelling used in warnings and in the reference table. */
export function behaviourConfigPath(row: BehaviourRow): string {
  return row.block === undefined ? row.key : `${row.block}.${row.key}`;
}

/** Parses one engine block of runner.config.json. Unknown keys are ignored,
 *  as in the other blocks. */
export function parseBehaviourBlock(
  block: BehaviourBlock,
  raw: Record<string, unknown>,
): ClaudeCodeConfig & AntigravityBehaviourConfig & CodexBehaviourConfig {
  const parsed: Record<string, BehaviourValue> = {};
  for (const row of BEHAVIOUR_ROWS) {
    if (row.block !== block) continue;
    const value = raw[row.key];
    if (value !== undefined) parsed[row.key] = row.parseFile(value);
  }
  return parsed as ClaudeCodeConfig &
    AntigravityBehaviourConfig &
    CodexBehaviourConfig;
}

/** The top-level behaviour keys (no engine block) present in the file. */
export function parseTopLevelBehaviour(
  raw: Record<string, unknown>,
): { permission_timeout_ms?: number; log_phoenix_heartbeats?: boolean } {
  const parsed: Record<string, BehaviourValue> = {};
  for (const row of BEHAVIOUR_ROWS) {
    if (row.block !== undefined || row.fileParsedElsewhere) continue;
    const value = raw[row.key];
    if (value !== undefined) parsed[row.key] = row.parseFile(value);
  }
  return parsed as { permission_timeout_ms?: number; log_phoenix_heartbeats?: boolean };
}

function fileValue(
  config: RunnerConfig | undefined,
  row: BehaviourRow,
): BehaviourValue | undefined {
  const holder = (
    row.block === undefined ? config : config?.[row.block]
  ) as Record<string, unknown> | undefined;
  const value = holder?.[row.key] as BehaviourValue | undefined;
  return row.falseIsAbsent && value === false ? undefined : value;
}

function isEnabled(
  config: RunnerConfig,
  engine: EngineKind | "all" | "runner",
): boolean {
  // Absent capabilities = every bundled engine (config.ts BUNDLED_ENGINES).
  // A top-level row applies to every engine and a runner row to the runner
  // itself, so both are always read.
  if (engine === "all" || engine === "runner") return true;
  return config.capabilities?.includes(engine) ?? true;
}

const ALL_ENGINES: readonly EngineKind[] = ["claude-code", "codex", "antigravity"];

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
    if (row.engine === "runner" || row.wrapperField === undefined) continue;
    if (row.envIsSet(env[row.env])) continue;
    const value = fileValue(config, row);
    if (value === undefined) continue;
    for (const engine of row.engine === "all" ? ALL_ENGINES : [row.engine]) {
      (relay[engine] ??= {})[row.wrapperField] = value;
    }
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

/** Whether Phoenix heartbeat lines are kept: a set variable wins (exactly
 *  "1" is on), else the file value, else off. */
export function resolveHeartbeatLogging(
  config: RunnerConfig,
  env: NodeJS.ProcessEnv,
): boolean {
  const raw = env[PHOENIX_HEARTBEAT_LOGS_ENV];
  if (raw !== undefined && raw !== "") return raw === "1";
  return config.log_phoenix_heartbeats === true;
}
