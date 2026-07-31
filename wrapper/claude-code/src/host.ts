// Agent host — runs a query() session, derives state from its message stream,
// and routes tool-permission requests through canUseTool so they surface as
// waiting_permission. Streaming input (send) and interrupt are wired here.
// Authentication is inherited from the local Claude Code runtime; no API key is
// required or handled here.

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  EffortLevel,
  HookInput,
  ModelInfo,
  Options,
  PermissionResult,
  Query,
  SDKRateLimitInfo,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AdapterEvent,
  AttachRejectedPayload,
  EffectiveStatusSnapshot,
  Envelope,
  InstructionRejectedPayload,
  KaoiroState,
  LogEntry,
  ModelSource,
  PendingPermissionExt,
  PendingQuestionExt,
  PermissionMode,
  Question,
  ResolvedSnapshotExt,
  ResultPayload,
  SwitchErrorExt,
  WrapperConfig,
  WhoamiSnapshot,
} from "@kaoiro/agent-common";
import type {
  EngineAdapter,
  MachineState,
  PermissionDecision,
  QuestionDecision,
} from "@kaoiro/agent-common";
import {
  initialMachineState,
  effectiveStatusEnvelopeFields,
  effectiveStatusWhoamiFields,
  makeAttachRejected,
  makeInstructionRejected,
  makeLog,
  makeResult,
  makeStateChange,
  stepState,
} from "@kaoiro/agent-common";
import {
  cwdChangedHookToCwd,
  sdkMessageToCompactNotice,
  sdkMessageToCost,
  sdkMessageToEvents,
  sdkMessageToInitMeta,
  sdkMessageToLogs,
  sdkMessageToRateLimit,
  sdkMessageToResult,
  sdkMessageToResultMeta,
  sdkMessageToSessionId,
  sdkMessageToStatusMeta,
  sdkMessageToTerminalReason,
} from "./adapter.js";
import {
  clipText,
  computeResumeDrift,
  logEntryToPayload,
} from "@kaoiro/agent-common";
import type { RefreshModelsFailReason } from "@kaoiro/protocol";
import { PERMISSION_MODE_AXES } from "./permission_axes.js";
import { claudeBootstrapCatalog, type SupportedModel } from "./catalog.js";
import { runClaudeProbe, type ProbeOutcome } from "./probe-client.js";
import type { ContentBlock, PendingUpload, UploadMeta } from "./upload.js";
import {
  MAX_ATTACHMENTS_PER_INSTRUCTION,
  MAX_INFLIGHT_UPLOADS,
  PENDING_UPLOAD_GC_INTERVAL_MS,
  PENDING_UPLOAD_TTL_MS,
  PROTOCOL_FILE_SIZE_LIMIT_BYTES,
  TOTAL_REQUEST_BYTE_LIMIT,
  assembleBytes,
  blockWireSize,
  parseChunkPayload,
  renderAttachmentBlock,
  validateClose,
  validateOpen,
} from "./upload.js";

/** Cap on queued user turns; send() throws beyond this (fail fast). */
const MAX_QUEUED_TURNS = 1000;

/** Total supportedModels() attempts before the host stays silent per session
 *  (ADR-0037 F6). Counts the init-time fetch as trial 1 and each subsequent
 *  end-of-turn retry as one further trial, so the semantics are "trial cap =
 *  3", not "init + 3 retries". Manual retry (Phase 18-5) resets this. */
const MAX_MODEL_REFRESH_RETRIES = 3;

export const CLAUDE_EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly EffortLevel[];

/** Status fields available before the Claude SDK starts.
 *  The CLI uses this for the initial idle state_change so ADR-0034's
 *  first-envelope capability contract does not depend on SDK init. Effort
 *  starts true because the adapter accepts set_effort; once the catalog is
 *  available #statusExt narrows it for models without effort support. */
export function initialStatusExt(): Record<string, unknown> {
  return {
    engine: "claude-code",
    session_capabilities: {
      supports_attachments: true,
      supports_user_input_dialog: true,
      supports_model_switch: true,
      supports_effort_switch: true,
      supports_session_reset: true,
      session_reset_modes: ["new", "clear"],
      supports_context_usage: true,
    },
    models: claudeBootstrapCatalog(),
  };
}

/** Init-time bounded retry delay for `#refreshContextUsageForInit` (ADR-0040,
 *  phase-21). Small backoff so a transient SDK control-request race at
 *  session init settles quickly, keeping the retry window well under a first
 *  user turn. Exported so tests can inspect without duplicating the constant. */
export const CONTEXT_INIT_RETRY_DELAY_MS = 100;

/** Context-usage share (percent) at or above which the wrapper tells the
 *  agent ONCE per context epoch that recovery is available (phase-28 B1,
 *  #168 決定 P3). The hybrid split: the wrapper does the machine judgement,
 *  the agent decides whether to act. Deliberately a constant — a config
 *  field would have to travel through WrapperConfig in @kaoiro/protocol, and
 *  Phase B is scoped to close inside the wrapper. TODO(#168 Phase C or a
 *  follow-up): make configurable once operators want per-agent thresholds;
 *  the number itself is a guess pending dogfood data. */
export const CONTEXT_NOTICE_THRESHOLD_PERCENT = 70;

/** How many context readings a freshly-opened epoch may take before the
 *  threshold notice is re-enabled regardless of the numbers (phase-28 BR
 *  MF1-R). This is the liveness half of the settling gate: the magnitude
 *  test can miss its window entirely, so something bounded has to end the
 *  suppression or a legitimate warning is lost for the rest of the epoch.
 *
 *  3 was chosen against Track S, which saw exactly ONE stale reading after a
 *  boundary — the refresh the boundary itself kicks. That leaves a full turn
 *  of margin beyond the observed behaviour while capping a false notice at
 *  "one turn late", the direction that costs an approval dialog rather than
 *  a missed warning. */
export const CONTEXT_EPOCH_SETTLE_READINGS = 3;

/** The turn injected when usage first crosses the threshold in an epoch.
 *  Wording is load-bearing (P3: context anxiety): it states the fact, names
 *  the one action available, explicitly removes urgency, and promises not to
 *  repeat — an agent told "you are running out" every turn starts optimizing
 *  for the meter instead of the work. */
function contextNoticeText(usedPercentage: number): string {
  return (
    `[kaoiro] Context usage for this session has reached ` +
    `${usedPercentage}%. If you judge that headroom is starting to limit ` +
    "the work, you can call request_compact to ask the operator to approve " +
    "compacting it. There is no need to act now — finish what you are " +
    "doing and decide at a natural break, or ignore this if the remaining " +
    "room is enough. This notice is not repeated until the next compaction " +
    "or conversation reset."
  );
}

// PermissionDecision / QuestionDecision moved to @kaoiro/agent-common with
// the brokers (phase-13); re-exported here so the host's public surface is
// unchanged.
export type {
  PermissionDecision,
  QuestionDecision,
} from "@kaoiro/agent-common";

export interface AgentHostOptions {
  /** Invoked on every state transition with the common envelope. */
  onState: (envelope: Envelope) => void;
  /**
   * Invoked with each relayed log / result envelope (the agent's reply
   * stream, protocol.md / ADR-0012). Separate from onState so a
   * reply does not trip state-driven logic (e.g. close-on-waiting_input).
   * Omitted = replies are not relayed.
   */
  onLog?: (envelope: Envelope) => void;
  /** Invoked once per SDK turn boundary (success or error), alongside (not
   *  instead of) onLog's result envelope (issue #131). `conversationId` is
   *  the inter-agent conversation that turn's injection came from (the value
   *  passed as send()'s third argument for that turn), or null for an
   *  ordinary operator-instruction turn — must-fix 1: turn-scoped, so the CLI
   *  never resolves a conversation the current turn was not actually
   *  answering. `error` is present only when the turn ended with
   *  is_error=true: `reason` is the SDK's terminal_reason when reported,
   *  `detail` mirrors the turn's error_detail. The CLI feeds `error` into the
   *  shared inter-agent error classifier and resolves exactly this turn's
   *  conversation via InterAgentTool#resolveTurnEnd. Omitted = no notice is
   *  ever emitted (unit tests only — production always wires it). */
  onTurnEnd?: (info: {
    conversationId: string | null;
    error?: { reason?: string; detail?: string };
  }) => void;
  /** Serialises a wrapper-initiated injection behind everything already
   *  queued (phase-28 BR MF2). cli.ts owns one promise chain for operator
   *  instructions, inter-agent deliveries and the B2 `/compact`; the B1
   *  threshold notice must ride the same chain or it can reach the SDK input
   *  stream ahead of a turn that was queued first. `task` re-checks its own
   *  preconditions when the chain reaches it, so a queue this deep is free to
   *  delay it arbitrarily. Omitted = the task runs inline (unit tests,
   *  embedders); production always wires it. */
  enqueueInjection?: (task: () => Promise<void>) => Promise<void>;
  /** Invoked when wrapper rejects an individual upload (file-upload spec /
   *  ADR-0025 F9). Omitted = rejections are not relayed (validation still
   *  runs, the message just does not leave the host). */
  onAttachRejected?: (envelope: Envelope) => void;
  /** Invoked when wrapper rejects a whole instruction (file-upload spec /
   *  ADR-0025 F9). Omitted = the message does not leave the host. */
  onInstructionRejected?: (envelope: Envelope) => void;
  /**
   * Invoked when the SDK first reports a conversation session_id, and again
   * whenever it changes (init / result, ADR-0014 phase-0). The wrapper
   * forwards it to ServerLink, which stamps it onto outgoing envelopes so the
   * server can group history by session. Omitted = the id is not reported.
   */
  onSessionId?: (sessionId: string) => void;
  /**
   * Decides a pending tool permission; its awaited duration is the
   * waiting_permission window. Defaults to deny (fail-closed) when omitted.
   */
  decidePermission?: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<PermissionDecision> | PermissionDecision;
  /**
   * Decides a pending AskUserQuestion (ADR-0027); its awaited duration is the
   * waiting_question window. When omitted, AskUserQuestion falls through to
   * decidePermission (allow/deny) — the pre-#78 behaviour.
   */
  decideQuestion?: (
    questions: Question[],
  ) => Promise<QuestionDecision> | QuestionDecision;
  /**
   * Extra query options (tools, allowedTools, cwd, model, …). Merged over the
   * defaults; canUseTool is reserved by the host and cannot be overridden.
   */
  queryOptions?: Partial<Options>;
  /**
   * Origin of the model resolved by the CLI at startup (ADR-0032 F4bc
   * addendum, phase-15). "launch" / "env" / "config" means the wrapper
   * received an explicit pick and keeps that source stamped even after the
   * SDK confirms the value; leave undefined when no explicit pick was made
   * so #applyInitMeta stamps "default" on the first init report.
   */
  modelSource?: ModelSource;
  /** Origin of an explicit startup effort. Undefined means SDK default. */
  effortSource?: ModelSource;
  /**
   * Resume snapshot from the server (ADR-0014 F1 追補, phase-15 D8): the
   * "last effective" resolved values captured before this relaunch. Only
   * set on a resume launch; absent on a fresh spawn. When set, the host
   * stamps ext.resume_snapshot and ext.resume_drift on every state_change
   * alongside ext.effective.
   */
  resumeSnapshot?: ResolvedSnapshotExt;
  /**
   * Persona personality prompt appended to the SDK systemPrompt via the
   * preset's `append` field (persona-personality-injection spec /
   * ADR-0029). Composed server-side (personality + common footer) and
   * delivered over the WS handshake; cli.ts awaits it and threads it in
   * here. Omitted = no `append` field is emitted (defensive default;
   * production always supplies it).
   */
  appendSystemPrompt?: string;
  /**
   * Delay Query construction until the first queued user turn. Production
   * idle-wait wrappers enable this so model / effort controls selected from
   * a fresh AgentDetail become first-Query Options instead of racing an SDK
   * control request whose initialization also waits for that first turn.
   */
  deferQueryUntilFirstInput?: boolean;
  /** SDK query() factory; injectable for tests. Defaults to the real SDK. */
  queryFn?: typeof query;
  /** Injectable short-lived catalog probe (ADR-0039 F9 v2 = 藤 review D1b).
   *  Called by `refreshCatalogFor()` when `#query` is null (fresh idle).
   *  Defaults to the real child-subprocess probe shared with runner. */
  probeFn?: () => Promise<ProbeOutcome>;
  /** ISO-8601 timestamp source; injectable for tests. */
  now?: () => string;
  /** Wall-clock epoch-ms source for the pending_uploads TTL GC sweep,
   *  injectable for tests. Defaults to `Date.now`. */
  nowMs?: () => number;
}

/**
 * Hosts a single agent session. `run` drives the message loop until the input
 * stream is closed; `send` feeds follow-up turns, `interrupt` stops the current
 * one. State derivation is funneled through one synchronous apply step, so the
 * message loop and the permission callback never interleave mid-update.
 */
export class AgentHost implements EngineAdapter {
  readonly #config: WrapperConfig;
  readonly #options: AgentHostOptions;
  readonly #queryFn: typeof query;
  readonly #probeFn: () => Promise<ProbeOutcome>;
  readonly #now: () => string;
  readonly #nowMs: () => number;
  /** setInterval handle for the TTL GC sweep, cleared in close(). null
   *  between construction and run() (sweep doesn't start until run). */
  #gcTimer: ReturnType<typeof setInterval> | null = null;

  readonly #queue: SDKUserMessage[] = [];
  /** Parallel FIFO to #queue (issue #131 must-fix 1): the inter-agent
   *  conversation_id (if any) that each queued turn's injection came from,
   *  null for an ordinary operator instruction. Shifted in lockstep with
   *  #queue in #input() so #currentTurnConversationId always names exactly
   *  the turn in flight — never a stale or unrelated conversation. */
  readonly #turnConversationIds: (string | null)[] = [];
  /** conversation_id of the turn currently being processed by the SDK
   *  session loop, set by #input() when it dequeues that turn's message. */
  #currentTurnConversationId: string | null = null;
  #notify: (() => void) | null = null;
  #closed = false;
  #query: Query | null = null;
  #machine: MachineState = initialMachineState();
  /** tool_use_id -> tool_name, so a tool_result log can name its tool.
   *  Cleared each turn (every tool is settled by the result). */
  readonly #toolNames = new Map<string, string>();

  /** Latest Claude Code status meta (#16), stamped into state_change ext:
   *  active model, working directory, context-window usage, and per-window
   *  rate limits. All best-effort — absent until the SDK surfaces them. */
  #model: string | null = null;
  /** Source of #model (ADR-0032 F4bc addendum, phase-15). Set by the
   *  constructor from options.modelSource; auto-becomes "default" when
   *  #applyInitMeta stamps a model without a prior explicit source. */
  #modelSource: ModelSource | null = null;
  #effort: string | null = null;
  #effortPending: string | null = null;
  #effortLastGood: string | null = null;
  #effortLastGoodSource: ModelSource | null = null;
  #effortSource: ModelSource | null = null;
  #effortResetPending = false;
  #effortResetOnce = false;
  #switchErrorOnce: SwitchErrorExt | null = null;
  readonly #operatorSwitchedFields = new Set<keyof ResolvedSnapshotExt>();
  /** Resume snapshot (ADR-0014 F1 追補, phase-15 D8), set by the
   *  constructor from options.resumeSnapshot; null on a fresh spawn.
   *  When non-null, #statusExt emits ext.resume_snapshot + ext.resume_drift
   *  alongside ext.effective on every state_change. */
  readonly #resumeSnapshot: ResolvedSnapshotExt | null = null;
  #cwd: string | null = null;
  /** Slash commands the SDK reported at session init (#34); surfaced so the
   *  dashboard can offer `/` completion. */
  #slashCommands: string[] | null = null;
  /** Current Claude Code permission mode (#57). Init carries it as required;
   *  SDKStatusMessage updates it on mid-session changes (e.g. `/mode`).
   *  Stamped into ext.permission_mode. */
  #permissionMode: string | null = null;
  /** Fast mode state (#57) — `off` / `cooldown` / `on`. Updated from init and
   *  every result message (cooldown only ever surfaces via result). Stamped
   *  into ext.fast_mode. */
  #fastMode: string | null = null;
  /** Snapshot of the persisted model alias supplied at construction (spawn
   *  config / env / resume snapshot). #model tracks the *effective* value
   *  which init overwrites with what the SDK is actually running (host.ts:
   *  around L1231), so we keep the original request separately to validate it
   *  against the SDK's measured catalog once available (ADR-0037 F8). Null
   *  when no persist alias was supplied. Consumed once by the first
   *  refresh-success run of #validatePersistModelAgainstCatalog — manual
   *  retry (retrySupportedModels) does NOT re-seed this snapshot, which is
   *  intentional: re-validating on manual retry would suppress the
   *  legitimate first-success path when the catalog only becomes reachable
   *  after a retry. */
  #persistedModel: string | null = null;
  /** Selectable models with their per-model effort levels (#54, ADR-0020);
   *  surfaced so the dashboard can build the bare `/model` / `/effort` choice
   *  dialogs without a round-trip. Seed order: runner-supplied catalog
   *  (ADR-0039 F9 追補) if the spawn carried one, else the bootstrap floor
   *  (ADR-0037 F1). The SDK's own supportedModels() still overrides both
   *  once `#refreshSupportedModels()` succeeds. */
  #models: SupportedModel[];
  /** True while a supportedModels() call is in flight; guards concurrent
   *  fetches triggered by overlapping init / result messages within the same
   *  turn. Cleared in finally. */
  #modelsInflight = false;
  /** Number of supportedModels() attempts made in this session (successful or
   *  failed). Compared against MAX_MODEL_REFRESH_RETRIES to enforce the F6
   *  bounded retry; incremented at each attempt (see #refreshSupportedModels
   *  for the exact contract). */
  #modelsRetryCount = 0;
  /** Once supportedModels() has resolved successfully, further fetches are
   *  suppressed for the session — the SDK's catalog is static per session
   *  (ADR-0020). Phase 18-5's manual retry resets this together with the
   *  counter to force a re-fetch. */
  #modelsSucceeded = false;
  #context: {
    used_tokens: number;
    max_tokens: number;
    used_percentage: number;
  } | null = null;
  /** In-flight guard for `#refreshContextUsage()` (ADR-0040 phase-21,
   *  藤 review turn-3 must-fix C). Concurrent triggers (init / result /
   *  model switch) coalesce; a caller that hits the guard sets
   *  `#contextRefreshPending` so a follow-up runs after the current
   *  completion, avoiding a stall until the next natural trigger. */
  #contextInflight = false;
  /** Set when a refresh call landed while another was in flight
   *  (ADR-0040 phase-21 must-fix C). The `finally` block re-kicks
   *  `#refreshContextUsage()` once so the queued caller gets serviced. */
  #contextRefreshPending = false;
  /** Monotonic generation for context refreshes (ADR-0040 phase-21,
   *  Codex pattern parallel: `#modelResolutionGeneration`). Incremented on
   *  model switch (context window semantics differ per model). A refresh's
   *  captured generation is compared against the current value on completion;
   *  a mismatch discards the result so stale data cannot overwrite a fresh
   *  post-switch snapshot. */
  #contextGeneration = 0;
  /** True once this context epoch's threshold notice has been queued
   *  (phase-28 B1). Cleared by `#invalidateContextEpoch()`, so a compaction
   *  or a conversation reset re-arms it and nothing else does — that is the
   *  whole dedup: one notice per epoch, never a per-turn nag (P3). */
  #contextNoticeSent = false;
  /** Settling gate for a context epoch that has just opened (phase-28 BR
   *  MF1 / MF1-R). Non-null means a compaction or reset happened and
   *  `getContextUsage()` has not yet been shown to reflect it — Track S
   *  measured the call right after a boundary still reporting the PRE-compact
   *  total, and a threshold notice computed from that stale figure warns the
   *  agent about usage it just compacted away.
   *
   *  Two independent ways out, because neither alone is sound:
   *
   *  - `atOrBelow` — a reading no larger than this proves the measurement
   *    reflects the new epoch. It comes from the boundary metadata, the only
   *    authoritative statement of what the context became: `post_tokens` when
   *    the boundary reported it, otherwise `pre_tokens - 1` (anything at or
   *    above `pre_tokens` is indistinguishable from the stale reading).
   *    Null when the event carried no usable numbers at all — a
   *    `conversation_reset`, or a boundary whose metadata did not parse.
   *  - `readings` — a hard cap of `CONTEXT_EPOCH_SETTLE_READINGS`
   *    measurements. Magnitude alone cannot settle the gate: readings are
   *    discrete, so an epoch can jump from below `atOrBelow` to above it
   *    between two samples and never be seen in between (BR MF1-R). Without
   *    this cap such an epoch would be muted for its whole life. */
  #contextEpochGate: { atOrBelow: number | null; readings: number } | null =
    null;
  readonly #rateLimits = new Map<
    string,
    { status?: string; utilization?: number; resets_at?: number }
  >();
  /** Authoritative pending-permission record (ADR-0022, #59). Set by the
   *  broker via setPendingPermission() so every state_change emitted while
   *  waiting_permission carries it in ext, surviving any intermediate
   *  envelope arrival. null when no decision is in flight. */
  #pendingPermission: PendingPermissionExt | null = null;
  /** Authoritative pending-question record (ADR-0027). Question twin of
   *  #pendingPermission: set by the question broker via setPendingQuestion()
   *  so every state_change emitted while waiting_question carries it in ext.
   *  null when no question is in flight. */
  #pendingQuestion: PendingQuestionExt | null = null;
  /** Latest SDK conversation session id (ADR-0014 phase-0). Mirrored locally
   *  so the whoami snapshot can include it without coupling to ServerLink. */
  #sessionId: string | null = null;
  /** In-memory chunk buffers for in-flight uploads (file-upload spec /
   *  ADR-0025 F3 — pure-memory, disk-unreachable). One entry per accepted
   *  attach_open; entries are consumed when their upload_id appears in an
   *  instruction's attachment_ids. */
  readonly #pendingUploads = new Map<string, PendingUpload>();

  constructor(config: WrapperConfig, options: AgentHostOptions) {
    this.#config = config;
    this.#options = options;
    this.#queryFn = options.queryFn ?? query;
    this.#probeFn = options.probeFn ?? runClaudeProbe;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#nowMs = options.nowMs ?? Date.now;
    // ADR-0039 F9 追補: prefer the runner-transported catalog so fresh
    // idle wrappers (deferQueryUntilFirstInput=true, #query still null,
    // supportedModels() unreachable) already surface a rich model +
    // effort_levels list to AgentDetail. Falls back to the bootstrap floor
    // when the spawn carried nothing (runner cache miss / cold start).
    this.#models =
      config.claude_engine_catalog !== undefined
        ? (config.claude_engine_catalog as SupportedModel[])
        : claudeBootstrapCatalog();
    // Optimistic stamp (phase-15 15-4b): surface the wrapper-known model /
    // permission_mode from the first state_change onward, before the SDK
    // init reports them. Fields the wrapper cannot know at startup
    // (fast_mode has no launch-time source; slash_commands / context /
    // rate_limits are SDK-reported only) stay null.
    this.#modelSource = options.modelSource ?? null;
    this.#effort = options.queryOptions?.effort ?? null;
    this.#effortSource = options.effortSource ?? null;
    this.#effortLastGood = this.#effort;
    this.#effortLastGoodSource = this.#effortSource;
    this.#resumeSnapshot = options.resumeSnapshot ?? null;
    if (options.queryOptions?.model !== undefined) {
      this.#model = options.queryOptions.model;
      this.#persistedModel = options.queryOptions.model;
    }
    // Phase-23 dogfood 回帰対策 (ADR-0014 F1 追補 P1「launch pin vs display
    // hint」): runner の 5-case pair rule Case 2 (source=default) は
    // config.model / config.effort を unset するので queryOptions にも
    // 届かない。しかし wrapper の display / catalog resolve には前回セッションの
    // value が必要 — resume_snapshot の (value, source="default") ペアを
    // display hint として復元し、`this.#model` / `this.#effort` に反映する。
    // explicit queryOptions/options が既に set の場合はそちらが優先。
    // Claude effort は SDK の effort enum との drift 対策として
    // CLAUDE_EFFORT_LEVELS で再 validation し、外れなら value / source
    // ともに drop + stderr warn (pair drop invariant を wrapper 境界でも維持)。
    if (this.#resumeSnapshot !== null) {
      if (
        this.#model === null &&
        this.#resumeSnapshot.model !== undefined &&
        this.#resumeSnapshot.model_source === "default"
      ) {
        this.#model = this.#resumeSnapshot.model;
        // #persistedModel は明示 spawn/env/Case3 alias の SDK-measured catalog
        // 検証用 (`#validatePersistModelAgainstCatalog` が persist_alias_unknown
        // rollback を出す)。SDK default の historical hint はその validation
        // 対象外なので null 維持 — hint が現 catalog に無いだけで
        // switch_error を出す穴を塞ぐ (藤 3 次 review R4)。
        this.#modelSource = "default";
      }
      if (
        this.#effort === null &&
        this.#resumeSnapshot.effort !== undefined &&
        this.#resumeSnapshot.effort_source === "default"
      ) {
        const hintEffort = this.#resumeSnapshot.effort;
        if ((CLAUDE_EFFORT_LEVELS as readonly string[]).includes(hintEffort)) {
          this.#effort = hintEffort;
          this.#effortLastGood = hintEffort;
          this.#effortLastGoodSource = "default";
          this.#effortSource = "default";
        } else {
          process.stderr.write(
            `resume: unsupported claude-code effort hint ` +
              `'${hintEffort}', dropped (value and source both)\n`,
          );
        }
      }
    }
    if (config.permission_mode !== undefined) {
      this.#permissionMode = config.permission_mode;
    }
  }

  get state(): KaoiroState {
    return this.#machine.state;
  }

  /** Snapshot of the calling agent's identity and current status (used by the
   *  `mcp__kaoiro__whoami` tool, protocol-inter-agent companion). Reads only
   *  local state — no server round-trip, since the wrapper holds the freshest
   *  view of these fields. Omits keys whose SDK has not yet reported a value
   *  so consumers can distinguish "unknown" from a stale stub. */
  statusSnapshot(): WhoamiSnapshot {
    const out: WhoamiSnapshot = {
      agent_id: this.#config.agent_id,
      persona: this.#config.persona,
      state: this.#machine.state,
      ...effectiveStatusWhoamiFields(this.#effectiveStatusSnapshot()),
    };
    if (this.#cwd !== null) out.cwd = this.#cwd;
    if (this.#sessionId !== null) out.session_id = this.#sessionId;
    // phase-28 A2 (#168): the agent's own context usage, in the same shape
    // peers already read via list_agents. Null (never fetched, or dropped by
    // a model switch) omits the key so absent keeps meaning unknown.
    if (this.#context !== null) out.context = this.#context;
    return out;
  }

  /** Single engine-neutral SoT for both state_change.ext and whoami (#113). */
  #effectiveStatusSnapshot(): EffectiveStatusSnapshot {
    const axes = PERMISSION_MODE_AXES[this.#permissionMode as PermissionMode];
    return {
      engine: "claude-code",
      resolved: {
        ...(this.#model !== null ? { model: this.#model } : {}),
        ...(this.#modelSource !== null
          ? { model_source: this.#modelSource }
          : {}),
        ...(this.#effort !== null ? { effort: this.#effort } : {}),
        ...(this.#effortSource !== null
          ? { effort_source: this.#effortSource }
          : {}),
        ...(this.#permissionMode !== null
          ? { permission_mode: this.#permissionMode as PermissionMode }
          : {}),
        ...(axes === undefined ? {} : { sandbox: axes.sandbox }),
      },
      ...(axes === undefined ? {} : { permission: axes }),
      ...(this.#fastMode === null ? {} : { fast_mode: this.#fastMode }),
    };
  }

  /** Enqueue a user turn for the streaming input. When `attachmentIds` are
   *  provided, the host resolves each id against pending_uploads, assembles
   *  bytes, fits to SDK and renders content blocks (file-upload spec /
   *  ADR-0025 F1 & F10), and atomically rejects the whole turn if any id is
   *  missing, incomplete, or unfittable. Successful resolution consumes the
   *  uploads. Async because the PDF fit-to-SDK pass is async; cli.ts
   *  serialises onInstruction calls through a promise chain so async render
   *  cost does not reorder concurrent instructions on the SDK queue.
   *
   *  `interAgentConversationId` (issue #131 must-fix 1) tags this specific
   *  queued turn with the inter-agent conversation it was injected to answer
   *  — cli.ts passes it only from the inter-agent injection path, never for
   *  an ordinary operator instruction. Threaded through #turnConversationIds
   *  in lockstep with #queue so onTurnEnd resolves exactly this turn's
   *  conversation, not whatever else happens to be pending. */
  async send(
    text: string,
    attachmentIds?: string[],
    interAgentConversationId?: string,
  ): Promise<void> {
    if (this.#closed) throw new Error("agent host is closed");
    // Fail fast instead of growing without bound when nothing drains.
    if (this.#queue.length >= MAX_QUEUED_TURNS) {
      throw new Error("agent host input queue is full");
    }

    let content: string | ContentBlock[] = text;
    if (attachmentIds && attachmentIds.length > 0) {
      if (attachmentIds.length > MAX_ATTACHMENTS_PER_INSTRUCTION) {
        // F6 cap: bounce the turn before consuming any staged upload so the
        // operator can re-pick within the limit (count_over is an atomic
        // pre-flight failure, not a partial send).
        this.#emitInstructionRejected({
          attachment_ids: attachmentIds,
          reason: "count_over",
          detail: `count=${attachmentIds.length} cap=${MAX_ATTACHMENTS_PER_INSTRUCTION}`,
        });
        return;
      }
      const resolved = this.#resolveAttachments(attachmentIds);
      if (!resolved) return; // emitInstructionRejected already fired.
      const blocks: ContentBlock[] = [];
      for (const entry of resolved) {
        const result = await renderAttachmentBlock(
          entry.meta,
          assembleBytes(entry),
        );
        if (!result.ok) {
          // Stamp the per-upload reject for ALL render-failure reasons so
          // the dashboard chip identifies which file broke, not just
          // "the turn failed" (instruction_rejected only carries the id
          // list). sdk_error covers corrupt PDFs et al., and like the
          // unfittable_* family the same bytes will fail the same way on
          // retry — so drop the entry from pending_uploads here too,
          // matching attachChunk/size_over and attachClose/failure which
          // delete on failure. Already-rendered siblings stay so the
          // operator can retry the turn without the broken file.
          this.#emitAttachRejected({
            upload_id: entry.meta.upload_id,
            reason: result.reason,
            ...(result.reason === "sdk_error"
              ? { detail: `render failed for mime=${entry.meta.mime}` }
              : {}),
          });
          this.#pendingUploads.delete(entry.meta.upload_id);
          this.#emitInstructionRejected({
            attachment_ids: attachmentIds,
            reason: result.reason,
          });
          return;
        }
        blocks.push(result.block);
      }
      if (text.length > 0) blocks.push({ type: "text", text });
      // Per-instruction total request size check (Stage A IN2: Anthropic's
      // 32 MB ceiling counts base64-encoded media + raw text). Run AFTER
      // each block has been fit-to-SDK so e.g. a downsized 30 MB JPEG
      // counts against the budget at its reduced size, not the raw upload.
      // No uploads consumed on overflow so the operator can re-pick a
      // smaller subset without re-uploading anything.
      const totalSize = blocks.reduce((acc, b) => acc + blockWireSize(b), 0);
      if (totalSize > TOTAL_REQUEST_BYTE_LIMIT) {
        this.#emitInstructionRejected({
          attachment_ids: attachmentIds,
          reason: "total_request_over",
          detail: `total=${totalSize} cap=${TOTAL_REQUEST_BYTE_LIMIT}`,
        });
        return;
      }
      content = blocks;
      // Consume — uploads are one-shot per instruction.
      for (const id of attachmentIds) this.#pendingUploads.delete(id);
    }

    this.#queue.push({
      type: "user",
      // Empty by design (ADR-0014 phase-0): in streaming-input mode the SDK
      // owns the conversation and issues the session id itself. We capture the
      // real id from init/result (sdkMessageToSessionId) and report it on
      // envelopes; resume targets a session via options.resume, not here.
      session_id: "",
      parent_tool_use_id: null,
      // The SDK's MessageParam accepts string | content blocks; the cast
      // narrows our local ContentBlock union to the SDK's wider shape.
      message: { role: "user", content: content as never },
    });
    this.#turnConversationIds.push(interAgentConversationId ?? null);
    // Optimistic `sending` state (#32): raised here, where the host knows the
    // instruction was accepted, rather than waiting for an SDK message that
    // may not land until the model's first token.
    this.#apply({ kind: "user_send" });
    this.#wake();
  }

  /** Registers a new upload from `attach_open`; emits `attach_rejected`
   *  immediately on the in-flight cap, MIME, or size mismatch (no entry is
   *  created in that case so a subsequent attach_chunk for the same id is
   *  dropped silently). */
  attachOpen(meta: UploadMeta): void {
    if (this.#pendingUploads.size >= MAX_INFLIGHT_UPLOADS) {
      // F6 in-flight cap: refuse the open before allocating a pending entry
      // so a misbehaving client cannot exhaust pending_uploads memory by
      // opening uploads it never closes / never references.
      this.#emitAttachRejected({
        upload_id: meta.upload_id,
        reason: "count_over",
        detail: `in-flight=${this.#pendingUploads.size} cap=${MAX_INFLIGHT_UPLOADS}`,
      });
      return;
    }
    const result = validateOpen(meta);
    if (!result.ok) {
      this.#emitAttachRejected({
        upload_id: meta.upload_id,
        reason: result.reason,
        ...(result.detail !== undefined ? { detail: result.detail } : {}),
      });
      return;
    }
    this.#pendingUploads.set(meta.upload_id, {
      meta,
      chunks: new Map(),
      sealed: false,
      accumulatedBytes: 0,
      addedAt: this.#nowMs(),
    });
  }

  /** Parses an `attach_chunk` binary payload and appends bytes to the
   *  matching pending upload, enforcing the per-upload cap incrementally
   *  (security: a misbehaving client cannot stream past meta.size or
   *  PROTOCOL_FILE_SIZE_LIMIT_BYTES). Unknown id, sealed entry, malformed header,
   *  or out-of-bounds chunk_index is dropped silently — a stray chunk
   *  after a successful attach_close or rejected open is not an error. */
  attachChunk(payload: ArrayBuffer | ArrayBufferView): void {
    let parsed;
    try {
      parsed = parseChunkPayload(payload);
    } catch {
      return;
    }
    const entry = this.#pendingUploads.get(parsed.upload_id);
    if (!entry || entry.sealed) return;
    if (parsed.chunk_index >= entry.meta.chunks) return;
    const existing = entry.chunks.get(parsed.chunk_index);
    const newTotal =
      entry.accumulatedBytes -
      (existing?.byteLength ?? 0) +
      parsed.bytes.byteLength;
    if (
      newTotal > entry.meta.size ||
      newTotal > PROTOCOL_FILE_SIZE_LIMIT_BYTES
    ) {
      this.#pendingUploads.delete(parsed.upload_id);
      this.#emitAttachRejected({
        upload_id: parsed.upload_id,
        reason: "size_over",
        detail: `accumulated=${newTotal} declared=${entry.meta.size} cap=${PROTOCOL_FILE_SIZE_LIMIT_BYTES}`,
      });
      return;
    }
    entry.chunks.set(parsed.chunk_index, parsed.bytes);
    entry.accumulatedBytes = newTotal;
  }

  /** Verifies an upload is complete (all chunks landed, assembled size
   *  matches declared); incomplete or oversize emits attach_rejected and
   *  drops the entry. On success the entry is `sealed` so post-close chunks
   *  cannot rewrite already-validated bytes. */
  attachClose(uploadId: string): void {
    const entry = this.#pendingUploads.get(uploadId);
    if (!entry) return;
    const result = validateClose(entry);
    if (!result.ok) {
      this.#pendingUploads.delete(uploadId);
      this.#emitAttachRejected({
        upload_id: uploadId,
        reason: result.reason,
        ...(result.detail !== undefined ? { detail: result.detail } : {}),
      });
      return;
    }
    entry.sealed = true;
  }

  /** Resolves `attachment_ids` to their pending uploads, validating each
   *  that has not been sealed by attachClose. Returns the entries in caller
   *  order, or null after emitting instruction_rejected (atomic — first
   *  failure aborts the turn). */
  #resolveAttachments(ids: string[]): PendingUpload[] | null {
    const entries: PendingUpload[] = [];
    for (const id of ids) {
      const entry = this.#pendingUploads.get(id);
      if (!entry) {
        this.#emitInstructionRejected({
          attachment_ids: ids,
          reason: "timeout",
          detail: `unknown upload_id ${id}`,
        });
        return null;
      }
      // Sealed entries already passed validateClose; re-running it is
      // redundant and would scan the chunks map again for nothing.
      if (!entry.sealed) {
        const check = validateClose(entry);
        if (!check.ok) {
          this.#emitInstructionRejected({
            attachment_ids: ids,
            reason: check.reason,
            ...(check.detail !== undefined ? { detail: check.detail } : {}),
          });
          return null;
        }
      }
      entries.push(entry);
    }
    return entries;
  }

  #emitAttachRejected(payload: AttachRejectedPayload): void {
    const onReject = this.#options.onAttachRejected;
    if (!onReject) return;
    onReject(
      makeAttachRejected(
        this.#config,
        this.#machine.state,
        this.#now(),
        payload,
      ),
    );
  }

  #emitInstructionRejected(payload: InstructionRejectedPayload): void {
    const onReject = this.#options.onInstructionRejected;
    if (!onReject) return;
    onReject(
      makeInstructionRejected(
        this.#config,
        this.#machine.state,
        this.#now(),
        payload,
      ),
    );
  }

  /** Close the input stream; the session ends once the current turn drains.
   *  Clears the TTL GC interval so the host does not keep the Node event
   *  loop alive after the session has settled. */
  close(): void {
    this.#closed = true;
    if (this.#gcTimer !== null) {
      clearInterval(this.#gcTimer);
      this.#gcTimer = null;
    }
    this.#wake();
  }

  /** Drop pending_uploads whose age exceeds PENDING_UPLOAD_TTL_MS
   *  (file-upload spec F13), emitting attach_rejected{reason="timeout"}
   *  for each so the dashboard chip surfaces the drop. Called by the
   *  setInterval started in run() and exposed for tests to trigger
   *  deterministically without waiting on a real timer. */
  tickGC(): void {
    const cutoff = this.#nowMs() - PENDING_UPLOAD_TTL_MS;
    for (const [uploadId, entry] of this.#pendingUploads) {
      if (entry.addedAt < cutoff) {
        this.#emitAttachRejected({
          upload_id: uploadId,
          reason: "timeout",
          detail: `ttl exceeded (added_at=${entry.addedAt} cutoff=${cutoff})`,
        });
        this.#pendingUploads.delete(uploadId);
      }
    }
  }

  /** Interrupt the current turn (streaming-input control request) AND
   *  drop any uploads still resident in pending_uploads, emitting
   *  `attach_rejected{reason="interrupted"}` per dropped id (file-upload
   *  spec F11). Operates even when no turn is in progress: an interrupt
   *  with staged uploads but no live SDK call clears the wrapper-side
   *  build-up so the operator can rebuild from scratch instead of
   *  inheriting half-staged state. With no pending uploads the loop is a
   *  no-op, preserving the legacy interrupt-only behaviour. */
  async interrupt(): Promise<void> {
    for (const uploadId of this.#pendingUploads.keys()) {
      this.#emitAttachRejected({
        upload_id: uploadId,
        reason: "interrupted",
      });
    }
    this.#pendingUploads.clear();
    await this.#query?.interrupt();
  }

  /** Switch the model for subsequent turns (#54, ADR-0020). `value` accepts
   *  either a supportedModels alias (e.g. "opus[1m]", "sonnet", "default")
   *  or its resolved canonical ID. Input representation is preserved: the
   *  exact string received is sent to the SDK and stored in #model; catalog
   *  lookup only determines the compatible effort domain. Next-message
   *  granularity — the active turn is unaffected. Before run(), buffers that
   *  same string into the first Query's Options. */
  async setModel(value: string): Promise<void> {
    const current = this.#query;
    const nextModels = this.#findCatalogEntries(value);
    const nextEffortLevels = this.#effortLevelsForCatalogEntries(nextModels);
    const invalidEffort =
      this.#effort !== null &&
      nextModels.length > 0 &&
      !nextEffortLevels.includes(this.#effort as EffortLevel);
    // Before run(), commit into the fields used to construct query Options.
    // This closes the fresh-idle race where the dashboard can send set_model
    // after the CLI's idle announce but before #query exists.
    if (current === null) {
      if (nextModels.length === 0) {
        this.#switchErrorOnce = {
          kind: "model",
          requested: value,
          reason: "model_catalog_unavailable",
        };
        this.#emitState(this.#machine.state);
        throw new Error(`unknown bootstrap model: ${value}`);
      }
      this.#model = value;
      this.#modelSource = "config";
      this.#operatorSwitchedFields.add("model");
      this.#operatorSwitchedFields.add("model_source");
      if (invalidEffort) {
        this.#effort = null;
        this.#effortSource = null;
        this.#effortLastGood = null;
        this.#effortLastGoodSource = null;
        this.#operatorSwitchedFields.add("effort");
        this.#operatorSwitchedFields.add("effort_source");
        this.#effortResetOnce = true;
      }
      this.#switchErrorOnce = null;
      this.#emitState(this.#machine.state);
      return;
    }
    if (invalidEffort) {
      this.#effortPending = null;
      this.#effortResetPending = true;
      this.#effortResetOnce = true;
      this.#emitState(this.#machine.state);
    }
    let modelApplied = false;
    try {
      await current.setModel(value);
      modelApplied = true;
      this.#model = value;
      this.#modelSource = "config";
      this.#operatorSwitchedFields.add("model");
      this.#operatorSwitchedFields.add("model_source");
      // Invalidate the cached context snapshot AS SOON AS the model has been
      // applied on the SDK side (ADR-0040 phase-21, 藤 review turn-5 must-fix
      // R1). Different Claude models can have different context windows
      // (opus[1m] vs sonnet), so the previous percentage is stale the moment
      // setModel resolves. If we deferred this bump past the effort_reset
      // step, an applyFlagSettings reject would throw before it landed —
      // leaving #context pointing at the old model's window while the SDK
      // is already on the new one. Bump the generation FIRST so any
      // in-flight refresh's captured generation mismatches on completion
      // and its pre-switch result is discarded.
      this.#contextGeneration += 1;
      this.#context = null;
      if (invalidEffort) {
        // SDK 0.3.187: null clears the flag layer; undefined is dropped by
        // JSON serialisation and would silently leave the old effort active.
        await current.applyFlagSettings({ effortLevel: null });
        this.#effort = null;
        this.#effortSource = null;
        this.#effortLastGood = null;
        this.#effortLastGoodSource = null;
        this.#effortResetPending = false;
        this.#operatorSwitchedFields.add("effort");
        this.#operatorSwitchedFields.add("effort_source");
      }
      this.#switchErrorOnce = null;
      this.#emitState(this.#machine.state);
      void this.#refreshContextUsage();
    } catch (error) {
      this.#effortResetPending = false;
      this.#switchErrorOnce = {
        kind: modelApplied && invalidEffort ? "effort" : "model",
        requested: modelApplied && invalidEffort ? "default" : value,
        reason:
          modelApplied && invalidEffort
            ? "effort_reset_failed"
            : "control_rejected",
        ...(modelApplied && invalidEffort && this.#effort !== null
          ? { rolled_back_to: this.#effort }
          : {}),
      };
      this.#emitState(this.#machine.state);
      // R1: model apply が成功していれば context refresh を kick する。
      // 失敗 path (effort_reset_failed) の envelope は switch_error 経由で
      // 旧 context を絶対に含まない (#context は既に null 済) — ここでの
      // refresh kick が新 model の値を後続 state_change に届ける。
      // setModel 自体 reject (modelApplied=false) の場合は SDK model 変化
      // していないため refresh 不要 (二重 refresh 防止)。
      if (modelApplied) {
        void this.#refreshContextUsage();
      }
      throw error;
    }
  }

  /** Switch the reasoning effort for subsequent turns (#54, ADR-0020) via the
   *  apply_flag_settings control request. `level` arrives as a wire string
   *  (an effort_levels entry); symmetric with setModel, the SDK is the
   *  validator. The persisted Settings.effortLevel type stops at "xhigh", but
   *  the runtime accepts the full domain including "max" (#54 実機検証;
   *  agent-sdk-events.md model/effort 検証メモ), so the cast widens it
   *  deliberately. Next-message granularity. */
  async setEffort(level: string): Promise<void> {
    const current = this.#query;
    if (current === null) {
      const activeModels = this.#findCatalogEntries(this.#model ?? "default");
      const activeEffortLevels = this.#effortLevelsForCatalogEntries(activeModels);
      if (!activeEffortLevels.includes(level as EffortLevel)) {
        this.#switchErrorOnce = {
          kind: "effort",
          requested: level,
          reason: "control_rejected",
        };
        this.#emitState(this.#machine.state);
        throw new Error(`unsupported bootstrap effort: ${level}`);
      }
      this.#effort = level;
      this.#effortSource = "config";
      this.#effortLastGood = level;
      this.#effortLastGoodSource = "config";
      this.#operatorSwitchedFields.add("effort");
      this.#operatorSwitchedFields.add("effort_source");
      this.#switchErrorOnce = null;
      this.#emitState(this.#machine.state);
      return;
    }
    this.#effortPending = level;
    this.#effortResetPending = false;
    this.#emitState(this.#machine.state);
    try {
      await current.applyFlagSettings({
        effortLevel: level as "low" | "medium" | "high" | "xhigh",
      });
      this.#effort = level;
      this.#effortSource = "config";
      this.#effortLastGood = level;
      this.#effortLastGoodSource = "config";
      this.#effortPending = null;
      this.#operatorSwitchedFields.add("effort");
      this.#operatorSwitchedFields.add("effort_source");
      this.#switchErrorOnce = null;
      this.#emitState(this.#machine.state);
    } catch (error) {
      this.#effort = this.#effortLastGood;
      this.#effortSource = this.#effortLastGoodSource;
      this.#effortPending = null;
      this.#switchErrorOnce = {
        kind: "effort",
        requested: level,
        reason: "control_rejected",
        ...(this.#effortLastGood === null
          ? {}
          : { rolled_back_to: this.#effortLastGood }),
      };
      this.#emitState(this.#machine.state);
      throw error;
    }
  }

  /** Switch the permission mode for subsequent turns (#58). Two paths:
   *  - PRE-run() (`#query` null): seeds the initial mode used at SDK
   *    open. Server's after-join push lands here, before the first turn.
   *  - MID-session: forwards to `query.setPermissionMode`; the SDK echoes
   *    the new mode via SDKStatusMessage so ext.permission_mode updates on
   *    the next state_change (#57). Optimistically stamp the internal
   *    field so the next envelope reflects the choice even if the status
   *    message is delayed; a later status overwrites it.
   *
   *  Rolls back the optimistic write when the SDK rejects (e.g. mid-session
   *  switch INTO bypassPermissions when the session was not opened with
   *  allowDangerouslySkipPermissions). Otherwise the failed switch would
   *  leave the next state_change stamping a mode the SDK never accepted —
   *  and no status echo would arrive to correct it. */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    const prev = this.#permissionMode;
    this.#permissionMode = mode;
    try {
      await this.#query?.setPermissionMode(mode);
    } catch (err) {
      this.#permissionMode = prev;
      throw err;
    }
  }

  /** Receives the pending-permission record from the broker (ADR-0022).
   *  Called synchronously inside the decider before #canUseTool transitions
   *  the state machine, so the resulting state_change(waiting_permission)
   *  carries ext.pending_permission directly; called again with null on
   *  resolve / timeout / close so the next state_change(tool_running) has
   *  a cleared ext. No envelope is emitted here — the next #apply does it. */
  setPendingPermission(pending: PendingPermissionExt | null): void {
    this.#pendingPermission = pending;
  }

  /** Question twin of setPendingPermission (ADR-0027): the question broker
   *  stamps the pending-question record so the state_change(waiting_question)
   *  carries ext.pending_question, and clears it on resolve / cancel / close. */
  setPendingQuestion(pending: PendingQuestionExt | null): void {
    this.#pendingQuestion = pending;
  }

  /** Updates #cwd from a CwdChanged hook (#64) so the next state_change
   *  stamps the new path into ext.cwd. Mirrors the pending_permission
   *  piggyback (ADR-0022): no envelope is emitted here — the next #apply
   *  carries it. cwd changes always happen mid-turn (Bash `cd`) and are
   *  followed by another state transition, so a same-turn re-emit would
   *  only add a duplicate state_change without surfacing the change sooner. */
  #applyCwdChanged(input: HookInput): void {
    const cwd = cwdChangedHookToCwd(input);
    if (cwd !== null) this.#cwd = cwd;
  }

  /**
   * Start the session and consume messages until closed. With
   * `initialPrompt` the first turn starts immediately; without it the
   * session waits until `send` delivers the first turn. Production enables
   * deferQueryUntilFirstInput so fresh-idle model / effort picks can still
   * become startup Options before the SDK Query is constructed.
   */
  async run(initialPrompt?: string): Promise<void> {
    if (initialPrompt !== undefined) await this.send(initialPrompt);
    // Start the TTL GC sweep. unref() so the timer never blocks process
    // shutdown — close() also clears it explicitly, but a stray uncaught
    // path otherwise would keep Node alive.
    this.#gcTimer = setInterval(() => {
      this.tickGC();
    }, PENDING_UPLOAD_GC_INTERVAL_MS);
    if (typeof this.#gcTimer.unref === "function") this.#gcTimer.unref();
    if (
      initialPrompt === undefined &&
      this.#options.deferQueryUntilFirstInput === true
    ) {
      await this.#waitForFirstInput();
      if (this.#closed) return;
    }
    // Merge CwdChanged into any user-supplied hooks instead of overwriting,
    // so #64's cwd refresh composes with the consumer's own hooks. CwdChanged
    // is the only mid-session cwd source (init carries it once, never updates).
    const userHooks = this.#options.queryOptions?.hooks ?? {};
    // permissionMode source order (#58): server-pushed last-choice >
    // config.permission_mode > `default`. setPermissionMode() before run()
    // sets #permissionMode; that overrides config.permission_mode here so
    // the SDK opens the session in the chosen mode without a mid-session flip.
    // allowDangerouslySkipPermissions is opt-in by mode: enabled only when
    // the session STARTS in bypassPermissions. A later switch into bypass
    // via the dashboard fails at the SDK boundary unless the wrapper was
    // started with that mode.
    const initialMode: PermissionMode =
      (this.#permissionMode as PermissionMode | null) ??
      this.#config.permission_mode ??
      "default";
    const options: Options = {
      permissionMode: initialMode,
      ...(initialMode === "bypassPermissions"
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        ...(this.#options.appendSystemPrompt !== undefined
          ? { append: this.#options.appendSystemPrompt }
          : {}),
      },
      ...this.#options.queryOptions,
      // PRE-run model / effort switches override the constructor snapshot;
      // queryOptions alone would retain the spawn-time values and silently
      // lose a fresh-idle dashboard choice.
      //
      // Phase-23 dogfood 回帰対策 (ADR-0014 F1 追補 P1「launch pin vs display
      // hint」): source="default" は SDK 委任継続で non-pin。resume_snapshot
      // 経由の hint 復元でこのフィールドが set されていても、初回 Query に
      // は渡さず SDK が自ら default を選ぶ (これが Case 2 の semantics)。
      // operator setModel / setEffort は #modelSource / #effortSource を
      // "config" に上書きするため gate 通過し、explicit choice は従来通り
      // Options に載る。
      ...(this.#model !== null && this.#modelSource !== "default"
        ? { model: this.#model }
        : {}),
      ...(this.#effort !== null && this.#effortSource !== "default"
        ? { effort: this.#effort as EffortLevel }
        : {}),
      hooks: {
        ...userHooks,
        CwdChanged: [
          ...(userHooks.CwdChanged ?? []),
          {
            hooks: [
              async (input) => {
                this.#applyCwdChanged(input);
                return {};
              },
            ],
          },
        ],
      },
      // Set last so queryOptions can never override the hook that drives
      // waiting_permission.
      canUseTool: (toolName, input) => this.#canUseTool(toolName, input),
    };
    const session = this.#queryFn({ prompt: this.#input(), options });
    this.#query = session;
    // The SDK stamps a session_id on every message; report it before deriving
    // state so the envelopes this message produces already carry it. Forward
    // only on change — the id is stable within a conversation (ADR-0014).
    for await (const message of session) {
      const id = sdkMessageToSessionId(message);
      if (id !== null && id !== this.#sessionId) {
        this.#sessionId = id;
        this.#options.onSessionId?.(id);
      }

      // Capture Claude Code status meta (#16) before deriving state, so the
      // next state_change envelope carries the latest. Rate-limit events
      // arrive inline; context usage is pulled fire-and-forget so the control
      // round-trip never blocks (or stalls) the message loop.
      const initMeta = sdkMessageToInitMeta(message);
      if (initMeta) {
        this.#applyInitMeta(initMeta);
        // The session is initialized once init meta lands, so the
        // supportedModels control request can resolve; fetch it once (#54).
        void this.#refreshSupportedModels();
        // Context usage is also reachable once init lands (ADR-0040 phase-21).
        // Use the init-time bounded-retry helper so a transient control-request
        // race gets one more shot before we fall back to result-time refresh
        // — otherwise the "ctx" meter would spin until the first turn ends.
        void this.#refreshContextUsageForInit();
      }
      const rateLimit = sdkMessageToRateLimit(message);
      if (rateLimit) this.#applyRateLimit(rateLimit);
      const statusMeta = sdkMessageToStatusMeta(message);
      if (statusMeta?.permission_mode !== undefined) {
        this.#permissionMode = statusMeta.permission_mode;
      }
      const resultMeta = sdkMessageToResultMeta(message);
      if (resultMeta?.fast_mode !== undefined) {
        this.#fastMode = resultMeta.fast_mode;
      }
      if (message.type === "result") {
        void this.#refreshContextUsage();
        // Turn-boundary retry for supportedModels() when init-time fetch or
        // an earlier retry failed. Guarded internally against overrun of
        // MAX_MODEL_REFRESH_RETRIES and post-success no-ops.
        void this.#refreshSupportedModels();
      }

      // State first, so a log envelope carries the state this message
      // settled into; then relay the message's reply lines.
      for (const event of sdkMessageToEvents(message)) this.#apply(event);
      for (const entry of sdkMessageToLogs(message)) this.#emitLog(entry);
      // Compaction / conversation-reset notices (phase-28 A1, #168). Emitted
      // as their own log line rather than folded into sdkMessageToLogs: that
      // mapper is shared with resume history reconstruction (history.ts), and
      // these are live-session observations, not transcript content.
      const compact = sdkMessageToCompactNotice(message);
      if (compact) {
        this.#emitLog({ kind: "system", text: compact.text });
        // A boundary or a reset ENDS the context epoch the current reading
        // belongs to; `compacting` / a failed `compact_result` do not (nothing
        // was discarded yet). 藤 review MF1.
        if (
          compact.kind === "compact_boundary" ||
          compact.kind === "conversation_reset"
        ) {
          this.#invalidateContextEpoch(compact.tokens);
        }
      }
      const result = sdkMessageToResult(message);
      if (result) {
        this.#emitResult(result, sdkMessageToCost(message));
        // issue #131 must-fix 1: resolve exactly the conversation #input()
        // tagged this turn with — never sweep whatever else is pending.
        const conversationId = this.#currentTurnConversationId;
        if (result.is_error) {
          const terminalReason = sdkMessageToTerminalReason(message);
          this.#options.onTurnEnd?.({
            conversationId,
            error: {
              ...(terminalReason !== undefined ? { reason: terminalReason } : {}),
              ...(result.error_detail !== undefined
                ? { detail: result.error_detail }
                : {}),
            },
          });
        } else {
          this.#options.onTurnEnd?.({ conversationId });
        }
        this.#toolNames.clear();
      }
    }
  }

  async #canUseTool(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> {
    // AskUserQuestion arrives via canUseTool too, but needs a structured
    // dialog and a structured answer, not allow/deny (ADR-0027). Branch to the
    // question path when a decider is wired; else fall through to allow/deny.
    const decideQuestion = this.#options.decideQuestion;
    if (toolName === "AskUserQuestion" && decideQuestion) {
      return this.#askUserQuestion(decideQuestion, input);
    }
    const decide = this.#options.decidePermission;
    // Kick off the decider FIRST so it (synchronously, in the broker
    // case) calls setPendingPermission before we transition the state
    // machine. The resulting state_change(waiting_permission) then carries
    // ext.pending_permission in a single envelope (ADR-0022 F3) — no
    // empty-then-stamped flicker. Fail closed: deny when no decider is
    // wired.
    const decisionPromise: Promise<PermissionDecision> = decide
      ? Promise.resolve(decide(toolName, input))
      : Promise.resolve({ allow: false });
    this.#apply({ kind: "permission_request" });
    try {
      const decision = await decisionPromise;
      return decision.allow
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: decision.message ?? "denied" };
    } catch {
      // A throwing decider denies safely rather than crashing the session.
      return { behavior: "deny", message: "permission decision failed" };
    } finally {
      // Broker has already cleared pending in its settle path; the
      // permission_resolved state_change just needs to emit. A decider
      // that did NOT touch pending leaves the prior value untouched, so
      // belt-and-braces null it here too in case of a custom decider.
      this.#pendingPermission = null;
      this.#apply({ kind: "permission_resolved" });
    }
  }

  /** AskUserQuestion branch of #canUseTool (ADR-0027). Mirrors the permission
   *  path: kick off the decider first (it stamps ext.pending_question via
   *  setPendingQuestion), transition to waiting_question, then return the
   *  operator's answers to the SDK as updatedInput.answers — or deny on
   *  cancellation / error. */
  async #askUserQuestion(
    decide: (
      questions: Question[],
    ) => Promise<QuestionDecision> | QuestionDecision,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> {
    const questions = Array.isArray(input.questions)
      ? (input.questions as Question[])
      : [];
    const decisionPromise = Promise.resolve(decide(questions));
    this.#apply({ kind: "question_request" });
    try {
      const decision = await decisionPromise;
      if (decision.cancelled) {
        return { behavior: "deny", message: "kaoiro: question cancelled" };
      }
      return {
        behavior: "allow",
        updatedInput: { ...input, answers: decision.answers ?? {} },
      };
    } catch {
      return { behavior: "deny", message: "question decision failed" };
    } finally {
      this.#pendingQuestion = null;
      this.#apply({ kind: "question_resolved" });
    }
  }

  #apply(event: AdapterEvent): void {
    const { next, emitted } = stepState(this.#machine, event);
    this.#machine = next;
    for (const state of emitted) {
      this.#emitState(state);
    }
  }

  #emitState(state: KaoiroState): void {
    this.#options.onState(
      makeStateChange(
        this.#config,
        state,
        this.#now(),
        {},
        this.#statusExt(true),
      ),
    );
  }

  /** Non-consuming ext snapshot for the CLI's synthetic initial idle
   * envelope. Unlike initialStatusExt(), this includes resolved startup and
   * resume fields already known by the constructed host. */
  statusExtSnapshot(): Record<string, unknown> {
    return this.#statusExt(false);
  }

  /** Current Claude Code status meta as an ext object (#16). Empty keys are
   *  omitted so an envelope only carries what the SDK has surfaced so far.
   *  pending_permission is the authoritative pending-record (ADR-0022)
   *  carried while waiting_permission is in flight. */
  #statusExt(consumeOneShot = false): Record<string, unknown> {
    const effectiveStatus = this.#effectiveStatusSnapshot();
    const ext: Record<string, unknown> = {
      ...initialStatusExt(),
      ...effectiveStatusEnvelopeFields(effectiveStatus),
    };
    // Session capabilities (ADR-0034 F1/F4, phase-15 15-14): advertised
    // from the first state_change onward (no SDK init await). Claude Code
    // accepts uploads and provides the SDK's
    // native AskUserQuestion — both true unconditionally today. If the
    // SDK later attaches conditions, split the constants into fields
    // and update them from init / status meta.
    // supports_session_reset (ADR-0036 F5, phase-17 17-6 flip): with the
    // runner supervisor's fresh relaunch + rollback + snapshot re-apply
    // (17-5) and the server's SessionResets orchestration + two-phase
    // completion (17-4/5) landed, the session now provides the F2
    // fresh-relaunch + completion handshake required to advertise this
    // as `true`. Both modes are supported: `new` keeps the log ring +
    // adds a boundary marker, `clear` resets the display projection
    // before appending its boundary. The dashboard's Composer intercept
    // (chunk δ 17-8) is the last piece; until that lands the ordinary
    // send_instruction path handles `/new`・`/clear` as reserved-command
    // rejects, so the capability=true stamp is safely observable but
    // does not yet reach a user-triggerable code path.
    if (this.#effortPending !== null) ext.pending_effort = this.#effortPending;
    if (this.#effortResetOnce) {
      ext.effort_reset = true;
      if (consumeOneShot) this.#effortResetOnce = false;
    }
    if (this.#switchErrorOnce !== null) {
      ext.switch_error = this.#switchErrorOnce;
      if (consumeOneShot) this.#switchErrorOnce = null;
    }
    if (this.#models !== null && this.#model !== null) {
      const activeModels = this.#findCatalogEntries(this.#model);
      if (activeModels.length > 0) {
        const activeEffortLevels = this.#effortLevelsForCatalogEntries(activeModels);
        const caps = ext.session_capabilities as Record<string, unknown>;
        ext.session_capabilities = {
          ...caps,
          supports_effort_switch: activeEffortLevels.length > 0,
        };
      }
    }
    if (this.#cwd !== null) ext.cwd = this.#cwd;
    if (this.#slashCommands !== null) ext.slash_commands = this.#slashCommands;
    if (this.#models !== null) ext.models = this.#models;
    // Deliberately NOT one-shot (contrast with effort_reset / switch_error
    // above, which consume via consumeOneShot). Rationale: those are discrete
    // events — a late-connecting operator does not need to see them replayed.
    // models_error is a PERSISTENT state — the wrapper is stuck on the floor
    // catalog until refresh_models (phase-18-5) resets the retry state — so a
    // reconnecting client MUST see it too, otherwise they will read the floor
    // default as the account's real catalog (ADR-0037 F1 keeps ext.models
    // valid throughout; this flag is the ONLY signal that fetch has given up).
    // If future work makes this one-shot, the reconnect path breaks silently.
    if (
      this.#modelsRetryCount >= MAX_MODEL_REFRESH_RETRIES &&
      !this.#modelsSucceeded
    ) {
      ext.models_error = true;
    }
    if (this.#context !== null) ext.context = this.#context;
    if (this.#rateLimits.size > 0) {
      ext.rate_limits = Object.fromEntries(this.#rateLimits);
    }
    if (this.#pendingPermission !== null) {
      ext.pending_permission = this.#pendingPermission;
    }
    if (this.#pendingQuestion !== null) {
      ext.pending_question = this.#pendingQuestion;
    }
    if (this.#resumeSnapshot !== null) {
      ext.resume_snapshot = this.#resumeSnapshot;
      ext.resume_drift = computeResumeDrift(
        this.#resumeSnapshot,
        effectiveStatus.resolved,
      ).filter((entry) => !this.#operatorSwitchedFields.has(entry.field));
    }
    return ext;
  }

  /** Records the active model, working directory, and slash commands from
   *  session init (#16, #34). */
  #applyInitMeta(meta: {
    model?: string;
    cwd?: string;
    slash_commands?: string[];
    permission_mode?: string;
    fast_mode?: string;
  }): void {
    if (meta.model !== undefined) {
      this.#model = meta.model;
      // When the wrapper had no explicit source at startup, this init is the
      // SDK's own default (or a mid-session setModel confirmation); stamp
      // "default" so UI stops treating the value as "not yet reported".
      // Explicit source (launch / env / config) is maintained — the field
      // reports the value's origin, not the SDK's confirmation of it.
      if (this.#modelSource === null) {
        this.#modelSource = "default";
      }
    }
    if (meta.cwd !== undefined) this.#cwd = meta.cwd;
    if (meta.slash_commands !== undefined) {
      this.#slashCommands = meta.slash_commands;
    }
    if (meta.permission_mode !== undefined) {
      this.#permissionMode = meta.permission_mode;
    }
    if (meta.fast_mode !== undefined) this.#fastMode = meta.fast_mode;
  }

  /** Records the latest rate-limit snapshot for its window (#16). */
  #applyRateLimit(info: SDKRateLimitInfo): void {
    // The SDK's weekly event gained `seven_day_overage_included`. It is the
    // same weekly subscription window for the operator-facing meter; keeping
    // it as a separate raw key makes it invisible to the stable dashboard
    // seven_day row.
    const window =
      info.rateLimitType === "seven_day_overage_included"
        ? "seven_day"
        : info.rateLimitType;
    if (window === undefined) return;
    const previous = this.#rateLimits.get(window);
    const nextReset =
      typeof info.resetsAt === "number" && Number.isFinite(info.resetsAt)
        ? info.resetsAt
        : undefined;
    // A reset timestamp identifies the quota window. A partial event without
    // it is an update to that known window, so retaining utilization is safe.
    // Conversely, a finite new timestamp denotes a new window: never carry
    // old utilization into it unless this event provides a fresh value.
    const resetChanged = nextReset !== undefined && previous?.resets_at !== nextReset;
    const snapshot: {
      status?: string;
      utilization?: number;
      resets_at?: number;
    } = resetChanged ? { status: info.status } : { ...previous, status: info.status };
    // `allowed` refreshes commonly omit both utilization and resetsAt. Such a
    // no-reset partial update keeps the last measured value; a reset change
    // above intentionally starts a fresh snapshot instead.
    if (typeof info.utilization === "number" && Number.isFinite(info.utilization)) {
      snapshot.utilization = info.utilization;
    }
    if (nextReset !== undefined) {
      snapshot.resets_at = nextReset;
    }
    this.#rateLimits.set(window, snapshot);
  }

  /** Fetches the selectable model list (#54, ADR-0020, ADR-0037 F6). Called
   *  fire-and-forget from init (first-chance) and from every result message
   *  (turn-driven retry). A single success caches the catalog for the rest of
   *  the session; failures count toward MAX_MODEL_REFRESH_RETRIES trials, and
   *  once the cap is reached the host stays silent until Phase 18-5's manual
   *  retry resets it. #query being unavailable is not counted as a trial —
   *  the SDK Query is racy at startup and a missing query is not a failure. */
  async #refreshSupportedModels(): Promise<void> {
    if (this.#modelsSucceeded) return;
    if (this.#modelsInflight) return;
    if (this.#modelsRetryCount >= MAX_MODEL_REFRESH_RETRIES) return;
    const current = this.#query;
    if (!current) return;
    this.#modelsInflight = true;
    this.#modelsRetryCount += 1;
    try {
      const models = await current.supportedModels();
      if (!models) return;
      this.#models = models.map((m) => ({
        value: m.value,
        display_name: m.displayName,
        description: m.description,
        ...(m.supportedEffortLevels
          ? { effort_levels: m.supportedEffortLevels }
          : {}),
        // Read-only metadata (ADR-0037 追補): absent when the SDK omits
        // resolvedModel, so ext.models keeps its pre-field shape. `""` is
        // not a canonical wire ID and collapses to absent (unknown) too.
        ...(typeof m.resolvedModel === "string" && m.resolvedModel.length > 0
          ? { resolved_model: m.resolvedModel }
          : {}),
      }));
      this.#modelsSucceeded = true;
      this.#validatePersistModelAgainstCatalog();
    } catch {
      if (this.#modelsRetryCount >= MAX_MODEL_REFRESH_RETRIES) {
        // Diagnostic breadcrumb for dogfood: after the cap the host stays
        // silent, so surface the give-up moment once. Per-retry noise is
        // intentionally omitted.
        process.stderr.write(
          "claude-code: supportedModels() failed " +
            `${MAX_MODEL_REFRESH_RETRIES}× in a row; giving up until manual retry\n`,
        );
      }
    } finally {
      this.#modelsInflight = false;
    }
  }

  /** Validates a persisted `#model` (spawn config / env / resume snapshot)
   *  against the SDK's measured catalog once #refreshSupportedModels() has
   *  populated it (ADR-0037 F8, phase-18-7). A persisted alias or canonical
   *  ID that the account no longer entitles — Anthropic drops a model, the
   *  operator's plan changes, a resume snapshot outlives its catalog — is dropped to
   *  `"default"` (BOOTSTRAP floor, always in the SDK catalog) and reported
   *  once via `#switchErrorOnce` for UI feedback. Runs only in the
   *  refresh-success branch, so the FIRST turn before that success can still
   *  hit the SDK with a stale input string and be rejected there — accepted trade-off
   *  under the pre-init chicken-and-egg (there is no earlier point to see the
   *  measured catalog). Operator-explicit setModel with a floor-out value at
   *  pre-init stays a loud throw (`setModel` L717-725) — that is a dashboard
   *  bug path, not a persist path, and warrants fail-fast. */
  #validatePersistModelAgainstCatalog(): void {
    if (this.#persistedModel === null) return;
    const requested = this.#persistedModel;
    // Consume once — the snapshot represents a spawn-time input, not a
    // running state, so we should not re-fire on a later manual-retry
    // refresh cycle. Manual retry that legitimately wants to re-validate
    // could re-seed #persistedModel; the current UX has no such path.
    this.#persistedModel = null;
    if (this.#findCatalogEntries(requested).length > 0) return;
    this.#model = "default";
    // Paired reset: the explicit source (config / env / launch) that
    // supplied the alias no longer owns the effective value, mirroring the
    // #model / #modelSource pair that #applyInitMeta and setModel's
    // invalidEffort branch both maintain. Without this, ext.model_source
    // would keep reporting the original source even though its choice was
    // silently discarded, misleading whoami / dashboard consumers.
    this.#modelSource = "default";
    this.#switchErrorOnce = {
      kind: "model",
      requested,
      reason: "persist_alias_unknown",
      rolled_back_to: "default",
    };
  }

  /** Finds the catalog rows for an alias or the canonical model ID reported
   *  by the SDK. A value-exact hit is one row and always wins. Otherwise all
   *  non-empty resolved_model matches are returned so callers can derive a
   *  conservative shared effort domain. Keep this metadata-only — callers
   *  continue sending the string they were given to the SDK. */
  #findCatalogEntries(key: string): SupportedModel[] {
    const exact = this.#models.find((model) => model.value === key);
    if (exact !== undefined) return [exact];
    return this.#models.filter(
      (model) =>
        typeof model.resolved_model === "string" &&
        model.resolved_model.length > 0 &&
        model.resolved_model === key,
    );
  }

  /** Derives the effort domain for catalog matches. A value-exact lookup has
   *  one row; canonical fallback can have several and only exposes their
   *  intersection. Missing effort_levels in any canonical row fails closed. */
  #effortLevelsForCatalogEntries(models: readonly SupportedModel[]): EffortLevel[] {
    const first = models[0];
    if (first === undefined || first.effort_levels === undefined) return [];
    if (models.length === 1) return [...first.effort_levels];
    if (models.some((model) => model.effort_levels === undefined)) return [];
    return first.effort_levels.filter((level) =>
      models.slice(1).every((model) => model.effort_levels?.includes(level)),
    );
  }

  /** Manual retry of supportedModels() (ADR-0037 F6, phase-18-5). Resets the
   *  bounded-retry counter and the succeeded-cache so #refreshSupportedModels
   *  will attempt a fresh fetch on the next tick, even after the auto-retry
   *  cap was reached. Invoked from cli.ts on the server's `refresh_models`
   *  control message. Kicks the async fetch fire-and-forget — nothing to await. */
  retrySupportedModels(): void {
    this.#modelsRetryCount = 0;
    this.#modelsSucceeded = false;
    void this.#refreshSupportedModels();
  }

  /** In-flight dedup for `refreshCatalogFor` (ADR-0039 F9 v2). Concurrent
   *  manual refresh callers coalesce onto ONE execution but each caller
   *  gets its own `refresh_models_result` envelope emitted by cli.ts. */
  #refreshInFlight: Promise<{
    ok: boolean;
    reason?: RefreshModelsFailReason;
    models_count?: number;
  }> | null = null;

  /** Manual `refresh_models` completion path (ADR-0039 F9 v2 = 藤 review
   *  turn-7 D2a). Concurrency-safe: dedups to a single execution; each
   *  caller receives the shared outcome, cli.ts emits a per-request
   *  refresh_models_result envelope. On success: replaces `#models`,
   *  clears the retry cap, and emits a fresh state_change so the paired
   *  AgentDetail's model/effort switches repopulate WITHOUT waiting for
   *  the next natural state transition (fresh-idle wrappers otherwise
   *  never move). On failure: keeps the previous `#models` (last-known
   *  good) so the operator does not regress to the bootstrap floor. */
  async refreshCatalogFor(): Promise<{
    ok: boolean;
    reason?: RefreshModelsFailReason;
    models_count?: number;
  }> {
    if (this.#refreshInFlight !== null) return this.#refreshInFlight;
    this.#refreshInFlight = this.#executeManualRefresh().finally(() => {
      this.#refreshInFlight = null;
    });
    return this.#refreshInFlight;
  }

  async #executeManualRefresh(): Promise<{
    ok: boolean;
    reason?: RefreshModelsFailReason;
    models_count?: number;
  }> {
    // Reset the retry cap so a fresh attempt runs even after the auto-retry
    // path gave up (same intent as retrySupportedModels()).
    this.#modelsRetryCount = 0;
    this.#modelsSucceeded = false;

    if (this.#query !== null) {
      // Live Query available → SDK.supportedModels() is authoritative.
      // #refreshSupportedModels swallows errors internally and sets
      // #modelsSucceeded on success. We inspect that flag rather than
      // duplicating the SDK call here.
      try {
        await this.#refreshSupportedModels();
      } catch {
        // Belt-and-braces: #refreshSupportedModels already catches internally,
        // but never-reject contract (藤 review turn-10 must-fix 2) means
        // we must not surface a stray throw either.
      }
      if (this.#modelsSucceeded) {
        this.#emitState(this.#machine.state);
        return { ok: true, models_count: this.#models.length };
      }
      return { ok: false, reason: "cli_error" };
    }

    // Fresh-idle wrapper (#query still null under deferQueryUntilFirstInput):
    // fall back to the shared short-lived probe subprocess so the SAME
    // AgentDetail can be updated without waiting for the operator's first
    // instruction. Reuses wrapper/claude-code/src/probe-client to keep the
    // launcher single-sourced across runner and wrapper (藤 D1b).
    //
    // Wrap in try/catch so an injected probeFn (test) or a real subprocess
    // throw is converted to a structured failure — never-reject contract
    // per 藤 review turn-10 must-fix 2. Without this, refreshCatalogFor()'s
    // shared promise would reject, `#refreshInFlight`'s `.finally` still
    // clears state so the NEXT call retries, but the current caller's
    // paired refresh_models_result envelope would never emit and the client
    // spinner would spin until the 45s client-side timeout.
    let outcome: ProbeOutcome;
    try {
      outcome = await this.#probeFn();
    } catch (err) {
      return {
        ok: false,
        reason: "cli_error",
        models_count: this.#models.length,
        // Reason vocab is the closed set; the raw message goes nowhere.
        // Last-known catalog is preserved because `#models` was never
        // reassigned in this branch.
        ...(err instanceof Error ? {} : {}),
      };
    }
    if (outcome.ok && outcome.models !== undefined && outcome.models.length > 0) {
      // Defensive copy per row so a downstream mutation cannot bleed back
      // through the shared array reference.
      this.#models = outcome.models.map((m) => ({
        value: m.value,
        display_name: m.display_name,
        description: m.description,
        ...(m.effort_levels ? { effort_levels: [...m.effort_levels] } : {}),
        ...(m.default_effort ? { default_effort: m.default_effort } : {}),
        // Same absent = unknown contract as the live-SDK mapping above; an
        // empty id from a stale/foreign probe payload is dropped here too.
        ...(typeof m.resolved_model === "string" && m.resolved_model.length > 0
          ? { resolved_model: m.resolved_model }
          : {}),
      })) as SupportedModel[];
      this.#modelsSucceeded = true;
      this.#validatePersistModelAgainstCatalog();
      this.#emitState(this.#machine.state);
      return { ok: true, models_count: this.#models.length };
    }
    return {
      ok: false,
      reason: (outcome.reason as RefreshModelsFailReason) ?? "cli_error",
    };
  }

  /** Pulls the current context-window usage (#16, ADR-0040 phase-21).
   *  Best-effort: the SDK control request can be unavailable, so any failure
   *  is swallowed.
   *
   *  Concurrency contract (藤 review turn-3 must-fix C):
   *  - inflight guard: only one live call at a time; overlapping triggers
   *    (init / result / model switch) set `#contextRefreshPending` and the
   *    `finally` re-kicks so no caller stalls until the next natural trigger.
   *  - generation guard: on completion, compare captured generation vs
   *    `#contextGeneration`; a mismatch (model switch happened while we
   *    awaited) drops the result. The re-kick in `finally` then fetches
   *    the fresh generation.
   *  - dedup: `#emitState` fires ONLY when the snapshot actually changed,
   *    so a same-value refresh does not spam state_change envelopes.
   *  - close guard: never re-kick after `close()`. */
  async #refreshContextUsage(): Promise<void> {
    if (this.#contextInflight) {
      this.#contextRefreshPending = true;
      return;
    }
    this.#contextInflight = true;
    const generation = this.#contextGeneration;
    try {
      const usage = await this.#query?.getContextUsage();
      // Stale result: model switched (or session closed) while we awaited.
      // Discard so a fresh-generation refresh (queued by the finally block)
      // is the one that lands in `#context`.
      if (this.#closed || generation !== this.#contextGeneration) return;
      if (!usage) return;
      const next = {
        used_tokens: usage.totalTokens,
        max_tokens: usage.maxTokens,
        used_percentage: usage.percentage,
      };
      if (typeof usage.model === "string" && usage.model !== "") {
        this.#model = usage.model;
        // Same source semantics as #applyInitMeta: if the wrapper had no
        // explicit source at startup, the model that surfaces here (a result
        // message may fire this before init) is the SDK's own default —
        // stamp "default" so ext.model never ships without ext.model_source.
        if (this.#modelSource === null) {
          this.#modelSource = "default";
        }
      }
      const prev = this.#context;
      const changed =
        prev === null ||
        prev.used_tokens !== next.used_tokens ||
        prev.max_tokens !== next.max_tokens ||
        prev.used_percentage !== next.used_percentage;
      this.#context = next;
      // Runs on EVERY successful reading of this generation, deliberately
      // ahead of the equality dedup (BR MF1-R2). The settling gate counts
      // MEASUREMENTS, not value changes: a compaction that leaves usage
      // pinned at the same high number produces identical readings, and
      // gating this on `changed` would stall the liveness bound exactly in
      // the case it exists for. Re-notification is already bounded by
      // `#contextNoticeSent`, so the notice cannot spam either.
      this.#maybeNotifyContextThreshold(next);
      // The emit, by contrast, IS deduped — a same-value refresh has nothing
      // new to announce and would only spam state_change envelopes.
      if (!changed) return;
      // Authoritative stamp rides #statusExt on every state_change (L1233);
      // this explicit re-emit satisfies the "取得成功時の即時反映" contract
      // (藤 review turn-3 S7) without waiting for the next natural transition.
      this.#emitState(this.#machine.state);
    } catch {
      // Context usage is optional telemetry; never disrupt the session.
    } finally {
      this.#contextInflight = false;
      // Re-run if a caller hit the guard while we were awaiting, OR the
      // generation moved (our result was stale-dropped above; a fresh fetch
      // is needed for the current generation).
      const shouldReRun =
        this.#contextRefreshPending ||
        generation !== this.#contextGeneration;
      this.#contextRefreshPending = false;
      if (shouldReRun && !this.#closed) {
        void this.#refreshContextUsage();
      }
    }
  }

  /** Closes the current context-usage epoch and opens the next one
   *  (phase-28 A1, 藤 review MF1). Same three steps setModel() runs when the
   *  model — and with it the context window — changes, in the same order:
   *
   *  1. bump `#contextGeneration` FIRST, so any refresh already awaiting the
   *     SDK mismatches on completion and its pre-boundary reading is dropped
   *     instead of landing in `#context` after the epoch it measured ended;
   *  2. null `#context`, so `#statusExt` stops stamping the stale number;
   *  3. re-emit state when there WAS a reading, retracting `ext.context` from
   *     the operator's view. Without this a failed follow-up refresh would
   *     leave the pre-compact figure on screen and in whoami indefinitely —
   *     "unknown" is the honest reading between epochs, not the old value.
   *
   *  The follow-up refresh is the eventual meter update only: Track S measured
   *  `getContextUsage()` right after a boundary still reporting the PRE-compact
   *  total, so the freed-token numbers the operator reads come from the
   *  boundary metadata in the log line, not from here. */
  #invalidateContextEpoch(tokens?: { pre?: number; post?: number }): void {
    const hadReading = this.#context !== null;
    // Arm the settling gate for the epoch now opening (BR MF1-R). The bound
    // comes from the boundary's own metadata, never from a cached reading:
    // a cached reading may be missing or itself stale, whereas the event
    // states what the context became. post_tokens is the exact new total, so
    // a reading at or below it is proof; with only pre_tokens the best that
    // can be said is "not the stale value", hence pre - 1.
    this.#contextEpochGate = {
      atOrBelow:
        tokens?.post ?? (tokens?.pre !== undefined ? tokens.pre - 1 : null),
      readings: 0,
    };
    this.#contextGeneration += 1;
    this.#context = null;
    // New epoch, new notice budget (phase-28 B1).
    this.#contextNoticeSent = false;
    if (hadReading) this.#emitState(this.#machine.state);
    void this.#refreshContextUsage();
  }

  /** Queues the one threshold notice this context epoch is allowed
   *  (phase-28 B1, #168 P3). Called from `#refreshContextUsage` on every
   *  reading that actually changed, so the notice lands the first time usage
   *  crosses the line and never again until the epoch ends.
   *
   *  Two guards beyond the per-epoch dedup (BR MF1 / MF1-R / MF2):
   *
   *  - a freshly-opened epoch is muted until `#settleContextEpoch` says its
   *    readings can be believed; right after a compaction the SDK still
   *    reports the pre-compact total, and warning on that would nag the agent
   *    about usage it just compacted away;
   *  - the injection rides the caller-supplied serialization (cli.ts's
   *    instruction chain — the same one operator / inter-agent / B2 turns use)
   *    and re-checks the epoch when the chain reaches it, so a notice queued
   *    behind a slow send is dropped rather than carried across a boundary.
   *
   *  It is still an ordinary queued turn: nothing interrupts and nothing is
   *  injected mid-turn (ADR-0036 F6 stays intact). */
  #maybeNotifyContextThreshold(reading: {
    used_tokens: number;
    used_percentage: number;
  }): void {
    if (!this.#settleContextEpoch(reading.used_tokens)) return;
    if (this.#contextNoticeSent) return;
    if (reading.used_percentage < CONTEXT_NOTICE_THRESHOLD_PERCENT) return;
    // Claim the budget BEFORE the async send so two refreshes resolving in
    // the same tick cannot both queue a notice.
    this.#contextNoticeSent = true;
    const generation = this.#contextGeneration;
    const text = contextNoticeText(reading.used_percentage);
    void this.#enqueueInjection(async () => {
      // The chain may have held us across a compaction the agent already
      // acted on. Injecting now would deliver the old epoch's warning into
      // the new one, which is exactly what the operator just fixed.
      if (this.#closed || generation !== this.#contextGeneration) return;
      await this.send(text);
    }).catch((err: unknown) => {
      // Closed or full queue. Re-arm rather than burning the epoch's one
      // notice on a send that never reached the model — but only while the
      // epoch that claimed the budget is still current. A late rejection
      // from a previous epoch must not unset the flag the new epoch owns.
      if (generation === this.#contextGeneration) {
        this.#contextNoticeSent = false;
      }
      process.stderr.write(
        `context threshold notice not queued: ${String(err)}\n`,
      );
    });
  }

  /** Answers whether this reading can be trusted to describe the current
   *  context epoch, consuming one of the gate's allowance in the process
   *  (phase-28 BR MF1-R). True once the epoch has settled — which is the
   *  steady state, so the ordinary path is a single null check.
   *
   *  A settled epoch NEVER re-arms here: only `#invalidateContextEpoch()`
   *  opens a gate, so a later reading cannot silently re-mute the notice. */
  #settleContextEpoch(usedTokens: number): boolean {
    const gate = this.#contextEpochGate;
    if (gate === null) return true;
    gate.readings += 1;
    const provenFresh = gate.atOrBelow !== null && usedTokens <= gate.atOrBelow;
    // Liveness backstop: readings are discrete samples, so an epoch can grow
    // past `atOrBelow` between two of them and never be caught below it.
    // Without this the gate would stay shut for the whole epoch (BR MF1-R).
    const allowanceSpent = gate.readings >= CONTEXT_EPOCH_SETTLE_READINGS;
    if (!provenFresh && !allowanceSpent) return false;
    this.#contextEpochGate = null;
    return true;
  }

  /** Runs `task` on the caller-supplied injection queue when one was wired
   *  (cli.ts serialises every instruction through a single promise chain so a
   *  slow render cannot let a later turn reach the SDK input stream first).
   *  With no queue — unit tests, embedders — it runs inline, which preserves
   *  the pre-MF2 behaviour. */
  #enqueueInjection(task: () => Promise<void>): Promise<void> {
    const enqueue = this.#options.enqueueInjection;
    return enqueue ? enqueue(task) : task();
  }

  /** Init-time refresh with a small bounded retry (ADR-0040 phase-21,
   *  藤 review turn-3 must-fix D). One initial attempt + one retry after
   *  CONTEXT_INIT_RETRY_DELAY_MS if the first came back empty. Bounded so
   *  a persistent SDK failure falls back cleanly to the result-time refresh
   *  (host.ts run() loop L1049); scoped to the captured generation so a
   *  model switch or close() aborts the retry cleanly. */
  async #refreshContextUsageForInit(): Promise<void> {
    const generation = this.#contextGeneration;
    await this.#refreshContextUsage();
    if (
      this.#closed ||
      generation !== this.#contextGeneration ||
      this.#context !== null
    ) {
      return;
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, CONTEXT_INIT_RETRY_DELAY_MS),
    );
    if (this.#closed || generation !== this.#contextGeneration) return;
    await this.#refreshContextUsage();
  }

  /** Builds the log payload (size-clipped) and relays it via onLog. */
  #emitLog(entry: LogEntry): void {
    const onLog = this.#options.onLog;
    if (!onLog) return;
    onLog(
      makeLog(
        this.#config,
        this.#machine.state,
        this.#now(),
        logEntryToPayload(entry, this.#toolNames),
      ),
    );
  }

  /** Relays the turn's final reply via onLog (result envelope). The session's
   *  cumulative cost, when known, rides along in ext.cost (#8). */
  #emitResult(payload: ResultPayload, cost: number | null): void {
    const onLog = this.#options.onLog;
    if (!onLog) return;
    const out: ResultPayload = {};
    // result payload has no truncated flag (protocol.md); clip silently
    // to stay under the server's envelope cap.
    if (typeof payload.text === "string")
      out.text = clipText(payload.text).text;
    if (payload.is_error) out.is_error = true;
    // issue #127: only forward error metadata on error results. The
    // adapter never sets these on success, but the guard keeps the wire
    // payload minimal even if a future caller reuses this shape.
    if (typeof payload.error_subtype === "string") {
      out.error_subtype = payload.error_subtype;
    }
    if (typeof payload.error_detail === "string") {
      out.error_detail = clipText(payload.error_detail).text;
    }
    const ext = cost !== null ? { cost } : {};
    onLog(makeResult(this.#config, this.#now(), out, ext));
  }

  async *#input(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.#queue.length > 0) {
        // Shift in lockstep with #queue (issue #131 must-fix 1) so the tag
        // always names the turn about to be fed to the SDK, not a stale one.
        this.#currentTurnConversationId = this.#turnConversationIds.shift() ?? null;
        yield this.#queue.shift() as SDKUserMessage;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#notify = resolve;
      });
    }
  }

  /** Wait without consuming the first queued turn. #input() will drain it
   * after Query construction; close() shares #wake and ends the idle wait. */
  async #waitForFirstInput(): Promise<void> {
    while (this.#queue.length === 0 && !this.#closed) {
      await new Promise<void>((resolve) => {
        this.#notify = resolve;
      });
    }
  }

  #wake(): void {
    const notify = this.#notify;
    this.#notify = null;
    notify?.();
  }
}
