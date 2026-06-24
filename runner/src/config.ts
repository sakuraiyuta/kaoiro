// Loading and validation of the runner config (ADR-0023). The runner reads
// this once on start to know its host_id, where to connect, and what it may
// launch (spawnable personas + selectable cwd allow-list, #22). The auth token
// is NOT in this file (security): it comes from the env (KAOIRO_RUNNER_TOKEN).

import { readFileSync } from "node:fs";
import type {
  Persona,
  RunnerHeartbeat,
  RunnerRegister,
} from "@kaoiro/protocol";

/** Upper bound for identity string fields, matching the wrapper's config. */
const MAX_FIELD_LENGTH = 256;

/** List bounds so a malformed config cannot allocate without limit; far above
 *  any real host's persona / cwd / engine counts. */
const MAX_PERSONAS = 64;
const MAX_CWDS = 64;
const MAX_CAPABILITIES = 16;

/** host_id rides the channel topic `runner:<host_id>`, so its charset is
 *  restricted exactly like agent_id (the server enforces the same guard). */
const HOST_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

class ConfigError extends Error {
  override name = "ConfigError";
}

/** Runner config (file shape). personas/cwd_allowlist are declared to the
 *  server via `register`; capabilities lists engine kinds (e.g. ["claude"]). */
export interface RunnerConfig {
  host_id: string;
  server_url: string;
  personas: Persona[];
  cwd_allowlist: string[];
  capabilities?: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function parsePersona(value: unknown, index: number): Persona {
  if (!isObject(value)) {
    throw new ConfigError(`personas[${index}] must be an object`);
  }
  return {
    id: nonEmptyString(value.id, `personas[${index}].id`),
    name: nonEmptyString(value.name, `personas[${index}].name`),
    sprite_set: nonEmptyString(value.sprite_set, `personas[${index}].sprite_set`),
  };
}

function parseStringList(
  value: unknown,
  field: string,
  max: number,
): string[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(`${field} must be an array`);
  }
  if (value.length > max) {
    throw new ConfigError(`${field} must have at most ${max} entries`);
  }
  return value.map((entry, index) => nonEmptyString(entry, `${field}[${index}]`));
}

/**
 * Validates parsed JSON as a runner config. Missing or ill-typed fields throw
 * immediately (fail fast). fs-independent so tests can call it directly.
 */
export function parseRunnerConfig(raw: unknown): RunnerConfig {
  if (!isObject(raw)) {
    throw new ConfigError("config must be an object");
  }

  const host_id = nonEmptyString(raw.host_id, "host_id");
  if (!HOST_ID_PATTERN.test(host_id)) {
    throw new ConfigError(
      "host_id must contain only letters, digits, '.', '_' or '-'",
    );
  }

  const server_url = nonEmptyString(raw.server_url, "server_url");
  if (!server_url.startsWith("ws://") && !server_url.startsWith("wss://")) {
    throw new ConfigError("server_url must start with ws:// or wss://");
  }

  if (!Array.isArray(raw.personas)) {
    throw new ConfigError("personas must be an array");
  }
  if (raw.personas.length > MAX_PERSONAS) {
    throw new ConfigError(`personas must have at most ${MAX_PERSONAS} entries`);
  }
  // A runner exists to spawn agents, so it must declare at least one
  // spawnable persona and one cwd; an empty list is a misconfiguration the
  // server would accept silently, so fail fast here. capabilities stays
  // optional (it only annotates engine kinds).
  if (raw.personas.length === 0) {
    throw new ConfigError("personas must have at least one entry");
  }
  const personas = raw.personas.map(parsePersona);

  const cwd_allowlist = parseStringList(
    raw.cwd_allowlist,
    "cwd_allowlist",
    MAX_CWDS,
  );
  if (cwd_allowlist.length === 0) {
    throw new ConfigError("cwd_allowlist must have at least one entry");
  }

  const config: RunnerConfig = { host_id, server_url, personas, cwd_allowlist };

  if (raw.capabilities !== undefined) {
    config.capabilities = parseStringList(
      raw.capabilities,
      "capabilities",
      MAX_CAPABILITIES,
    );
  }

  return config;
}

/**
 * Reads and validates a runner config file (JSON).
 *
 * The path is read as-is; callers must supply a trusted, statically-known path
 * (an operator-provided config location), not untrusted external input.
 */
export function loadRunnerConfig(path: string): RunnerConfig {
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

  return parseRunnerConfig(raw);
}

/** Builds the `register` message (sent once per connection) from the config. */
export function buildRegister(config: RunnerConfig): RunnerRegister {
  return {
    version: "0",
    host_id: config.host_id,
    personas: config.personas,
    cwd_allowlist: config.cwd_allowlist,
    ...(config.capabilities === undefined
      ? {}
      : { capabilities: config.capabilities }),
  };
}

/** Builds a `heartbeat` liveness message for the given host. */
export function buildHeartbeat(hostId: string): RunnerHeartbeat {
  return { version: "0", host_id: hostId };
}

export { ConfigError };
