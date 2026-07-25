// The dashboard receives replayed JSONL rows through the same `envelope`
// route as live rows. Pin the complete reset → replay → completion → live
// sequence against the production replay-window helper used by App.svelte.
import { describe, expect, it } from "vitest";
import {
  beginTimelineReplay,
  completeTimelineReplay,
  isTimelineReplayEnvelope,
} from "../src/lib/timelineArrival";
import { conversationEntryKey, isTimelineArrival } from "../src/lib/conversationTimeline";
import type { Envelope } from "../src/lib/protocol";

function assistant(seq: number, text: string): Envelope {
  return {
    version: "0",
    agent_id: "agent-a",
    session_id: "resume-session",
    ts: `2026-07-25T00:00:0${seq}Z`,
    seq,
    type: "log",
    state: "thinking",
    payload: { kind: "assistant", text },
  };
}

describe("timeline replay/live arrival integration (#125)", () => {
  it("history_reset → replayed assistant → complete → live assistant で replay だけ pulse しない", () => {
    let active = beginTimelineReplay({}, "agent-a", "replay-1");
    let pulseKeys = new Set<string>();

    const replayed = assistant(1, "JSONL replay");
    if (isTimelineArrival(replayed) && !isTimelineReplayEnvelope(active, replayed)) {
      pulseKeys.add(conversationEntryKey(replayed));
    }
    expect(pulseKeys).toEqual(new Set());

    active = completeTimelineReplay(active, "agent-a", "replay-1");
    const live = assistant(2, "live reply");
    if (isTimelineArrival(live) && !isTimelineReplayEnvelope(active, live)) {
      pulseKeys.add(conversationEntryKey(live));
    }
    expect(pulseKeys).toEqual(new Set([conversationEntryKey(live)]));
  });

  it("古い replay complete は現行 replay の抑止を解除しない", () => {
    let active = beginTimelineReplay({}, "agent-a", "replay-new");
    active = completeTimelineReplay(active, "agent-a", "replay-old");
    expect(isTimelineReplayEnvelope(active, assistant(1, "still replay"))).toBe(true);
  });
});
