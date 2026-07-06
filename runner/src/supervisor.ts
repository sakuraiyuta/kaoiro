// Process supervisor (ADR-0023, phases 4-4b/4-5). Owns the host's wrapper child
// processes: spawns a wrapper per `spawn`, restarts a crashed one (isolated
// from siblings), stops/restarts on operator command, enumerates resume
// candidates, and resumes a session — gated by the T3 existence check and the
// F4 same-session local lock. The child launch is injected so the supervision
// logic is testable without real processes (default launcher: spawn.ts).

import type {
  RunnerSessions,
  SessionMeta,
  SpawnFailReason,
  SpawnResult,
  WirePersona,
  WrapperConfig,
} from "@kaoiro/protocol";
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
) => ManagedChild;

/** The validated fields of a `spawn` message the supervisor acts on. serverUrl
 *  is optional: under案A the server omits it and the runner falls back to its
 *  own wrapper URL (ADR-0024). */
export interface ParsedSpawn {
  persona: WirePersona;
  cwd: string;
  serverUrl?: string;
  token?: string;
  initialPrompt?: string;
  resumeSessionId?: string;
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
  sendResult: (result: SpawnResult) => void;
  sendSessions: (sessions: RunnerSessions) => void;
  /** Injectable for tests; defaults read the local Claude JSONLs (sessions.ts). */
  listSessions?: (cwd: string) => SessionMeta[];
  sessionExists?: (cwd: string, sessionId: string) => boolean;
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
  const parsed: ParsedSpawn = {
    persona,
    cwd: payload.cwd,
  };
  const serverUrl = optionalString(payload.server_url);
  if (serverUrl !== undefined && serverUrl !== "") parsed.serverUrl = serverUrl;
  const token = optionalString(payload.token);
  if (token !== undefined) parsed.token = token;
  const prompt = optionalString(payload.initial_prompt);
  if (prompt !== undefined && prompt !== "") parsed.initialPrompt = prompt;
  const resume = optionalString(payload.resume_session_id);
  if (resume !== undefined) parsed.resumeSessionId = resume;
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
): WrapperConfig {
  const config: WrapperConfig = {
    agent_id: agentId,
    persona: parsed.persona,
    server_url: parsed.serverUrl ?? fallbackServerUrl,
  };
  if (parsed.token !== undefined) config.server_token = parsed.token;
  return config;
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
}

export class Supervisor {
  readonly #hostId: string;
  readonly #cwdAllowlist: string[];
  readonly #launch: LaunchFn;
  readonly #sendResult: (result: SpawnResult) => void;
  readonly #sendSessions: (sessions: RunnerSessions) => void;
  readonly #listSessions: (cwd: string) => SessionMeta[];
  readonly #sessionExists: (cwd: string, sessionId: string) => boolean;
  readonly #now: () => number;
  readonly #wrapperServerUrl: string;
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
    this.#listSessions = options.listSessions ?? defaultListSessions;
    this.#sessionExists = options.sessionExists ?? defaultSessionExists;
    this.#now = options.now ?? (() => Date.now());
    this.#wrapperServerUrl = options.wrapperServerUrl;
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
      // T3: the resume target must exist as a JSONL under the bound cwd.
      if (!this.#sessionExists(parsed.cwd, resume)) {
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
    if (!this.#sessionExists(entry.parsed.cwd, resume)) {
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
    entry.parsed = { ...entry.parsed, resumeSessionId: resume };
    // Take the same restart path a `restart` uses: reset the crash budget
    // (this is a deliberate cycle, not a crash) and kill; #onExit sees
    // restarting=true and routes into #relaunch, which re-reads entry.parsed
    // so the new resume_session_id rides the fresh wrapper.
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
    const sessions = isCwdAllowed(cwd, this.#cwdAllowlist)
      ? this.#listSessions(cwd)
      : [];
    this.#sendSessions({ version: "0", host_id: this.#hostId, cwd, sessions });
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
      resolveWrapperConfig(agentId, parsed, this.#wrapperServerUrl),
      parsed.cwd,
      parsed.resumeSessionId,
      parsed.initialPrompt,
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
        resolveWrapperConfig(agentId, entry.parsed, this.#wrapperServerUrl),
        entry.parsed.cwd,
        entry.parsed.resumeSessionId,
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
}
