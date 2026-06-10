// Adapter — bridges real Claude Agent SDK messages into the normalized
// AdapterEvent stream consumed by the state machine (state.ts). Pure: it only
// reads message shape, never calls the SDK. See docs/specs/agent-sdk-events.md.

import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AdapterEvent, AssistantBlockKind, ResultSubtype } from "./types.js";

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
