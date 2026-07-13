// Process supervisor (ADR-0023, phases 4-4b/4-5). Owns the host's wrapper child
// processes: spawns a wrapper per `spawn`, restarts a crashed one (isolated
// from siblings), stops/restarts on operator command, enumerates resume
// candidates, and resumes a session — gated by the T3 existence check and the
// F4 same-session local lock. The child launch is injected so the supervision
// logic is testable without real processes (default launcher: spawn.ts).

import type {
  EngineKind,
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

/** agent_id rides a temp config filename and the spawn_result, so its charset
 *  is restricted exactly like the server's AgentId guard (no path separators). */
const AGENT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** The minimal child handle the supervisor needs; ChildProcess satisfies it. */
export interface ManagedChild {
  on(event: "exit", listener: () => void): void;
  kill(): void;
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

/** The validated fields of a `spawn` message the supervisor acts on. serverUrl
 *  is optional: under案A the server omits it and the runner falls back to its
 *  own wrapper URL (ADR-0024). engine defaults to "claude-code" so old
 *  servers keep working (ADR-0032 F4a). */
export interface ParsedSpawn {
  persona: WirePersona;
  cwd: string;
  engine: EngineKind;
  serverUrl?: string;
  token?: string;
  initialPrompt?: string;
  resumeSessionId?: string;
  model?: string;
  effort?: string;
  /** Claude-only launch permission mode (ADR-0033 F4 追補, phase-15 D2 /
   *  task 15-12). Relayed from SpawnMessage.permission_mode; Codex ignores
   *  it. Closed-enum validation runs at parseSpawn's whitelist. */
  permissionMode?: PermissionMode;
  sandbox?: WrapperConfig["sandbox"];
  networkAccess?: boolean;
  /** Resume snapshot: relayed by the server on a resume spawn only
   *  (ADR-0014 F1 追補, phase-15 D8). Passed through to the wrapper via
   *  config.resume_snapshot so the wrapper can stamp ext.resume_snapshot
   *  / ext.resume_drift on its first state_change. */
  resumeSnapshot?: ResolvedSnapshotExt;
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
  sendResult: (result: SpawnResult) => void;
  sendSessions: (sessions: RunnerSessions) => void;
  /** phase-17 17-5: report a session-reset outcome (ADR-0036 F7). Required
   *  now the supervisor can handle a `reset_session` command; the CLI
   *  wires this to `RunnerLink.sendResetResult`. */
  sendResetResult: (result: SessionResetResult) => void;
  /** Injectable for tests; defaults read the local session stores
   *  (sessions.ts — Claude JSONLs / codex rollouts, per engine). */
  listSessions?: (cwd: string, engine: EngineKind) => SessionMeta[];
  sessionExists?: (cwd: string, sessionId: string, engine: EngineKind) => boolean;
  /** Clock in ms for the restart window; injectable for tests. Defaults to
   *  Date.now. */
  now?: () => number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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
  if (payload.server_url !== undefined && typeof payload.server_url !== "string") {
    return null;
  }
  // engine (ADR-0032 F4a): absent = claude-code; an unknown value is a
  // fail-loud reject, not a silent fallback to the wrong engine.
  let engine: EngineKind = "claude-code";
  if (payload.engine !== undefined) {
    if (payload.engine !== "claude-code" && payload.engine !== "codex") {
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
  // Resume snapshot (ADR-0014 F1 追補, phase-15 D8): loose shape check —
  // an object at the top level is enough. Fields are optional and their
  // value types (strings/booleans) get validated where they are read.
  if (payload.resume_snapshot !== undefined) {
    if (!isObject(payload.resume_snapshot)) return null;
    parsed.resumeSnapshot = payload.resume_snapshot as ResolvedSnapshotExt;
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
): WrapperConfig {
  const config: WrapperConfig = {
    agent_id: agentId,
    persona: parsed.persona,
    server_url: parsed.serverUrl ?? fallbackServerUrl,
  };
  if (parsed.token !== undefined) config.server_token = parsed.token;
  // Launch-time picks (ADR-0032 F4bc / ADR-0033 F3). Engines ignore the
  // fields that are not theirs (sandbox on Claude, permission_mode on codex).
  if (parsed.model !== undefined) config.model = parsed.model;
  if (parsed.effort !== undefined) config.effort = parsed.effort;
  if (parsed.engine === "codex") {
    if (codexAuthMode !== undefined) config.codex_auth_mode = codexAuthMode;
    if (codexChatgptPlan !== undefined) {
      config.codex_chatgpt_plan = codexChatgptPlan;
    }
  }
  if (parsed.permissionMode !== undefined) {
    config.permission_mode = parsed.permissionMode;
  }
  if (parsed.sandbox !== undefined) config.sandbox = parsed.sandbox;
  if (parsed.networkAccess !== undefined) {
    config.network_access = parsed.networkAccess;
  }
  if (parsed.resumeSnapshot !== undefined) {
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
}

export class Supervisor {
  readonly #hostId: string;
  #cwdAllowlist: string[];
  readonly #launch: LaunchFn;
  readonly #sendResult: (result: SpawnResult) => void;
  readonly #sendSessions: (sessions: RunnerSessions) => void;
  readonly #sendResetResult: (result: SessionResetResult) => void;
  readonly #listSessions: (cwd: string, engine: EngineKind) => SessionMeta[];
  readonly #sessionExists: (
    cwd: string,
    sessionId: string,
    engine: EngineKind,
  ) => boolean;
  readonly #now: () => number;
  #wrapperServerUrl: string;
  #codexAuthMode: CodexAuthMode | undefined;
  #codexChatgptPlan: ChatGptPlan | undefined;
  readonly #children = new Map<string, ChildEntry>();
  /** session_ids currently being resumed — the F4 local lock against a second
   *  concurrent resume of the same session. */
  readonly #activeSessions = new Set<string>();

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
    this.#wrapperServerUrl = options.wrapperServerUrl;
    this.#codexAuthMode = options.codexAuthMode;
    this.#codexChatgptPlan = options.codexChatgptPlan;
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
    const parsed = parseSpawn(payload);
    if (parsed === null) {
      this.#fail(agentId, "error");
      return;
    }
    if (!isCwdAllowed(parsed.cwd, this.#cwdAllowlist)) {
      this.#fail(agentId, "cwd_not_found");
      return;
    }
    if (this.#children.has(agentId)) {
      this.#fail(agentId, "already_running");
      return;
    }
    const resume = parsed.resumeSessionId;
    if (resume !== undefined) {
      // T3: the resume target must exist in the engine's session store
      // under the bound cwd.
      if (!this.#sessionExists(parsed.cwd, resume, parsed.engine)) {
        process.stderr.write(
          `runner: resume session not found under cwd (agent ${agentId})\n`,
        );
        this.#fail(agentId, "error");
        return;
      }
      // F4: physically block a second concurrent resume of the same session.
      if (this.#activeSessions.has(resume)) {
        this.#fail(agentId, "already_running");
        return;
      }
      this.#activeSessions.add(resume);
    }
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
      this.#fail(agentId, "error");
      return;
    }
    this.#sendResult({
      version: "0",
      host_id: this.#hostId,
      agent_id: agentId,
      ok: true,
    });
  }

  /** Handles a server `stop`: a deliberate exit, no auto-restart. */
  handleStop(payload: unknown): void {
    const agentId = readAgentId(payload);
    if (agentId === null) return;
    const entry = this.#children.get(agentId);
    if (entry === undefined) return;
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
    const resume = optionalString(payload.resume_session_id);
    if (resume === undefined || resume === "") {
      this.#fail(agentId, "error");
      return;
    }
    // T3 under the agent's currently bound cwd — the operator picked the id
    // from the same cwd's enumerate; re-verify at the boundary so a spoofed
    // or stale id cannot slip past.
    if (!this.#sessionExists(entry.parsed.cwd, resume, entry.parsed.engine)) {
      process.stderr.write(
        `runner: switch_session target not found under cwd (agent ${agentId})\n`,
      );
      this.#fail(agentId, "error");
      return;
    }
    const old = entry.parsed.resumeSessionId;
    // F4: another agent already resuming the target session blocks the swap.
    // Self (same session already bound) is a no-op we could early-return, but
    // proceeding to cycle the wrapper matches the intent of an explicit swap
    // click (drop stale in-memory state), so we only guard against a foreign
    // holder.
    if (resume !== old && this.#activeSessions.has(resume)) {
      this.#fail(agentId, "already_running");
      return;
    }
    if (old !== undefined && old !== resume) this.#activeSessions.delete(old);
    this.#activeSessions.add(resume);
    // Resume snapshot (ADR-0014 F1 追補, phase-15 D8): the server may attach
    // the swapped-in session's stored snapshot on switch_session; carry it
    // through so the relaunched wrapper stamps ext.resume_snapshot /
    // ext.resume_drift instead of retaining the original spawn-time value
    // (post-review Finding 2). Absent = keep the previous parsed value —
    // the wrapper still had a snapshot for the original session.
    const nextSnapshot: ResolvedSnapshotExt | undefined = isObject(payload) &&
      isObject(payload.resume_snapshot)
      ? (payload.resume_snapshot as ResolvedSnapshotExt)
      : entry.parsed.resumeSnapshot;
    entry.parsed = {
      ...entry.parsed,
      resumeSessionId: resume,
      ...(nextSnapshot !== undefined ? { resumeSnapshot: nextSnapshot } : {}),
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
    const previousSessionId = optionalString(payload.previous_session_id);
    // Capture the spawn-time F4-lock holder BEFORE stripping it below;
    // #relaunchForReset releases it on success and #rollback transfers
    // it to rollbackSid if the two differ (mirrors handleSwitchSession
    // add/delete lock transfer, which the reset diff must not break).
    const oldResumeSessionId = entry.parsed.resumeSessionId;
    // Stash the pending reset BEFORE mutating entry.parsed, so a
    // rollback triggered by an early kill/exit still has the id.
    entry.pendingReset = {
      requestId,
      mode: mode as SessionResetMode,
      ...(previousSessionId !== undefined
        ? { previousSessionId }
        : {}),
      ...(oldResumeSessionId !== undefined
        ? { oldResumeSessionId }
        : {}),
    };
    // Fresh: strip resumeSessionId so #relaunchForReset launches without
    // --resume. resumeSnapshot stays (phase-15 D8 last-effective values).
    // Destructure-and-drop instead of assigning `undefined` because the
    // ParsedSpawn type uses exactOptionalPropertyTypes.
    const { resumeSessionId: _drop, ...withoutResume } = entry.parsed;
    void _drop;
    entry.parsed = withoutResume;
    // Intentional cycle (same as handleRestart / handleSwitchSession):
    // reset the crash budget so the deliberate kill does not count.
    entry.restarting = true;
    entry.restarts = 0;
    entry.windowStart = this.#now();
    entry.child.kill();
  }

  /** Handles a server `enumerate_sessions`: lists resume candidates under cwd
   *  and replies with `sessions`. Only allow-listed cwds are enumerated, so an
   *  operator cannot probe arbitrary paths. */
  handleEnumerate(payload: unknown): void {
    if (!isObject(payload)) return;
    const cwd = payload.cwd;
    if (typeof cwd !== "string") return;
    // engine scopes the listing to one session store (ADR-0032 F8);
    // absent = claude-code, unknown values fall back to an empty list.
    let engine: EngineKind = "claude-code";
    if (payload.engine !== undefined) {
      if (payload.engine !== "claude-code" && payload.engine !== "codex") {
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
    const sessions = isCwdAllowed(cwd, this.#cwdAllowlist)
      ? this.#listSessions(cwd, engine)
      : [];
    this.#sendSessions({
      version: "0",
      host_id: this.#hostId,
      cwd,
      sessions,
      engine,
    });
  }

  /** Stops every child (deliberate); used on runner shutdown. */
  stopAll(): void {
    for (const entry of this.#children.values()) {
      entry.stopping = true;
      entry.child.kill();
    }
  }

  #fail(agentId: string, reason: SpawnFailReason): void {
    this.#sendResult({
      version: "0",
      host_id: this.#hostId,
      agent_id: agentId,
      ok: false,
      reason,
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

  #onExit(agentId: string): void {
    const entry = this.#children.get(agentId);
    if (entry === undefined) return;

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
