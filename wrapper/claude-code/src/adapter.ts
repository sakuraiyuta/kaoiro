// Adapter — bridges real Claude Agent SDK messages into the normalized
// AdapterEvent stream consumed by the state machine (state.ts). Pure: it only
// reads message shape, never calls the SDK. See docs/specs/agent-sdk-events.md.

import type {
  HookInput,
  SDKMessage,
  SDKRateLimitInfo,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AdapterEvent,
  AssistantBlockKind,
  LogEntry,
  ResultPayload,
  ResultSubtype,
  TasklistSourceItem,
} from "@kaoiro/agent-common";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ERROR_SUBTYPES: ReadonlySet<string> = new Set([
  "error_max_turns",
  "error_during_execution",
  "error_max_budget_usd",
  "error_max_structured_output_retries",
]);

/** Extract the state-relevant block kinds and tool_use ids from an assistant
 *  message's content. Blocks without a string id are counted but not tracked. */
function scanAssistantContent(content: unknown): {
  blocks: AssistantBlockKind[];
  toolUseIds: string[];
} {
  const blocks: AssistantBlockKind[] = [];
  const toolUseIds: string[] = [];
  if (!Array.isArray(content)) return { blocks, toolUseIds };
  for (const block of content) {
    const { type, id } = block as { type?: unknown; id?: unknown };
    if (type === "text") {
      blocks.push("text");
    } else if (type === "thinking" || type === "redacted_thinking") {
      blocks.push("thinking");
    } else if (
      type === "tool_use" ||
      type === "server_tool_use" ||
      type === "mcp_tool_use"
    ) {
      blocks.push("tool_use");
      if (typeof id === "string") toolUseIds.push(id);
    }
  }
  return { blocks, toolUseIds };
}

/** Extract the tool_use ids answered by a user message's tool_result blocks. */
function toolResultIds(content: unknown): {
  hasToolResult: boolean;
  toolUseIds: string[];
} {
  let hasToolResult = false;
  const toolUseIds: string[] = [];
  if (!Array.isArray(content)) return { hasToolResult, toolUseIds };
  for (const block of content) {
    const { type, tool_use_id } = block as {
      type?: unknown;
      tool_use_id?: unknown;
    };
    if (type === "tool_result") {
      hasToolResult = true;
      if (typeof tool_use_id === "string") toolUseIds.push(tool_use_id);
    }
  }
  return { hasToolResult, toolUseIds };
}

function resultSubtype(message: SDKResultMessage): ResultSubtype {
  if (message.subtype === "success") return "success";
  return ERROR_SUBTYPES.has(message.subtype)
    ? (message.subtype as ResultSubtype)
    : "error_during_execution";
}

/**
 * Maps one SDK message to zero or more adapter events. Messages with no
 * coarse-state effect (status, retry, hooks, replays, …) map to no event.
 */
export function sdkMessageToEvents(message: SDKMessage): AdapterEvent[] {
  switch (message.type) {
    case "system":
      // SDKSystemMessage(init) only; other system subtypes carry no state.
      return message.subtype === "init" ? [{ kind: "session_init" }] : [];
    case "assistant": {
      if (message.error) return [{ kind: "assistant", blocks: [], error: true }];
      const { blocks, toolUseIds } = scanAssistantContent(
        message.message.content,
      );
      return toolUseIds.length > 0
        ? [{ kind: "assistant", blocks, toolUseIds }]
        : [{ kind: "assistant", blocks }];
    }
    case "user": {
      const { hasToolResult, toolUseIds } = toolResultIds(
        message.message.content,
      );
      if (!hasToolResult) return [];
      return toolUseIds.length > 0
        ? [{ kind: "tool_result", toolUseIds }]
        : [{ kind: "tool_result" }];
    }
    case "result":
      return [{ kind: "result", subtype: resultSubtype(message) }];
    case "stream_event":
      return [{ kind: "ignore" }];
    default:
      return [];
  }
}

/** Flattens a tool_result block's content to text. Non-text parts (e.g.
 *  images) are dropped — the log stream is a textual transcript. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const { type, text } = block as { type?: unknown; text?: unknown };
    if (type === "text" && typeof text === "string") parts.push(text);
  }
  return parts.join("\n");
}

/** Assistant content -> log entries: text speech and tool_use calls
 *  (thinking is not relayed, protocol.md log.kind). */
function assistantLogs(content: unknown): LogEntry[] {
  if (!Array.isArray(content)) return [];
  const entries: LogEntry[] = [];
  for (const block of content) {
    const { type, text, id, name, input } = block as {
      type?: unknown;
      text?: unknown;
      id?: unknown;
      name?: unknown;
      input?: unknown;
    };
    if (type === "text" && typeof text === "string") {
      entries.push({ kind: "assistant", text });
    } else if (
      (type === "tool_use" ||
        type === "server_tool_use" ||
        type === "mcp_tool_use") &&
      typeof name === "string"
    ) {
      const entry: LogEntry = {
        kind: "tool_use",
        tool_name: name,
        input: isRecord(input) ? input : {},
      };
      if (typeof id === "string") entry.tool_use_id = id;
      entries.push(entry);
    }
  }
  return entries;
}

/** tool_result blocks of a user message -> tool_result log entries. */
function toolResultLogs(content: unknown): LogEntry[] {
  if (!Array.isArray(content)) return [];
  const entries: LogEntry[] = [];
  for (const block of content) {
    const { type, tool_use_id, content: body } = block as {
      type?: unknown;
      tool_use_id?: unknown;
      content?: unknown;
    };
    if (type !== "tool_result") continue;
    const entry: LogEntry = {
      kind: "tool_result",
      output: toolResultText(body),
    };
    if (typeof tool_use_id === "string") entry.tool_use_id = tool_use_id;
    entries.push(entry);
  }
  return entries;
}

/**
 * Extracts relayable log entries from one SDK message: assistant speech /
 * tool calls and tool results. Messages with nothing to show (system,
 * result, stream_event, errored assistant) map to no entry. Pure, like
 * sdkMessageToEvents; the host adds identity, tool_name backfill, and
 * size clipping.
 */
export function sdkMessageToLogs(message: SDKMessage): LogEntry[] {
  switch (message.type) {
    case "assistant":
      return message.error ? [] : assistantLogs(message.message.content);
    case "user":
      return toolResultLogs(message.message.content);
    default:
      return [];
  }
}

/** Final-reply payload of a result message, or null for other messages.
 *  Only the success subtype carries reply text; failures surface as
 *  is_error, plus (issue #127) an error_subtype for UI branching and,
 *  when present, an error_detail string joined from SDKResultError.errors
 *  (falling back to stop_reason) — otherwise the AgentDetail turn-end
 *  line shows a bare "エラーで終了" without cause. */
export function sdkMessageToResult(message: SDKMessage): ResultPayload | null {
  if (message.type !== "result") return null;
  const payload: ResultPayload = {};
  if (message.subtype === "success" && typeof message.result === "string") {
    payload.text = message.result;
  }
  if (message.subtype !== "success" || message.is_error === true) {
    payload.is_error = true;
    payload.error_subtype = resultSubtype(message);
    // TypeScript narrows to SDKResultError here; that shape carries no
    // `result` string but an `errors: string[]` (SDK-level exception /
    // tool crash messages) plus `stop_reason`. Concatenate the errors
    // list (SDK returns 1+ per turn-end); fall back to stop_reason so
    // the UI always has some cue on error termination.
    if (message.subtype !== "success") {
      const errs = message.errors;
      if (Array.isArray(errs) && errs.length > 0) {
        payload.error_detail = errs.join("; ");
      } else if (
        typeof message.stop_reason === "string" &&
        message.stop_reason !== ""
      ) {
        payload.error_detail = message.stop_reason;
      }
    }
  }
  return payload;
}

/** The SDK's terminal_reason for a result message (issue #131), or undefined
 *  for other messages or when the SDK did not report one. Deliberately kept
 *  out of ResultPayload/the wire envelope (scope: no raw engine detail on
 *  the wire) — it exists only to feed the wrapper-local inter-agent error
 *  classifier (classifyInterAgentError, @kaoiro/agent-common) when a turn
 *  ends in error. */
export function sdkMessageToTerminalReason(
  message: SDKMessage,
): string | undefined {
  return message.type === "result" ? message.terminal_reason : undefined;
}

/** Cumulative session cost (USD) from a result message for the ext.cost
 *  filter (#8), or null for non-result messages. Carried in the envelope's
 *  ext, not the result payload, per the plugin-model. */
export function sdkMessageToCost(message: SDKMessage): number | null {
  if (message.type !== "result") return null;
  return typeof message.total_cost_usd === "number"
    ? message.total_cost_usd
    : null;
}

/** Rate-limit snapshot from a rate_limit_event message (#16), or null for
 *  other messages. The SDK emits one per window (five_hour / seven_day / …)
 *  when its info changes; the host keeps the latest per window. */
export function sdkMessageToRateLimit(
  message: SDKMessage,
): SDKRateLimitInfo | null {
  return message.type === "rate_limit_event" ? message.rate_limit_info : null;
}

/** Session init meta — active model, working directory, slash commands, the
 *  current permission mode and fast mode state (#16, #34, #57) — from a
 *  system/init message, or null for other messages. The SDK emits one init
 *  per session; the host stamps these into state_change ext. */
export function sdkMessageToInitMeta(
  message: SDKMessage,
): {
  model?: string;
  cwd?: string;
  slash_commands?: string[];
  permission_mode?: string;
  fast_mode?: string;
} | null {
  if (message.type !== "system" || message.subtype !== "init") return null;
  const meta: {
    model?: string;
    cwd?: string;
    slash_commands?: string[];
    permission_mode?: string;
    fast_mode?: string;
  } = {};
  if (typeof message.model === "string" && message.model !== "") {
    meta.model = message.model;
  }
  if (typeof message.cwd === "string" && message.cwd !== "") {
    meta.cwd = message.cwd;
  }
  if (Array.isArray(message.slash_commands)) {
    const commands = message.slash_commands.filter(
      (c): c is string => typeof c === "string",
    );
    if (commands.length > 0) meta.slash_commands = commands;
  }
  if (typeof message.permissionMode === "string") {
    meta.permission_mode = message.permissionMode;
  }
  if (typeof message.fast_mode_state === "string") {
    meta.fast_mode = message.fast_mode_state;
  }
  return meta;
}

/** Permission mode update from a system/status message (#57), or null. The SDK
 *  emits status messages mid-session when permissionMode changes (e.g. via
 *  /mode); fast_mode_state is not carried here — it rides result messages
 *  only. */
export function sdkMessageToStatusMeta(
  message: SDKMessage,
): { permission_mode?: string } | null {
  if (message.type !== "system" || message.subtype !== "status") return null;
  const m = message as { permissionMode?: unknown };
  if (typeof m.permissionMode !== "string" || m.permissionMode === "") {
    return null;
  }
  return { permission_mode: m.permissionMode };
}

/** Fast mode update from a result message (#57), or null. The SDK ships
 *  fast_mode_state on result success / error_* subtypes; it is the only
 *  mid-session source of `cooldown` (not in status / init). */
export function sdkMessageToResultMeta(
  message: SDKMessage,
): { fast_mode?: string } | null {
  if (message.type !== "result") return null;
  const m = message as { fast_mode_state?: unknown };
  if (typeof m.fast_mode_state !== "string" || m.fast_mode_state === "") {
    return null;
  }
  return { fast_mode: m.fast_mode_state };
}

/** new_cwd from a CwdChanged hook input (#64), or null for other hook events
 *  or empty values. init carries cwd at session start, but never updates
 *  mid-session — the CwdChanged hook is the only path that does. */
export function cwdChangedHookToCwd(input: HookInput): string | null {
  if (input.hook_event_name !== "CwdChanged") return null;
  return typeof input.new_cwd === "string" && input.new_cwd !== ""
    ? input.new_cwd
    : null;
}

/** Compaction / conversation-reset notice extracted from one SDK message
 *  (phase-28 A1, #168), or null when the message carries none. The host turns
 *  it into a `system`-kind log line so the operator sees compaction happen —
 *  until this, a compact was completely invisible in kaoiro.
 *
 *  `kind` names the observed event, `text` is the operator-facing line.
 *  Track S measured the real event order as
 *  `status(compacting)` → `status(null, compact_result)` → `compact_boundary`
 *  → empty `result`, so three distinct messages contribute here. The token
 *  numbers come from `compact_metadata` — Track S found `getContextUsage()`
 *  right after a boundary still reports the PRE-compact total, so the
 *  boundary metadata is the authoritative source for "how much was freed"
 *  and the host's context refresh is only for the meter's eventual update. */
export interface CompactNotice {
  kind:
    | "compacting"
    | "compact_result"
    | "compact_boundary"
    | "conversation_reset";
  text: string;
  /** Boundary token counts, when the event reported them (BR MF1-R). The
   *  host needs the numbers, not just the rendered line: they are the only
   *  authoritative statement of what the context became, and the host uses
   *  them to decide when a later `getContextUsage()` can be believed. Absent
   *  for every kind except `compact_boundary`, and `post` is absent whenever
   *  the boundary omitted it (the SDK declares it optional). */
  tokens?: { pre?: number; post?: number };
}

/** Reads `compact_metadata` defensively: the SDK type declares
 *  trigger/pre_tokens as required and post_tokens/duration_ms as optional,
 *  but Track S observed further undeclared fields (cumulative_dropped_tokens),
 *  so treat every field as best-effort rather than trusting the declaration.
 *
 *  Only trigger / pre_tokens / post_tokens / duration_ms are surfaced. The
 *  relink fields (preserved_segment, uuids, …) are resume plumbing with no
 *  operator meaning, and unknown extras are not guessed at (ふじ review). */
function compactBoundaryText(metadata: unknown): string {
  if (!isRecord(metadata)) return "コンテキストを圧縮しました";
  const { trigger, pre_tokens, post_tokens, duration_ms } = metadata;
  const how = trigger === "auto" ? "自動" : trigger === "manual" ? "手動" : "";
  const parts: string[] = [];
  if (typeof pre_tokens === "number") parts.push(`前 ${pre_tokens} tokens`);
  if (typeof post_tokens === "number") parts.push(`後 ${post_tokens} tokens`);
  const detail = parts.length > 0 ? ` (${parts.join(" → ")})` : "";
  // Track S measured ~13.7 s for a manual compact — long enough that the
  // operator wants to see it next to the turn it interrupted.
  const took =
    typeof duration_ms === "number"
      ? ` ${(duration_ms / 1000).toFixed(1)} 秒`
      : "";
  return `${how}コンテキスト圧縮が完了しました${detail}${took}`;
}

/** Same defensive read as `compactBoundaryText`, but returning the numbers
 *  rather than a rendered line. Non-numeric or missing fields are simply
 *  omitted — the caller must work without them (実機受け入れ 2026-07-28
 *  confirmed post_tokens is genuinely optional). */
function compactBoundaryTokens(
  metadata: unknown,
): { pre?: number; post?: number } | undefined {
  if (!isRecord(metadata)) return undefined;
  const { pre_tokens, post_tokens } = metadata;
  const tokens: { pre?: number; post?: number } = {};
  if (typeof pre_tokens === "number") tokens.pre = pre_tokens;
  if (typeof post_tokens === "number") tokens.post = post_tokens;
  return tokens;
}

/** Maps one SDK message to its compaction / reset notice, or null when it
 *  carries none. Pure, like the other sdkMessageTo* mappers; the host owns
 *  the emit and the follow-up context refresh. Deliberately kept out of
 *  `sdkMessageToLogs`, which history.ts reuses to rebuild a resumed
 *  transcript — these are live-session observations, not transcript
 *  content. */
export function sdkMessageToCompactNotice(
  message: SDKMessage,
): CompactNotice | null {
  // conversation_reset is its own top-level type, not a system subtype.
  if (message.type === "conversation_reset") {
    const id = (message as { new_conversation_id?: unknown })
      .new_conversation_id;
    const suffix = typeof id === "string" && id !== "" ? ` (${id})` : "";
    return {
      kind: "conversation_reset",
      text: `会話がリセットされました${suffix}`,
    };
  }
  if (message.type !== "system") return null;
  if (message.subtype === "compact_boundary") {
    const metadata = (message as { compact_metadata?: unknown })
      .compact_metadata;
    const tokens = compactBoundaryTokens(metadata);
    return {
      kind: "compact_boundary",
      text: compactBoundaryText(metadata),
      ...(tokens !== undefined ? { tokens } : {}),
    };
  }
  if (message.subtype !== "status") return null;
  const m = message as {
    status?: unknown;
    compact_result?: unknown;
    compact_error?: unknown;
  };
  // A failure never reaches compact_boundary, so this status is the only
  // place the operator can learn the compact did not happen.
  if (m.compact_result === "failed") {
    const detail =
      typeof m.compact_error === "string" && m.compact_error !== ""
        ? `: ${m.compact_error}`
        : "";
    return {
      kind: "compact_result",
      text: `コンテキスト圧縮に失敗しました${detail}`,
    };
  }
  // compact_result === "success" is deliberately NOT relayed: the
  // compact_boundary that follows it carries the same news plus the token
  // numbers, and relaying both would double every compact in the transcript.
  if (m.status === "compacting") {
    return { kind: "compacting", text: "コンテキストを圧縮しています…" };
  }
  return null;
}

/** The SDK conversation session id carried by a message (every SDKMessage
 *  variant has one), or null when absent/empty. The host reports it so the
 *  server can group history by session (protocol.md / ADR-0014 phase-0). */
export function sdkMessageToSessionId(message: SDKMessage): string | null {
  const id = (message as { session_id?: unknown }).session_id;
  return typeof id === "string" && id !== "" ? id : null;
}

/** A current Task* tasklist write/list tool tells the host to read Claude
 * Code's persisted task directory after execution. The stream no longer
 * carries its whole list; TodoWrite remains a separate compatibility path
 * below because its input is an atomic whole-list replacement. */
export type TasklistTrigger =
  | { kind: "refresh"; toolUseId: string }
  | { kind: "updated"; items: TasklistSourceItem[] }
  | { kind: "invalid"; reason: string }
  | { kind: "unrecognized"; name: string };

const TASKLIST_REFRESH_TOOLS: ReadonlySet<string> = new Set([
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
]);

// TaskGet is the tasklist API's read-one sibling (same camel-case taskId as
// TaskUpdate). TaskOutput / TaskStop use snake-case task_id and the SDK types
// define them as background-agent controls; bare Task launches a subagent.
// None changes the persisted todo list, so none should refresh or warn.
const KNOWN_NON_REFRESH_TASK_TOOLS: ReadonlySet<string> = new Set([
  "Task",
  "TaskGet",
  "TaskOutput",
  "TaskStop",
]);

/** TodoWrite remains in the public SDK tool union, and the
 * CLAUDE_CODE_ENABLE_TASKS=0 compatibility path emits it. Unlike the Task*
 * tools its input is already an atomic whole-list replacement, so the host
 * applies it directly without waiting for tool_result or reading disk. */
function todoWriteTrigger(input: unknown): TasklistTrigger {
  if (!isRecord(input) || !Array.isArray(input.todos)) {
    return { kind: "invalid", reason: "TodoWrite input.todos is missing" };
  }

  const items: TasklistSourceItem[] = [];
  for (const todo of input.todos) {
    if (!isRecord(todo) || typeof todo.content !== "string") {
      return { kind: "invalid", reason: "TodoWrite todo.content is invalid" };
    }
    if (
      todo.status !== "pending" &&
      todo.status !== "in_progress" &&
      todo.status !== "completed"
    ) {
      return { kind: "invalid", reason: "TodoWrite todo.status is invalid" };
    }
    items.push({ text: todo.content, status: todo.status });
  }
  return { kind: "updated", items };
}

/** Extracts tasklist events from one assistant message. A current Task* tool's
 * source file is written after this assistant message, so host.ts records its
 * id and refreshes only after the matching tool_result; TodoWrite returns an
 * immediate whole-list update through the compatibility path. */
export function sdkMessageToTasklistTriggers(message: SDKMessage): TasklistTrigger[] {
  if (message.type !== "assistant" || message.error) return [];
  const content = message.message.content;
  if (!Array.isArray(content)) return [];

  const events: TasklistTrigger[] = [];
  for (const block of content) {
    const { type, id, name } = block as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
    };
    if (type !== "tool_use" || typeof name !== "string") continue;
    if (name === "TodoWrite") {
      events.push(todoWriteTrigger((block as { input?: unknown }).input));
      continue;
    }
    if (TASKLIST_REFRESH_TOOLS.has(name)) {
      events.push(
        typeof id === "string" && id !== ""
          ? { kind: "refresh", toolUseId: id }
          : { kind: "invalid", reason: `${name} tool_use id is missing` },
      );
      continue;
    }
    if (KNOWN_NON_REFRESH_TASK_TOOLS.has(name)) continue;
    // A newly introduced Task* may be another tasklist writer with an input
    // shape we do not yet know. Known background/subagent siblings above keep
    // this detector from becoming permanently noisy; every other name warns
    // once so a future rename cannot silently disconnect the list again.
    if (name.startsWith("Task")) {
      events.push({ kind: "unrecognized", name });
    }
  }
  return events;
}

/** Returns the tool_use ids settled by this user message. Kept separate from
 * the state mapper so state reduction and post-execution tasklist refresh can
 * use the same SDK-level join without coupling either concern to the other. */
export function sdkMessageToToolResultIds(message: SDKMessage): string[] {
  if (message.type !== "user") return [];
  return toolResultIds(message.message.content).toolUseIds;
}

/** Raw fields extracted from one task_* SDK system message (issue #180,
 *  ADR-0019 F2-F4, ADR-0047), before the host backfills `task_type` for
 *  `updated`/`completed` from its own started-task cache — the SDK's
 *  `task_progress` / `task_notification` messages carry no `task_type` of
 *  their own (verified against the installed `@anthropic-ai/claude-agent-
 *  sdk@0.3.220` type declarations; only `task_started` has it, and even
 *  there it is optional). Kept out of adapter.ts's per-session state on
 *  purpose — this file is pure, like every other `sdkMessageTo*` mapper
 *  here; host.ts owns the cache and the fail-visible "unknown task_id /
 *  missing task_type" handling.
 *
 *  Deliberately excludes two real SDK fields outside ADR-0047 F3's
 *  enumerated optional-meta list: `task_started.prompt` (the subagent's
 *  full instructions, content-bearing) and `task_notification.output_file`
 *  (a local filesystem path). Neither is wired to the wire envelope
 *  (こはく判断 2026-08-09, issue #180).
 *
 *  `task_updated` (a real SDK subtype — richer status enum
 *  pending/running/completed/failed/killed/paused than ADR-0019 F3's
 *  coarse lifecycle) is likewise not extracted: #180 review captured the
 *  real SDK stream (2026-08-09, SDK 0.3.220) across natural completion,
 *  explicit `stopTask()`, session-level `interrupt()`, and
 *  `backgroundTasks()` — `task_notification` reliably followed every
 *  `task_updated(status:"killed")` observation, so the 3-event model
 *  (`task_started`/`task_progress`/`task_notification`) is sufficient
 *  without it; `task_updated` stays out of ADR-0019's explicit scope. */
export type TaskEvent =
  | {
      kind: "started";
      task_id: string;
      /** Present iff the SDK message had a non-empty `task_type` — see
       *  the `task_started` case: host.ts logs and drops the event when
       *  this is absent, since ADR-0047 F2 requires task_type on every
       *  emitted `task` envelope and there is nothing to backfill it
       *  from yet for a brand-new task_id. */
      task_type?: string;
      subagent_type?: string;
      workflow_name?: string;
      description?: string;
      skip_transcript?: boolean;
    }
  | {
      kind: "updated";
      task_id: string;
      subagent_type?: string;
      description?: string;
      usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
      last_tool_name?: string;
      summary?: string;
    }
  | {
      kind: "completed";
      task_id: string;
      /** Coarse status the caller emits (completed/failed/stopped, ADR-0019
       *  F3). `task_notification` is inherently terminal — even when the SDK
       *  reports a status value outside this 3-value set, `status` still
       *  gets a value here (falls back to `"failed"`) so the caller always
       *  closes out its active-task cache/count; the SDK's raw string is
       *  preserved separately in {@link raw_status} for logging (M2
       *  fix-round, 2026-08-09 — ふじ review: dropping the event entirely on
       *  an unrecognized status left the +1 permanently un-decremented). */
      status: "completed" | "failed" | "stopped";
      /** Present only when `status` above is a fallback, i.e. the SDK's own
       *  value did not match the 3 known statuses. The caller should log
       *  this raw value rather than silently discarding it. */
      raw_status?: string;
      usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
      summary?: string;
      skip_transcript?: boolean;
    };

/** Maps one SDK system message to a {@link TaskEvent}, or null for every
 *  other message (including `task_updated` and any other `task_*`
 *  subtype the SDK adds later — see the type's doc comment for why those
 *  are out of scope, and why unknown subtypes must still be visible to
 *  the host rather than silently vanishing: `message.subtype` itself is
 *  available to a caller that wants to log an unrecognized `task_*`
 *  subtype, since this function only returns null for it). */
export function sdkMessageToTask(message: SDKMessage): TaskEvent | null {
  if (message.type !== "system") return null;
  switch (message.subtype) {
    case "task_started": {
      const m = message as unknown as {
        task_id: string;
        task_type?: string;
        subagent_type?: string;
        workflow_name?: string;
        description?: string;
        skip_transcript?: boolean;
      };
      const event: TaskEvent = { kind: "started", task_id: m.task_id };
      if (typeof m.task_type === "string" && m.task_type !== "") {
        event.task_type = m.task_type;
      }
      if (typeof m.subagent_type === "string") {
        event.subagent_type = m.subagent_type;
      }
      if (typeof m.workflow_name === "string") {
        event.workflow_name = m.workflow_name;
      }
      if (typeof m.description === "string") event.description = m.description;
      if (typeof m.skip_transcript === "boolean") {
        event.skip_transcript = m.skip_transcript;
      }
      return event;
    }
    case "task_progress": {
      const m = message as unknown as {
        task_id: string;
        subagent_type?: string;
        description?: string;
        usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
        last_tool_name?: string;
        summary?: string;
      };
      const event: TaskEvent = { kind: "updated", task_id: m.task_id };
      if (typeof m.subagent_type === "string") {
        event.subagent_type = m.subagent_type;
      }
      if (typeof m.description === "string") event.description = m.description;
      if (isRecord(m.usage)) {
        const { total_tokens, tool_uses, duration_ms } = m.usage as Record<
          string,
          unknown
        >;
        if (
          typeof total_tokens === "number" &&
          typeof tool_uses === "number" &&
          typeof duration_ms === "number"
        ) {
          event.usage = { total_tokens, tool_uses, duration_ms };
        }
      }
      if (typeof m.last_tool_name === "string") {
        event.last_tool_name = m.last_tool_name;
      }
      if (typeof m.summary === "string") event.summary = m.summary;
      return event;
    }
    case "task_notification": {
      const m = message as unknown as {
        task_id: string;
        status?: unknown;
        usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
        summary?: string;
        skip_transcript?: boolean;
      };
      // M2 fix-round (2026-08-09, ふじ review): task_notification is
      // ALWAYS terminal — returning null here for an unrecognized status
      // (the pre-fix behavior) dropped the event entirely, leaving the
      // host's active-task cache/count stuck at +1 forever (no -1 ever
      // fires for that task_id). Fall back to "failed" rather than
      // silently coercing to "completed" (which would misreport success),
      // and preserve the raw value in `raw_status` so the caller can warn
      // with it instead of swallowing it.
      let status: "completed" | "failed" | "stopped";
      let rawStatus: string | undefined;
      if (
        m.status === "completed" ||
        m.status === "failed" ||
        m.status === "stopped"
      ) {
        status = m.status;
      } else {
        status = "failed";
        rawStatus = typeof m.status === "string" ? m.status : String(m.status);
      }
      const event: TaskEvent = {
        kind: "completed",
        task_id: m.task_id,
        status,
        ...(rawStatus !== undefined ? { raw_status: rawStatus } : {}),
      };
      if (isRecord(m.usage)) {
        const { total_tokens, tool_uses, duration_ms } = m.usage as Record<
          string,
          unknown
        >;
        if (
          typeof total_tokens === "number" &&
          typeof tool_uses === "number" &&
          typeof duration_ms === "number"
        ) {
          event.usage = { total_tokens, tool_uses, duration_ms };
        }
      }
      if (typeof m.summary === "string") event.summary = m.summary;
      if (typeof m.skip_transcript === "boolean") {
        event.skip_transcript = m.skip_transcript;
      }
      return event;
    }
    default:
      return null;
  }
}
