import type { Messages } from "../ja";

export const responseTimeline: Messages["responseTimeline"] = {
  title: "Conversation timeline",
  empty: "No conversations yet",
  openDetail: ({ name }) => `Open details of ${name}`,
  recipientFallback: "recipient",
  emptyUserMessage: "(empty message)",
  emptyInterAgentMessage: "(empty inter-agent message)",
  emptyResponse: "(empty response)",
};
