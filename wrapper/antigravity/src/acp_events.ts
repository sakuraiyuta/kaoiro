import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AdapterEvent, LogEntry } from "@kaoiro/agent-common";

/** The input classes of the design (section 4.0) for one `session/update`. */
export type UpdateClass = "control" | "activity" | "other";

const CONTROL = new Set([
  "available_commands_update",
  "usage_update",
  "config_option_update",
  "current_mode_update",
  "session_info_update",
]);
const ACTIVITY = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"]);

export function classifyUpdate(notification: SessionNotification, sessionId: string | undefined): UpdateClass {
  if (sessionId === undefined || notification.sessionId !== sessionId) return "other";
  const kind = notification.update.sessionUpdate;
  if (CONTROL.has(kind)) return "control";
  return ACTIVITY.has(kind) ? "activity" : "other";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The vendor's tool name; `agy` sends it beside the ACP fields. */
export function toolName(update: unknown): string | undefined {
  const name = isRecord(update) ? update.name : undefined;
  return typeof name === "string" ? name : undefined;
}

function outputText(update: Record<string, unknown>): string {
  const content = update.content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      const inner = isRecord(item) && isRecord(item.content) ? item.content : undefined;
      if (inner?.type === "text" && typeof inner.text === "string") parts.push(inner.text);
    }
    if (parts.length > 0) return parts.join("\n");
  }
  const raw = update.rawOutput;
  if (isRecord(raw) && typeof raw.output === "string") return raw.output;
  return "";
}

/** What one activity update projects onto the turn. */
export function activityProjection(notification: SessionNotification): {
  events: AdapterEvent[];
  log?: LogEntry;
  text?: string;
} {
  const update = notification.update;
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return update.content.type === "text"
        ? { events: [{ kind: "assistant", blocks: ["text"] }], text: update.content.text }
        : { events: [] };
    case "agent_thought_chunk":
      return { events: [{ kind: "assistant", blocks: ["thinking"] }] };
    case "tool_call": {
      const name = toolName(update) ?? update.title;
      return {
        events: [{ kind: "assistant", blocks: ["tool_use"], toolUseIds: [update.toolCallId] }],
        log: {
          kind: "tool_use",
          tool_use_id: update.toolCallId,
          tool_name: name,
          input: isRecord(update.rawInput) ? update.rawInput : {},
        },
      };
    }
    case "tool_call_update":
      if (update.status === "completed" || update.status === "failed") {
        return {
          events: [{ kind: "tool_result", toolUseIds: [update.toolCallId] }],
          log: { kind: "tool_result", tool_use_id: update.toolCallId, output: outputText(update as Record<string, unknown>) },
        };
      }
      return { events: [] };
    default:
      return { events: [] };
  }
}
