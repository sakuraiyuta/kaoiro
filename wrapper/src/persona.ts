// Loading and validation of the wrapper init config (protocol.md "identity and
// persona"). agent_id is a stable id; volatile runtime-generated ids are not
// used.

import { readFileSync } from "node:fs";
import type { WrapperConfig } from "./types.js";

/** Upper bound for identity string fields. They are embedded verbatim in every
 *  Envelope and broadcast, so a sane length cap keeps the wire payload bounded. */
const MAX_FIELD_LENGTH = 256;

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

/**
 * Validates parsed JSON as a wrapper config. Missing or ill-typed fields throw
 * immediately (fail fast). fs-independent so tests can call it directly.
 */
export function parseConfig(raw: unknown): WrapperConfig {
  if (!isObject(raw)) {
    throw new ConfigError("config must be an object");
  }
  const agent_id = nonEmptyString(raw.agent_id, "agent_id");

  if (!isObject(raw.persona)) {
    throw new ConfigError("persona must be an object");
  }
  const persona = {
    id: nonEmptyString(raw.persona.id, "persona.id"),
    name: nonEmptyString(raw.persona.name, "persona.name"),
    sprite_set: nonEmptyString(raw.persona.sprite_set, "persona.sprite_set"),
  };

  return { agent_id, persona };
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
