import { describe, expect, it } from "vitest";
import type { Envelope } from "../src/lib/protocol";
import {
  SUMMARY_MAX_CHARS,
  latestReplies,
} from "../src/lib/latestReply";

function assistantLog(
  agentId: string,
  ts: string,
  text: string,
  seq = 1,
): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    ts,
    seq,
    type: "log",
    state: "thinking",
    payload: { kind: "assistant", text },
  };
}

function toolUseLog(agentId: string, ts: string, tool: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    ts,
    type: "log",
    state: "tool_running",
    payload: { kind: "tool_use", tool_name: tool },
  };
}

function userLog(agentId: string, ts: string, text: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    ts,
    type: "log",
    state: "thinking",
    payload: { kind: "user", text },
  };
}

function result(
  agentId: string,
  ts: string,
  text: string,
  seq = 1,
): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    ts,
    seq,
    type: "result",
    state: "done",
    payload: { text },
  };
}

describe("latestReplies (#25)", () => {
  it("agent ごとの最新 assistant/result を新しい順に返す", () => {
    const logs: Record<string, Envelope[]> = {
      "agent-a": [
        assistantLog("agent-a", "2026-07-23T15:00:00Z", "古い応答"),
        assistantLog("agent-a", "2026-07-23T15:05:00Z", "新しい応答"),
      ],
      "agent-b": [result("agent-b", "2026-07-23T15:10:00Z", "b の返答")],
    };
    const entries = latestReplies(logs);
    expect(entries.map((e) => e.agentId)).toEqual(["agent-b", "agent-a"]);
    expect(entries[0]?.summary).toBe("b の返答");
    expect(entries[1]?.summary).toBe("新しい応答");
  });

  it("tool_use / user / inter_agent は除外し、応答のみ拾う", () => {
    const logs: Record<string, Envelope[]> = {
      "agent-a": [
        toolUseLog("agent-a", "2026-07-23T15:00:00Z", "Bash"),
        userLog("agent-a", "2026-07-23T15:01:00Z", "operator prompt"),
        assistantLog("agent-a", "2026-07-23T15:02:00Z", "本物の応答"),
      ],
    };
    const entries = latestReplies(logs);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.summary).toBe("本物の応答");
  });

  it("応答が 1 件もない agent は entries に出さない", () => {
    const logs: Record<string, Envelope[]> = {
      "agent-a": [toolUseLog("agent-a", "2026-07-23T15:00:00Z", "Bash")],
    };
    expect(latestReplies(logs)).toEqual([]);
  });

  it("長文と改行を含む text は 1 行 summary に collapse + ellipsis", () => {
    const long = "あ".repeat(SUMMARY_MAX_CHARS + 20);
    const logs: Record<string, Envelope[]> = {
      "agent-a": [
        assistantLog(
          "agent-a",
          "2026-07-23T15:00:00Z",
          "改行\nを\n含む\nテキスト",
        ),
        assistantLog("agent-a", "2026-07-23T15:01:00Z", long),
      ],
    };
    const [entry] = latestReplies(logs);
    expect(entry?.summary.length).toBe(SUMMARY_MAX_CHARS);
    expect(entry?.summary.endsWith("…")).toBe(true);
    // 空白 collapse も 1 行 summary の直接検証: 別 ts の agent で pin。
    const collapsed = latestReplies({
      "agent-b": [
        assistantLog("agent-b", "2026-07-23T15:00:00Z", "1 行目\n2 行目"),
      ],
    });
    expect(collapsed[0]?.summary).toBe("1 行目 2 行目");
  });

  it("同一 ts は seq を副次比較 (protocol の compareTranscriptEnvelopes と同型)", () => {
    const logs: Record<string, Envelope[]> = {
      "agent-a": [
        assistantLog("agent-a", "2026-07-23T15:00:00Z", "先", 1),
        assistantLog("agent-a", "2026-07-23T15:00:00Z", "後", 2),
      ],
    };
    const [entry] = latestReplies(logs);
    expect(entry?.summary).toBe("後");
  });

  it("result payload に text が無いエントリは空 summary で出す (空応答フォールバック)", () => {
    const noText: Envelope = {
      version: "0",
      agent_id: "agent-a",
      ts: "2026-07-23T15:00:00Z",
      type: "result",
      state: "done",
      payload: { is_error: true },
    };
    const [entry] = latestReplies({ "agent-a": [noText] });
    expect(entry?.summary).toBe("");
  });
});
