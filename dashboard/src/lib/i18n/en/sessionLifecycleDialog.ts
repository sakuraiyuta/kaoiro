import type { Messages } from "../ja";

export const sessionLifecycleDialog = {
  title: ({ label }) => `Session history of ${label}`,
  refresh: "Refresh",
  refreshNote:
    "Reloads automatically when a reset starts or completes. If the newest row is not there yet because of record ordering, or for other kinds of history, use Refresh.",
  loading: "Loading",
  incomplete:
    "Part of the history is shown. Older rows are omitted because of the response size limit.",
  malformedRow: ({ kind, at }) => `Unreadable row — kind: ${kind} / at: ${at}`,
  disconnect: ({ origin, reason }) => `Disconnected: ${origin} (${reason})`,
  requestOrigin: ({ origin }) => `Requested by (origin): ${origin}`,
  requester: ({ who }) => `Requester: ${who}`,
} satisfies Messages["sessionLifecycleDialog"];
