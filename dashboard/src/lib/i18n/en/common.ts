import type { Messages } from "../ja";

export const common = {
  close: "Close",
  cancel: "Cancel",
  loading: "Loading…",
  noHistory: "No history",
  historyFetchFailed: ({ reason }) => `Cannot load the history (${reason})`,
} satisfies Messages["common"];
