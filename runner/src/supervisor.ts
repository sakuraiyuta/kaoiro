// Process supervisor (ADR-0023, phase 4-4b). Owns the host's wrapper child
// processes: it spawns a wrapper per `spawn`, restarts a crashed one (isolated
// from its siblings), and stops/restarts on operator command. The actual child
// launch (temp config + child_process.spawn) is injected so the supervision
// logic is testable without real processes; the default launcher lives in
// spawn.ts.
//
// resume_session_id, session enumeration, and the local same-session lock are
// out of scope here (phase 4-5): a spawn carrying resume_session_id is rejected
// until the existence check (T3) and lock (F4) land.

import type {
  Persona,
  SpawnFailReason,
  SpawnResult,
  WrapperConfig,
} from "@kaoiro/protocol";

/** Cap on automatic restarts after crashes, per agent. A wrapper that keeps
 *  crashing is left down rather than hot-looped; an explicit `restart` resets
 *  the count. (A time-windowed budget is a possible follow-up.) */
export const MAX_RESTARTS = 5;

/** agent_id rides a temp config filename and the spawn_result, so its charset
 *  is restricted exactly like the server's AgentId guard (no path separators). */
const AGENT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** The minimal child handle the supervisor needs; ChildProcess satisfies it. */
export interface ManagedChild {
  on(event: "exit", listener: () => void): void;
  kill(): void;
}

/** Launches one wrapper child for the resolved config in the given cwd. */
export type LaunchFn = (
  agentId: string,
  config: WrapperConfig,
  cwd: string,
) => ManagedChild;

/** The validated fields of a `spawn` message the supervisor acts on. */
export interface ParsedSpawn {
  persona: Persona;
  cwd: string;
  serverUrl: string;
  token?: string;
  resumeSessionId?: string;
}

export interface SupervisorOptions {
  hostId: string;
  cwdAllowlist: string[];
  launch: LaunchFn;
  sendResult: (result: SpawnResult) => void;
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

function parsePersona(value: unknown): Persona | null {
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
  if (typeof payload.server_url !== "string" || payload.server_url === "") {
    return null;
  }
  const parsed: ParsedSpawn = {
    persona,
    cwd: payload.cwd,
    serverUrl: payload.server_url,
  };
  const token = optionalString(payload.token);
  if (token !== undefined) parsed.token = token;
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
 *  read-only default. */
export function resolveWrapperConfig(
  agentId: string,
  parsed: ParsedSpawn,
): WrapperConfig {
  const config: WrapperConfig = {
    agent_id: agentId,
    persona: parsed.persona,
    server_url: parsed.serverUrl,
  };
  if (parsed.token !== undefined) config.server_token = parsed.token;
  return config;
}

interface ChildEntry {
  child: ManagedChild;
  parsed: ParsedSpawn;
  restarts: number;
  stopping: boolean;
  restarting: boolean;
}

export class Supervisor {
  readonly #hostId: string;
  readonly #cwdAllowlist: string[];
  readonly #launch: LaunchFn;
  readonly #sendResult: (result: SpawnResult) => void;
  readonly #children = new Map<string, ChildEntry>();

  constructor(options: SupervisorOptions) {
    this.#hostId = options.hostId;
    this.#cwdAllowlist = options.cwdAllowlist;
    this.#launch = options.launch;
    this.#sendResult = options.sendResult;
  }

  /** Handles a server `spawn`: validates, enforces the cwd allow-list and the
   *  agent_id-level dedup, launches the wrapper, and reports the outcome. */
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
    if (parsed.resumeSessionId !== undefined) {
      // resume needs the existence check (T3) and lock (F4), landing in 4-5.
      process.stderr.write(
        `runner: resume not yet supported (agent ${agentId})\n`,
      );
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
    try {
      this.#start(agentId, parsed);
    } catch (error) {
      // A synchronous launch failure (the config write or spawn raising) must
      // still surface to the operator and leave no stranded slot.
      process.stderr.write(
        `runner: launch failed for ${agentId}: ${String(error)}\n`,
      );
      this.#children.delete(agentId);
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
    entry.child.kill();
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
      resolveWrapperConfig(agentId, parsed),
      parsed.cwd,
    );
    const entry: ChildEntry = {
      child,
      parsed,
      restarts: 0,
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
      this.#children.delete(agentId);
      return;
    }
    if (entry.restarting) {
      entry.restarting = false;
      this.#relaunch(agentId, entry);
      return;
    }
    // Unexpected exit = crash: relaunch (isolated from siblings) until the cap.
    if (entry.restarts >= MAX_RESTARTS) {
      process.stderr.write(
        `runner: agent ${agentId} exceeded restart cap; leaving down\n`,
      );
      this.#children.delete(agentId);
      return;
    }
    entry.restarts += 1;
    this.#relaunch(agentId, entry);
  }

  #relaunch(agentId: string, entry: ChildEntry): void {
    const child = this.#launch(
      agentId,
      resolveWrapperConfig(agentId, entry.parsed),
      entry.parsed.cwd,
    );
    entry.child = child;
    child.on("exit", () => this.#onExit(agentId));
  }
}
