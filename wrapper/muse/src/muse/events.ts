import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AdapterEvent, LogPayload } from "@kaoiro/agent-common";

/** Maps one standard ACP `session/update` to the common adapter surface.
 *  Muse Code speaks plain ACP (no vendor session updates are consumed by
 *  this adapter), so the mapping is the protocol's own vocabulary:
 *  message and thought chunks, tool call rows and their completion, plan
 *  entries (shown as system lines) and usage readings. */
export function updateEvents(notification: SessionNotification): {
  events: AdapterEvent[];
  log?: LogPayload;
  text?: string;
  usage?: { used: number; size: number };
} {
  const update = notification.update;
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (update.content.type === "text") {
        return {
          events: [{ kind: "assistant", blocks: ["text"] }],
          text: update.content.text,
        };
      }
      break;
    case "agent_thought_chunk":
      return { events: [{ kind: "assistant", blocks: ["thinking"] }] };
    case "tool_call":
      return {
        events: [
          {
            kind: "assistant",
            blocks: ["tool_use"],
            toolUseIds: [update.toolCallId],
          },
        ],
        log: { kind: "tool_use", tool_name: update.title },
      };
    case "tool_call_update":
      if (update.status === "completed" || update.status === "failed") {
        return {
          events: [{ kind: "tool_result", toolUseIds: [update.toolCallId] }],
        };
      }
      break;
    case "usage_update":
      if (
        typeof update.used === "number" &&
        typeof update.size === "number" &&
        update.size > 0
      ) {
        return { events: [], usage: { used: update.used, size: update.size } };
      }
      break;
    case "plan": {
      const entries = update.entries
        .filter((entry) => entry.status === "in_progress")
        .map((entry) => entry.content);
      if (entries.length > 0) {
        return {
          events: [],
          log: { kind: "system", text: `Plan: ${entries.join("; ")}` },
        };
      }
      break;
    }
  }
  return { events: [] };
}
