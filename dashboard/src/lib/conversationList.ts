import type { ConversationSummary } from "./protocol";

/** Project the operator's conversation list without changing its server data. */
export function visibleConversationSummaries(
  conversations: readonly ConversationSummary[],
  showClosed: boolean,
): ConversationSummary[] {
  return conversations.filter(
    (conversation) => showClosed || conversation.status === "open",
  );
}

/** A selected list entry that vanished or became a tombstone is already closed. */
export function isConversationAlreadyClosedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === "conversation_closed" ||
      error.message === "unknown_conversation_id")
  );
}
