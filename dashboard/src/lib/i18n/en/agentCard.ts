import type { Messages } from "../ja";

export const agentCard = {
  rateResetDone: "Reset",
  terminateConfirm: ({ name, state }) =>
    `"${name}" is ${state}. Terminating it may lose work in progress. Terminate?`,
  deleteConfirm: ({ name }) =>
    `This permanently deletes the offline agent "${name}". ` +
    `Its saved persona / session pointer / permission_mode are discarded, ` +
    `and this agent_id can no longer be restored. Continue?`,
  offline: "Offline",
  restoreFailed: "Restore failed",
  restoreFailedTitle: ({ reason }) => `Restore failed: ${reason}`,
  needsAttention: "Needs attention",
  openDetail: ({ name }) => `Open details of ${name}`,
  offlineName: ({ name }) => `${name} (offline)`,
  contextWindow: "Window",
  workBudget: "Budget",
  openStatusHistory: ({ name }) => `Open the status line history of ${name}`,
  terminateTitle: "Terminate the agent (wrapper)",
  terminateAria: ({ name }) => `Terminate ${name}`,
  terminate: "Terminate",
  terminating: "Terminating…",
  restoreTitle: "Resume the session and bring the agent back",
  restoreAria: ({ name }) => `Restore ${name}`,
  restore: "Restore",
  restoring: "Restoring…",
  interruptTitle: "Interrupt the current turn (like ESC)",
  interruptAria: ({ name }) => `Interrupt the turn of ${name}`,
  interrupt: "Interrupt",
  interrupting: "Interrupting…",
  deleteTitle: "Delete the offline agent from the ledger",
  deleteAria: ({ name }) => `Delete ${name}`,
  delete: "Delete",
  deleting: "Deleting…",
} satisfies Messages["agentCard"];
