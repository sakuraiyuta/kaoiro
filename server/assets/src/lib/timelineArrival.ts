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

/** Ordinary `envelope` events are used for both JSONL reconstruction and live
 * traffic. The explicit replay window is therefore the only authoritative
 * answer to whether an arrival may pulse. */
export function isTimelineReplayEnvelope(
  active: ActiveTimelineReplays,
  envelope: Envelope,
): boolean {
  return active[envelope.agent_id] !== undefined;
}
