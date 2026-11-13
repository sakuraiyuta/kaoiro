import type { Envelope, KaoiroConnection } from "./protocol";

// A future rejection reason cannot prove that the reset was not accepted.
const DEFINITE_SESSION_RESET_REJECTIONS = new Set([
  "agent_busy",
  "unsupported_session_reset",
  "invalid_mode",
  "unknown_agent",
  "missing_agent_id",
  "invalid_agent_id",
  "payload_too_large",
  "invalid_payload",
]);


export async function executeBulkCleanup(
  connection: Pick<KaoiroConnection, "closeConversation" | "sendSessionReset">,
  conversationIds: readonly string[],
  agentIds: readonly string[],
  current: () => boolean,
  getAgents: () => Record<string, Envelope>,
): Promise<{ closed: number; closeSkipped: number; accepted: number; resetSkipped: number; resetUnknown: number } | null> {
  let closed = 0;
  let closeSkipped = 0;
  let accepted = 0;
  let resetSkipped = 0;
  let resetUnknown = 0;
  let stopped = false;

  for (const conversationId of conversationIds) {
    if (!current()) {
      stopped = true;
      break;
    }
    try {
      await connection.closeConversation(conversationId);
      if (!current()) {
        stopped = true;
        break;
      }
      closed += 1;
    } catch (err) {
      if (!current()) {
        stopped = true;
        break;
      }
      if (err instanceof Error && err.message === "forbidden") {
        console.warn("lost operator permission during the bulk operation", err);
        stopped = true;
        break;
      }
      closeSkipped += 1;
      console.warn("skipped the bulk close", conversationId, err);
    }
  }

  if (!stopped) {
    for (const agentId of agentIds) {
      if (!current()) {
        stopped = true;
        break;
      }
      const envelope = getAgents()[agentId];
      if (!envelope || envelope.state === "disconnected") {
        resetSkipped += 1;
        continue;
      }
      try {
        await connection.sendSessionReset(agentId, "clear");
        if (!current()) {
          stopped = true;
          break;
        }
        accepted += 1;
      } catch (err) {
        if (!current()) {
          stopped = true;
          break;
        }
        const reason = err instanceof Error ? err.message : "error";
        if (reason === "forbidden") {
          console.warn("lost operator permission during the bulk operation", err);
          stopped = true;
          break;
        }
        if (reason === "timeout" || reason === "session_reset_pending") {
          resetUnknown += 1;
          console.warn(
            "bulk session_reset outcome is unknown; not retrying",
            agentId,
            err,
          );
        } else if (DEFINITE_SESSION_RESET_REJECTIONS.has(reason)) {
          resetSkipped += 1;
          console.warn(
            "skipped the bulk session_reset",
            agentId,
            err,
          );
        } else {
          resetUnknown += 1;
          console.warn(
            "bulk session_reset outcome is unknown; not retrying",
            agentId,
            err,
          );
        }
      }
    }
  }

  return current() && !stopped
    ? { closed, closeSkipped, accepted, resetSkipped, resetUnknown }
    : null;
}
