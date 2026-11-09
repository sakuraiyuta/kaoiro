import type { Messages } from "../ja";

export const deliveryPolicy = {
  title: "Interrupt delivery while running",
  savedPolicy: ({ policy }) => `Saved setting: ${policy}`,
  saving: "Saving",
  apiUnconfirmed: "The operation API of this server is not confirmed",
  mechanisms: ({ operatorEarly, interAgentEarly }) =>
    `From you: ${operatorEarly} / Between agents: ${interAgentEarly}`,
  interAgentStop: ({ value }) => `Stopping between agents: ${value}`,
  stopUnsupported: "unsupported",
  stopToolBoundary: "at tool boundary",
  earlyOnly: " (early only)",
  acceptedMayComplete: "A request that was already accepted may still complete.",
  allow: "Allow interrupt delivery",
  refreshTitle:
    "Allows the matching delivery method to accept the request. It is not a setting that guarantees delivery.",
  refresh: "Refresh delivery state",
  waitingConnection: "Waiting for connection",
  unknownNormal: "State unknown · normal delivery",
  off: ({ pending }) =>
    `off (new interrupt delivery stopped)${pending ? " · waiting for wrapper confirmation" : ""}`,
  unsupportedNormalOnly: "Unsupported · normal delivery only",
  switchUnsupported: "Switching while running is unsupported",
  onConfirmed: "on (confirmed)",
  awaitingConfirmation: "Waiting for confirmation",
  saveUnconfirmed: "Save result unconfirmed",
  saveUnconfirmedRefreshFailed:
    "Save result unconfirmed · could not refresh the state",
  refreshFailed: "Could not refresh the state",
  conflictReselectAfterRefresh:
    "Updated by another operation. Refresh, then choose again",
  saveFailed: "Could not save the setting",
  conflictReselect: "Updated by another operation. Choose again",
} satisfies Messages["deliveryPolicy"];
