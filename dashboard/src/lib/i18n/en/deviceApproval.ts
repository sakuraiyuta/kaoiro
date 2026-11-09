import type { Messages } from "../ja";

export const deviceApproval = {
  unknownCode:
    "This code was not found. Check the code shown on the device and what you typed.",
  expired:
    "This code has expired. Log in again on the device to get a new code.",
  rateLimited: ({ seconds }) =>
    `Too many attempts. Wait about ${seconds} seconds, then enter it again.`,
  alreadyDecided: "This code has already been approved or denied.",
  unauthorized: "The session has expired. Log in again with OAuth.",
  oauthSessionRequired:
    "A shared-token session cannot approve this. Log in again with OAuth.",
  unavailable: "This server does not provide device approval.",
  generic: "The request failed. Enter the code again.",
  title: "Approve a device login",
  enterCode: "Enter the code shown on the device",
  checking: "Checking…",
  check: "Check",
  selfReported: "(self-reported by the client; not a basis for trust)",
  issued: "Issued",
  remaining: "Remaining",
  identityToApprove: "Identity to approve",
  connectsAs: "The device will connect with this identity and role.",
  verifyWarning:
    "Make sure it matches the code shown on the device. Deny it unless you just started this login yourself.",
  approve: "Approve",
  deny: "Deny",
  approved: "Approved. The device connects within a few seconds.",
  denied: "Denied. The device is told that it was denied.",
  loginWith: ({ provider }) => `Log in with ${provider}`,
  enterAgain: "Enter again",
  remainingSeconds: ({ seconds }) => `${seconds} s`,
  remainingMinutes: ({ minutes, seconds }) => `${minutes} min ${seconds} s`,
} satisfies Messages["deviceApproval"];
