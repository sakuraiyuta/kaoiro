// kaoiro shared protocol types (TS source of truth).
//
// The on-the-wire envelope and the wrapper init contract, spoken by every
// wrapper variant (Claude/codex/...) and the runner. Mirrors
// docs/specs/protocol.md and the related ADRs. SDK-coupled and adapter-internal
// types stay in each wrapper, not here.

/** State set v0 (protocol.md), plus `sending` which a wrapper raises
 *  locally when it accepts an instruction (#32). `disconnected` is derived
 *  server-side and is therefore not handled by a wrapper. */
export type KaoiroState =
  | "idle"
  | "sending"
  | "thinking"
  | "tool_running"
  | "waiting_permission"
  | "waiting_input"
  | "done"
  | "error";

/** log payload kind (protocol.md). assistant=model speech, tool_use=tool
 *  call, tool_result=tool output, user=operator instruction echoed into the
 *  transcript (#31). thinking is intentionally not relayed. */
export type LogKind = "assistant" | "tool_use" | "tool_result" | "user";

/** payload of a type="log" envelope (protocol.md). The fields present
 *  depend on `kind`; `truncated` flags wrapper-side size clipping. */
export interface LogPayload {
  kind: LogKind;
  text?: string;
  tool_name?: string;
  /** Links a tool_use to its tool_result so clients can pair them (#40).
   *  Present on tool_use / tool_result lines when the SDK supplied an id. */
  tool_use_id?: string;
  input?: Record<string, unknown>;
  output?: string;
  truncated?: boolean;
}

/** payload of a type="result" envelope (protocol.md): the turn's final
 *  reply, with is_error marking an error termination. */
export interface ResultPayload {
  text?: string;
  is_error?: boolean;
}

/** Assigned persona (protocol.md / ADR-0003). */
export interface Persona {
  id: string;
  name: string;
  sprite_set: string;
}

/** Wrapper init config. agent_id is a stable id, constant across restarts.
 *  server_url, when set, points the wrapper at the kaoiro server's wrapper
 *  socket (ws:// or wss://); omitted = local-only (no relay). Shared with the
 *  runner, which resolves it to spawn a wrapper (ADR-0023). */
export interface WrapperConfig {
  agent_id: string;
  persona: Persona;
  server_url?: string;
  /** Wrapper auth token, paired with agent_id on the server (ADR-0011). */
  server_token?: string;
  /** permission_request no-response window before the default deny
   *  (ADR-0011 / ADR-0022; defaults to no timeout = wait until the
   *  operator decides, matching the SDK's canUseTool behaviour). A
   *  finite value opts into fail-closed deny after that many ms. */
  permission_timeout_ms?: number;
  /** Tool-permission ceiling passed to the SDK as allowedTools. Local
   *  config only — cannot be widened from the server side
   *  (specs/threat-model.md). Omitted = the CLI's read-only default. */
  allowed_tools?: string[];
}

/** state_change.ext.pending_permission shape (ADR-0022, #59). The
 *  authoritative pending-permission record carried on every state_change
 *  while waiting_permission, so a permission dialog survives any other
 *  envelope arriving in between. Mirrors the legacy permission_request
 *  envelope's payload (kept as initial-notification per ADR-0022 F2). */
export interface PendingPermissionExt {
  request_id: string;
  tool_name: string;
  input?: Record<string, unknown>;
  truncated?: boolean;
  ts: string;
}

/**
 * Common event envelope v0 (protocol.md). The type enum fixes
 * state_change / permission_request (ADR-0010/0011) and log / result
 * (ADR-0012). payload stays loosely typed; the per-type shapes are
 * LogPayload / ResultPayload above.
 */
export interface Envelope {
  version: "0";
  agent_id: string;
  /** SDK conversation session id (protocol.md / ADR-0014; one agent_id : N
   *  session_id). Stamped by ServerLink at send time alongside seq; absent
   *  until the SDK reports one, and on envelopes that never go to a server. */
  session_id?: string;
  persona: Persona;
  ts: string;
  /** Wrapper-issued monotonic sequence (ADR-0011), stamped by ServerLink
   *  at send time; absent on envelopes that never go to a server. */
  seq?: number;
  type: "state_change" | "permission_request" | "log" | "result";
  state: KaoiroState;
  payload: Record<string, unknown>;
  ext: Record<string, unknown>;
}

// Runner control messages (protocol.md "runner 制御メッセージ", #66 / ADR-0023).
// A resident runner connects on topic `runner:<host_id>`, a separate system
// from the wrapper data path. `version` is the flat outer key (ADR-0015), "0"
// for now. The spawn/stop/restart/enumerate and sessions/spawn_result shapes
// are added with the phases that consume them.

/** runner -> server, once per (re)connection: declares the host's spawnable
 *  personas and the operator-selectable cwd allow-list (#22). capabilities
 *  lists the engine kinds the host can run (e.g. ["claude"]). */
export interface RunnerRegister {
  version: "0";
  host_id: string;
  personas: Persona[];
  cwd_allowlist: string[];
  capabilities?: string[];
}

/** runner -> server liveness ping; the topic carries the host_id, but it is
 *  sent in the payload too per the protocol.md schema. */
export interface RunnerHeartbeat {
  version: "0";
  host_id: string;
}

/** server -> runner, operator-only: launch a wrapper for agent_id. The server
 *  relays the operator's payload verbatim (minus host_id), so server_url/token
 *  are operator-supplied. cwd must be in the host's allow-list (T1).
 *  resume_session_id requests a resume (honored in a later phase, with the
 *  existence check (T3) and the local lock (F4)). */
export interface SpawnMessage {
  version: "0";
  agent_id: string;
  persona: Persona;
  cwd: string;
  server_url: string;
  token?: string;
  resume_session_id?: string;
}

/** server -> runner, operator-only: stop the wrapper for agent_id. */
export interface StopMessage {
  version: "0";
  agent_id: string;
}

/** server -> runner, operator-only: restart the wrapper for agent_id. */
export interface RestartMessage {
  version: "0";
  agent_id: string;
}

/** Why a spawn failed (protocol.md). already_running = a live wrapper already
 *  owns the agent_id; cwd_not_found = the cwd is not in the host's allow-list;
 *  error = any other failure. */
export type SpawnFailReason = "already_running" | "cwd_not_found" | "error";

/** runner -> server: the outcome of a spawn; reason is set only on failure. */
export interface SpawnResult {
  version: "0";
  host_id: string;
  agent_id: string;
  ok: boolean;
  reason?: SpawnFailReason;
}
