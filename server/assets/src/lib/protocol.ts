// kaoiro public-protocol client — plain TS, no Svelte dependency
// (ADR-0007). Speaks Phoenix Channels (vsn=2.0.0 via the official client,
// ADR-0009) and consumes the same API as any external client: join
// "agents:lobby", receive one "snapshot" push, then "envelope" broadcasts.
// Reconnect/heartbeat belong to the phoenix client; every successful
// (re)join yields a fresh snapshot (protocol.md re-sync rule).

import { Socket } from "phoenix";
import type { Channel } from "phoenix";

/** Envelope v0 frame (docs/specs/protocol.md). */
export interface Persona {
  id: string;
  name: string;
  sprite_set: string;
}

export interface Envelope {
  version: string;
  agent_id: string;
  /** SDK conversation session id (protocol.md / ADR-0014); absent until the
   * wrapper reports one. Used to group/clear the transcript by session. */
  session_id?: string;
  persona?: Persona;
  ts: string;
  /** Wrapper-issued monotonic sequence (ADR-0011); absent on
   * server-derived envelopes such as disconnected. */
  seq?: number;
  type: string;
  state: string;
  payload?: Record<string, unknown>;
  ext?: Record<string, unknown>;
}

/** Shape of a pending tool-permission request — carried on
 *  state_change.ext.pending_permission (ADR-0022, #59) as the
 *  authoritative source, and on the legacy permission_request envelope's
 *  payload as initial notification. `ts` is present on ext, optional on
 *  the legacy payload — the dashboard does not depend on it. */
export interface PermissionRequestPayload {
  request_id: string;
  tool_name: string;
  input?: Record<string, unknown>;
  truncated?: boolean;
  ts?: string;
}

/**
 * Reads ext.pending_permission off any envelope (ADR-0022 authoritative
 * source). Returns null when no pending decision is in flight or the
 * record is malformed. Carried on every state_change while
 * waiting_permission so the dialog survives intermediate state_change
 * envelopes that previously erased it (issue #59).
 */
export function pendingPermissionFrom(
  envelope: Envelope,
): PermissionRequestPayload | null {
  const ext = envelope.ext;
  if (typeof ext !== "object" || ext === null) return null;
  const pending = (ext as Record<string, unknown>).pending_permission;
  if (typeof pending !== "object" || pending === null) return null;
  const record = pending as Record<string, unknown>;
  if (
    typeof record.request_id !== "string" ||
    typeof record.tool_name !== "string"
  ) {
    return null;
  }
  return record as unknown as PermissionRequestPayload;
}

/** One option of an AskUserQuestion question (ADR-0027). */
export interface QuestionOption {
  label: string;
  description: string;
  preview?: string;
}

/** One AskUserQuestion question (SDK AskUserQuestionInput, ADR-0027). */
export interface Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

/** ext.pending_question shape (ADR-0027): the authoritative pending-question
 *  record carried on every state_change while waiting_question, twin of
 *  {@link PermissionRequestPayload}. */
export interface PendingQuestionPayload {
  request_id: string;
  questions: Question[];
  ts?: string;
}

/**
 * Reads ext.pending_question off any envelope (ADR-0027 authoritative
 * source). Returns null when no pending question is in flight or the record
 * is malformed. Twin of {@link pendingPermissionFrom}.
 */
export function pendingQuestionFrom(
  envelope: Envelope,
): PendingQuestionPayload | null {
  const ext = envelope.ext;
  if (typeof ext !== "object" || ext === null) return null;
  const pending = (ext as Record<string, unknown>).pending_question;
  if (typeof pending !== "object" || pending === null) return null;
  const record = pending as Record<string, unknown>;
  if (
    typeof record.request_id !== "string" ||
    !Array.isArray(record.questions)
  ) {
    return null;
  }
  return record as unknown as PendingQuestionPayload;
}

/** The engine-neutral two-axis permission posture (ADR-0033 F1), from
 *  agent-level ext.permission. Successor of ext.permission_mode. */
export interface PermissionAxes {
  sandbox: string;
  approval: string;
}

/** Reads ext.permission off an envelope, or null when absent/malformed. */
export function permissionFrom(envelope: Envelope): PermissionAxes | null {
  const raw = envelope.ext?.permission;
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as PermissionAxes;
  return typeof p.sandbox === "string" && typeof p.approval === "string"
    ? { sandbox: p.sandbox, approval: p.approval }
    : null;
}

/** Reads ext.engine (ADR-0032 F4a), or null when absent. */
export function engineFrom(envelope: Envelope): string | null {
  const raw = envelope.ext?.engine;
  return typeof raw === "string" && raw !== "" ? raw : null;
}

/** Reads ext.model_source (ADR-0032 F4bc addendum, phase-15 D1), or null
 *  when absent. Values are the resolution origin the wrapper stamped:
 *  "launch" | "env" | "config" | "default". UI reads this — NOT ext.engine —
 *  to tell whether the wrapper is on the engine's own default model
 *  (source="default") vs an explicit operator pick. */
export function modelSourceFrom(envelope: Envelope): string | null {
  const raw = envelope.ext?.model_source;
  return typeof raw === "string" && raw !== "" ? raw : null;
}

/** Reset modes for /new・/clear (ADR-0036 F1/F3, phase-17). Mirrors
 *  protocol.ts `SessionResetMode`; kept local so the client bundle stays
 *  self-contained per this file's plain-TS contract. */
export type SessionResetMode = "new" | "clear";

/** Closed vocabulary of session-reset failure reasons broadcast on the
 *  `session_reset_failed` event (ADR-0036 F7, phase-17). Mirrors
 *  protocol.ts `SessionResetErrorReason`; the value list is exported so
 *  UI code can exhaustive-match on the reason without redeclaring the
 *  literals (SSOT — kept in sync with the wrapper protocol). */
export const SESSION_RESET_ERROR_REASONS = [
  "agent_busy",
  "unsupported_session_reset",
  "session_reset_pending",
  "runner_unavailable",
  "spawn_failed",
  "rollback_failed",
  "timeout",
] as const;
export type SessionResetErrorReason =
  (typeof SESSION_RESET_ERROR_REASONS)[number];

/** Advertised session-level capabilities the wrapper stamps on every
 *  state_change (ADR-0034 F1/F2, ADR-0036 F5). Missing = fail-closed /
 *  "not supported" — the UI must not enable feature paths on absent
 *  capabilities. */
export interface SessionCapabilities {
  supports_attachments: boolean;
  supports_user_input_dialog: boolean;
  /** Optional constraint: dialog only fires in these permission_mode /
   *  sandbox contexts. Absent / empty = unconditional (matches on=true).
   *  When present the UI shows "conditional-off" when the current mode is
   *  not listed (ADR-0034 F3). */
  user_input_modes?: string[];
  /** Mid-session model / effort switching (ADR-0035 F4, phase-16).
   *  Missing or malformed values are normalized to false by the defensive
   *  parser so consumers remain fail-closed. */
  supports_model_switch?: boolean;
  supports_effort_switch?: boolean;
  /** Whether the session accepts /new・/clear as first-class reset control
   *  (ADR-0036 F5, phase-17). Absent = fail-closed unsupported. */
  supports_session_reset?: boolean;
  /** Which reset modes the session accepts when supports_session_reset is
   *  true (ADR-0036 F5, phase-17). Non-empty when supports=true; a
   *  true+missing/empty combination is fail-closed as invalid
   *  advertisement (the loose parser drops the modes so the availability
   *  judge falls into "unsupported"). */
  session_reset_modes?: SessionResetMode[];
}

/** Reads ext.session_capabilities off an envelope (ADR-0034 F1). Returns
 *  null when absent or malformed — fail-closed by contract, so a null
 *  return MUST be treated as "no capability" by every caller (never as
 *  "unknown, permit". Both required booleans must be present; malformed
 *  strings in user_input_modes are dropped. */
export function sessionCapabilitiesFrom(
  envelope: Envelope,
): SessionCapabilities | null {
  const raw = envelope.ext?.session_capabilities;
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.supports_attachments !== "boolean" ||
    typeof r.supports_user_input_dialog !== "boolean"
  ) {
    return null;
  }
  const out: SessionCapabilities = {
    supports_attachments: r.supports_attachments,
    supports_user_input_dialog: r.supports_user_input_dialog,
  };
  if (typeof r.supports_model_switch === "boolean") {
    out.supports_model_switch = r.supports_model_switch;
  }
  if (typeof r.supports_effort_switch === "boolean") {
    out.supports_effort_switch = r.supports_effort_switch;
  }
  if (Array.isArray(r.user_input_modes)) {
    const modes: string[] = [];
    for (const m of r.user_input_modes) if (typeof m === "string") modes.push(m);
    if (modes.length > 0) out.user_input_modes = modes;
  }
  // session_reset (ADR-0036 F5, phase-17). Parse defensively: only accept
  // supports=true when session_reset_modes is a non-empty array of the
  // closed vocabulary "new"|"clear". A true+missing/empty/malformed modes
  // stamp is fail-closed here by dropping BOTH fields — the availability
  // judge then treats it as "unsupported", matching the ADR's rule that
  // an invalid advertisement disables the command.
  if (typeof r.supports_session_reset === "boolean") {
    if (r.supports_session_reset === false) {
      out.supports_session_reset = false;
    } else if (Array.isArray(r.session_reset_modes)) {
      const modes: SessionResetMode[] = [];
      for (const m of r.session_reset_modes) {
        if (m === "new" || m === "clear") modes.push(m);
      }
      if (modes.length > 0) {
        out.supports_session_reset = true;
        out.session_reset_modes = modes;
      }
    }
  }
  return out;
}

export interface ModelSwitchState {
  pending_model: string | null;
  pending_effort: string | null;
  effort_reset: boolean;
  switch_error: {
    kind: "model" | "effort";
    requested: string;
    reason: string;
    rolled_back_to?: string;
  } | null;
}

export type SwitchError = NonNullable<ModelSwitchState["switch_error"]>;

/** Reads ext.switch_error, rejecting partial/malformed records. */
export function switchErrorFrom(envelope: Envelope): SwitchError | null {
  const raw = envelope.ext?.switch_error;
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (
    (e.kind !== "model" && e.kind !== "effort") ||
    typeof e.requested !== "string" ||
    typeof e.reason !== "string" ||
    e.reason === ""
  ) {
    return null;
  }
  return {
    kind: e.kind,
    requested: e.requested,
    reason: e.reason,
    ...(typeof e.rolled_back_to === "string"
      ? { rolled_back_to: e.rolled_back_to }
      : {}),
  };
}

/** Defensive reader for ADR-0035's pending/effective/rollback UI metadata. */
export function modelSwitchStateFrom(envelope: Envelope): ModelSwitchState {
  const ext = envelope.ext ?? {};
  return {
    pending_model:
      typeof ext.pending_model === "string" ? ext.pending_model : null,
    pending_effort:
      typeof ext.pending_effort === "string" ? ext.pending_effort : null,
    effort_reset: ext.effort_reset === true,
    switch_error: switchErrorFrom(envelope),
  };
}

/** Composer-side intercept rule for `/new`・`/clear` (ADR-0036 F1,
 *  phase-17 17-8). Returns the reset mode when the input should NOT be
 *  sent as a normal instruction but as a `session_reset` control event.
 *  Rules:
 *   - `trim(text)` must exactly equal `/new` or `/clear` (引数付き
 *     `/new hello` は通常 instruction)
 *   - attachments must be empty (attachment 付き `/new` は通常 instruction)
 *   - the resulting mode must be `"on"` per
 *     {@link sessionResetAvailability} (capability unstamped / false /
 *     conditional-off = fall through as ordinary instruction)
 *  Returns `null` when the input is a normal instruction. Extracted so
 *  the Composer's send path stays a single-line branch and the rule is
 *  unit-testable without a Svelte harness. */
export function shouldInterceptAsSessionReset(
  text: string,
  attachmentIds: string[] | undefined,
  caps: SessionCapabilities | null,
): SessionResetMode | null {
  if (attachmentIds !== undefined && attachmentIds.length > 0) return null;
  const trimmed = text.trim();
  const mode: SessionResetMode | null =
    trimmed === "/new" ? "new" : trimmed === "/clear" ? "clear" : null;
  if (mode === null) return null;
  return sessionResetAvailability(caps, mode) === "on" ? mode : null;
}

/** Session-reset availability given the capability envelope and the
 *  requested mode (ADR-0036 F5, phase-17). Mirrors the 3-value shape of
 *  {@link userInputDialogAvailability} so the composer can share render
 *  logic. Values:
 *   - "unsupported"     : caps absent, supports_session_reset absent/false,
 *                         or supports=true+empty/malformed modes (the
 *                         parser already collapses invalid advertisements
 *                         into this bucket)
 *   - "conditional-off" : supports=true but the requested `mode` is not
 *                         in session_reset_modes
 *   - "on"              : supports=true AND `mode` is in session_reset_modes
 *  Fail-closed by contract — a null return from sessionCapabilitiesFrom
 *  or a missing field must map to "unsupported" (the composer must not
 *  intercept, the server must not relay). */
export function sessionResetAvailability(
  caps: SessionCapabilities | null,
  mode: SessionResetMode,
): "unsupported" | "conditional-off" | "on" {
  if (!caps || !caps.supports_session_reset) return "unsupported";
  const modes = caps.session_reset_modes;
  if (!modes || modes.length === 0) return "unsupported";
  return modes.includes(mode) ? "on" : "conditional-off";
}

/** AskUserQuestion dialog availability given the capability envelope and
 *  the operator's current permission_mode (ADR-0034 F3, phase-15 D5). Both
 *  adapters currently advertise unconditional `true` so this returns "on"
 *  for existing engines; the judge exists so a future adapter can
 *  advertise conditional availability without another UI rewrite. Values:
 *   - "unsupported"     : caps absent OR supports_user_input_dialog=false
 *   - "conditional-off" : dialog=true, user_input_modes specified but
 *                         `currentMode` is not in the list
 *   - "on"              : dialog=true AND (user_input_modes absent OR
 *                         includes `currentMode`)
 *  `currentMode` may be null when init has not landed; that reads the
 *  same as "no mode set" — the guard returns "conditional-off" only when
 *  the modes list is present and no match exists. */
export function userInputDialogAvailability(
  caps: SessionCapabilities | null,
  currentMode: string | null,
): "unsupported" | "conditional-off" | "on" {
  if (!caps || !caps.supports_user_input_dialog) return "unsupported";
  const modes = caps.user_input_modes;
  if (!modes || modes.length === 0) return "on";
  if (currentMode !== null && modes.includes(currentMode)) return "on";
  return "conditional-off";
}

/** One drifted field in a resume launch, comparing prev (the snapshot's
 *  last-effective value) vs now (this launch's effective value). `unknown`
 *  types because different fields carry different value shapes (string,
 *  boolean, enum). ADR-0014 F1 addendum + phase-15 D8. */
export interface ResumeDriftEntry {
  field: string;
  prev: unknown;
  now: unknown;
}

/** Reads ext.resume_drift off an envelope (ADR-0014 F1 addendum, phase-15
 *  D8). Returns null on a fresh spawn (field absent), empty array on a
 *  resume with no drift, and one entry per differing field otherwise.
 *  Malformed entries are dropped rather than surfacing bad UI. */
export function resumeDriftFrom(envelope: Envelope): ResumeDriftEntry[] | null {
  const raw = envelope.ext?.resume_drift;
  if (!Array.isArray(raw)) return null;
  const out: ResumeDriftEntry[] = [];
  for (const entry of raw) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { field?: unknown }).field === "string"
    ) {
      const e = entry as { field: string; prev: unknown; now: unknown };
      out.push({ field: e.field, prev: e.prev, now: e.now });
    }
  }
  return out;
}

/** Claude mode -> two-axis display annotation (ADR-0033 F2/F4: the picker
 *  stays engine-native, each option annotated with its two-axis reading).
 *  Mirrors the wrapper's PERMISSION_MODE_AXES table. */
export const PERMISSION_MODE_AXES: Record<string, PermissionAxes> = {
  default: { sandbox: "workspace-write", approval: "untrusted" },
  acceptEdits: { sandbox: "workspace-write", approval: "on-request" },
  plan: { sandbox: "read-only", approval: "on-request" },
  bypassPermissions: { sandbox: "danger-full-access", approval: "never" },
  dontAsk: { sandbox: "workspace-write", approval: "never" },
  auto: { sandbox: "workspace-write", approval: "on-request" },
};

/** A selectable model surfaced on state_change.ext.models (#54, ADR-0020):
 *  the choices and per-model effort levels behind the dashboard's model /
 *  effort switch dialogs. Operator-only — ext is stripped for viewers (#46),
 *  so non-operators always see an empty list. */
export interface ModelOption {
  value: string;
  display_name: string;
  description?: string;
  effort_levels?: string[];
  default_effort?: string;
}

/** Reads ext.models off an envelope into well-typed ModelOption entries
 *  (#54). Returns [] when the key is absent or malformed; viewers always get
 *  [] since ext is stripped for non-operators (#46). */
export function modelsFrom(envelope: Envelope): ModelOption[] {
  const raw = envelope.ext?.models;
  if (!Array.isArray(raw)) return [];
  const out: ModelOption[] = [];
  for (const entry of raw) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as ModelOption).value === "string" &&
      typeof (entry as ModelOption).display_name === "string"
    ) {
      const m = entry as ModelOption;
      out.push({
        value: m.value,
        display_name: m.display_name,
        ...(typeof m.description === "string"
          ? { description: m.description }
          : {}),
        ...(Array.isArray(m.effort_levels)
          ? {
              effort_levels: m.effort_levels.filter(
                (l): l is string => typeof l === "string",
              ),
            }
          : {}),
        ...(typeof m.default_effort === "string"
          ? { default_effort: m.default_effort }
          : {}),
      });
    }
  }
  return out;
}

/** payload of a type="log" envelope (protocol.md / ADR-0012).
 *  kind=user is the operator's instruction echoed into the transcript (#31). */
export interface LogPayload {
  kind: "assistant" | "tool_use" | "tool_result" | "user";
  text?: string;
  tool_name?: string;
  /** Pairs a tool_use with its tool_result (#40); present when known. */
  tool_use_id?: string;
  input?: Record<string, unknown>;
  output?: string;
  truncated?: boolean;
}

/** Metadata for a file upload (file-upload spec / ADR-0025). The client
 *  computes chunks from CHUNK_SIZE; upload_id is client-generated (UUID v4). */
export interface AttachOpenMeta {
  upload_id: string;
  filename: string;
  mime: string;
  size: number;
  chunks: number;
}

/** payload of a type="attach_rejected" envelope (file-upload spec / ADR-0025
 *  F9). Individual upload rejection from the wrapper. */
export interface AttachRejectedPayload {
  upload_id: string;
  reason: string;
  detail?: string;
}

/** payload of a type="instruction_rejected" envelope (file-upload spec /
 *  ADR-0025 F9). Whole-instruction rejection (SDK error, attachment
 *  unresolved, etc.). */
export interface InstructionRejectedPayload {
  attachment_ids?: string[];
  reason: string;
  detail?: string;
}

/** Recommended chunk size for attach_chunk binary frames. The protocol is
 *  client-determined (file-upload spec F14); 64 KB stays well under the
 *  server's transport safety valve (8 MB frame cap, ADR-0025 transport
 *  section) while keeping the chunk count manageable for phase-0 sizes. */
export const ATTACH_CHUNK_SIZE = 64 * 1024;

/** Builds an attach_chunk binary payload matching the spec layout:
 *  `<u32 upload_id_len BE><upload_id utf8><u32 chunk_index BE><bytes>`.
 *  Exported so external clients (kaoiro.nvim 等) have a reference builder. */
export function buildChunkPayload(
  uploadId: string,
  chunkIndex: number,
  bytes: Uint8Array,
): ArrayBuffer {
  const idBytes = new TextEncoder().encode(uploadId);
  const out = new Uint8Array(4 + idBytes.byteLength + 4 + bytes.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, idBytes.byteLength, false);
  out.set(idBytes, 4);
  view.setUint32(4 + idBytes.byteLength, chunkIndex, false);
  out.set(bytes, 4 + idBytes.byteLength + 4);
  return out.buffer;
}

/** payload of a type="result" envelope (the turn's final reply). */
export interface ResultPayload {
  text?: string;
  is_error?: boolean;
}

/** Narrows a log envelope's payload, or null for any other envelope. */
export function logOf(envelope: Envelope): LogPayload | null {
  if (envelope.type !== "log") return null;
  const payload = envelope.payload;
  if (typeof payload?.kind !== "string") return null;
  return payload as unknown as LogPayload;
}

/** Narrows a result envelope's payload, or null for any other envelope. */
export function resultOf(envelope: Envelope): ResultPayload | null {
  if (envelope.type !== "result") return null;
  return (envelope.payload ?? {}) as ResultPayload;
}

/** payload of a type="inter_agent_message" envelope (protocol-inter-agent
 *  spec, phase-8). The sender is the surrounding envelope's agent_id; `to` is
 *  the destination agent_id. Both sides' transcripts hold the same envelope —
 *  the rendering decides direction by comparing agent_id against the viewer's
 *  selected agent. */
export interface InterAgentMessagePayload {
  to: string;
  conversation_id: string;
  turn_number: number;
  kind:
    | "request"
    | "response"
    | "query"
    | "inform"
    | "propose"
    | "accept"
    | "reject"
    | "escalate-to-user"
    | "done";
  body: string;
  meta: {
    done: boolean;
    propose_next: string;
    confidence?: number;
    reject_reason?: string;
  };
  owner: { kind: "user" | "agent"; id: string };
}

/** Formats an agent for human display as `<name>(<id>)`. When the agent is
 *  not in the snapshot (e.g. just disconnected and pruned) or has no
 *  persona name, falls back to the bare id. The synthetic `server` sender
 *  used for auto-termination escalates collapses to just `server` since
 *  there is no separate id/name to disambiguate. */
export function formatAgentLabel(
  agents: Record<string, Envelope>,
  id: string,
): string {
  if (id === "server") return "server";
  const name = agents[id]?.persona?.name;
  if (!name || name === id) return id;
  return `${name}(${id})`;
}

/** Narrows an inter_agent_message envelope's payload, or null otherwise.
 *  Tolerant of the server-synthesized escalate skeleton (e.g. turn_number=0).
 *  The minimal structural check now covers `to`, `kind`, `body`, AND
 *  `conversation_id` — the AgentDetail template dereferences
 *  conversation_id.slice(...) without a guard, so a malformed payload must
 *  return null here rather than reach the renderer. */
export function interAgentMessageOf(
  envelope: Envelope,
): InterAgentMessagePayload | null {
  if (envelope.type !== "inter_agent_message") return null;
  const payload = envelope.payload as Partial<InterAgentMessagePayload> | undefined;
  if (
    !payload ||
    typeof payload.to !== "string" ||
    typeof payload.kind !== "string" ||
    typeof payload.body !== "string" ||
    typeof payload.conversation_id !== "string"
  ) {
    return null;
  }
  return payload as InterAgentMessagePayload;
}

/** True for transcript-only envelopes: they go to the per-agent
 *  transcript, NOT the latest-state map (routing them to `agents`
 *  would corrupt the grid face — the boundary marker is a stateless
 *  cue, not a state_change). `log` / `result` are operator-only
 *  (ADR-0012); `inter_agent_message` is operator-only too
 *  (protocol-inter-agent spec) and lands on both the sender and the
 *  receiver's transcript. `session_boundary` (ADR-0036 F3, phase-17
 *  17-7) IS viewer-visible after server-side sanitize (mode-only
 *  payload); the transcript-vs-state routing decision is orthogonal
 *  to the viewer/operator gate, and viewers still need the marker to
 *  render the between-sessions divider. */
export function isReplyEnvelope(envelope: Envelope): boolean {
  return (
    envelope.type === "log" ||
    envelope.type === "result" ||
    envelope.type === "inter_agent_message" ||
    envelope.type === "session_boundary"
  );
}

/** States where the agent is executing and an interrupt (ESC equivalent,
 *  #51) could land work. idle / waiting_input / done / error /
 *  disconnected have nothing to interrupt. Single source of truth so the
 *  lobby card and the detail view stay in sync when states change. */
export const RUNNING_STATES: ReadonlySet<string> = new Set([
  "sending",
  "thinking",
  "tool_running",
  "waiting_permission",
  "waiting_question",
]);

/** States where terminating the agent is safe to do without a warning (#22):
 *  it is not mid-work, so nothing in flight is lost. Any other state prompts a
 *  confirm. Shared by the lobby card and the detail view. */
export const STOP_SAFE_STATES: ReadonlySet<string> = new Set([
  "idle",
  "waiting_input",
  "done",
]);

/** Recovers the owning host_id from a server-allocated agent_id
 *  (`<host_id>.<rand>`, ADR-0024 D3) so the operator can address `stop` to the
 *  right runner without the dashboard tracking host membership. The random
 *  suffix has no dots, so host_id is everything before the last dot. An
 *  agent_id with no dot (e.g. a manual wrapper not following the convention)
 *  yields itself; the stop is then a no-op as no runner owns it. */
export function hostIdFromAgentId(agentId: string): string {
  const lastDot = agentId.lastIndexOf(".");
  return lastDot > 0 ? agentId.slice(0, lastDot) : agentId;
}

/** Persona asset manifest served at GET /api/personas (ADR-0008). */
export interface SpriteEntry {
  /** Hash-versioned URL; safe to cache immutably. */
  url: string;
  /** Content hash, e.g. "sha256:<hex>". */
  hash: string;
}

export interface PersonaManifest {
  /** Changes whenever any sprite content changes (incremental sync). */
  version: string;
  personas: Record<string, { states: Record<string, SpriteEntry> }>;
}

/**
 * Fetches the persona manifest; null on any failure so callers can
 * fall back to sprite-less rendering.
 */
export async function fetchPersonaManifest(
  base = "",
): Promise<PersonaManifest | null> {
  try {
    const res = await fetch(`${base}/api/personas`);
    if (!res.ok) return null;
    return (await res.json()) as PersonaManifest;
  } catch {
    return null;
  }
}

/** Launch catalog of one engine (ADR-0032 F4bc), from the host's register
 *  payload. models reuses the ext.models entry shape (#54) so the launch
 *  cascade and the running-agent switcher share one renderer. */
export interface EngineCatalog {
  id: string;
  models: ModelOption[];
}

/** A live host the operator can launch agents on (ADR-0023 / #22). Derived
 *  from the operator-only `hosts` push; viewers never receive it. */
export interface HostInfo {
  host_id: string;
  personas: Persona[];
  cwd_allowlist: string[];
  /** Engine kinds the host can run (ADR-0032 F4a): "claude-code" / "codex". */
  capabilities?: string[];
  /** Launch catalog per capability (ADR-0032 F4bc). */
  engines?: EngineCatalog[];
}

/** Operator launch request (案A, ADR-0024). The client sends only these; the
 *  server allocates agent_id and mints the per-agent token. */
export interface SpawnRequest {
  host_id: string;
  /** persona id, resolved server-side to the host's declared persona. */
  persona: string;
  cwd: string;
  /** Optional per-instance display name; overrides the persona's name for
   *  this agent only (not the agent_id). Empty/absent = the persona name. */
  name?: string;
  initial_prompt?: string;
  resume_session_id?: string;
  /** Engine to launch (ADR-0032 F4a); absent = claude-code. */
  engine?: string;
  /** Launch-time model / effort picks from the engine catalog cascade. */
  model?: string;
  effort?: string;
  /** Claude-only launch permission mode (ADR-0033 F4 追補, phase-15 D2).
   *  Rides SpawnRequest → server → SpawnMessage → runner → wrapper.
   *  Omitted = the server's PermissionModes store value is used on
   *  wrapper join (natural continuation for restore paths). Priority is
   *  "explicit spawn wins": when present, the server records it into the
   *  same store so the persisted value matches the operator's latest
   *  intent. Codex ignores this field (launch-fixed via sandbox). */
  permission_mode?:
    | "default"
    | "acceptEdits"
    | "plan"
    | "bypassPermissions"
    | "dontAsk"
    | "auto";
  /** Codex-only launch permission (ADR-0033 F3): the OS sandbox axis and
   *  its network toggle; approval is pinned to "never" and not sent. */
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  network_access?: boolean;
}

/** Outcome of a spawn, forwarded from the runner (operator-only). */
export interface SpawnResult {
  host_id: string;
  agent_id: string;
  ok: boolean;
  reason?: string;
}

/** One entry in the restart-surviving identity ledger (ADR-0030). The
 *  server pushes this on operator join alongside the AgentStates
 *  snapshot; the client merges it with live envelopes to render offline
 *  agents' tiles for the restore UI. `last_seen` is memory-only on the
 *  server and resets to null on server restart. */
export interface DirectoryEntry {
  persona: Persona;
  last_seen: number | null;
}

/** A resume candidate under a cwd (ADR-0014 F2; minimal metadata, T2). */
export interface RunnerSession {
  session_id: string;
  summary?: string;
  mtime?: string;
}

/** Resume candidates for a (host, cwd), forwarded from the runner's
 *  enumerate_sessions reply (operator-only, #22 phase-1). `engine` echoes
 *  the requested engine (ADR-0032 F8) so a stale reply for another engine
 *  is not offered. */
export interface RunnerSessions {
  host_id: string;
  cwd: string;
  sessions: RunnerSession[];
  engine?: string;
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface KaoiroHandlers {
  onStatus: (status: ConnectionStatus) => void;
  /** Full re-sync; replaces all known agents (last-write-wins). */
  onSnapshot: (agents: Record<string, Envelope>) => void;
  /** Single-agent update (any envelope type; caller routes by type). */
  onEnvelope: (envelope: Envelope) => void;
  /** Reply-log history per agent (operator-only, ADR-0012); pushed once
   *  on join, chronological. Absent for viewers. */
  onHistory?: (histories: Record<string, Envelope[]>) => void;
  /** A past-session log purge (issue #48): the named agent's transcript
   *  should drop every line outside `sessionId`. Operator-only. */
  onHistoryCleared?: (agentId: string, sessionId: string) => void;
  /** A resume reconstruction reset (issue #50, ADR-0014 phase-2): the named
   *  agent's transcript should be dropped entirely, just before the server
   *  replays the JSONL-rebuilt `log` lines. Operator-only. */
  onHistoryReset?: (agentId: string) => void;
  /** A disconnected agent was removed (issue #14): drop it from the grid.
   *  Operator-only. */
  onAgentDeleted?: (agentId: string) => void;
  /** Live launchable hosts (#22); pushed on join and on every host
   *  register/drop. Operator-only — its arrival also marks this client an
   *  operator (viewers never receive it). */
  onHosts?: (hosts: HostInfo[]) => void;
  /** Restart-surviving identity ledger (ADR-0030); pushed once on
   *  operator join. Every known agent_id maps to its persona and a
   *  last_seen hint. Merged with the AgentStates snapshot on the client
   *  to surface offline agents for the restore UI. Operator-only. */
  onDirectory?: (entries: Record<string, DirectoryEntry>) => void;
  /** A spawn outcome forwarded from the runner (#22). Operator-only. */
  onSpawnResult?: (result: SpawnResult) => void;
  /** Resume candidates for a (host, cwd), in reply to enumerateSessions
   *  (#22 phase-1). Operator-only. */
  onSessions?: (result: RunnerSessions) => void;
  /** Wrapper rejected an individual upload (file-upload spec / ADR-0025).
   *  Operator-only. Forwarded from the envelope stream as a convenience. */
  onAttachRejected?: (payload: AttachRejectedPayload) => void;
  /** Wrapper rejected a whole instruction (file-upload spec / ADR-0025).
   *  Operator-only. Forwarded from the envelope stream as a convenience. */
  onInstructionRejected?: (payload: InstructionRejectedPayload) => void;
  /** Session-reset lifecycle broadcasts (ADR-0036 F7, phase-17 17-9).
   *  All three are operator-only (payloads carry session identifiers,
   *  gated in AgentsChannel.handle_out). `started` fires on lock
   *  acquire, `completed` on the fresh wrapper's channel join,
   *  `failed` on any rejection (invalid mode / busy / rollback etc.). */
  onSessionResetStarted?: (payload: SessionResetStartedPayload) => void;
  onSessionResetCompleted?: (payload: SessionResetCompletedPayload) => void;
  onSessionResetFailed?: (payload: SessionResetFailedPayload) => void;
}

/** ADR-0036 F7 broadcast payloads (client view). `previous_session_id` /
 *  `to_session_id` are optional; the server omits them per protocol type
 *  when absent (fresh spawn edge / lazy采番 / failure branches). */
export interface SessionResetStartedPayload {
  request_id: string;
  agent_id: string;
  mode: SessionResetMode;
  previous_session_id?: string;
}

export interface SessionResetCompletedPayload {
  request_id: string;
  agent_id: string;
  mode: SessionResetMode;
  previous_session_id?: string;
  to_session_id: string | null;
}

export interface SessionResetFailedPayload {
  request_id: string;
  agent_id: string;
  mode: SessionResetMode;
  reason: SessionResetErrorReason;
}

export interface KaoiroConnection {
  disconnect: () => void;
  /** Sends an operator instruction; rejects on server refusal
   * (forbidden / unknown_agent) or timeout. `attachmentIds` references
   * uploads previously sent through uploadFile / attach* (file-upload spec
   * / ADR-0025); the wrapper resolves each id to the corresponding bytes. */
  sendInstruction: (
    agentId: string,
    text: string,
    attachmentIds?: string[],
  ) => Promise<void>;
  /** Answers a pending permission_request; rejects like sendInstruction. */
  sendPermissionDecision: (
    agentId: string,
    requestId: string,
    allow: boolean,
  ) => Promise<void>;
  /** Answers a pending question_request (AskUserQuestion, ADR-0027); rejects
   *  like sendInstruction. `answers` is keyed by question text; `cancelled`
   *  dismisses the question (deny). */
  sendQuestionResponse: (
    agentId: string,
    requestId: string,
    answers: Record<string, string>,
    cancelled?: boolean,
  ) => Promise<void>;
  /** Interrupts the agent's current turn (#51, ESC equivalent); rejects
   * like sendInstruction (forbidden / unknown_agent / timeout). The
   * wrapper handles a stale interrupt as a no-op. */
  sendInterrupt: (agentId: string) => Promise<void>;
  /** Switches the model for the agent's subsequent turns (#54); rejects like
   * sendInstruction (forbidden / unknown_agent / timeout). `model` is a
   * `value` from ext.models. */
  setModel: (agentId: string, model: string) => Promise<void>;
  /** Switches the reasoning effort for the agent's subsequent turns (#54);
   * rejects like sendInstruction. `effort` is a level from a model's
   * effort_levels (low..max). */
  setEffort: (agentId: string, effort: string) => Promise<void>;
  /** Switches the SDK permission mode for the agent's subsequent turns
   * (#58); the server also persists the pick so the wrapper restores it
   * on next start. `mode` must be a closed-enum PermissionMode value. */
  setPermissionMode: (agentId: string, mode: string) => Promise<void>;
  /** Purges the agent's past-session reply log (issue #48); rejects like
   * sendInstruction (forbidden / unknown_agent / no_current_session). */
  clearHistory: (agentId: string) => Promise<void>;
  /** Removes a disconnected agent (issue #14); rejects like
   * sendInstruction (forbidden / unknown_agent / not_disconnected). */
  deleteAgent: (agentId: string) => Promise<void>;
  /** Terminates the running wrapper (#22): the runner that owns the agent
   * kills its process; the agent then goes `disconnected`. The host is
   * derived from the agent_id (hostIdFromAgentId). A no-op for an agent no
   * runner owns. Rejects like sendInstruction (forbidden / timeout). */
  stop: (agentId: string) => Promise<void>;
  /** Restores a disconnected agent (#22, ADR-0014「復帰」): the server
   * re-spawns the SAME agent_id with resume from its recorded session
   * pointer, so the agent comes back with its face / mood / conversation.
   * Rejects with `no_session` when no resumable pointer (session_id + cwd)
   * was recorded, `unknown_agent` when the agent is not known. */
  restore: (agentId: string) => Promise<void>;
  /** Swaps a running agent to a different resume session_id under its
   * current cwd (ADR-0014, resume-swap). The wrapper is cycled (kill +
   * relaunch) so the new session takes effect; a disconnected agent takes
   * the same path as restore but with the operator-picked session_id.
   * The client picks `sessionId` from `enumerateSessions` under the agent's
   * cwd. Rejects like sendInstruction plus `invalid_session_id` /
   * `missing_session_id`. */
  resumeSession: (agentId: string, sessionId: string) => Promise<void>;
  /** Session-reset control (ADR-0036 F1, phase-17 17-8). Operator-only.
   *  Resolves on server accept; the completion / failure arrives via
   *  the onSessionResetCompleted / _Failed handlers. Rejects like
   *  sendInstruction plus the closed reset vocabulary (agent_busy /
   *  unsupported_session_reset / session_reset_pending / invalid_mode). */
  sendSessionReset: (
    agentId: string,
    mode: SessionResetMode,
  ) => Promise<void>;
  /** Requests a spawn (#22, 案A); resolves with the server-allocated
   * agent_id. Rejects like sendInstruction (forbidden / unknown_host /
   * unknown_persona / cwd_not_allowed). The eventual launch outcome
   * arrives separately via onSpawnResult. */
  spawn: (request: SpawnRequest) => Promise<{ agentId: string }>;
  /** Requests the resume candidates under (host, cwd) (#22 phase-1);
   * resolves when the server accepts the relay. The candidate list arrives
   * separately via onSessions. Rejects like sendInstruction. */
  enumerateSessions: (
    hostId: string,
    cwd: string,
    engine?: string,
  ) => Promise<void>;
  /** Same as `enumerateSessions` but resolves cwd server-side from the
   *  agent's SessionPointer (seeded at spawn). Use from the detail view
   *  where cwd may not yet ride on `envelope.ext.cwd`. Reject reasons
   *  include `no_session` (pointer unknown for this agent). */
  enumerateAgentSessions: (agentId: string) => Promise<void>;
  /** Uploads a File using attach_open / attach_chunk* / attach_close
   *  (file-upload spec / ADR-0025). Resolves with the upload_id once
   *  attach_close acks. Reject from the wrapper arrives asynchronously
   *  via onAttachRejected with the same upload_id.
   *
   *  `onProgress`, when provided, fires after each attach_chunk push with
   *  (uploaded_chunks, total_chunks). Chunk granularity (64 KB by spec /
   *  ADR-0025 F14) is fine enough for per-upload UI without per-byte
   *  bookkeeping. The bar may briefly flash 100% before attach_close
   *  resolves — the caller decides how to render that boundary. */
  uploadFile: (
    agentId: string,
    file: File,
    onProgress?: (uploaded: number, total: number) => void,
  ) => Promise<string>;
  /** Lower-level attach primitives — exposed mainly for tests and unusual
   *  upload patterns (the high-level uploadFile orchestrates them). */
  attachOpen: (agentId: string, meta: AttachOpenMeta) => Promise<void>;
  attachChunk: (data: ArrayBuffer) => void;
  attachClose: (agentId: string, uploadId: string) => Promise<void>;
}

export interface ConnectOptions {
  /** User token (ADR-0011); resolved server-side to viewer/operator. */
  token?: string;
  /** Short-lived WS ticket fetched from the auth cookie (ADR-0013) — the
   *  reload path, where the token is not in the URL. */
  ticket?: string;
}

function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Envelope).agent_id === "string" &&
    typeof (value as Envelope).state === "string"
  );
}

/** Parses the `hosts` map (host_id => entry) into a HostInfo list, keeping
 *  only the operator-facing fields and skipping malformed entries. */
export function parseHosts(value: unknown): HostInfo[] {
  if (typeof value !== "object" || value === null) return [];
  const hosts: HostInfo[] = [];
  for (const [hostId, entry] of Object.entries(value)) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      Array.isArray((entry as HostInfo).personas) &&
      Array.isArray((entry as HostInfo).cwd_allowlist)
    ) {
      const e = entry as HostInfo;
      hosts.push({
        host_id: hostId,
        personas: e.personas,
        cwd_allowlist: e.cwd_allowlist,
        ...(Array.isArray(e.capabilities)
          ? { capabilities: e.capabilities }
          : {}),
        ...(Array.isArray(e.engines) ? { engines: e.engines } : {}),
      });
    }
  }
  return hosts;
}

/** Parses the `directory` map (agent_id => entry) into a
 *  Record<string, DirectoryEntry>, skipping malformed entries. `last_seen`
 *  is either an integer (unix seconds) or null (fresh after server restart,
 *  ADR-0030 A5). */
export function parseDirectory(
  value: unknown,
): Record<string, DirectoryEntry> {
  const entries: Record<string, DirectoryEntry> = {};
  if (typeof value !== "object" || value === null) return entries;
  for (const [agentId, entry] of Object.entries(value)) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as DirectoryEntry).persona === "object" &&
      (entry as DirectoryEntry).persona !== null &&
      typeof (entry as DirectoryEntry).persona.id === "string"
    ) {
      const e = entry as DirectoryEntry;
      entries[agentId] = {
        persona: e.persona,
        last_seen: typeof e.last_seen === "number" ? e.last_seen : null,
      };
    }
  }
  return entries;
}

/** Parses a `sessions` array, keeping only well-typed candidates. */
export function parseSessions(value: unknown): RunnerSession[] {
  if (!Array.isArray(value)) return [];
  const sessions: RunnerSession[] = [];
  for (const entry of value) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as RunnerSession).session_id === "string"
    ) {
      const s = entry as RunnerSession;
      sessions.push({
        session_id: s.session_id,
        ...(typeof s.summary === "string" ? { summary: s.summary } : {}),
        ...(typeof s.mtime === "string" ? { mtime: s.mtime } : {}),
      });
    }
  }
  return sessions;
}

// phase-17 17-9: defensive parsers for the session-reset lifecycle
// broadcasts (ADR-0036 F7). Malformed payload → null so the channel
// dispatch silently drops rather than fire a handler on an ill-typed
// event. mode / reason are validated against their closed vocabulary.

function parseResetMode(value: unknown): SessionResetMode | null {
  return value === "new" || value === "clear" ? value : null;
}

function parseResetReason(value: unknown): SessionResetErrorReason | null {
  return typeof value === "string" &&
      (SESSION_RESET_ERROR_REASONS as readonly string[]).includes(value)
    ? (value as SessionResetErrorReason)
    : null;
}

export function parseSessionResetStarted(
  value: unknown,
): SessionResetStartedPayload | null {
  if (typeof value !== "object" || value === null) return null;
  const p = value as Record<string, unknown>;
  if (typeof p.request_id !== "string" || typeof p.agent_id !== "string") return null;
  const mode = parseResetMode(p.mode);
  if (mode === null) return null;
  return {
    request_id: p.request_id,
    agent_id: p.agent_id,
    mode,
    ...(typeof p.previous_session_id === "string"
      ? { previous_session_id: p.previous_session_id }
      : {}),
  };
}

export function parseSessionResetCompleted(
  value: unknown,
): SessionResetCompletedPayload | null {
  if (typeof value !== "object" || value === null) return null;
  const p = value as Record<string, unknown>;
  if (typeof p.request_id !== "string" || typeof p.agent_id !== "string") return null;
  const mode = parseResetMode(p.mode);
  if (mode === null) return null;
  // to_session_id: string | null (protocol type). Missing / non-string /
  // explicit null all collapse to null.
  const to_session_id =
    typeof p.to_session_id === "string" ? p.to_session_id : null;
  return {
    request_id: p.request_id,
    agent_id: p.agent_id,
    mode,
    to_session_id,
    ...(typeof p.previous_session_id === "string"
      ? { previous_session_id: p.previous_session_id }
      : {}),
  };
}

export function parseSessionResetFailed(
  value: unknown,
): SessionResetFailedPayload | null {
  if (typeof value !== "object" || value === null) return null;
  const p = value as Record<string, unknown>;
  if (typeof p.request_id !== "string" || typeof p.agent_id !== "string") return null;
  const mode = parseResetMode(p.mode);
  const reason = parseResetReason(p.reason);
  if (mode === null || reason === null) return null;
  return { request_id: p.request_id, agent_id: p.agent_id, mode, reason };
}

function pushAsync(
  channel: Channel,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    channel
      .push(event, payload)
      .receive("ok", () => resolve())
      .receive("error", (reason: { reason?: string } | undefined) =>
        reject(new Error(reason?.reason ?? "error")),
      )
      .receive("timeout", () => reject(new Error("timeout")));
  });
}

/**
 * Connects to the kaoiro server's client socket and forwards protocol
 * events to the handlers. `url` is the socket endpoint, e.g.
 * `ws://host:4000/client` (the phoenix client appends "/websocket").
 */
export function connectKaoiro(
  url: string,
  handlers: KaoiroHandlers,
  options: ConnectOptions = {},
): KaoiroConnection {
  const params: Record<string, string> = {};
  if (options.token !== undefined) params.token = options.token;
  if (options.ticket !== undefined) params.ticket = options.ticket;
  const socket = new Socket(url, {
    params,
  });
  handlers.onStatus("connecting");
  socket.onOpen(() => handlers.onStatus("connected"));
  socket.onClose(() => handlers.onStatus("disconnected"));
  socket.onError(() => handlers.onStatus("disconnected"));
  socket.connect();

  const channel = socket.channel("agents:lobby");
  channel.on("snapshot", (payload: { agents?: unknown }) => {
    const agents: Record<string, Envelope> = {};
    for (const value of Object.values(payload.agents ?? {})) {
      if (isEnvelope(value)) agents[value.agent_id] = value;
    }
    handlers.onSnapshot(agents);
  });
  channel.on("envelope", (payload: unknown) => {
    if (!isEnvelope(payload)) return;
    handlers.onEnvelope(payload);
    // Convenience dispatch for upload rejections (file-upload spec /
    // ADR-0025). The full envelope still goes through onEnvelope so
    // generic UIs see it; the specific handlers fire when bound.
    if (payload.type === "attach_rejected") {
      const p = payload.payload as Partial<AttachRejectedPayload> | undefined;
      if (
        p !== undefined &&
        typeof p.upload_id === "string" &&
        typeof p.reason === "string"
      ) {
        handlers.onAttachRejected?.({
          upload_id: p.upload_id,
          reason: p.reason,
          ...(typeof p.detail === "string" ? { detail: p.detail } : {}),
        });
      }
    } else if (payload.type === "instruction_rejected") {
      const p = payload.payload as Partial<InstructionRejectedPayload> | undefined;
      if (p !== undefined && typeof p.reason === "string") {
        handlers.onInstructionRejected?.({
          reason: p.reason,
          ...(Array.isArray(p.attachment_ids)
            ? {
                attachment_ids: p.attachment_ids.filter(
                  (id): id is string => typeof id === "string",
                ),
              }
            : {}),
          ...(typeof p.detail === "string" ? { detail: p.detail } : {}),
        });
      }
    }
  });
  channel.on("history", (payload: { agents?: unknown }) => {
    const histories: Record<string, Envelope[]> = {};
    for (const [id, value] of Object.entries(payload.agents ?? {})) {
      if (Array.isArray(value)) {
        histories[id] = value.filter(isEnvelope);
      }
    }
    handlers.onHistory?.(histories);
  });
  channel.on(
    "history_cleared",
    (payload: { agent_id?: unknown; session_id?: unknown }) => {
      if (
        typeof payload.agent_id === "string" &&
        typeof payload.session_id === "string"
      ) {
        handlers.onHistoryCleared?.(payload.agent_id, payload.session_id);
      }
    },
  );
  channel.on("history_reset", (payload: { agent_id?: unknown }) => {
    if (typeof payload.agent_id === "string") {
      handlers.onHistoryReset?.(payload.agent_id);
    }
  });
  channel.on("agent_deleted", (payload: { agent_id?: unknown }) => {
    if (typeof payload.agent_id === "string") {
      handlers.onAgentDeleted?.(payload.agent_id);
    }
  });
  channel.on("hosts", (payload: { hosts?: unknown }) => {
    handlers.onHosts?.(parseHosts(payload.hosts));
  });
  channel.on("directory", (payload: { entries?: unknown }) => {
    handlers.onDirectory?.(parseDirectory(payload.entries));
  });
  channel.on("spawn_result", (payload: unknown) => {
    const p = payload as Partial<SpawnResult>;
    if (
      typeof p.host_id === "string" &&
      typeof p.agent_id === "string" &&
      typeof p.ok === "boolean"
    ) {
      handlers.onSpawnResult?.({
        host_id: p.host_id,
        agent_id: p.agent_id,
        ok: p.ok,
        ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
      });
    }
  });
  channel.on("runner_sessions", (payload: unknown) => {
    const p = payload as Partial<RunnerSessions>;
    if (typeof p.host_id === "string" && typeof p.cwd === "string") {
      handlers.onSessions?.({
        host_id: p.host_id,
        cwd: p.cwd,
        sessions: parseSessions(p.sessions),
      });
    }
  });
  // Session-reset lifecycle broadcasts (ADR-0036 F7, phase-17 17-9).
  // Payload is validated defensively; malformed drops so the UI never
  // fires on an ill-formed event.
  channel.on("session_reset_started", (payload: unknown) => {
    const parsed = parseSessionResetStarted(payload);
    if (parsed !== null) handlers.onSessionResetStarted?.(parsed);
  });
  channel.on("session_reset_completed", (payload: unknown) => {
    const parsed = parseSessionResetCompleted(payload);
    if (parsed !== null) handlers.onSessionResetCompleted?.(parsed);
  });
  channel.on("session_reset_failed", (payload: unknown) => {
    const parsed = parseSessionResetFailed(payload);
    if (parsed !== null) handlers.onSessionResetFailed?.(parsed);
  });
  channel.join();

  return {
    disconnect: () => {
      channel.leave();
      socket.disconnect();
    },
    sendInstruction: (agentId, text, attachmentIds) =>
      pushAsync(
        channel,
        "instruction",
        attachmentIds !== undefined && attachmentIds.length > 0
          ? { agent_id: agentId, text, attachment_ids: attachmentIds }
          : { agent_id: agentId, text },
      ),
    sendPermissionDecision: (agentId, requestId, allow) =>
      pushAsync(channel, "permission_decision", {
        agent_id: agentId,
        request_id: requestId,
        allow,
      }),
    sendQuestionResponse: (agentId, requestId, answers, cancelled) =>
      pushAsync(channel, "question_response", {
        agent_id: agentId,
        request_id: requestId,
        answers,
        ...(cancelled ? { cancelled: true } : {}),
      }),
    sendInterrupt: (agentId) =>
      pushAsync(channel, "interrupt", { agent_id: agentId }),
    setModel: (agentId, model) =>
      pushAsync(channel, "set_model", { agent_id: agentId, model }),
    setEffort: (agentId, effort) =>
      pushAsync(channel, "set_effort", { agent_id: agentId, effort }),
    setPermissionMode: (agentId, mode) =>
      pushAsync(channel, "set_permission_mode", { agent_id: agentId, mode }),
    clearHistory: (agentId) =>
      pushAsync(channel, "clear_history", { agent_id: agentId }),
    deleteAgent: (agentId) =>
      pushAsync(channel, "delete_agent", { agent_id: agentId }),
    stop: (agentId) =>
      pushAsync(channel, "stop", {
        host_id: hostIdFromAgentId(agentId),
        agent_id: agentId,
      }),
    restore: (agentId) =>
      pushAsync(channel, "restore", { agent_id: agentId }),
    resumeSession: (agentId, sessionId) =>
      pushAsync(channel, "resume_session", {
        agent_id: agentId,
        session_id: sessionId,
      }),
    sendSessionReset: (agentId, mode) =>
      pushAsync(channel, "session_reset", {
        agent_id: agentId,
        mode,
      }),
    spawn: (request) =>
      new Promise((resolve, reject) => {
        channel
          .push("spawn", { ...request })
          .receive("ok", (resp: { agent_id?: unknown }) =>
            typeof resp?.agent_id === "string"
              ? resolve({ agentId: resp.agent_id })
              : reject(new Error("error")),
          )
          .receive("error", (reason: { reason?: string } | undefined) =>
            reject(new Error(reason?.reason ?? "error")),
          )
          .receive("timeout", () => reject(new Error("timeout")));
      }),
    enumerateSessions: (hostId, cwd, engine) =>
      pushAsync(channel, "enumerate_sessions", {
        host_id: hostId,
        cwd,
        ...(engine === undefined ? {} : { engine }),
      }),
    enumerateAgentSessions: (agentId) =>
      pushAsync(channel, "enumerate_sessions", {
        host_id: hostIdFromAgentId(agentId),
        agent_id: agentId,
      }),
    attachOpen: (agentId, meta) =>
      pushAsync(channel, "attach_open", { agent_id: agentId, ...meta }),
    attachChunk: (data) => {
      // Fire-and-forget binary frame: phoenix.js automatically encodes
      // ArrayBuffer payloads as a V2 binary frame. The server's handler
      // returns :noreply so awaiting a reply would only ever time out.
      channel.push("attach_chunk", data);
    },
    attachClose: (agentId, uploadId) =>
      pushAsync(channel, "attach_close", {
        agent_id: agentId,
        upload_id: uploadId,
      }),
    uploadFile: async (agentId, file, onProgress) => {
      const upload_id = crypto.randomUUID();
      const buffer = await file.arrayBuffer();
      const size = buffer.byteLength;
      const chunks = Math.max(1, Math.ceil(size / ATTACH_CHUNK_SIZE));
      await pushAsync(channel, "attach_open", {
        agent_id: agentId,
        upload_id,
        filename: file.name,
        mime: file.type,
        size,
        chunks,
      });
      for (let i = 0; i < chunks; i++) {
        const start = i * ATTACH_CHUNK_SIZE;
        const end = Math.min(start + ATTACH_CHUNK_SIZE, size);
        const chunkBytes = new Uint8Array(buffer.slice(start, end));
        channel.push("attach_chunk", buildChunkPayload(upload_id, i, chunkBytes));
        onProgress?.(i + 1, chunks);
      }
      await pushAsync(channel, "attach_close", {
        agent_id: agentId,
        upload_id,
      });
      return upload_id;
    },
  };
}

/** Socket endpoint derived from the page origin (Phoenix-served build). */
export function defaultSocketUrl(location: Location): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/client`;
}
