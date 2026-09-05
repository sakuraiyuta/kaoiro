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

  // issue #287 (ふじ2 round1 S1): a success+is_error result never carries
  // payload.text (adapter.ts drops it), so the pre-#287 behavior left this
  // row blank even though the wrapper's own error_summary was available.
  it("is_error の result は error_summary を summary に使う (issue #287)", () => {
    const authFailure: Envelope = {
      version: "0",
      agent_id: "agent-a",
      ts: "2026-07-23T15:00:00Z",
      type: "result",
      state: "error",
      payload: {
        is_error: true,
        error_code: "authentication_failed",
        error_summary: "認証の有効期限が切れました。",
      },
    };
    const [entry] = latestReplies({ "agent-a": [authFailure] });
    expect(entry?.summary).toBe("認証の有効期限が切れました。");
  });

  // ふじ2 round2 M3: round1's S1 test never actually poisoned payload.text,
  // so it could not tell "replyText ignores text on is_error" apart from
  // "text just happened to be absent". A real wrapper bug (or a future
  // adapter.ts regression) could still leak the raw SDK text into
  // payload.text alongside a valid error_summary -- pin that error_summary
  // wins even when text carries a token-shaped poison.
  it("is_error のとき payload.text に token 風の毒が入っていても error_summary を優先する (negative control)", () => {
    const TOKEN_LIKE =
      "sk-ant-api03-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    const poisoned: Envelope = {
      version: "0",
      agent_id: "agent-a",
      ts: "2026-07-23T15:00:00Z",
      type: "result",
      state: "error",
      payload: {
        is_error: true,
        error_code: "authentication_failed",
        error_summary: "認証の有効期限が切れました。",
        text: `Failed to authenticate: ${TOKEN_LIKE}`,
      },
    };
    const [entry] = latestReplies({ "agent-a": [poisoned] });
    expect(entry?.summary).toBe("認証の有効期限が切れました。");
    expect(entry?.summary).not.toContain(TOKEN_LIKE);
  });

  it("is_error かつ error_summary も無いエントリは空 summary のまま (回帰防止)", () => {
    const bare: Envelope = {
      version: "0",
      agent_id: "agent-a",
      ts: "2026-07-23T15:00:00Z",
      type: "result",
      state: "error",
      payload: { is_error: true, error_subtype: "error_max_turns" },
    };
    const [entry] = latestReplies({ "agent-a": [bare] });
    expect(entry?.summary).toBe("");
  });
});
