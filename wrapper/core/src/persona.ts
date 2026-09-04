// Loading and validation of the wrapper init config (protocol.md "identity
// and persona"). Under the server-集約 SoT model (ADR-0029), the wrapper
// no longer loads any personality Markdown; the ready-to-inject prompt is
// delivered by the server over the WS handshake and consumed as-is
// (persona-personality-injection spec, protocol.md「人格プロンプト配送」).

import { readFileSync } from "node:fs";
import type { ModelSource, PermissionMode, WrapperConfig } from "@kaoiro/protocol";

// The protocol package is types-only (no runtime exports), so the closed
// enum's value list is duplicated here. Keep in sync with the PermissionMode
// type in protocol/src/index.ts (#58).
export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
] as const satisfies readonly PermissionMode[];

// Same protocol-types-only duplication rationale as PERMISSION_MODES above,
// for the ModelSource closed enum (#167, issue #160 follow-up: model_source /
// effort_source were declared on WrapperConfig but never copied by
// parseConfig's manual allow-list — the exact drift class this file's
// round-trip test now guards against).
export const MODEL_SOURCES = [
  "launch",
  "env",
  "config",
  "default",
] as const satisfies readonly ModelSource[];

// The `satisfies` above only checks that MODEL_SOURCES' elements are valid
// ModelSource values -- it says nothing about the OTHER direction (藤 review
// #167 S1). Without this, a future ModelSource addition that forgets to
// join MODEL_SOURCES would still typecheck, and parseConfig would then
// wrongly REJECT that legitimate new value as `ConfigError`. `_exhaustive`
// fails to compile (`true` is not assignable to `false`) the moment
// MODEL_SOURCES falls behind the ModelSource union.
type ModelSourcesCoverAllValues = ModelSource extends (typeof MODEL_SOURCES)[number]
  ? true
  : false;
const _exhaustive: ModelSourcesCoverAllValues = true;
void _exhaustive;

/** Upper bound for identity string fields. They are embedded verbatim in every
 *  Envelope and broadcast, so a sane length cap keeps the wire payload bounded. */
const MAX_FIELD_LENGTH = 256;

/** Bounds the allowed_tools list so a malformed config cannot allocate
 *  without limit; far above any real tool count. */
const MAX_ALLOWED_TOOLS = 64;

/** Bounds for codex_extra_models (issue #292) -- same rationale and same
 *  values as runner/src/config.ts's MAX_EXTRA_MODELS / MAX_EFFORT_LEVELS
 *  (independent copies, no shared dependency edge between the runner and
 *  wrapper packages for constants this small; keep the two in sync). */
const MAX_EXTRA_MODELS = 32;
const MAX_EFFORT_LEVELS = 16;

class ConfigError extends Error {
  override name = "ConfigError";
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${field} must be a non-empty string`);
  }
  if (value.length > MAX_FIELD_LENGTH) {
    throw new ConfigError(
      `${field} must be at most ${MAX_FIELD_LENGTH} characters`,
    );
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Charset is restricted so agent_id stays safe in channel topics and URLs
 *  (protocol.md Constraints). */
const AGENT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Validates parsed JSON as a wrapper config. Missing or ill-typed fields throw
 * immediately (fail fast). fs-independent so tests can call it directly.
 */
export function parseConfig(raw: unknown): WrapperConfig {
  if (!isObject(raw)) {
    throw new ConfigError("config must be an object");
  }
  const agent_id = nonEmptyString(raw.agent_id, "agent_id");
  if (!AGENT_ID_PATTERN.test(agent_id)) {
    throw new ConfigError(
      "agent_id must contain only letters, digits, '.', '_' or '-'",
    );
  }

  if (!isObject(raw.persona)) {
    throw new ConfigError("persona must be an object");
  }
  const personaId = nonEmptyString(raw.persona.id, "persona.id");
  // persona.id rides the join params and the sprite URL path; the same
  // charset restriction as agent_id keeps a malformed value out of both
  // (ADR-0029 F3, protocol.md「人格プロンプト配送」).
  if (!AGENT_ID_PATTERN.test(personaId)) {
    throw new ConfigError(
      "persona.id must contain only letters, digits, '.', '_' or '-'",
    );
  }
  const persona: WrapperConfig["persona"] = {
    id: personaId,
    name: nonEmptyString(raw.persona.name, "persona.name"),
    sprite_set: nonEmptyString(raw.persona.sprite_set, "persona.sprite_set"),
  };

  // issue #219 D19/D20: the server has already resolved this at spawn/
  // restore time (custom name, or persona.name's value at that moment) —
  // the wrapper just carries it, never re-derives it from `persona`.
  const display_name = nonEmptyString(raw.display_name, "display_name");

  // server_url is required under the fail-closed server-集約 SoT model
  // (ADR-0029 F3 / F10): the wrapper cannot open its SDK session without
  // the server-pushed personality prompt, so a config without server_url
  // could never spawn.
  const server_url = nonEmptyString(raw.server_url, "server_url");
  if (!server_url.startsWith("ws://") && !server_url.startsWith("wss://")) {
    throw new ConfigError("server_url must start with ws:// or wss://");
  }

  const config: WrapperConfig = { agent_id, persona, display_name, server_url };

  if (raw.server_token !== undefined) {
    config.server_token = nonEmptyString(raw.server_token, "server_token");
  }

  // transition_id is the runner-relayed spawn correlation id (phase-27,
  // #160). A blank or ill-typed value is dropped silently rather than
  // thrown: the server already treats an absent id as legacy_absent, and
  // failing the whole config would break wrapper startup on a legacy
  // runner that never writes the field.
  if (typeof raw.transition_id === "string" && raw.transition_id !== "") {
    config.transition_id = raw.transition_id;
  }

  // permission_timeout_ms precedence (#60): explicit config wins (per-persona
  // override) over the process-wide env var; both absent leaves it undefined,
  // letting the broker fall back to the SDK default (no timeout, ADR-0022 F6).
  if (raw.permission_timeout_ms !== undefined) {
    const timeout = raw.permission_timeout_ms;
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout <= 0) {
      throw new ConfigError("permission_timeout_ms must be a positive integer");
    }
    config.permission_timeout_ms = timeout;
  } else {
    const envValue = process.env.KAOIRO_WRAPPER_PERMISSION_TIMEOUT_MS;
    if (envValue !== undefined && envValue !== "") {
      const parsed = Number(envValue);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new ConfigError(
          "KAOIRO_WRAPPER_PERMISSION_TIMEOUT_MS must be a positive integer",
        );
      }
      config.permission_timeout_ms = parsed;
    }
  }

  // issue #264: a soft work budget is a positive share of the SDK-reported
  // context window. It must not exceed that window: an over-100 setting
  // would name an unreachable denominator as a normal stopping point.
  if (raw.context_work_budget_percent !== undefined) {
    const percent = raw.context_work_budget_percent;
    if (
      typeof percent !== "number" ||
      !Number.isFinite(percent) ||
      percent <= 0 ||
      percent > 100
    ) {
      throw new ConfigError(
        "context_work_budget_percent must be a finite number greater than 0 and at most 100",
      );
    }
    config.context_work_budget_percent = percent;
  }

  if (raw.permission_mode !== undefined) {
    if (
      typeof raw.permission_mode !== "string" ||
      !(PERMISSION_MODES as readonly string[]).includes(raw.permission_mode)
    ) {
      throw new ConfigError(
        `permission_mode must be one of: ${PERMISSION_MODES.join(", ")}`,
      );
    }
    config.permission_mode = raw.permission_mode as PermissionMode;
  }

  if (raw.allowed_tools !== undefined) {
    if (!Array.isArray(raw.allowed_tools)) {
      throw new ConfigError("allowed_tools must be an array of tool names");
    }
    if (raw.allowed_tools.length > MAX_ALLOWED_TOOLS) {
      throw new ConfigError(
        `allowed_tools must have at most ${MAX_ALLOWED_TOOLS} entries`,
      );
    }
    config.allowed_tools = raw.allowed_tools.map((tool, index) =>
      nonEmptyString(tool, `allowed_tools[${index}]`),
    );
  }

  // Launch-time picks relayed from SpawnMessage (ADR-0032 F4bc). Free-form
  // strings: the value set belongs to the engine catalog, not the config
  // layer, so only shape is validated here.
  if (raw.model !== undefined) {
    config.model = nonEmptyString(raw.model, "model");
  }
  if (raw.effort !== undefined) {
    config.effort = nonEmptyString(raw.effort, "effort");
  }
  // Resume-relayed provenance of model/effort (ADR-0014 F1 追補 P1,
  // phase-23). Closed enum, validated the same way as permission_mode.
  if (raw.model_source !== undefined) {
    if (
      typeof raw.model_source !== "string" ||
      !(MODEL_SOURCES as readonly string[]).includes(raw.model_source)
    ) {
      throw new ConfigError(
        `model_source must be one of: ${MODEL_SOURCES.join(", ")}`,
      );
    }
    config.model_source = raw.model_source as ModelSource;
  }
  if (raw.effort_source !== undefined) {
    if (
      typeof raw.effort_source !== "string" ||
      !(MODEL_SOURCES as readonly string[]).includes(raw.effort_source)
    ) {
      throw new ConfigError(
        `effort_source must be one of: ${MODEL_SOURCES.join(", ")}`,
      );
    }
    config.effort_source = raw.effort_source as ModelSource;
  }
  if (
    raw.codex_auth_mode === "chatgpt" ||
    raw.codex_auth_mode === "apikey" ||
    raw.codex_auth_mode === "unknown"
  ) {
    config.codex_auth_mode = raw.codex_auth_mode;
  } else if (raw.codex_auth_mode !== undefined) {
    throw new ConfigError(
      "codex_auth_mode must be one of: chatgpt, apikey, unknown",
    );
  }
  if (
    raw.codex_chatgpt_plan === "free" ||
    raw.codex_chatgpt_plan === "go" ||
    raw.codex_chatgpt_plan === "plus" ||
    raw.codex_chatgpt_plan === "pro" ||
    raw.codex_chatgpt_plan === "business" ||
    raw.codex_chatgpt_plan === "enterprise"
  ) {
    config.codex_chatgpt_plan = raw.codex_chatgpt_plan;
  } else if (raw.codex_chatgpt_plan !== undefined) {
    throw new ConfigError(
      "codex_chatgpt_plan must be one of: free, go, plus, pro, " +
        "business, enterprise",
    );
  }
  if (raw.codex_internal_subagents !== undefined) {
    if (typeof raw.codex_internal_subagents !== "boolean") {
      throw new ConfigError("codex_internal_subagents must be a boolean");
    }
    config.codex_internal_subagents = raw.codex_internal_subagents;
  }
  if (raw.codex_extra_models !== undefined) {
    // issue #292: same defensive shape + per-row validation as
    // claude_engine_catalog below (the runner already validated/defaulted
    // this at parse time, but the wrapper does not blindly trust it either).
    // Unlike claude_engine_catalog, display_name is required here rather
    // than re-defaulted: by the time it reaches the wrapper it should
    // already carry the runner's default substitution, so a missing one
    // signals a malformed upstream rather than a legitimately-omitted field.
    // Routed through nonEmptyString (MAX_FIELD_LENGTH) and MAX_EXTRA_MODELS
    // like every other identity-string / list field in this file: this
    // object rides every state_change broadcast verbatim (host.ts stamps
    // it into ext.models), so it gets the same wire-payload bound as
    // allowed_tools / persona fields, not a looser one.
    if (!Array.isArray(raw.codex_extra_models)) {
      throw new ConfigError("codex_extra_models must be an array");
    }
    if (raw.codex_extra_models.length > MAX_EXTRA_MODELS) {
      throw new ConfigError(
        `codex_extra_models must have at most ${MAX_EXTRA_MODELS} entries`,
      );
    }
    const rows: NonNullable<WrapperConfig["codex_extra_models"]> = [];
    for (let i = 0; i < raw.codex_extra_models.length; i++) {
      const r = raw.codex_extra_models[i];
      if (typeof r !== "object" || r === null) {
        throw new ConfigError(`codex_extra_models[${i}] must be an object`);
      }
      const row = r as Record<string, unknown>;
      const copy: NonNullable<WrapperConfig["codex_extra_models"]>[number] = {
        value: nonEmptyString(row.value, `codex_extra_models[${i}].value`),
        display_name: nonEmptyString(
          row.display_name,
          `codex_extra_models[${i}].display_name`,
        ),
      };
      if (row.description !== undefined) {
        copy.description = nonEmptyString(
          row.description,
          `codex_extra_models[${i}].description`,
        );
      }
      if (row.effort_levels !== undefined) {
        if (!Array.isArray(row.effort_levels)) {
          throw new ConfigError(
            `codex_extra_models[${i}].effort_levels must be an array`,
          );
        }
        if (row.effort_levels.length > MAX_EFFORT_LEVELS) {
          throw new ConfigError(
            `codex_extra_models[${i}].effort_levels must have at most ` +
              `${MAX_EFFORT_LEVELS} entries`,
          );
        }
        copy.effort_levels = row.effort_levels.map((l, j) =>
          nonEmptyString(l, `codex_extra_models[${i}].effort_levels[${j}]`),
        );
      }
      if (row.default_effort !== undefined) {
        copy.default_effort = nonEmptyString(
          row.default_effort,
          `codex_extra_models[${i}].default_effort`,
        );
      }
      rows.push(copy);
    }
    config.codex_extra_models = rows;
  }
  if (raw.claude_engine_catalog !== undefined) {
    // Defensive shape + per-row validation (ADR-0039 F9 v2 = 藤 review
    // turn-7 A condition). Reject arrays or rows that would surface as
    // undefined-populated dropdowns; make a defensive copy so a later
    // mutation upstream cannot bleed into the wrapper's #models.
    if (!Array.isArray(raw.claude_engine_catalog)) {
      throw new ConfigError("claude_engine_catalog must be an array");
    }
    const rows: NonNullable<WrapperConfig["claude_engine_catalog"]> = [];
    for (let i = 0; i < raw.claude_engine_catalog.length; i++) {
      const r = raw.claude_engine_catalog[i];
      if (typeof r !== "object" || r === null) {
        throw new ConfigError(
          `claude_engine_catalog[${i}] must be an object`,
        );
      }
      const row = r as Record<string, unknown>;
      if (typeof row.value !== "string" || row.value === "") {
        throw new ConfigError(
          `claude_engine_catalog[${i}].value must be a non-empty string`,
        );
      }
      if (typeof row.display_name !== "string" || row.display_name === "") {
        throw new ConfigError(
          `claude_engine_catalog[${i}].display_name must be a non-empty string`,
        );
      }
      const copy: NonNullable<WrapperConfig["claude_engine_catalog"]>[number] =
        {
          value: row.value,
          display_name: row.display_name,
          description: typeof row.description === "string" ? row.description : "",
        };
      // Optional fields: absent → skip; present but malformed → loud
      // ConfigError so a bad supplier upstream cannot silently downgrade a
      // rich catalog to a strings-missing one (藤 review turn-10 補足).
      if (row.effort_levels !== undefined) {
        if (
          !Array.isArray(row.effort_levels) ||
          !row.effort_levels.every(
            (l): l is string => typeof l === "string" && l !== "",
          )
        ) {
          throw new ConfigError(
            `claude_engine_catalog[${i}].effort_levels must be an array of non-empty strings`,
          );
        }
        copy.effort_levels = [...row.effort_levels];
      }
      if (row.default_effort !== undefined) {
        if (
          typeof row.default_effort !== "string" ||
          row.default_effort === ""
        ) {
          throw new ConfigError(
            `claude_engine_catalog[${i}].default_effort must be a non-empty string`,
          );
        }
        copy.default_effort = row.default_effort;
      }
      rows.push(copy);
    }
    config.claude_engine_catalog = rows;
  }

  // Codex / Antigravity launch permission (ADR-0033 F3, ADR-0057 F4c); the
  // Claude engine ignores all three. The sandbox and approval axes are
  // closed enums.
  if (raw.sandbox !== undefined) {
    if (
      raw.sandbox !== "read-only" &&
      raw.sandbox !== "workspace-write" &&
      raw.sandbox !== "danger-full-access"
    ) {
      throw new ConfigError(
        "sandbox must be one of: read-only, workspace-write, danger-full-access",
      );
    }
    config.sandbox = raw.sandbox;
  }
  if (raw.network_access !== undefined) {
    if (typeof raw.network_access !== "boolean") {
      throw new ConfigError("network_access must be a boolean");
    }
    config.network_access = raw.network_access;
  }
  // Antigravity-only launch approval axis (ADR-0057 F4c). "on-failure" is
  // deliberately excluded: this engine rejects it at spawn.
  if (raw.approval !== undefined) {
    if (
      raw.approval !== "untrusted" &&
      raw.approval !== "on-request" &&
      raw.approval !== "never"
    ) {
      throw new ConfigError(
        "approval must be one of: untrusted, on-request, never",
      );
    }
    config.approval = raw.approval;
  }

  // Resume snapshot (ADR-0014 F1 追補, phase-15 D8): passed through by the
  // runner on resume launches only. Loose shape check — the fields are all
  // optional and free-form strings/booleans; deeper validation is not worth
  // the maintenance since ext consumers already tolerate absent fields.
  if (raw.resume_snapshot !== undefined) {
    if (!isObject(raw.resume_snapshot)) {
      throw new ConfigError("resume_snapshot must be an object");
    }
    config.resume_snapshot = raw.resume_snapshot as NonNullable<
      WrapperConfig["resume_snapshot"]
    >;
  }

  return config;
}

/**
 * Reads and validates a config file (JSON).
 *
 * The path is read as-is; callers must supply a trusted, statically-known path
 * (e.g. an operator-provided config location), not untrusted external input.
 */
export function loadConfig(path: string): WrapperConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw new ConfigError(`cannot read config file: ${path}`, { cause });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new ConfigError(`config file is not valid JSON: ${path}`, { cause });
  }

  return parseConfig(raw);
}

export { ConfigError };
