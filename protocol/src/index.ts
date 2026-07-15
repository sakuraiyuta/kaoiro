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
  | "waiting_question"
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
 *  (Envelope, RunnerRegister, SpawnMessage, and any future wire shape). */
export interface WirePersona {
  id: string;
  name: string;
  sprite_set: string;
}

/** Assigned persona (protocol.md / ADR-0003). Under the server-集約 SoT
 *  model (ADR-0029) the wrapper carries only the wire-safe identifiers;
 *  the personality prompt is fetched from the server via WS handshake,
 *  not the config file. */
export type Persona = WirePersona;

/** Wrapper init config. agent_id is a stable id, constant across restarts.
 *  server_url points the wrapper at the kaoiro server's wrapper socket
 *  (ws:// or wss://) and is required — the wrapper cannot open its SDK
 *  session without the server-pushed personality prompt (ADR-0029 F3
 *  fail-closed). Shared with the runner, which resolves it to spawn a
 *  wrapper (ADR-0023). */
export interface WrapperConfig {
  agent_id: string;
  persona: Persona;
  server_url: string;
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
  /** Launch-time model pick relayed from SpawnMessage (ADR-0032 F4bc).
   *  Omitted = engine default. */
  model?: string;
  /** Launch-time effort pick relayed from SpawnMessage. */
  effort?: string;
  /** Provenance of `model` when the runner sourced it from a resume snapshot
   *  (ADR-0014 F1 追補 P1 pair-aware apply, phase-23). Populated by the
   *  supervisor after `applyResumeSnapshot` promotes a pair through the
   *  5-case rule; the wrapper CLI must prefer this over its own env / config
   *  provenance guesses so that a resume launch reports the SAME source the
   *  prior session stamped (Case 3 preserve) instead of overwriting it with
   *  "config". Absent on a fresh spawn — the CLI still derives the source
   *  from config.model / env as before. Distinct from the resume_snapshot
   *  field (drift display only): source rides here as an effective value. */
  model_source?: ModelSource;
  /** Provenance of `effort`, same semantics as `model_source`. */
  effort_source?: ModelSource;
  /** Runner-detected Codex auth context used to resolve the adapter catalog. */
  codex_auth_mode?: "chatgpt" | "apikey" | "unknown";
  /** Operator-declared ChatGPT plan. Ignored under API-key auth. */
  codex_chatgpt_plan?:
    | "free"
    | "go"
    | "plus"
    | "pro"
    | "business"
    | "enterprise";
  /** Codex internal sub-agent toggle relayed from the runner config
   *  (codex.internal_subagents), resolved to effective (= configured ?? true)
   *  by the runner relay. The host ALWAYS injects features.multi_agent = this
   *  value, so the runner option outranks any user-global Codex config: true
   *  force-enables, false disables (ADR-0038 F2). */
  codex_internal_subagents?: boolean;
  /** Claude-only: live-probed engine catalog snapshot from the runner's
   *  memory cache (ADR-0039 F9 追補). When set, the Claude adapter seeds
   *  its #models with this rich list instead of the ADR-0037 F1 single
   *  `default` bootstrap floor, so AgentDetail's model/effort switch is
   *  populated on the FIRST state_change — before the SDK's own
   *  supportedModels() runs (fresh-idle wrappers deferring Query
   *  construction never even reach that call). Absent = the wrapper falls
   *  back to `claudeBootstrapCatalog()`; the SDK's own catalog still
   *  overrides both once `#refreshSupportedModels()` succeeds. */
  claude_engine_catalog?: EngineModelInfo[];
  /** Codex-only OS sandbox axis (ADR-0033 F3); Claude ignores it.
   *  Omitted = "workspace-write". */
  sandbox?: PermissionAxesExt["sandbox"];
  /** Codex-only network toggle for workspace-write sandboxes. */
  network_access?: boolean;
  /** Resume snapshot relayed by the runner on a resume launch only
   *  (ADR-0014 F1 追補, phase-15 D8). Absent on fresh spawn. When present,
   *  the wrapper stamps it as ext.resume_snapshot and computes ext.resume_drift
   *  against the values it is enforcing this run. */
  resume_snapshot?: ResolvedSnapshotExt;
}

/** Closed enum of SDK PermissionMode values (#58). Mirrors the SDK union
 *  type so the wrapper, server, and dashboard share one definition. The
 *  protocol package is types-only (no runtime exports); consumers that need
 *  the value list duplicate it locally (wrapper/core/src/persona.ts,
 *  agents_channel.ex). */
export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto";

/** Engine kinds a host can run (ADR-0032 F4a). The value set of the runner
 *  register `capabilities`, `SpawnMessage.engine`, and `ext.engine`. */
export type EngineKind = "claude-code" | "codex";

/** ext.permission — the agent's current permission posture as the
 *  engine-neutral two-axis form (ADR-0033 F1). Claude adapters derive it
 *  from permissionMode via a display-approximation table (ADR-0033 F2);
 *  the codex adapter projects its launch-fixed sandbox with approval
 *  pinned to "never" (ADR-0033 F3). Successor of `ext.permission_mode`
 *  (kept in parallel for one release window, then removed). */
export interface PermissionAxesExt {
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  /** `on-failure` is a deprecated upstream alias of `on-request`; kaoiro
   *  wrappers never emit it but the enum keeps wire compatibility with
   *  the Codex SDK vocabulary. */
  approval: "untrusted" | "on-request" | "on-failure" | "never";
}

/** One launch-selectable model of an engine (ADR-0032 F4bc). Same shape as
 *  the `ext.models[]` entries the Claude adapter already publishes (#54),
 *  reused for the LaunchDialog's engine -> model -> effort cascade. */
export interface EngineModelInfo {
  value: string;
  display_name: string;
  description?: string;
  effort_levels?: string[];
  /** Preferred launch effort when this model is explicitly selected. Must be
   *  one of effort_levels when present (ADR-0035 F2, phase-16). */
  default_effort?: string;
}

/** Launch catalog for one engine, sent by the runner in its register
 *  payload so the dashboard can build the three-stage launch select before
 *  any wrapper process exists (ADR-0032 F4bc). */
export interface EngineCatalogEntry {
  id: EngineKind;
  models: EngineModelInfo[];
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

/** One option of an AskUserQuestion question (SDK AskUserQuestionInput,
 *  ADR-0027). `preview` is optional rich content for the option. */
export interface QuestionOption {
  label: string;
  description: string;
  preview?: string;
}

/** One AskUserQuestion question (SDK AskUserQuestionInput). 1..4 per
 *  request, each with 2..4 options; `multiSelect` allows several picks. */
export interface Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

/** state_change.ext.pending_question shape (ADR-0027). Question-side twin of
 *  {@link PendingPermissionExt}: the authoritative record carried on every
 *  state_change while waiting_question, so a question dialog survives any
 *  other envelope arriving in between. Mirrors the question_request envelope's
 *  payload (kept as initial-notification per ADR-0027 F3). */
export interface PendingQuestionExt {
  request_id: string;
  questions: Question[];
  ts: string;
}

/** Source of a launch-selectable value (model / effort) at wrapper start
 *  time (ADR-0032 F4bc addendum, phase-15). Explicit picks (launch / env /
 *  config) stay stamped after the SDK confirms the value — the field
 *  reports the value's origin, not the SDK's confirmation. Only "default"
 *  means the wrapper never received an explicit pick and is reporting the
 *  engine's own default. */
export type ModelSource = "launch" | "env" | "config" | "default";

/** state_change.ext.session_capabilities shape (ADR-0034 F1/F2). Advertised
 *  by the adapter from the first state_change onward (spawn-direct — the
 *  session_init events like Claude's SDKSystemMessage(init) or Codex's
 *  thread.started are NOT awaited, otherwise Codex's per-turn
 *  thread.started would delay capability visibility to the first turn).
 *  UI reads this alone for feature-availability decisions; the engine name
 *  (ext.engine) is display-only. Missing fields default to fail-closed
 *  ("not supported"). */
export interface SessionCapabilitiesExt {
  supports_attachments: boolean;
  supports_user_input_dialog: boolean;
  /** Optional constraint: dialog fires only in these permission modes /
   *  sandbox contexts. Absent / empty array = unconditional. */
  user_input_modes?: string[];
  /** Whether the active session supports changing model at a turn boundary.
   *  Absent / false = fail-closed unsupported (ADR-0035 F4, phase-16). */
  supports_model_switch?: boolean;
  /** Whether the active model supports changing reasoning effort at a turn
   *  boundary. Absent / false = fail-closed unsupported. */
  supports_effort_switch?: boolean;
  /** Whether the session accepts /new・/clear as first-class session-reset
   *  control (ADR-0036 F5, phase-17 17-2). Advertised true only when the
   *  wrapper/runner/server together provide the fresh-relaunch + completion
   *  handshake described in F2. Absent / false = fail-closed unsupported —
   *  the dashboard MUST NOT intercept typed exact commands, and the server
   *  MUST NOT relay the reset request. */
  supports_session_reset?: boolean;
  /** Which reset modes the session accepts when supports_session_reset is
   *  true (ADR-0036 F5, phase-17 17-2). Required and non-empty when
   *  supports_session_reset=true; a true+missing/empty combination is
   *  fail-closed as invalid advertisement. Omitted when supports=false. */
  session_reset_modes?: SessionResetMode[];
  /** Whether the active session exposes an authoritative context-window usage
   *  snapshot in `ext.context` (ADR-0040, phase-21). The three-state UI
   *  contract:
   *
   *  - **absent** — the wrapper predates this capability (rolling upgrade).
   *    UI hides the ctx row entirely; treating absent as "unsupported" would
   *    misinform operators on any older wrapper still on the fleet.
   *  - **explicit `false`** — the current adapter cannot produce a reliable
   *    exact snapshot. UI renders "未対応" so the operator stops waiting.
   *  - **explicit `true`** — the adapter will stamp `ext.context` when
   *    available. UI renders the meter when `ext.context` lands, and a
   *    "取得中" placeholder while it is still null.
   *
   *  Claude expects `true`: the SDK's `getContextUsage()` control_request
   *  is designed to return `totalTokens` / `maxTokens` / `percentage` at
   *  any point after the SDK's initialize control_response arrives.
   *  System-prompt + tools + MCP + memory-files should already consume
   *  context before turn 1, so an init-time call is expected to yield a
   *  non-zero snapshot — but this remains best-effort until confirmed by
   *  dogfood; failures are swallowed and the UI stays in "取得中".
   *
   *  Codex sets `false`: `turn.completed.usage.input_tokens` reports the
   *  per-turn prompt tokens only — it shrinks after compaction, excludes
   *  reasoning / output, and has no `max_tokens` companion, so it does not
   *  represent context accumulation. A reliable exact source in Codex
   *  requires upstream compaction telemetry that does not exist yet
   *  (ADR-0040). */
  supports_context_usage?: boolean;
}

/** Reset modes for /new・/clear (ADR-0036 F1/F3, phase-17 17-1). `new` keeps
 *  the display log and appends a session_boundary marker; `clear` resets
 *  the server-side AgentStates ring and broadcasts history_reset, then
 *  writes a boundary marker at the head. Neither deletes the underlying
 *  session file. */
export type SessionResetMode = "new" | "clear";

/** server -> dashboard transcript reset. Resume reconstruction preserves
 * structured inter-agent envelopes because SDK JSONL cannot replay them;
 * `/clear` sets this false for a complete display-projection reset. Legacy
 * servers may omit the flag, which clients interpret as true. */
export interface HistoryResetPayload {
  agent_id: string;
  preserve_inter_agent?: boolean;
}

/** Closed vocabulary of session-reset failure reasons (ADR-0036 F7,
 *  phase-17 17-1). Loud values only — no silent fallback to prompt or
 *  old-session resume. `session_reset_pending` covers duplicate reset
 *  requests as well as instruction/model switches attempted while a
 *  reset is in flight. */
export type SessionResetErrorReason =
  | "agent_busy"
  | "unsupported_session_reset"
  | "session_reset_pending"
  | "runner_unavailable"
  | "spawn_failed"
  | "rollback_failed"
  | "timeout";

/** Resolved launch/session-state snapshot used by D8 resume drift detection
 *  (ADR-0032 F4bc + ADR-0033 F4 addenda, phase-15). Same shape for both
 *  ext.resume_snapshot (the "last effective values" of the prior session,
 *  NOT the spawn-time values — mid-session operator switches via
 *  set_model / set_effort / set_permission_mode land here so an intended
 *  change is not warned as drift) and ext.effective (the values the host
 *  is enforcing this run). Any field may be absent when it was never set. */
export interface ResolvedSnapshotExt {
  model?: string;
  model_source?: ModelSource;
  effort?: string;
  effort_source?: ModelSource;
  permission_mode?: PermissionMode;
  sandbox?: PermissionAxesExt["sandbox"];
  network_access?: boolean;
}

/** One drifted field in a resume, comparing prev (resume_snapshot value)
 *  vs now (effective value). `unknown` on prev/now because different fields
 *  carry different value types (string / boolean / enum). */
export interface ResumeDriftEntry {
  field: keyof ResolvedSnapshotExt;
  prev: unknown;
  now: unknown;
}

/** state_change.ext.resume_drift shape: one entry per differing field
 *  between resume_snapshot and effective. Empty array = no drift observed,
 *  absent = not a resume launch (fresh spawn). */
export type ResumeDriftExt = ResumeDriftEntry[];

/** A failed model/effort switch. The requested value never becomes effective;
 *  rolled_back_to is the last-known-good value retained for the next turn
 *  (ADR-0035 F3, phase-16). */
export interface SwitchErrorExt {
  kind: "model" | "effort";
  requested: string;
  /** Machine-readable failure reason. Intentionally open for future
   *  adapter-specific loud-failure categories. Currently used:
   *  - `"turn_failed"` — mid-session model/effort switch rejected by SDK
   *    (ADR-0035 F3, phase-16).
   *  - `"persist_alias_unknown"` — persisted model alias (from spawn config,
   *    env, or resume snapshot) not present in the SDK's measured catalog at
   *    startup; the wrapper falls back to `default` (ADR-0037 F8, phase-18-7).
   *    `rolled_back_to === "default"` in this case; `requested` carries the
   *    dropped alias for operator visibility. */
  reason: string;
  rolled_back_to?: string;
}

/** Typed state_change extension fields. The index signature preserves v0's
 *  forward-compatible extension space while making established wire fields
 *  first-class to producers and consumers. */
export interface EnvelopeExt extends Record<string, unknown> {
  pending_model?: string;
  pending_effort?: string;
  effort_reset?: boolean;
  switch_error?: SwitchErrorExt;
  /** Set when the wrapper has exhausted its bounded retry for
   *  `supportedModels()` and no cached catalog is available yet
   *  (ADR-0037 F6, phase-18-6). `ext.models` still carries a valid floor
   *  default (BOOTSTRAP, ADR-0037 F1) — this flag signals "catalog fetch
   *  gave up", NOT "ext.models is broken". Client one-shot dedup on the
   *  flag's rising edge; the wrapper keeps derive-always semantics so a
   *  late-connecting operator also sees the degraded state. Cleared by
   *  `refresh_models` (phase-18-5), which resets the retry counter. */
  models_error?: boolean;
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
    | "question_request"
    | "log"
    | "result"
    | "attach_rejected"
    | "instruction_rejected"
    | "inter_agent_message"
    /** Manual refresh_models completion (ADR-0039 F9 v2, 藤 review D2a).
     *  payload = { request_id, ok, reason?, models_count? }. Wrapper emits
     *  after refreshCatalogFor() settles so AgentDetail can pair server
     *  ack + actual result and settle its loading spinner. */
    | "refresh_models_result";
  state: KaoiroState;
  payload: Record<string, unknown>;
  ext: EnvelopeExt;
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

/** runner -> server, once per (re)connection: declares how much the host
 *  trusts the server's persona catalog (ADR-0031) and the operator-selectable
 *  cwd allow-list (#22). capabilities lists the engine kinds the host can
 *  run (e.g. ["claude"]).
 *
 *  Persona trust policy is expressed by exactly one of the following, or none
 *  (accept-all). More than one being set is a fail-loud invalid register:
 *
 *  - `allowed_personas`: allowlist by id — only these ids are spawnable
 *  - `blocked_personas`: blocklist by id — every server-known id EXCEPT these
 *    is spawnable
 *  - `personas` (legacy, deprecated): interpreted as an allowlist by the
 *    `id` field only; `name` / `sprite_set` are ignored since the server SoT
 *    (ADR-0029) owns display metadata. Emits a deprecation warning at the
 *    server; scheduled for removal in the next major release. */
export interface RunnerRegister {
  version: "0";
  host_id: string;
  personas?: WirePersona[];
  allowed_personas?: string[];
  blocked_personas?: string[];
  cwd_allowlist: string[];
  /** Engine kinds this host can run (ADR-0032 F4a): "claude-code" /
   *  "codex". The legacy value "claude" is normalized to "claude-code"
   *  by the server for one release window (deprecation warn), then
   *  rejected. */
  capabilities?: string[];
  /** Launch catalog per engine (ADR-0032 F4bc): the models (and their
   *  effort levels) the dashboard offers in the engine -> model -> effort
   *  cascade of LaunchDialog. Sourced from each engine package's
   *  EngineCapability by the runner at register time. */
  engines?: EngineCatalogEntry[];
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
  /** Engine to launch (ADR-0032 F4a). Omitted = "claude-code" (the
   *  pre-engine-select default), so old servers keep working. */
  engine?: EngineKind;
  /** Launch-time model pick from the LaunchDialog cascade (ADR-0032
   *  F4bc), an EngineModelInfo.value. Omitted = engine default. */
  model?: string;
  /** Launch-time effort pick; one of the model's effort_levels.
   *  Omitted = model default. */
  effort?: string;
  /** Claude-only launch permission mode (ADR-0033 F4 追補, phase-15 D2).
   *  When present the runner relays this into the wrapper config so the
   *  session starts in this mode without waiting for the server's
   *  set_permission_mode push. Priority is "explicit spawn wins over the
   *  server-side store": the server records this into
   *  `KaoiroServer.PermissionModes` at spawn time so the persisted store
   *  matches the operator's latest intent. Restore paths (which do not
   *  pass through the LaunchDialog) omit this field and fall through to
   *  the persisted store value naturally. The Codex engine ignores it
   *  (its permission posture is launch-fixed via sandbox, ADR-0033 F3). */
  permission_mode?: PermissionMode;
  /** Codex-only launch permission: the OS sandbox axis (ADR-0033 F3;
   *  the approval axis is pinned to "never" and not selectable). The
   *  Claude engine ignores it (its permission posture is the mode,
   *  pushed after join per #58). Omitted = "workspace-write". */
  sandbox?: PermissionAxesExt["sandbox"];
  /** Codex-only: allow network inside a workspace-write sandbox.
   *  Omitted = false (Codex CLI default). */
  network_access?: boolean;
  /** Resume snapshot: the "last effective" resolved settings the server
   *  had cached for this agent (ADR-0014 F1 追補, phase-15 D8). Only
   *  present when resume_session_id is also set; the runner relays this
   *  into the wrapper config so ext.resume_snapshot / ext.resume_drift can
   *  ride the wrapper's first state_change. */
  resume_snapshot?: ResolvedSnapshotExt;
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

/** server -> runner, operator-only: switch a running agent to a different
 *  session_id under its bound cwd (ADR-0014, resume-swap). The runner keeps
 *  the SAME agent_id and cwd, retargets the resume pointer, and cycles the
 *  wrapper (kill -> relaunch) so the new session takes effect; the F4 local
 *  lock is transferred atomically from the old session_id to the new one.
 *  The wrapper channel's D5 reject-newcomer stays intact because the same
 *  agent_id relaunches only after the incumbent process has exited. */
export interface SwitchSessionMessage {
  version: "0";
  agent_id: string;
  resume_session_id: string;
}

/** Why a spawn failed (protocol.md). already_running = a live wrapper already
 *  owns the agent_id; cwd_not_found = the cwd is not in the host's allow-list;
 *  session_not_found = a resume/switch_session target failed the T3 existence
 *  check under the bound cwd; error = any other failure. */
export type SpawnFailReason =
  | "already_running"
  | "cwd_not_found"
  | "session_not_found"
  | "error";

/** runner -> server: the outcome of a spawn; reason is set only on failure. */
export interface SpawnResult {
  version: "0";
  host_id: string;
  agent_id: string;
  ok: boolean;
  reason?: SpawnFailReason;
}

/** operator -> server -> runner (Option E, ADR-0039): request a fresh probe
 *  of the engine's launch catalog (LaunchDialog "モデル一覧を再取得" button
 *  and cache-miss auto-refresh). host_id is derived from the topic; agent_id
 *  is intentionally absent — the catalog is per (host, engine), not per agent.
 *  The runner decides whether an actual probe runs by consulting its
 *  memory-only last-known-good cache: `force=true` bypasses the TTL check
 *  (button), `force=false`/omitted skips the probe if the cache entry is
 *  still fresh. On completion the runner emits an `EngineCatalogResult`
 *  addressed by `request_id`, and (on ok=true) re-registers the host so the
 *  usual `hosts` broadcast repaints LaunchDialog. */
export interface RefreshEngineCatalog {
  version: "0";
  /** Target engine. Currently only "claude-code" needs live probing —
   *  Codex advertises statically (ADR-0035 F1). */
  engine: EngineKind;
  /** Correlation id for the paired EngineCatalogResult. Client-allocated
   *  UUIDv4; the runner echoes it verbatim. */
  request_id: string;
  /** True to bypass the runner's TTL check (manual refresh button); false
   *  or omitted honours the cache. */
  force?: boolean;
}

/** Closed vocabulary of catalog-probe failure reasons (ADR-0039). */
export type EngineCatalogFailReason =
  | "auth_failed"
  | "spawn_failed"
  | "cli_error"
  | "invalid_output"
  | "timeout"
  | "unsupported_engine";

/** Closed vocabulary for a per-agent refresh_models completion (ADR-0039 F9
 *  v2, 藤 review turn-7 D2a). Superset-compatible with the shared probe
 *  failure vocabulary; `unsupported_engine` reuses the same string for
 *  non-Claude adapters that no-op the control. */
export type RefreshModelsFailReason = EngineCatalogFailReason;

/** Payload of a `type: "refresh_models_result"` envelope (ADR-0039 F9 v2 =
 *  藤 review D2a). `agent_id` lives on the enclosing envelope frame — this
 *  payload MUST NOT duplicate it (see wrapper/agent-common/src/state.ts
 *  makeRefreshModelsResult, which builds the envelope). Only correlation
 *  fields go here so state_change latest-tracking is not affected — the
 *  envelope is transient (server.wrapper_channel skips AgentStates.put for
 *  it, client protocol.ts special-dispatches it before onEnvelope). The
 *  refreshed catalog itself arrives on the paired `state_change.ext.models`
 *  emitted immediately BEFORE the result envelope. */
export interface RefreshModelsResultPayload {
  request_id: string;
  ok: boolean;
  reason?: RefreshModelsFailReason;
  /** Present on success; size-only signal for the toast. */
  models_count?: number;
}

/** Legacy alias retained so consumers referencing `RefreshModelsResult` in
 *  a "flat" client-shaped view (agent_id merged in) keep compiling; the
 *  wire payload uses `RefreshModelsResultPayload` only. */
export interface RefreshModelsResult {
  agent_id: string;
  request_id: string;
  ok: boolean;
  reason?: RefreshModelsFailReason;
  models_count?: number;
}

/** runner -> server -> operator (agents:lobby, operator-only): completion
 *  report for a RefreshEngineCatalog request (ADR-0039). Failure carries a
 *  closed-vocab `reason`. `models_count` on success is a size-only signal
 *  for the operator UI toast; the actual catalog reaches the client via the
 *  refreshed `hosts` broadcast triggered by the runner's re-register. */
export interface EngineCatalogResult {
  version: "0";
  host_id: string;
  engine: EngineKind;
  request_id: string;
  ok: boolean;
  reason?: EngineCatalogFailReason;
  models_count?: number;
}

/** server -> runner, operator-only: list the resume candidates under cwd for
 *  agent_id (ADR-0014 F2). `engine` scopes the listing to one engine's
 *  session store (ADR-0032 F8); omitted = "claude-code". */
export interface EnumerateSessions {
  version: "0";
  agent_id: string;
  cwd: string;
  engine?: EngineKind;
}

/** Minimal per-session metadata (T2: minimal, operator-only). mtime is the
 *  JSONL file's last-modified time; summary is optional and may be absent. */
export interface SessionMeta {
  session_id: string;
  summary?: string;
  mtime?: string;
}

/** runner -> server: the resume candidates under cwd (response to
 *  enumerate_sessions, ADR-0014 F2). Forwarded operator-only by the server.
 *  `engine` echoes the request's engine so a dashboard awaiting one
 *  engine's list ignores a stale reply for another. */
export interface RunnerSessions {
  version: "0";
  host_id: string;
  cwd: string;
  sessions: SessionMeta[];
  engine?: EngineKind;
}

// Session-reset control flow (ADR-0036 F7, phase-17 17-1). The four-hop
// SSOT: client -> server (SessionResetRequest), server -> runner
// (ResetSessionCommand), runner -> server (SessionResetResult), then
// server -> clients (SessionResetStarted / Completed / Failed). Every hop
// carries the same `request_id` so late `session_reset_result` messages
// and stale broadcasts can be discarded by generation on the receiver.

/** client -> server, operator-only (ADR-0036 F1, phase-17 17-1). Sent
 *  only when the dashboard trims the composer input to an exact
 *  `/new` or `/clear` with no attachments. The server validates
 *  operator role / live agent / capability / state / pending lock
 *  before relaying to the runner. */
export interface SessionResetRequest {
  agent_id: string;
  mode: SessionResetMode;
}

/** server -> runner, operator-only (ADR-0036 F2/F7, phase-17 17-1/17-5).
 *  Instructs the runner supervisor to kill the current wrapper for
 *  agent_id and fresh-relaunch (no resume_session_id) while re-applying
 *  the last-effective snapshot from phase-15 D8. `previous_session_id`
 *  is the SessionPointer's current session_id at lock-acquire time —
 *  supplied by the server so the runner's rollback branch can resume
 *  the RIGHT session (not a possibly-stale spawn-time value that has
 *  since been switched via `switch_session`). Absent when the pointer
 *  has no session_id yet (fresh spawn edge case).
 *
 *  `resume_snapshot` (ADR-0014 F1 追補「resume 時の privilege 三軸再適用」,
 *  phase-22): the server attaches the CURRENT `SessionPointers.snapshot`
 *  at lock-acquire time so the runner re-applies the last-effective
 *  privilege axes (sandbox / network_access / permission_mode) to the
 *  fresh wrapper. Absent when the pointer has no snapshot yet (pre-D8
 *  legacy or fresh agent), in which case the runner's apply helper is
 *  a no-op and the fresh wrapper falls to engine defaults. */
export interface ResetSessionCommand {
  version: "0";
  agent_id: string;
  mode: SessionResetMode;
  request_id: string;
  previous_session_id?: string;
  resume_snapshot?: ResolvedSnapshotExt;
}

/** runner -> server (ADR-0036 F7, phase-17 17-1/17-5). Report of a reset
 *  attempt's outcome. `ok=true` marks fresh-relaunch success (the
 *  server keeps the reset in `:awaiting_connect` until the fresh
 *  wrapper's channel join). `ok=false` requires a `reason` from the
 *  closed vocabulary. `to_session_id` is the session_id the runner
 *  already knows (rarely populated — Claude reports its ID via init
 *  in the wrapper's own state_change, Codex's thread ID is lazy), so
 *  the field is optional / nullable and the server prefers the value
 *  the wrapper itself reports at join time. */
export interface SessionResetResult {
  version: "0";
  host_id: string;
  agent_id: string;
  mode: SessionResetMode;
  request_id: string;
  ok: boolean;
  reason?: SessionResetErrorReason;
  to_session_id?: string | null;
}

/** server -> clients (ADR-0036 F7, phase-17 17-1). Fired once the server
 *  accepts a reset request, before the runner replies. The UI shows
 *  "starting a new session" and disables the composer until Completed
 *  or Failed lands. */
export interface SessionResetStarted {
  request_id: string;
  agent_id: string;
  mode: SessionResetMode;
  previous_session_id?: string;
}

/** server -> clients (ADR-0036 F7, phase-17 17-1). Fired once the runner
 *  reports a successful fresh relaunch. `to_session_id` is null when the
 *  new session ID has not been reported yet (Codex lazy採番); the
 *  matching boundary marker's `to_session_id` is patched later by the
 *  same request_id. */
export interface SessionResetCompleted {
  request_id: string;
  agent_id: string;
  mode: SessionResetMode;
  previous_session_id?: string;
  to_session_id: string | null;
}

/** server -> clients (ADR-0036 F7, phase-17 17-1). Fired on any reset
 *  failure. The reason names whether the rollback recovered the old
 *  session (`spawn_failed` / `timeout`) or not (`rollback_failed`). */
export interface SessionResetFailed {
  request_id: string;
  agent_id: string;
  mode: SessionResetMode;
  reason: SessionResetErrorReason;
}

/** session_boundary log-marker payload (ADR-0036 F3, phase-17 17-1).
 *  Appended to AgentStates on `new` (end of ring) and after a
 *  history_reset on `clear` (head of ring). `to_session_id` may be null
 *  when the fresh session's ID has not been reported yet; the same
 *  request_id lets the server patch it on the first ID report. */
export interface SessionBoundaryMarker {
  mode: SessionResetMode;
  request_id: string;
  ts: string;
  previous_session_id?: string;
  to_session_id?: string | null;
}
