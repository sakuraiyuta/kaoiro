import type { Messages } from "../ja";

export const statusLineHistoryDialog = {
  emptyFirstLine: "(empty first line)",
  agentGone: "The history of this agent cannot be shown now",
  temporarilyUnavailable: "The history is temporarily unavailable",
  ariaLabel: ({ label }) => `Status line history of ${label}`,
  title: ({ label }) => `Status line of ${label}`,
  cleared: "(cleared)",
  collapse: "Collapse",
  expand: "Expand",
} satisfies Messages["statusLineHistoryDialog"];
