// Adapter — bridges real Claude Agent SDK messages into the normalized
// AdapterEvent stream consumed by the state machine (state.ts). Pure: it only
// reads message shape, never calls the SDK. See docs/specs/agent-sdk-events.md.

import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  AdapterEvent,
  AssistantBlockKind,
  LogEntry,
  ResultPayload,
  ResultSubtype,
} from "./types.js";

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
 *  is_error with the state machine already showing `error`. */
export function sdkMessageToResult(message: SDKMessage): ResultPayload | null {
  if (message.type !== "result") return null;
  const payload: ResultPayload = {};
  if (message.subtype === "success" && typeof message.result === "string") {
    payload.text = message.result;
  }
  if (message.subtype !== "success" || message.is_error === true) {
    payload.is_error = true;
  }
  return payload;
}
