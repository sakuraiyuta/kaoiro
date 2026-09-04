// Process supervisor (ADR-0023, phases 4-4b/4-5). Owns the host's wrapper child
// processes: spawns a wrapper per `spawn`, restarts a crashed one (isolated
// from siblings), stops/restarts on operator command, enumerates resume
// candidates, and resumes a session — gated by the T3 existence check and the
// F4 same-session local lock. The child launch is injected so the supervision
// logic is testable without real processes (default launcher: spawn.ts).

import type {
  EngineKind,
  ModelSource,
  PermissionAxesExt,
  PermissionMode,
  ResolvedSnapshotExt,
  RunnerSessions,
  SessionMeta,
  SessionResetErrorReason,
  SessionResetMode,
  SessionResetResult,
  SpawnFailReason,
  SpawnResult,
  WirePersona,
  WrapperConfig,
} from "@kaoiro/protocol";
import type { CodexAuthMode } from "./codex-auth.js";
import type { ChatGptPlan } from "./config.js";
import {
  applyResumeSnapshot,
  validateResolvedSnapshot,
} from "./resume_snapshot.js";
import {
  listSessions as defaultListSessions,
  sessionExists as defaultSessionExists,
} from "./sessions.js";

/** Cap on automatic restarts after crashes within RESTART_WINDOW_MS, per agent.
 *  A wrapper that keeps crashing in a tight loop is left down rather than
 *  hot-looped; an explicit `restart`, or a quiet spell longer than the window,
 *  resets the count so occasional crashes over a long uptime do not exhaust it. */
export const MAX_RESTARTS = 5;

/** Rolling window for the crash budget (ms): a crash arriving more than this
 *  after the window started resets the count, so the cap catches a tight
 *  crash-loop but not a few crashes spread across a long-running agent (#73). */
export const RESTART_WINDOW_MS = 60_000;

/** A reset must not wait forever for the wrapper it is replacing. Give the
 *  wrapper one normal-termination grace period before escalating to SIGKILL;
 *  a second missed exit is reported as a reset failure rather than silently
 *  leaving the old process and a pending server lock behind (#258). */
export const RESET_TERMINATION_GRACE_MS = 5_000;

/** agent_id rides a temp config filename and the spawn_result, so its charset
 *  is restricted exactly like the server's AgentId guard (no path separators). */
const AGENT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** The minimal child handle the supervisor needs; ChildProcess satisfies it. */
export interface ManagedChild {
  on(event: "exit", listener: () => void): void;
  /** Mirrors ChildProcess.kill: false means there was no live child to
   *  signal. The supervisor uses that outcome instead of waiting forever for
   *  an exit event that will never arrive. */
  kill(signal?: NodeJS.Signals): boolean;
}

/** Launches one wrapper child. resumeSessionId, when set, continues an existing
 *  SDK session (the launcher passes it to the wrapper as `--resume`).
 *  initialPrompt, when set, is the wrapper's first turn (passed as the positional
 *  prompt arg). */
export type LaunchFn = (
  agentId: string,
  config: WrapperConfig,
  cwd: string,
  resumeSessionId?: string,
  initialPrompt?: string,
  engine?: EngineKind,
) => ManagedChild;

type MaybePromise<T> = T | Promise<T>;

/** The validated fields of a `spawn` message the supervisor acts on. serverUrl
 *  is optional: under案A the server omits it and the runner falls back to its
 *  own wrapper URL (ADR-0024). engine defaults to "claude-code" so old
 *  servers keep working (ADR-0032 F4a). */
export interface ParsedSpawn {
  persona: WirePersona;
  /** Initial `display_name` from the spawn message (issue #219 MF-1).
   *  Absent = legacy server that predates this field; `resolveWrapperConfig`
   *  falls back to `persona.name` as the one-time migration so
   *  `WrapperConfig.display_name` (required) always gets a value. */
  displayName?: string;
  cwd: string;
  engine: EngineKind;
  serverUrl?: string;
  token?: string;
  initialPrompt?: string;
  resumeSessionId?: string;
  model?: string;
  effort?: string;
  /** Source stamped alongside `model` when it originated from a resume
   *  snapshot (ADR-0014 F1 追補 P1 pair-aware apply, phase-23). Populated
   *  only by `applyResumeSnapshot` under the 5-case pair rule; fresh spawn
   *  leaves this undefined and the wrapper CLI derives the source from
   *  config.model / env as before. */
  modelSource?: ModelSource;
  /** Source stamped alongside `effort`; same semantics as `modelSource`. */
  effortSource?: ModelSource;
  /** Claude-only launch permission mode (ADR-0033 F4 追補, phase-15 D2 /
   *  task 15-12). Relayed from SpawnMessage.permission_mode; Codex ignores
   *  it. Closed-enum validation runs at parseSpawn's whitelist. */
  permissionMode?: PermissionMode;
  sandbox?: WrapperConfig["sandbox"];
  networkAccess?: boolean;
  /** Antigravity-only launch approval axis (ADR-0057 F4c). Claude / Codex
   *  ignore it. Closed-enum validation runs at parseSpawn's whitelist and
   *  at `applyResumeSnapshot` / the resume-snapshot sanitizer — both
   *  reject "on-failure" even though the shared
   *  `PermissionAxesExt["approval"]` type admits it. */
  approval?: PermissionAxesExt["approval"];
  /** Resume snapshot: relayed by the server on a resume spawn only
   *  (ADR-0014 F1 追補, phase-15 D8). Passed through to the wrapper via
   *  config.resume_snapshot so the wrapper can stamp ext.resume_snapshot
   *  / ext.resume_drift on its first state_change. */
  resumeSnapshot?: ResolvedSnapshotExt;
  /** Session-transition correlation id from the command that launched (or
   *  relaunched) this wrapper — spawn, switch_session, or reset_session
   *  (phase-27, #160). Rides into the wrapper as `config.transition_id`
   *  and is echoed back on `spawn_result`. Switch and reset overwrite it
   *  on `entry.parsed` so the relaunch carries the id of the transition
   *  that caused it, not the original spawn's. Absent = legacy server. */
  requestId?: string;
  /** Fresh-restore flag (phase-25, ADR-0030 D8 / ADR-0014 F1 追補).
   *  Set to `true` when the server wants a fresh spawn (no
   *  `resume_session_id`) that nevertheless re-applies `resumeSnapshot`
   *  as if it were a resume — used to revive a `/clear`-detached or
   *  未発話 offline agent under the same model / effort / permission /
   *  sandbox / network the pointer's snapshot last stamped. Absent =
   *  the ordinary fresh-spawn no-apply semantics (藤 D1). */
  applyResumeSnapshot?: boolean;
}

export interface SupervisorOptions {
  hostId: string;
  cwdAllowlist: string[];
  launch: LaunchFn;
  /** Fallback wrapper socket URL used when a spawn omits server_url (案A,
   *  ADR-0024). Derived from the runner's own server_url (config.wrapperUrlFrom).
   *  Required under ADR-0029: the wrapper's server_url is mandatory, so a
   *  spawn without an explicit value must still get one. */
  wrapperServerUrl: string;
  codexAuthMode?: CodexAuthMode;
  codexChatgptPlan?: ChatGptPlan;
  codexInternalSubagents?: boolean;
  /** Global soft context-work budget from runner.config.json. The wrapper
   * derives a per-model token denominator at measurement time (issue #264). */
  contextWorkBudgetPercent?: number;
  /** ADR-0039 F9 追補: reads the current Claude engine-catalog from the
   *  runner's live probe cache so every spawn/restart/relaunch relays the
   *  latest known models to the wrapper's initial #models. Getter (not a
   *  cached value) so a probe that finishes between spawns reaches the
   *  next child, and a null return (cold start / probe never ran) falls
   *  back to the bootstrap floor server-side. */
  getClaudeEngineCatalog?: () =>
    | WrapperConfig["claude_engine_catalog"]
    | null
    | undefined;
  sendResult: (result: SpawnResult) => void;
  sendSessions: (sessions: RunnerSessions) => void;
  /** phase-17 17-5: report a session-reset outcome (ADR-0036 F7). Required
   *  now the supervisor can handle a `reset_session` command; the CLI
   *  wires this to `RunnerLink.sendResetResult`. */
  sendResetResult: (result: SessionResetResult) => void;
  /** Injectable for tests; defaults read the local session stores
   *  (sessions.ts — Claude JSONLs / codex rollouts, per engine). */
  listSessions?: (
    cwd: string,
    engine: EngineKind,
  ) => MaybePromise<SessionMeta[]>;
  sessionExists?: (
    cwd: string,
    sessionId: string,
    engine: EngineKind,
  ) => MaybePromise<boolean>;
  /** Clock in ms for the restart window; injectable for tests. Defaults to
   *  Date.now. */
  now?: () => number;
  /** Grace before escalating a reset's old wrapper from SIGTERM to SIGKILL. */
  resetTerminationGraceMs?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Like {@link optionalString} but also drops the empty string. Used for the
 *  transition correlation id (phase-27, #160): a present-but-blank value must
 *  not reach the wrapper, because the server reads a blank `transition_id` as
 *  a mismatch rather than as the legacy "absent" case. */
function nonEmptyString(value: unknown): string | undefined {
  const text = optionalString(value);
  return text === undefined || text === "" ? undefined : text;
}

function isPromise<T>(value: MaybePromise<T>): value is Promise<T> {
  return value instanceof Promise;
}

/** Extracts a charset-valid agent_id, or null when absent/ill-typed/unsafe.
 *  The charset check is what keeps agent_id safe in a temp filename. */
export function readAgentId(payload: unknown): string | null {
  if (!isObject(payload)) return null;
  const id = payload.agent_id;
  if (typeof id !== "string" || !AGENT_ID_PATTERN.test(id)) return null;
  return id;
}

function parsePersona(value: unknown): WirePersona | null {
  if (!isObject(value)) return null;
  const { id, name, sprite_set } = value;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof sprite_set !== "string"
  ) {
    return null;
  }
  return { id, name, sprite_set };
}

/** Closed enum of Claude SDK permission_mode values (phase-15 15-12).
 *  Kept as a runtime array for parseSpawn's whitelist check; the type-side
 *  is `PermissionMode` in `@kaoiro/protocol`. Order matches the LaunchDialog
 *  option list, not the SDK's own ordering, so a grep between the two
 *  reads consistently. */
const PERMISSION_MODE_VALUES: readonly string[] = [
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "auto",
  "bypassPermissions",
];

/** Validates the rest of a `spawn` message (agent_id already read). Returns
 *  null when a required field is missing or ill-typed. */
export function parseSpawn(payload: unknown): ParsedSpawn | null {
  if (!isObject(payload)) return null;
  const persona = parsePersona(payload.persona);
  if (persona === null) return null;
  if (typeof payload.cwd !== "string" || payload.cwd === "") return null;
  // server_url is optional (案A): reject only a present-but-ill-typed value;
  // when absent the runner supplies its own wrapper URL at launch.
  if (
    payload.server_url !== undefined &&
    typeof payload.server_url !== "string"
  ) {
    return null;
  }
  // engine (ADR-0032 F4a, ADR-0057 F1): absent = claude-code; an unknown
  // value is a fail-loud reject, not a silent fallback to the wrong engine.
  let engine: EngineKind = "claude-code";
  if (payload.engine !== undefined) {
    if (
      payload.engine !== "claude-code" &&
      payload.engine !== "codex" &&
      payload.engine !== "antigravity"
    ) {
      return null;
    }
    engine = payload.engine;
  }
  const parsed: ParsedSpawn = {
    persona,
    cwd: payload.cwd,
    engine,
  };
  const serverUrl = optionalString(payload.server_url);
  if (serverUrl !== undefined && serverUrl !== "") parsed.serverUrl = serverUrl;
  const token = optionalString(payload.token);
  if (token !== undefined) parsed.token = token;
  const prompt = optionalString(payload.initial_prompt);
  if (prompt !== undefined && prompt !== "") parsed.initialPrompt = prompt;
  const resume = optionalString(payload.resume_session_id);
  if (resume !== undefined) parsed.resumeSessionId = resume;
  // Launch-time picks (ADR-0032 F4bc / ADR-0033 F3), relayed into the
  // wrapper config verbatim; value sets belong to the engine.
  const model = optionalString(payload.model);
  if (model !== undefined && model !== "") parsed.model = model;
  const effort = optionalString(payload.effort);
  if (effort !== undefined && effort !== "") parsed.effort = effort;
  // Claude-only permission_mode passthrough (phase-15 15-12). Closed-enum
  // whitelist, same as the SDK's PermissionMode union; an unknown value is
  // a fail-loud reject so the operator cannot silently launch with the
  // engine default when they picked something.
  if (payload.permission_mode !== undefined) {
    if (!PERMISSION_MODE_VALUES.includes(payload.permission_mode as string)) {
      return null;
    }
    parsed.permissionMode = payload.permission_mode as PermissionMode;
  }
  if (payload.sandbox !== undefined) {
    if (
      payload.sandbox !== "read-only" &&
      payload.sandbox !== "workspace-write" &&
      payload.sandbox !== "danger-full-access"
    ) {
      return null;
    }
    parsed.sandbox = payload.sandbox;
  }
  if (payload.network_access !== undefined) {
    if (typeof payload.network_access !== "boolean") return null;
    parsed.networkAccess = payload.network_access;
  }
  // Antigravity-only launch approval axis (ADR-0057 F4c). "on-failure" is
  // deliberately excluded from the whitelist — this engine rejects it at
  // spawn (Stage A offers only these three values in LaunchDialog).
  if (payload.approval !== undefined) {
    if (
      payload.approval !== "untrusted" &&
      payload.approval !== "on-request" &&
      payload.approval !== "never"
    ) {
      return null;
    }
    parsed.approval = payload.approval;
  }
  // Resume snapshot (ADR-0014 F1 追補, resume-privilege-restoration 藤 D2):
  // read-side sanitize — closed-enum / boolean / non-empty-string guards
  // on each of the known 8 fields, unknown / malformed dropped with a
  // stderr warn. A present-but-non-object shape is fail-loud (parseSpawn
  // returns null) so a compromised sender cannot slip a garbage payload
  // that later apply-time code would have to guard against.
  if (payload.resume_snapshot !== undefined) {
    const sanitized = validateResolvedSnapshot(payload.resume_snapshot);
    if (sanitized === null) return null;
    parsed.resumeSnapshot = sanitized;
  }
  // Fresh-restore flag (phase-25). Only meaningful on a fresh spawn
  // (resume_session_id absent); ignored when both are set because the
  // resume path already runs applyResumeSnapshot. Fail-loud on a
  // present-but-non-boolean value so a compromised sender cannot slip
  // truthy garbage past the guard.
  if (payload.apply_resume_snapshot !== undefined) {
    if (typeof payload.apply_resume_snapshot !== "boolean") return null;
    if (payload.apply_resume_snapshot) parsed.applyResumeSnapshot = true;
  }
  // Session-transition correlation id (phase-27, #160). Relayed verbatim;
  // the runner never interprets it. An empty string is dropped so it cannot
  // reach the wrapper as a present-but-blank transition_id — the server
  // treats that as a mismatch, not as the legacy absent case.
  const requestId = nonEmptyString(payload.request_id);
  if (requestId !== undefined) parsed.requestId = requestId;
  // display_name (issue #219 MF-1): absent = legacy server, the runner
  // falls back to persona.name at resolveWrapperConfig time. A PRESENT
  // value must be a string — fail-loud reject (not a silent drop) so a
  // compromised/buggy sender cannot slip non-string garbage past the
  // guard, matching sandbox/network_access above.
  if (payload.display_name !== undefined) {
    if (typeof payload.display_name !== "string") return null;
    parsed.displayName = payload.display_name;
  }
  return parsed;
}

/** A spawn's cwd must be one the host declared it can launch in (T1). */
export function isCwdAllowed(cwd: string, allowlist: string[]): boolean {
  return allowlist.includes(cwd);
}

/** Builds the wrapper init config from a spawn. allowed_tools is intentionally
 *  NOT taken from the spawn: the tool ceiling is wrapper-local and cannot be
 *  widened from the server side (threat-model.md), so the wrapper keeps its
 *  read-only default. Under ADR-0029 the wrapper's `server_url` is required,
 *  so a spawn without it falls back to the runner's own — its absence would
 *  otherwise leave the wrapper with no server to hand back to for the
 *  personality push. */
export function resolveWrapperConfig(
  agentId: string,
  parsed: ParsedSpawn,
  fallbackServerUrl: string,
  codexAuthMode?: CodexAuthMode,
  codexChatgptPlan?: ChatGptPlan,
  codexInternalSubagents?: boolean,
  claudeEngineCatalog?: WrapperConfig["claude_engine_catalog"] | null,
  contextWorkBudgetPercent?: number,
): WrapperConfig {
  const config: WrapperConfig = {
    agent_id: agentId,
    persona: parsed.persona,
    // One-time migration fallback (issue #219 MF-1): a legacy server that
    // predates SpawnMessage.display_name omits it, so parsed.displayName is
    // undefined here. Falling back to persona.name keeps a new-wrapper /
    // old-server pairing spawnable — WrapperConfig.display_name is required,
    // and the wrapper's own config parser (wrapper/core/src/persona.ts)
    // fails closed on a missing value.
    display_name: parsed.displayName ?? parsed.persona.name,
    server_url: parsed.serverUrl ?? fallbackServerUrl,
  };
  if (parsed.token !== undefined) config.server_token = parsed.token;
  if (contextWorkBudgetPercent !== undefined) {
    config.context_work_budget_percent = contextWorkBudgetPercent;
  }
  // Session-transition correlation id (phase-27, #160): the wrapper echoes
  // it in its channel join params so the server can recognise the
  // connection this transition produced.
  if (parsed.requestId !== undefined) config.transition_id = parsed.requestId;
  // Launch-time picks (ADR-0032 F4bc / ADR-0033 F3). Engines ignore the
  // fields that are not theirs (sandbox on Claude, permission_mode on codex).
  if (parsed.model !== undefined) config.model = parsed.model;
  if (parsed.effort !== undefined) config.effort = parsed.effort;
  // Resume-snapshot-sourced provenance (ADR-0014 F1 追補 P1, phase-23).
  // parseSpawn does NOT populate these; only applyResumeSnapshot does. The
  // wrapper CLI prefers this over its own env / config source guess so a
  // Case 3 (explicit source) resume preserves "launch" / "env" instead of
  // being relabelled "config". Fresh spawn → both fields absent, CLI
  // fallback unchanged.
  if (parsed.modelSource !== undefined) config.model_source = parsed.modelSource;
  if (parsed.effortSource !== undefined) {
    config.effort_source = parsed.effortSource;
  }
  if (parsed.engine === "codex") {
    if (codexAuthMode !== undefined) config.codex_auth_mode = codexAuthMode;
    if (codexChatgptPlan !== undefined) {
      config.codex_chatgpt_plan = codexChatgptPlan;
    }
    // Effective = configured ?? true (ADR-0038 F2): the runner option is
    // authoritative over user-global Codex config, so relay a concrete
    // boolean for every codex spawn (default true when unset).
    config.codex_internal_subagents = codexInternalSubagents ?? true;
  }
  if (
    parsed.engine === "claude-code" &&
    claudeEngineCatalog !== undefined &&
    claudeEngineCatalog !== null &&
    claudeEngineCatalog.length > 0
  ) {
    // ADR-0039 F9 追補: hand the runner's live-probed Claude catalog to
    // the wrapper so its initial #models is rich from the first
    // state_change (fresh-idle wrappers never reach SDK.supportedModels()).
    // Empty / null / undefined all fall through to the bootstrap floor.
    config.claude_engine_catalog = claudeEngineCatalog;
  }
  if (parsed.permissionMode !== undefined) {
    config.permission_mode = parsed.permissionMode;
  }
  if (parsed.sandbox !== undefined) config.sandbox = parsed.sandbox;
  if (parsed.networkAccess !== undefined) {
    config.network_access = parsed.networkAccess;
  }
  if (parsed.approval !== undefined) config.approval = parsed.approval;
  if (parsed.resumeSnapshot !== undefined) {
    // Invariant: `parsed.resumeSnapshot` is already sanitized by the caller
    // (parseSpawn / handleSwitchSession / handleResetSession all run
    // `validateResolvedSnapshot` before writing this field). Passing it
    // through verbatim keeps the wrapper's `config.resume_snapshot` in
    // sync with what the drift computation and P0 apply used.
    config.resume_snapshot = parsed.resumeSnapshot;
  }
  return config;
}

/** phase-17 17-5: session-reset in flight. The supervisor stashes it on
 *  the ChildEntry so `#onExit` knows to fresh-relaunch instead of taking
 *  the ordinary restart path, and so `#relaunchForReset` can fall back
 *  into `#rollback` on a fresh-spawn failure. Cleared as soon as the
 *  reset transitions to the wrapper (successful fresh spawn) OR the
 *  rollback fully resolves — after that, any crash is a normal crash. */
interface PendingReset {
  requestId: string;
  mode: SessionResetMode;
  /** The session_id the SERVER read from the SessionPointer at
   *  lock-acquire time. Used for the rollback branch's explicit resume;
   *  `entry.parsed.resumeSessionId` (spawn/switch-time) may have since
   *  diverged and cannot be trusted for rollback. `undefined` means the
   *  wrapper had not reported a session yet (fresh spawn edge) — a
   *  rollback there is not meaningful, so a failure fresh spawn goes
   *  straight to `rollback_failed` / disconnected. */
  previousSessionId?: string;
  /** The `entry.parsed.resumeSessionId` value that was in effect at
   *  reset-acquire time, captured BEFORE `handleResetSession` strips
   *  it. Owns the F4 lock on that id: on fresh-relaunch success the
   *  reset abandons that id so we release it from `#activeSessions`,
   *  and `#rollback` re-locks `rollbackSid` (mirroring
   *  `handleSwitchSession`'s add/delete transfer). Without this,
   *  a successful reset would leave the old id stuck in
   *  `#activeSessions` forever, blocking any future spawn / switch onto
   *  it (F4 same-session lock never released — review finding). */
  oldResumeSessionId?: string;
  /** The still-running old wrapper owns this launch configuration until it
   *  actually exits. Restore it if both termination signals time out: a later
   *  ordinary crash must resume the old session, not inherit the attempted
   *  fresh-reset configuration (#258). */
  previousParsed: ParsedSpawn;
}

interface ChildEntry {
  child: ManagedChild;
  parsed: ParsedSpawn;
  restarts: number;
  /** Start of the current crash-budget window (ms); reset when the window
   *  elapses or on an explicit restart. */
  windowStart: number;
  stopping: boolean;
  restarting: boolean;
  /** Session-reset in flight (phase-17 17-5). When set, `#onExit` routes
   *  into `#relaunchForReset` instead of the ordinary restart path. */
  pendingReset?: PendingReset;
  /** One reset-specific termination timer at a time. It is cancelled on the
   *  real exit path before the fresh relaunch takes ownership of this entry. */
  resetTerminationTimer?: ReturnType<typeof setTimeout>;
  /** SIGTERM has already been escalated to SIGKILL for this reset. */
  resetTerminationEscalated?: boolean;
}

/** Fields the runner's config watcher can hot-swap while the supervisor
 *  keeps running (see cli.ts config-reload dispatch). Applied all-or-none
 *  each reload — the caller passes the FULL current value for every field
 *  (undefined for codex fields means "clear it"), so a config that drops
 *  the `codex` block leaves no stale plan behind. Running children keep
 *  their own launch-time values; only wrappers spawned AFTER the update
 *  see the new ones. */
export interface SupervisorRuntimeUpdate {
  cwdAllowlist: string[];
  wrapperServerUrl: string;
  codexAuthMode: CodexAuthMode | undefined;
  codexChatgptPlan: ChatGptPlan | undefined;
  codexInternalSubagents: boolean | undefined;
  contextWorkBudgetPercent: number | undefined;
  /** Live getter for the runner's Claude engine-catalog cache (ADR-0039
   *  F9 追補). Preserved on hot-reload so a config file change does not
   *  disconnect an existing probe result from future spawns. */
  getClaudeEngineCatalog:
    | (() => WrapperConfig["claude_engine_catalog"] | null | undefined)
    | undefined;
}

export class Supervisor {
  readonly #hostId: string;
  #cwdAllowlist: string[];
  readonly #launch: LaunchFn;
  readonly #sendResult: (result: SpawnResult) => void;
  readonly #sendSessions: (sessions: RunnerSessions) => void;
  readonly #sendResetResult: (result: SessionResetResult) => void;
  readonly #listSessions: (
    cwd: string,
    engine: EngineKind,
  ) => MaybePromise<SessionMeta[]>;
  readonly #sessionExists: (
    cwd: string,
    sessionId: string,
    engine: EngineKind,
  ) => MaybePromise<boolean>;
  readonly #now: () => number;
  readonly #resetTerminationGraceMs: number;
  #wrapperServerUrl: string;
  #codexAuthMode: CodexAuthMode | undefined;
  #codexChatgptPlan: ChatGptPlan | undefined;
  #codexInternalSubagents: boolean | undefined;
  #contextWorkBudgetPercent: number | undefined;
  #getClaudeEngineCatalog:
    | (() => WrapperConfig["claude_engine_catalog"] | null | undefined)
    | undefined;
  readonly #children = new Map<string, ChildEntry>();
  /** session_ids currently being resumed — the F4 local lock against a second
   *  concurrent resume of the same session. */
  readonly #activeSessions = new Set<string>();
  /** Resume validation for Codex uses async filesystem I/O (#100). Reserve
   *  the agent_id while it is pending so duplicate spawn events cannot pass
   *  the ordinary #children guard before the first launch has started. */
  readonly #pendingSpawns = new Map<string, symbol>();
  /** At most one async switch validation per live agent. The wrapper stays
   *  running until validation succeeds, so a stop/crash can cancel safely. */
  readonly #pendingSwitches = new Map<string, symbol>();
  /** `runner_sessions` is a singleton broadcast without request_id. Async
   *  scans can finish out of order, so only the latest valid enumerate
   *  request may publish a result. */
  #enumerationGeneration = 0;

  constructor(options: SupervisorOptions) {
    this.#hostId = options.hostId;
    this.#cwdAllowlist = options.cwdAllowlist;
    this.#launch = options.launch;
    this.#sendResult = options.sendResult;
    this.#sendSessions = options.sendSessions;
    this.#sendResetResult = options.sendResetResult;
    this.#listSessions = options.listSessions ?? defaultListSessions;
    this.#sessionExists = options.sessionExists ?? defaultSessionExists;
    this.#now = options.now ?? (() => Date.now());
    this.#resetTerminationGraceMs =
      options.resetTerminationGraceMs ?? RESET_TERMINATION_GRACE_MS;
    this.#wrapperServerUrl = options.wrapperServerUrl;
    this.#codexAuthMode = options.codexAuthMode;
    this.#codexChatgptPlan = options.codexChatgptPlan;
    this.#codexInternalSubagents = options.codexInternalSubagents;
    this.#contextWorkBudgetPercent = options.contextWorkBudgetPercent;
    this.#getClaudeEngineCatalog = options.getClaudeEngineCatalog;
  }

  /** Hot-swap runtime config on a config-file reload. Full replacement per
   *  field — the caller provides the current value for every field, so the
   *  supervisor never carries stale values from a prior config revision.
   *  Existing children are untouched: only wrappers spawned AFTER this call
   *  see the new values (relaunches use `entry.parsed`, not the config, so
   *  a crashed agent relaunches with the SAME config as before but reads
   *  the wrapperServerUrl from the current value). */
  updateRuntimeConfig(update: SupervisorRuntimeUpdate): void {
    this.#cwdAllowlist = update.cwdAllowlist;
    this.#wrapperServerUrl = update.wrapperServerUrl;
    this.#codexAuthMode = update.codexAuthMode;
    this.#codexChatgptPlan = update.codexChatgptPlan;
    this.#codexInternalSubagents = update.codexInternalSubagents;
    this.#contextWorkBudgetPercent = update.contextWorkBudgetPercent;
    this.#getClaudeEngineCatalog = update.getClaudeEngineCatalog;
  }

  /** Handles a server `spawn`: validates, enforces the cwd allow-list, the
   *  agent_id dedup, and (for resume) the T3 existence check and F4 lock;
   *  launches the wrapper and reports the outcome. */
  handleSpawn(payload: unknown): void {
    const agentId = readAgentId(payload);
    if (agentId === null) {
      process.stderr.write("runner: spawn with missing/invalid agent_id\n");
      return;
    }
    // Read the correlation id before parsing so even a rejected payload
    // reports against the right pending transition (phase-27, #160).
    const requestId = isObject(payload)
      ? nonEmptyString(payload.request_id)
      : undefined;
    const parsed = parseSpawn(payload);
    if (parsed === null) {
      this.#fail(agentId, "error", requestId);
      return;
    }
    if (!isCwdAllowed(parsed.cwd, this.#cwdAllowlist)) {
      this.#fail(agentId, "cwd_not_found", requestId);
      return;
    }
    if (this.#children.has(agentId) || this.#pendingSpawns.has(agentId)) {
      this.#fail(agentId, "already_running", requestId);
      return;
    }
    const resume = parsed.resumeSessionId;
    if (resume === undefined) {
      // Fresh spawn: the ordinary rule is "never re-apply the snapshot"
      // (藤 D1) — a resume_snapshot ride only reaches the wrapper's
      // ext.resume_snapshot for drift display, not the engine-relevant
      // axes.
      //
      // Exception (phase-25, ADR-0030 D8 追補): fresh-restore. The server
      // sets `applyResumeSnapshot` when reviving a `/clear`-detached or
      // 未発話 offline agent whose SessionPointer lost its session_id.
      // Under this flag the snapshot IS SSOT for the privilege axes, so
      // we run applyResumeSnapshot exactly like the resume path — no T3
      // (no session file to check) and no F4 (no session id to lock), so
      // this flows straight into #launchSpawn.
      const freshParsed = parsed.applyResumeSnapshot
        ? applyResumeSnapshot(parsed, parsed.resumeSnapshot, parsed.engine)
        : parsed;
      this.#launchSpawn(agentId, freshParsed);
      return;
    }

    // Resume operation: the snapshot is the SSOT for privilege axes, so
    // overwrite parsed's engine-relevant fields from it before launch
    // (ADR-0014 F1 追補, 藤 D1/D2). Absent / invalid → safe engine default.
    const resumedParsed = applyResumeSnapshot(
      parsed,
      parsed.resumeSnapshot,
      parsed.engine,
    );

    // T3: Codex scans its date tree asynchronously (#100); Claude and test
    // injections may still answer synchronously. Preserve that fast path so
    // fresh/Claude spawn remains immediate while Codex I/O yields the event
    // loop instead of pausing status relay for every agent.
    const exists = this.#sessionExists(parsed.cwd, resume, parsed.engine);
    if (!isPromise(exists)) {
      this.#completeResumeSpawn(agentId, resumedParsed, exists);
      return;
    }

    const token = Symbol(agentId);
    this.#pendingSpawns.set(agentId, token);
    void exists
      .then((found) => {
        if (this.#pendingSpawns.get(agentId) !== token) return;
        this.#pendingSpawns.delete(agentId);
        this.#completeResumeSpawn(agentId, resumedParsed, found);
      })
      .catch((error: unknown) => {
        if (this.#pendingSpawns.get(agentId) !== token) return;
        this.#pendingSpawns.delete(agentId);
        process.stderr.write(
          `runner: resume session scan failed for ${agentId}: ${String(error)}\n`,
        );
        this.#fail(agentId, "error", resumedParsed.requestId);
      });
  }

  /** Handles a server `stop`: a deliberate exit, no auto-restart. */
  handleStop(payload: unknown): void {
    const agentId = readAgentId(payload);
    if (agentId === null) return;
    // A stop racing an async Codex T3 scan cancels the not-yet-launched spawn.
    // Deleting its token makes the promise continuation a no-op.
    if (this.#pendingSpawns.delete(agentId)) {
      // Close the original spawn outcome instead of leaving the dashboard's
      // pending notice unresolved. The closed vocabulary has no cancellation
      // reason, so use the existing generic failure.
      this.#fail(agentId, "error");
      return;
    }
    const entry = this.#children.get(agentId);
    if (entry === undefined) return;
    this.#pendingSwitches.delete(agentId);
    entry.stopping = true;
    entry.child.kill();
  }

  /** Handles a server `restart`: kill then relaunch fresh; resets the crash
   *  budget since this is an intentional cycle. */
  handleRestart(payload: unknown): void {
    const agentId = readAgentId(payload);
    if (agentId === null) return;
    const entry = this.#children.get(agentId);
    if (entry === undefined) return;
    if (isObject(payload)) {
      const requestId = nonEmptyString(payload.request_id);
      if (requestId !== undefined) {
        // A deliberate restart belongs to this command, not to the spawn or
        // switch that originally created the entry. New runners accept the
        // server-issued id and relay it into the relaunched wrapper's
        // transition_id; an old server omits it and retains the historical
        // restart behaviour unchanged.
        entry.parsed = { ...entry.parsed, requestId };
      }
    }
    this.#pendingSwitches.delete(agentId);
    entry.restarting = true;
    entry.restarts = 0;
    entry.windowStart = this.#now();
    entry.child.kill();
  }

  /** Handles a server `switch_session`: retargets a live agent's resume pointer
   *  to a different session_id under its bound cwd, then cycles the wrapper so
   *  the new session takes effect (ADR-0014, resume-swap). agent_id and cwd are
   *  preserved; T3 (existence) and F4 (same-session lock) are re-enforced on
   *  the incoming session_id, and the lock is transferred atomically from the
   *  old id to the new so a subsequent resume of the released id is not
   *  spuriously blocked. Silent on a missing agent (mirrors `restart` / `stop`
   *  — the entry may have exited between the operator click and the arrival). */
  handleSwitchSession(payload: unknown): void {
    const agentId = readAgentId(payload);
    if (agentId === null) {
      process.stderr.write(
        "runner: switch_session with missing/invalid agent_id\n",
      );
      return;
    }
    const entry = this.#children.get(agentId);
    if (entry === undefined) return;
    if (!isObject(payload)) return;
    const requestId = nonEmptyString(payload.request_id);
    const resume = optionalString(payload.resume_session_id);
    if (resume === undefined || resume === "") {
      this.#fail(agentId, "error", requestId);
      return;
    }
    // A newer switch supersedes an older async validation for the same agent.
    // The older continuation observes its missing token and becomes a no-op.
    this.#pendingSwitches.delete(agentId);
    // T3 under the agent's currently bound cwd — the operator picked the id
    // from the same cwd's enumerate; re-verify at the boundary so a spoofed
    // or stale id cannot slip past.
    const exists = this.#sessionExists(
      entry.parsed.cwd,
      resume,
      entry.parsed.engine,
    );
    if (!isPromise(exists)) {
      this.#completeSwitchSession(agentId, entry, payload, resume, exists);
      return;
    }

    const token = Symbol(agentId);
    this.#pendingSwitches.set(agentId, token);
    void exists
      .then((found) => {
        if (this.#pendingSwitches.get(agentId) !== token) return;
        this.#pendingSwitches.delete(agentId);
        this.#completeSwitchSession(agentId, entry, payload, resume, found);
      })
      .catch((error: unknown) => {
        if (this.#pendingSwitches.get(agentId) !== token) return;
        this.#pendingSwitches.delete(agentId);
        process.stderr.write(
          `runner: switch_session scan failed for ${agentId}: ${String(error)}\n`,
        );
        if (this.#children.get(agentId) === entry && !entry.stopping) {
          this.#fail(agentId, "error", requestId);
        }
      });
  }

  #completeSwitchSession(
    agentId: string,
    entry: ChildEntry,
    payload: Record<string, unknown>,
    resume: string,
    exists: boolean,
  ): void {
    // The child can stop/crash while Codex I/O is pending. Never resurrect or
    // mutate a stale entry after the scan completes.
    if (this.#children.get(agentId) !== entry || entry.stopping) return;
    const requestId = nonEmptyString(payload.request_id);
    if (!exists) {
      process.stderr.write(
        `runner: switch_session target not found under cwd (agent ${agentId})\n`,
      );
      this.#fail(agentId, "session_not_found", requestId);
      return;
    }
    // Resume snapshot (ADR-0014 F1 追補「resume 時の privilege 三軸再適用」,
    // phase-15 D8 + phase-22 藤 D1/D2/R2):
    // the server attaches the swapped-in session's stored snapshot on
    // switch_session; validate + carry it so the relaunched wrapper stamps
    // ext.resume_snapshot / ext.resume_drift. Absent on the payload =
    // keep the previous parsed value (post-review Finding 2). A present-
    // but-malformed shape (validate returns null) is fail-loud (藤 R2
    // must-fix): retaining `entry.parsed.resumeSnapshot` here would let
    // an attacker-crafted or buggy payload carry the OLD privileged
    // sandbox / permission_mode into the relaunched wrapper. Validate
    // BEFORE the F4 lock mutation below so a reject leaves activeSessions
    // untouched.
    let nextSnapshot: ResolvedSnapshotExt | undefined =
      entry.parsed.resumeSnapshot;
    if (isObject(payload) && payload.resume_snapshot !== undefined) {
      const sanitized = validateResolvedSnapshot(payload.resume_snapshot);
      if (sanitized === null) {
        process.stderr.write(
          `runner: switch_session with malformed resume_snapshot for ${agentId}\n`,
        );
        this.#fail(agentId, "error", requestId);
        return;
      }
      nextSnapshot = sanitized;
    }
    const old = entry.parsed.resumeSessionId;
    // F4: another agent already resuming the target session blocks the swap.
    // Self (same session already bound) is a no-op we could early-return, but
    // proceeding to cycle the wrapper matches the intent of an explicit swap
    // click (drop stale in-memory state), so we only guard against a foreign
    // holder.
    if (resume !== old && this.#activeSessions.has(resume)) {
      this.#fail(agentId, "already_running", requestId);
      return;
    }
    if (old !== undefined && old !== resume) this.#activeSessions.delete(old);
    this.#activeSessions.add(resume);
    // Apply the snapshot's engine-relevant privilege axes to entry.parsed
    // BEFORE the relaunch (D1/D2): snapshot is SSOT on a resume operation,
    // so the fresh wrapper enforces the last-effective sandbox / network /
    // permission_mode. Absent snapshot on this payload AND on entry
    // (never seen a snapshot at all) = no-op, and the previous entry
    // values persist.
    const applied = applyResumeSnapshot(
      entry.parsed,
      nextSnapshot,
      entry.parsed.engine,
    );
    // The relaunch belongs to THIS switch, so it must carry this command's
    // correlation id — never the previous spawn's (phase-27, #160). Drop the
    // inherited value first so a legacy switch (no request_id) relaunches
    // with none rather than with a stale one; the server then declines to
    // activate and suppresses the affected metadata instead of trusting it.
    // Destructure-and-drop matches the resumeSessionId handling below and
    // satisfies exactOptionalPropertyTypes.
    const { requestId: _dropRequestId, ...appliedWithoutRequestId } = applied;
    void _dropRequestId;
    entry.parsed = {
      ...appliedWithoutRequestId,
      resumeSessionId: resume,
      ...(nextSnapshot !== undefined ? { resumeSnapshot: nextSnapshot } : {}),
      ...(requestId !== undefined ? { requestId } : {}),
    };
    // Take the same restart path a `restart` uses: reset the crash budget
    // (this is a deliberate cycle, not a crash) and kill; #onExit sees
    // restarting=true and routes into #relaunch, which re-reads entry.parsed
    // so the new resume_session_id rides the fresh wrapper.
    entry.restarting = true;
    entry.restarts = 0;
    entry.windowStart = this.#now();
    entry.child.kill();
  }

  /** Handles a server `reset_session` (ADR-0036 F2/F7, phase-17 17-5):
   *  same-agent fresh relaunch of the wrapper. `resumeSessionId` is
   *  cleared so the fresh child launches WITHOUT `--resume`; the
   *  `resumeSnapshot` (phase-15 D8's last-effective settings) is kept so
   *  the fresh session re-applies model / effort / permission / sandbox
   *  from where the old one left off, not from spawn-time defaults.
   *
   *  Failure recovery: `#relaunchForReset` calls `#rollback` on a fresh
   *  spawn exception, which resumes the OLD session (from the payload's
   *  `previous_session_id` — a value the SERVER read from the
   *  SessionPointer at lock-acquire time so a mid-run switch_session
   *  cannot leave us rolling back to a stale id).
   *
   *  This is intentionally NOT unified with `handleSwitchSession` even
   *  though both cycle the wrapper: switch_session commits to the new
   *  session_id and drops the old; reset must preserve the old for
   *  rollback, and its completion is a two-phase server-side handshake
   *  (spawn ok + wrapper join), not a one-shot restart. Missing agent /
   *  malformed payload is a silent drop like the other handlers. */
  handleResetSession(payload: unknown): void {
    const agentId = readAgentId(payload);
    if (agentId === null) {
      process.stderr.write(
        "runner: reset_session with missing/invalid agent_id\n",
      );
      return;
    }
    const entry = this.#children.get(agentId);
    if (entry === undefined) return;
    if (!isObject(payload)) return;
    const requestId = optionalString(payload.request_id);
    const mode = payload.mode;
    if (requestId === undefined || requestId === "") return;
    if (mode !== "new" && mode !== "clear") return;
    this.#pendingSwitches.delete(agentId);
    const previousSessionId = optionalString(payload.previous_session_id);
    // Capture the spawn-time F4-lock holder BEFORE stripping it below;
    // #relaunchForReset releases it on success and #rollback transfers
    // it to rollbackSid if the two differ (mirrors handleSwitchSession
    // add/delete lock transfer, which the reset diff must not break).
    const previousParsed = entry.parsed;
    const oldResumeSessionId = previousParsed.resumeSessionId;
    // Stash the pending reset BEFORE mutating entry.parsed, so a
    // rollback triggered by an early kill/exit still has the id.
    entry.pendingReset = {
      requestId,
      mode: mode as SessionResetMode,
      ...(previousSessionId !== undefined ? { previousSessionId } : {}),
      ...(oldResumeSessionId !== undefined ? { oldResumeSessionId } : {}),
      previousParsed,
    };
    // ADR-0014 F1 追補 (phase-22 藤 D1/D2/R2): reset_session carries the
    // current SessionPointers snapshot from the server. Validate + apply
    // it to entry.parsed BEFORE the fresh relaunch so ADR-0036 F2's
    // "最後に実効だった設定で開始" contract holds for the privilege axes
    // (Codex sandbox / network_access, Claude permission_mode).
    //
    // Absent on the payload = keep entry.parsed as-is (previous snapshot-
    // applied values from initial restore / switch survive).
    //
    // Present-but-malformed shape (validate returns null): **safe-default
    // relaunch**. The existing SessionResetErrorReason vocabulary has no
    // fitting reason for a schema-level malformed payload, so a hard-fail
    // via sendResetResult would misuse `spawn_failed` (spawn was never
    // attempted); a silent drop would let the server timeout without
    // detaching. Instead we treat the malformed payload as if snapshot
    // were `{}` — the empty snapshot drives applyResumeSnapshot into
    // engine defaults (Codex: workspace-write / false, Claude: default),
    // never carrying the OLD privileged value from `entry.parsed`
    // through the relaunch (藤 R2 must-fix: 旧 danger 保持禁止). stderr
    // warn so operator sees the incident even when the runtime path
    // continues.
    let nextSnapshot: ResolvedSnapshotExt | undefined =
      entry.parsed.resumeSnapshot;
    if (payload.resume_snapshot !== undefined) {
      const sanitized = validateResolvedSnapshot(payload.resume_snapshot);
      if (sanitized === null) {
        process.stderr.write(
          `runner: reset_session with malformed resume_snapshot for ` +
            `${agentId}; safe-default relaunch (empty snapshot → engine defaults)\n`,
        );
        nextSnapshot = {};
      } else {
        nextSnapshot = sanitized;
      }
    }
    const applied = applyResumeSnapshot(
      entry.parsed,
      nextSnapshot,
      entry.parsed.engine,
    );
    // Fresh: strip resumeSessionId so #relaunchForReset launches without
    // --resume. resumeSnapshot stays (phase-15 D8 last-effective values).
    // Destructure-and-drop instead of assigning `undefined` because the
    // ParsedSpawn type uses exactOptionalPropertyTypes.
    const { resumeSessionId: _drop, ...withoutResume } = {
      ...applied,
      ...(nextSnapshot !== undefined ? { resumeSnapshot: nextSnapshot } : {}),
      // The fresh session belongs to THIS reset, so the relaunch carries the
      // reset's request_id (phase-27, #160). Overwriting the inherited spawn
      // value is what lets the server match the fresh wrapper's join against
      // the reset lock it is holding.
      requestId,
    };
    void _drop;
    entry.parsed = withoutResume;
    // Intentional cycle (same as handleRestart / handleSwitchSession):
    // reset the crash budget so the deliberate kill does not count.
    entry.restarting = true;
    entry.restarts = 0;
    entry.windowStart = this.#now();
    entry.resetTerminationEscalated = false;
    this.#terminateForReset(agentId, entry, "SIGTERM");
  }

  /** Handles a server `enumerate_sessions`: lists resume candidates under cwd
   *  and replies with `sessions`. Only allow-listed cwds are enumerated, so an
   *  operator cannot probe arbitrary paths. */
  handleEnumerate(payload: unknown): void {
    if (!isObject(payload)) return;
    const cwd = payload.cwd;
    if (typeof cwd !== "string") return;
    const generation = ++this.#enumerationGeneration;
    // engine scopes the listing to one session store (ADR-0032 F8,
    // ADR-0057 F1); absent = claude-code, unknown values fall back to an
    // empty list.
    let engine: EngineKind = "claude-code";
    if (payload.engine !== undefined) {
      if (
        payload.engine !== "claude-code" &&
        payload.engine !== "codex" &&
        payload.engine !== "antigravity"
      ) {
        this.#sendSessions({
          version: "0",
          host_id: this.#hostId,
          cwd,
          sessions: [],
        });
        return;
      }
      engine = payload.engine;
    }
    if (!isCwdAllowed(cwd, this.#cwdAllowlist)) {
      this.#sendSessionList(cwd, engine, []);
      return;
    }
    const sessions = this.#listSessions(cwd, engine);
    if (!isPromise(sessions)) {
      this.#sendSessionList(cwd, engine, sessions);
      return;
    }
    void sessions
      .then((found) => {
        if (generation === this.#enumerationGeneration) {
          this.#sendSessionList(cwd, engine, found);
        }
      })
      .catch((error: unknown) => {
        if (generation !== this.#enumerationGeneration) return;
        process.stderr.write(
          `runner: session enumeration failed for ${cwd}: ${String(error)}\n`,
        );
        this.#sendSessionList(cwd, engine, []);
      });
  }

  /** Stops every child (deliberate); used on runner shutdown. */
  stopAll(): void {
    // Cancel resume spawns that have not launched yet. Their async continuations
    // compare tokens before acting, so clearing the map is sufficient.
    this.#pendingSpawns.clear();
    this.#pendingSwitches.clear();
    for (const entry of this.#children.values()) {
      entry.stopping = true;
      entry.child.kill();
    }
  }

  #sendSessionList(
    cwd: string,
    engine: EngineKind,
    sessions: SessionMeta[],
  ): void {
    this.#sendSessions({
      version: "0",
      host_id: this.#hostId,
      cwd,
      sessions,
      engine,
    });
  }

  #completeResumeSpawn(
    agentId: string,
    parsed: ParsedSpawn,
    exists: boolean,
  ): void {
    const resume = parsed.resumeSessionId;
    if (resume === undefined) return;
    if (!exists) {
      process.stderr.write(
        `runner: resume session not found under cwd (agent ${agentId})\n`,
      );
      this.#fail(agentId, "session_not_found", parsed.requestId);
      return;
    }
    // F4: after an async T3 check resumes, this check+add remains one
    // synchronous JS turn. Two concurrent scans therefore cannot both claim
    // the same session.
    if (this.#activeSessions.has(resume)) {
      this.#fail(agentId, "already_running", parsed.requestId);
      return;
    }
    this.#activeSessions.add(resume);
    this.#launchSpawn(agentId, parsed);
  }

  #launchSpawn(agentId: string, parsed: ParsedSpawn): void {
    const resume = parsed.resumeSessionId;
    try {
      this.#start(agentId, parsed);
    } catch (error) {
      // A synchronous launch failure (the config write or spawn raising) must
      // still surface to the operator and leave no stranded slot or lock.
      process.stderr.write(
        `runner: launch failed for ${agentId}: ${String(error)}\n`,
      );
      this.#children.delete(agentId);
      if (resume !== undefined) this.#activeSessions.delete(resume);
      this.#fail(agentId, "error", parsed.requestId);
      return;
    }
    this.#sendResult({
      version: "0",
      host_id: this.#hostId,
      agent_id: agentId,
      ok: true,
      ...(parsed.requestId !== undefined
        ? { request_id: parsed.requestId }
        : {}),
    });
  }

  /** `requestId` echoes the transition correlation id of the command that
   *  failed (phase-27, #160) so the server can abort exactly that pending
   *  transition. Omitted when the id is unknown — a malformed payload, or a
   *  failure raised outside the originating command (e.g. a `stop` that
   *  cancels an in-flight spawn). The server then discards the result and
   *  lets the pending transition expire instead of acting on it. */
  #fail(
    agentId: string,
    reason: SpawnFailReason,
    requestId?: string | undefined,
  ): void {
    this.#sendResult({
      version: "0",
      host_id: this.#hostId,
      agent_id: agentId,
      ok: false,
      reason,
      ...(requestId !== undefined ? { request_id: requestId } : {}),
    });
  }

  #start(agentId: string, parsed: ParsedSpawn): void {
    const child = this.#launch(
      agentId,
      resolveWrapperConfig(
        agentId,
        parsed,
        this.#wrapperServerUrl,
        this.#codexAuthMode,
        this.#codexChatgptPlan,
        this.#codexInternalSubagents,
        this.#getClaudeEngineCatalog?.() ?? null,
        this.#contextWorkBudgetPercent,
      ),
      parsed.cwd,
      parsed.resumeSessionId,
      parsed.initialPrompt,
      parsed.engine,
    );
    const entry: ChildEntry = {
      child,
      parsed,
      restarts: 0,
      windowStart: this.#now(),
      stopping: false,
      restarting: false,
    };
    this.#children.set(agentId, entry);
    child.on("exit", () => this.#onExit(agentId));
  }

  /** Drives the old reset target to a definitive outcome. The old process is
   *  never replaced until its own exit callback runs: spawning a fresh wrapper
   *  while the old one is still connected would create two owners for one
   *  agent. A child that reports `kill() === false` is already gone, so its
   *  missing exit is advanced through the normal exit branch on a microtask. */
  #terminateForReset(
    agentId: string,
    entry: ChildEntry,
    signal: NodeJS.Signals,
  ): void {
    const signalled = entry.child.kill(signal);
    if (!signalled) {
      queueMicrotask(() => {
        if (
          this.#children.get(agentId) === entry &&
          entry.pendingReset !== undefined
        ) {
          this.#onExit(agentId);
        }
      });
      return;
    }
    // ChildProcess emits exit asynchronously, but test doubles and alternate
    // launchers may synchronously invoke the listener from kill(). Do not arm
    // a stale timer after that listener already relaunches the entry.
    if (
      this.#children.get(agentId) !== entry ||
      entry.pendingReset === undefined
    ) {
      return;
    }
    entry.resetTerminationTimer = setTimeout(() => {
      delete entry.resetTerminationTimer;
      if (
        this.#children.get(agentId) !== entry ||
        entry.pendingReset === undefined
      ) {
        return;
      }
      if (!entry.resetTerminationEscalated) {
        entry.resetTerminationEscalated = true;
        this.#terminateForReset(agentId, entry, "SIGKILL");
        return;
      }
      this.#failResetTermination(agentId, entry);
    }, this.#resetTerminationGraceMs);
  }

  #clearResetTerminationTimer(entry: ChildEntry): void {
    if (entry.resetTerminationTimer !== undefined) {
      clearTimeout(entry.resetTerminationTimer);
      delete entry.resetTerminationTimer;
    }
    delete entry.resetTerminationEscalated;
  }

  /** Both SIGTERM and SIGKILL were acknowledged but no exit arrived. Keep the
   *  child mapped (it may still exit later) and restore its old launch state;
   *  reporting `timeout` unlocks the server transaction and reaches the
   *  requesting wrapper, instead of making a non-reset look successful. */
  #failResetTermination(agentId: string, entry: ChildEntry): void {
    const pending = entry.pendingReset;
    if (pending === undefined) return;
    process.stderr.write(
      `runner: reset termination timed out for ${agentId}; old wrapper remains supervised\n`,
    );
    entry.parsed = pending.previousParsed;
    entry.restarting = false;
    delete entry.pendingReset;
    this.#sendResetResult({
      version: "0",
      host_id: this.#hostId,
      agent_id: agentId,
      mode: pending.mode,
      request_id: pending.requestId,
      ok: false,
      reason: "timeout",
    });
  }

  #onExit(agentId: string): void {
    const entry = this.#children.get(agentId);
    if (entry === undefined) return;

    this.#clearResetTerminationTimer(entry);

    if (entry.stopping) {
      this.#remove(agentId, entry);
      return;
    }
    // phase-17 17-5: reset exit runs BEFORE the ordinary restart branch
    // — a reset also sets restarting=true, but the reset branch owns the
    // fresh-vs-rollback decision and reports back via #sendResetResult.
    // Clearing entry.pendingReset happens inside those helpers so a
    // fresh-spawn success cleanly hands the entry back to the ordinary
    // crash path for the rest of its lifetime.
    if (entry.pendingReset !== undefined) {
      entry.restarting = false;
      this.#relaunchForReset(agentId, entry);
      return;
    }
    if (entry.restarting) {
      entry.restarting = false;
      this.#relaunch(agentId, entry);
      return;
    }
    // Unexpected exit = crash: relaunch (isolated from siblings) until the cap.
    // The budget is windowed (RESTART_WINDOW_MS): a quiet spell longer than the
    // window resets it, so only a tight crash-loop exhausts the cap.
    const now = this.#now();
    if (now - entry.windowStart > RESTART_WINDOW_MS) {
      entry.windowStart = now;
      entry.restarts = 0;
    }
    if (entry.restarts >= MAX_RESTARTS) {
      process.stderr.write(
        `runner: agent ${agentId} exceeded restart cap; leaving down\n`,
      );
      this.#remove(agentId, entry);
      return;
    }
    entry.restarts += 1;
    this.#relaunch(agentId, entry);
  }

  /** Drops an entry and releases its resume lock; the lock is held across
   *  restarts and freed only when the agent is finally gone. */
  #remove(agentId: string, entry: ChildEntry): void {
    this.#clearResetTerminationTimer(entry);
    this.#pendingSwitches.delete(agentId);
    this.#children.delete(agentId);
    const resume = entry.parsed.resumeSessionId;
    if (resume !== undefined) this.#activeSessions.delete(resume);
  }

  #relaunch(agentId: string, entry: ChildEntry): void {
    let child: ManagedChild;
    try {
      // initialPrompt is deliberately NOT re-sent on an auto-restart: re-running
      // a possibly side-effectful first turn on every crash is unsafe. A restarted
      // agent comes back idle and awaits the next instruction.
      child = this.#launch(
        agentId,
        resolveWrapperConfig(
          agentId,
          entry.parsed,
          this.#wrapperServerUrl,
          this.#codexAuthMode,
          this.#codexChatgptPlan,
          this.#codexInternalSubagents,
          this.#getClaudeEngineCatalog?.() ?? null,
          this.#contextWorkBudgetPercent,
        ),
        entry.parsed.cwd,
        entry.parsed.resumeSessionId,
        undefined,
        entry.parsed.engine,
      );
    } catch (error) {
      // Same guard as handleSpawn's #start: a synchronous relaunch failure
      // runs inside the exit-event callback, so an unguarded throw would crash
      // the runner. Free the slot and the resume lock instead of leaking them.
      process.stderr.write(
        `runner: relaunch failed for ${agentId}: ${String(error)}\n`,
      );
      this.#remove(agentId, entry);
      return;
    }
    entry.child = child;
    child.on("exit", () => this.#onExit(agentId));
  }

  /** phase-17 17-5: fresh-relaunch branch of a session reset (ADR-0036 F2).
   *  The wrapper is launched WITHOUT a resume session_id (Claude starts a
   *  new `query()` without `resume`; Codex calls `startThread()` instead
   *  of `resumeThread()`). On success the runner reports ok=true; the
   *  server-side lock transitions to `:awaiting_connect` and completion
   *  waits on the fresh wrapper's channel join (must-2, F2 文言準拠). On
   *  a synchronous launch failure the branch degrades to `#rollback`,
   *  restoring the previous session_id if we have one. Post-success, any
   *  further crash falls into the ordinary #onExit crash path — the
   *  pendingReset is cleared here so a fresh-wrapper crash 30 s later
   *  does not re-enter this branch. */
  #relaunchForReset(agentId: string, entry: ChildEntry): void {
    const pending = entry.pendingReset;
    if (pending === undefined) return;
    let child: ManagedChild;
    try {
      child = this.#launch(
        agentId,
        resolveWrapperConfig(
          agentId,
          entry.parsed,
          this.#wrapperServerUrl,
          this.#codexAuthMode,
          this.#codexChatgptPlan,
          this.#codexInternalSubagents,
          this.#getClaudeEngineCatalog?.() ?? null,
          this.#contextWorkBudgetPercent,
        ),
        entry.parsed.cwd,
        undefined, // fresh: no --resume
        undefined, // no initial prompt
        entry.parsed.engine,
      );
    } catch (error) {
      process.stderr.write(
        `runner: fresh relaunch failed for ${agentId}: ${String(error)}\n`,
      );
      this.#rollback(agentId, entry, "spawn_failed");
      return;
    }
    entry.child = child;
    entry.restarts = 0;
    entry.windowStart = this.#now();
    child.on("exit", () => this.#onExit(agentId));
    // Release the F4 resume lock for the abandoned session_id (review
    // finding: without this, the id stays in #activeSessions forever
    // because #remove later reads entry.parsed.resumeSessionId which
    // was stripped in handleResetSession). handleSwitchSession uses
    // the same add/delete pattern.
    if (pending.oldResumeSessionId !== undefined) {
      this.#activeSessions.delete(pending.oldResumeSessionId);
    }
    // Report to server: spawn succeeded. Server transitions the lock to
    // `:awaiting_connect` and waits for the fresh wrapper's channel join.
    // to_session_id is `null` here: the runner does not know it yet.
    // Claude's init state_change will carry one (server sees it in
    // WrapperChannel.after_join); Codex has none until the first turn
    // and its completed broadcast rides `to_session_id=null`.
    this.#sendResetResult({
      version: "0",
      host_id: this.#hostId,
      agent_id: agentId,
      mode: pending.mode,
      request_id: pending.requestId,
      ok: true,
      to_session_id: null,
    });
    // Clear so a post-success crash lands in the ordinary #onExit path,
    // not back into #relaunchForReset. Director-approved: pid-success
    // followed by an immediate wrapper death gets loud via the server's
    // 60 s awaiting_connect timeout (session_reset_failed { timeout }).
    delete entry.pendingReset;
  }

  /** phase-17 17-5: rollback branch of a session reset (ADR-0036 F2). The
   *  fresh spawn failed synchronously; re-launch with the previous
   *  session_id (from the server-supplied `previous_session_id`, NOT the
   *  entry's spawn-time value which may have diverged). Success = the
   *  old session is back and the operator sees `session_reset_failed
   *  { reason: "spawn_failed" }`; failure of the rollback itself =
   *  `rollback_failed` + drop the entry so the operator sees the agent
   *  disconnected. */
  #rollback(
    agentId: string,
    entry: ChildEntry,
    freshFailureReason: SessionResetErrorReason,
  ): void {
    const pending = entry.pendingReset;
    if (pending === undefined) return;
    const rollbackSid = pending.previousSessionId;
    if (rollbackSid === undefined || rollbackSid === "") {
      // No session to resume — no meaningful rollback target. Report
      // rollback_failed and drop the entry so the agent goes disconnected.
      process.stderr.write(
        `runner: no previous_session_id for rollback of ${agentId}; disconnected\n`,
      );
      this.#sendResetResult({
        version: "0",
        host_id: this.#hostId,
        agent_id: agentId,
        mode: pending.mode,
        request_id: pending.requestId,
        ok: false,
        reason: "rollback_failed",
      });
      delete entry.pendingReset;
      this.#remove(agentId, entry);
      return;
    }
    // Restore entry.parsed to the pre-reset state.
    entry.parsed = { ...entry.parsed, resumeSessionId: rollbackSid };
    let child: ManagedChild;
    try {
      child = this.#launch(
        agentId,
        resolveWrapperConfig(
          agentId,
          entry.parsed,
          this.#wrapperServerUrl,
          this.#codexAuthMode,
          this.#codexChatgptPlan,
          this.#codexInternalSubagents,
          this.#getClaudeEngineCatalog?.() ?? null,
          this.#contextWorkBudgetPercent,
        ),
        entry.parsed.cwd,
        rollbackSid,
        undefined,
        entry.parsed.engine,
      );
    } catch (error) {
      process.stderr.write(
        `runner: rollback resume failed for ${agentId}: ${String(error)}\n`,
      );
      this.#sendResetResult({
        version: "0",
        host_id: this.#hostId,
        agent_id: agentId,
        mode: pending.mode,
        request_id: pending.requestId,
        ok: false,
        reason: "rollback_failed",
      });
      delete entry.pendingReset;
      this.#remove(agentId, entry);
      return;
    }
    entry.child = child;
    entry.restarts = 0;
    entry.windowStart = this.#now();
    child.on("exit", () => this.#onExit(agentId));
    // Transfer the F4 lock from oldResumeSessionId to rollbackSid when
    // they differ — mirrors handleSwitchSession's atomic delete + add.
    // If they match, the lock is already held from the original spawn
    // and no change is needed.
    if (pending.oldResumeSessionId !== rollbackSid) {
      if (pending.oldResumeSessionId !== undefined) {
        this.#activeSessions.delete(pending.oldResumeSessionId);
      }
      this.#activeSessions.add(rollbackSid);
    }
    // Rollback succeeded: report the ORIGINAL fresh-spawn failure so the
    // operator sees why the reset failed, not that rollback happened.
    this.#sendResetResult({
      version: "0",
      host_id: this.#hostId,
      agent_id: agentId,
      mode: pending.mode,
      request_id: pending.requestId,
      ok: false,
      reason: freshFailureReason,
    });
    delete entry.pendingReset;
  }
}
