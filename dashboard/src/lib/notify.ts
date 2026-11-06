// Hand-wait notifications (#7): alert the operator the moment an agent hands
// control back — waiting_input ("your turn") or waiting_permission ("approve
// this tool?") — so a backgrounded tab still surfaces the hand-off. Fires a
// notification plus a short, per-state cue sound. Mobile browsers can use
// the registered service worker when the page constructor is unavailable.

import { expressionFor } from "./expression";
import type { Envelope } from "./protocol";
import { settings } from "./settings.svelte";
import inputSound from "./sounds/input.wav";
import permissionSound from "./sounds/permission.wav";

/** States that hand control back to the operator. */
const WAIT_STATES = new Set([
  "waiting_input",
  "waiting_permission",
  "waiting_question",
]);

let registration: Promise<ServiceWorkerRegistration | null> = Promise.resolve(null);
let warned = false;

export function registerNotificationWorker(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  try {
    registration = navigator.serviceWorker
      .register("/notification-worker/sw.js")
      .catch(() => null);
  } catch {
    registration = Promise.resolve(null);
  }
}

function activeRegistration(): Promise<ServiceWorkerRegistration | null> {
  return new Promise((resolve) => {
    let finished = false;
    let worker: ServiceWorker | undefined;
    const finish = (result: ServiceWorkerRegistration | null) => {
      finished = true;
      clearTimeout(timer);
      worker?.removeEventListener("statechange", changed);
      resolve(result);
    };
    let current: ServiceWorkerRegistration | null = null;
    const changed = () => {
      if (current?.active?.state === "activated") finish(current);
      else if (worker?.state === "redundant") finish(null);
    };
    const timer = setTimeout(() => finish(null), 5000);
    void registration.then((result) => {
      if (finished) return;
      current = result;
      if (!result) return finish(null);
      if (result.active?.state === "activated") return finish(result);
      worker = result.active ?? result.installing ?? result.waiting ?? undefined;
      if (!worker) return finish(null);
      worker.addEventListener("statechange", changed);
      changed();
    });
  });
}

async function showWorkerNotification(title: string, options: NotificationOptions): Promise<void> {
  try {
    const active = await activeRegistration();
    if (!active) throw new Error("notification worker unavailable");
    await active.showNotification(title, options);
  } catch {
    if (!warned) {
      warned = true;
      console.warn("Unable to show a hand-wait notification");
    }
  }
}

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

/** Notification copy for a wait-state envelope: display_name (or agent id)
 *  as the title, the state's human label as the body. */
export function waitNotificationContent(
  envelope: Envelope,
): NotificationContent {
  return {
    title: envelope.display_name ?? envelope.agent_id,
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
  // Reuse the permission cue for the question hand-off (no separate asset).
  if (state === "waiting_question") return permissionSound;
  return undefined;
}

/** Play the per-state cue for a wait-state envelope. Best-effort: silent
 *  where the HTMLAudioElement API is absent (test/node) or autoplay is
 *  blocked by browser policy until a user gesture. Respects the operator's
 *  notification-sound settings (#85): muted when disabled, scaled by volume. */
function playWaitSound(state: string): void {
  if (!settings.notificationSoundEnabled) return;
  const url = soundUrlFor(state);
  if (url === undefined || typeof Audio === "undefined") return;
  try {
    const audio = new Audio(url);
    audio.volume = settings.notificationSoundVolume;
    void audio.play().catch(() => {
      // Autoplay may be blocked until a user gesture; ignore.
    });
  } catch {
    // Some contexts forbid constructing Audio; never break notification.
  }
}

/** Fire the hand-wait alert for a wait-state envelope: a notification
 *  (when granted) tagged by agent so repeats replace rather than stack, plus a
 *  beep. Safe to call where the APIs are missing. */
export function notifyWait(envelope: Envelope): void {
  const { title, body } = waitNotificationContent(envelope);
  if (
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  ) {
    const options = { body, tag: `kaoiro:${envelope.agent_id}` };
    try {
      new Notification(title, options);
    } catch {
      void showWorkerNotification(title, options);
    }
  }
  playWaitSound(envelope.state);
}
