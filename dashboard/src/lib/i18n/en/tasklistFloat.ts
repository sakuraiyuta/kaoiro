import type { Messages } from "../ja";

export const tasklistFloat = {
  status: {
    pending: "Not started",
    in_progress: "In progress",
    completed: "Completed",
  },
  listAria: "Current todo list",
  collapse: "Collapse",
  expand: "Details",
  detailAria: "Todo details",
  omitted: ({ count, completed }) =>
    `${count} more omitted (${completed} of them completed)`,
} satisfies Messages["tasklistFloat"];
