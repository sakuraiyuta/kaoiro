// Loading and validation of the wrapper init config (protocol.md "identity and
// persona"). agent_id is a stable id; volatile runtime-generated ids are not
// used.

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PermissionMode, WrapperConfig } from "./types.js";

/** Common footer appended after every persona's personality prompt.
 *  Provisional hard-code per persona-common-footer open-question
 *  (暫定方針 B). Structured composition is deferred to phase-1. */
const COMMON_FOOTER =
  "このエージェントは kaoiro クライアント越しに操作されています。";

/** Wrapper package root (directory containing `package.json`). Used as the
 *  base for default personality file resolution (`<root>/personas/<id>.md`).
 *  Compiled `dist/persona.js` and dev-mode `src/persona.ts` both sit one
 *  level under the package root, so `..` finds it from either entry. */
const WRAPPER_PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

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

/** Upper bound for identity string fields. They are embedded verbatim in every
 *  Envelope and broadcast, so a sane length cap keeps the wire payload bounded. */
const MAX_FIELD_LENGTH = 256;

/** Bounds the allowed_tools list so a malformed config cannot allocate
 *  without limit; far above any real tool count. */
const MAX_ALLOWED_TOOLS = 64;

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
  // persona.id is used as a filesystem path segment when resolving the
  // default personality file (`<wrapper-root>/personas/<id>.md`), so the
  // same charset restriction as agent_id keeps a malicious server-pushed
  // spawn from steering resolvePersonaAppend outside the personas/ tree
  // (persona-personality-injection MUST NOT / ADR-0026).
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
  if (raw.persona.personality_prompt_file !== undefined) {
    persona.personality_prompt_file = nonEmptyString(
      raw.persona.personality_prompt_file,
      "persona.personality_prompt_file",
    );
  }
  if (raw.persona.language !== undefined) {
    persona.language = nonEmptyString(raw.persona.language, "persona.language");
  }

  const config: WrapperConfig = { agent_id, persona };

  if (raw.server_url !== undefined) {
    const server_url = nonEmptyString(raw.server_url, "server_url");
    if (!server_url.startsWith("ws://") && !server_url.startsWith("wss://")) {
      throw new ConfigError("server_url must start with ws:// or wss://");
    }
    config.server_url = server_url;
  }

  if (raw.server_token !== undefined) {
    config.server_token = nonEmptyString(raw.server_token, "server_token");
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

/**
 * Resolves the personality Markdown file for a config and composes the
 * append string for the SDK systemPrompt (persona-personality-injection
 * spec / ADR-0026). The return value is the ready-to-append text: a
 * personality body (when a file was resolved) followed by
 * {@link COMMON_FOOTER} — the footer is always present.
 *
 * Resolution rules:
 * - explicit `persona.personality_prompt_file`: resolved from the config
 *   file's directory (or as-is if absolute). Missing = ConfigError
 *   (fail-fast, the user explicitly requested this file).
 * - unset: `<wrapper package root>/personas/<persona.id>.md`. Missing =
 *   OK (footer only). This lets the `default` persona and any not-yet-
 *   packaged persona.id boot without a file.
 *
 * @param configPath  Path to the loaded config file. Used to resolve the
 *   custom `personality_prompt_file` relatively. Pass an absolute path in
 *   production; tests may pass any path since the resolution never falls
 *   back to CWD.
 */
export function resolvePersonaAppend(
  config: WrapperConfig,
  configPath: string,
  options: { packageRoot?: string } = {},
): string {
  const packageRoot = options.packageRoot ?? WRAPPER_PACKAGE_ROOT;
  const custom = config.persona.personality_prompt_file;

  let personality = "";
  if (custom !== undefined) {
    const resolved = isAbsolute(custom)
      ? custom
      : resolve(dirname(configPath), custom);
    try {
      personality = readFileSync(resolved, "utf8").trim();
    } catch (cause) {
      throw new ConfigError(
        `cannot read persona.personality_prompt_file: ${resolved}`,
        { cause },
      );
    }
  } else {
    const bundled = resolve(packageRoot, "personas", `${config.persona.id}.md`);
    if (existsSync(bundled)) {
      personality = readFileSync(bundled, "utf8").trim();
    }
  }

  return personality.length > 0
    ? `${personality}\n\n${COMMON_FOOTER}`
    : COMMON_FOOTER;
}

export { COMMON_FOOTER, ConfigError };
