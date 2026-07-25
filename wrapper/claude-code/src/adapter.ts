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

/** The SDK conversation session id carried by a message (every SDKMessage
 *  variant has one), or null when absent/empty. The host reports it so the
 *  server can group history by session (protocol.md / ADR-0014 phase-0). */
export function sdkMessageToSessionId(message: SDKMessage): string | null {
  const id = (message as { session_id?: unknown }).session_id;
  return typeof id === "string" && id !== "" ? id : null;
}
