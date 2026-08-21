// Server link — pushes envelopes to the kaoiro server over Phoenix Channels
// (ADR-0009: Channels only, wire vsn=2.0.0, which the official client speaks).
// The phoenix client owns reconnect/heartbeat; pushes made while disconnected
// are buffered and flushed on rejoin. The link also re-announces its latest
// state and active task entities after a reconnect, because WrapperChannel
// purges the server-side task table when the old channel terminates. Outbound
// envelopes get the wrapper's monotonic seq (ADR-0011: one assignment point
// for the whole series) and the current SDK session_id (protocol.md /
// ADR-0014 phase-0) stamped here;
// inbound pushes (instruction / permission_decision, protocol.md) are
// validated structurally and forwarded to the handlers.

import { Channel, Socket, type Push } from "phoenix";
import { randomUUID } from "node:crypto";
import type { Envelope } from "@kaoiro/protocol";

/** A client's permission decision relayed by the server (protocol.md).
 *  Defined here (the wire layer that parses it); the PermissionBroker in
 *  @kaoiro/agent-common consumes it. */
export interface PermissionDecisionMessage {
  request_id: string;
  allow: boolean;
  message?: string;
}

/** A client's answer relayed by the server (protocol.md question_response).
 *  Wire twin of {@link PermissionDecisionMessage} for the AskUserQuestion
 *  path (ADR-0027); consumed by the QuestionBroker in @kaoiro/agent-common. */
export interface QuestionResponseMessage {
  request_id: string;
  /** Selected answers keyed by question text; ignored when cancelled. */
  answers: Record<string, string>;
  /** true = the operator dismissed the dialog (deny). */
  cancelled?: boolean;
}

/** context usage as it reaches a peer (phase-27, #160). Same three numbers
 *  the dashboard's ctx meter reads, so the two never disagree. The server
 *  only projects this when the reporting wrapper advertised
 *  `supports_context_usage: true`; an engine without the capability omits the
 *  field entirely rather than sending a null or an estimate (ADR-0040). */
export interface DirectoryContext {
  used_tokens: number;
  max_tokens: number;
  used_percentage: number;
}

/** One rate-limit window as it reaches a peer (phase-27, #160). Every field
 *  is optional because the engine reports what it knows; a window with none
 *  of them is dropped rather than sent empty. The snapshot is from the peer's
 *  LAST turn and is not refreshed while it idles — read `resets_at` against
 *  the current time and stop trusting `utilization` / `status` once it has
 *  passed. */
export interface DirectoryRateLimitWindow {
  status?: string;
  utilization?: number;
  resets_at?: number;
}

/** Active inter-agent conversation state of a peer (phase-27, #160). Always
 *  present on a current server (`{active: false, peers: []}` when idle), so
 *  an absent field means the server predates the feature — not "no
 *  conversation". `conversation_id` is deliberately not disclosed: the agreed
 *  disclosure scope is presence plus counterpart ids. */
export interface DirectoryConversation {
  active: boolean;
  peers: string[];
}

/** Recipient-local dispatch confirmation watermark (issue #247).  It is an
 * observation ledger, not a retransmission guarantee.  An absent field is
 * deliberately `unknown` (legacy/disarmed capability), never zero. */
export interface InterAgentDeliveryStatus {
  issued_seq: number;
  acked_seq: number;
  pending_since?: string;
}

/** Single entry returned from `directory_request` (protocol-inter-agent
 * companion tool). Runtime traits are optional because an old/not-yet-init
 * wrapper may not have stamped them. Operator-grade cwd / permission /
 * session / capabilities / source fields remain excluded.
 *
 * phase-27 (#160) adds the situational fields below so an agent can pick a
 * delegate on its own. Every one of them is omitted rather than defaulted
 * when the server cannot vouch for it — **read an absent field as "unknown",
 * never as zero or "fine"**. `turns` in particular is omitted (not `0`) when
 * the server never observed this session's start. */
export interface DirectoryEntry {
  agent_id: string;
  persona: { id?: string; name?: string; sprite_set?: string };
  /** Mutable instance-scoped display name (issue #219 D19/D26, ADR-0021
   *  F6-3) — `persona.name` above stays the pack's canonical name,
   *  unaffected by rename; this is the current, possibly-renamed label.
   *  Optional: an old server / not-yet-updated peer wrapper build omits
   *  it, same discipline as every other situational field here. */
  display_name?: string;
  state: string;
  engine?: string;
  model?: string;
  effort?: string;
  context?: DirectoryContext;
  /** ISO8601 UTC. The time the SERVER observed the session start, not a
   *  wrapper-measured value. */
  session_started_at?: string;
  /** Reply round-trips counted in the current session. */
  turns?: number;
  /** ISO8601 UTC of the last envelope the server accepted from this peer.
   *  Grades how stale `context` / `rate_limits` are. */
  last_activity_at?: string;
  conversation?: DirectoryConversation;
  /** Keyed by window: `five_hour` / `seven_day` plus any engine-specific
   *  ones. */
  rate_limits?: Record<string, DirectoryRateLimitWindow>;
  inter_agent_delivery?: InterAgentDeliveryStatus;
  /** issue #269: この entry は AgentDirectory (永続 ledger) にしか存在せず、
   *  AgentStates に live envelope が無いことを示す。**この field は他の
   *  optional field と absent の意味が違う** — absent は unknown ではなく
   *  「live directory 由来」。server は true のときだけ載せる (F6-2
   *  fail-closed)。send_to_agent の宛先にはできない。 */
  directory_only?: true;
  /** issue #269: server が最後に envelope を受理した時刻。directory-only
   *  entry でのみ載る (live entry は last_activity_at を持つ)。
   *  AgentDirectory の memory-only hint 由来なので、server 再起動後は
   *  絶対に取れない — absent は「unknown」であって「一度も動いていない」
   *  ではない。 */
  last_seen?: string;
}

/** Single entry in the peer directory's "users" projection (issue #197
 *  段階2, ADR-0021 F6-8). Server-side config default is OPEN
 *  (`KAOIRO_EXPOSE_USERS_TO_AGENTS` unset = disclosed, explicit
 *  `"false"` opts out — ふじ M1 レビュー指摘, protocol-inter-agent.md is
 *  the source of truth for the full default/opt-out contract). An old
 *  (pre-段階2) server omits the `users` key entirely; a 段階2+ server
 *  that opted OUT still returns the key with an empty array — the two
 *  are NOT the same wire shape, though both narrow to `[]` here (see
 *  `userDirectoryEntryFrom`'s own doc; the distinction does not matter
 *  to this narrow's caller either way, ふじ M4 レビュー指摘).
 *
 *  `kind`/`role` are the exact literal/enum values F6-8 allow-lists.
 *  An unrecognised value on either field drops the WHOLE entry rather
 *  than degrading to a passthrough string — forward-compat passthrough
 *  for these two fields was proposed and explicitly rejected (director
 *  review, issue #197 段階2 M2); issue #198 (admin role) extends both
 *  server (`role_string/1`) and this union/narrow together. */
/** Single source for the role allow-list: the TYPE below and the runtime
 *  narrow in `userDirectoryEntryFrom` are both derived from this array,
 *  so they cannot drift apart. They previously could — the comment above
 *  had to instruct a future reader to extend "both together", and that is
 *  exactly the kind of paired edit issue #198 found half-done elsewhere.
 *  Adding a role is a one-line change here and nowhere else. */
const USER_ROLES = ["operator", "viewer", "admin"] as const;

export type UserRole = (typeof USER_ROLES)[number];

export interface UserDirectoryEntry {
  id: string;
  kind: "user";
  display_name: string;
  role: UserRole;
}

/** `requestDirectory()`'s reply shape (issue #197 段階2). `agents` and
 *  `users` are deliberately two separate arrays, not one merged list —
 *  `users` are NOT valid `send_to_agent` destinations, and a caller that
 *  merged them for convenience would have to re-derive which entries are
 *  agents at every use site instead of it being structurally impossible
 *  to get wrong. */
export interface DirectoryResult {
  agents: DirectoryEntry[];
  users: UserDirectoryEntry[];
}

/** attach_open payload (protocol.md / file-upload spec, server -> wrapper
 *  relay). chunks is the advertised total chunk count for the upload. */
export interface AttachOpenMessage {
  upload_id: string;
  filename: string;
  mime: string;
  size: number;
  chunks: number;
}

/** Hydration verdict from the wrapper channel's JOIN REPLY (ADR-0051 D2).
 *  Structurally identical to `@kaoiro/agent-common`'s `HydrationVerdict`;
 *  redeclared here because agent-common already depends on this package and
 *  a back-import would close the cycle. */
export interface HydrationVerdictMessage {
  replay_required: boolean;
  replay_id?: string;
}

/** One restored inter-agent row on the `replay_ia` wire (ADR-0051 D3-3).
 *  Structural twin of agent-common's `SidecarRecord`, same reason. */
export interface ReplayIaItem {
  ingress_stamp: [number, number];
  envelope: Envelope;
}

/** What the server did with an outbound `inter_agent_message` push
 *  (ADR-0051 D3-2). `unknown` is the honest answer for a timeout or a lost
 *  ack: the message may well have been delivered, so the caller must not
 *  present it as a failure the model can safely retry. */
export type InterAgentAcceptance =
  | { kind: "accepted"; stamp: [number, number] | null }
  | { kind: "rejected"; reason: string }
  | { kind: "unknown"; reason: string };

/** Byte budget for ONE `replay_ia` push.
 *
 * ふじ 30-10 must-fix M4: the wrapper socket caps a frame at 8 MB
 * (endpoint.ex) while a single envelope may be 64 KiB (wrapper_channel
 * `@max_envelope_bytes`), so a full 200-row replay is ~12 MB of entirely
 * VALID data. The frame is rejected before it is decoded — the server's
 * own `Enum.take(200)` never runs — so `history_replay_complete` never
 * lands, the agent stays unhydrated, and the next join replays the same
 * oversized batch forever. Splitting on real JSON byte length is the only
 * thing that breaks that loop. 1 MB leaves the Phoenix frame wrapper an
 * order of magnitude of headroom. */
export const MAX_REPLAY_IA_PUSH_BYTES = 1_000_000;

/**
 * Bounds the reconnect-only cache of active task entities. The server's
 * TaskStates table applies the same two ceilings globally; this local cache
 * needs its own limits because a missing `completed` event (crash/kill) would
 * otherwise retain an entity for the entire wrapper process lifetime.
 *
 * The byte limit measures the cached envelope's actual JSON representation,
 * rather than estimating from a field such as `summary`. It therefore also
 * bounds future task payload extensions. These are cache limits, not a
 * promise that a concurrently busy multi-wrapper server will accept every
 * re-announcement — server ingress remains authoritative for that.
 */
export const MAX_ACTIVE_TASK_CACHE_ENTRIES = 5_000;
export const MAX_ACTIVE_TASK_CACHE_BYTES = 6_000_000;

/** The protocol version this wrapper speaks (ADR-0015). Mirrors
 *  `RUNNER_PROTOCOL_VERSION` in `runner/src/transport.ts` — same rule,
 *  separate constant per party since each stamps its own outbound
 *  messages independently. */
const WRAPPER_PROTOCOL_VERSION = "0";

/** `version` is unvalidated wire input, so it is rendered bounded — same
 *  reason the server bounds its own inspect of the field. */
const MAX_LOGGED_VERSION_CHARS = 64;

function describeVersion(value: unknown): string {
  if (value === undefined) return "(absent)";
  const text = typeof value === "string" ? JSON.stringify(value) : String(value);
  return text.length > MAX_LOGGED_VERSION_CHARS
    ? text.slice(0, MAX_LOGGED_VERSION_CHARS) + "…"
    : text;
}

/** ADR-0015's receiver rule: only an exact match is normal, a mismatch is
 *  warned about, and the message is processed EITHER WAY (best-effort
 *  accept). Mirrors `warnOnVersionMismatch` in `runner/src/transport.ts`
 *  (issue #197 段階3, ふじ MF-1 レビュー指摘: `persona_sync` predates
 *  this wrapper-side check entirely — the first server -> wrapper
 *  message on this topic to carry a `version` key at all). */
function warnOnVersionMismatch(event: string, version: unknown): void {
  if (version === WRAPPER_PROTOCOL_VERSION) return;
  process.stderr.write(
    `${event}: server declared protocol version ${describeVersion(version)}; ` +
      `accepting as ${JSON.stringify(WRAPPER_PROTOCOL_VERSION)} (ADR-0015 best-effort accept)\n`,
  );
}

/** Every server -> wrapper event `ServerLink` binds, mapped to how
 *  ADR-0015's receiver check applies to it (issue #218).
 *
 *  - `"checked"` — a JSON payload with a flat `version` frame key.
 *    `warnOnVersionMismatch` runs in front of the handler: exact match is
 *    silent, absent or differing warns and the message is processed either
 *    way (best-effort accept).
 *  - `"binaryFrame"` — a V2 binary frame: a fixed length-prefixed header
 *    plus raw bytes, with no JSON object to hold a `version` key. Stamping
 *    one would need a wire change (a protocol version bump), which #218
 *    rules out of scope, and running the check anyway would warn
 *    "(absent)" on every chunk of every upload. Recorded as a permanent
 *    exception in `docs/specs/protocol.md`.
 *
 *  Bindings go through `#bindServerEvent`, whose `event` parameter is typed
 *  as a key of this table — a new event cannot be bound without first
 *  declaring which side of the line it falls on. That is the whole point:
 *  before #218 the check was an independent line each handler had to
 *  remember, and the same omission became a must-fix twice (#88, #197
 *  段階3). `bindControlEvents` gives the runner the same guarantee with a
 *  loop; the wrapper needs a table because these handlers' payload shapes
 *  differ too much to share one callback signature. */
export const SERVER_EVENT_VERSION_POLICY = {
  persona_prompt: "checked",
  instruction: "checked",
  permission_decision: "checked",
  question_response: "checked",
  interrupt: "checked",
  set_model: "checked",
  set_effort: "checked",
  refresh_models: "checked",
  set_permission_mode: "checked",
  persona_sync: "checked",
  display_name_sync: "checked",
  attach_open: "checked",
  attach_chunk: "binaryFrame",
  attach_close: "checked",
  envelope: "checked",
  delivery_status: "checked",
  session_reset_failed: "checked",
} as const satisfies Record<string, "checked" | "binaryFrame">;

export type ServerEventName = keyof typeof SERVER_EVENT_VERSION_POLICY;

export const WRAPPER_CONTROL_EVENT_POLICY = {
  delivery_ack: "versioned",
  delivery_status_request: "versioned",
  history_reset: "versioned",
  replay_ia: "versioned",
  history_replay_complete: "versioned",
  directory_request: "versioned",
  session_reset_request: "versioned",
  envelope: "envelopeFrame",
} as const satisfies Record<string, "versioned" | "envelopeFrame">;

export type WrapperControlEvent = keyof typeof WRAPPER_CONTROL_EVENT_POLICY;
export type VersionedWrapperEvent = {
  [K in WrapperControlEvent]: typeof WRAPPER_CONTROL_EVENT_POLICY[K] extends "versioned"
    ? K
    : never;
}[WrapperControlEvent];

interface ActiveTaskCacheEntry {
  envelope: Envelope;
  jsonBytes: number;
}

/** Splits replay rows into pushes that stay under `maxBytes` of JSON.
 *
 *  A single row that cannot fit the budget at all is DROPPED, not sent
 *  alone (ふじ 30-10 2 巡目 should). Sending it re-creates the very loop
 *  this function exists to break: the frame is rejected before decoding,
 *  `history_replay_complete` never lands, and the next join replays the
 *  same unsendable row forever. A host-local sidecar is the only thing
 *  that can produce such a row, and D3-2 already drops corrupt sidecar
 *  lines on the same fail-closed reasoning — one lost bubble against a
 *  permanently unhydrated pane. `sendReplayIa` warns about the loss. */
export function chunkReplayIaItems(
  items: readonly ReplayIaItem[],
  maxBytes: number = MAX_REPLAY_IA_PUSH_BYTES,
): ReplayIaItem[][] {
  const chunks: ReplayIaItem[][] = [];
  let current: ReplayIaItem[] = [];
  let size = 0;
  for (const item of items) {
    // +1 for the `,` this row adds to the JSON array.
    const bytes = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
    if (bytes > maxBytes) continue;
    if (current.length > 0 && size + bytes > maxBytes) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export interface ServerLinkOptions {
  /** persona.id declared to the server at join time (ADR-0029 F3).
   *  The server rejects the join when this id is not in its pack manifest
   *  (or the reserved `default`); the wrapper then never opens its SDK
   *  session. Required — there is no fallback under fail-closed. */
  personaId: string;
  /** Session-transition correlation id relayed from the command that
   *  launched this wrapper (`config.transition_id`, phase-27 / #160). Sent
   *  verbatim as a join param so the server can recognise the connection a
   *  spawn / restore / reset produced — a session_id cannot identify it,
   *  because a same-session resume reuses the old one. Absent on a legacy
   *  runner; the server then declines to activate the pending transition
   *  and omits the affected activity metadata. */
  transitionId?: string;
  /** Wrapper auth token (ADR-0011), sent as a connect param. */
  token?: string;
  /** The server-composed personality + common footer (ADR-0029 F5)
   *  pushed once after join over the WS handshake. cli.ts awaits this
   *  before opening the SDK session — the SDK's systemPrompt.append is
   *  set once and never rewritten (F9 no hot-swap). */
  onPersonaPrompt?: (prompt: string) => void;
  /** An operator's instruction relayed by the server. `attachmentIds`, when
   *  present, lists prior uploads the wrapper should attach to this turn
   *  (file-upload spec). */
  onInstruction?: (text: string, attachmentIds?: string[]) => void;
  /** An operator's permission decision relayed by the server. */
  onPermissionDecision?: (decision: PermissionDecisionMessage) => void;
  /** An operator's AskUserQuestion answer relayed by the server (ADR-0027). */
  onQuestionResponse?: (response: QuestionResponseMessage) => void;
  /** An operator's interrupt request relayed by the server (protocol.md, #51).
   *  Payload is `{}` — the topic carries the agent_id. */
  onInterrupt?: () => void;
  /** An operator's model switch relayed by the server (protocol.md, #54).
   *  Payload is `{ model: string }` — an alias from ext.models. */
  onSetModel?: (value: string) => void;
  /** An operator's effort switch relayed by the server (protocol.md, #54).
   *  Payload is `{ effort: string }` — a level from a model's effort_levels. */
  onSetEffort?: (level: string) => void;
  /** An operator's manual retry of supportedModels() relayed by the server
   *  (protocol.md, ADR-0037 F6, phase-18-5). Payload is `{}` — the topic
   *  addresses the agent. The wrapper resets its retry counter + succeeded
   *  flag and kicks a fresh #refreshSupportedModels() attempt. */
  onRefreshModels?: (payload: { request_id?: string }) => void;
  /** An operator's permission-mode switch relayed by the server (#58). Also
   *  the carrier of the server's after-join push of the persisted last
   *  choice. Payload is `{ mode: string }` — one of the SDK PermissionMode
   *  values; validation lives in the wrapper. */
  onSetPermissionMode?: (mode: string) => void;
  /** The AUTHORITATIVE `display_name` state (issue #219 D19/D23 — renamed
   *  from `onRenamePersona`; `persona` canonical data is never mutated by
   *  either event this rides on), pushed by the server on every join (fresh
   *  AND reconnect, issue #197 段階3 D14 acceptance 1) and on a live
   *  `rename_agent` relay. `revision` is a monotonic per-agent_id counter
   *  (`AgentDirectory.rename/2`) — the handler MUST drop a push whose
   *  revision is <= the last one it applied (D15: two `rename_agent` calls
   *  racing on the server can broadcast in either order, and this is what
   *  lets the wrapper converge on the newer one regardless of arrival
   *  order). Fed by BOTH `persona_sync` (legacy `name` key) and
   *  `display_name_sync` (new `display_name` key) — issue #219 D22
   *  dual-emit compatibility window; the server sends both at the same
   *  revision, and the revision guard above makes applying both idempotent
   *  (whichever arrives first wins, the second is a no-op). */
  onRenameDisplayName?: (displayName: string, revision: number) => void;
  /** attach_open relayed by the server (file-upload spec / ADR-0025).
   *  Announces an upcoming upload; the wrapper registers a pending entry. */
  onAttachOpen?: (msg: AttachOpenMessage) => void;
  /** attach_chunk relayed by the server — a V2 binary frame payload. The
   *  wrapper parses the upload_id / chunk_index header and appends bytes. */
  onAttachChunk?: (payload: ArrayBuffer | ArrayBufferView) => void;
  /** attach_close relayed by the server. The wrapper verifies the upload
   *  is complete; an incomplete or oversize upload emits attach_rejected. */
  onAttachClose?: (uploadId: string) => void;
  /** Inbound inter_agent_message envelope (protocol-inter-agent spec). The
   *  server pushes both routed messages (from peer wrapper) and synthesized
   *  ones (e.g. escalate-to-user on quota overshoot) to the receiving
   *  wrapper's topic — both flow through here. */
  onInterAgentMessage?: (envelope: Envelope) => void;
  /** Join/rejoin's recipient-local acknowledgement ledger. `null` means an
   * older server did not negotiate the capability, so callers must report it
   * as unknown rather than as an empty queue. */
  onInterAgentDeliveryStatus?: (status: InterAgentDeliveryStatus | null) => void;
  /** Acceptance ack for an OUTBOUND inter_agent_message (ADR-0051 D3-2).
   *  Fires when the server replies to the `envelope` push with the ingress
   *  stamp it allocated — the point at which the message is known to be
   *  accepted, projected and routed. This, not the MCP tool result, is the
   *  sender-side sidecar trigger: the tool result is a locally built string
   *  and, under `wait_for_response=true`, does not return until the peer
   *  replies, which can be a whole session generation later.
   *
   *  `envelope` is what actually went on the wire (seq / session_id
   *  stamped), so recording it verbatim keeps the restored sender copy
   *  identical to the live one. A reject, a timeout or a lost ack simply
   *  never fires this — that message is not restorable, which D7 (e)
   *  accepts. */
  onInterAgentAck?: (envelope: Envelope, stamp: [number, number]) => void;
  /** Terminal reset failure for this wrapper topic. The requesting process
   *  normally exits on success, so this is intentionally only the failure
   *  leg: it lets an old wrapper that could not be terminated tell its agent
   *  that the accepted reservation did not become a reset (#258). */
  onSessionResetFailed?: (failure: SessionResetFailure) => void;
  /** Hydration verdict from the join reply (ADR-0051 D2). Called on EVERY
   *  (re)join, with `null` when the reply carried no `hydration` key — a
   *  legacy server, where the wrapper keeps its old startup-replay
   *  behaviour. */
  onHydration?: (verdict: HydrationVerdictMessage | null) => void;
}

/** Server acknowledgement of a self-initiated reset reservation. Acceptance
 *  is not completion: retain this id to correlate a later failure push. */
export interface SessionResetAccepted {
  requestId: string;
}

/** Narrowed server -> wrapper terminal failure. `reason` is a lifecycle
 *  vocabulary value, never free server text because it reaches a model turn. */
export interface SessionResetFailure {
  requestId: string;
  reason: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The reasons a `session_reset_request` reply may carry — exactly the four
 *  the server can answer with (protocol.md `session_reset_request`; the
 *  channel normalises malformed requests into `unsupported_session_reset`
 *  rather than minting new tokens). A whitelist, not a filter: anything
 *  outside it is a server the wrapper does not understand, and guessing at
 *  its wording is worse than admitting that.
 *
 *  `timeout` is deliberately absent — it is not a payload value. The
 *  transport raises it itself when the push never gets a reply, and the
 *  distinction matters to the caller (see SessionResetCoordinator: a
 *  timeout does not establish that nothing happened). */
const SESSION_RESET_ERROR_REASONS: ReadonlySet<string> = new Set([
  "agent_busy",
  "session_reset_pending",
  "unsupported_session_reset",
  "runner_unavailable",
]);

/** Lifecycle results use the broader closed vocabulary. They are delivered
 *  only as server-authored pushes on wrapper:<agent>, but still narrow them
 *  before they reach the reset coordinator and its model-facing notice. */
const SESSION_RESET_FAILURE_REASONS: ReadonlySet<string> = new Set([
  ...SESSION_RESET_ERROR_REASONS,
  "spawn_failed",
  "rollback_failed",
  "timeout",
]);

/** Collapses to this when the reply carries no recognised reason. */
export const SESSION_RESET_UNKNOWN_REASON = "unknown_error";

/** Pulls the server's `reason` out of a `session_reset_request` error reply
 *  (`{reason: "agent_busy"}`). Anything outside the closed vocabulary — an
 *  unknown token, a non-object payload, an empty string — collapses to
 *  `unknown_error` rather than being echoed back. The value ends up in an
 *  operator log AND in a turn injected into the model, so it must not become
 *  a channel for arbitrary payload text. */
function sessionResetErrorReason(payload: unknown): string {
  if (isObject(payload)) {
    const reason = (payload as { reason?: unknown }).reason;
    if (typeof reason === "string" && SESSION_RESET_ERROR_REASONS.has(reason)) {
      return reason;
    }
  }
  return SESSION_RESET_UNKNOWN_REASON;
}

function sessionResetAcceptedFrom(
  payload: unknown,
): SessionResetAccepted | null {
  if (!isObject(payload) || typeof payload.request_id !== "string") return null;
  return payload.request_id === "" ? null : { requestId: payload.request_id };
}

function sessionResetFailureFrom(payload: unknown): SessionResetFailure | null {
  if (!isObject(payload)) return null;
  const requestId = payload.request_id;
  const reason = payload.reason;
  if (
    typeof requestId !== "string" ||
    requestId === "" ||
    typeof reason !== "string" ||
    !SESSION_RESET_FAILURE_REASONS.has(reason)
  ) {
    return null;
  }
  return { requestId, reason };
}

/** `isObject` answers true for arrays (`typeof [] === "object"`), which the
 *  projection must not accept: the server's Elixir side tests `is_map/1`, so
 *  `rate_limits: [{...}]` is rejected there but would arrive here as a window
 *  named "0". Projection uses this stricter test to keep the two sides
 *  admitting the same inputs. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return isObject(value) && !Array.isArray(value);
}

/** Bounds mirrored from the server's own projection (phase-27, #160). The two
 *  sides MUST agree: a looser client would re-open the pass-through the
 *  server closed, since the model reads whatever survives here. */
const MAX_RATE_WINDOWS = 8;
const MAX_WINDOW_KEY_BYTES = 32;
const MAX_STATUS_BYTES = 64;
const WINDOW_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
/** Windows every engine is expected to report; kept ahead of engine-specific
 *  ones when the count has to be trimmed, so the two that drive delegation
 *  decisions never get pushed out. */
const CANONICAL_WINDOWS = ["five_hour", "seven_day"];

const utf8Bytes = new TextEncoder();

/** Finite AND within +-(2^53-1). `Number.isFinite` alone admits values past
 *  the safe-integer range, where a JS number has already lost precision
 *  against the arbitrary-precision integer the Elixir side accepted — the two
 *  would then disagree about the same wire value. The magnitude bound is the
 *  agreed common ceiling for every numeric field (phase-27, #160). */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= Number.MAX_SAFE_INTEGER
    ? value
    : undefined;
}

/** Non-negative counters and Unix-second timestamps alike: a negative or
 *  fractional value is not one, and a value past the safe-integer range has
 *  already lost precision. */
function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function deliveryStatusFrom(value: unknown): InterAgentDeliveryStatus | undefined {
  if (!isPlainObject(value)) return undefined;
  const issued = nonNegativeInteger(value.issued_seq);
  const acked = nonNegativeInteger(value.acked_seq);
  if (issued === undefined || acked === undefined || acked > issued) return undefined;
  if (value.pending_since !== undefined && typeof value.pending_since !== "string") return undefined;
  if (issued === acked && value.pending_since !== undefined) return undefined;
  if (issued > acked && typeof value.pending_since !== "string") return undefined;
  return {
    issued_seq: issued,
    acked_seq: acked,
    ...(typeof value.pending_since === "string" ? { pending_since: value.pending_since } : {}),
  };
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Copies only the three canonical numbers. An unknown nested key is not
 *  carried over, and a malformed one drops the whole field rather than
 *  handing the model a partial reading it would compare against a full one. */
function projectContext(value: unknown): DirectoryContext | undefined {
  if (!isPlainObject(value)) return undefined;
  const used_tokens = finiteNumber(value.used_tokens);
  const max_tokens = finiteNumber(value.max_tokens);
  const used_percentage = finiteNumber(value.used_percentage);
  if (
    used_tokens === undefined ||
    max_tokens === undefined ||
    used_percentage === undefined
  ) {
    return undefined;
  }
  return { used_tokens, max_tokens, used_percentage };
}

/** `utilization` is deliberately NOT range-checked to 0..1 here: #164 is
 *  still reconciling what the engines actually report, and clamping now
 *  would hide the very values that investigation needs. */
function projectRateLimitWindow(
  key: string,
  value: unknown,
): DirectoryRateLimitWindow | undefined {
  if (!isPlainObject(value)) return undefined;
  if (utf8Bytes.encode(key).length > MAX_WINDOW_KEY_BYTES) return undefined;
  if (!WINDOW_KEY_PATTERN.test(key)) return undefined;
  // Each field is optional, but a PRESENT one that fails validation drops the
  // whole window rather than just itself: a window reporting `utilization`
  // while silently discarding an out-of-spec `status` would read as a
  // complete picture when it is not.
  const window: DirectoryRateLimitWindow = {};
  if (value.status !== undefined) {
    if (typeof value.status !== "string") return undefined;
    if (utf8Bytes.encode(value.status).length > MAX_STATUS_BYTES) {
      return undefined;
    }
    window.status = value.status;
  }
  if (value.utilization !== undefined) {
    const utilization = finiteNumber(value.utilization);
    if (utilization === undefined) return undefined;
    window.utilization = utilization;
  }
  if (value.resets_at !== undefined) {
    const resetsAt = nonNegativeInteger(value.resets_at);
    if (resetsAt === undefined) return undefined;
    window.resets_at = resetsAt;
  }
  // No field at all — an empty window name tells a peer nothing.
  return Object.keys(window).length === 0 ? undefined : window;
}

function windowSortKey(key: string): [number, string] {
  const canonical = CANONICAL_WINDOWS.indexOf(key);
  return canonical === -1 ? [CANONICAL_WINDOWS.length, key] : [canonical, ""];
}

function projectRateLimits(
  value: unknown,
): Record<string, DirectoryRateLimitWindow> | undefined {
  if (!isPlainObject(value)) return undefined;
  const valid: [string, DirectoryRateLimitWindow][] = [];
  for (const [key, raw] of Object.entries(value)) {
    const window = projectRateLimitWindow(key, raw);
    if (window !== undefined) valid.push([key, window]);
  }
  // Deterministic trim: canonical windows first, then the rest in ASCII
  // code-unit order, so which windows survive never depends on object key
  // order. NOT localeCompare — it is locale-dependent and orders case
  // differently from the server's binary sort ("Z" before "a" there, after
  // it under many locales), which would make the two keep different windows
  // once more than MAX_RATE_WINDOWS survive validation.
  valid.sort(([a], [b]) => {
    const [rankA, tieA] = windowSortKey(a);
    const [rankB, tieB] = windowSortKey(b);
    if (rankA !== rankB) return rankA - rankB;
    return tieA < tieB ? -1 : tieA > tieB ? 1 : 0;
  });
  const kept = valid.slice(0, MAX_RATE_WINDOWS);
  return kept.length === 0 ? undefined : Object.fromEntries(kept);
}

function projectConversation(
  value: unknown,
): DirectoryConversation | undefined {
  if (!isPlainObject(value)) return undefined;
  if (typeof value.active !== "boolean") return undefined;
  if (!Array.isArray(value.peers)) return undefined;
  if (!value.peers.every((peer): peer is string => typeof peer === "string")) {
    return undefined;
  }
  return { active: value.active, peers: value.peers };
}

/** Structural narrow for a single `directory_request` entry. Asserts every
 *  field DirectoryEntry declares non-optional, so a server response that
 *  drops `persona` or `state` cannot smuggle a malformed entry through the
 *  type system.
 *
 *  The optional fields are projected one at a time: a malformed one is
 *  dropped on its own and its valid siblings still reach the model, matching
 *  the "omit what we cannot vouch for" rule the whole feature is built on. */
function directoryEntryFrom(value: unknown): DirectoryEntry | null {
  if (!isObject(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.agent_id !== "string" ||
    !isObject(v.persona) ||
    typeof v.state !== "string"
  ) {
    return null;
  }
  const entry: DirectoryEntry = {
    agent_id: v.agent_id,
    persona: v.persona as DirectoryEntry["persona"],
    state: v.state,
  };
  const delivery = deliveryStatusFrom(v.inter_agent_delivery);
  if (delivery !== undefined) entry.inter_agent_delivery = delivery;
  // issue #219 D19/D26: same value-level narrow used everywhere else on
  // this repo's display-name fields — a malformed value (overlong,
  // control chars) is omitted rather than passed through, matching this
  // function's own "omit what we cannot vouch for" rule for every other
  // optional field.
  if (typeof v.display_name === "string") {
    const displayName = validDisplayNameOrNull(v.display_name);
    if (displayName !== null) entry.display_name = displayName;
  }
  for (const key of ["engine", "model", "effort"] as const) {
    const field = v[key];
    if (typeof field === "string" && field !== "") entry[key] = field;
  }
  const context = projectContext(v.context);
  if (context !== undefined) entry.context = context;
  const startedAt = nonEmptyText(v.session_started_at);
  if (startedAt !== undefined) entry.session_started_at = startedAt;
  // A non-negative integer; absent means "the server never observed this
  // session start", which is NOT the same as zero round-trips.
  const turns = nonNegativeInteger(v.turns);
  if (turns !== undefined) entry.turns = turns;
  const lastActivityAt = nonEmptyText(v.last_activity_at);
  if (lastActivityAt !== undefined) entry.last_activity_at = lastActivityAt;
  const conversation = projectConversation(v.conversation);
  if (conversation !== undefined) entry.conversation = conversation;
  const rateLimits = projectRateLimits(v.rate_limits);
  if (rateLimits !== undefined) entry.rate_limits = rateLimits;
  // issue #269: server は true のときだけ載せる。それ以外の値 (false /
  // 文字列 / 数値) は「server が閉じたものを client が開け直さない」規約
  // に従って落とす。
  if (v.directory_only === true) entry.directory_only = true;
  const lastSeen = nonEmptyText(v.last_seen);
  if (lastSeen !== undefined) entry.last_seen = lastSeen;
  return entry;
}

// Same charset the server enforces for BOTH agent_id and user_id
// (issue #61, ADR-0050 D1 puts the two in one id space) —
// KaoiroServerWeb.AgentId's own single-source-of-truth regex, mirrored
// here since the two languages cannot share one literal.
const USER_ID_PATTERN = /^[A-Za-z0-9._-]{1,256}$/;

// C0 controls + DEL — same set `WrapperChannel.valid_display_name/1`
// rejects server-side (issue #197 段階2).
const DISPLAY_NAME_CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;
const DISPLAY_NAME_MAX_GRAPHEMES = 64;
// Grapheme-cluster segmentation, NOT locale-sensitive collation — the
// `undefined` locale arg just picks the runtime default locale, which
// does not affect where grapheme cluster boundaries fall (Unicode's
// extended grapheme cluster algorithm is locale-independent).
const displayNameSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

/** Same display_name contract the server enforces
 *  (`WrapperChannel.valid_display_name/1`, issue #197 段階2 ふじ MF-1
 *  レビュー指摘): trim-then-non-empty, no C0/DEL control chars, and — the
 *  part a plain-string check misses — **<= 64 GRAPHEME CLUSTERS**, not
 *  UTF-16 code units (JS's plain `.length`) and not Unicode code points
 *  (`[...s].length`). Both of those over-count a combining-character or
 *  ZWJ-emoji name relative to Elixir `String.length/1` (the unit the
 *  server actually bounds), which would make this narrow reject a value
 *  the server already accepted and sent — see protocol-inter-agent.md's
 *  contract note for the measured divergence on one such string.
 *
 *  Returns the TRIMMED name on success (not merely `true`) and `null` on
 *  failure — the caller must forward the same value this validated, not
 *  the untrimmed original, or the boundary's own contract claim
 *  ("enforces the same trim contract the server enforces") would hold
 *  for the accept/reject decision only, not for the value that actually
 *  crosses it (code-review round finding, issue #197 段階2 MF-1
 *  follow-up: a well-behaved server always sends an already-trimmed
 *  value today, so this had no observable effect against it, but a
 *  malicious/legacy/future-buggy source sending e.g. `" Ao "` would
 *  otherwise pass validation while still forwarding the padding this
 *  bound exists to strip). */
function validDisplayNameOrNull(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "" || DISPLAY_NAME_CONTROL_CHAR_PATTERN.test(trimmed)) {
    return null;
  }
  let graphemeCount = 0;
  for (const _segment of displayNameSegmenter.segment(trimmed)) {
    graphemeCount += 1;
    if (graphemeCount > DISPLAY_NAME_MAX_GRAPHEMES) return null;
  }
  return trimmed;
}

/** Structural narrow for a single `users` entry (issue #197 段階2). All
 *  four fields are non-optional on the wire (server-side allow-list,
 *  ADR-0021 F6-8), so unlike `directoryEntryFrom` there is no
 *  field-by-field partial projection: any field missing, off-type, or
 *  off-VALUE drops the WHOLE entry, matching the server's own "role is
 *  required, no per-field unknown" stance. `kind`/`role` are checked
 *  against the exact allow-listed literal/enum, not merely `typeof
 *  === "string"` (ふじ M2 レビュー指摘: a plain-string check let an
 *  unrecognised `kind`/`role` value — e.g. a future `"agent"`, or
 *  `"admin"` back when issue #198 had not yet added it — pass through
 *  unnoticed). `id` is checked against the
 *  same charset the server enforces, `display_name` against the same
 *  trim/length/control-char contract the server enforces
 *  (`validDisplayNameOrNull`, ふじ MF-1 レビュー指摘: this used to accept
 *  any non-empty string, leaving the server-side M5 bound unenforced at
 *  this boundary). The entry carries the TRIMMED name back
 *  (`validDisplayNameOrNull`'s return, not `v.display_name`) so the
 *  value forwarded matches the value actually validated. One malformed
 *  entry does not affect its siblings — the caller maps this over the
 *  array and filters nulls, so a single bad entry among many valid ones
 *  is dropped on its own. */
/** Runtime half of `USER_ROLES`. Widening to `readonly unknown[]` is the
 *  only way `includes` accepts an `unknown`; it widens the ARGUMENT type,
 *  never the set being matched, so the check stays exact. */
function isUserRole(value: unknown): value is UserRole {
  return (USER_ROLES as readonly unknown[]).includes(value);
}

function userDirectoryEntryFrom(value: unknown): UserDirectoryEntry | null {
  if (!isObject(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.id !== "string" ||
    !USER_ID_PATTERN.test(v.id) ||
    v.kind !== "user" ||
    typeof v.display_name !== "string" ||
    !isUserRole(v.role)
  ) {
    return null;
  }
  const displayName = validDisplayNameOrNull(v.display_name);
  if (displayName === null) return null;
  return { id: v.id, kind: v.kind, display_name: displayName, role: v.role };
}

/** Narrows the join reply's `hydration` object. Anything unexpected —
 *  absent, a non-object, `replay_required: true` without a usable id —
 *  collapses to `null` (treated as a legacy server), because guessing at a
 *  malformed verdict is worse than falling back to the old behaviour. */
export function hydrationVerdictFrom(
  reply: unknown,
): HydrationVerdictMessage | null {
  if (!isObject(reply)) return null;
  const hydration = (reply as { hydration?: unknown }).hydration;
  if (!isObject(hydration)) return null;
  const required = (hydration as { replay_required?: unknown }).replay_required;
  if (typeof required !== "boolean") return null;
  if (!required) return { replay_required: false };
  const replayId = (hydration as { replay_id?: unknown }).replay_id;
  if (typeof replayId !== "string" || replayId === "") return null;
  return { replay_required: true, replay_id: replayId };
}

/** Narrows the acceptance ack's `ingress_stamp` (protocol.md: a 2-element
 *  integer array). A malformed stamp is unusable — the server drops
 *  stampless rows fail-closed on replay — so it is dropped here. */
function ingressStampFrom(reply: unknown): [number, number] | null {
  if (!isObject(reply)) return null;
  const stamp = (reply as { ingress_stamp?: unknown }).ingress_stamp;
  if (
    !Array.isArray(stamp) ||
    stamp.length !== 2 ||
    !Number.isSafeInteger(stamp[0]) ||
    !Number.isSafeInteger(stamp[1])
  ) {
    return null;
  }
  return [stamp[0] as number, stamp[1] as number];
}

/** Closed-vocabulary reason from a rejected push reply. The channel always
 *  answers `{reason: "..."}`; anything else is normalised rather than
 *  interpolated into the tool result verbatim. */
function pushRejectReason(reply: unknown): string {
  if (!isObject(reply)) return "unknown";
  const reason = (reply as { reason?: unknown }).reason;
  return typeof reason === "string" && reason !== "" ? reason : "unknown";
}

export class ServerLink {
  readonly #socket: Socket;
  readonly #channel: Channel;
  #seq = 0;
  #lastEnvelope: Envelope | null = null;
  /** Active task entities by task_id. Unlike logs/results, these are current
   * state that must be re-announced after WrapperChannel purges the old
   * connection's TaskStates entry. `kind=completed` removes its entity.
   *
   * Map insertion order is a least-recently-updated queue. A wrapper can miss
   * a completion when a child crashes, so this cache may not grow without
   * bound while the process lives: `#rememberActiveTask` evicts its oldest
   * entry to the documented count/byte ceilings. `tasklist` is retained in
   * preference to ordinary child tasks because it is the parent agent's sole
   * current todo snapshot; an overflow writes one bounded stderr warning
   * instead of silently claiming reconnect recovery is complete. */
  readonly #activeTasks = new Map<string, ActiveTaskCacheEntry>();
  #activeTaskCacheBytes = 0;
  #activeTaskCacheOverflowWarned = false;
  /** Latest SDK session id reported by the host (ADR-0014 phase-0); stamped
   *  onto every outgoing envelope until a newer one replaces it. */
  #sessionId: string | null = null;
  /** Kept because `send/1` needs it per push, unlike the inbound handlers
   *  which are bound once in the constructor. */
  readonly #onInterAgentAck: ServerLinkOptions["onInterAgentAck"];

  /**
   * @param serverUrl Socket endpoint, e.g. "ws://localhost:4000/wrapper"
   *   (the client appends "/websocket").
   * @param agentId Stable agent id; the channel topic is `wrapper:<agentId>`.
   */
  constructor(
    serverUrl: string,
    agentId: string,
    options: ServerLinkOptions,
  ) {
    this.#onInterAgentAck = options.onInterAgentAck;
    this.#socket = new Socket(serverUrl, {
      transport: WebSocket,
      params: options.token === undefined ? {} : { token: options.token },
    });
    this.#socket.connect();
    // persona_id rides join params (channel-level) so the server can
    // reject an unknown-persona join before it consumes any state
    // (ADR-0029 F3, protocol.md「人格プロンプト配送」). transition_id rides
    // the same params (phase-27, #160) so the server can tell this join
    // apart from any other connection for the agent; omitted entirely when
    // unknown, since the server reads a blank value as a mismatch rather
    // than as the legacy absent case.
    this.#channel = this.#socket.channel(`wrapper:${agentId}`, {
      persona_id: options.personaId,
      inter_agent_delivery_ack: "dispatch-v1",
      delivery_generation: randomUUID(),
      ...(options.transitionId !== undefined && options.transitionId !== ""
        ? { transition_id: options.transitionId }
        : {}),
    });

    // ADR-0029 F5: the server pushes the ready-to-inject prompt (persona
    // personality + common footer) once after join. cli.ts's promise
    // resolves on this and starts the SDK session.
    this.#bindServerEvent("persona_prompt", (payload: unknown) => {
      if (isObject(payload) && typeof payload.prompt === "string") {
        options.onPersonaPrompt?.(payload.prompt);
      }
    });

    this.#bindServerEvent("instruction", (payload: unknown) => {
      if (isObject(payload) && typeof payload.text === "string") {
        // attachment_ids is optional (file-upload spec); validate it as an
        // array of strings or drop it silently so a malformed list does
        // not poison the text-only path.
        const ids = Array.isArray(payload.attachment_ids)
          ? payload.attachment_ids.filter(
              (id): id is string => typeof id === "string",
            )
          : undefined;
        options.onInstruction?.(
          payload.text,
          ids && ids.length > 0 ? ids : undefined,
        );
      }
    });
    this.#bindServerEvent("permission_decision", (payload: unknown) => {
      if (
        isObject(payload) &&
        typeof payload.request_id === "string" &&
        typeof payload.allow === "boolean"
      ) {
        const decision: PermissionDecisionMessage = {
          request_id: payload.request_id,
          allow: payload.allow,
        };
        if (typeof payload.message === "string") {
          decision.message = payload.message;
        }
        options.onPermissionDecision?.(decision);
      }
    });
    // ADR-0027: server -> wrapper `question_response` carries the operator's
    // AskUserQuestion answers (or a cancel). `answers` is a string map keyed
    // by question text; malformed pushes are dropped.
    this.#bindServerEvent("question_response", (payload: unknown) => {
      if (isObject(payload) && typeof payload.request_id === "string") {
        const response: QuestionResponseMessage = {
          request_id: payload.request_id,
          answers: isObject(payload.answers)
            ? (payload.answers as Record<string, string>)
            : {},
        };
        if (payload.cancelled === true) response.cancelled = true;
        options.onQuestionResponse?.(response);
      }
    });
    // protocol.md (#51): server -> wrapper `interrupt` carries an empty
    // payload; the topic already addresses the agent. Fire the handler
    // unconditionally — extra keys are ignored for forward compat.
    this.#bindServerEvent("interrupt", (_payload: unknown) => {
      options.onInterrupt?.();
    });
    // protocol.md (#54): server -> wrapper `set_model` / `set_effort` carry
    // the operator's choice; the topic addresses the agent. Validate the one
    // string field structurally and forward; malformed pushes are dropped.
    this.#bindServerEvent("set_model", (payload: unknown) => {
      if (isObject(payload) && typeof payload.model === "string") {
        options.onSetModel?.(payload.model);
      }
    });
    this.#bindServerEvent("set_effort", (payload: unknown) => {
      if (isObject(payload) && typeof payload.effort === "string") {
        options.onSetEffort?.(payload.effort);
      }
    });
    // protocol.md (ADR-0037 F6, phase-18-5): server -> wrapper `refresh_models`
    // has no payload fields; the topic already addresses the agent. Fire the
    // handler unconditionally — extra keys are ignored for forward compat.
    this.#bindServerEvent("refresh_models", (payload: unknown) => {
      // ADR-0039 F9 v2 = 藤 review D2a: payload now carries request_id so
      // the wrapper's refresh_models_result envelope can correlate. Older
      // servers may still push a bare {} — pass through as undefined.
      const rid =
        typeof payload === "object" &&
        payload !== null &&
        typeof (payload as { request_id?: unknown }).request_id === "string"
          ? (payload as { request_id: string }).request_id
          : undefined;
      options.onRefreshModels?.({
        ...(rid === undefined ? {} : { request_id: rid }),
      });
    });
    // protocol.md (#58): server -> wrapper `set_permission_mode` carries the
    // operator's mode pick AND the server's after-join push of the persisted
    // last choice. Mode-value validation lives in host.setPermissionMode.
    this.#bindServerEvent("set_permission_mode", (payload: unknown) => {
      if (isObject(payload) && typeof payload.mode === "string") {
        options.onSetPermissionMode?.(payload.mode);
      }
    });
    // protocol.md (issue #197 段階3): server -> wrapper `persona_sync`
    // carries the authoritative current name + revision, both on join
    // (fresh AND reconnect) and on a live `rename_agent`. `name` gets the
    // SAME value-level narrow `userDirectoryEntryFrom` uses
    // (`validDisplayNameOrNull` — trim / <= 64 grapheme clusters / no
    // control chars), not just `typeof === "string"` (ふじ MF-4 レビュー
    // 指摘: a bare string check let an empty, overlong, or control-char
    // name flow straight into config/state_change/stdout). `revision`
    // must be a safe integer in `AgentDirectory.rename/2`'s actual output
    // domain (0 <= revision <= Number.MAX_SAFE_INTEGER — the server
    // fail-closes with `revision_exhausted` rather than ever emitting
    // past that ceiling). Two INDEPENDENT conditions reject the two
    // ends, deliberately not one — `Number.isSafeInteger` alone accepts
    // negative integers (its domain is symmetric,
    // -(2^53-1)..2^53-1), so it cannot do this job by itself:
    // `revision < 0` drops negatives (a domain check, not a poisoning
    // defense — the producer, `AgentDirectory.rename/2`, never emits
    // one, and `host.renamePersona`'s `revision <= #personaRevision`
    // guard starts from a baseline of 0, so a negative value could never
    // plant there in the first place), and `!Number.isSafeInteger(...)`
    // drops unsafe-large values, i.e. anything past MAX_SAFE_INTEGER
    // (ふじ MF-5 レビュー指摘: THIS is the actual poisoning risk this
    // narrow guards against — the server can hold an authoritative
    // revision this narrow keeps dropping, which would leave this
    // agent's persona permanently unable to converge even across
    // reconnects, if the server-side ceiling above did not already
    // prevent it from being emitted at all). The stale-vs-newer
    // comparison itself still happens in `host.renamePersona`, not
    // here — same division of labor `set_permission_mode` has with
    // `host.setPermissionMode`.
    // issue #219 D22: dual-emit compatibility window — the server sends
    // BOTH `persona_sync` (legacy `name` key) and `display_name_sync`
    // (new `display_name` key) at the same revision. Both funnel through
    // this same validate+dispatch so the two events are indistinguishable
    // to `onRenameDisplayName` beyond which key each payload happened to
    // carry; the revision guard in host.ts makes applying both idempotent
    // (D15 — whichever arrives first wins, the second is a no-op).
    //
    // ADR-0015 warn-then-accept (issue #197 段階3, ふじ MF-1 レビュー指摘):
    // a version mismatch/absence never blocks the rename itself, it only
    // logs. The check no longer lives in this closure — `#bindServerEvent`
    // runs it for every event (issue #218), which also means a push this
    // function drops as malformed still surfaces its version mismatch.
    const applyDisplayNameSync = (
      rawValue: unknown,
      rawRevision: unknown,
    ): void => {
      if (typeof rawValue !== "string") return;
      const displayName = validDisplayNameOrNull(rawValue);
      if (
        displayName === null ||
        typeof rawRevision !== "number" ||
        !Number.isSafeInteger(rawRevision) ||
        rawRevision < 0
      ) {
        return;
      }
      options.onRenameDisplayName?.(displayName, rawRevision);
    };

    this.#bindServerEvent("persona_sync", (payload: unknown) => {
      if (!isObject(payload)) return;
      applyDisplayNameSync(payload.name, payload.revision);
    });
    this.#bindServerEvent("display_name_sync", (payload: unknown) => {
      if (!isObject(payload)) return;
      applyDisplayNameSync(payload.display_name, payload.revision);
    });
    // File-upload wire (file-upload spec / ADR-0025). attach_open declares an
    // upload, attach_chunk delivers a binary slice, attach_close finalises.
    // Malformed payloads are dropped — the wire is operator-only and the
    // server already vets shapes; a defensive drop is enough.
    this.#bindServerEvent("attach_open", (payload: unknown) => {
      if (
        isObject(payload) &&
        typeof payload.upload_id === "string" &&
        typeof payload.filename === "string" &&
        typeof payload.mime === "string" &&
        typeof payload.size === "number" &&
        typeof payload.chunks === "number"
      ) {
        options.onAttachOpen?.({
          upload_id: payload.upload_id,
          filename: payload.filename,
          mime: payload.mime,
          size: payload.size,
          chunks: payload.chunks,
        });
      }
    });
    this.#bindServerEvent("attach_chunk", (payload: unknown) => {
      // V2 binary frame: payload is an ArrayBuffer (browser) or a
      // Buffer/Uint8Array (Node ws). Anything else is malformed.
      if (payload instanceof ArrayBuffer || ArrayBuffer.isView(payload)) {
        options.onAttachChunk?.(payload as ArrayBuffer | ArrayBufferView);
      }
    });
    this.#bindServerEvent("attach_close", (payload: unknown) => {
      if (isObject(payload) && typeof payload.upload_id === "string") {
        options.onAttachClose?.(payload.upload_id);
      }
    });
    // Inter-agent routing (protocol-inter-agent spec): the server pushes the
    // full envelope (type=inter_agent_message) onto wrapper:<self> for every
    // message routed to this agent, including the server-synthesized
    // escalate-to-user on quota overshoot. Trust the topic for addressing —
    // payload.to is informational here, not a filter. Drop anything but
    // inter_agent_message defensively (the server never pushes other types
    // to wrapper:<self>, but a future broker should not see them).
    this.#bindServerEvent("envelope", (payload: unknown) => {
      if (!isObject(payload) || payload.type !== "inter_agent_message") return;
      options.onInterAgentMessage?.(payload as unknown as Envelope);
    });
    this.#bindServerEvent("delivery_status", (payload: unknown) => {
      options.onInterAgentDeliveryStatus?.(deliveryStatusFrom(payload) ?? null);
    });
    // #258: a self-reset's request reply proves only that the server acquired
    // its lock. If the runner later cannot terminate this old wrapper, the
    // server sends the terminal failure back to this topic. Correlation stays
    // in SessionResetCoordinator; a fresh wrapper ignores an old request id.
    this.#bindServerEvent("session_reset_failed", (payload: unknown) => {
      const failure = sessionResetFailureFrom(payload);
      if (failure !== null) options.onSessionResetFailed?.(failure);
    });

    // Re-announce the latest state and active tasks after a reconnect: the
    // server keeps them in memory only, and WrapperChannel discards TaskStates
    // when the old connection terminates. A tasklist's wrapper-side exact
    // snapshot dedupe must not prevent this restoration. On the first open
    // both caches are empty (no-op); on reconnects pushes are buffered by the
    // client until the channel rejoins. send() stamps a fresh seq.
    this.#socket.onOpen(() => {
      if (this.#lastEnvelope) this.send(this.#lastEnvelope);
      for (const task of [...this.#activeTasks.values()]) this.send(task.envelope);
    });

    // Surface join failures; the client retries the join on its own, but a
    // silent rejection would otherwise leave sends buffering unnoticed.
    // The "ok" hook also carries the ADR-0051 hydration verdict, and the
    // phoenix client keeps receive hooks across a rejoin's `resend()`, so
    // it fires again on every reconnect — which is exactly when the server
    // needs to re-decide whether its projection survived.
    this.#channel
      .join()
      .receive("ok", (reply: unknown) => {
        options.onHydration?.(hydrationVerdictFrom(reply));
        options.onInterAgentDeliveryStatus?.(
          isObject(reply) ? deliveryStatusFrom(reply.delivery) ?? null : null,
        );
      })
      .receive("error", (reason: unknown) => {
        process.stderr.write(
          `ServerLink join error: ${JSON.stringify(reason)}\n`,
        );
      })
      .receive("timeout", () => {
        process.stderr.write("ServerLink join timeout\n");
      });
  }

  /** Binds one server -> wrapper event with ADR-0015's receiver check in
   *  front of the handler (issue #218). The single `channel.on` call site
   *  in this class — `SERVER_EVENT_VERSION_POLICY` decides whether the
   *  check runs, and typing `event` as a key of that table means a new
   *  event has to be declared there before it can be bound at all.
   *
   *  The check runs BEFORE the handler's own payload validation, so a push
   *  the handler goes on to drop as malformed still surfaces its version
   *  mismatch. That is the receiver rule as ADR-0015 states it — the
   *  receiver observed a version it does not speak — and it keeps every
   *  event's logging behaviour identical regardless of how much shape
   *  validation the individual handler happens to do. */
  #bindServerEvent(
    event: ServerEventName,
    handler: (payload: unknown) => void,
  ): void {
    const checked = SERVER_EVENT_VERSION_POLICY[event] === "checked";
    this.#channel.on(event, (payload: unknown) => {
      if (checked) {
        warnOnVersionMismatch(
          event,
          isObject(payload) ? payload.version : undefined,
        );
      }
      handler(payload);
    });
  }

  /** Records the SDK session id the host just captured (ADR-0014 phase-0).
   *  Subsequent sends carry it; re-announced envelopes pick up the current
   *  one too, which is correct since it only ever moves forward. */
  setSessionId(sessionId: string): void {
    this.#sessionId = sessionId;
  }

  /** The SDK session id currently stamped onto outgoing envelopes, or null
   *  before the engine has reported one (ADR-0051 D2: a fresh session with
   *  no id replays empty). */
  currentSessionId(): string | null {
    return this.#sessionId;
  }

  /** Records contiguous SDK-dispatch completion.  The server treats a stale,
   * future, or duplicate watermark as a harmless no-op. */
  acknowledgeInterAgentDelivery(deliverySeq: number): void {
    if (!Number.isSafeInteger(deliverySeq) || deliverySeq <= 0) return;
    this.#pushVersioned("delivery_ack", { delivery_seq: deliverySeq });
  }

  /** Reads this wrapper's ledger independently of directory peers. */
  requestInterAgentDeliveryStatus(): Promise<InterAgentDeliveryStatus | null> {
    return new Promise((resolve) => {
      this.#pushVersioned("delivery_status_request", {})
        .receive("ok", (payload: unknown) =>
          resolve(isObject(payload) ? deliveryStatusFrom(payload.delivery) ?? null : null),
        )
        .receive("error", () => resolve(null))
        .receive("timeout", () => resolve(null));
    });
  }

  /** Pushes one envelope with the next seq; buffered while disconnected. */
  send(envelope: Envelope): void {
    const { wire, push } = this.#pushEnvelope(envelope);
    // ADR-0051 D3-2: only an inter-agent send has an ack worth reading —
    // the server replies with the ingress stamp it allocated, which is the
    // sender-side sidecar trigger. Everything else keeps the existing
    // fire-and-forget shape.
    if (envelope.type === "inter_agent_message") {
      push.receive("ok", (reply: unknown) =>
        this.#recordInterAgentAck(wire, reply),
      );
    }
  }

  /** Pushes an inter-agent envelope and resolves with what the server did
   *  with it (ADR-0051 D3-2 / ふじ 30-10 must-fix M5).
   *
   *  `send()` cannot answer this: it discards the `error` / `timeout` legs,
   *  so an explicit reject (`unknown_agent`, `participants_mismatch`, …)
   *  still surfaced to the model as "sent". The sidecar side-effect is
   *  unchanged and stays on the ack — recording is about durability, this
   *  Promise is about the tool result, and they settle at the same moment
   *  only in the accepted case. */
  sendInterAgent(envelope: Envelope): Promise<InterAgentAcceptance> {
    const { wire, push } = this.#pushEnvelope(envelope);
    return new Promise((resolve) => {
      push
        .receive("ok", (reply: unknown) => {
          resolve({ kind: "accepted", stamp: this.#recordInterAgentAck(wire, reply) });
        })
        .receive("error", (reply: unknown) => {
          resolve({ kind: "rejected", reason: pushRejectReason(reply) });
        })
        .receive("timeout", () => {
          resolve({ kind: "unknown", reason: "timeout" });
        });
    });
  }

  /** Stamps and pushes one envelope, returning both the wire form (for the
   *  sidecar) and the Push (for whichever ack legs the caller wants). */
  #pushEnvelope(envelope: Envelope): { wire: Envelope; push: Push } {
    // Only state_change / permission_request define the latest state worth
    // re-announcing after a reconnect. log / result are transcript lines
    // the server keeps as history; re-sending them would duplicate it.
    if (
      envelope.type === "state_change" ||
      envelope.type === "permission_request"
    ) {
      this.#lastEnvelope = envelope;
    }
    this.#rememberActiveTask(envelope);
    this.#seq += 1;
    const wire = {
      ...envelope,
      ...(this.#sessionId !== null ? { session_id: this.#sessionId } : {}),
      seq: this.#seq,
    } as Envelope;
    return { wire, push: this.#channel.push("envelope", wire) };
  }

  /** Stamps wrapper -> server control messages (ADR-0015 stage 2). */
  #pushVersioned(event: VersionedWrapperEvent, payload: Record<string, unknown>): Push {
    return this.#channel.push(event, {
      ...payload,
      version: WRAPPER_PROTOCOL_VERSION,
    });
  }

  #rememberActiveTask(envelope: Envelope): void {
    if (envelope.type !== "task") return;
    const taskId = envelope.payload.task_id;
    const kind = envelope.payload.kind;
    if (typeof taskId !== "string" || taskId === "") return;
    if (kind === "completed") {
      this.#dropActiveTask(taskId);
      return;
    }
    if (kind === "started" || kind === "updated") {
      const jsonBytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");

      // Replace before checking capacity so an update can reclaim its former
      // size. Deleting then setting also moves it to the newest end of the
      // LRU order, which is exactly the activity signal this cache has.
      this.#dropActiveTask(taskId);
      if (jsonBytes > MAX_ACTIVE_TASK_CACHE_BYTES) {
        this.#warnActiveTaskCacheOverflow();
        return;
      }

      this.#activeTasks.set(taskId, { envelope, jsonBytes });
      this.#activeTaskCacheBytes += jsonBytes;
      this.#trimActiveTaskCache();
    }
  }

  #dropActiveTask(taskId: string): void {
    const previous = this.#activeTasks.get(taskId);
    if (!previous) return;
    this.#activeTasks.delete(taskId);
    this.#activeTaskCacheBytes -= previous.jsonBytes;
    this.#resetActiveTaskCacheWarningIfBelowCapacity();
  }

  #trimActiveTaskCache(): void {
    let evicted = false;
    while (
      this.#activeTasks.size > MAX_ACTIVE_TASK_CACHE_ENTRIES ||
      this.#activeTaskCacheBytes > MAX_ACTIVE_TASK_CACHE_BYTES
    ) {
      // `tasklist` is a single parent-owned snapshot, unlike the potentially
      // stale child entries that made this cache need a lifecycle bound. Keep
      // it when any ordinary task is available to evict; if it is the only
      // entry it is necessarily within the per-envelope byte ceiling above.
      let oldest: [string, ActiveTaskCacheEntry] | undefined;
      for (const entry of this.#activeTasks.entries()) {
        if (!oldest) oldest = entry;
        if (entry[0] !== "tasklist") {
          oldest = entry;
          break;
        }
      }
      if (!oldest) break;

      const [taskId] = oldest;
      this.#dropActiveTask(taskId);
      evicted = true;
    }
    if (evicted) this.#warnActiveTaskCacheOverflow();
  }

  #warnActiveTaskCacheOverflow(): void {
    if (this.#activeTaskCacheOverflowWarned) return;
    this.#activeTaskCacheOverflowWarned = true;
    process.stderr.write(
      "ServerLink active-task replay cache reached its 5000-entity / 6000000-byte bound; oldest task entries were not retained for reconnect replay\n",
    );
  }

  #resetActiveTaskCacheWarningIfBelowCapacity(): void {
    if (
      this.#activeTasks.size < MAX_ACTIVE_TASK_CACHE_ENTRIES &&
      this.#activeTaskCacheBytes < MAX_ACTIVE_TASK_CACHE_BYTES
    ) {
      this.#activeTaskCacheOverflowWarned = false;
    }
  }

  /** Sidecar-records an accepted inter-agent send and returns the stamp the
   *  server allocated, or null when the ack carried none. */
  #recordInterAgentAck(wire: Envelope, reply: unknown): [number, number] | null {
    const stamp = ingressStampFrom(reply);
    if (stamp === null) {
      // An old server acks without a stamp. The message was delivered;
      // it just cannot be restored after a restart (ADR-0051 D6
      // rollout: this mixed pairing is the documented degradation).
      process.stderr.write(
        "inter-agent ack carried no ingress_stamp; not recorded\n",
      );
      return null;
    }
    this.#onInterAgentAck?.(wire, stamp);
    return stamp;
  }

  /** Asks the server to drop this agent's display projection before a
   *  history replay (ADR-0014 phase-2 / ADR-0051 D3-3), so the
   *  reconstructed lines overwrite rather than duplicate whatever the
   *  server still holds. The topic carries the agent_id. `replayId` is the
   *  server-allocated id from the join verdict; omitting it allocates a
   *  wrapper-side one, which is only correct against a legacy server that
   *  never issued a verdict. */
  sendHistoryReset(replayId?: string): string {
    const id =
      replayId ??
      `resume-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.#pushVersioned("history_reset", { replay_id: id });
    return id;
  }

  /** Restores this wrapper's own inter-agent pane from its sidecar
   *  (ADR-0051 D3-3). Display-only: the server upserts into the projection
   *  and does not route, so no peer is re-pushed and no SDK is re-injected.
   *  The pane is bound to the channel topic, so this cannot address another
   *  agent's pane. */
  sendReplayIa(replayId: string, items: readonly ReplayIaItem[]): void {
    // Chunked on real byte length (M4): one 200-row push is ~12 MB of valid
    // data against an 8 MB frame cap. Every chunk carries the SAME
    // replay_id and all of them precede `history_replay_complete`, so the
    // server's CAS still sees one attempt.
    const chunks = chunkReplayIaItems(items);
    const sent = chunks.reduce((n, chunk) => n + chunk.length, 0);
    if (sent < items.length) {
      process.stderr.write(
        `replay_ia: dropped ${items.length - sent} oversize sidecar row(s)\n`,
      );
    }
    for (const chunk of chunks) {
      this.#pushVersioned("replay_ia", { replay_id: replayId, items: chunk });
    }
  }

  /** Pushes the explicit end boundary after the final replayed row. */
  sendHistoryReplayComplete(replayId: string): void {
    this.#pushVersioned("history_replay_complete", { replay_id: replayId });
  }

  /** Fetches the peer directory (protocol-inter-agent companion tool). The
   *  server replies with `{agents: [...], users: [...]}` — `agents` is
   *  every currently-known agent except this wrapper, used by the
   *  `mcp__kaoiro__list_agents` tool to resolve persona names → agent_ids
   *  before send_to_agent. `users` is the issue #197 段階2 addition
   *  (ADR-0021 F6-8); only a server that PREDATES it omits the `users`
   *  key entirely — a 段階2+ server that opted the projection OUT still
   *  returns the key, just with an empty array (ふじ M4 レビュー指摘: an
   *  earlier draft of this comment conflated the two cases). Either way
   *  narrows to `[]` here, not an error (protocol-inter-agent.md
   *  back-compat note; see `UserDirectoryEntry`'s own doc above for the
   *  same distinction). Rejects on transport error or timeout so the
   *  tool surfaces the failure to the model rather than hanging. */
  requestDirectory(): Promise<DirectoryResult> {
    return new Promise((resolve, reject) => {
      this.#pushVersioned("directory_request", {})
        .receive("ok", (payload: unknown) => {
          if (!isObject(payload)) {
            resolve({ agents: [], users: [] });
            return;
          }
          const raw = payload as { agents?: unknown; users?: unknown };
          const agents = Array.isArray(raw.agents)
            ? raw.agents
                .map(directoryEntryFrom)
                .filter((entry): entry is DirectoryEntry => entry !== null)
            : [];
          const users = Array.isArray(raw.users)
            ? raw.users
                .map(userDirectoryEntryFrom)
                .filter((entry): entry is UserDirectoryEntry => entry !== null)
            : [];
          resolve({ agents, users });
        })
        .receive("error", (reason: unknown) => {
          reject(new Error(`directory_request failed: ${JSON.stringify(reason)}`));
        })
        .receive("timeout", () => {
          reject(new Error("directory_request timeout"));
        });
    });
  }

  /** Asks the server to reset THIS agent's session (ADR-0043 D1, phase-28
   *  C2). Only ever sent after the `request_session_reset` tool was approved
   *  by the operator and the wrapper reached its own turn boundary — the
   *  channel derives the agent_id from the socket, so a wrapper can only
   *  ever reset itself. `reason` travels solely in this payload; the server
   *  copies it to the operator-facing lifecycle broadcast and nowhere else.
   *
   *  Resolves when the server accepted the request, including its opaque
   *  request_id. That is a reservation acknowledgement, not reset completion:
   *  a later `session_reset_failed` push is correlated through this id if the
   *  old wrapper survives the runner's termination attempt (#258).
   *  Rejects with the reply's closed-vocabulary reason — `agent_busy`,
   *  `session_reset_pending`, `unsupported_session_reset` or
   *  `runner_unavailable` (protocol.md `session_reset_request`) — or with
   *  `timeout` when the push itself never got a reply, or `unknown_error`
   *  for anything outside that contract. The caller must distinguish these:
   *  a rejection is NOT proof that no reset started. */
  requestSessionReset(
    mode: "new" | "clear",
    reason?: string,
  ): Promise<SessionResetAccepted> {
    return new Promise((resolve, reject) => {
      this.#pushVersioned("session_reset_request", {
          mode,
          ...(reason !== undefined ? { reason } : {}),
        })
        .receive("ok", (payload: unknown) => {
          const accepted = sessionResetAcceptedFrom(payload);
          if (accepted === null) {
            reject(new Error(SESSION_RESET_UNKNOWN_REASON));
            return;
          }
          resolve(accepted);
        })
        .receive("error", (payload: unknown) => {
          reject(new Error(sessionResetErrorReason(payload)));
        })
        .receive("timeout", () => {
          reject(new Error("timeout"));
        });
    });
  }

  /** Leaves the channel and closes the socket. */
  close(): void {
    this.#channel.leave();
    this.#socket.disconnect();
  }
}
