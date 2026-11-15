import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AdapterEvent, LogPayload } from "@kaoiro/agent-common";

export function updateEvents(notification: SessionNotification): {
  events: AdapterEvent[];
  log?: LogPayload;
  text?: string;
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
  }
  return { events: [] };
}

/** The turn a `_x.ai/session_notification` `turn_completed` closes, if any. */
export function turnCompletion(
  notification: Record<string, unknown>,
  currentSessionId: string | undefined,
): { sessionId: string; promptId: string } | undefined {
  const update = notification.update as Record<string, unknown> | undefined;
  const sessionId = notification.sessionId ?? notification.session_id;
  if (
    update?.sessionUpdate === "turn_completed" &&
    sessionId === currentSessionId &&
    typeof sessionId === "string" &&
    typeof update.prompt_id === "string"
  ) {
    return { sessionId, promptId: update.prompt_id };
  }
  return undefined;
}

/** The prompt id Grok puts in a `session/update` `_meta`, if any. */
export function updatePromptId(notification: SessionNotification): string | undefined {
  const id = (notification._meta as Record<string, unknown> | null | undefined)?.promptId;
  return typeof id === "string" ? id : undefined;
}

/**
 * The running prompt an `_x.ai/queue/changed` reports for the current
 * session: `{ running: undefined }` when nothing runs, `undefined` when the
 * notification is for another session.
 */
export function queueRunning(
  params: Record<string, unknown>,
  currentSessionId: string | undefined,
): { running: string | undefined } | undefined {
  if (currentSessionId === undefined || params.sessionId !== currentSessionId) return undefined;
  const id = params.runningPromptId;
  return { running: typeof id === "string" ? id : undefined };
}

/** Why Grok started a prompt on its own, for the operator's log. */
export function selfStartedReason(promptId: string): string {
  if (promptId.startsWith("task-completed-")) return "a background task ended";
  if (promptId.startsWith("notifications-")) return "notifications";
  if (promptId.startsWith("interject-fallback-")) return "an interjection";
  return "unknown reason";
}

/** The prompt id Grok puts in a `session/prompt` result `_meta`. */
export function promptIdOf(meta: unknown): unknown {
  return (meta as Record<string, unknown> | null | undefined)?.promptId;
}

export function cancellationKind(meta: unknown): "rejected" | "interrupted" {
  const value = meta as Record<string, unknown> | undefined;
  return value?.cancellationCategory === "PermissionRejected"
    ? "rejected"
    : "interrupted";
}
