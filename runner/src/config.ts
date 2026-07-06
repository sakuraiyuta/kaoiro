// Loading and validation of the runner config (ADR-0023, ADR-0031). The
// runner reads this once on start to know its host_id, where to connect,
// its persona trust policy against the server catalog, and its cwd allow-
// list (#22). The auth token is NOT in this file (security): it comes from
// the env (KAOIRO_RUNNER_TOKEN).

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

/** Runner config (file shape). Persona trust is expressed by exactly one of
 *  `allowed_personas` (allowlist by id) or `blocked_personas` (blocklist
 *  by id), or none for accept-all — see [[ADR-0031]]. Legacy `personas`
 *  (full objects) is accepted for one release cycle as an allowlist by id
 *  with a deprecation warning; mixing legacy and new fields is rejected. */
export interface RunnerConfig {
  host_id: string;
  server_url: string;
  personas?: Persona[];
  allowed_personas?: string[];
  blocked_personas?: string[];
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

  const cwd_allowlist = parseStringList(
    raw.cwd_allowlist,
    "cwd_allowlist",
    MAX_CWDS,
  );
  if (cwd_allowlist.length === 0) {
    throw new ConfigError("cwd_allowlist must have at least one entry");
  }

  const config: RunnerConfig = { host_id, server_url, cwd_allowlist };

  const hasLegacy = raw.personas !== undefined;
  const hasAllow = raw.allowed_personas !== undefined;
  const hasBlock = raw.blocked_personas !== undefined;

  if (hasAllow && hasBlock) {
    throw new ConfigError(
      "allowed_personas and blocked_personas are mutually exclusive",
    );
  }
  if ((hasAllow || hasBlock) && hasLegacy) {
    throw new ConfigError(
      "legacy `personas` cannot be combined with allowed_personas / blocked_personas",
    );
  }

  if (hasLegacy) {
    // Legacy allowlist by full persona object; used only for its ids since
    // the server SoT (ADR-0029) owns display metadata. Warn once so
    // operators can migrate to `allowed_personas`.
    process.stderr.write(
      "runner: warn — `personas` in runner.config.json is deprecated (ADR-0031); " +
        "use `allowed_personas` (allowlist by id) or `blocked_personas` " +
        "(blocklist by id). Legacy `personas` will be removed in the next major.\n",
    );
    config.personas = parsePersonaList(raw.personas);
  } else if (hasAllow) {
    config.allowed_personas = parseStringList(
      raw.allowed_personas,
      "allowed_personas",
      MAX_PERSONAS,
    );
  } else if (hasBlock) {
    config.blocked_personas = parseStringList(
      raw.blocked_personas,
      "blocked_personas",
      MAX_PERSONAS,
    );
  }

  if (raw.capabilities !== undefined) {
    config.capabilities = parseStringList(
      raw.capabilities,
      "capabilities",
      MAX_CAPABILITIES,
    );
  }

  return config;
}

function parsePersonaList(value: unknown): Persona[] {
  if (!Array.isArray(value)) {
    throw new ConfigError("personas must be an array");
  }
  if (value.length > MAX_PERSONAS) {
    throw new ConfigError(`personas must have at most ${MAX_PERSONAS} entries`);
  }
  if (value.length === 0) {
    throw new ConfigError("personas must have at least one entry");
  }
  return value.map(parsePersona);
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

/** Builds the `register` message (sent once per connection) from the config.
 *  Persona trust is expressed by the same field shape the file used
 *  (ADR-0031: allowlist / blocklist / accept-all), so the server can gate
 *  spawn without a separate mode enum on the wire. */
export function buildRegister(config: RunnerConfig): RunnerRegister {
  return {
    version: "0",
    host_id: config.host_id,
    cwd_allowlist: config.cwd_allowlist,
    ...(config.personas === undefined ? {} : { personas: config.personas }),
    ...(config.allowed_personas === undefined
      ? {}
      : { allowed_personas: config.allowed_personas }),
    ...(config.blocked_personas === undefined
      ? {}
      : { blocked_personas: config.blocked_personas }),
    ...(config.capabilities === undefined
      ? {}
      : { capabilities: config.capabilities }),
  };
}

/** Builds a `heartbeat` liveness message for the given host. */
export function buildHeartbeat(hostId: string): RunnerHeartbeat {
  return { version: "0", host_id: hostId };
}

/**
 * Derives the wrapper socket URL from the runner's own server_url. Under案A
 * (ADR-0024) the server allocates agent_id and mints the per-agent token but
 * does not send server_url; the runner supplies it, since it already knows how
 * to reach the server. The wrapper socket shares the server origin on the
 * `/wrapper` mount (the runner uses `/runner`), so we keep the origin and swap
 * the path.
 */
export function wrapperUrlFrom(serverUrl: string): string {
  const url = new URL(serverUrl);
  return `${url.protocol}//${url.host}/wrapper`;
}

export { ConfigError };
