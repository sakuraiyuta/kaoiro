// Relative-time formatting for the response timeline (issue #25). Kept
// as a pure helper so the timeline component and its tests do not have
// to touch Date directly or seed a Vitest fake timer. `now` is passed
// in explicitly by the caller — App.svelte owns a $state clock that
// ticks every RELATIVE_TIME_TICK_MS so tiles refresh live.

import { msg } from "./i18n/index.svelte";

/** How often App.svelte re-ticks its `now` clock. Kept in one place so
 *  tests can assert the tick interval without dead reckoning. */
export const RELATIVE_TIME_TICK_MS = 30_000;

const MINUTE = 60;
const HOUR = 60 * 60;
const DAY = 24 * 60 * 60;

/** ISO ts → "N seconds/minutes/hours/days ago" or "just now", worded by the
 *  current locale. Future or missing ts falls back to a stable dash so the
 *  layout does not shift as the clock ticks. */
export function formatRelative(ts: string, now: number): string {
  if (!ts) return "—";
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return "—";
  const deltaSec = Math.floor((now - parsed) / 1000);
  if (deltaSec < 0) return "—";
  const t = msg().time;
  if (deltaSec < 5) return t.justNow;
  if (deltaSec < MINUTE) return t.secondsAgo({ n: deltaSec });
  if (deltaSec < HOUR) return t.minutesAgo({ n: Math.floor(deltaSec / MINUTE) });
  if (deltaSec < DAY) return t.hoursAgo({ n: Math.floor(deltaSec / HOUR) });
  return t.daysAgo({ n: Math.floor(deltaSec / DAY) });
}
