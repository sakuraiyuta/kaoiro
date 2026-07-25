import type { Envelope } from "./protocol";

/** Active JSONL replays indexed by producer agent. A replay's completion is
 * paired by `replay_id`, so a delayed completion from a prior reconnect
 * cannot accidentally enable live-pulse behavior for a newer replay. */
export type ActiveTimelineReplays = Readonly<Record<string, string>>;

export function beginTimelineReplay(
  active: ActiveTimelineReplays,
  agentId: string,
  replayId: string | undefined,
): ActiveTimelineReplays {
  const { [agentId]: _previous, ...remaining } = active;
  return replayId === undefined
    ? remaining
    : { ...remaining, [agentId]: replayId };
}

export function completeTimelineReplay(
  active: ActiveTimelineReplays,
  agentId: string,
  replayId: string,
): ActiveTimelineReplays {
  if (active[agentId] !== replayId) return active;
  const { [agentId]: _complete, ...remaining } = active;
  return remaining;
}

/** Drops the active-replay marker for `agentId` (agent_deleted 経路など).
 * Shaped identically to `beginTimelineReplay(active, agentId, undefined)`
 * but named for the intent so callers read "clear" rather than "begin"
 * with a nullish id (クロエ #122 再レビュー advisory 1)。*/
export function clearTimelineReplay(
  active: ActiveTimelineReplays,
  agentId: string,
): ActiveTimelineReplays {
  return beginTimelineReplay(active, agentId, undefined);
}

/** Ordinary `envelope` events are used for both JSONL reconstruction and live
 * traffic. The explicit replay window is therefore the only authoritative
 * answer to whether an arrival may pulse. */
export function isTimelineReplayEnvelope(
  active: ActiveTimelineReplays,
  envelope: Envelope,
): boolean {
  return active[envelope.agent_id] !== undefined;
}

/** Entry keys that were present in `prev` but no longer in `next` (issue #122
 * ふじ再レビュー must-fix). Used by App.svelte's timeline-state prune to drop
 * read / new-pulse bookkeeping ONLY for rows actually being discarded. The
 * previous "all of prev is stale" implementation clobbered read state for
 * entries that filterAfterHistoryCleared / resetTranscriptHistory kept alive
 * (typically IA envelopes with preserve_inter_agent: true), making previously
 * read rows re-appear as unread after a resume. Full-drop cases (agent_deleted)
 * still get the whole set via `next = []`. Pure so it is unit-testable
 * alongside beginTimelineReplay / completeTimelineReplay. */
export function computeStaleTimelineKeys(
  prev: readonly Envelope[],
  next: readonly Envelope[],
  toKey: (envelope: Envelope) => string,
): Set<string> {
  const nextKeys = new Set<string>();
  for (const entry of next) nextKeys.add(toKey(entry));
  const stale = new Set<string>();
  for (const entry of prev) {
    const key = toKey(entry);
    if (!nextKeys.has(key)) stale.add(key);
  }
  return stale;
}
