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

/** Extract the state-relevant block kinds from an assistant message's content. */
function blockKinds(content: unknown): AssistantBlockKind[] {
  if (!Array.isArray(content)) return [];
  const kinds: AssistantBlockKind[] = [];
  for (const block of content) {
    const type = (block as { type?: unknown }).type;
    if (type === "text") {
      kinds.push("text");
    } else if (type === "thinking" || type === "redacted_thinking") {
      kinds.push("thinking");
    } else if (
      type === "tool_use" ||
      type === "server_tool_use" ||
      type === "mcp_tool_use"
    ) {
      kinds.push("tool_use");
    }
  }
  return kinds;
}

/** True if a user message carries a tool_result block (end of tool_running). */
function hasToolResult(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some((b) => (b as { type?: unknown }).type === "tool_result")
  );
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
    case "assistant":
      if (message.error) return [{ kind: "assistant", blocks: [], error: true }];
      return [{ kind: "assistant", blocks: blockKinds(message.message.content) }];
    case "user":
      return hasToolResult(message.message.content)
        ? [{ kind: "tool_result" }]
        : [];
    case "result":
      return [{ kind: "result", subtype: resultSubtype(message) }];
    case "stream_event":
      return [{ kind: "ignore" }];
    default:
      return [];
  }
}
