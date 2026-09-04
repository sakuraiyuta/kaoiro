// Loading and validation of the runner config (ADR-0023, ADR-0031). The
// runner reads this once on start to know its host_id, where to connect,
// its persona trust policy against the server catalog, and its cwd allow-
// list (#22). The auth token is NOT in this file (security): it comes from
// the env (KAOIRO_RUNNER_TOKEN).

import { readFileSync } from "node:fs";
import { resolveCodexCatalog } from "@kaoiro/codex";
import { claudeBootstrapCatalog } from "@kaoiro/claude-code/catalog";
import { antigravityCatalogSnapshot } from "@kaoiro/antigravity";
import type { CodexAuthMode } from "./codex-auth.js";
import { isBuildInfoConsistent, type BuildInfo } from "./build_info.js";
import type {
  EngineCatalogEntry,
  EngineKind,
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
  /** Soft work-budget denominator as a percentage of every active model's
   * SDK-reported context window (issue #264). Omitted lets the wrapper apply
   * its 60% default. */
  context_work_budget_percent?: number;
  capabilities?: string[];
  codex?: CodexConfig;
}

export type ChatGptPlan =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "business"
  | "enterprise";

export interface CodexConfig {
  /** Explicit auth mode declaration for the Codex adapter's catalog resolve
   *  (Phase-24, dogfood 環境依存の catalog 空回帰対策)。closed-enum:
   *  `"chatgpt"` or `"apikey"`。Priority explicit > doctor detection >
   *  `"unknown"`: 明示宣言があれば `detectCodexAuthMode` (codex CLI の
   *  `doctor` サブコマンド依存) をスキップし、runner 環境の PATH に codex
   *  binary が無くても catalog を正しく解決する。auth_mode は catalog
   *  selection 用の宣言 metadata のみで、runner は credential (OAuth token
   *  / API key 等、Codex 側の credential store / environment) を付与も変更
   *  もしない — その意味で escalation にならない。誤宣言時は catalog が
   *  実 entitlement からずれ、unsupported な model / effort の explicit
   *  request が SDK 側で loud fail → 既存 switch_error rollback に到達し
   *  うる。auth 実体の invalid credentials エラーになるかどうかは runtime
   *  の credential store / SDK 実装依存で、config だけからは断定しない。
   *  `chatgpt_plan` からの暗黙推定は禁止 (API-key auth で plan が設定されて
   *  いる config を誤判定するため)。旧 config 互換: 未指定なら現行の doctor
   *  detection にフォールバック、失敗時は "unknown"。 */
  auth_mode?: "chatgpt" | "apikey";
  chatgpt_plan?: ChatGptPlan;
  /** Toggle for Codex's internal sub-agent spawning (ADR-0038 F2). Effective
   *  = configured ?? true; the host ALWAYS injects features.multi_agent = the
   *  effective value, so this runner option outranks any user-global Codex
   *  config. true force-enables, false disables, absent = default true. */
  internal_subagents?: boolean;
}

const CHATGPT_PLANS = new Set<ChatGptPlan>([
  "free",
  "go",
  "plus",
  "pro",
  "business",
  "enterprise",
]);

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

  if (raw.codex !== undefined) {
    if (!isObject(raw.codex)) {
      throw new ConfigError("codex must be an object");
    }
    const codex: CodexConfig = {};
    if (raw.codex.auth_mode !== undefined) {
      if (
        raw.codex.auth_mode !== "chatgpt" &&
        raw.codex.auth_mode !== "apikey"
      ) {
        throw new ConfigError(
          "codex.auth_mode must be one of: chatgpt, apikey",
        );
      }
      codex.auth_mode = raw.codex.auth_mode;
    }
    if (raw.codex.chatgpt_plan !== undefined) {
      if (
        typeof raw.codex.chatgpt_plan !== "string" ||
        !CHATGPT_PLANS.has(raw.codex.chatgpt_plan as ChatGptPlan)
      ) {
        throw new ConfigError(
          "codex.chatgpt_plan must be one of: free, go, plus, pro, " +
            "business, enterprise",
        );
      }
      codex.chatgpt_plan = raw.codex.chatgpt_plan as ChatGptPlan;
    }
    if (raw.codex.internal_subagents !== undefined) {
      if (typeof raw.codex.internal_subagents !== "boolean") {
        throw new ConfigError("codex.internal_subagents must be a boolean");
      }
      codex.internal_subagents = raw.codex.internal_subagents;
    }
    config.codex = codex;
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

/** Engines this runner build bundles (ADR-0032 F4a, ADR-0057 F1); the
 *  default capabilities when the config file does not restrict them. */
const BUNDLED_ENGINES: EngineKind[] = ["claude-code", "codex", "antigravity"];

/** Effective capabilities: the configured list (legacy "claude" normalized
 *  to "claude-code" with a warning — the server keeps the same one-release
 *  window, ADR-0032 F4a) or the bundled default. */
export function effectiveCapabilities(config: RunnerConfig): string[] {
  if (config.capabilities === undefined) return [...BUNDLED_ENGINES];
  return config.capabilities.map((value) => {
    if (value === "claude") {
      process.stderr.write(
        'runner: capabilities value "claude" is deprecated; use "claude-code"\n',
      );
      return "claude-code";
    }
    return value;
  });
}

/** Builds the `register` message (sent once per connection) from the config.
 *  Persona trust is expressed by the same field shape the file used
 *  (ADR-0031: allowlist / blocklist / accept-all), so the server can gate
 *  spawn without a separate mode enum on the wire. `engines` carries the
 *  launch catalog per capability (ADR-0032 F4bc). Claude advertises a
 *  versioned optimistic bootstrap snapshot which the SDK's account-aware
 *  ext.models replaces after init (#110); Codex resolves its curated list
 *  from the detected auth mode and operator-declared ChatGPT plan
 *  (ADR-0035); Antigravity's `antigravityCatalogOverride` is the caller's
 *  `resolveAntigravityCatalog()` result (ADR-0057 F6) — absent falls back
 *  to the pinned 1.1.26 snapshot, matching how a probe failure inside that
 *  resolver already degrades. */
export function buildRegister(
  config: RunnerConfig,
  codexAuthMode: CodexAuthMode = "unknown",
  claudeCatalogOverride?: EngineCatalogEntry["models"],
  buildInfo?: BuildInfo,
  antigravityCatalogOverride?: EngineCatalogEntry["models"],
): RunnerRegister {
  const capabilities = effectiveCapabilities(config);
  const engines: EngineCatalogEntry[] = [];
  if (capabilities.includes("claude-code")) {
    // Option E, ADR-0039: when the runner has a fresh live-probe catalog in
    // its memory cache it overrides the pre-init bootstrap floor. Absent =
    // the ADR-0037 F1 minimum default entry.
    engines.push({
      id: "claude-code",
      models: claudeCatalogOverride ?? claudeBootstrapCatalog(),
    });
  }
  if (capabilities.includes("codex")) {
    engines.push({
      id: "codex",
      models: resolveCodexCatalog(
        codexAuthMode,
        config.codex?.chatgpt_plan,
      ),
      // ADR-0033 F3: Codex exposes a launch-fixed sandbox axis (+ its
      // network_access toggle) but not approval (upstream-fixed to
      // "never", round 2 SF-R2-4).
      launch_permission_axes: { sandbox: true, approval: false },
    });
  }
  if (capabilities.includes("antigravity")) {
    // ADR-0057 F6: the caller runs `agy models` (resolveAntigravityCatalog,
    // antigravity-catalog.ts) before calling buildRegister and passes the
    // result here — this function stays synchronous like the Codex branch
    // above. Absent override (caller never probed, e.g. a config predating
    // this field) falls back to the static snapshot rather than an empty
    // catalog.
    engines.push({
      id: "antigravity",
      // ADR-0057 F4c: Antigravity exposes both the sandbox axis and the
      // approval axis (round 2 SF-R2-4).
      launch_permission_axes: { sandbox: true, approval: true },
      models: antigravityCatalogOverride ?? antigravityCatalogSnapshot(),
    });
  }
  const safeBuildInfo =
    buildInfo !== undefined && !isBuildInfoConsistent(buildInfo)
      ? {
          revision: "unknown",
          dirty: false,
          built_at: "unknown",
          version: "unknown",
          channel: "dev" as const,
        }
      : buildInfo;
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
    capabilities,
    engines,
    ...(safeBuildInfo === undefined
      ? {}
      : {
          build_revision: safeBuildInfo.revision,
          build_dirty: safeBuildInfo.dirty,
          ...(safeBuildInfo.version === undefined || safeBuildInfo.channel === undefined
            ? {}
            : {
                build_version: safeBuildInfo.version,
                build_channel: safeBuildInfo.channel,
              }),
        }),
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

/** env override name for `server_url` (issue #140). */
export const SERVER_URL_ENV = "KAOIRO_RUNNER_SERVER_URL";

/** Set to `1` to include Phoenix's periodic heartbeat wire logs. They are
 *  suppressed by default because the steady-state push/reply pair obscures
 *  operational messages in runner.log. */
export const PHOENIX_HEARTBEAT_LOGS_ENV =
  "KAOIRO_RUNNER_LOG_PHOENIX_HEARTBEATS";

/** Whether the runner should retain the normally-suppressed periodic Phoenix
 *  heartbeat push/reply wire logs. Kept as an explicit `1` opt-in so a typo
 *  cannot unexpectedly make a production control-plane log noisy. */
export function isPhoenixHeartbeatLoggingEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[PHOENIX_HEARTBEAT_LOGS_ENV] === "1";
}

/**
 * Applies the `KAOIRO_RUNNER_SERVER_URL` env override to a loaded config's
 * `server_url` (issue #140): distribution/service deployments (systemd/
 * launchd units, #141) inject the connection target via env rather than
 * editing the gitignored `runner.config.json`. Precedence: env > config
 * file — unset/empty env leaves the config untouched. Re-validates the
 * same `ws://`/`wss://` shape `parseRunnerConfig` enforces on the file
 * value, so a malformed env fails fast at startup/reload instead of
 * reaching `RunnerLink`. Called on both initial load and every config-
 * watcher reload (cli.ts) so the override consistently outranks the file
 * across hot-reloads too.
 */
export function applyServerUrlOverride(config: RunnerConfig): RunnerConfig {
  const override = process.env[SERVER_URL_ENV];
  if (override === undefined || override === "") return config;
  if (!override.startsWith("ws://") && !override.startsWith("wss://")) {
    throw new ConfigError(`${SERVER_URL_ENV} must start with ws:// or wss://`);
  }
  return { ...config, server_url: override };
}

export { ConfigError };
