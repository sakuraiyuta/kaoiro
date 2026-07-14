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
  sdkMessageToCost,
  sdkMessageToEvents,
  sdkMessageToInitMeta,
  sdkMessageToLogs,
  sdkMessageToRateLimit,
  sdkMessageToResult,
  sdkMessageToResultMeta,
  sdkMessageToSessionId,
  sdkMessageToStatusMeta,
} from "./adapter.js";
import {
  clipText,
  computeResumeDrift,
  logEntryToPayload,
} from "@kaoiro/agent-common";
import { PERMISSION_MODE_AXES } from "./permission_axes.js";
import { claudeBootstrapCatalog, type SupportedModel } from "./catalog.js";
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
    },
    models: claudeBootstrapCatalog(),
  };
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
  readonly #now: () => string;
  readonly #nowMs: () => number;
  /** setInterval handle for the TTL GC sweep, cleared in close(). null
   *  between construction and run() (sweep doesn't start until run). */
  #gcTimer: ReturnType<typeof setInterval> | null = null;

  readonly #queue: SDKUserMessage[] = [];
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
  /** Selectable models with their per-model effort levels (#54, ADR-0020);
   *  surfaced so the dashboard can build the bare `/model` / `/effort` choice
   *  dialogs without a round-trip. Starts with the optimistic bootstrap
   *  snapshot and is replaced once supportedModels() resolves after init. */
  #models: SupportedModel[] = claudeBootstrapCatalog();
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
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#nowMs = options.nowMs ?? Date.now;
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
   *  cost does not reorder concurrent instructions on the SDK queue. */
  async send(text: string, attachmentIds?: string[]): Promise<void> {
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

  /** Switch the model for subsequent turns (#54, ADR-0020). `value` is an
   *  alias from supportedModels (e.g. "opus[1m]", "sonnet", "default"); the
   *  SDK resolves it. Next-message granularity — the active turn is unaffected.
   *  Before run(), buffers the choice into the first Query's Options. */
  async setModel(value: string): Promise<void> {
    const current = this.#query;
    const nextModel = this.#models?.find((model) => model.value === value);
    const invalidEffort =
      this.#effort !== null &&
      nextModel !== undefined &&
      !(
        nextModel.effort_levels?.includes(this.#effort as EffortLevel) ?? false
      );
    // Before run(), commit into the fields used to construct query Options.
    // This closes the fresh-idle race where the dashboard can send set_model
    // after the CLI's idle announce but before #query exists.
    if (current === null) {
      if (nextModel === undefined) {
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
      const active = this.#models.find(
        (model) => model.value === (this.#model ?? "default"),
      );
      if (!(active?.effort_levels?.includes(level as EffortLevel) ?? false)) {
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
      ...(this.#model !== null ? { model: this.#model } : {}),
      ...(this.#effort !== null ? { effort: this.#effort as EffortLevel } : {}),
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
      const result = sdkMessageToResult(message);
      if (result) {
        this.#emitResult(result, sdkMessageToCost(message));
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
      const active = this.#models.find((model) => model.value === this.#model);
      if (active !== undefined) {
        const caps = ext.session_capabilities as Record<string, unknown>;
        ext.session_capabilities = {
          ...caps,
          supports_effort_switch: (active.effort_levels?.length ?? 0) > 0,
        };
      }
    }
    if (this.#cwd !== null) ext.cwd = this.#cwd;
    if (this.#slashCommands !== null) ext.slash_commands = this.#slashCommands;
    if (this.#models !== null) ext.models = this.#models;
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
    const window = info.rateLimitType;
    if (window === undefined) return;
    const snapshot: {
      status?: string;
      utilization?: number;
      resets_at?: number;
    } = { status: info.status };
    if (info.utilization !== undefined) snapshot.utilization = info.utilization;
    if (info.resetsAt !== undefined) snapshot.resets_at = info.resetsAt;
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
      }));
      this.#modelsSucceeded = true;
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

  /** Pulls the current context-window usage (#16). Best-effort: the SDK
   *  control request can be unavailable, so any failure is swallowed. */
  async #refreshContextUsage(): Promise<void> {
    try {
      const usage = await this.#query?.getContextUsage();
      if (!usage) return;
      this.#context = {
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
    } catch {
      // Context usage is optional telemetry; never disrupt the session.
    }
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
    const ext = cost !== null ? { cost } : {};
    onLog(makeResult(this.#config, this.#now(), out, ext));
  }

  async *#input(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.#queue.length > 0) {
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
