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
  Envelope,
  InstructionRejectedPayload,
  KaoiroState,
  LogEntry,
  PendingPermissionExt,
  PermissionMode,
  ResultPayload,
  WrapperConfig,
} from "./types.js";
import type { MachineState } from "./state.js";
import {
  initialMachineState,
  makeAttachRejected,
  makeInstructionRejected,
  makeLog,
  makeResult,
  makeStateChange,
  stepState,
} from "./state.js";
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
import { clipText, logEntryToPayload } from "./logpayload.js";
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

/** A selectable model surfaced in state_change.ext.models (#54, ADR-0020),
 *  trimmed from the SDK's ModelInfo to the snake_case fields the dashboard
 *  needs to render the `/model` / `/effort` dialogs. effort_levels is absent
 *  for models without effort support (e.g. Haiku). */
export interface SupportedModel {
  value: string;
  display_name: string;
  description: string;
  effort_levels?: EffortLevel[];
}

export interface PermissionDecision {
  allow: boolean;
  /** Reason returned to the agent when denied. */
  message?: string;
}

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
   * Extra query options (tools, allowedTools, cwd, model, …). Merged over the
   * defaults; canUseTool is reserved by the host and cannot be overridden.
   */
  queryOptions?: Partial<Options>;
  /**
   * Persona personality prompt appended to the SDK systemPrompt via the
   * preset's `append` field (persona-personality-injection spec / ADR-0026).
   * Composed by cli.ts from the resolved persona.personality_prompt_file and
   * the common footer; the host just threads it into the SDK options.
   * Omitted = no `append` field is emitted, matching pre-#63 behaviour.
   */
  appendSystemPrompt?: string;
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
export class AgentHost {
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
   *  dialogs without a round-trip. Fetched once via supportedModels() after
   *  the session's first init; null until then. */
  #models: SupportedModel[] | null = null;
  /** Guards the one-shot supportedModels fetch so it is not re-issued per
   *  message; reset on failure to allow a later retry. */
  #modelsRequested = false;
  #context:
    | { used_tokens: number; max_tokens: number; used_percentage: number }
    | null = null;
  readonly #rateLimits = new Map<
    string,
    { status?: string; utilization?: number; resets_at?: number }
  >();
  /** Authoritative pending-permission record (ADR-0022, #59). Set by the
   *  broker via setPendingPermission() so every state_change emitted while
   *  waiting_permission carries it in ext, surviving any intermediate
   *  envelope arrival. null when no decision is in flight. */
  #pendingPermission: PendingPermissionExt | null = null;
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
  }

  get state(): KaoiroState {
    return this.#machine.state;
  }

  /** Snapshot of the calling agent's identity and current status (used by the
   *  `mcp__kaoiro__whoami` tool, protocol-inter-agent companion). Reads only
   *  local state — no server round-trip, since the wrapper holds the freshest
   *  view of these fields. Omits keys whose SDK has not yet reported a value
   *  so consumers can distinguish "unknown" from a stale stub. */
  statusSnapshot(): {
    agent_id: string;
    persona: { id: string; name: string; sprite_set: string };
    state: KaoiroState;
    model?: string;
    cwd?: string;
    permission_mode?: string;
    fast_mode?: string;
    session_id?: string;
  } {
    const out: ReturnType<AgentHost["statusSnapshot"]> = {
      agent_id: this.#config.agent_id,
      // Explicit pick: TS erases the narrower shape at runtime, so an
      // unfiltered `this.#config.persona` would leak personality_prompt_file
      // / language into wire callers (ADR-0026 "Envelope 非露出").
      persona: {
        id: this.#config.persona.id,
        name: this.#config.persona.name,
        sprite_set: this.#config.persona.sprite_set,
      },
      state: this.#machine.state,
    };
    if (this.#model !== null) out.model = this.#model;
    if (this.#cwd !== null) out.cwd = this.#cwd;
    if (this.#permissionMode !== null) out.permission_mode = this.#permissionMode;
    if (this.#fastMode !== null) out.fast_mode = this.#fastMode;
    if (this.#sessionId !== null) out.session_id = this.#sessionId;
    return out;
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
    if (newTotal > entry.meta.size || newTotal > PROTOCOL_FILE_SIZE_LIMIT_BYTES) {
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
      makeAttachRejected(this.#config, this.#machine.state, this.#now(), payload),
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
   *  No-op before the session's first turn establishes the Query. */
  async setModel(value: string): Promise<void> {
    await this.#query?.setModel(value);
  }

  /** Switch the reasoning effort for subsequent turns (#54, ADR-0020) via the
   *  apply_flag_settings control request. `level` arrives as a wire string
   *  (an effort_levels entry); symmetric with setModel, the SDK is the
   *  validator. The persisted Settings.effortLevel type stops at "xhigh", but
   *  the runtime accepts the full domain including "max" (#54 実機検証;
   *  agent-sdk-events.md model/effort 検証メモ), so the cast widens it
   *  deliberately. Next-message granularity. */
  async setEffort(level: string): Promise<void> {
    await this.#query?.applyFlagSettings({
      effortLevel: level as "low" | "medium" | "high" | "xhigh",
    });
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
   * session idles on the streaming input until `send` delivers the
   * first turn (e.g. an operator instruction relayed by the server).
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
      if (message.type === "result") void this.#refreshContextUsage();

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

  #apply(event: AdapterEvent): void {
    const { next, emitted } = stepState(this.#machine, event);
    this.#machine = next;
    for (const state of emitted) {
      this.#options.onState(
        makeStateChange(this.#config, state, this.#now(), {}, this.#statusExt()),
      );
    }
  }

  /** Current Claude Code status meta as an ext object (#16). Empty keys are
   *  omitted so an envelope only carries what the SDK has surfaced so far.
   *  pending_permission is the authoritative pending-record (ADR-0022)
   *  carried while waiting_permission is in flight. */
  #statusExt(): Record<string, unknown> {
    const ext: Record<string, unknown> = {};
    if (this.#model !== null) ext.model = this.#model;
    if (this.#cwd !== null) ext.cwd = this.#cwd;
    if (this.#slashCommands !== null) ext.slash_commands = this.#slashCommands;
    if (this.#models !== null) ext.models = this.#models;
    if (this.#context !== null) ext.context = this.#context;
    if (this.#permissionMode !== null) ext.permission_mode = this.#permissionMode;
    if (this.#fastMode !== null) ext.fast_mode = this.#fastMode;
    if (this.#rateLimits.size > 0) {
      ext.rate_limits = Object.fromEntries(this.#rateLimits);
    }
    if (this.#pendingPermission !== null) {
      ext.pending_permission = this.#pendingPermission;
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
    if (meta.model !== undefined) this.#model = meta.model;
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
    const snapshot: { status?: string; utilization?: number; resets_at?: number } =
      { status: info.status };
    if (info.utilization !== undefined) snapshot.utilization = info.utilization;
    if (info.resetsAt !== undefined) snapshot.resets_at = info.resetsAt;
    this.#rateLimits.set(window, snapshot);
  }

  /** Fetches the selectable model list once (#54, ADR-0020). Best-effort and
   *  fire-and-forget like context usage: the list is static per session, so a
   *  single success caches it and rides the next state_change in ext.models.
   *  On failure the request flag is cleared so a later turn can retry. */
  async #refreshSupportedModels(): Promise<void> {
    if (this.#modelsRequested) return;
    this.#modelsRequested = true;
    try {
      const models = await this.#query?.supportedModels();
      if (!models) return;
      this.#models = models.map((m) => ({
        value: m.value,
        display_name: m.displayName,
        description: m.description,
        ...(m.supportedEffortLevels
          ? { effort_levels: m.supportedEffortLevels }
          : {}),
      }));
    } catch {
      // Optional telemetry; allow a retry on a later turn.
      this.#modelsRequested = false;
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
    if (typeof payload.text === "string") out.text = clipText(payload.text).text;
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

  #wake(): void {
    const notify = this.#notify;
    this.#notify = null;
    notify?.();
  }
}
