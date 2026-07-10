// Adapter — bridges Codex SDK ThreadEvents into the normalized AdapterEvent
// stream consumed by the state machine (@kaoiro/agent-common state.ts) and
// into relayable log entries. Pure: it only reads event shape, never calls
// the SDK. See docs/specs/codex-sdk-events.md; the Claude twin lives in
// @kaoiro/claude-code/src/adapter.ts.

import type { ThreadEvent, ThreadItem } from "@openai/codex-sdk";
import type { AdapterEvent, LogEntry } from "@kaoiro/agent-common";

/** Tool-ish items: they occupy the tool_running state between item.started
 *  and item.completed. agent_message / reasoning / todo_list are not tools. */
function isToolItem(item: ThreadItem): boolean {
  return (
    item.type === "command_execution" ||
    item.type === "file_change" ||
    item.type === "mcp_tool_call" ||
    item.type === "web_search"
  );
}

/**
 * Maps one ThreadEvent to zero or more adapter events (state-machine input).
 * Events with no coarse-state effect (item.updated, todo_list, error items)
 * map to no event; the stream-fatal `error` event is handled by the host
 * (it also ends the turn on the SDK side).
 */
export function threadEventToEvents(event: ThreadEvent): AdapterEvent[] {
  switch (event.type) {
    case "thread.started":
      return [{ kind: "session_init" }];
    case "turn.started":
      // send() already raised user_send; the machine is in sending/thinking.
      return [{ kind: "assistant", blocks: ["thinking"] }];
    case "item.started": {
      const item = event.item;
      if (item.type === "agent_message") {
        return [{ kind: "assistant", blocks: ["text"] }];
      }
      if (item.type === "reasoning") {
        return [{ kind: "assistant", blocks: ["thinking"] }];
      }
      if (isToolItem(item)) {
        return [
          { kind: "assistant", blocks: ["tool_use"], toolUseIds: [item.id] },
        ];
      }
      return [];
    }
    case "item.completed": {
      const item = event.item;
      if (isToolItem(item)) {
        return [{ kind: "tool_result", toolUseIds: [item.id] }];
      }
      return [];
    }
    case "turn.completed":
      return [{ kind: "result", subtype: "success" }];
    case "turn.failed":
      return [{ kind: "result", subtype: "error_during_execution" }];
    default:
      return [];
  }
}

/** Human-readable tool name for the log stream (protocol.md log.kind).
 *  mcp tools keep the Claude-style FQN so the dashboard groups them the
 *  same way across engines. */
function toolName(item: ThreadItem): string {
  switch (item.type) {
    case "command_execution":
      return "shell";
    case "file_change":
      return "edit";
    case "web_search":
      return "web_search";
    case "mcp_tool_call":
      return `mcp__${item.server}__${item.tool}`;
    default:
      return item.type;
  }
}

/** Flattens an MCP tool result's content blocks to text (images and other
 *  non-text parts are dropped — the log stream is a textual transcript). */
function mcpResultText(item: Extract<ThreadItem, { type: "mcp_tool_call" }>): string {
  if (item.error) return item.error.message;
  const parts: string[] = [];
  for (const block of item.result?.content ?? []) {
    const { type, text } = block as { type?: unknown; text?: unknown };
    if (type === "text" && typeof text === "string") parts.push(text);
  }
  return parts.join("\n");
}

/**
 * Extracts relayable log entries from one ThreadEvent: assistant speech and
 * tool call / result pairs. item.started carries the tool_use line (input),
 * item.completed the tool_result line (output); agent_message text lands on
 * completion. reasoning / todo_list are not relayed (protocol.md: thinking
 * stays local), matching the Claude adapter.
 */
export function threadEventToLogs(event: ThreadEvent): LogEntry[] {
  if (event.type === "item.started") {
    const item = event.item;
    switch (item.type) {
      case "command_execution":
        return [
          {
            kind: "tool_use",
            tool_use_id: item.id,
            tool_name: toolName(item),
            input: { command: item.command },
          },
        ];
      case "file_change":
        return [
          {
            kind: "tool_use",
            tool_use_id: item.id,
            tool_name: toolName(item),
            input: { changes: item.changes },
          },
        ];
      case "mcp_tool_call":
        return [
          {
            kind: "tool_use",
            tool_use_id: item.id,
            tool_name: toolName(item),
            input:
              typeof item.arguments === "object" && item.arguments !== null
                ? (item.arguments as Record<string, unknown>)
                : { arguments: item.arguments },
          },
        ];
      case "web_search":
        return [
          {
            kind: "tool_use",
            tool_use_id: item.id,
            tool_name: toolName(item),
            input: { query: item.query },
          },
        ];
      default:
        return [];
    }
  }
  if (event.type === "item.completed") {
    const item = event.item;
    switch (item.type) {
      case "agent_message":
        return [{ kind: "assistant", text: item.text }];
      case "command_execution":
        return [
          {
            kind: "tool_result",
            tool_use_id: item.id,
            output:
              item.exit_code !== undefined && item.exit_code !== 0
                ? `(exit ${item.exit_code})\n${item.aggregated_output}`
                : item.aggregated_output,
          },
        ];
      case "file_change":
        return [
          {
            kind: "tool_result",
            tool_use_id: item.id,
            output: `${item.status}: ${item.changes
              .map((c) => `${c.kind} ${c.path}`)
              .join(", ")}`,
          },
        ];
      case "mcp_tool_call":
        return [
          {
            kind: "tool_result",
            tool_use_id: item.id,
            output: mcpResultText(item),
          },
        ];
      case "web_search":
        return [
          { kind: "tool_result", tool_use_id: item.id, output: "" },
        ];
      default:
        return [];
    }
  }
  return [];
}

/** Final-reply text of a turn: the last completed agent_message. The host
 *  accumulates via this helper while streaming and emits type=result at
 *  turn.completed. */
export function threadEventToFinalText(event: ThreadEvent): string | null {
  if (event.type === "item.completed" && event.item.type === "agent_message") {
    return event.item.text;
  }
  return null;
}

/** Token usage from turn.completed for ext (tokens only — the Codex SDK
 *  reports no USD cost, so ext.cost is never stamped on codex agents). */
export function threadEventToUsage(
  event: ThreadEvent,
): Record<string, number> | null {
  if (event.type !== "turn.completed") return null;
  return {
    input_tokens: event.usage.input_tokens,
    cached_input_tokens: event.usage.cached_input_tokens,
    output_tokens: event.usage.output_tokens,
    reasoning_output_tokens: event.usage.reasoning_output_tokens,
  };
}

/** thread id from thread.started, or null. */
export function threadEventToSessionId(event: ThreadEvent): string | null {
  return event.type === "thread.started" ? event.thread_id : null;
}
