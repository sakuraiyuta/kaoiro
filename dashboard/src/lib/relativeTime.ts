// Relative-time formatting for the response timeline (issue #25). Kept
// as a pure helper so the timeline component and its tests do not have
// to touch Date directly or seed a Vitest fake timer. `now` is passed
// in explicitly by the caller — App.svelte owns a $state clock that
// ticks every RELATIVE_TIME_TICK_MS so tiles refresh live.

/** How often App.svelte re-ticks its `now` clock. Kept in one place so
 *  tests can assert the tick interval without dead reckoning. */
export const RELATIVE_TIME_TICK_MS = 30_000;

const MINUTE = 60;
const HOUR = 60 * 60;
const DAY = 24 * 60 * 60;

/** ISO ts → 「N 秒前」「N 分前」「N 時間前」「N 日前」/「たった今」. Future
 *  or missing ts falls back to a stable dash so the layout does not
 *  shift as the clock ticks. */
export function formatRelativeJa(ts: string, now: number): string {
  if (!ts) return "—";
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return "—";
  const deltaSec = Math.floor((now - parsed) / 1000);
  if (deltaSec < 0) return "—";
  if (deltaSec < 5) return "たった今";
  if (deltaSec < MINUTE) return `${deltaSec} 秒前`;
  if (deltaSec < HOUR) return `${Math.floor(deltaSec / MINUTE)} 分前`;
  if (deltaSec < DAY) return `${Math.floor(deltaSec / HOUR)} 時間前`;
  return `${Math.floor(deltaSec / DAY)} 日前`;
}
