// The dashboard receives replayed JSONL rows through the same `envelope`
// route as live rows. Pin the complete reset → replay → completion → live
// sequence against the production replay-window helper used by App.svelte.
import { describe, expect, it } from "vitest";
import {
  beginTimelineReplay,
  completeTimelineReplay,
  computeStaleTimelineKeys,
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

describe("computeStaleTimelineKeys (ふじ #122 再レビュー must-fix 2026-07-25)", () => {
  function ia(seq: number, to: string): Envelope {
    return {
      version: "0",
      agent_id: "agent-a",
      session_id: "resume-session",
      ts: `2026-07-25T00:00:0${seq}Z`,
      seq,
      type: "inter_agent_message",
      state: "thinking",
      payload: { kind: "message", to, text: "hi" },
    } as unknown as Envelope;
  }

  it("prev と next の差分が stale (next にも残る entry の key は含めない)", () => {
    const a = assistant(1, "a");
    const b = ia(2, "agent-b");
    const c = assistant(3, "c");
    const stale = computeStaleTimelineKeys([a, b, c], [b], conversationEntryKey);
    expect(stale).toEqual(
      new Set([conversationEntryKey(a), conversationEntryKey(c)]),
    );
    expect(stale.has(conversationEntryKey(b))).toBe(false);
  });

  it("next=[] (agent_deleted / 全消去) では prev の全 key が stale", () => {
    const a = assistant(1, "a");
    const b = ia(2, "agent-b");
    const stale = computeStaleTimelineKeys([a, b], [], conversationEntryKey);
    expect(stale).toEqual(
      new Set([conversationEntryKey(a), conversationEntryKey(b)]),
    );
  });

  it("preserve_inter_agent: true 相当 (IA だけ next に残る) — IA の read/pulse state は保持される", () => {
    // resetTranscriptHistory(prev, true) が IA だけ残す挙動を再現。
    // 過去実装 (prev 全てを stale) だとこの IA も read/pulse から消えていた。
    const assistantEntry = assistant(1, "before");
    const iaEntry = ia(2, "agent-b");
    const stale = computeStaleTimelineKeys(
      [assistantEntry, iaEntry],
      [iaEntry],
      conversationEntryKey,
    );
    expect(stale.has(conversationEntryKey(iaEntry))).toBe(false);
    expect(stale.has(conversationEntryKey(assistantEntry))).toBe(true);
  });

  it("prev が空なら stale も空 (副作用なし)", () => {
    expect(computeStaleTimelineKeys([], [], conversationEntryKey)).toEqual(
      new Set(),
    );
    expect(computeStaleTimelineKeys([], [assistant(1, "x")], conversationEntryKey)).toEqual(
      new Set(),
    );
  });
});
