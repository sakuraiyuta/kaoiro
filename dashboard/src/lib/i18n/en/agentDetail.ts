import type { Messages } from "../ja";
import { plural } from "./plural";

const axesWithNetwork = (p: {
  sandbox: string;
  network: boolean;
  approval: string | undefined;
}) =>
  `write ${p.sandbox} / network ${p.network}${p.approval ? ` / approval ${p.approval}` : ""}`;

export const agentDetail = {
  driftUnset: "(not set)",
  rateOverage: "extra",
  rateResetDone: "Reset",
  rateReset: ({ at }) => `resets ${at}`,
  rateNoData: "No data yet",
  resumeCandidatesFailed: "Could not get the candidates.",
  resumeCandidatesFailedWith: ({ reason }) =>
    `Could not get the candidates (${reason})`,
  effortResetNotice:
    "The previous effort is not available on the new model, so it was reset to the default",
  modelsRefreshFailingNotice:
    "Updating the model list during the session keeps failing. Try reloading it with ↻ next to the switch button",
  modelsRefreshFailed: ({ reason }) =>
    `Failed to reload the model list: ${reason}`,
  effortCatalogUnavailableNotice:
    "The current model has no effort catalog, so the switch was stopped locally. Refresh the catalog (↻), or switch after the first turn",
  effortLevelUnsupportedNotice: ({ requested }) =>
    `The catalog of the current model has no ${requested}, so the switch was stopped locally`,
  persistAliasUnknownNotice: ({ requested }) =>
    `The saved ${requested} is not in the current catalog, so the session started with default`,
  sdkFallbackNotice: ({ requested, rolledBackTo }) =>
    `The safeguard fell back from ${requested} to ${rolledBackTo ?? "another model"}. The setting ${requested} is kept and comes back on restart. To go back now, pick it again from the switch`,
  switchFailedNotice: ({ kind, requested, reason, rollbackTarget }) =>
    `${kind === "model" ? "Model" : "Effort"} switch failed: ${requested} is not in effect (reason: ${reason}). Rolled back to ${rollbackTarget ? `the previous value ${rollbackTarget}` : "the last value that succeeded"}`,
  bypassConfirm:
    "bypassPermissions: this bypasses every tool permission at once. Continue?",
  permissionStatus: {
    pending: "Requested (applies from the next turn)",
    applying: "Applying (picked up by the next run)",
    applied: "Applied",
    failed: "Failed",
    unknown: "Unconfirmed",
  },
  permissionError: {
    forbidden: "Not permitted (only an operator can do this)",
    invalid_payload: "The request is invalid",
    unknown_agent: "The agent was not found",
    agent_unavailable: "The agent is not connected",
    unsupported_permission_switch:
      "This engine does not support switching permissions",
    permission_not_ready: "Waiting for the permission information",
    session_reset_pending: "Waiting for the session reset to finish",
    revision_exhausted: "No revisions are left",
    persistence_failed: "The server failed to save the request",
    exceeds_launch_ceiling: "The requested value exceeds the launch ceiling",
  },
  codexApprovalConfigRecovery:
    "The wrapper states the requested approval (never by default) explicitly. If the observed value differs, check approvals_reviewer in the host's $CODEX_HOME/config.toml (~/.codex/config.toml by default) and the Codex CLI version. Reapplying before the cause is fixed may be blocked again on the next turn. After fixing it, reapply the same permission values once to assign a new revision, then send the cancelled instruction again.",
  gateObservationUnavailable: ({ revision, canReselect }) =>
    `The result of rev ${revision} could not be confirmed.${canReselect ? " Choosing the permission again resumes." : ""}`,
  gateNextOverCeiling: ({ revision, canReselect }) =>
    `The server's choice (rev ${revision}) exceeds the ceiling of the launch settings after the restart.${canReselect ? " Choosing a permission within the ceiling resumes." : ""} The same combination cannot be chosen, because both the server's clamp and the wrapper's final gate reject it.`,
  gateBlocked: ({ revision, step, canReselect }) =>
    `The wrapper is stopped before applying rev ${revision}${step}. Nothing ran under the server's fallback.${canReselect ? " Choosing the permission again resumes (the same combination is fine)." : ""} The cancelled instruction is not sent again.`,
  resetWithAttachments: "Session commands cannot be used with attachments",
  resetUnavailable: ({ command }) =>
    `${command} is not available in this session`,
  attachmentsUnsupported: "This session does not support attachments",
  attachmentsImagesOnly: "This session accepts image attachments only",
  attachmentTypeUnsupported:
    "This session does not support this kind of attachment",
  attachmentLimit: ({ max, dropped }) =>
    `Up to ${plural(max, "attachment", "attachments")} (${plural(dropped, "file was", "files were")} ignored)`,
  deleteConfirm: ({ name }) =>
    `This permanently deletes the offline agent "${name}". ` +
    `Its saved persona / session pointer / permission_mode are discarded, ` +
    `and this agent_id can no longer be restored. Continue?`,
  terminateConfirm: ({ name, state }) =>
    `"${name}" is ${state}. Terminating it may lose work in progress. Terminate?`,
  resumeConfirm: ({ name, state }) =>
    `"${name}" is ${state}. Switching the session may lose work in progress. Continue?`,
  clearHistoryConfirm:
    "This erases the reply logs of every session except the current one. This cannot be undone. Continue?",
  backToGrid: "Back to the grid",
  attentionTitle: "Go back to the list and handle them",
  attentionOthers: ({ count }) =>
    `${plural(count, "other agent needs", "other agents need")} attention (click for the list)`,
  statusSheetLabel: "Status",
  pinnedLabel: "Gauges and status line",
  pinnedDisclosure: "Gauges and status",
  pinnedShowAll: "Show all",
  pinnedShowLess: "Show less",
  detailTabsLabel: "Details",
  detailTabEngine: "engine",
  detailTabKaoiro: "kaoiro",
  detailTabNotice: "has notices",
  personaDetailAria: ({ name }) => `Show the persona details of ${name}`,
  renameTitle: "Change the display name",
  renameAria: ({ name }) => `Change the display name of ${name}`,
  renameInputAria: ({ name }) => `New display name for ${name}`,
  renaming: "Changing…",
  rename: "Change",
  sessionHistory: "Session history",
  accountDefault: "Account default",
  modelPending: "Awaiting confirmation",
  modelSwitchTitle: "Switch the model",
  switchButton: "Switch",
  modelsRefreshAria: "Reload the model list",
  modelsRefreshFailingTitle:
    "Loading the model list is failing. Click to reload",
  modelsRefreshTitle: "Reload the model list",
  modelMenuAria: "Model choices",
  fallbackModelHint:
    "Fell back by the safeguard (the setting is kept and comes back on restart)",
  effortDefault: "default",
  effortSwitchTitle: "Switch the effort",
  effortMenuAria: "Effort choices",
  effortCatalogHint:
    "Refresh the catalog (↻), or switch the effort after the first turn",
  resumeDriftTitle: "The resolved settings changed across the resume",
  workIntent: "Work intent",
  unconfirmed: "unconfirmed",
  axisWrite: ({ sandbox }) => `write: ${sandbox}`,
  axisApproval: ({ approval }) => `approval: ${approval}`,
  permModeMenuAria: "Permission mode choices",
  effectiveWriteScope: "Effective write scope",
  advisoryTitle:
    "The wrapper only inspects tool arguments; the OS does not enforce it (ADR-0057 F4)",
  hostFixedTitle: "Fixed by the host configuration",
  pastObservation: "Past observation",
  pastObservationNote: ({ revision }) =>
    `rev ${revision} — not the current permission:`,
  sandboxChange: "Change sandbox",
  ceilingNextTurn: ({ ceiling }) =>
    `ceiling ${ceiling} · applies from the next turn`,
  nextTurn: "applies from the next turn",
  sandboxMenuAria: "Sandbox choices",
  overCeiling: "over ceiling",
  networkChange: "Change network",
  networkDisable: "Disable",
  networkEnable: "Enable",
  networkCeiling: ({ enabled }) =>
    `ceiling ${enabled ? "enabled" : "disabled"}`,
  approvalChange: "Change approval",
  approvalMenuAria: "Approval choices",
  permissionRequest: "Permission request",
  permissionRequested: (p) => `Requested: ${axesWithNetwork(p)}`,
  permissionRequestedUnknown:
    "Requested: unknown (the server's choice is not settled)",
  permissionReason: ({ reason }) => `Reason: ${reason}`,
  reapplyHint:
    "Reapplying the same permission values creates a new revision. After it is applied, send the cancelled instruction again.",
  rolledBackApplied: (p) =>
    `Settings restored before applying: ${axesWithNetwork(p)}`,
  rolledBackFallback: (p) =>
    `Server fallback (not applied): ${axesWithNetwork(p)}`,
  permissionRequestError: "Permission request error",
  ctxLoading: "Loading",
  ctxWindow: ({ pct }) => `Window ${pct}%`,
  ctxBudget: ({ pct }) => `Budget ${pct}%`,
  ctxUnsupported: "Not supported",
  iaDelivery: "IA delivery",
  notDispatched: "Not dispatched",
  deliveryLost: ({ count }) => `Lost ${count}`,
  deliveryUncertain: ({ count }) => `Uncertain ${count}`,
  clearHistoryTitle:
    "Erases the reply logs of every session except the current one",
  clearHistoryDisabledTitle:
    "Cannot erase because the current session is unknown",
  clearHistory: "Erase logs of past sessions",
  resumeSwapTitle: "Resume this agent from another session",
  resumeSwapping: "Switching…",
  resumeSwap: "Resume from another session…",
  resumeMenuAria: "Session choices",
  resumeNoCandidates: "No session in this cwd can be resumed.",
  terminateTitle: "Terminate the agent (wrapper)",
  terminating: "Terminating…",
  terminate: "Terminate agent",
  restoreTitle: "Resume the session and bring the agent back",
  restoring: "Restoring…",
  restore: "Restore agent",
  logEmpty: "No replies yet.",
  showEarlier: ({ count }) => `Show earlier logs (${count})`,
  sessionBoundaryClear: "Session cleared, new session started",
  sessionBoundaryNew: "New session started",
  openPeerDetailTitle: ({ peer }) => `Open details of ${peer}`,
  toolCall: ({ name }) => `Tool call: ${name}`,
  toolResultLinkTitle: "Go to the matching result",
  toolInputTruncated: "\n…(input omitted: too large)",
  toolResult: ({ name }) => `Result: ${name}`,
  toolCallLinkTitle: "Go to the matching call",
  toolOutputTruncated: "\n…(omitted)",
  turnEndError: ({ detail }) => `Ended with an error (${detail})`,
  turnEndErrorPlain: "Ended with an error",
  turnEndDone: "Reply complete",
  costTitle:
    "An estimate at standard API prices. With a Claude subscription this is not the amount billed (it is close to the real cost only with a pay-as-you-go API key). Cumulative since the session started.",
  costTotal: ({ amount }) => `Total ~$${amount}`,
  retryTitle:
    "Sends this prompt again as a new instruction (text only; the original attachments are not included)",
  retrying: "Resending…",
  retry: "Resend",
  errorDetail: "Details",
  interruptTitle: "Interrupt the current turn (like ESC)",
  interrupting: "Interrupting…",
  interrupt: "Interrupt",
  deleteTitle: "Delete the offline agent from the ledger",
  deleting: "Deleting…",
  delete: "Delete",
  permissionExpandTitle: "Expand the permission dialog",
  permissionWaiting: "Awaiting permission (click to expand)",
  minimizeTitle: "Minimize",
  permissionMinimizeAria: "Minimize the permission dialog",
  permissionAskBefore: "Asking for permission to run ",
  permissionAskAfter: "",
  codexDenyNote: ({ minutes }) =>
    `The reason for a denial does not reach Codex (only decline is sent).${minutes !== null ? ` If ${plural(minutes, "minute passes", "minutes pass")} with no response and no activity, the turn watchdog interrupts the turn together with this request.` : ""}`,
  permissionInputTruncated: "(input omitted: too large)",
  allow: "Allow",
  deny: "Deny",
  codexRecoveryExpandTitle: "Expand the Codex permission recovery prompt",
  codexRecoveryWaiting: "Awaiting permission recovery (click to expand)",
  codexRecoveryMinimizeAria: "Minimize the Codex permission recovery prompt",
  codexGateStopped: "The Codex permission check is stopped",
  codexGateReapplyHint:
    "Reapplying the same sandbox / network creates a new revision, and the next turn can recover. Send the cancelled instruction again.",
  reapplySame: "Reapply the same permission values",
  gateStopped: "Stopped at the permission check",
  questionExpandTitle: "Expand the question dialog",
  questionWaiting: "Awaiting an answer (click to expand)",
  questionMinimizeAria: "Minimize the question dialog",
  questionTitle: "Choose an answer",
  questionOtherPlaceholder: "Free text",
  answer: "Answer",
  cancel: "Cancel",
  dialogModeHint:
    "Questions cannot be answered under the current work intent (session_capabilities.user_input_modes)",
  composerAria: "Instruction input and attachments",
  slashMenuAria: "Slash command choices",
  resetProgress: ({ mode, requester }) =>
    `Starting a new session… (mode: ${mode}${requester ? ` / ${requester}` : ""})`,
  composerResetPlaceholder: "Input is disabled during a session reset",
  composerPlaceholder:
    "Send an instruction… (Ctrl+Enter to send, / for commands, drag and drop or paste to send images and other files)",
  attachImagesTitle: "Attach images (multiple allowed)",
  attachFilesTitle:
    "Attach files (images / text / code / PDF / Office, multiple allowed)",
  attachUnsupportedTitle: "Not supported in this session",
  sending: "Sending…",
  send: "Send",
  trayCount: ({ count, max }) => `Attachments ${count}/${max}`,
  removeAttachmentAria: "Remove the attachment",
  uploadProgressAria: "Upload progress",
  sendingNote: "Sending… awaiting the reply",
  sendUnconfirmed:
    "No reply from the server, so delivery is unconfirmed. The instruction may already have reached the agent: check the log above before sending it again",
  sendNotConnected:
    "Not sent: the dashboard is not connected to the server. Send it again after it reconnects",
} satisfies Messages["agentDetail"];
