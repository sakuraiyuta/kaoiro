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
 *  transcript (#31), system=session-level event the wrapper observed rather
 *  than anything either party said (context compaction, conversation reset —
 *  phase-28 A1 / #168). thinking is intentionally not relayed.
 *
 *  `system` is deliberately its own kind: relaying these as `assistant` would
 *  put wrapper-authored notices into the operator's "latest reply" timeline
 *  as though the model had said them. */
export type LogKind =
  | "assistant"
  | "tool_use"
  | "tool_result"
  | "user"
  | "system";

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
  /** SDK error termination subtype (issue #127). Set on error results only
   *  so the UI can differentiate max_turns / during_execution / max_budget /
   *  max_structured_output_retries. Wire-typed as a plain string here so
   *  this shared type stays SDK-agnostic; wrapper-side callers narrow to
   *  their ResultSubtype union. Absent on success. */
  error_subtype?: string;
  /** SDK error termination detail (issue #127): the free-form message the
   *  SDK returned alongside is_error (e.g. tool error text). Absent on
   *  success; may be omitted on error if the SDK provided no text. */
  error_detail?: string;
}

/** Coarse subagent/workflow lifecycle status (ADR-0019 F3). Distinct from
 *  the wider status enum the SDK's own `task_updated` message carries
 *  (pending/running/completed/failed/killed/paused) — #180 review (実測
 *  2026-08-09、SDK 0.3.220) confirmed `task_notification` is reliably
 *  emitted on every exercised termination path, so the wire-facing status
 *  stays limited to this 4-value set; a `killed` SDK-side intermediate
 *  always surfaces here as `stopped`. */
export type TaskStatus = "running" | "completed" | "failed" | "stopped";

/** One item in an agent's own todo list (issue #188, ADR-0049). The three
 * values mirror Claude Code's TodoWrite vocabulary. Codex has only a
 * completed boolean; its wrapper maps false to pending and true to
 * completed before constructing this wire value. */
export type TasklistItemStatus = "pending" | "in_progress" | "completed";

/** A single item in a tasklist's whole-list snapshot. */
export interface TasklistItem {
  text: string;
  status: TasklistItemStatus;
}

/** Summary of source items omitted from a bounded tasklist snapshot. The
 * completed count keeps the dashboard's aggregate progress truthful even
 * when the detail view can show only the first items. */
export interface TasklistOmitted {
  count: number;
  completed: number;
}

/** payload of a type="task" envelope (ADR-0047 F1-F4, issue #180).
 *  `kind` distinguishes lifecycle events sharing this one type (ADR-0047
 *  F1); `agent_id`/`task_id`/`task_type`/`status` are required on every
 *  kind (F2); the rest are optional progress meta present only when the
 *  originating SDK message carried them (F3). `task_type` is an open,
 *  extensible string (F4, initial values `subagent` | `workflow`) — the
 *  real SDK (0.3.220) emits its OWN internal vocabulary
 *  (`local_agent` / `local_workflow` / `local_bash` and possibly others,
 *  not verbatim `subagent`/`workflow`), relayed through unmodified per
 *  F4's "受信側は未知値を汎用表示へフォールバック" design — no renaming
 *  layer exists here. Deliberately excludes two SDK fields outside this
 *  enumerated set (host has them, does not wire them):
 *  `task_started.prompt` (the subagent's full instructions,
 *  content-bearing) and `task_notification.output_file` (a local
 *  filesystem path). */
export interface TaskPayload {
  kind: "started" | "updated" | "completed";
  agent_id: string;
  task_id: string;
  task_type: string;
  status: TaskStatus;
  subagent_type?: string;
  workflow_name?: string;
  description?: string;
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
  last_tool_name?: string;
  summary?: string;
  skip_transcript?: boolean;
  /** Present only for task_type="tasklist". Each update replaces the whole
   * list; an empty array is an intentional empty todo list. */
  items?: TasklistItem[];
  /** Present only when wrapper-side tasklist bounding omitted source items. */
  omitted?: TasklistOmitted;
}

/** Wire-safe subset of Persona used in every network-facing type
 *  (Envelope, RunnerRegister, SpawnMessage, and any future wire shape). */
export interface WirePersona {
  id: string;
  name: string;
  sprite_set: string;
}

/** Flat build identity reported by a connected wrapper after channel join. */
export interface WrapperBuildInfoPayload {
  build_revision: string;
  build_dirty: boolean;
  build_version: string;
  build_channel: "dev" | "release";
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
  /** Initial `display_name` (ADR-0050 D1, issue #219 D19/D20). Set by the
   *  server at spawn/restore time — the spawn custom name if the operator
   *  gave one, else `persona.name`'s value at that moment (created-time
   *  persistence: the wrapper's own copy never re-derives from `persona`
   *  again, so a later pack rename cannot silently change it). */
  display_name: string;
  server_url: string;
  /** Wrapper auth token, paired with agent_id on the server (ADR-0011). */
  server_token?: string;
  /** permission_request no-response window before the default deny
   *  (ADR-0011 / ADR-0022; defaults to no timeout = wait until the
   *  operator decides, matching the SDK's canUseTool behaviour). A
   *  finite value opts into fail-closed deny after that many ms. */
  permission_timeout_ms?: number;
  /** Optional soft work-budget denominator as a percentage of the SDK's
   * authoritative context window. The Claude adapter defaults this to 60
   * when absent, then derives the actual token denominator from each
   * `getContextUsage().maxTokens` reading. Keeping the configured value as a
   * ratio, rather than a fixed token count, gives 1M- and 200k-token models
   * the same "natural break" semantics (issue #264). */
  context_work_budget_percent?: number;
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
  /** Codex / Antigravity sandbox axis (ADR-0033 F3, ADR-0057 F4c); Claude
   *  ignores it. Omitted = "workspace-write". */
  sandbox?: PermissionAxesExt["sandbox"];
  /** Codex / Antigravity network toggle for workspace-write sandboxes. */
  network_access?: boolean;
  /** Antigravity-only launch approval axis (ADR-0057 F4c); Codex and
   *  Claude ignore it (Codex's approval is launch-fixed to "never" via
   *  `sandbox` alone, ADR-0033 F3). "on-failure" is rejected by the server
   *  / runner at spawn even though the type admits it (wire compatibility
   *  with the shared `PermissionAxesExt["approval"]` enum). Omitted =
   *  "on-request". */
  approval?: PermissionAxesExt["approval"];
  /** Resume snapshot relayed by the runner on a resume launch only
   *  (ADR-0014 F1 追補, phase-15 D8). Absent on fresh spawn. When present,
   *  the wrapper stamps it as ext.resume_snapshot and computes ext.resume_drift
   *  against the values it is enforcing this run. */
  resume_snapshot?: ResolvedSnapshotExt;
  /** Session-transition correlation id relayed from the spawn / restore /
   *  reset command that launched this wrapper (phase-27, #160). The wrapper
   *  echoes it verbatim in its channel join params so the server can tell
   *  "the connection this transition produced" from any other join — a
   *  session_id cannot, because a same-session resume reuses the old one.
   *  Absent on a legacy runner, in which case the server declines to
   *  activate the pending transition and omits the affected activity
   *  metadata; spawn / restore themselves are unaffected. */
  transition_id?: string;
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

/** Engine kinds a host can run (ADR-0032 F4a, ADR-0057 F1). The value set of
 *  the runner register `capabilities`, `SpawnMessage.engine`, and
 *  `ext.engine`. */
export type EngineKind = "claude-code" | "codex" | "antigravity";

/** ext.permission — the agent's current permission posture as the
 *  engine-neutral two-axis form (ADR-0033 F1). Claude adapters derive it
 *  from permissionMode via a display-approximation table (ADR-0033 F2);
 *  the codex adapter projects its launch-fixed sandbox with approval
 *  pinned to "never" (ADR-0033 F3); the antigravity adapter reports both
 *  axes as operator-selected at spawn (ADR-0057 F4c). Successor of
 *  `ext.permission_mode` (kept in parallel for one release window, then
 *  removed). */
export interface PermissionAxesExt {
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  /** `on-failure` is a deprecated upstream alias of `on-request`; kaoiro
   *  wrappers never emit it but the enum keeps wire compatibility with
   *  the Codex SDK vocabulary. */
  approval: "untrusted" | "on-request" | "on-failure" | "never";
  /** How the sandbox axis is actually enforced (ADR-0057 F4/F4c). Every
   *  engine fills this so the dashboard never branches on its absence:
   *  `"os"` for Codex (OS sandbox), `"mode"` for Claude (the sandbox value
   *  is a projection of permissionMode, ADR-0033 F2), `"advisory"` for
   *  Antigravity — its `--sandbox` flag was measured to have no effect, so
   *  the wrapper enforces the cell by inspecting tool arguments, never by
   *  the OS. Only `"advisory"` renders a permanent badge next to the
   *  sandbox value, reusing ADR-0033 F4 addendum's device for Codex's
   *  host-fixed approval. */
  enforcement?: "os" | "mode" | "advisory";
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
  /** Canonical wire model ID this entry resolves to, mirrored from the
   *  upstream ModelInfo.resolvedModel (e.g. the concrete id an alias like
   *  `default` maps to). Read-only metadata; absent = unknown. */
  resolved_model?: string;
}

/** Launch catalog for one engine, sent by the runner in its register
 *  payload so the dashboard can build the three-stage launch select before
 *  any wrapper process exists (ADR-0032 F4bc). */
export interface EngineCatalogEntry {
  id: EngineKind;
  models: EngineModelInfo[];
  /** Launch-time permission axes this engine offers as operator-selectable
   *  LaunchDialog controls, pre-spawn (ADR-0033 F3, ADR-0057 F4c) — declared
   *  here so the dashboard reads a value instead of inferring capability
   *  from `id` (ADR-0034 F3, round 2 SF-R2-4). Absent = a pre-metadata
   *  runner; callers fall back to their own engine-name allowlist. */
  launch_permission_axes?: {
    /** sandbox (read-only/workspace-write/danger-full-access) picker, plus
     *  the workspace-write network_access toggle. */
    sandbox: boolean;
    /** approval (untrusted/on-request/never) picker. */
    approval: boolean;
  };
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

/** Engine-neutral attachment category. The initial closed vocabulary is
 * image only; adapters map it to their SDK representation internally. */
export type AttachmentType = "image";

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
  /** Optional attachment type restriction. Absent preserves the original
   * supports_attachments=true meaning (all protocol-supported types). When
   * present, only listed types are accepted. */
  attachment_types?: AttachmentType[];
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

/** Reset modes for /new・/clear (ADR-0036 F3 復元, 2026-07-24). `new` keeps
 *  the display log and appends a session_boundary marker at the end;
 *  `clear` narrows the agent's AgentStates history down to a single
 *  boundary marker and records a ClearWatermark. **Neither broadcasts
 *  `history_reset`** — that event is resume-replay only. Neither deletes
 *  the underlying session file either. */
export type SessionResetMode = "new" | "clear";

/** server -> dashboard transcript reset, sent ONLY when a resuming wrapper
 * rebuilds its display history from the SDK JSONL. Structured inter-agent
 * envelopes cannot be replayed from that JSONL, so they are preserved and
 * the flag is always true on this path; legacy servers may omit it, which
 * clients also read as true. `/clear` does not use this event (see
 * {@link SessionResetMode}). */
export interface HistoryResetPayload {
  agent_id: string;
  preserve_inter_agent?: boolean;
  /** Pairs the reset with the `history_replay_complete` that closes the
   *  replay window (#125). The wrapper allocates it and sends it on its own
   *  `history_reset` push; the server echoes it into this broadcast when
   *  present. Absent keeps the pre-#125 wire shape readable. */
  replay_id?: string;
}

/** Closed vocabulary of session-reset failure reasons (ADR-0036 F7,
 *  phase-17 17-1). Loud values only — no silent fallback to prompt or
 *  old-session resume. `session_reset_pending` covers duplicate reset
 *  requests as well as instruction/model switches attempted while a
 *  reset is in flight. */
/** Who initiated a session reset (protocol.md, ADR-0043 D1). Added with the
 *  agent-initiated path; `operator` covers every pre-existing reset. */
export type SessionResetOrigin = "operator" | "agent_self";

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
  /** Codex-only ACTUAL network state this run enforces — distinct from
   *  `WrapperConfig.network_access` (the raw configured toggle, meaningful
   *  only for the `workspace-write` sandbox). Sandbox-aware: always `true`
   *  for `danger-full-access` (network is included in full access) and
   *  always `false` for `read-only`, regardless of the toggle (ADR-0033
   *  F3 追補, phase-22 dogfood 藤 audit). Claude ignores this field. */
  network_access?: boolean;
  /** Antigravity-only approval axis (ADR-0057 F4c). Stage A fixes both
   *  sandbox and approval at spawn (mid-session change is Stage B0), so
   *  the resume snapshot must carry approval too, not sandbox alone.
   *  Claude / Codex ignore this field. "on-failure" is a stale/invalid
   *  value the runner falls back from (see resume_snapshot.ts). */
  approval?: PermissionAxesExt["approval"];
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

/** Work-budget projection paired with the authoritative SDK context reading
 * in `ext.context` (issue #264). `work_budget_tokens` is the soft,
 * model-window-relative denominator; `work_budget_percentage` is the current
 * used-token share of that denominator and may exceed 100 after the soft
 * budget has been crossed. This is an extension of an already versioned
 * {@link Envelope}, never a standalone unversioned message (ADR-0015). */
export interface ContextBudgetExt {
  work_budget_tokens: number;
  work_budget_percentage: number;
}

/** Typed state_change extension fields. The index signature preserves v0's
 *  forward-compatible extension space while making established wire fields
 *  first-class to producers and consumers. */
export interface EnvelopeExt extends Record<string, unknown> {
  context_budget?: ContextBudgetExt;
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
 * Common event envelope v0 (protocol.md) — **the shape a wrapper emits**.
 * The type enum fixes state_change / permission_request (ADR-0010/0011),
 * log / result (ADR-0012), and attach_rejected / instruction_rejected
 * (ADR-0025). payload stays loosely typed; the per-type shapes are
 * LogPayload / ResultPayload / Attach*Payload above.
 *
 * This is deliberately the PRODUCER type: `ServerLink.send`, the adapter
 * sinks, and the permission / question / inter-agent brokers all take it,
 * so every member of the union is something a wrapper is allowed to send.
 * Server-authored envelopes that ride the same channel event live in
 * {@link OperatorEnvelope} instead — widening this union would let an
 * adapter emit them and still typecheck.
 */
export interface Envelope {
  version: "0";
  agent_id: string;
  /** SDK conversation session id (protocol.md / ADR-0014; one agent_id : N
   *  session_id). Stamped by ServerLink at send time alongside seq; absent
   *  until the SDK reports one, and on envelopes that never go to a server. */
  session_id?: string;
  persona: WirePersona;
  /** Mutable instance-scoped display name (ADR-0050 D1 `Principal.
   *  display_name`, issue #219 D19/D23). `persona.name` above is the
   *  pack's canonical name and never changes for the session (ADR-0029
   *  F9, ADR-0030 D2); THIS is what an operator rename / spawn custom
   *  name actually mutates. Defaults to `persona.name` at spawn
   *  (created-time persistence, D20) and stays independent of it
   *  thereafter — a pack rename never changes an already-spawned
   *  agent's `display_name`. */
  display_name: string;
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
    | "refresh_models_result"
    /** subagent/workflow task lifecycle (issue #180, ADR-0019 F2 / ADR-0047
     *  F1). payload.kind = "started" | "updated" | "completed"; payload
     *  carries the ADR-0047 F2 required fields (agent_id/task_id/task_type/
     *  status) plus F3's optional progress meta. `agent_id` here is the
     *  PARENT (the wrapper's own agent_id, same as the envelope frame's own
     *  `agent_id` — ADR-0047 F2 keeps it in payload too so the field is
     *  self-contained for server aggregation/snapshot, which handles task
     *  envelopes independently of the outer frame). Reserved as a
     *  予約-status protocol row since ADR-0019; this is the first producer. */
    | "task";
  state: KaoiroState;
  payload: Record<string, unknown>;
  ext: EnvelopeExt;
}

/** The `session_boundary` marker envelope (ADR-0036 F3, phase-17 17-7).
 *  **Built and broadcast by the server** (`SessionResets` composes it and
 *  `AgentStates` appends it to the history ring), never by a wrapper — but
 *  it rides the same `envelope` channel event, so anything reading the wire
 *  must handle it. Kept out of {@link Envelope} so an adapter cannot emit
 *  one and still typecheck. */
export type SessionBoundaryEnvelope = Omit<Envelope, "type" | "payload"> & {
  type: "session_boundary";
  payload: SessionBoundaryMarker;
};

/** Every envelope shape an **operator** receives on `agents:lobby`: what the
 *  wrappers emit, plus the server-authored markers. Consumers that narrow on
 *  `type` should read this; producers keep taking {@link Envelope}.
 *
 *  Deliberately NOT "whatever a client receives" — the viewer projection
 *  (ADR-0021) is a different, narrower shape that these types do not model:
 *  `ext` is stripped from every type, `permission_request` is replaced by a
 *  synthetic `state_change`, and `session_boundary.payload` is sanitized
 *  down to `{ mode }` alone. Model that separately if a consumer ever needs
 *  it; do not read this union as covering it. */
export type OperatorEnvelope = Envelope | SessionBoundaryEnvelope;

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

/** Peer-unresponsive-error attachment on an inter_agent_message (issue #131).
 *  `code` is an intentionally open string — the initial vocabulary is
 *  `rate_limit` / `context_overflow` / `api_error` / `timeout` /
 *  `interrupted` / `disconnected`; a classifier that cannot map its input to
 *  one of these degrades to `api_error`. `message` is a human-readable,
 *  secret-masked, length-clipped reason so the receiving agent can decide
 *  whether to retry, wait, or escalate to the operator. */
export interface InterAgentErrorPayload {
  code: string;
  message: string;
}

/** payload of a type="inter_agent_message" envelope (protocol-inter-agent
 *  spec). The sender lives in the surrounding envelope's `agent_id`; `to`
 *  is the destination agent_id used by the server for routing. `meta.done`
 *  must be true from both owner-side agents for the conversation to
 *  complete; `meta.reject_reason` is required when `kind === "reject"`.
 *  `error` (issue #131) marks this envelope as a peer-unresponsive-error
 *  notice rather than an ordinary message: `kind` stays `"inform"` (no new
 *  enum value, so older receivers degrade gracefully) and `body` repeats the
 *  human-readable reason for clients that only render `body`. `meta.done` is
 *  always `false` on an error notice — ending the conversation is left to
 *  the receiving agent's judgement.
 *  `new_conversation` (issue #262) is true only when the CALLING agent's
 *  `send_to_agent` omitted `conversation_id` and this wrapper allocated a
 *  fresh one — the one case where the server has never seen this id and
 *  that is expected. Every other envelope this wrapper builds (a reply
 *  within a conversation it already knows, a peer-error / stale_turn
 *  notice) carries an id the server already tracks, so those set it
 *  false. The server rejects an explicit-but-unknown id (`false` and no
 *  entry exists) as `unknown_conversation_id` instead of silently opening
 *  a fresh, context-less thread under a mistyped or stale id. */
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
  error?: InterAgentErrorPayload;
  new_conversation: boolean;
}

/** Context usage as it reaches a peer through `directory_request`. The server
 * only projects this when the reporting wrapper advertised
 * `supports_context_usage: true`; an engine without the capability omits the
 * field entirely rather than sending a null or an estimate (ADR-0040). */
export interface DirectoryContext {
  used_tokens: number;
  max_tokens: number;
  used_percentage: number;
}

/** One rate-limit window as it reaches a peer through `directory_request`.
 * Every field is optional because the engine reports what it knows; a window
 * with none of them is dropped rather than sent empty. The snapshot is from
 * the peer's last turn and is not refreshed while it idles — read `resets_at`
 * against the current time and stop trusting `utilization` / `status` once it
 * has passed. */
export interface DirectoryRateLimitWindow {
  status?: string;
  utilization?: number;
  resets_at?: number;
}

/** Active inter-agent conversation state of a peer. A current server always
 * includes this (`{active: false, peers: []}` when idle); absence means the
 * server predates the feature, not that there is no conversation. */
export interface DirectoryConversation {
  /** The server keeps `conversation_id` private; peers are enough to show
   * the active relationship without making it a send target. */
  active: boolean;
  peers: string[];
}

/** Recipient-local dispatch confirmation watermark. It is an observation
 * ledger, not a retransmission guarantee; absence is unknown, never zero. */
export interface InterAgentDeliveryStatus {
  issued_seq: number;
  acked_seq: number;
  pending_since?: string;
}

/** One agent in the `directory_request` response. Runtime traits are optional
 * because an old or not-yet-initialized wrapper may not have stamped them.
 * Omitted situational fields mean unknown, never zero or fine. */
export interface DirectoryEntry {
  agent_id: string;
  persona: { id?: string; name?: string; sprite_set?: string };
  /** Mutable, instance-scoped name; persona metadata remains the canonical
   * pack identity. */
  display_name?: string;
  state: string;
  engine?: string;
  model?: string;
  effort?: string;
  context?: DirectoryContext;
  /** ISO8601 UTC time the server observed the session start. */
  session_started_at?: string;
  /** Reply round-trips counted in the current session. */
  turns?: number;
  /** ISO8601 UTC time the server last accepted an envelope from this peer. */
  last_activity_at?: string;
  conversation?: DirectoryConversation;
  rate_limits?: Record<string, DirectoryRateLimitWindow>;
  inter_agent_delivery?: InterAgentDeliveryStatus;
  /** Present only for a persistent entry with no live envelope; absence
   * means live, rather than unknown. It cannot receive `send_to_agent`. */
  directory_only?: true;
  /** Server-observed timestamp, available only for `directory_only` entries. */
  last_seen?: string;
}

export type UserRole = "operator" | "viewer" | "admin";

/** One user in the `directory_request` response. Users and agents remain
 * separate arrays because users are not `send_to_agent` destinations. */
export interface UserDirectoryEntry {
  id: string;
  kind: "user";
  display_name: string;
  role: UserRole;
}

/** `directory_request` response. `agents` and `users` are intentionally
 * separate arrays so callers cannot mistake a user for an agent destination. */
export interface DirectoryResult {
  agents: DirectoryEntry[];
  users: UserDirectoryEntry[];
}

// Runner control messages (protocol.md "runner 制御メッセージ", #66 / ADR-0023).
// A resident runner connects on topic `runner:<host_id>`, a separate system
// from the wrapper data path. `version` is the flat outer key (ADR-0015), "0"
// for now. The spawn/stop/restart/enumerate and sessions/spawn_result shapes
// are added with the phases that consume them.
//
// `version` on the opaque-relay messages
// --------------------------------------
// Most of these the server or the runner BUILDS, so they stamp `version`
// themselves. Four do not — StopMessage, RestartMessage, EnumerateSessions,
// RefreshEngineCatalog originate at a client, and the server forwards the
// payload after stripping `host_id`. For those the server's
// `relay_to_runner/4` normalizes `version` to "0" on the way out (warning
// first when the client declared anything else, absent included), so
// `version` is required here for every runner-bound message alike.
//
// ADR-0015's receiver rule is now enforced on both hops: the dashboard
// stamps these payloads (#182), the server warns on any non-"0" it relays,
// and the runner re-checks every message it receives before handing it to
// the supervisor (#181). RestartMessage is the one shape the bundled
// dashboard never sends — the server still accepts it for other clients, and
// an unstamped one warns like any other.

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
  /** Engine kinds this host can run (ADR-0032 F4a, ADR-0057 F1):
   *  "claude-code" / "codex" / "antigravity". The legacy value "claude"
   *  is normalized to "claude-code" by the server for one release window
   *  (deprecation warn), then rejected. */
  capabilities?: string[];
  /** Launch catalog per engine (ADR-0032 F4bc): the models (and their
   *  effort levels) the dashboard offers in the engine -> model -> effort
   *  cascade of LaunchDialog. Sourced from each engine package's
   *  EngineCapability by the runner at register time. */
  engines?: EngineCatalogEntry[];
  /** Build identity (issue #228) — distinct from `version` above, which is
   *  the ADR-0015 WIRE PROTOCOL version (message-shape compatibility).
   *  `build_revision` is the full 40-char git SHA the running runner
   *  artifact was built from ("unknown" when undeterminable), and
   *  `build_dirty` whether that build had uncommitted changes (tracked OR
   *  untracked). Absent = a runner build predating issue #228. Observability
   *  only: a mismatch against the server's own build revision is
   *  surfaced to the operator (dashboard), never used to reject the
   *  connection — docs-only commits, backports, and rolling deploy
   *  windows all make a legitimate SHA mismatch, and `version` above
   *  already carries the actual compatibility contract. */
  build_revision?: string;
  build_dirty?: boolean;
  /** CalVer project version and derived build channel (issue #288). Both
   *  are optional as a pair for pre-#288 runner compatibility. */
  build_version?: string;
  build_channel?: "dev" | "release";
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
  /** Initial `display_name` (ADR-0050 D1, issue #219 D19/D20/MF-1). The
   *  operator's spawn custom name, or `persona.name`'s value at record
   *  time when none was given. Optional on the wire for compatibility
   *  with a server that predates this field — the runner falls back to
   *  `persona.name` for the one-time migration when it is absent
   *  (`resolveWrapperConfig`); `WrapperConfig.display_name` itself stays
   *  required. */
  display_name?: string;
  cwd: string;
  server_url?: string;
  token?: string;
  initial_prompt?: string;
  resume_session_id?: string;
  /** Engine to launch (ADR-0032 F4a, ADR-0057 F1). Omitted = "claude-code"
   *  (the pre-engine-select default), so old servers keep working. */
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
  /** Codex / Antigravity launch permission: the sandbox axis (ADR-0033 F3,
   *  ADR-0057 F4c). On Codex the approval axis is pinned to "never" and
   *  not selectable; on Antigravity `approval` below is a separate,
   *  operator-selectable field. The Claude engine ignores this (its
   *  permission posture is the mode, pushed after join per #58). Omitted
   *  = "workspace-write". */
  sandbox?: PermissionAxesExt["sandbox"];
  /** Codex / Antigravity: allow network inside a workspace-write sandbox.
   *  Omitted = false. */
  network_access?: boolean;
  /** Antigravity-only launch approval axis (ADR-0057 F4c). Stage A fixes
   *  both sandbox and approval at spawn; mid-session change is Stage B0.
   *  Codex and Claude ignore this field. LaunchDialog offers three values
   *  for this engine; the server rejects "on-failure" even though the
   *  type admits it (wire compatibility with the shared
   *  `PermissionAxesExt["approval"]` enum). Omitted = "on-request". */
  approval?: PermissionAxesExt["approval"];
  /** Resume snapshot: the "last effective" resolved settings the server
   *  had cached for this agent (ADR-0014 F1 追補, phase-15 D8). Present
   *  either alongside `resume_session_id` (restore an existing SDK session
   *  and re-apply its snapshot) OR alongside `apply_resume_snapshot: true`
   *  (fresh-restore, phase-25: `/clear`/未発話で session_id が失われた
   *  agent を snapshot だけで同設定復元する). The runner relays this into
   *  the wrapper config so ext.resume_snapshot / ext.resume_drift can ride
   *  the wrapper's first state_change. */
  resume_snapshot?: ResolvedSnapshotExt;
  /** Fresh-restore flag (phase-25, ADR-0030 D8 / ADR-0014 F1 追補).
   *  Set to `true` on a spawn WITHOUT `resume_session_id` to request that
   *  the runner apply the accompanying `resume_snapshot` as if this were
   *  a resume operation — snapshot becomes SSOT for the engine-relevant
   *  privilege axes (5-case pair rule included). Absent / false = the
   *  ordinary fresh-spawn no-apply semantics from ADR-0014 F1 追補
   *  (藤 D1). Ignored (paired with resume_session_id) if both are set;
   *  the resume path already runs applyResumeSnapshot. */
  apply_resume_snapshot?: boolean;
  /** Session-transition correlation id, server-allocated per spawn
   *  (phase-27, #160). Mirrors the four-hop `request_id` discipline the
   *  session-reset flow already uses (ADR-0036 F7): the runner relays it
   *  into the wrapper config as `transition_id` and echoes it back on
   *  `SpawnResult`, so a late result and a join from an unrelated
   *  connection can both be discarded by CAS. Absent = legacy server;
   *  the runner passes nothing along and the spawn behaves as before. */
  request_id?: string;
}

/** server -> runner, operator-only: stop the wrapper for agent_id. */
export interface StopMessage {
  /** Stamped by the dashboard and re-normalized by the server's relay — see
   *  "version on the opaque-relay messages" above. */
  version: "0";
  agent_id: string;
}

/** server -> runner, operator-only: restart the wrapper for agent_id. */
export interface RestartMessage {
  /** The one relay shape the bundled dashboard never sends — see "version on
   *  the opaque-relay messages" above. Another client's restart is normalized
   *  to "0" by the server's relay, and an unstamped one warns like any other,
   *  so this is the relay path where the absent-version warning actually
   *  fires today. */
  version: "0";
  agent_id: string;
  /** Planned-disconnect correlation id (issue #266). New servers allocate
   *  it for each restart; new runners replace the entry's prior request id
   *  before relaunch so the wrapper echoes it as join `transition_id`.
   *  Optional for runner-first rolling deployment against an old server. */
  request_id?: string;
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
  /** The agent's CURRENT `SessionPointers.snapshot`, attached by the server
   *  on a live switch (ADR-0014 F1 追補, phase-15 D8). Without it the
   *  relaunched wrapper would fall back to its original spawn-time snapshot
   *  and stamp a stale `ext.resume_snapshot` / `ext.resume_drift`. Absent
   *  when the pointer holds no snapshot yet, in which case the runner's
   *  apply helper is a no-op. */
  resume_snapshot?: ResolvedSnapshotExt;
  /** Session-transition correlation id, same semantics as
   *  {@link SpawnMessage.request_id} (phase-27, #160). A live switch
   *  reuses the SDK session id, so this is the only way to tell the
   *  connection this switch produced from the outgoing one. */
  request_id?: string;
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
  /** Verbatim echo of {@link SpawnMessage.request_id} /
   *  {@link SwitchSessionMessage.request_id} (phase-27, #160). The server
   *  aborts a pending transition only when this matches the one it is
   *  holding, so a result that arrives after the transition was superseded
   *  or garbage-collected cannot tear down its successor. Absent = legacy
   *  runner (or a spawn the server issued without one); the server discards
   *  the correlation silently rather than acting on it. */
  request_id?: string;
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
  /** Stamped by the dashboard and re-normalized by the server's relay — see
   *  "version on the opaque-relay messages" above. */
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

/** server -> runner, operator-only: list the resume candidates under cwd
 *  (ADR-0014 F2). `engine` scopes the listing to one engine's session store
 *  (ADR-0032 F8, ADR-0057 F1); omitted = "claude-code".
 *
 *  This models what the RUNNER receives, which is not what the client sent:
 *  the server strips `host_id` and, when `cwd` was omitted, resolves it from
 *  SessionPointers via `agent_id` and puts it on the payload. So `cwd` is
 *  always present by the time it reaches the runner, while `agent_id`
 *  survives only on the detail-view path (the LaunchDialog path never sends
 *  one). The client must supply at least one of the two — sending both is
 *  accepted, and an explicit `cwd` simply wins. */
export interface EnumerateSessions {
  /** Stamped by the dashboard and re-normalized by the server's relay — see
   *  "version on the opaque-relay messages" above. */
  version: "0";
  /** Present when the operator opened the listing from an agent's detail
   *  view; absent on the LaunchDialog path. */
  agent_id?: string;
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
  /** Who asked (protocol.md / ADR-0043 D1). `agent_self` is the agent's own
   *  broker-approved `request_session_reset`; `operator` is the Composer's
   *  `/new` / `/clear`. Operator-only disclosure — this broadcast is role
   *  gated (ADR-0021), so viewers never see either this or `reason`. */
  origin: SessionResetOrigin;
  previous_session_id?: string;
  /** Present only on `agent_self`, and only when the agent supplied one:
   *  the sentence it gave the operator in the approval dialog. Never echoed
   *  back into any engine input. */
  reason?: string;
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
