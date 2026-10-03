// The inter-agent queue limits, shared by the wrapper's config reader
// (persona.ts) and the runner, which resolves omitted keys to these defaults
// when it builds a spawn snapshot. The server applies its own ceilings on top
// (docs/reference/protocol/channels.md, server-owned inter-agent queue).

import type { InterAgentQueuePolicy } from "@kaoiro/protocol";

/** EX_CONFIG. The runner does not restart a wrapper that exits with it. */
export const WRAPPER_CONFIG_EXIT_CODE = 78;

export const INTER_AGENT_QUEUE_SETTINGS = [
  {
    field: "inter_agent_batch_max_items",
    defaultValue: 10,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  },
  {
    field: "inter_agent_backlog_max_items",
    defaultValue: 100,
    min: 1,
    max: 1000,
  },
  {
    field: "inter_agent_backlog_max_bytes",
    defaultValue: 524_288,
    min: 16_384,
    max: Number.MAX_SAFE_INTEGER,
  },
] as const;

export type InterAgentQueueSetting = (typeof INTER_AGENT_QUEUE_SETTINGS)[number];
export type InterAgentQueueField = InterAgentQueueSetting["field"];
export type InterAgentQueueSettings = Record<InterAgentQueueField, number>;

/** A JSON number that is a safe integer within the setting's bounds; strings
 *  are not coerced. Undefined means invalid. */
export function parseInterAgentQueueSetting(
  setting: InterAgentQueueSetting,
  value: unknown,
): number | undefined {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < setting.min ||
    value > setting.max
  ) {
    return undefined;
  }
  return value;
}

export function interAgentQueueRangeMessage(
  setting: InterAgentQueueSetting,
): string {
  return setting.max === Number.MAX_SAFE_INTEGER
    ? `${setting.field} must be a safe integer of at least ${setting.min}`
    : `${setting.field} must be an integer from ${setting.min} through ${setting.max}`;
}

/** The complete tuple a wrapper declares, with omitted keys at their
 *  defaults. Values are assumed already validated by the config reader. */
export function resolveInterAgentQueueSettings(
  config: Partial<InterAgentQueueSettings>,
): InterAgentQueueSettings {
  const resolved = {} as InterAgentQueueSettings;
  for (const setting of INTER_AGENT_QUEUE_SETTINGS) {
    resolved[setting.field] = config[setting.field] ?? setting.defaultValue;
  }
  return resolved;
}

/** The join-time policy tuple, with omitted keys at their defaults. */
export function interAgentQueuePolicy(
  config: Partial<InterAgentQueueSettings>,
): InterAgentQueuePolicy {
  const settings = resolveInterAgentQueueSettings(config);
  return {
    batch_max_items: settings.inter_agent_batch_max_items,
    backlog_max_items: settings.inter_agent_backlog_max_items,
    backlog_max_bytes: settings.inter_agent_backlog_max_bytes,
  };
}

/** A queue refusal is a configuration error, not a crash: exit so the
 *  runner leaves the agent down instead of restarting it into the same
 *  refusal. ServerLink has already logged the server's reason. */
export function exitOnInterAgentQueueRefusal(): never {
  process.exit(WRAPPER_CONFIG_EXIT_CODE);
}
