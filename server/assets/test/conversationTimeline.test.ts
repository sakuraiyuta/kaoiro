// 実機検収 3 (2026-07-23 マスター指示): 純関数 conversationEntries の
// 分類ロジック pin。 マスター spec = 「agent の応答 + ユーザ送信
// prompt」と IA を含み、「tool running 系」を除外。 新しい順。

import { describe, expect, it } from "vitest";
import {
  conversationEntries,
  SUMMARY_MAX_CHARS,
} from "../src/lib/conversationTimeline";
import type { Envelope } from "../src/lib/protocol";

function assistant(agentId: string, ts: string, text: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    ts,
    type: "log",
    state: "thinking",
    payload: { kind: "assistant", text },
  };
}

function user(agentId: string, ts: string, text: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    ts,
    type: "log",
    state: "sending",
    payload: { kind: "user", text },
  };
}

function toolUse(agentId: string, ts: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    ts,
    type: "log",
    state: "tool_running",
    payload: { kind: "tool_use", text: "irrelevant" },
  };
}

function toolResult(agentId: string, ts: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    ts,
    type: "log",
    state: "tool_running",
    payload: { kind: "tool_result", text: "irrelevant" },
  };
}

function resultEnv(agentId: string, ts: string, text: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    ts,
    type: "result",
    state: "done",
    payload: { text },
  };
}

function stateChange(agentId: string, ts: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    ts,
    type: "state_change",
    state: "idle",
  };
}

function interAgent(agentId: string, to: string, ts: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    ts,
    type: "inter_agent_message",
    state: "tool_running",
    payload: {
      to,
      conversation_id: "cid-x",
      turn_number: 1,
      kind: "inform",
      body: "hello",
    },
  };
}

describe("conversationEntries (実機検収 3)", () => {
  it("複数 agent の assistant / user を時系列マージして新しい順に返す (result は除外)", () => {
    const logs = {
      "agent-a": [
        assistant("agent-a", "2026-07-23T14:00:00Z", "早い assistant"),
        user("agent-a", "2026-07-23T14:30:00Z", "operator の prompt"),
      ],
      "agent-b": [
        // result は M4 で除外されるので数に入らない。
        resultEnv("agent-b", "2026-07-23T14:15:00Z", "b の result"),
        assistant("agent-b", "2026-07-23T14:45:00Z", "最新 assistant"),
      ],
    };
    const entries = conversationEntries(logs);
    // 新しい順: 14:45(b assistant) > 14:30(a user) > 14:00(a assistant)。
    // 14:15(b result) は除外。
    expect(entries.map((e) => e.envelope.ts)).toEqual([
      "2026-07-23T14:45:00Z",
      "2026-07-23T14:30:00Z",
      "2026-07-23T14:00:00Z",
    ]);
    expect(entries[0]?.agentId).toBe("agent-b");
    expect(entries[0]?.kind).toBe("agent");
    expect(entries[1]?.kind).toBe("user");
    expect(entries[2]?.kind).toBe("agent");
  });

  // ふじ 検収 2 fix-round M4 (2026-07-23): 通常 turn [user, assistant(X),
  // result(X)] は 2 会話行 (user + assistant) になる。 result 分の
  // 重複行を出さない直接 pin。
  it("M4: [user, assistant(X), result(X)] は 2 会話行 (user + assistant)、result は turn boundary 扱い", () => {
    const logs = {
      "agent-a": [
        user("agent-a", "2026-07-23T14:00:00Z", "hey"),
        assistant("agent-a", "2026-07-23T14:00:05Z", "答え"),
        resultEnv("agent-a", "2026-07-23T14:00:06Z", "答え"),
      ],
    };
    const entries = conversationEntries(logs);
    expect(entries).toHaveLength(2);
    // 新しい順: assistant > user。
    expect(entries[0]?.kind).toBe("agent");
    expect(entries[0]?.text).toBe("答え");
    expect(entries[1]?.kind).toBe("user");
    expect(entries[1]?.text).toBe("hey");
  });

  it("tool_use / tool_result は除外 (マスター指示: tool running 系)", () => {
    const logs = {
      "agent-a": [
        assistant("agent-a", "2026-07-23T14:00:00Z", "keep"),
        toolUse("agent-a", "2026-07-23T14:05:00Z"),
        toolResult("agent-a", "2026-07-23T14:10:00Z"),
      ],
    };
    const entries = conversationEntries(logs);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toBe("keep");
  });

  it("state_change は除外し、IA は送信元・受信側つきの一行になる", () => {
    const logs = {
      "agent-a": [
        assistant("agent-a", "2026-07-23T14:00:00Z", "keep"),
        stateChange("agent-a", "2026-07-23T14:05:00Z"),
        interAgent("agent-a", "agent-b", "2026-07-23T14:10:00Z"),
      ],
    };
    const entries = conversationEntries(logs);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.kind).toBe("inter_agent");
    expect(entries[0]?.agentId).toBe("agent-a");
    expect(entries[0]?.recipientId).toBe("agent-b");
    expect(entries[0]?.text).toBe("hello");
    expect(entries[1]?.kind).toBe("agent");
  });

  it("sender/receiver pane に複製された同一 IA は一行に dedupe する", () => {
    const message = interAgent("agent-a", "agent-b", "2026-07-23T14:10:00Z");
    const entries = conversationEntries({
      "agent-a": [message],
      "agent-b": [message],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("inter_agent");
  });

  it("user prompt entry の agentId は prompt が echoed された agent (送信先)", () => {
    // user prompt は operator が agent-a に送ったので、agent-a の
    // transcript に log kind=user として現れる。 entry.agentId が
    // 「誰との会話か」= 送信先 agent-a になることを pin。
    const logs = {
      "agent-a": [user("agent-a", "2026-07-23T14:00:00Z", "hey a")],
    };
    const entries = conversationEntries(logs);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.agentId).toBe("agent-a");
    expect(entries[0]?.kind).toBe("user");
    expect(entries[0]?.text).toBe("hey a");
  });

  it("同一 ts + seq で agent が異なる場合、両方が独立 entry として現れる", () => {
    const a = { ...assistant("agent-a", "2026-07-23T14:00:00Z", "a"), seq: 1 };
    const b = { ...assistant("agent-b", "2026-07-23T14:00:00Z", "b"), seq: 1 };
    const entries = conversationEntries({
      "agent-a": [a],
      "agent-b": [b],
    });
    expect(entries).toHaveLength(2);
  });

  it("長文 assistant は SUMMARY_MAX_CHARS で切り詰め + 省略記号", () => {
    const long = "あ".repeat(SUMMARY_MAX_CHARS + 20);
    const entries = conversationEntries({
      "agent-a": [assistant("agent-a", "2026-07-23T14:00:00Z", long)],
    });
    expect(entries[0]?.text.length).toBe(SUMMARY_MAX_CHARS);
    expect(entries[0]?.text.endsWith("…")).toBe(true);
  });

  it("改行 / 連続 whitespace は 1 スペースに畳む", () => {
    const entries = conversationEntries({
      "agent-a": [
        assistant("agent-a", "2026-07-23T14:00:00Z", "line1\n\nline2\t\tend"),
      ],
    });
    expect(entries[0]?.text).toBe("line1 line2 end");
  });

  it("空 payload.text の assistant は空 text を返す (UI 側で placeholder 表示)", () => {
    const emptyAssistant: Envelope = {
      version: "0",
      agent_id: "agent-a",
      ts: "2026-07-23T14:00:00Z",
      type: "log",
      state: "thinking",
      payload: { kind: "assistant" },
    };
    const entries = conversationEntries({ "agent-a": [emptyAssistant] });
    expect(entries[0]?.text).toBe("");
    expect(entries[0]?.kind).toBe("agent");
  });

  // M4 派生: result only の turn (稀な wrapper 実装) は timeline に
  // 載らない。 per-agent 詳細には別途表示される契約。
  it("assistant が無い result-only turn は timeline から drop する (M4 副作用)", () => {
    const entries = conversationEntries({
      "agent-a": [resultEnv("agent-a", "2026-07-23T14:00:00Z", "x")],
    });
    expect(entries).toEqual([]);
  });

  it("空 map / 空 transcript は空配列", () => {
    expect(conversationEntries({})).toEqual([]);
    expect(conversationEntries({ "agent-a": [] })).toEqual([]);
  });

  // ふじ 検収 2 fix-round A3 (2026-07-23): 丸めが UTF-16 code unit 単位
  // (`.slice`) だと 4-byte 絵文字を surrogate pair の途中で割って壊れた
  // 文字を生む。 code point 単位のイテレーションで防ぐ pin。
  it("A3: 4-byte 絵文字を含む長文でも surrogate pair を割らない", () => {
    // 「👨‍👩‍👧」等の ZWJ 連結までは Intl.Segmenter を要するので今回は
    // 単純な surrogate pair (1 emoji = 1 code point = 2 UTF-16 code units)
    // のみ pin。 SUMMARY_MAX_CHARS + 20 文字の全長で切り詰めが発生。
    const emoji = "😀";
    const long = emoji.repeat(SUMMARY_MAX_CHARS + 20);
    const entries = conversationEntries({
      "agent-a": [assistant("agent-a", "2026-07-23T14:00:00Z", long)],
    });
    // code point 単位で SUMMARY_MAX_CHARS。末尾 1 code point は "…"。
    expect(Array.from(entries[0]?.text ?? "").length).toBe(SUMMARY_MAX_CHARS);
    expect(entries[0]?.text.endsWith("…")).toBe(true);
    // pre-A3 の `.slice` は UTF-16 単位なので同じ計算で
    // `entries[0].text.length === SUMMARY_MAX_CHARS` になり、末尾 code
    // point の high surrogate だけ入って壊れる。 新実装は code point 単位
    // なので、UTF-16 length は `SUMMARY_MAX_CHARS * 2 - 1`
    // (絵文字 × 79 + "…") になる。
    expect(entries[0]?.text.length).toBe((SUMMARY_MAX_CHARS - 1) * 2 + 1);
  });
});
