// Hand-wait notifications (#7): alert the operator the moment an agent hands
// control back — waiting_input ("your turn") or waiting_permission ("approve
// this tool?") — so a backgrounded tab still surfaces the hand-off. Fires a
// desktop Notification plus a short, per-state cue sound; both degrade
// silently where the browser API is unavailable (non-secure context,
// test/node env).

import { expressionFor } from "./expression";
import type { Envelope } from "./protocol";
import inputSound from "./sounds/input.wav";
import permissionSound from "./sounds/permission.wav";

/** States that hand control back to the operator. */
const WAIT_STATES = new Set(["waiting_input", "waiting_permission"]);

/**
 * True only when an agent crosses from a non-wait state into a wait state, so
 * the operator is alerted once per hand-off rather than on every envelope
 * while waiting (and never when moving between the two wait states). A
 * first-seen agent (prev undefined) that arrives already waiting counts as a
 * transition.
 */
export function isWaitTransition(
  prev: string | undefined,
  next: string,
): boolean {
  return WAIT_STATES.has(next) && !WAIT_STATES.has(prev ?? "");
}

export interface NotificationContent {
  title: string;
  body: string;
}

/** Notification copy for a wait-state envelope: persona name (or agent id)
 *  as the title, the state's human label as the body. */
export function waitNotificationContent(
  envelope: Envelope,
): NotificationContent {
  return {
    title: envelope.persona?.name ?? envelope.agent_id,
    body: expressionFor(envelope.state).label,
  };
}

/** Ask for desktop-notification permission once, while it is still undecided.
 *  No-op where the API is absent (non-secure context / test env). */
export function requestNotificationPermission(): void {
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "default") {
    void Notification.requestPermission();
  }
}

/** The cue sound URL for a wait state, or undefined for any other state
 *  (which never raises an alert). */
export function soundUrlFor(state: string): string | undefined {
  if (state === "waiting_input") return inputSound;
  if (state === "waiting_permission") return permissionSound;
  return undefined;
}

/** Play the per-state cue for a wait-state envelope. Best-effort: silent
 *  where the HTMLAudioElement API is absent (test/node) or autoplay is
 *  blocked by browser policy until a user gesture. */
function playWaitSound(state: string): void {
  const url = soundUrlFor(state);
  if (url === undefined || typeof Audio === "undefined") return;
  try {
    void new Audio(url).play().catch(() => {
      // Autoplay may be blocked until a user gesture; ignore.
    });
  } catch {
    // Some contexts forbid constructing Audio; never break notification.
  }
}

/** Fire the hand-wait alert for a wait-state envelope: a desktop notification
 *  (when granted) tagged by agent so repeats replace rather than stack, plus a
 *  beep. Safe to call where the APIs are missing. */
export function notifyWait(envelope: Envelope): void {
  const { title, body } = waitNotificationContent(envelope);
  if (
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  ) {
    try {
      new Notification(title, { body, tag: `kaoiro:${envelope.agent_id}` });
    } catch {
      // Some contexts only allow notifications via a service worker; ignore.
    }
  }
  playWaitSound(envelope.state);
}
