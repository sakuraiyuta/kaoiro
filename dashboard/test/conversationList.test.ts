import { describe, expect, it } from "vitest";
import {
  isConversationAlreadyClosedError,
  visibleConversationSummaries,
} from "../src/lib/conversationList";
import type { ConversationSummary } from "../src/lib/protocol";

const conversations: ConversationSummary[] = [
  {
    conversationId: "open-id",
    participants: ["agent.a", "agent.b"],
    turns: 2,
    tokens: 20,
    status: "open",
    startedAt: "2026-09-20T00:00:00Z",
  },
  {
    conversationId: "closed-id",
    participants: ["agent.a", "agent.b"],
    turns: 7,
    tokens: null,
    status: "closed",
    startedAt: "2026-09-19T00:00:00Z",
  },
];

describe("visibleConversationSummaries (issue #383)", () => {
  it("hides closed rows by default and preserves open entries", () => {
    expect(visibleConversationSummaries(conversations, false)).toEqual([
      conversations[0],
    ]);
  });

  it("shows the original closed summary, including its frozen turns and status, when enabled", () => {
    const visible = visibleConversationSummaries(conversations, true);
    expect(visible).toEqual(conversations);
    expect(visible[1]).toBe(conversations[1]);
    expect(visible[1]).toMatchObject({ turns: 7, status: "closed" });
  });
});

describe("isConversationAlreadyClosedError (issue #383)", () => {
  it.each(["conversation_closed", "unknown_conversation_id"])(
    "treats %s as already closed",
    (reason) => {
      expect(isConversationAlreadyClosedError(new Error(reason))).toBe(true);
    },
  );

  it("leaves other errors and non-Error values as failures", () => {
    expect(isConversationAlreadyClosedError(new Error("timeout"))).toBe(false);
    expect(isConversationAlreadyClosedError("conversation_closed")).toBe(false);
  });
});
