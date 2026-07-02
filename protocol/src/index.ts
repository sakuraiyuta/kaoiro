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

/** Wire-safe subset of Persona used in every network-facing type
 *  (Envelope, RunnerRegister, SpawnMessage, and any future wire shape).
 *  Config-only fields on {@link Persona} stay wrapper-local — a local
 *  filesystem path must never leave the wrapper
 *  (persona-personality-injection MUST / ADR-0026 "Envelope 非露出"). */
export interface WirePersona {
  id: string;
  name: string;
  sprite_set: string;
}

/** Assigned persona (protocol.md / ADR-0003). The full config-level view
 *  including optional personality/language fields that {@link WirePersona}
 *  intentionally omits. */
export interface Persona extends WirePersona {
  /** Path to a Markdown file with the persona's personality prompt
   *  (口調・一人称・語尾・返答スタイル). Relative paths resolve from the
   *  config file's directory. When unset the wrapper falls back to
   *  `<wrapper-root>/personas/<id>.md`; when that also does not exist,
   *  no personality is appended (persona-personality-injection spec /
   *  ADR-0026). */
  personality_prompt_file?: string;
  /** Language hint for the personality prompt (BCP-47 or short code).
   *  Phase-0 only carries this value; multilingual dispatch is deferred
   *  to persona-language-dispatch (ADR-0026 D4). Default when consumed:
   *  "ja". */
  language?: string;
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
  /** Initial SDK permission mode (#58). Omitted = `default`. The server may
   *  override this on join by pushing the last operator-persisted choice for
   *  this agent_id. `bypassPermissions` requires explicit config opt-in:
   *  the wrapper sets `allowDangerouslySkipPermissions: true` only when this
   *  field is `bypassPermissions` at startup; a mid-session switch INTO
   *  bypass via the dashboard fails closed unless the wrapper was started
   *  with it. */
  permission_mode?: PermissionMode;
  /** Tool-permission ceiling passed to the SDK as allowedTools. Local
   *  config only — cannot be widened from the server side
   *  (specs/threat-model.md). Omitted = the CLI's read-only default. */
  allowed_tools?: string[];
}

/** Closed enum of SDK PermissionMode values (#58). Mirrors the SDK union
 *  type so the wrapper, server, and dashboard share one definition. The
 *  protocol package is types-only (no runtime exports); consumers that need
 *  the value list duplicate it locally (wrapper/src/persona.ts,
 *  agents_channel.ex). */
export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto";

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
 * state_change / permission_request (ADR-0010/0011), log / result
 * (ADR-0012), and attach_rejected / instruction_rejected (ADR-0025).
 * payload stays loosely typed; the per-type shapes are
 * LogPayload / ResultPayload / Attach*Payload above.
 */
export interface Envelope {
  version: "0";
  agent_id: string;
  /** SDK conversation session id (protocol.md / ADR-0014; one agent_id : N
   *  session_id). Stamped by ServerLink at send time alongside seq; absent
   *  until the SDK reports one, and on envelopes that never go to a server. */
  session_id?: string;
  persona: WirePersona;
  ts: string;
  /** Wrapper-issued monotonic sequence (ADR-0011), stamped by ServerLink
   *  at send time; absent on envelopes that never go to a server. */
  seq?: number;
  type:
    | "state_change"
    | "permission_request"
    | "log"
    | "result"
    | "attach_rejected"
    | "instruction_rejected"
    | "inter_agent_message";
  state: KaoiroState;
  payload: Record<string, unknown>;
  ext: Record<string, unknown>;
}

/** reason enum for attach_rejected / instruction_rejected (file-upload spec,
 *  ADR-0025 F9). Single source of truth for both envelopes. */
export type FileUploadRejectReason =
  | "size_over"
  | "mime_denied"
  | "count_over"
  | "timeout"
  | "interrupted"
  | "unfittable_image"
  | "unfittable_pdf"
  | "text_too_large"
  | "total_request_over"
  | "sdk_error";

/** payload of a type="attach_rejected" envelope (file-upload spec / ADR-0025
 *  F9). Individual upload rejection. */
export interface AttachRejectedPayload {
  upload_id: string;
  reason: FileUploadRejectReason;
  detail?: string;
}

/** payload of a type="instruction_rejected" envelope (file-upload spec /
 *  ADR-0025 F9). Whole-instruction rejection (e.g. SDK error, total over). */
export interface InstructionRejectedPayload {
  attachment_ids?: string[];
  reason: FileUploadRejectReason;
  detail?: string;
}

/** Closed enum of inter-agent message kinds (protocol-inter-agent spec). 9
 *  kinds derived from FIPA-ACL performatives, compressed to cover request /
 *  response / consultation (query+inform) / discussion
 *  (propose/accept/reject) plus tie-breaker (escalate-to-user) and
 *  termination (done). */
export type InterAgentMessageKind =
  | "request"
  | "response"
  | "query"
  | "inform"
  | "propose"
  | "accept"
  | "reject"
  | "escalate-to-user"
  | "done";

/** payload of a type="inter_agent_message" envelope (protocol-inter-agent
 *  spec). The sender lives in the surrounding envelope's `agent_id`; `to`
 *  is the destination agent_id used by the server for routing. `meta.done`
 *  must be true from both owner-side agents for the conversation to
 *  complete; `meta.reject_reason` is required when `kind === "reject"`. */
export interface InterAgentMessagePayload {
  to: string;
  conversation_id: string;
  turn_number: number;
  kind: InterAgentMessageKind;
  body: string;
  meta: {
    done: boolean;
    propose_next: string;
    confidence?: number;
    reject_reason?: string;
  };
  owner: {
    kind: "user" | "agent";
    id: string;
  };
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
  personas: WirePersona[];
  cwd_allowlist: string[];
  capabilities?: string[];
}

/** runner -> server liveness ping; the topic carries the host_id, but it is
 *  sent in the payload too per the protocol.md schema. */
export interface RunnerHeartbeat {
  version: "0";
  host_id: string;
}

/** server -> runner, operator-only: launch a wrapper for agent_id. Under案A
 *  (ADR-0024) the server fills the sensitive fields: it allocates agent_id and
 *  mints the per-agent `token`; the operator only chose host/persona/cwd. cwd
 *  must be in the host's allow-list (T1). `server_url` is optional — when the
 *  server omits it, the runner supplies the wrapper socket URL from its own
 *  config (it already knows how to reach the server). `initial_prompt`, when
 *  set, is the wrapper's first turn. `resume_session_id` requests a resume
 *  (with the existence check (T3) and the local lock (F4)). */
export interface SpawnMessage {
  version: "0";
  agent_id: string;
  persona: WirePersona;
  cwd: string;
  server_url?: string;
  token?: string;
  initial_prompt?: string;
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

/** server -> runner, operator-only: list the resume candidates under cwd for
 *  agent_id (ADR-0014 F2). */
export interface EnumerateSessions {
  version: "0";
  agent_id: string;
  cwd: string;
}

/** Minimal per-session metadata (T2: minimal, operator-only). mtime is the
 *  JSONL file's last-modified time; summary is optional and may be absent. */
export interface SessionMeta {
  session_id: string;
  summary?: string;
  mtime?: string;
}

/** runner -> server: the resume candidates under cwd (response to
 *  enumerate_sessions, ADR-0014 F2). Forwarded operator-only by the server. */
export interface RunnerSessions {
  version: "0";
  host_id: string;
  cwd: string;
  sessions: SessionMeta[];
}
