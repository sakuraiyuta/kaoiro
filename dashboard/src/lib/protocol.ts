// kaoiro public-protocol client — plain TS, no Svelte dependency
// (ADR-0007). Speaks Phoenix Channels (vsn=2.0.0 via the official client,
// ADR-0009) and consumes the same API as any external client: join
// "agents:lobby", receive agents/tasks/deliveries snapshot pushes, then
// "envelope" broadcasts.
// Reconnect/heartbeat belong to the phoenix client; every successful
// (re)join yields a fresh snapshot (protocol.md re-sync rule).

import { Socket } from "phoenix";
import type { Channel } from "phoenix";

import { randomUUID } from "./uuid";

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
  /** Mutable instance-scoped display name (ADR-0050 D1, issue #219
   *  D19/D23). `persona.name` above is the pack's canonical name and
   *  never changes for the session; THIS is what a rename mutates and
   *  what the UI shows — see `AgentDetail.svelte` / `AgentCard.svelte`.
   *  Optional for the same reason `persona` itself is: an envelope built
   *  before this field existed (older wrapper build) simply omits it. */
  display_name?: string;
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

/** Who initiated a reset (protocol.md, ADR-0043 D1). Mirrors
 *  @kaoiro/protocol's SessionResetOrigin. */
export type SessionResetOrigin = "operator" | "agent_self";

/** `history_reset` broadcast payload. The optional form records the v0
 * compatibility rule: omission means preserve structured IA history. */
export interface HistoryResetPayload {
  agent_id: string;
  preserve_inter_agent?: boolean;
  /** Pairs the reset with `history_replay_complete`. New wrappers always
   * provide it; omission keeps the pre-#125 wire shape readable. */
  replay_id?: string;
}

/** Completion boundary for a resume's JSONL replay. The wrapper sends this
 * only after the final reconstructed log envelope, allowing the dashboard to
 * distinguish historical replay from the next live assistant reply. */
export interface HistoryReplayCompletePayload {
  agent_id: string;
  replay_id: string;
}

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
  /** Absent means unrestricted for backwards compatibility; present is the
   * closed set of types this session accepts. */
  attachment_types?: Array<"image">;
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
  /** Whether the active session provides an authoritative context-window
   *  usage snapshot in `ext.context` (ADR-0040, phase-21). Tri-state UI
   *  contract (do NOT collapse absent into false):
   *   - **absent (undefined)** — rolling upgrade; the wrapper predates this
   *     capability. Callers hide the ctx row entirely.
   *   - **explicit `false`** — the adapter cannot produce a reliable
   *     snapshot (currently Codex). UI shows "未対応".
   *   - **explicit `true`** — the adapter stamps `ext.context` when
   *     available. UI shows the meter when `ext.context` lands, else a
   *     "取得中" placeholder. */
  supports_context_usage?: boolean;
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
  if (typeof r.supports_context_usage === "boolean") {
    out.supports_context_usage = r.supports_context_usage;
  }
  if (Array.isArray(r.attachment_types)) {
    const types: Array<"image"> = [];
    for (const type of r.attachment_types) {
      if (type === "image") types.push(type);
    }
    // A present-but-invalid / empty list is intentionally retained as an
    // empty restriction: fail closed rather than widening a malformed stamp.
    out.attachment_types = types;
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
  /** Canonical model ID this selectable alias resolves to. Read-only
   *  metadata; omitted when the engine cannot report it. */
  resolved_model?: string;
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
        ...(typeof m.resolved_model === "string" && m.resolved_model.length > 0
          ? { resolved_model: m.resolved_model }
          : {}),
      });
    }
  }
  return out;
}

/** payload of a type="log" envelope (protocol.md / ADR-0012).
 *  kind=user is the operator's instruction echoed into the transcript (#31);
 *  kind=system is a session-level event the wrapper observed — context
 *  compaction, conversation reset (phase-28 A1 / #168) — not model speech. */
export interface LogPayload {
  kind: "assistant" | "tool_use" | "tool_result" | "user" | "system";
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
  /** SDK error termination subtype relayed from the wrapper (issue #127).
   *  Present on error results only, absent on success. The Claude Code
   *  adapter's values mirror its ResultSubtype (`error_max_turns` /
   *  `error_during_execution` / `error_max_budget_usd` /
   *  `error_max_structured_output_retries`). The Codex adapter has no
   *  SDK-native subtype of its own but sets one independent value,
   *  `error_rollout_corrupted` (issue #263), when a resume failure is
   *  confirmed as permanent rollout corruption (candidate stderr pattern
   *  AND the rollout file itself verified corrupted — a text match alone
   *  never sets it). The UI treats any other unknown string as fallback
   *  wording. */
  error_subtype?: string;
  /** SDK error termination detail text (issue #127) — the wrapper forwards
   *  what the SDK returned alongside is_error (e.g. tool error message).
   *  Absent on success; may be omitted on error when the SDK provided no
   *  text. */
  error_detail?: string;
}

/** Human-readable Japanese label for a wrapper's error_subtype (issue #127).
 *  Falls back to null for absent / unknown subtypes so the caller can either
 *  omit the label or default to the plain "エラーで終了" wording. Kept
 *  co-located with ResultPayload so #128 (retry button) can share the same
 *  error-classification path. */
const ERROR_SUBTYPE_LABELS: Record<string, string> = {
  error_max_turns: "最大ターン数到達",
  error_during_execution: "実行中エラー",
  error_max_budget_usd: "予算上限到達",
  error_max_structured_output_retries: "構造化出力リトライ上限",
  // issue #263: Codex アダプタが resume 失敗の detail から rollout 破損
  // (行途中の UTF-8 切断 / JSON 途切れ) を検知したときだけ独自に載せる
  // 値。他の4値と違い SDK 由来の subtype ではない — wrapper 側の判定
  // (isRolloutCorruptionDetail) が付与する。
  error_rollout_corrupted: "セッション破損 (再開不可)",
};

export function errorSubtypeLabel(subtype: string | undefined): string | null {
  if (typeof subtype !== "string" || subtype === "") return null;
  return ERROR_SUBTYPE_LABELS[subtype] ?? null;
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

/** ADR-0019 F3 coarse lifecycle. Client mirror of @kaoiro/protocol
 *  TaskStatus. */
export type TaskStatus = "running" | "completed" | "failed" | "stopped";

/** One visible item in an agent-owned tasklist snapshot (issue #188,
 * ADR-0049). Codex only produces pending/completed, while Claude can also
 * report in_progress. The dashboard keeps the protocol's shared vocabulary
 * rather than inferring state from display text. */
export type TasklistItemStatus = "pending" | "in_progress" | "completed";

export interface TasklistItem {
  text: string;
  status: TasklistItemStatus;
}

/** Source items that wrapper-side bounding omitted from a tasklist snapshot.
 * Their aggregate is what keeps the collapsed completed/total display honest
 * when the expanded float can render only the leading item texts. */
export interface TasklistOmitted {
  count: number;
  completed: number;
}

export interface TasklistSnapshot {
  items: TasklistItem[];
  omitted?: TasklistOmitted;
}

/** payload of a type="task" envelope (ADR-0019/ADR-0047, issue #180):
 *  normally a subagent/workflow child-task lifecycle, parent-linked via
 *  `agent_id`. The reserved `task_id/task_type="tasklist"` pair is the
 *  sole exception: it carries the parent agent's own LWW todo snapshot
 *  (ADR-0049, issue #188).
 *  Client mirror of @kaoiro/protocol TaskPayload, kept as a plain
 *  interface so protocol.ts stays runtime-free. Operator-only (ADR-0021,
 *  こはく 2026-08-09 access-control decision) — the server never sends
 *  `type: "task"` envelopes or the snapshot's `tasks` key to a `:viewer`
 *  role join, so this narrower is a no-op for viewer clients. */
export interface TaskPayload {
  kind: "started" | "updated" | "completed";
  agent_id: string;
  task_id: string;
  /** SDK raw value (e.g. "local_agent" / "local_workflow" / "local_bash"),
   *  passed through unrenamed (ADR-0047 F4 open enum). */
  task_type: string;
  status: TaskStatus;
  subagent_type?: string;
  workflow_name?: string;
  description?: string;
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
  last_tool_name?: string;
  summary?: string;
  skip_transcript?: boolean;
  /** Present only on the reserved tasklist entity. An empty array means the
   * current todo list is empty; it is not a completed child task. */
  items?: TasklistItem[];
  /** Present only when wrapper-side tasklist bounding skipped source items. */
  omitted?: TasklistOmitted;
}

/** Nested active-task table (issue #180): agent_id => task_id => latest
 *  task envelope. Composite-keyed (M1 fix-round, 2026-08-09, ふじ review)
 *  — ADR-0047 F2 only promises `task_id` is unique WITHIN one parent
 *  session, so a flat task_id-only map could let two different agents'
 *  tasks collide (one agent's `completed` erasing another agent's
 *  still-running task of the same id). Mirrors the server's `TaskStates`
 *  internal/wire shape exactly (protocol.md `snapshot`'s `tasks` key). */
export type TaskTable = Record<string, Record<string, Envelope>>;

/** Narrows a task envelope's payload, or null for any other envelope or a
 *  malformed payload (fail-visible: an unrecognised shape is dropped by
 *  the caller rather than coerced into a partial task). `status` is only
 *  checked for "is it a non-empty string", not matched against the
 *  closed 4-value enum (running/completed/failed/stopped, ADR-0019 F3) —
 *  deliberate forward-compat (N2, クロエ 2026-08-09): a server running a
 *  newer wrapper build could report a `status` value this client does
 *  not yet recognise, and dropping the WHOLE task rather than accepting
 *  the unrecognised string (the UI can still fall back to a generic
 *  display for an unrecognised value, same as `task_type`'s own
 *  open-enum handling) would be a worse failure mode. */
export function taskOf(envelope: Envelope): TaskPayload | null {
  if (envelope.type !== "task") return null;
  const p = envelope.payload as Partial<TaskPayload> | undefined;
  if (
    !p ||
    (p.kind !== "started" && p.kind !== "updated" && p.kind !== "completed") ||
    typeof p.agent_id !== "string" ||
    typeof p.task_id !== "string" ||
    typeof p.task_type !== "string" ||
    typeof p.status !== "string"
  ) {
    return null;
  }
  return p as TaskPayload;
}

/** True only for ADR-0049's single reserved entity. Keep the two fields
 * together even though the current server rejects mismatches: snapshots can
 * outlive a rolling upgrade, so the client must not mistake a malformed child
 * task for the parent's todo list (or omit it from AgentCard's activity ring).
 */
export function isTasklistTask(task: TaskPayload): boolean {
  return task.task_id === "tasklist" && task.task_type === "tasklist";
}

function tasklistItemOf(value: unknown): TasklistItem | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as { text?: unknown; status?: unknown };
  if (
    typeof item.text !== "string" ||
    (item.status !== "pending" &&
      item.status !== "in_progress" &&
      item.status !== "completed")
  ) {
    return null;
  }
  return { text: item.text, status: item.status };
}

function tasklistOmittedOf(value: unknown): TasklistOmitted | null {
  if (typeof value !== "object" || value === null) return null;
  const omitted = value as { count?: unknown; completed?: unknown };
  if (
    typeof omitted.count !== "number" ||
    !Number.isSafeInteger(omitted.count) ||
    omitted.count <= 0 ||
    typeof omitted.completed !== "number" ||
    !Number.isSafeInteger(omitted.completed) ||
    omitted.completed < 0 ||
    omitted.completed > omitted.count
  ) {
    return null;
  }
  return { count: omitted.count, completed: omitted.completed };
}

/**
 * Extracts one parent's latest tasklist entity from the active task table.
 * `items: []` is valid retained state but the caller may intentionally hide
 * its float to avoid a meaningless 0/0 display. Any malformed list is
 * dropped as a whole: rendering a partial snapshot would turn an operator
 * view into a false claim about the agent's todo state.
 */
export function tasklistForAgent(
  tasks: TaskTable,
  agentId: string,
): TasklistSnapshot | null {
  const agentTasks = Object.prototype.hasOwnProperty.call(tasks, agentId)
    ? tasks[agentId]
    : undefined;
  const envelope = agentTasks?.tasklist;
  if (!envelope) return null;

  const task = taskOf(envelope);
  if (
    !task ||
    envelope.agent_id !== agentId ||
    task.agent_id !== agentId ||
    !isTasklistTask(task) ||
    task.kind !== "updated" ||
    task.status !== "running" ||
    !Array.isArray(task.items)
  ) {
    return null;
  }

  const items: TasklistItem[] = [];
  for (const rawItem of task.items) {
    const item = tasklistItemOf(rawItem);
    if (item === null) return null;
    items.push(item);
  }

  if (task.omitted === undefined) return { items };
  const omitted = tasklistOmittedOf(task.omitted);
  return omitted === null ? null : { items, omitted };
}

/** The selected AgentDetail must not retain a todo float through the same
 * disconnect race guarded for its child-task ring. A `disconnected` envelope
 * is authoritative "no current wrapper" state even if the local task table
 * has not observed its purge tick yet. Kept pure so App's display guard is
 * tested without relying on a large socket mount. */
export function tasklistForDetail(
  envelope: Envelope,
  tasks: TaskTable,
): TasklistSnapshot | null {
  if (envelope.state === "disconnected") return null;
  return tasklistForAgent(tasks, envelope.agent_id);
}

/** Applies a live `type: "task"` envelope to the nested active-task table
 *  (agent_id => task_id => latest envelope, issue #180). kind=started/
 *  updated upserts; kind=completed removes (pruning the agent's now-
 *  empty inner map too, so a fully-drained agent does not leak an empty
 *  `{}` entry) — ADR-0019 F4 concurrency: +1 / in-place refresh / -1.
 *  Deliberately NOT folded into the `agents` latest-state map — ADR-0019
 *  F2 forbids a task envelope from overwriting its parent's own
 *  state_change slot, so App.svelte routes `type === "task"` here
 *  instead of through its ordinary agents-map update. A malformed
 *  payload (`taskOf` returns null) is a no-op — fail-visible, matching
 *  the wrapper/server treatment of the same class of input — and returns
 *  the SAME table reference so callers can skip a redundant state write. */
export function applyTaskEnvelope(tasks: TaskTable, envelope: Envelope): TaskTable {
  const task = taskOf(envelope);
  // The server validates this before live broadcast, but preserve the same
  // ownership invariant at the browser boundary. Without it an envelope whose
  // outer agent_id differs from payload.agent_id could put a task under one
  // parent while every other UI read treats the envelope as another parent's
  // state (the snapshot parser below applies the analogous three-way check).
  if (!task || envelope.agent_id !== task.agent_id) return tasks;
  // Security review round 2 (issue #180, 2026-08-09): read via
  // `hasOwnProperty`, never a bare `tasks[task.agent_id]`. `tasks` starts
  // life as a plain `{}` (App.svelte's `$state<TaskTable>({})` initial
  // value and its `endSession()` reset), which still has `Object.prototype`
  // in its chain — reading a key literally `"__proto__"` (or
  // "toString"/"constructor"/etc.) off a plain object returns the
  // INHERITED member, a genuinely truthy value, even with ZERO prior
  // writes to `tasks` (round-1's fix comment here previously claimed this
  // could only happen after a prior safe upsert — that premise was wrong,
  // caught by round-2 review + independent reproduction: `({})["__proto__"]
  // === Object.prototype` is `true`). An own-property guard treats that
  // phantom read as absent, matching every other unrelated agent_id and
  // restoring this function's documented "same reference for a no-op"
  // contract for this edge case.
  const agentTasks = Object.prototype.hasOwnProperty.call(tasks, task.agent_id)
    ? tasks[task.agent_id]
    : undefined;
  if (task.kind === "completed") {
    // Same reasoning applies to `in`, which also walks the prototype
    // chain — `"toString" in someMap` is true for ANY object regardless
    // of its actual own keys.
    if (
      !agentTasks ||
      !Object.prototype.hasOwnProperty.call(agentTasks, task.task_id)
    ) {
      return tasks;
    }
    const nextAgentTasks = { ...agentTasks };
    delete nextAgentTasks[task.task_id];
    if (Object.keys(nextAgentTasks).length === 0) {
      // `delete` never triggers the `__proto__` accessor (unlike bracket
      // assignment below) — safe regardless of what agent_id is.
      const next = { ...tasks };
      delete next[task.agent_id];
      return next;
    }
    // Object-literal COMPUTED property, not a bracket ASSIGNMENT on an
    // existing object — the pattern that IS independently exploitable in
    // `parseTasks` below (mutation-tested: reverting parseTasks's fix
    // reintroduces real prototype pollution reachable from wire input).
    // Kept here too as defense-in-depth even though the hasOwnProperty
    // guards above already ensure this line is only reached through a
    // genuine own entry.
    return { ...tasks, [task.agent_id]: nextAgentTasks };
  }
  return {
    ...tasks,
    [task.agent_id]: { ...agentTasks, [task.task_id]: envelope },
  };
}

/** Removes every task belonging to one agent_id from the nested active-
 *  task table (issue #180, M3/クロエ M1 fix-round, 2026-08-09). Client-
 *  side counterpart of the server's `TaskStates.discard_for_agent/1`:
 *  the server purges its own table on parent disconnect, but that alone
 *  never reaches an already-connected client's local `tasks` state — a
 *  new wire event was deliberately NOT invented for this (ADR-0019 F1:
 *  task lifecycle is bound to the parent session, so the parent's own
 *  `disconnected` state_change, already broadcast live and already
 *  handled by every client, is the natural purge trigger). App.svelte
 *  calls this from its `onEnvelope` handler whenever a `state_change`
 *  reports `state === "disconnected"` for some agent_id — see that call
 *  site for the fuller race analysis (mirrors the server-side ordering
 *  fix in `WrapperChannel.terminate/2`). Returns the SAME table
 *  reference when the agent_id had no tracked tasks, so callers can
 *  skip a redundant state write. */
export function purgeTasksForAgent(tasks: TaskTable, agentId: string): TaskTable {
  // Security review round 2 (issue #180, 2026-08-09): `hasOwnProperty`,
  // not `in` — `in` walks the prototype chain, so `"toString" in {}` is
  // true for any plain object regardless of its actual own keys. Same
  // reasoning as applyTaskEnvelope's `agentTasks` read above.
  if (!Object.prototype.hasOwnProperty.call(tasks, agentId)) return tasks;
  const next = { ...tasks };
  delete next[agentId];
  return next;
}

/** Per-agent active-task tally (ADR-0019 F4 concurrency), driving
 *  AgentCard's 頭上リング on/off only — no numeric display (issue #180,
 *  こはく scoping). Extracted from App.svelte's `activeTaskCountByAgent`
 *  derived state (M2 fix-round, 2026-08-09, ふじ round 2) so it is
 *  directly unit-testable rather than only reachable by mounting the
 *  component. Named distinctly from that `$derived` binding to avoid a
 *  shadowing import in App.svelte.
 *
 *  M2 fix: the accumulator MUST be `Object.create(null)`, not a plain
 *  `{}` — a plain object inherits `Object.prototype`, so
 *  `counts[agentId] = n` for agentId="__proto__" (or any other
 *  Object.prototype member name) silently fails to create an OWN entry.
 *  `tasks`'s own keys are already hasOwnProperty-safe (parseTasks /
 *  applyTaskEnvelope above), but this re-keys into a FRESH object and
 *  must not reintroduce the same class of hole at this final consumer. */
export function computeActiveTaskCountByAgent(
  tasks: TaskTable,
): Record<string, number> {
  const counts: Record<string, number> = Object.create(null);
  for (const [agentId, agentTasks] of Object.entries(tasks)) {
    // A tasklist is the parent agent's own todo snapshot (ADR-0049), not a
    // running subagent/workflow. Excluding the fully-reserved entity here is
    // what keeps AgentCard's child-activity ring dark for a parent that only
    // has a todo list. A malformed one-sided reservation remains a child
    // count rather than being silently hidden; the server rejects it, and the
    // dashboard should not turn an invalid snapshot into a false negative.
    counts[agentId] = Object.values(agentTasks).filter((envelope) => {
      const task = taskOf(envelope);
      return task === null || !isTasklistTask(task);
    }).length;
  }
  return counts;
}

/** AgentDetail's effective activeTaskCount for the currently-selected
 *  envelope (issue #180 follow-up, 2026-08-10 — マスター指摘: AgentCard に
 *  はある頭上リングが AgentDetail に無いのはマスター未承認のスコープ外
 *  判断だったため追加。詳細は phase-32 プラン参照)。
 *
 *  Forces 0 for a disconnected envelope rather than passing
 *  `activeTaskCountByAgent[agent_id] ?? 0` straight through (クロエ
 *  2026-08-10): a disconnected agent cannot have an active subagent, and
 *  this guards two distinct sources of a stale positive count that a
 *  disconnected/offline detail view can otherwise show —
 *  (a) `directoryEnvelope()` (App.svelte) always sets
 *  `state: "disconnected"` for an offline tile that was never live THIS
 *  session, so `tasks` may hold no purge for it at all yet still
 *  coincidentally key-match a live agent_id reused after a restart, and
 *  (b) the documented race between the server's separate AgentStates /
 *  TaskStates broadcasts (App.svelte's `disconnected` purge comment) can
 *  leave a just-disconnected agent's `tasks` entries un-purged for one
 *  tick. Extracted as a pure function — same rationale as
 *  computeActiveTaskCountByAgent above — so the guard is unit-testable
 *  without mounting AgentDetail/App.svelte. */
export function activeTaskCountForDetail(
  envelope: Envelope,
  activeTaskCountByAgent: Record<string, number>,
): number {
  if (envelope.state === "disconnected") return 0;
  return activeTaskCountByAgent[envelope.agent_id] ?? 0;
}

/** Locate the user prompt (log kind="user") that produced the errored result
 *  at `resultIndex` in the transcript (issue #128 エラー再送ボタン)。
 *  Walks backwards through `entries` and returns the first user log's text,
 *  stopping at the previous turn's result envelope so a re-send is always
 *  paired with the SAME turn's user prompt. Returns null when no user
 *  prompt survives in the current turn (typical for wrapper-side history
 *  boundaries where the user echo was pruned). Pure so the retry-button
 *  gating can be unit-tested without mounting AgentDetail.
 *
 *  クロエ round 2 must-fix: (a) session_boundary marker (/new が積む) にも
 *  停止する — /new 直後の inter-agent 起因エラー turn は user log を持たない
 *  ため、boundary を素通りすると前 session の無関係 prompt を返してしまう。
 *  (b) log.truncated === true (wrapper 側 16KB クリップ済) は null で
 *  ボタン非表示 — 「原文そのまま再送」の受け入れ基準を守るため。 */
export function findPrecedingUserPrompt(
  entries: readonly Envelope[],
  resultIndex: number,
): string | null {
  for (let i = resultIndex - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry === undefined) continue;
    if (resultOf(entry) !== null) return null;
    // session_boundary は /new が積む turn 境界 marker (App.svelte)。
    // 越えると前 session の user prompt を拾ってしまうので必ず停止する。
    if (entry.type === "session_boundary") return null;
    const log = logOf(entry);
    if (log?.kind !== "user") continue;
    // truncated:true = wrapper 側 16KB クリップ済。原文再送ができないので
    // ボタン非表示 (再送しない)。
    if (log.truncated === true) return null;
    return typeof log.text === "string" && log.text !== "" ? log.text : null;
  }
  return null;
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

/** Formats an agent for human display as `<name>(<id>)`. Prefers the
 *  mutable `display_name` (issue #219 D19/D23) — a renamed agent must
 *  show its current label, not the pack's canonical name, everywhere
 *  a human reads this label (spawn notices, IA conversation peers).
 *  Falls back to `persona.name` only for a legacy envelope that
 *  predates `display_name` (older wrapper build). When the agent is
 *  not in the snapshot (e.g. just disconnected and pruned) or has
 *  neither field, falls back to the bare id. The synthetic `server`
 *  sender used for auto-termination escalates collapses to just
 *  `server` since there is no separate id/name to disambiguate. */
export function formatAgentLabel(
  agents: Record<string, Envelope>,
  id: string,
): string {
  if (id === "server") return "server";
  const name = agents[id]?.display_name ?? agents[id]?.persona?.name;
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

/** Chronological transcript order shared by history fan-out, reconnect merge,
 *  and live/replay insertion. `seq` only breaks equal producer timestamps,
 *  matching the server's merged-history ordering (#105). */
export function compareTranscriptEnvelopes(
  a: Envelope,
  b: Envelope,
): number {
  const byTime = a.ts.localeCompare(b.ts);
  if (byTime !== 0) return byTime;
  return (a.seq ?? 0) - (b.seq ?? 0);
}

/** Stable identity for a transcript envelope.
 *
 * A quota auto-termination can synthesize two server IA envelopes at the
 * same timestamp and sequence. `payload.to` is the only discriminator in
 * that case, so retain it for the synthetic server producer. Session is also
 * part of the identity: a resumed session may legitimately reuse a wrapper
 * timestamp/sequence pair. This key is shared by merging, DOM anchors and
 * timeline UI state; changing one without the others reintroduces collisions.
 *
 * `payload.to` alone is not enough when the SAME peer pair runs 2+
 * concurrent conversations and one side disconnects (issue #132): the
 * server synthesizes one disconnected notice per conversation the
 * disconnecting wrapper participated in
 * (docs/specs/protocol-inter-agent.md 「server 合成 (disconnected) の
 * 規則」), all addressed to the SAME `payload.to` (the same remaining
 * peer) with the SAME `ts` — the opposite shape from the quota case above
 * (same conversation, different recipients), so `conversation_id` is
 * needed too. Scoped to the same synthetic-server-IA branch as
 * `recipient`: every other envelope type/producer keeps an unchanged key
 * (this segment is always "" for them, same as before this field existed).
 */
export function transcriptEntryKey(
  envelope: Pick<Envelope, "agent_id" | "session_id" | "ts" | "seq" | "type" | "payload">,
): string {
  const syntheticServerIaPayload =
    envelope.agent_id === "server" && envelope.type === "inter_agent_message"
      ? (envelope.payload as
          | { to?: unknown; conversation_id?: unknown }
          | undefined)
      : undefined;
  const recipient = syntheticServerIaPayload?.to;
  const conversationId = syntheticServerIaPayload?.conversation_id;
  return [
    envelope.agent_id,
    envelope.session_id ?? "",
    envelope.ts,
    envelope.seq ?? 0,
    envelope.type,
    typeof recipient === "string" ? recipient : "",
    typeof conversationId === "string" ? conversationId : "",
  ].join("|");
}

/** Merge an authoritative history with buffered/live entries, dedupe the
 *  overlap, and restore chronological order. This also handles resume replay:
 *  retained structured IA lines may be newer than JSONL logs arriving later,
 *  so append order is not display order (#105). */
export function mergeTranscriptEntries(
  history: Envelope[],
  buffered: Envelope[],
): Envelope[] {
  const seen = new Set<string>();
  const merged: Envelope[] = [];
  for (const envelope of [...history, ...buffered]) {
    const identity = transcriptEntryKey(envelope);
    if (seen.has(identity)) continue;
    seen.add(identity);
    merged.push(envelope);
  }
  return merged.sort(compareTranscriptEnvelopes);
}

/** Legacy-server branch of `onHistory` (ふじ R3 must-fix, 2026-07-23):
 *  when the server omits `history_projection` (pre-M6/R3 build), the
 *  history payload is still keyed by sender only, so the client must
 *  fan each IA out to the receiver pane itself. Modern servers set
 *  `history_projection: "per-pane-v1"` and this function is skipped —
 *  the payload is already per-pane and running it again would duplicate
 *  the sender copy on the receiver's transcript.
 *
 *  `clearWatermarks` (issue #109, ISO ts per agent) is applied to the
 *  fan-out'd receiver copy only. The sender-side filter was already
 *  performed by the legacy server (its sender-keyed `all/1` was
 *  pre-filtered before the wire push). Peer transcripts stay unaffected
 *  by an unrelated agent's clear — the "peer 側の表示にも影響なし"
 *  semantics. */
export function fanOutInterAgentHistory(
  histories: Record<string, Envelope[]>,
  clearWatermarks: Record<string, string> = {},
): Record<string, Envelope[]> {
  const expanded: Record<string, Envelope[]> = {};
  for (const [id, entries] of Object.entries(histories)) {
    expanded[id] = [...(expanded[id] ?? []), ...entries];
    for (const envelope of entries) {
      if (envelope.type !== "inter_agent_message") continue;
      const to = (envelope.payload as { to?: unknown } | undefined)?.to;
      if (typeof to === "string" && to !== "" && to !== id) {
        const wm = clearWatermarks[to];
        if (typeof wm === "string" && envelope.ts <= wm) continue;
        expanded[to] = [...(expanded[to] ?? []), envelope];
      }
    }
  }
  for (const entries of Object.values(expanded)) {
    entries.sort(compareTranscriptEnvelopes);
  }
  return expanded;
}

/** Resume JSONL replay cannot reconstruct structured inter-agent payloads. */
export function retainInterAgentHistory(entries: Envelope[]): Envelope[] {
  return entries.filter((envelope) => envelope.type === "inter_agent_message");
}

/** Applies the normalized `history_reset` policy to one transcript. */
export function resetTranscriptHistory(
  entries: Envelope[],
  preserveInterAgent: boolean,
): Envelope[] {
  return preserveInterAgent ? retainInterAgentHistory(entries) : [];
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

/** Full persona pack detail served at GET /api/personas/:id (issue #232):
 *  every manifest.json field the schema defines, plus the full
 *  personality.md body. Static per-pack information, not an individual
 *  agent's state. Optional fields are simply absent, not null, when the
 *  pack's manifest.json omits them. */
export interface PersonaPackDetail {
  id: string;
  name: string;
  sprite_set: string;
  version: string;
  license: string;
  min_kaoiro_version: string;
  states: string[];
  description?: string;
  author?: string;
  homepage?: string;
  personality: string;
}

/** Fetches one persona pack's detail; null on any failure (unknown id,
 *  network error) so callers can show a fallback message. On-demand only —
 *  called when the operator opens the detail modal, not polled. */
export async function fetchPersonaPackDetail(
  personaId: string,
  base = "",
): Promise<PersonaPackDetail | null> {
  try {
    const res = await fetch(
      `${base}/api/personas/${encodeURIComponent(personaId)}`,
    );
    if (!res.ok) return null;
    return (await res.json()) as PersonaPackDetail;
  } catch {
    return null;
  }
}

/** Which login paths the login screen should offer (issue #65 / ADR-0042). */
export interface AuthMethods {
  token: boolean;
  oauth: string[];
}

/**
 * Fetches which auth methods this server offers. Null on any failure,
 * including a 404 from a pre-#65 server that has no `/session/auth-methods`
 * route, or a malformed body — callers should fall back to the pre-OAuth
 * default (token only).
 */
export async function fetchAuthMethods(
  base = "",
): Promise<AuthMethods | null> {
  try {
    const res = await fetch(`${base}/session/auth-methods`);
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as AuthMethods).token !== "boolean" ||
      !Array.isArray((body as AuthMethods).oauth) ||
      !(body as AuthMethods).oauth.every((p) => typeof p === "string")
    ) {
      return null;
    }
    return body as AuthMethods;
  } catch {
    return null;
  }
}

/** Value domain for a build_revision string (issue #228 round 2, ふじ MF-3
 *  差し戻し): either the literal "unknown" or a lowercase 40-hex-digit git
 *  SHA. Mirrors `KaoiroServer.BuildIdentity.valid_revision?/1` (server) and
 *  runner's own `BUILD_REVISION_RE` (build_info.ts) — kept as an
 *  independently-authored duplicate per this file's own plain-TS,
 *  no-workspace-dependency contract (see the module header comment); a
 *  malformed value must be dropped here rather than displayed as if it
 *  were a real revision (spoofing prevention, same posture as the
 *  `typeof` guards elsewhere in this file). */
const BUILD_REVISION_RE = /^[0-9a-f]{40}$/;
const BUILD_VERSION_RE = /^\d{4}\.(?:[1-9]|1[0-2])\.\d+$/;

function isValidBuildRevision(value: unknown): value is string {
  return value === "unknown" || (typeof value === "string" && BUILD_REVISION_RE.test(value));
}

function isValidBuildVersion(value: unknown): value is string {
  return value === "unknown" || (typeof value === "string" && BUILD_VERSION_RE.test(value));
}

function isValidBuildChannel(value: unknown): value is "dev" | "release" {
  return value === "dev" || value === "release";
}

/** Server's own build identity (issues #228/#288), served at GET /api/health.
 *  `build_version` / `build_channel` identify the lockstep CalVer project
 *  artifact; `build_channel` is a controlled `dev`/`release` value.
 *  `protocol_version` is ADR-0015's wire compatibility stamp — a
 *  DIFFERENT concept from `build_revision` (the git SHA the running image
 *  was built from); see HostInfo.build_revision's own doc for why the two
 *  are never conflated. `built_at` is deliberately absent — it is a
 *  runner-only diagnostic field (issue #228 round 2 advisory 2, ふじ 差し戻
 *  し), never part of the server's own identity response. */
export interface ServerHealth {
  status: string;
  build_version: string;
  build_channel: "dev" | "release";
  build_revision: string;
  build_dirty: boolean;
  protocol_version: string;
}

/**
 * Fetches the server's build identity; null on any failure (including a
 * pre-#228 server with no /api/health route, or a malformed field outside
 * BuildInfo's value domain). null does NOT mean "no warning" — LaunchDialog
 * (issue #228 round 2 MF-4) surfaces null as its own explicit "server の
 * build revision を取得できません" warning rather than staying silent
 * (round 3 advisory 1, ふじ 差し戻し: this comment previously said null
 * meant "no mismatch warning", which stopped being true once MF-4 shipped
 * — stale documentation, not stale behavior). `cache: "no-store"` (issue
 * #228 round 2 MF-4): the caller re-fetches this on every LaunchDialog
 * open / reconnect, and a cached response would keep reporting a
 * pre-redeploy server identity after the operator's own /api/health would
 * answer differently.
 */
export async function fetchServerHealth(base = ""): Promise<ServerHealth | null> {
  try {
    const res = await fetch(`${base}/api/health`, { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as ServerHealth).status !== "string" ||
      !isValidBuildVersion((body as ServerHealth).build_version) ||
      !isValidBuildChannel((body as ServerHealth).build_channel) ||
      !isValidBuildRevision((body as ServerHealth).build_revision) ||
      typeof (body as ServerHealth).build_dirty !== "boolean" ||
      typeof (body as ServerHealth).protocol_version !== "string"
    ) {
      return null;
    }
    return body as ServerHealth;
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
  /** Build identity (issue #228) — the full 40-char git SHA the runner's
   *  own artifact was built from ("unknown" when undeterminable), and
   *  whether that build had uncommitted changes. Absent = a pre-#228
   *  runner (no signal, not a claim of "unknown"). DISTINCT from ADR-0015's
   *  wire protocol `version` — this changes on every commit regardless of
   *  wire-shape compatibility, and is compared against the server's own
   *  build_revision (ServerHealth, fetchServerHealth) ONLY to warn the
   *  operator of a mismatch, never to block anything. */
  build_revision?: string;
  build_dirty?: boolean;
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

/** Operator-facing conversation-list entry (issue #276, admin-only first
 *  cut). Wire shape from `ConversationStates.list_for_operator/1` — a
 *  closed tombstone reports `tokens` as `null` (dropped server-side at
 *  close), while `startedAt` is RETAINED across close (director decision
 *  A, issue #276 review follow-up) so a closed row still shows when it
 *  started. `startedAt` stays nullable in this type only for a server
 *  reply that omits it (legacy/defensive fallback), not because the
 *  conversation is closed. */
export interface ConversationSummary {
  conversationId: string;
  participants: string[];
  turns: number;
  tokens: number | null;
  status: "open" | "closed";
  startedAt: string | null;
}

/** Operator-facing user-list entry (issue #207). Wire shape from
 *  `Users.all_with_role/1` (id/kind/display_name/role) — the server
 *  handler REUSES that shape's IMPLEMENTATION (it matches exactly), but
 *  the decision that these 4 fields may cross this operator boundary
 *  was made independently of ADR-0021 F6-8's separate, agent-facing
 *  allow-list (`directory_request`'s `users` projection) — ADR-0021
 *  F6-1: agent disclosure and operator disclosure are independent
 *  decisions, not a shared allow-list. */
export interface UserSummary {
  id: string;
  kind: "user";
  displayName: string;
  role: "viewer" | "operator" | "admin";
}

/** Canonical persona joined server-side against the CURRENT PersonaAssets
 *  manifest (issue #219 D19) — never a stored snapshot. `name` /
 *  `sprite_set` are present when the pack still resolves; absent
 *  ("typed unresolved", issue #219 D21) when it does not — never a
 *  stale/guessed value. `spriteUrlFor` already treats a missing
 *  `sprite_set` as "no sprite, fall back to the CSS face", so this
 *  degrades through the existing rendering path with no special-casing
 *  needed at the call site. */
export interface DirectoryPersona {
  id: string;
  name?: string;
  sprite_set?: string;
}

/** One entry in the restart-surviving identity ledger (ADR-0030). The
 *  server pushes this on operator join alongside the AgentStates
 *  snapshot; the client merges it with live envelopes to render offline
 *  agents' tiles for the restore UI. `last_seen` is memory-only on the
 *  server and resets to null on server restart. `display_name` (issue
 *  #219 D19) is the label to SHOW — always present, independent of
 *  whether `persona` resolved. */
export interface DirectoryEntry {
  persona: DirectoryPersona;
  display_name: string;
  last_seen: number | null;
}

/** Server-owned recipient-local dispatch watermark (issue #247). */
export interface InterAgentDeliveryStatus {
  issued_seq: number;
  acked_seq: number;
  pending_since?: string;
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
  /** The lobby channel completed a join — the opening edge of the
   *  "join → this connection's `history` push" window (ADR-0051 D4 step 1).
   *  Fires again on every Phoenix rejoin, because the join push's receive
   *  hooks survive `resend()`. Distinct from `onStatus("connected")`, which
   *  reports the TRANSPORT: a socket can open before the channel joins, and
   *  the buffer's window is the channel's, not the socket's. */
  onJoined?: () => void;
  /** Full re-sync; replaces all known agents (last-write-wins). */
  onSnapshot: (agents: Record<string, Envelope>) => void;
  /** Whether the bounded agent wire projection omitted entries on this join. */
  onSnapshotIncomplete?: (incomplete: boolean) => void;
  /** Active subagent/workflow task snapshot (nested {@link TaskTable}),
   *  pushed once alongside the AgentStates snapshot on join (ADR-0048
   *  F3, issue #180). Operator-only: the server sends an empty map for a
   *  `:viewer` role join — the same server-gate path as `hosts`/`log`/
   *  `result`, not a fail-closed special case (N3, クロエ 2026-08-09) —
   *  so this is a no-op there. Absent when the caller does not track
   *  tasks. */
  onTaskSnapshot?: (tasks: TaskTable) => void;
  onDeliverySnapshot?: (deliveries: Record<string, InterAgentDeliveryStatus>) => void;
  /** Whether the bounded delivery projection omitted watermarks on this join. */
  onDeliverySnapshotIncomplete?: (incomplete: boolean) => void;
  onDeliveryStatus?: (agentId: string, status: InterAgentDeliveryStatus | null) => void;
  /** Single-agent update (any envelope type; caller routes by type). */
  onEnvelope: (envelope: Envelope) => void;
  /** Reply-log history per agent (operator-only, ADR-0012); pushed once
   *  on join, chronological. Absent for viewers. `clearWatermarks`
   *  (issue #109): agent_id => ISO-8601 UTC ts of that agent's most
   *  recent operator `clear_history`; today display-only (server owns
   *  the filter). `projection` (ふじ R3, 2026-07-23): wire marker for
   *  how `histories` was projected — `"per-pane-v1"` means the server
   *  already fanned each IA to both sender AND receiver panes and
   *  applied the watermark filter, so the client must NOT re-fanOut
   *  (that double-counts the sender copy). `undefined` means a legacy
   *  server that keyed IA by sender only; the client must fanOut
   *  itself, matching the pre-R3 behaviour. Empty map on legacy servers
   *  or when no clears exist. */
  onHistory?: (
    histories: Record<string, Envelope[]>,
    clearWatermarks: Record<string, string>,
    projection?: string,
    projectionEpoch?: string,
  ) => void;
  /** A past-session log purge (issue #48): the named agent's transcript
   *  should drop every line outside `sessionId`. `clearWatermark`
   *  (issue #109): the ts the server stamped for this clear so the
   *  client can update its local watermark map for future fan-outs
   *  (undefined on legacy servers). Operator-only. */
  onHistoryCleared?: (
    agentId: string,
    sessionId: string,
    clearWatermark?: string,
  ) => void;
  /** A transcript projection reset used only by resume replay. It preserves
   *  structured IA history; `/new` and `/clear` leave the projection intact.
   *  Operator-only. */
  onHistoryReset?: (
    agentId: string,
    preserveInterAgent: boolean,
    replayId?: string,
  ) => void;
  /** Deterministic end boundary for the resume replay paired by replay_id. */
  onHistoryReplayComplete?: (agentId: string, replayId: string) => void;
  /** One inter-agent row restored from a wrapper's sidecar, addressed to
   *  exactly ONE pane (ADR-0051 D3-3 追補 / ふじ 30-10 must-fix M2). The
   *  server chose `paneAgentId` from the replaying wrapper's channel topic,
   *  so unlike an ordinary `envelope` this must NOT be fanned out across
   *  `agent_id ∪ payload.to` — doing so puts the row in a pane a reload
   *  would not show it in. Operator-only. */
  onHistoryReplayEnvelope?: (paneAgentId: string, envelope: Envelope) => void;
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
  /** Engine-catalog probe outcome (Option E, ADR-0039). Correlates with
   *  a prior refreshEngineCatalog() by `request_id`. Operator-only. The
   *  refreshed catalog itself arrives via the paired `hosts` broadcast on
   *  success — this event only carries the completion signal + toast
   *  material (models_count on ok=true, closed-vocab reason on ok=false). */
  onCatalogResult?: (result: EngineCatalogResult) => void;
}

/** Client mirror of protocol/src/index.ts EngineCatalogResult. Kept as a
 *  plain interface so protocol.ts stays runtime-free. */
export interface EngineCatalogResult {
  host_id: string;
  engine: string;
  request_id: string;
  ok: boolean;
  reason?: string;
  models_count?: number;
}

/** Client mirror of protocol/src/index.ts RefreshModelsResult (ADR-0039
 *  F9 v2). Payload of a `type: "refresh_models_result"` envelope. */
export interface RefreshModelsResult {
  agent_id: string;
  request_id: string;
  ok: boolean;
  reason?: string;
  models_count?: number;
}

/** ADR-0036 F7 broadcast payloads (client view). `previous_session_id` /
 *  `to_session_id` are optional; the server omits them per protocol type
 *  when absent (fresh spawn edge / lazy采番 / failure branches). */
export interface SessionResetStartedPayload {
  request_id: string;
  agent_id: string;
  mode: SessionResetMode;
  /** Operator-only (the broadcast is role gated, ADR-0021). Nothing renders
   *  it yet; the parser keeps it so the field is not silently dropped and a
   *  later UI does not have to re-derive it. An unrecognised value falls
   *  back to `operator` — the pre-ADR-0043 meaning of a payload without the
   *  field — rather than discarding the whole event, which would leave the
   *  composer disabled with no matching Completed. */
  origin: SessionResetOrigin;
  previous_session_id?: string;
  /** `agent_self` only, and only when the agent supplied one. */
  reason?: string;
}

export interface SessionResetCompletedPayload {
  request_id: string;
  agent_id: string;
  mode: SessionResetMode;
  previous_session_id?: string;
  to_session_id: string | null;
  /** `/clear` only (ADR-0036 F3 復元, 2026-07-24): ISO ts of the pane's
   *  fresh IA visibility cutoff. Absent for `/new` completions. Let the
   *  live client update its per-agent watermark map without a reload. */
  clear_watermark?: string;
}

export interface SessionResetFailedPayload {
  request_id: string;
  agent_id: string;
  mode: SessionResetMode;
  reason: SessionResetErrorReason;
}

export interface KaoiroConnection {
  disconnect: () => void;
  /** Force-cycles the Phoenix socket: disconnect then reconnect (issue
   *  #123). Use when the tab or network reappears in a state where
   *  Phoenix's built-in reconnect timer never fired — macOS sleep resume
   *  can drop the WebSocket without a close event, leaving Phoenix stuck.
   *  Phoenix's `socket.disconnect(cb)` first clears its internal reconnect
   *  timers, then closes the WS, then invokes the callback; `socket.connect()`
   *  from that callback opens a fresh WS and Phoenix auto-rejoins every
   *  already-joined channel. Safe to call repeatedly — Phoenix's connect()
   *  is a no-op when a connection is already in-flight, so no duplicate
   *  socket is created. */
  reconnect: () => void;
  /** Informs the connection that the browser has regained network access.
   *  Resets ticket-mint backoff and immediately retries a ticket request that
   *  was waiting for its retry timer; it never cycles a healthy transport. */
  notifyOnline: () => void;
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
  /** Manually re-triggers the wrapper's supportedModels() catalog fetch
   * (ADR-0037 F6, phase-18-5 + ADR-0039 F9 v2 = 藤 review D2a). Resets
   * the wrapper's retry counter and succeeded cache so the fetch runs
   * even after the auto-retry cap. The returned promise resolves with the
   * wrapper's paired `refresh_models_result` envelope (correlated by
   * request_id), or rejects on server ack failure / transport disconnect
   * / client-side timeout. Claude-only — the codex adapter has no
   * handler for this control (catalog is static per ADR-0035). The
   * refreshed catalog surfaces via the wrapper's paired state_change
   * (ext.models) BEFORE this promise settles. */
  refreshModels: (agentId: string) => Promise<RefreshModelsResult>;
  /** Requests the runner to freshen its (host, engine) launch-catalog
   * cache and re-register (Option E, ADR-0039). `force=true` bypasses the
   * runner's TTL check (LaunchDialog manual button); `force=false`/omitted
   * lets the runner skip the probe when its cache is still fresh. The
   * returned promise resolves with the full EngineCatalogResult once the
   * runner's paired `catalog_result` arrives (correlated by request_id),
   * or rejects if the server ack fails, the transport disconnects before
   * the result arrives, or the client-side wait times out. The refreshed
   * catalog itself arrives separately via a `hosts` broadcast on success.
   * Claude-only in practice — Codex catalogs are static (ADR-0035 F1),
   * so the runner replies `unsupported_engine` for other engines. */
  refreshEngineCatalog: (
    hostId: string,
    engine: string,
    force?: boolean,
  ) => Promise<EngineCatalogResult>;
  /** Switches the SDK permission mode for the agent's subsequent turns
   * (#58); the server also persists the pick so the wrapper restores it
   * on next start. `mode` must be a closed-enum PermissionMode value. */
  setPermissionMode: (agentId: string, mode: string) => Promise<void>;
  /** Renames the agent's `display_name` while it is running (issue #197
   *  段階3 unit B, wire vocabulary revised issue #219 D23 — `persona`
   *  canonical data is never touched by this call); rejects like
   *  sendInstruction, plus `invalid_name` (server-side trim/64-grapheme/
   *  control-char rejection) and `revision_exhausted` (fail-closed
   *  wire-domain ceiling, `AgentDirectory.rename/2`). `name` is sent
   *  as-is — this client does NOT re-validate it, matching the
   *  server-authoritative-only decision already made for LaunchDialog's
   *  spawn-time name field. The resolved `{ display_name, revision }`
   *  reply is intentionally NOT surfaced here: the display update itself
   *  arrives through the agent's own next envelope (a live wrapper
   *  re-emits `state_change` immediately after applying the sync) or,
   *  for a disconnected/directory-only agent, through the next
   *  `directory` broadcast — this call's resolution only confirms the
   *  server accepted the write. */
  renameAgent: (agentId: string, name: string) => Promise<void>;
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
  /** LaunchDialog persona-scoped effort default (issue #88): resolves with
   *  a `persona_id => effort` map computed server-side from a read-time
   *  join of AgentDirectory and SessionPointers (no new store). Entries are
   *  defensively parsed — a malformed persona_id/effort pair is dropped
   *  without discarding the rest of the map. Rejects on forbidden /
   *  transport disconnect / timeout; the caller (LaunchDialog) must fall
   *  back to the model's own default_effort rather than block launch on
   *  this failing. */
  getLaunchDefaults: () => Promise<Record<string, string>>;
  /** Operator-facing conversation list (issue #276, admin-only first
   *  cut). Pure read-time query mirroring getLaunchDefaults — no push
   *  event, the caller re-fetches on demand. Entries are defensively
   *  parsed (a malformed entry is dropped, not the whole list). Rejects
   *  on forbidden / transport disconnect / timeout. */
  listConversations: () => Promise<ConversationSummary[]>;
  /** Manual conversation close (issue #276): rides the same tombstone +
   *  conversation_closed notification every hard-limit/GC closure
   *  already uses — no new termination path. Resolves on server accept.
   *  Rejects on forbidden / conversation_closed (idempotent double-close)
   *  / unknown_conversation_id / transport disconnect / timeout; the
   *  caller must re-fetch listConversations() to see the updated status
   *  either way (no separate push). */
  closeConversation: (conversationId: string) => Promise<void>;
  /** Operator-facing user list (issue #207). Pure read-time query
   *  mirroring listConversations — no push event, the caller re-fetches
   *  on demand. Entries are defensively parsed (a malformed entry is
   *  dropped, not the whole list). Rejects on forbidden / transport
   *  disconnect / timeout. */
  listUsers: () => Promise<UserSummary[]>;
  /** Renames a user's `display_name` (server API from issue #197 段階3;
   *  dashboard access added by issue #207). Operator-only, any existing
   *  user — no self-service distinction (director's Q1 判定, issue #187
   *  段階3). Rejects like sendInstruction, plus `unknown_user` /
   *  `invalid_name`. The resolved entry is NOT surfaced here, same as
   *  renameAgent — the caller re-fetches listUsers() to see the updated
   *  name (issue #207 design decision: same refresh-on-mutation contract
   *  closeConversation already uses). */
  renameUser: (userId: string, name: string) => Promise<void>;
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
  /** Reissues the short-lived WS ticket before every reconnect. A returned
   *  `unauthorized` is terminal: the httpOnly session cookie has expired or
   *  been revoked. Rejections represent transient failures (offline/server
   *  unavailable) and are retried without opening a socket with the stale
   *  ticket. */
  refreshTicket?: (signal: AbortSignal) => Promise<TicketRefreshResult>;
  /** Called exactly once when refreshTicket reports `unauthorized`. The UI
   *  owns the resulting session teardown / login-form transition. */
  onTicketRefreshUnauthorized?: () => void;
  /** Test-only: WebSocket-compatible transport class handed to Phoenix
   *  Socket (issue #123 regression tests). Production leaves this undefined
   *  and Phoenix falls through to global.WebSocket. Typed as `unknown`
   *  because Phoenix's own transport option is untyped. */
  transport?: unknown;
  /** Test-only: shortened Phoenix heartbeat interval (ms) so tests can
   *  exercise the heartbeatTimeout path in bounded wall-clock (issue
   *  #123). Production leaves this undefined and Phoenix defaults to
   *  30000. */
  heartbeatIntervalMs?: number;
  /** Test-only override for the HTTP ticket-mint deadline. Production uses
   *  TICKET_REFRESH_TIMEOUT_MS, deliberately far below the ticket's 30 s
   *  server TTL so a stalled proxy cannot keep reconnect gated forever. */
  ticketRefreshTimeoutMs?: number;
}

/** Result of renewing the cookie-backed, short-lived WebSocket ticket. */
export type TicketRefreshResult =
  | { kind: "ok"; ticket: string }
  | { kind: "unauthorized" };

/** A ticket request must fail well before the server's 30-second ticket TTL. */
export const TICKET_REFRESH_TIMEOUT_MS = 8_000;

/** Retry no more aggressively than Phoenix's own reconnect behaviour. */
const TICKET_REFRESH_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

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
        // issue #228: absent on a pre-#228 runner — only copy over when
        // present AND correctly typed/in-domain, so a malformed/forged
        // value cannot spoof a build_revision that was never actually
        // declared (issue #228 round 2 MF-3, ふじ 差し戻し: typeof alone
        // let through any string, e.g. an attacker-controlled label
        // masquerading as a SHA).
        //
        // build_revision and build_dirty are narrowed as ONE PAIR, not two
        // independent optionals (issue #228 round 3 MF-2, ふじ 差し戻し):
        // the server's own runner_channel.ex rejects a register carrying
        // only one of the two ("both absent or both present" — round 2
        // MF-3), but this round-2 code independently copied each field,
        // so a malformed revision + a well-typed `dirty: false` let the
        // dirty flag survive alone. That is a fail-open spoofing path: an
        // attacker-forged `build_revision` gets dropped as intended, but
        // `build_dirty: false` then silently reads as "this host's build
        // is confirmed clean" — the same trust-boundary invariant the
        // server enforces was NOT enforced here. Both fields must be
        // present and individually valid, or neither is copied.
        ...(isValidBuildRevision(e.build_revision) && typeof e.build_dirty === "boolean"
          ? { build_revision: e.build_revision, build_dirty: e.build_dirty }
          : {}),
      });
    }
  }
  return hosts;
}

/** Parses the `directory` map (agent_id => entry) into a
 *  Record<string, DirectoryEntry>, skipping malformed entries. `last_seen`
 *  is either an integer (unix seconds) or null (fresh after server restart,
 *  ADR-0030 A5). `persona.id` is required (the stable reference is always
 *  present); `persona.name` / `sprite_set` are carried through AS-IS —
 *  present or absent, never synthesized — since an absent pair is the
 *  "typed unresolved" state issue #219 D21 defines (pack removed since).
 *  `display_name` (issue #219 D19) is required — a malformed/missing one
 *  drops the WHOLE entry, same fail-closed discipline the rest of this
 *  parser already applies to `persona.id`. */
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
      typeof (entry as DirectoryEntry).persona.id === "string" &&
      typeof (entry as DirectoryEntry).display_name === "string"
    ) {
      const e = entry as DirectoryEntry;
      entries[agentId] = {
        persona: {
          id: e.persona.id,
          ...(typeof e.persona.name === "string" ? { name: e.persona.name } : {}),
          ...(typeof e.persona.sprite_set === "string"
            ? { sprite_set: e.persona.sprite_set }
            : {}),
        },
        display_name: e.display_name,
        last_seen: typeof e.last_seen === "number" ? e.last_seen : null,
      };
    }
  }
  return entries;
}

export function parseDeliveryStatus(value: unknown): InterAgentDeliveryStatus | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const issued = raw.issued_seq;
  const acked = raw.acked_seq;
  if (
    typeof issued !== "number" || !Number.isSafeInteger(issued) || issued < 0 ||
    typeof acked !== "number" || !Number.isSafeInteger(acked) || acked < 0 || acked > issued ||
    (raw.pending_since !== undefined && typeof raw.pending_since !== "string") ||
    (issued > acked && typeof raw.pending_since !== "string")
  ) return null;
  return {
    issued_seq: issued,
    acked_seq: acked,
    ...(typeof raw.pending_since === "string" ? { pending_since: raw.pending_since } : {}),
  };
}

export function parseDeliverySnapshot(value: unknown): Record<string, InterAgentDeliveryStatus> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  // AgentId permits "__proto__". A plain object assignment would invoke its
  // legacy prototype setter instead of retaining an own snapshot entry.
  const entries: Record<string, InterAgentDeliveryStatus> = Object.create(null);
  for (const [agentId, candidate] of Object.entries(value)) {
    const status = parseDeliveryStatus(candidate);
    if (status !== null) entries[agentId] = status;
  }
  return entries;
}

/** Parses the join-time snapshot's `tasks` map (agent_id => task_id =>
 *  envelope, ADR-0048 F3, M1 fix-round composite key) into a
 *  {@link TaskTable}, keeping only well-formed `type: "task"` envelopes
 *  whose OUTER agent_id/task_id keys agree with both the envelope and its
 *  payload. A key mismatch would make one parent's tasklist appear in a
 *  different AgentDetail (or let an attacker hide/show an AgentCard ring), so
 *  it is rejected rather than silently re-keyed. Drop any agent_id whose
 *  inner map ends up empty.
 *  A viewer join always yields `tasks: {}` server-side (the same
 *  operator-only server-gate path as `hosts`/`log`/`result`, ADR-0021),
 *  so this returns {} for that value regardless. */
export function parseTasks(value: unknown): TaskTable {
  // Security review (issue #180 fix-round, 2026-08-09): `Object.create(null)`
  // instead of `{}` for both the outer table and each per-agent inner map.
  // This loop accumulates via repeated bracket ASSIGNMENT (`tasks[agentId] =
  // ...`, `agentTasks[taskId] = ...`), which is genuinely unsafe on a plain
  // `{}` — the wire `agent_id` charset (server/lib/kaoiro_server_web/
  // agent_id.ex, `[A-Za-z0-9._-]{1,256}`) permits the literal string
  // "__proto__", and `task_id` has no charset restriction at all beyond
  // non-empty. Assigning THAT key on an object whose prototype chain still
  // includes `Object.prototype` invokes its `__proto__` accessor and swaps
  // the object's actual `[[Prototype]]` instead of adding an entry
  // (prototype pollution), corrupting later `in`/lookup checks. A
  // null-prototype object has no such accessor to invoke, so the same
  // assignment becomes an ordinary own-property write regardless of key.
  const tasks: TaskTable = Object.create(null);
  if (typeof value !== "object" || value === null) return tasks;
  for (const [agentId, entry] of Object.entries(value)) {
    if (typeof entry !== "object" || entry === null) continue;
    const agentTasks: Record<string, Envelope> = Object.create(null);
    for (const [taskId, envelope] of Object.entries(entry)) {
      if (!isEnvelope(envelope)) continue;
      const task = taskOf(envelope);
      if (
        task &&
        envelope.agent_id === agentId &&
        task.agent_id === agentId &&
        task.task_id === taskId
      ) {
        agentTasks[taskId] = envelope;
      }
    }
    if (Object.keys(agentTasks).length > 0) tasks[agentId] = agentTasks;
  }
  return tasks;
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

/** Unknown / missing origin degrades to `operator` rather than rejecting the
 *  event: a payload without the field is a pre-ADR-0043 server, where every
 *  reset WAS operator-initiated. Dropping the Started broadcast would strand
 *  the composer in its disabled state. */
function parseResetOrigin(value: unknown): SessionResetOrigin {
  return value === "agent_self" ? "agent_self" : "operator";
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
    origin: parseResetOrigin(p.origin),
    ...(typeof p.previous_session_id === "string"
      ? { previous_session_id: p.previous_session_id }
      : {}),
    // Server-side free text, kept verbatim but never rendered as markdown
    // by any current consumer. Absent unless the agent supplied one.
    ...(typeof p.reason === "string" && p.reason !== ""
      ? { reason: p.reason }
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
    ...(typeof p.clear_watermark === "string" && p.clear_watermark !== ""
      ? { clear_watermark: p.clear_watermark }
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

/** Normalizes the backwards-compatible `history_reset` payload. */
export function parseHistoryReset(
  value: unknown,
): { agent_id: string; preserve_inter_agent: boolean; replay_id?: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const p = value as Partial<HistoryResetPayload>;
  if (typeof p.agent_id !== "string") return null;
  return {
    agent_id: p.agent_id,
    preserve_inter_agent:
      typeof p.preserve_inter_agent === "boolean"
        ? p.preserve_inter_agent
        : true,
    ...(typeof p.replay_id === "string" && p.replay_id !== ""
      ? { replay_id: p.replay_id }
      : {}),
  };
}

export function parseHistoryReplayComplete(
  value: unknown,
): HistoryReplayCompletePayload | null {
  if (typeof value !== "object" || value === null) return null;
  const p = value as Partial<HistoryReplayCompletePayload>;
  if (
    typeof p.agent_id !== "string" ||
    typeof p.replay_id !== "string" ||
    p.replay_id === ""
  ) {
    return null;
  }
  return { agent_id: p.agent_id, replay_id: p.replay_id };
}

export interface HistoryReplayEnvelopePayload {
  paneAgentId: string;
  envelope: Envelope;
}

/** Narrows the `history_replay_envelope` push (ADR-0051 D3-3 追補). The pane
 *  is server-chosen, so its absence is not something to guess around — a
 *  malformed push is dropped rather than degraded into the fan-out this
 *  event exists to avoid. Only `inter_agent_message` is accepted: replayed
 *  transcript lines keep riding the ordinary `envelope` route. */
export function parseHistoryReplayEnvelope(
  value: unknown,
): HistoryReplayEnvelopePayload | null {
  if (typeof value !== "object" || value === null) return null;
  const p = value as { pane_agent_id?: unknown; envelope?: unknown };
  if (typeof p.pane_agent_id !== "string" || p.pane_agent_id === "") return null;
  if (!isEnvelope(p.envelope)) return null;
  if (p.envelope.type !== "inter_agent_message") return null;
  return { paneAgentId: p.pane_agent_id, envelope: p.envelope };
}

/** ふじ 4th advisory 2 (2026-07-23): single production helper that
 *  wraps the `onHistory` glue App.svelte used to inline (branch on
 *  projection marker → fanOut fallback for markerless legacy servers →
 *  merge with local live-buffer). Extracted so App and the R3 composite
 *  table test both call the same code path — the pre-4th test's
 *  `applyOnHistory` was a hand-rolled re-implementation that could
 *  drift silently.
 *
 *  Contract:
 *    - `projection === "per-pane-v1"` → server already fanned out per
 *      pane; use `histories` directly.
 *    - anything else (undefined, unknown value, empty string) → legacy
 *      sender-keyed payload; run `fanOutInterAgentHistory` to build
 *      the receiver copies before merge.
 *    - `mergeHistories` dedupes by identity key so the old-client +
 *      new-server case (marker ignored, fanOut re-adds a receiver
 *      copy already present) collapses to one visible copy per pane. */
export function projectAndMergeHistory(
  histories: Record<string, Envelope[]>,
  clearWatermarks: Record<string, string>,
  projection: string | undefined,
  local: Record<string, Envelope[]>,
): Record<string, Envelope[]> {
  const projected =
    projection === "per-pane-v1"
      ? histories
      : fanOutInterAgentHistory(histories, clearWatermarks);
  return mergeHistories(projected, local);
}

/** ふじ A2 must-fix (2026-07-23, 3rd review): merges a per-agent history
 *  map (`histories`, from `onHistory`) with a per-agent live-buffer
 *  map (`local`, accumulated between join and the history push). Each
 *  pane is deduped by `mergeTranscriptEntries` on
 *  `agent_id|session_id|ts|seq|type` — the identity key is what makes
 *  the R3 rolling-upgrade case (old client + new server) safe: even
 *  when old client's `fanOutInterAgentHistory` produces a receiver
 *  copy the new server already sent, both hit the same identity key
 *  and only one survives.
 *
 *  Extracted from App.svelte so the 4-quadrant composite test
 *  (new/old client × new/old server → merged pane) can exercise the
 *  same production code, not a reimplementation. */
export function mergeHistories(
  histories: Record<string, Envelope[]>,
  local: Record<string, Envelope[]>,
): Record<string, Envelope[]> {
  const merged: Record<string, Envelope[]> = {};
  const ids = new Set([...Object.keys(histories), ...Object.keys(local)]);
  for (const id of ids) {
    merged[id] = mergeTranscriptEntries(histories[id] ?? [], local[id] ?? []);
  }
  return merged;
}

/** Layout gate for the response-timeline pane. Reply logs are
 *  operator-only (ADR-0012), so viewer sessions never see the pane.
 *  Previously AND-gated with a `wide` (`min-width: 1600px`) viewport
 *  switch (#25); that threshold was removed on 2026-07-24 so the pane
 *  shows at all widths — narrow viewports accept smaller tiles instead
 *  of hiding the pane. Extracted so `App.svelte`, `AgentGridShell`,
 *  and the integration test share the exact same gate. */
export function shouldShowResponseTimeline(operator: boolean): boolean {
  return operator;
}

/** ふじ R4 must-fix (2026-07-23): best-effort per-pane filter for a
 *  LIVE `inter_agent_message` envelope. The server-side authority is the
 *  ingress order tuple (see agents_channel `merged_histories/*`), but
 *  live delivery cannot ride that domain — it uses the envelope's wire
 *  `ts` string against the display watermark string. Clock skew between
 *  the operator and the wrapper may cause a transient mismatch; a
 *  page reload re-runs the server-authoritative filter and converges.
 *
 *  Keeps every `candidate` pane where either the pane has no watermark,
 *  the envelope has no string `ts`, or the envelope's `ts` is strictly
 *  greater than the pane's watermark (post-clear). */
export function filterInterAgentTargetsByWatermark(
  envelope: Envelope,
  candidates: Iterable<string>,
  clearWatermarks: Record<string, string>,
): string[] {
  const ts = typeof envelope.ts === "string" ? envelope.ts : undefined;
  const kept: string[] = [];
  for (const id of candidates) {
    const wm = clearWatermarks[id];
    if (typeof wm !== "string" || ts === undefined || ts > wm) {
      kept.push(id);
    }
  }
  return kept;
}

/** ふじ R4 must-fix (2026-07-23): applies operator `clear_history` to a
 *  single pane's transcript. Two-stage drop:
 *   1. session filter (issue #48 original behaviour): keep only
 *      envelopes whose `session_id` matches the current session.
 *   2. watermark filter (R4): also drop any `inter_agent_message`
 *      whose wire `ts` is `<= clearWatermark`, even if session_id
 *      matches — a same-session pre-clear IA would otherwise leak on
 *      the live path (the reload path already filters it server-side
 *      via the ingress order tuple).
 *  Both filters are best-effort against clock skew; a page reload uses
 *  the authoritative server ordering domain. */
export function filterAfterHistoryCleared(
  entries: Envelope[],
  sessionId: string,
  clearWatermark?: string,
): Envelope[] {
  return entries.filter((entry) => {
    if (entry.session_id !== sessionId) return false;
    if (
      entry.type === "inter_agent_message" &&
      typeof clearWatermark === "string" &&
      typeof entry.ts === "string" &&
      entry.ts <= clearWatermark
    ) {
      return false;
    }
    return true;
  });
}

export interface ParsedHistoryPayload {
  histories: Record<string, Envelope[]>;
  clearWatermarks: Record<string, string>;
  projection?: string;
  projectionEpoch?: string;
}

/** Extracts the fields the `history` push carries from an operator-role
 *  join. Split out so tests can exercise the wire-shape handling without
 *  spinning up a Phoenix channel mock (ふじ R3 must-fix, 2026-07-23):
 *   - `agents`: per-agent envelope array (skipped when non-array).
 *   - `clear_watermarks` (issue #109): agent_id => ISO ts display hint.
 *     Missing/malformed values fall through to an empty map.
 *   - `history_projection`: wire marker `"per-pane-v1"` when the server
 *     has already fanned IA out per pane; absent (undefined) means a
 *     legacy sender-keyed payload and the client must fanOut itself.
 *     A non-string / empty value collapses to undefined — the safer
 *     default is legacy branch (running fanOut on already-fanned data
 *     duplicates; the reverse only re-sorts idempotently). */
export function parseHistoryPayload(value: unknown): ParsedHistoryPayload {
  const empty: ParsedHistoryPayload = { histories: {}, clearWatermarks: {} };
  if (value === null || typeof value !== "object") return empty;
  const payload = value as {
    agents?: unknown;
    clear_watermarks?: unknown;
    history_projection?: unknown;
    projection_epoch?: unknown;
  };
  const histories: Record<string, Envelope[]> = {};
  if (payload.agents !== null && typeof payload.agents === "object") {
    for (const [id, entries] of Object.entries(payload.agents)) {
      if (Array.isArray(entries)) {
        histories[id] = entries.filter(isEnvelope);
      }
    }
  }
  const clearWatermarks: Record<string, string> = {};
  const rawWm = payload.clear_watermarks;
  if (rawWm !== null && typeof rawWm === "object") {
    for (const [id, ts] of Object.entries(rawWm)) {
      if (typeof ts === "string" && ts !== "") {
        clearWatermarks[id] = ts;
      }
    }
  }
  const projection =
    typeof payload.history_projection === "string" &&
    payload.history_projection !== ""
      ? payload.history_projection
      : undefined;
  // ADR-0051 D4: opaque id of the server-side projection's lifetime.
  // Absent = legacy server, and `applyProjectionEpoch` then keeps the old
  // merge behaviour rather than guessing.
  const projectionEpoch =
    typeof payload.projection_epoch === "string" &&
    payload.projection_epoch !== ""
      ? payload.projection_epoch
      : undefined;
  return {
    histories,
    clearWatermarks,
    ...(projection === undefined ? {} : { projection }),
    ...(projectionEpoch === undefined ? {} : { projectionEpoch }),
  };
}

export interface ProjectionEpochInput {
  /** Epoch the current baseline was built against; null before the first
   *  `history` push of this page load. */
  previousEpoch: string | null;
  /** Epoch on the push being applied; undefined on a legacy server. */
  incomingEpoch: string | undefined;
  histories: Record<string, Envelope[]>;
  /** Watermarks on this push. */
  incomingWatermarks: Record<string, string>;
  /** Watermarks the client currently holds. */
  previousWatermarks: Record<string, string>;
  projection: string | undefined;
  /** Everything the client currently shows — the merge baseline. */
  baseline: Record<string, Envelope[]>;
  /** ONLY the live envelopes this connection received since it joined. */
  sinceJoin: Record<string, Envelope[]>;
}

export interface ProjectionEpochResult {
  logs: Record<string, Envelope[]>;
  clearWatermarks: Record<string, string>;
  epoch: string | null;
  /** True when the baseline was thrown away. The caller owns the rest of
   *  the history-derived state (replay markers, read / new timeline keys)
   *  and must reset it too. */
  discarded: boolean;
}

/** Applies the ADR-0051 D4 projection-epoch rule to one `history` push.
 *
 * The problem it solves: a tab left open across a server restart merges the
 * authoritative history into a local buffer that still holds pre-restart
 * lines the server no longer has — ghosts that never go away.
 *
 * Why not simply drop everything local on mismatch: between this
 * connection's join and the `history` push, genuinely new live envelopes
 * can already have arrived. They belong to the NEW projection and are not
 * in the push (the server built it before they existed), so a blanket drop
 * loses real rows (ふじ 1 巡目 must-fix 4). Hence the split: the old
 * baseline goes, `sinceJoin` stays.
 *
 * A mismatch is only actionable when both epochs are known — an absent
 * incoming epoch means a legacy server, and an absent previous one means
 * this is the first push, where there is no stale baseline by definition.
 */
export function applyProjectionEpoch(
  input: ProjectionEpochInput,
): ProjectionEpochResult {
  const discarded =
    input.incomingEpoch !== undefined &&
    input.previousEpoch !== null &&
    input.incomingEpoch !== input.previousEpoch;

  const clearWatermarks = discarded
    ? { ...input.incomingWatermarks }
    : { ...input.previousWatermarks, ...input.incomingWatermarks };

  const local = discarded ? input.sinceJoin : input.baseline;

  return {
    logs: projectAndMergeHistory(
      input.histories,
      clearWatermarks,
      input.projection,
      local,
    ),
    clearWatermarks,
    epoch: input.incomingEpoch ?? input.previousEpoch,
    discarded,
  };
}

/** Instance-scoped pending map for `refreshModels()` waiters (ADR-0039 F9
 *  v2). Same shape as `CatalogPendingStore` but scoped to
 *  `RefreshModelsResult` — kept separate so a mis-routed request_id
 *  cannot cross paths with LaunchDialog refresh waits. */
export interface RefreshPendingStore {
  register: (request_id: string) => Promise<RefreshModelsResult>;
  cancel: (request_id: string, reason: string) => void;
  onResult: (result: RefreshModelsResult) => void;
  drain: (reason: string) => void;
  size: () => number;
}

export function makeRefreshPendingStore(
  timeoutMs: number = 45_000,
): RefreshPendingStore {
  interface Waiter {
    resolve: (r: RefreshModelsResult) => void;
    reject: (e: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }
  const pending = new Map<string, Waiter>();
  const cancel = (id: string, reason: string): void => {
    const w = pending.get(id);
    if (w === undefined) return;
    clearTimeout(w.timer);
    pending.delete(id);
    w.reject(new Error(reason));
  };
  return {
    register: (id) =>
      new Promise<RefreshModelsResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("refresh_models_result timeout"));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
      }),
    cancel,
    onResult: (r) => {
      const w = pending.get(r.request_id);
      if (w === undefined) return;
      clearTimeout(w.timer);
      pending.delete(r.request_id);
      w.resolve(r);
    },
    drain: (reason) => {
      for (const [id, w] of pending) {
        clearTimeout(w.timer);
        pending.delete(id);
        w.reject(new Error(reason));
      }
    },
    size: () => pending.size,
  };
}

/** Client-side wait timeout for a refreshEngineCatalog request. Sits well
 *  above the runner's own hard cap (35s) so a slow probe still settles
 *  through the pending map rather than timing out here first. */
const CATALOG_WAIT_TIMEOUT_MS = 45_000;

interface CatalogWaiter {
  resolve: (result: EngineCatalogResult) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Catalog-pending state lives INSIDE connectKaoiro so two concurrent
 *  connections do not share a Map (藤 review A). Exported for the unit
 *  test to exercise the register/resolve/drain lifecycle without
 *  standing up a real Phoenix channel; production code always
 *  constructs one per connectKaoiro call. */
export interface CatalogPendingStore {
  register: (request_id: string) => Promise<EngineCatalogResult>;
  cancel: (request_id: string, reason: string) => void;
  onResult: (result: EngineCatalogResult) => void;
  drain: (reason: string) => void;
  size: () => number;
}

export function makeCatalogPendingStore(
  timeoutMs: number = CATALOG_WAIT_TIMEOUT_MS,
): CatalogPendingStore {
  const pending = new Map<string, CatalogWaiter>();
  const cancel = (request_id: string, reason: string): void => {
    const w = pending.get(request_id);
    if (w === undefined) return;
    clearTimeout(w.timer);
    pending.delete(request_id);
    w.reject(new Error(reason));
  };
  return {
    register: (request_id) =>
      new Promise<EngineCatalogResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(request_id);
          reject(new Error("catalog_result timeout"));
        }, timeoutMs);
        pending.set(request_id, { resolve, reject, timer });
      }),
    cancel,
    onResult: (result) => {
      const w = pending.get(result.request_id);
      if (w === undefined) return;
      clearTimeout(w.timer);
      pending.delete(result.request_id);
      w.resolve(result);
    },
    drain: (reason) => {
      for (const [id, w] of pending) {
        clearTimeout(w.timer);
        pending.delete(id);
        w.reject(new Error(reason));
      }
    },
    size: () => pending.size,
  };
}

/** Defensive parse: any missing/malformed field drops the message so the
 *  UI never fires on an ill-formed catalog_result. */
function parseCatalogResult(payload: unknown): EngineCatalogResult | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Partial<EngineCatalogResult>;
  if (
    typeof p.host_id !== "string" ||
    typeof p.engine !== "string" ||
    typeof p.request_id !== "string" ||
    typeof p.ok !== "boolean"
  ) {
    return null;
  }
  return {
    host_id: p.host_id,
    engine: p.engine,
    request_id: p.request_id,
    ok: p.ok,
    ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
    ...(typeof p.models_count === "number"
      ? { models_count: p.models_count }
      : {}),
  };
}

/** Defensive parse of the launch_defaults reply (issue #88): fail-closed
 *  per entry, not per message — a malformed persona_id/effort pair is
 *  dropped, but the rest of the map survives (ふじ review). */
function parseLaunchDefaults(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, string> = {};
  for (const [personaId, effort] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    if (personaId !== "" && typeof effort === "string" && effort !== "") {
      out[personaId] = effort;
    }
  }
  return out;
}

/** Defensive parse of the list_conversations reply (issue #276):
 *  fail-closed per entry — a malformed entry is dropped, not the whole
 *  list. `tokens` is nullable on the wire (dropped server-side on
 *  close); `started_at` is nullable only as a legacy/defensive fallback
 *  -- a closed tombstone itself still carries its real value (director
 *  decision A). `null` passes through as-is for both; anything else
 *  non-numeric/non-string is treated as absent. */
function parseConversationList(raw: unknown): ConversationSummary[] {
  if (!Array.isArray(raw)) return [];
  const out: ConversationSummary[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const p = item as Record<string, unknown>;
    if (
      typeof p.conversation_id !== "string" ||
      !Array.isArray(p.participants) ||
      !p.participants.every((v) => typeof v === "string") ||
      typeof p.turns !== "number" ||
      (p.status !== "open" && p.status !== "closed")
    ) {
      continue;
    }
    out.push({
      conversationId: p.conversation_id,
      participants: p.participants as string[],
      turns: p.turns,
      tokens: typeof p.tokens === "number" ? p.tokens : null,
      status: p.status,
      startedAt: typeof p.started_at === "string" ? p.started_at : null,
    });
  }
  return out;
}

// Same charset `AgentId.valid?/1` enforces server-side (`agent_id.ex`,
// `^[A-Za-z0-9._-]{1,256}$`) -- user_id shares the SAME id space as
// agent_id (ADR-0050 D1), and the server's `fetch_user_id/1` reuses
// `AgentId.valid?/1` to validate it (`rename_user`'s own `invalid_user_id`
// reject). Narrowing to it here is what makes `UserSummary.id` a value
// this client can safely feed back into `renameUser(userId, ...)`.
const USER_ID_PATTERN = /^[A-Za-z0-9._-]{1,256}$/;

// Every role `Users.all_with_role/1` can resolve a user to -- the auth
// SoT's closed role vocabulary (ADR-0050 D2: admin > operator > viewer).
// A role outside this set cannot come from a genuine reply (an unknown
// role is filtered out server-side, `Users.all_with_role/1`'s own doc),
// so an entry claiming one is dropped rather than passed through typed
// as `UserSummary["role"]` when it structurally cannot be one.
const USER_ROLES = new Set(["viewer", "operator", "admin"]);

/** Defensive parse of the list_users reply (issue #207): fail-closed per
 *  entry, mirroring parseConversationList — a malformed entry is
 *  dropped, not the whole list. `id`/`kind`/`role` are narrowed to their
 *  actual value domains (see USER_ID_PATTERN/USER_ROLES above; `kind` is
 *  narrowed to the literal `"user"` — every production `Users.get_or_create`
 *  call site hardcodes it, `auth_controller.ex`/`session_controller.ex`).
 *  `display_name` is DELIBERATELY left unnarrowed beyond "is a string"
 *  (director decision, issue #207 round 2): this list is the admin
 *  surface for FIXING an existing bad display_name, so narrowing the
 *  parser here would hide the very row an operator needs to see and
 *  correct. Input-side validation (trim/64-grapheme/control-char) is the
 *  server's job on the way INTO Users, not this reply's job on the way
 *  out (`rename_user`'s `invalid_name` reject already owns that). */
function parseUserList(raw: unknown): UserSummary[] {
  if (!Array.isArray(raw)) return [];
  const out: UserSummary[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const p = item as Record<string, unknown>;
    if (
      typeof p.id !== "string" ||
      !USER_ID_PATTERN.test(p.id) ||
      p.kind !== "user" ||
      typeof p.display_name !== "string" ||
      typeof p.role !== "string" ||
      !USER_ROLES.has(p.role)
    ) {
      continue;
    }
    out.push({
      id: p.id,
      kind: p.kind,
      displayName: p.display_name,
      role: p.role as UserSummary["role"],
    });
  }
  return out;
}

/** LaunchDialog persona effort default resolution (issue #88). Pure helper
 *  isolated so the "a manual pick always wins" guard is unit-testable
 *  without mounting LaunchDialog.svelte (mirrors `shouldForceReconnectOnVisible`
 *  in this same file). Returns the effort to APPLY, or `undefined` for "no
 *  change" — the caller only assigns when a value comes back, so a late
 *  getLaunchDefaults() reply (or any other re-evaluation) can never
 *  overwrite an operator's manual effort pick, and an unknown/invalid-for-
 *  the-current-model preference simply leaves whatever chooseModel already
 *  computed (its own default_effort fallback) in place. */
export function resolveLaunchDefaultEffort(opts: {
  manualPick: boolean;
  preferred: string | undefined;
  effortLevels: readonly string[];
}): string | undefined {
  if (opts.manualPick) return undefined;
  if (opts.preferred !== undefined && opts.effortLevels.includes(opts.preferred)) {
    return opts.preferred;
  }
  return undefined;
}

/** The protocol version this client speaks (ADR-0015, protocol.md
 *  「version」節). Mirrors `WRAPPER_PROTOCOL_VERSION` / `RUNNER_PROTOCOL_VERSION`
 *  in the other parties — same rule, separate constant per party since each
 *  stamps its own outbound messages independently. Single fixed value.
 *
 *  Formerly `RUNNER_CONTROL_VERSION`, scoped to the runner-relay subset
 *  (`stop` / `enumerate_sessions` / `refresh_engine_catalog`). That name was
 *  itself part of the gap issue #218 closes: ADR-0015 covers EVERY client ->
 *  server message and draws no runner-relay exception, but a constant named
 *  for the subset invited exactly the "this one is not relayed, so it needs
 *  no version" misreading that became a must-fix twice (#88, #197 段階3). */
const CLIENT_PROTOCOL_VERSION = "0";

/** ADR-0015 receiver rule for server -> client JSON pushes. */
export function warnOnServerVersionMismatch(event: string, payload: unknown): void {
  const version =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).version
      : undefined;
  if (version === CLIENT_PROTOCOL_VERSION) return;
  const declared = version === undefined ? "(absent)" : JSON.stringify(version);
  console.warn(
    `${event}: server declared protocol version ${declared}; ` +
      `accepting as ${JSON.stringify(CLIENT_PROTOCOL_VERSION)} (ADR-0015 best-effort accept)`,
  );
}

/** Every server -> dashboard event is checked at the binding boundary.
 * `history_replay_envelope` is an ordinary JSON frame and is therefore
 * checked too: the server stamps its flat version when it leaves the final
 * egress funnel (issue #270). */
export const CLIENT_EVENT_VERSION_POLICY = {
  snapshot: "checked",
  task_snapshot: "checked",
  delivery_snapshot: "checked",
  history: "checked",
  hosts: "checked",
  directory: "checked",
  history_cleared: "checked",
  history_reset: "checked",
  history_replay_complete: "checked",
  history_replay_envelope: "checked",
  agent_deleted: "checked",
  delivery_status: "checked",
  session_reset_started: "checked",
  session_reset_completed: "checked",
  session_reset_failed: "checked",
  envelope: "checked",
  spawn_result: "checked",
  runner_sessions: "checked",
  catalog_result: "checked",
} as const satisfies Record<string, "checked">;

export type ClientEventName = keyof typeof CLIENT_EVENT_VERSION_POLICY;

/** The only server-event registration point: all handlers receive the
 * best-effort version check before their event-specific parser runs. */
function bindServerEvent<T>(
  channel: Channel,
  event: ClientEventName,
  handler: (payload: T) => void,
): void {
  channel.on(event, (payload: unknown) => {
    if (CLIENT_EVENT_VERSION_POLICY[event] === "checked") {
      warnOnServerVersionMismatch(event, payload);
    }
    handler(payload as T);
  });
}

/** The single client -> server JSON send point (issue #218).
 *
 *  ADR-0015 requires a flat `version` frame key on every message between the
 *  three parties. Stamping it HERE rather than at each call site makes an
 *  omission structurally impossible instead of a per-call-site discipline —
 *  the same reasoning behind `bindControlEvents` on the runner's receive
 *  side. `version` is spread LAST so a caller cannot override or drop it.
 *
 *  One carve-out: `attach_chunk` is a V2 BINARY frame (a length-prefixed
 *  header plus raw bytes, not JSON), so it has nowhere to put a `version`
 *  key without a wire change. It pushes directly and is documented as a
 *  permanent exception in `docs/specs/protocol.md`. */
function pushVersioned(
  channel: Channel,
  event: string,
  payload: Record<string, unknown>,
) {
  return channel.push(event, { ...payload, version: CLIENT_PROTOCOL_VERSION });
}

function pushAsync(
  channel: Channel,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    pushVersioned(channel, event, payload)
      .receive("ok", () => resolve())
      .receive("error", (reason: { reason?: string } | undefined) =>
        reject(new Error(reason?.reason ?? "error")),
      )
      .receive("timeout", () => reject(new Error("timeout")));
  });
}

/** Wake-guard threshold for the tab-visibility rebuild path (issue #123).
 *  On visible resume, if the tab was hidden longer than this, App.svelte
 *  calls connectKaoiro's reconnect() unconditionally to catch the
 *  macOS-sleep case where the WebSocket died silently but Phoenix's
 *  onClose / heartbeat-timeout has not yet fired. 60000 ms matches
 *  Phoenix client's heartbeat_interval (30 s) × 2 dead-connection horizon,
 *  so anything Phoenix would eventually catch on its own is caught here
 *  up-front without brief tab switches triggering a rebuild. */
export const HIDDEN_RECONNECT_THRESHOLD_MS = 60_000;

/** Pure helper for App.svelte's visibilitychange handler (issue #123).
 *  `hiddenAt` is the timestamp the tab last went hidden (null if it never
 *  hid while this session was alive). Returns whether the visible-resume
 *  transition should trigger a full socket rebuild. Isolated here so the
 *  60000-ms boundary is unit-testable without mounting App.svelte. */
export function shouldForceReconnectOnVisible(
  hiddenAt: number | null,
  now: number,
  thresholdMs: number = HIDDEN_RECONNECT_THRESHOLD_MS,
): boolean {
  if (hiddenAt === null) return false;
  return now - hiddenAt >= thresholdMs;
}

/** Wake-signal reasons App.svelte forwards to decideWakeAction (issue #123
 *  round 3). Kept as a discriminated string union so tests can enumerate
 *  every branch. */
export type WakeReason =
  | "online"
  | "visibility-visible"
  | "visibility-hidden";

/** Decision App.svelte should carry out in response to a wake signal.
 *   - noop: no action; status is healthy and the visibility gap is short.
 *   - reconnect: status is `disconnected` and we should ask the connection
 *     to cycle. Both `online` and short-hidden `visibility-visible` land
 *     here — App.svelte does not need to distinguish.
 *   - force-reconnect: hidden gap crossed HIDDEN_RECONNECT_THRESHOLD_MS,
 *     so we cycle regardless of `status` (heartbeat-death catch-up).
 *   - record-hidden: hidden transition; App.svelte should capture the
 *     current timestamp into `hiddenAt`. */
export type WakeDecision =
  | "noop"
  | "reconnect"
  | "force-reconnect"
  | "record-hidden";

/** Pure lifecycle decision for App.svelte's wake handlers (issue #123
 *  round 3, ふじ再レビュー must-fix 2 A). Concentrates the DOM-event ->
 *  action mapping in one testable function so the visibility / online
 *  branches can be pinned without mounting App.svelte. `hiddenAt` is the
 *  timestamp the tab last went hidden (null if it never hid while this
 *  session was alive); `now` is Date.now() at signal receipt; `status` is
 *  the latest ConnectionStatus observed. */
export function decideWakeAction(
  reason: WakeReason,
  status: ConnectionStatus,
  hiddenAt: number | null,
  now: number,
  thresholdMs: number = HIDDEN_RECONNECT_THRESHOLD_MS,
): WakeDecision {
  if (reason === "visibility-hidden") return "record-hidden";
  if (
    reason === "visibility-visible" &&
    shouldForceReconnectOnVisible(hiddenAt, now, thresholdMs)
  ) {
    return "force-reconnect";
  }
  return status === "disconnected" ? "reconnect" : "noop";
}

/** Dispatch for App.svelte's browser `online` handler (issue #162 advisory
 *  2). The old handler called `connection.notifyOnline()` unconditionally
 *  and THEN `connection.reconnect()` when `decideWakeAction` returned
 *  "reconnect" — both from the same event. `reconnect()` already performs
 *  everything `notifyOnline()` would in that case (it calls
 *  `resetTicketRefreshBackoff()` and its own `requireFreshTicket()`, which
 *  cancels any pending retry timer, PLUS the full socket/channel rebuild
 *  `notifyOnline()` does not do), so the extra `notifyOnline()` call was
 *  pure redundancy — worse, if `notifyOnline()`'s own immediate-retry
 *  branch had just started a ticket mint, `reconnect()`'s
 *  `requireFreshTicket()` would abort THAT mint and start another,
 *  wasting an RTT (this turned out to be the dominant trigger for issue
 *  #162 advisory 1's "in-flight mint aborted by a near-simultaneous wake"
 *  symptom — see the analysis on `requireFreshTicket` below). Splitting
 *  the two calls here removes both the redundant call and that self-
 *  inflicted abort for the single-`online`-event case; only a genuine
 *  near-simultaneous `visibilitychange` + `online` (two SEPARATE events)
 *  can still race two `reconnect()`-driven mints against each other.
 *  Exported and pure-dispatch (mirrors `decideWakeAction`) so the split is
 *  unit-testable without mounting App.svelte. */
export function dispatchOnlineWake(
  decision: WakeDecision,
  connection: Pick<KaoiroConnection, "notifyOnline" | "reconnect">,
): void {
  if (decision === "reconnect" || decision === "force-reconnect") {
    connection.reconnect();
  } else {
    connection.notifyOnline();
  }
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

  // Instance-scoped pending maps (ADR-0039 F9 v2 = 藤 review D2a): a second
  // connectKaoiro's disconnect cannot drain THIS instance's waiters. Kept
  // above socket/channel so setupChannelHandlers / setupSocketHandlers can
  // close over them from a single lexical scope.
  const catalogPending = makeCatalogPendingStore();
  const refreshPending = makeRefreshPendingStore();

  // ふじ review must-fix (issue #123): safe Socket+Channel rebuild state.
  //   disposed        — terminal flag; after disconnect() every pending
  //                     teardown callback is a no-op so a delayed
  //                     socket.disconnect(cb) cannot resurrect a zombie
  //                     socket ~1.5 s after endSession (must-fix 2).
  //   cycleGeneration — bumped on every reconnect() AND on disconnect(); a
  //                     teardown callback whose generation is stale refuses
  //                     to rebuild.
  //   cycleInFlight   — reconnect serialisation guard. visibilitychange +
  //                     online often fire within milliseconds of each other
  //                     on wake; without this each event would start its
  //                     own rebuild and multiply the socket count.
  //   (round 7 note) arm-time chain-provenance guarding — how we tell a
  //     stale teardown chain from a live one when scheduleTimeout fires —
  //     lives on the wrapped socket.teardown below (closure over
  //     teardownGen). A prior round-6 attempt used a fire-time live compare
  //     (allowedScheduleGen); a completed reconnect re-baselined it and let
  //     stale chains slip through. arm-time capture is the fix.
  let disposed = false;
  let cycleGeneration = 0;
  let cycleInFlight = false;

  // Tickets last just 30 seconds. Phoenix evaluates Socket params on every
  // transport connect, but that evaluation is synchronous, whereas minting a
  // replacement ticket is HTTP. Keep the params object mutable and gate every
  // post-initial socket.connect() through refreshTicket below. This covers
  // both our explicit wake rebuild and Phoenix's own reconnectTimer path.
  let ticketRefreshRequired = false;
  let ticketRefreshInFlight = false;
  let ticketRefreshPendingConnect = false;
  let ticketRefreshGeneration = 0;
  let ticketRefreshRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let ticketRefreshRetryAttempt = 0;
  let ticketRefreshController: AbortController | undefined;
  let ticketRefreshTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectTicketRefresh: ((reason: Error) => void) | undefined;

  function cancelTicketRefreshRetry(): void {
    if (ticketRefreshRetryTimer !== undefined) {
      clearTimeout(ticketRefreshRetryTimer);
      ticketRefreshRetryTimer = undefined;
    }
  }

  function resetTicketRefreshBackoff(): void {
    ticketRefreshRetryAttempt = 0;
  }

  function abortTicketRefresh(): void {
    ticketRefreshController?.abort();
    // Promise.race below must settle even when a custom refreshTicket
    // callback ignores AbortSignal (as a stalled mock/proxy can). Otherwise
    // ticketRefreshInFlight would permanently close every reconnect gate.
    rejectTicketRefresh?.(new Error("ticket refresh aborted"));
  }

  // issue #162 advisory 1 design note — MEASURED, then SHELVED (あお
  // 2026-08-05 判断). Left as analysis + decision record for whoever next
  // looks at this, so "investigated and shelved" isn't mistaken for
  // "missed":
  //
  // This one function conflates two distinct intents every caller relies on:
  //   (a) "a fresh ticket is now required" — onClose / onError / reconnect() /
  //       the teardown wrapper all just need this recorded. None of them has
  //       any positive reason to distrust an ALREADY in-flight mint.
  //   (b) "abandon whatever mint is in flight and start over" — ONLY
  //       notifyOnline()'s in-flight branch has a stated reason for this
  //       ("The old request may be stuck behind a captive portal/proxy").
  // Today every caller gets (b)'s abort-and-restart behavior unconditionally,
  // which is what lets a reconnect() arriving while a mint is already in
  // flight (issue #162 advisory 1) throw that mint away and start another —
  // wasting an RTT even though nothing about the mint itself was ever in
  // doubt.
  //
  // Measured after the advisory-2 dispatch split (dispatchOnlineWake) shipped:
  //   - Two reconnect-triggering calls in the SAME synchronous tick (no
  //     await between them) were already harmless BEFORE this note — the
  //     pre-existing `cycleInFlight` guard (reset only via queueMicrotask)
  //     coalesces them into one cycle, so no extra mint occurs.
  //   - The only surviving trigger is two genuinely SEPARATE events (e.g.
  //     visibilitychange and online) landing close enough to straddle a
  //     microtask boundary — rare, and costs exactly one wasted RTT, not a
  //     correctness failure.
  // Given how narrow the residual is, and that the (a)/(b) split touches the
  // core of a reconnect state machine that took #123's 7 review rounds to
  // harden — including the ONE caller ((b)) that has a real, stated need for
  // abort-and-restart (captive-portal/proxy recovery in notifyOnline()) — the
  // 1-RTT saving does not justify the risk of that path. Shelved, not fixed.
  // If revisited: any (a)/(b) split MUST preserve notifyOnline()'s
  // abort-and-restart behavior for its in-flight branch untouched; that is
  // the one case where discarding an in-flight mint is intentional, not
  // wasteful.
  function requireFreshTicket(): void {
    if (options.refreshTicket === undefined) return;
    const refreshWasInFlight = ticketRefreshInFlight;
    ticketRefreshRequired = true;
    ticketRefreshGeneration += 1;
    // A close/error can race a prior renewal. Preserve one follow-up connect
    // request so that prior result is discarded and the newest generation
    // still gets a chance to mint its own ticket.
    ticketRefreshPendingConnect ||= refreshWasInFlight;
    if (refreshWasInFlight) abortTicketRefresh();
    cancelTicketRefreshRetry();
  }

  function setupSocketHandlers(s: Socket): void {
    s.onOpen(() => {
      // A successful transport means the endpoint is reachable again; the
      // next outage starts at the gentle first backoff step.
      resetTicketRefreshBackoff();
      handlers.onStatus("connected");
    });
    s.onClose(() => {
      // Phoenix's native reconnectTimer calls socket.connect() itself. Mark
      // the ticket stale here so that path cannot accidentally reuse the
      // ticket which authenticated the now-closed transport.
      if (!disposed) requireFreshTicket();
      handlers.onStatus("disconnected");
    });
    s.onError(() => {
      if (!disposed) requireFreshTicket();
      handlers.onStatus("disconnected");
    });
    // Reject every outstanding wait on disconnect so callers do not hang
    // forever behind a dropped socket. `onClose` fires on both operator
    // disconnect and server shutdown; `onError` catches transport failures.
    // Both flow into the same drain path (藤 review A).
    s.onClose(() => {
      catalogPending.drain("socket closed");
      refreshPending.drain("socket closed");
    });
    s.onError(() => {
      catalogPending.drain("socket error");
      refreshPending.drain("socket error");
    });
  }

  function setupChannelHandlers(c: Channel): void {
    bindServerEvent(c, "snapshot", (payload: { agents?: unknown; snapshot_incomplete?: unknown }) => {
      const agents: Record<string, Envelope> = {};
      for (const value of Object.values(payload.agents ?? {})) {
        if (isEnvelope(value)) agents[value.agent_id] = value;
      }
      handlers.onSnapshot(agents);
      handlers.onSnapshotIncomplete?.(payload.snapshot_incomplete === true);
    });
    bindServerEvent(c, "task_snapshot", (payload: { tasks?: unknown }) => {
      handlers.onTaskSnapshot?.(parseTasks(payload.tasks));
    });
    bindServerEvent(c, "delivery_snapshot", (payload: {
      deliveries?: unknown;
      snapshot_incomplete?: unknown;
    }) => {
      handlers.onDeliverySnapshot?.(parseDeliverySnapshot(payload.deliveries));
      handlers.onDeliverySnapshotIncomplete?.(payload.snapshot_incomplete === true);
    });
    bindServerEvent(c, "delivery_status", (payload: unknown) => {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
    const raw = payload as Record<string, unknown>;
    if (typeof raw.agent_id !== "string") return;
    handlers.onDeliveryStatus?.(raw.agent_id, parseDeliveryStatus(raw.delivery));
  });
  bindServerEvent(c, "envelope", (payload: unknown) => {
    if (!isEnvelope(payload)) return;
    // ADR-0039 F9 v2 = 藤 review turn-10 must-fix 1: refresh_models_result
    // is a transient completion envelope, NOT a state. Special-dispatch it
    // BEFORE `handlers.onEnvelope` and return, so the client's latest-state
    // tracker never sees this envelope and cannot overwrite the rich
    // ext.models the immediately-preceding state_change just delivered.
    if (payload.type === "refresh_models_result") {
      const p = payload.payload as Partial<RefreshModelsResult> | undefined;
      if (
        p !== undefined &&
        typeof p.request_id === "string" &&
        typeof p.ok === "boolean"
      ) {
        refreshPending.onResult({
          agent_id: payload.agent_id,
          request_id: p.request_id,
          ok: p.ok,
          ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
          ...(typeof p.models_count === "number"
            ? { models_count: p.models_count }
            : {}),
        });
      }
      return;
    }
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
  bindServerEvent(c, "history", (payload: unknown) => {
    const parsed = parseHistoryPayload(payload);
    handlers.onHistory?.(
      parsed.histories,
      parsed.clearWatermarks,
      parsed.projection,
      parsed.projectionEpoch,
    );
  });
  bindServerEvent(
    c,
    "history_cleared",
    (payload: {
      agent_id?: unknown;
      session_id?: unknown;
      clear_watermark?: unknown;
    }) => {
      if (
        typeof payload.agent_id === "string" &&
        typeof payload.session_id === "string"
      ) {
        // issue #109: clear_watermark is optional (legacy servers omit it);
        // when present it lets the live handler update the local watermark
        // map without waiting for a reload.
        const watermark =
          typeof payload.clear_watermark === "string" &&
          payload.clear_watermark !== ""
            ? payload.clear_watermark
            : undefined;
        handlers.onHistoryCleared?.(
          payload.agent_id,
          payload.session_id,
          watermark,
        );
      }
    },
  );
  bindServerEvent(c, "history_reset", (payload: unknown) => {
    const reset = parseHistoryReset(payload);
    if (reset !== null) {
      handlers.onHistoryReset?.(
        reset.agent_id,
        reset.preserve_inter_agent,
        reset.replay_id,
      );
    }
  });
  bindServerEvent(c, "history_replay_complete", (payload: unknown) => {
    const complete = parseHistoryReplayComplete(payload);
    if (complete !== null) {
      handlers.onHistoryReplayComplete?.(
        complete.agent_id,
        complete.replay_id,
      );
    }
  });
  bindServerEvent(c, "history_replay_envelope", (payload: unknown) => {
    const restored = parseHistoryReplayEnvelope(payload);
    if (restored !== null) {
      handlers.onHistoryReplayEnvelope?.(restored.paneAgentId, restored.envelope);
    }
  });
  bindServerEvent(c, "agent_deleted", (payload: { agent_id?: unknown }) => {
    if (typeof payload.agent_id === "string") {
      handlers.onAgentDeleted?.(payload.agent_id);
    }
  });
  bindServerEvent(c, "hosts", (payload: { hosts?: unknown }) => {
    handlers.onHosts?.(parseHosts(payload.hosts));
  });
  bindServerEvent(c, "directory", (payload: { entries?: unknown }) => {
    handlers.onDirectory?.(parseDirectory(payload.entries));
  });
  bindServerEvent(c, "spawn_result", (payload: unknown) => {
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
  bindServerEvent(c, "runner_sessions", (payload: unknown) => {
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
  bindServerEvent(c, "session_reset_started", (payload: unknown) => {
    const parsed = parseSessionResetStarted(payload);
    if (parsed !== null) handlers.onSessionResetStarted?.(parsed);
  });
  bindServerEvent(c, "session_reset_completed", (payload: unknown) => {
    const parsed = parseSessionResetCompleted(payload);
    if (parsed !== null) handlers.onSessionResetCompleted?.(parsed);
  });
  bindServerEvent(c, "session_reset_failed", (payload: unknown) => {
    const parsed = parseSessionResetFailed(payload);
    if (parsed !== null) handlers.onSessionResetFailed?.(parsed);
  });
  bindServerEvent(c, "catalog_result", (payload: unknown) => {
    const parsed = parseCatalogResult(payload);
    if (parsed === null) return;
    // Route to any pending refreshEngineCatalog() caller first so its
    // promise settles deterministically, then fan out to the passive
    // handler (dashboard-wide toast subscribers).
    catalogPending.onResult(parsed);
    handlers.onCatalogResult?.(parsed);
  });
  }

  function subscribeChannel(s: Socket): Channel {
    const ch = s.channel("agents:lobby");
    setupChannelHandlers(ch);
    // The join reply opens the ADR-0051 D4 buffer window. Phoenix keeps a
    // join push's receive hooks across `rejoin()`'s `resend()`, so this
    // fires on every reconnect too — which is exactly when the client has
    // to forget what the previous connection buffered.
    ch.join().receive("ok", () => handlers.onJoined?.());
    return ch;
  }

  // ふじ再レビュー must-fix 1 (issue #123 round 3): Socket instance を
  // 使い回す。cycle するのは Channel と WebSocket transport のみ。
  //   - Phoenix Socket constructor は remove 不能な window listener を 3 本
  //     (pagehide / pageshow / visibilitychange) 登録するため、cycle ごとに
  //     new Socket を作ると旧 Socket 全体が leak する。
  //   - stuck transport の teardown は onConnClose を通らないケースがあり、
  //     旧 Socket 内部の heartbeatTimer が生き残って heartbeatTimeout →
  //     reconnectTimer.scheduleTimeout で旧 socket を自己復活させる
  //     (ふじ実測: reconnect() 2.2 秒後 transportsCreated:3)。
  // Socket 1 つを維持し、reconnect は Phoenix 内部 timer の明示停止 →
  // WS transport の張り直し → Channel の完全再作成の順で行う。
  const socketOpts: Record<string, unknown> = { params };
  if (options.transport !== undefined) socketOpts.transport = options.transport;
  if (options.heartbeatIntervalMs !== undefined) {
    socketOpts.heartbeatIntervalMs = options.heartbeatIntervalMs;
  }
  const socket = new Socket(url, socketOpts);

  // Keep Phoenix's single Socket instance, while interposing on its
  // connect() method. Its reconnectTimer eventually invokes this very method,
  // so the guard also protects native heartbeat/error recovery rather than
  // only the dashboard's explicit reconnect() call.
  const socketWithConnect = socket as unknown as {
    connect: () => void;
  };
  const originalSocketConnect = socketWithConnect.connect.bind(socket);

  function expireTicketSession(): void {
    // A 401 is not a transport hiccup: retrying can only repeat the same
    // failure. Become terminal before notifying the UI so a pending Phoenix
    // timer, delayed teardown callback, or duplicate wake event cannot start
    // another WS attempt while endSession() switches to the login form.
    if (disposed) return;
    disposed = true;
    cycleGeneration += 1;
    ticketRefreshGeneration += 1;
    ticketRefreshPendingConnect = false;
    abortTicketRefresh();
    cancelTicketRefreshRetry();
    drainPhoenixTimers();
    try {
      channel.leave();
    } catch {
      // A dead transport can throw synchronously from leave; session expiry
      // must still reach the login form.
    }
    socket.disconnect(() => {
      drainPhoenixTimers();
    });
    options.onTicketRefreshUnauthorized?.();
  }

  function retryTicketRefresh(generation: number): void {
    if (
      disposed ||
      generation !== ticketRefreshGeneration ||
      ticketRefreshRetryTimer !== undefined
    ) {
      return;
    }
    // Do not fall back to Phoenix's reconnect timer after an HTTP failure:
    // that would open a transport with the stale ticket. Retrying this gate
    // instead preserves offline recovery once the network returns, without
    // polling an offline endpoint at a fixed 60 requests/minute.
    const retryIndex = Math.min(
      ticketRefreshRetryAttempt,
      TICKET_REFRESH_RETRY_DELAYS_MS.length - 1,
    );
    const retryDelayMs = TICKET_REFRESH_RETRY_DELAYS_MS[retryIndex]!;
    ticketRefreshRetryAttempt += 1;
    ticketRefreshRetryTimer = setTimeout(() => {
      ticketRefreshRetryTimer = undefined;
      if (disposed || generation !== ticketRefreshGeneration) return;
      socketWithConnect.connect();
    }, retryDelayMs);
  }

  function refreshTicketWithTimeout(): Promise<TicketRefreshResult> {
    // This wrapper races the callback itself, not only fetch's AbortSignal.
    // A caller that accidentally ignores the signal must still release the
    // reconnect gate at the deadline.
    const refreshTicket = options.refreshTicket;
    if (refreshTicket === undefined) {
      return Promise.reject(new Error("ticket refresh is unavailable"));
    }
    const controller = new AbortController();
    ticketRefreshController = controller;
    const timeoutMs = options.ticketRefreshTimeoutMs ?? TICKET_REFRESH_TIMEOUT_MS;
    const timeout = new Promise<never>((_resolve, reject) => {
      rejectTicketRefresh = reject;
      ticketRefreshTimeoutTimer = setTimeout(() => {
        controller.abort();
        reject(new Error("ticket refresh timed out"));
      }, timeoutMs);
    });
    return Promise.race([
      // Normalise a synchronously-throwing adapter callback into the same
      // retry path as a rejected fetch.
      Promise.resolve().then(() => refreshTicket(controller.signal)),
      timeout,
    ]).finally(() => {
      if (ticketRefreshController === controller) {
        ticketRefreshController = undefined;
        rejectTicketRefresh = undefined;
        if (ticketRefreshTimeoutTimer !== undefined) {
          clearTimeout(ticketRefreshTimeoutTimer);
          ticketRefreshTimeoutTimer = undefined;
        }
      }
    });
  }

  function connectWithFreshTicket(): void {
    if (disposed) return;
    if (options.refreshTicket === undefined || !ticketRefreshRequired) {
      originalSocketConnect();
      return;
    }
    if (ticketRefreshInFlight) {
      // A later reconnect cycle superseded the ticket fetch in progress.
      // Let its finally block start one fresh fetch for the newest generation
      // instead of allowing that older result to open a transport.
      ticketRefreshPendingConnect = true;
      return;
    }

    const generation = ticketRefreshGeneration;
    ticketRefreshInFlight = true;
    void refreshTicketWithTimeout()
      .then((result) => {
        if (disposed || generation !== ticketRefreshGeneration) return;
        if (result.kind === "unauthorized") {
          expireTicketSession();
          return;
        }
        // Socket constructor params are wrapped in Phoenix's closure(), so
        // mutating this object is observed when transportConnect builds the
        // next WebSocket URL. No second Socket instance is needed.
        params.ticket = result.ticket;
        ticketRefreshRequired = false;
        originalSocketConnect();
      })
      .catch(() => {
        if (disposed || generation !== ticketRefreshGeneration) return;
        retryTicketRefresh(generation);
      })
      .finally(() => {
        ticketRefreshInFlight = false;
        if (ticketRefreshPendingConnect && !disposed) {
          ticketRefreshPendingConnect = false;
          connectWithFreshTicket();
        }
      });
  }

  socketWithConnect.connect = connectWithFreshTicket;

  // Round 7 must-fix (issue #123): arm-time chain-provenance guard on
  // Phoenix's teardown. Phoenix's chain heartbeatTimeout → abnormalClose
  // → teardown(cb=scheduleTimeout) starts at teardown time; the eventual
  // cb (and its follow-on scheduleTimeout) must NOT execute if a rebuild
  // has re-baselined the socket in between. A fire-time compare against
  // a live global (round 6's allowedScheduleGen) is insufficient because
  // a completed reconnect brings the live generation back in line with
  // the stale chain's world view, letting it slip through (round 7
  // レビュー実測: 6000ms 遅延 + 途中 reconnect() で transportsCreated:3)。
  //
  // Capture cycleGeneration at teardown call time (arm time) in the
  // callback's closure. On cb fire, skip if the generation moved. This
  // closes the stuck-transport heartbeat chain regardless of the wall
  // clock — the same wrap covers our own reconnect() / disconnect()
  // teardown callbacks (they capture the current generation and match on
  // fire, so they proceed normally).
  //
  // Phoenix 1.8.x internal API — typeof guard makes a future upgrade
  // that renames/removes teardown fail loudly at test time (regression
  // test pins its existence).
  const socketWithTeardown = socket as unknown as {
    teardown?: (cb?: () => void, code?: number, reason?: string) => void;
  };
  if (typeof socketWithTeardown.teardown === "function") {
    const originalTeardown = socketWithTeardown.teardown.bind(socket);
    socketWithTeardown.teardown = (
      cb?: () => void,
      code?: number,
      reason?: string,
    ) => {
      // heartbeatTimeout reaches reconnectTimer through teardown() without
      // firing Socket.onClose/onError (Phoenix intentionally replaces the
      // transport callbacks while it closes it). Mark the ticket stale at
      // this lower-level common point so that native recovery is protected
      // too; explicit reconnect() takes this same path and remains coalesced.
      if (!disposed) requireFreshTicket();
      const teardownGen = cycleGeneration;
      originalTeardown(
        cb === undefined
          ? undefined
          : () => {
              if (cycleGeneration !== teardownGen) return;
              cb();
            },
        code,
        reason,
      );
    };
  }
  // Belt-and-suspenders: permanent kill switch on Phoenix's own
  // reconnectTimer for the terminal disconnect() case. The teardown
  // arm-time guard already blocks stale teardown-cb → scheduleTimeout
  // chains; this covers a non-teardown-originated scheduleTimeout
  // (Phoenix's onConnClose when an unclean close beats our
  // onclose=noop) after disposed=true.
  // Phoenix 1.8.x internal API — typeof guard.
  const timerInternals = socket as unknown as {
    reconnectTimer?: { scheduleTimeout?: () => void };
  };
  if (
    timerInternals.reconnectTimer &&
    typeof timerInternals.reconnectTimer.scheduleTimeout === "function"
  ) {
    const originalScheduleTimeout =
      timerInternals.reconnectTimer.scheduleTimeout.bind(
        timerInternals.reconnectTimer,
      );
    timerInternals.reconnectTimer.scheduleTimeout = () => {
      if (disposed) return;
      originalScheduleTimeout();
    };
  }
  handlers.onStatus("connecting");
  setupSocketHandlers(socket);
  socket.connect();
  let channel = subscribeChannel(socket);

  // Phoenix 1.8.7 internal-API accessor for cycle bookkeeping. clearHeartbeats()
  // is on the Socket prototype (phoenix.js:1424); reconnectTimer is a Timer
  // instance with reset() (phoenix.js:1163). Both are private fields but we
  // need them to defuse the self-resurrection path documented above — Phoenix
  // itself only clears them via onConnClose(), which stuck transports skip.
  // typeof guard makes a future Phoenix upgrade that removes/renames them
  // fail loudly at test time (regression test pins these existences).
  function drainPhoenixTimers(): void {
    const s = socket as unknown as {
      clearHeartbeats?: () => void;
      reconnectTimer?: { reset?: () => void };
    };
    if (typeof s.clearHeartbeats === "function") s.clearHeartbeats();
    if (typeof s.reconnectTimer?.reset === "function") s.reconnectTimer.reset();
  }

  return {
    disconnect: () => {
      // Terminal: block any in-flight reconnect's teardown callback from
      // rebuilding after we tear down (must-fix 2). Bumping the generation
      // is defence in depth — the disposed check alone is enough.
      disposed = true;
      cycleGeneration += 1;
      ticketRefreshGeneration += 1;
      ticketRefreshPendingConnect = false;
      abortTicketRefresh();
      cancelTicketRefreshRetry();
      // Drain Phoenix internal timers first. Without this the heartbeatTimer
      // can outlive teardown on a stuck transport and self-resurrect via
      // heartbeatTimeout → reconnectTimer.scheduleTimeout (ふじ再レビュー).
      drainPhoenixTimers();
      // Fire-and-forget leave (対称化: reconnect() 側と同じ try/catch)。
      try {
        channel.leave();
      } catch {
        // leave push の同期例外は握り潰す — teardown を止めない。
      }
      // ふじ round 4 レビュー must-fix 1 hardening: reconnect() と同じく
      // teardown cb 内でも drain を再実行する。disconnect() を呼ぶ時点で
      // 既に arm 済みの heartbeatTimeout → teardown → scheduleTimeout の
      // 非同期 chain は事前 drain の reset 時点では未 arm。cb 実行時に
      // 再 drain して in-flight schedule も潰す (drainPhoenixTimers は
      // idempotent)。disposed は上で true にしているので guard を通した
      // 再 arm は起きない。
      socket.disconnect(() => {
        drainPhoenixTimers();
      });
    },
    reconnect: () => {
      // ふじ再レビュー must-fix 1 (round 3): Socket は使い回し、Channel と
      // WebSocket transport を張り直す。
      // (a) disposed / cycleInFlight で terminal / 直列化 guard、
      // (b) generation snapshot で cb 実行時に「まだこの世代か」を再確認、
      // (c) Phoenix 内部 timer を明示停止して stuck transport 経由の
      //     自己復活を防ぐ、
      // (d) leave は fire-and-forget (dead transport 対策)、
      // (e) socket.disconnect の cb で new Channel を subscribe → socket.connect。
      if (disposed || cycleInFlight) return;
      cycleInFlight = true;
      const gen = ++cycleGeneration;

      // App.svelte invokes reconnect() for the browser's `online` event and
      // wake recovery. Treat that new external signal as a fresh outage, so
      // the next transient ticket failure starts from the first backoff step.
      resetTicketRefreshBackoff();

      // A wake rebuild must never put the ticket from the old transport on
      // the new URL. connectWithFreshTicket() also guards Phoenix's native
      // retry path, so this is safe even when close/error and wake signals
      // race each other.
      requireFreshTicket();

      drainPhoenixTimers();

      try {
        channel.leave();
      } catch {
        // leave push の同期例外は握り潰す — rebuild を止めない。
      }

      socket.disconnect(() => {
        if (disposed || gen !== cycleGeneration) return;
        // ふじ round 3 must-fix 2 hardening: teardown 中に発火した
        // heartbeatTimeout → teardown → reconnectTimer.scheduleTimeout の
        // chain は pre-drain の reset 時点では未 arm。cb 実行時に再度 drain
        // して in-flight schedule も潰す (drainPhoenixTimers は idempotent)。
        drainPhoenixTimers();
        // Socket instance は使い回し (window listener leak と自己復活防止)。
        // WS transport は socket.connect() が張り直す。Channel は Phoenix の
        // 自動 rejoin に頼らず明示的に new して join する (implicit rejoin は
        // stuck transport 由来の handler 無効化タイミングで join が飛ばない
        // 事例あり — ふじ round 2 実測)。
        channel = subscribeChannel(socket);
        socket.connect();
      });

      // cycleInFlight は microtask boundary で解除する。Phoenix teardown() の
      // waitForSocketClosed は readyState=CLOSED なら synchronous に callback
      // を呼ぶため、cb 内で cycleInFlight=false にすると同一 tick 内の連続
      // reconnect が全て新 cycle を起こしてしまう (visibilitychange と
      // online の near-simultaneous fire で socket が multiply する)。
      // microtask で解除すれば同一 tick は 1 cycle に coalesce、次 tick 以降は
      // 再走可能。
      queueMicrotask(() => {
        cycleInFlight = false;
      });
    },
    notifyOnline: () => {
      resetTicketRefreshBackoff();
      if (disposed || !ticketRefreshRequired) return;
      if (ticketRefreshInFlight) {
        // The old request may be stuck behind a captive portal/proxy. A new
        // online signal is useful evidence to abandon it and mint again.
        requireFreshTicket();
        return;
      }
      if (ticketRefreshRetryTimer !== undefined) {
        cancelTicketRefreshRetry();
        socketWithConnect.connect();
      }
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
    refreshModels: async (agentId) => {
      // ADR-0039 F9 v2 = 藤 review D2a: request_id + pending map so the
      // returned promise settles on the wrapper's refresh_models_result
      // envelope, not just the server ack. Register BEFORE the push so a
      // fast wrapper reply cannot arrive before we can correlate.
      const request_id = randomUUID();
      const promise = refreshPending.register(request_id);
      try {
        await pushAsync(channel, "refresh_models", {
          agent_id: agentId,
          request_id,
        });
      } catch (err) {
        refreshPending.cancel(
          request_id,
          `server ack failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return promise;
    },
    refreshEngineCatalog: async (hostId, engine, force) => {
      const request_id = randomUUID();
      // Register BEFORE sending so a fast catalog_result cannot arrive
      // before we can correlate it. The returned promise resolves on
      // catalog_result / rejects on disconnect / timeout / ack failure.
      const promise = catalogPending.register(request_id);
      try {
        await pushAsync(channel, "refresh_engine_catalog", {
          host_id: hostId,
          engine,
          request_id,
          ...(force === true ? { force: true } : {}),
        });
      } catch (err) {
        // 藤 review B: fold ack-failure into the SAME rejection path as
        // catalog_result / disconnect / timeout so `promise` is the single
        // observable rejection source (previously we `throw err` here AND
        // rejected `promise`, producing an unhandled rejection on any
        // caller that read only `promise`).
        catalogPending.cancel(
          request_id,
          `server ack failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return promise;
    },
    setPermissionMode: (agentId, mode) =>
      pushAsync(channel, "set_permission_mode", { agent_id: agentId, mode }),
    // `display_name` (issue #219 D23): the server's field-extraction
    // helper (`extract_name_field/1`) still accepts the legacy `name` key
    // during the compatibility window, but this client — built alongside
    // the server that introduces the new key — sends the new one.
    renameAgent: (agentId, name) =>
      pushAsync(channel, "rename_agent", {
        agent_id: agentId,
        display_name: name,
      }),
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
        pushVersioned(channel, "spawn", { ...request })
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
    getLaunchDefaults: () =>
      new Promise((resolve, reject) => {
        pushVersioned(channel, "launch_defaults", {})
          .receive("ok", (resp: { defaults?: unknown }) =>
            resolve(parseLaunchDefaults(resp?.defaults)),
          )
          .receive("error", (reason: { reason?: string } | undefined) =>
            reject(new Error(reason?.reason ?? "error")),
          )
          .receive("timeout", () => reject(new Error("timeout")));
      }),
    listConversations: () =>
      new Promise((resolve, reject) => {
        pushVersioned(channel, "list_conversations", {})
          .receive("ok", (resp: { conversations?: unknown }) =>
            resolve(parseConversationList(resp?.conversations)),
          )
          .receive("error", (reason: { reason?: string } | undefined) =>
            reject(new Error(reason?.reason ?? "error")),
          )
          .receive("timeout", () => reject(new Error("timeout")));
      }),
    closeConversation: (conversationId) =>
      pushAsync(channel, "close_conversation", {
        conversation_id: conversationId,
      }),
    listUsers: () =>
      new Promise((resolve, reject) => {
        pushVersioned(channel, "list_users", {})
          .receive("ok", (resp: { users?: unknown }) =>
            resolve(parseUserList(resp?.users)),
          )
          .receive("error", (reason: { reason?: string } | undefined) =>
            reject(new Error(reason?.reason ?? "error")),
          )
          .receive("timeout", () => reject(new Error("timeout")));
      }),
    // `display_name` (issue #219 D23 vocabulary, reused here per
    // renameAgent's own doc: this client sends the canonical key, the
    // server's extract_name_field/1 still accepts legacy `name` too).
    renameUser: (userId, name) =>
      pushAsync(channel, "rename_user", {
        user_id: userId,
        display_name: name,
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
      //
      // ADR-0015 carve-out (issue #218): the only client -> server message
      // that bypasses `pushVersioned`. A binary frame carries a fixed
      // length-prefixed header plus raw bytes — there is no JSON object to
      // put a `version` key in, so stamping one would need a wire change
      // (i.e. a protocol version bump), which #218 rules out of scope.
      // Recorded as a permanent exception in `docs/specs/protocol.md`.
      channel.push("attach_chunk", data);
    },
    attachClose: (agentId, uploadId) =>
      pushAsync(channel, "attach_close", {
        agent_id: agentId,
        upload_id: uploadId,
      }),
    uploadFile: async (agentId, file, onProgress) => {
      const upload_id = randomUUID();
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
        // Same ADR-0015 binary-frame carve-out as `attachChunk` above.
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
