import type { Messages } from "../ja";
import { plural } from "./plural";

export const app = {
  quagmireRally: ({ names, turns, conversations, threshold }) =>
    `The exchange between ${names} reached ${plural(turns, "message", "messages")} ` +
    `(${plural(conversations, "conversation", "conversations")}, threshold ${threshold}). ` +
    `Check on their progress.`,
  quagmireDeliveryGap:
    "Delivery confirmation may be delayed (processing completed within the period).",
  quagmireStalled: "The exchange may be stalled.",
  quagmireUnconfirmed: ({ label, undelivered, since, diagnosis }) =>
    `Delivery of ${plural(undelivered, "message", "messages")} to ${label} is not confirmed (since ${since}). ${diagnosis}`,
  timeUnknown: "unknown time",
  ceilingNarrow: ({ axis, ceiling, current }) =>
    `Narrow ${axis} to ${ceiling} before the reset (current: ${current})`,
  ceilingSandboxFixed: ({ ceiling }) =>
    `The current sandbox is danger-full-access, so network_access is fixed to true. Narrow the sandbox to ${ceiling} first.`,
  ceilingNetworkNarrow: ({ ceiling }) =>
    `If network_access still exceeds the ceiling after that, narrow it to ${ceiling}.`,
  spawnStarted: ({ label }) => `Launched: ${label}`,
  spawnFailed: ({ label, reason }) => `Launch failed: ${label} (${reason})`,
  terminateFailed: ({ reason }) => `Cannot terminate (${reason})`,
  restoreFailed: ({ reason }) => `Cannot restore (${reason})`,
  attachRejected: ({ uploadId, reason, detail }) =>
    `Attachment rejected: ${uploadId} (${reason}${detail !== null ? ` — ${detail}` : ""})`,
  instructionRejected: ({ reason, detail }) =>
    `Instruction rejected: ${reason}${detail !== null ? ` — ${detail}` : ""}`,
  sessionResetFailed: ({ mode, reason, hint }) =>
    `session_reset failed (${mode}): ${reason}${hint !== null ? ` — ${hint}` : ""}`,
  restoreAllConfirm: ({ count }) =>
    `This restores ${plural(count, "offline agent", "offline agents")} in bulk. Continue?`,
  deleteAllConfirm: ({ count }) =>
    `This permanently deletes ${plural(count, "offline agent", "offline agents")}.` +
    "\nTheir conversation restore information is deleted too. This cannot be undone. Continue?",
  deleteAllFailed: ({ failed }) =>
    `Could not delete ${plural(failed, "agent", "agents")}`,
  loginTokenInvalid: "The token is invalid.",
  loginServerUnreachable: "Could not connect to the server.",
  logoutConfirm: "Log out?",
  authErrorProvider: "Login with the authentication provider failed.",
  authErrorNotAllowed:
    "This account is not allowed to access kaoiro. Ask an administrator.",
  authErrorInvalidState:
    "The authentication session has expired. Please try again.",
  authErrorDefault: "Login failed. Please try again.",
  loginEnterToken: "Enter the access token.",
  loginChooseMethod: "Choose a login method.",
  loginNoMethod:
    "No authentication method is configured. Ask an administrator.",
  loginForDevice: "Log in first to approve the device login.",
  tokenPlaceholder: "Token",
  tokenAria: "Access token",
  loginChecking: "Checking…",
  loginSubmit: "Log in",
  loginOr: "or",
  loginWithProvider: ({ provider }) => `Log in with ${provider}`,
  buildInfoAria: "Build information",
  agentListAria: "Agent list",
  settings: "Settings",
  launch: "+ Launch",
  logout: "Log out",
  snapshotAgentsCapped:
    "Some agents are not shown because of the snapshot limit.",
  snapshotDeliveryCapped:
    "Some inter-agent delivery confirmations are not shown because of the snapshot limit.",
  snapshotBuildInfoPartial: "Part of the build information cannot be shown.",
  snapshotHistoryPartial: "Part of the history cannot be shown.",
  snapshotHostsPartial: "Part of the host list cannot be shown.",
  snapshotDirectoryPartial: "Part of the agent list cannot be shown.",
  previousAgentAria: ({ name }) => `Go to the previous agent, ${name}`,
  previousAgentTitle: ({ name }) => `Previous: ${name}`,
  nextAgentAria: ({ name }) => `Go to the next agent, ${name}`,
  nextAgentTitle: ({ name }) => `Next: ${name}`,
  offlineSummary: ({ count }) => `Offline (${count})`,
  restoreAllTitle: "Restore all offline agents",
  restoreAll: "Restore previous state",
  deleteAllTitle: "Delete all offline agents from the ledger",
  deleteAll: "Delete all",
  deletingAll: "Deleting…",
  connecting: "Connecting…",
} satisfies Messages["app"];
