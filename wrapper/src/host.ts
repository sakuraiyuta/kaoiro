// Agent host — runs a query() session, derives state from its message stream,
// and routes tool-permission requests through canUseTool so they surface as
// waiting_permission. Streaming input (send) and interrupt are wired here.
// Authentication is inherited from the local Claude Code runtime; no API key is
// required or handled here.

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  Options,
  PermissionResult,
  Query,
  SDKRateLimitInfo,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AdapterEvent,
  Envelope,
  KaoiroState,
  LogEntry,
  LogPayload,
  ResultPayload,
  WrapperConfig,
} from "./types.js";
import type { MachineState } from "./state.js";
import {
  initialMachineState,
  makeLog,
  makeResult,
  makeStateChange,
  stepState,
} from "./state.js";
import {
  sdkMessageToCost,
  sdkMessageToEvents,
  sdkMessageToInitMeta,
  sdkMessageToLogs,
  sdkMessageToRateLimit,
  sdkMessageToResult,
} from "./adapter.js";

/** Relayed log text/output above this UTF-8 size is clipped (protocol.md
 *  truncated); oversized tool input is dropped wholesale like the
 *  permission payload. Keeps each envelope well under the server cap. */
const MAX_LOG_BYTES = 16_384;

/** Clips text to MAX_LOG_BYTES of UTF-8, flagging truncation. A cut may
 *  land mid-codepoint; toString renders the partial byte as U+FFFD,
 *  which is harmless for a transcript. */
function clipText(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= MAX_LOG_BYTES) {
    return { text, truncated: false };
  }
  const clipped = Buffer.from(text, "utf8")
    .subarray(0, MAX_LOG_BYTES)
    .toString("utf8");
  return { text: clipped, truncated: true };
}

/** Cap on queued user turns; send() throws beyond this (fail fast). */
const MAX_QUEUED_TURNS = 1000;

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
  /** SDK query() factory; injectable for tests. Defaults to the real SDK. */
  queryFn?: typeof query;
  /** ISO-8601 timestamp source; injectable for tests. */
  now?: () => string;
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
  #context:
    | { used_tokens: number; max_tokens: number; used_percentage: number }
    | null = null;
  readonly #rateLimits = new Map<
    string,
    { status?: string; utilization?: number; resets_at?: number }
  >();

  constructor(config: WrapperConfig, options: AgentHostOptions) {
    this.#config = config;
    this.#options = options;
    this.#queryFn = options.queryFn ?? query;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  get state(): KaoiroState {
    return this.#machine.state;
  }

  /** Enqueue a user turn for the streaming input. */
  send(text: string): void {
    if (this.#closed) throw new Error("agent host is closed");
    // Fail fast instead of growing without bound when nothing drains.
    if (this.#queue.length >= MAX_QUEUED_TURNS) {
      throw new Error("agent host input queue is full");
    }
    this.#queue.push({
      type: "user",
      session_id: "",
      parent_tool_use_id: null,
      message: { role: "user", content: text },
    });
    // Optimistic `sending` state (#32): raised here, where the host knows the
    // instruction was accepted, rather than waiting for an SDK message that
    // may not land until the model's first token.
    this.#apply({ kind: "user_send" });
    this.#wake();
  }

  /** Close the input stream; the session ends once the current turn drains. */
  close(): void {
    this.#closed = true;
    this.#wake();
  }

  /** Interrupt the current turn (streaming-input control request). */
  async interrupt(): Promise<void> {
    await this.#query?.interrupt();
  }

  /**
   * Start the session and consume messages until closed. With
   * `initialPrompt` the first turn starts immediately; without it the
   * session idles on the streaming input until `send` delivers the
   * first turn (e.g. an operator instruction relayed by the server).
   */
  async run(initialPrompt?: string): Promise<void> {
    if (initialPrompt !== undefined) this.send(initialPrompt);
    const options: Options = {
      permissionMode: "default",
      systemPrompt: { type: "preset", preset: "claude_code" },
      ...this.#options.queryOptions,
      // Set last so queryOptions can never override the hook that drives
      // waiting_permission.
      canUseTool: (toolName, input) => this.#canUseTool(toolName, input),
    };
    const session = this.#queryFn({ prompt: this.#input(), options });
    this.#query = session;
    for await (const message of session) {
      // Capture Claude Code status meta (#16) before deriving state, so the
      // next state_change envelope carries the latest. Rate-limit events
      // arrive inline; context usage is pulled fire-and-forget so the control
      // round-trip never blocks (or stalls) the message loop.
      const initMeta = sdkMessageToInitMeta(message);
      if (initMeta) this.#applyInitMeta(initMeta);
      const rateLimit = sdkMessageToRateLimit(message);
      if (rateLimit) this.#applyRateLimit(rateLimit);
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
    this.#apply({ kind: "permission_request" });
    try {
      const decide = this.#options.decidePermission;
      // Fail closed: deny when no decider is wired.
      const decision = decide
        ? await decide(toolName, input)
        : { allow: false };
      return decision.allow
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: decision.message ?? "denied" };
    } catch {
      // A throwing decider denies safely rather than crashing the session.
      return { behavior: "deny", message: "permission decision failed" };
    } finally {
      // Always leave waiting_permission, whatever the decider did.
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
   *  omitted so an envelope only carries what the SDK has surfaced so far. */
  #statusExt(): Record<string, unknown> {
    const ext: Record<string, unknown> = {};
    if (this.#model !== null) ext.model = this.#model;
    if (this.#cwd !== null) ext.cwd = this.#cwd;
    if (this.#context !== null) ext.context = this.#context;
    if (this.#rateLimits.size > 0) {
      ext.rate_limits = Object.fromEntries(this.#rateLimits);
    }
    return ext;
  }

  /** Records the active model and working directory from session init (#16). */
  #applyInitMeta(meta: { model?: string; cwd?: string }): void {
    if (meta.model !== undefined) this.#model = meta.model;
    if (meta.cwd !== undefined) this.#cwd = meta.cwd;
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
        this.#logPayload(entry),
      ),
    );
  }

  #logPayload(entry: LogEntry): LogPayload {
    switch (entry.kind) {
      case "assistant": {
        const { text, truncated } = clipText(entry.text);
        return truncated
          ? { kind: "assistant", text, truncated: true }
          : { kind: "assistant", text };
      }
      case "tool_use": {
        if (entry.tool_use_id) {
          this.#toolNames.set(entry.tool_use_id, entry.tool_name);
        }
        const payload: LogPayload = {
          kind: "tool_use",
          tool_name: entry.tool_name,
        };
        if (entry.tool_use_id) payload.tool_use_id = entry.tool_use_id;
        // Drop oversized input wholesale: a cut JSON is unparseable and
        // could split a secret (mirrors the permission payload).
        if (
          Buffer.byteLength(JSON.stringify(entry.input), "utf8") <=
          MAX_LOG_BYTES
        ) {
          payload.input = entry.input;
        } else {
          payload.truncated = true;
        }
        return payload;
      }
      case "tool_result": {
        const { text, truncated } = clipText(entry.output);
        const payload: LogPayload = { kind: "tool_result", output: text };
        if (entry.tool_use_id) payload.tool_use_id = entry.tool_use_id;
        const name = entry.tool_use_id
          ? this.#toolNames.get(entry.tool_use_id)
          : undefined;
        if (name) payload.tool_name = name;
        if (truncated) payload.truncated = true;
        return payload;
      }
    }
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
