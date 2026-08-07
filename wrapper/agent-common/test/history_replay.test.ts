// Hydration handshake driver (ADR-0051 D2). Covers the plan's failure-matrix
// rows on the wrapper side: (b) one server-allocated replay_id used across
// reset / replay_ia / complete with no double startup replay, (c) a
// `replay_required: false` verdict doing nothing at all, and (d) a fresh
// session answering with an empty replay so the server can mark it hydrated.

import { describe, expect, it } from "vitest";
import { HistoryReplayer } from "../src/history_replay.js";
import type { SidecarRecord } from "../src/ia_sidecar.js";
import type { Envelope } from "../src/types.js";

function logEnvelope(text: string): Envelope {
  return {
    version: "0",
    agent_id: "host-1.self",
    persona: { id: "ao", name: "あお", sprite_set: "ao" },
    ts: "2026-08-08T00:00:00Z",
    type: "log",
    state: "idle",
    payload: { kind: "assistant", text },
    ext: {},
  } as unknown as Envelope;
}

function sidecarRecord(stamp: number): SidecarRecord {
  return {
    ingress_stamp: [stamp, 0],
    envelope: {
      version: "0",
      agent_id: "host-1.peer",
      persona: { id: "ao", name: "あお", sprite_set: "ao" },
      ts: "2026-08-08T00:00:00Z",
      type: "inter_agent_message",
      state: "idle",
      payload: {},
      ext: {},
    } as unknown as Envelope,
  };
}

interface Harness {
  replayer: HistoryReplayer;
  events: string[];
  replayIaItems: SidecarRecord[][];
}

function harness(
  overrides: {
    sessionId?: string | null;
    transcript?: Envelope[];
    sidecar?: SidecarRecord[];
    legacyResumeSessionId?: string;
    readTranscript?: (sessionId: string) => Envelope[];
    readSidecar?: () => SidecarRecord[];
  } = {},
): Harness {
  const events: string[] = [];
  const replayIaItems: SidecarRecord[][] = [];
  const sessionId = overrides.sessionId === undefined ? "sess-1" : overrides.sessionId;

  const replayer = new HistoryReplayer({
    seedState: () => events.push("seed"),
    sessionId: () => sessionId,
    readTranscript:
      overrides.readTranscript ??
      ((sid) => {
        events.push(`transcript:${sid}`);
        return overrides.transcript ?? [];
      }),
    readSidecar: overrides.readSidecar ?? (() => overrides.sidecar ?? []),
    sendHistoryReset: (replayId) => events.push(`reset:${replayId}`),
    sendEnvelope: (envelope) => events.push(`send:${envelope.type}`),
    sendReplayIa: (replayId, items) => {
      events.push(`replay_ia:${replayId}:${items.length}`);
      replayIaItems.push([...items]);
    },
    sendHistoryReplayComplete: (replayId) => events.push(`complete:${replayId}`),
    ...(overrides.legacyResumeSessionId !== undefined
      ? { legacyResumeSessionId: overrides.legacyResumeSessionId }
      : {}),
    warn: (message) => events.push(`warn:${message}`),
  });

  return { replayer, events, replayIaItems };
}

describe("HistoryReplayer", () => {
  it("(b) server 採番 replay_id を reset / replay_ia / complete で一貫使用する", () => {
    const { replayer, events, replayIaItems } = harness({
      transcript: [logEnvelope("past")],
      sidecar: [sidecarRecord(10), sidecarRecord(11)],
    });

    replayer.markReady();
    replayer.onVerdict({ replay_required: true, replay_id: "hydr-xyz" });

    expect(events).toEqual([
      "seed",
      "transcript:sess-1",
      "reset:hydr-xyz",
      "send:log",
      "replay_ia:hydr-xyz:2",
      "complete:hydr-xyz",
    ]);
    expect(replayIaItems[0]?.map((r) => r.ingress_stamp)).toEqual([
      [10, 0],
      [11, 0],
    ]);
  });

  it("(c) replay_required: false では何も送らない", () => {
    const { replayer, events } = harness();

    replayer.markReady();
    replayer.onVerdict({ replay_required: false });

    expect(events).toEqual([]);
  });

  it("(d) fresh session (session_id 未採番・sidecar 空) は reset → 即 complete", () => {
    const { replayer, events } = harness({ sessionId: null });

    replayer.markReady();
    replayer.onVerdict({ replay_required: true, replay_id: "hydr-fresh" });

    expect(events).toEqual(["seed", "reset:hydr-fresh", "complete:hydr-fresh"]);
  });

  it("markReady 前に届いた verdict は ready で実行される (join 応答が host 構築より先)", () => {
    const { replayer, events } = harness();

    replayer.onVerdict({ replay_required: true, replay_id: "hydr-early" });
    expect(events).toEqual([]);

    replayer.markReady();
    expect(events).toEqual([
      "seed",
      "transcript:sess-1",
      "reset:hydr-early",
      "complete:hydr-early",
    ]);
  });

  it("再接続ごとの verdict をそのつど実行する (server 再起動後の再 hydration)", () => {
    const { replayer, events } = harness();
    replayer.markReady();

    replayer.onVerdict({ replay_required: true, replay_id: "hydr-1" });
    replayer.onVerdict({ replay_required: false });
    replayer.onVerdict({ replay_required: true, replay_id: "hydr-2" });

    expect(events.filter((e) => e.startsWith("reset:"))).toEqual([
      "reset:hydr-1",
      "reset:hydr-2",
    ]);
  });

  it("replay_id 欠落の verdict は警告して実行しない", () => {
    const { replayer, events } = harness();
    replayer.markReady();

    replayer.onVerdict({ replay_required: true });

    expect(events).toEqual([
      "warn:hydration: server asked for a replay without a replay_id; skipping",
    ]);
  });

  it("(b) legacy server (verdict 不在) は startup で 1 回だけ wrapper 採番 replay を実行する", () => {
    const { replayer, events } = harness({ legacyResumeSessionId: "sess-1" });
    replayer.markReady();

    replayer.onVerdict(null);
    replayer.onVerdict(null);

    const resets = events.filter((e) => e.startsWith("reset:"));
    expect(resets).toHaveLength(1);
    expect(resets[0]).toMatch(/^reset:resume-/);
  });

  it("legacy server + resume 対象なしなら replay しない (旧挙動の維持)", () => {
    const { replayer, events } = harness();
    replayer.markReady();

    replayer.onVerdict(null);

    expect(events).toEqual([]);
  });

  it("transcript / sidecar の読み出しが失敗しても complete 境界は必ず送る", () => {
    const { replayer, events } = harness({
      readTranscript: () => {
        throw new Error("transcript boom");
      },
      readSidecar: () => {
        throw new Error("sidecar boom");
      },
    });
    replayer.markReady();

    replayer.onVerdict({ replay_required: true, replay_id: "hydr-err" });

    // 読めなかった分は復元されないが、境界を送らないと server は永遠に
    // unhydrated のままになる。
    expect(events).toEqual([
      "seed",
      "warn:hydration: transcript read failed: Error: transcript boom",
      "warn:hydration: sidecar read failed: Error: sidecar boom",
      "reset:hydr-err",
      "complete:hydr-err",
    ]);
  });

  it("sidecar が空なら replay_ia を送らない", () => {
    const { replayer, events } = harness({ transcript: [logEnvelope("x")] });
    replayer.markReady();

    replayer.onVerdict({ replay_required: true, replay_id: "hydr-noia" });

    expect(events.some((e) => e.startsWith("replay_ia:"))).toBe(false);
  });
});
