// 実機検収 3 (2026-07-23 マスター指示): 純関数 conversationEntries の
// 分類ロジック pin。 マスター spec = 「agent の応答 + ユーザ送信
// prompt」を含み、「tool running 系」を除外。 新しい順。

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
  it("複数 agent の assistant / user / result を時系列マージして新しい順に返す", () => {
    const logs = {
      "agent-a": [
        assistant("agent-a", "2026-07-23T14:00:00Z", "早い assistant"),
        user("agent-a", "2026-07-23T14:30:00Z", "operator の prompt"),
      ],
      "agent-b": [
        resultEnv("agent-b", "2026-07-23T14:15:00Z", "b の result"),
        assistant("agent-b", "2026-07-23T14:45:00Z", "最新 assistant"),
      ],
    };
    const entries = conversationEntries(logs);
    // 新しい順: 14:45(b assistant) > 14:30(a user) > 14:15(b result) > 14:00(a assistant)
    expect(entries.map((e) => e.envelope.ts)).toEqual([
      "2026-07-23T14:45:00Z",
      "2026-07-23T14:30:00Z",
      "2026-07-23T14:15:00Z",
      "2026-07-23T14:00:00Z",
    ]);
    expect(entries[0]?.agentId).toBe("agent-b");
    expect(entries[0]?.kind).toBe("agent");
    expect(entries[1]?.kind).toBe("user");
    expect(entries[2]?.kind).toBe("agent");
    expect(entries[3]?.kind).toBe("agent");
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

  it("state_change / inter_agent_message は除外 (会話行ではない)", () => {
    const logs = {
      "agent-a": [
        assistant("agent-a", "2026-07-23T14:00:00Z", "keep"),
        stateChange("agent-a", "2026-07-23T14:05:00Z"),
        interAgent("agent-a", "agent-b", "2026-07-23T14:10:00Z"),
      ],
    };
    const entries = conversationEntries(logs);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("agent");
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

  it("空 payload.text の result は空 text を返す (UI 側で '(空応答)' 表示)", () => {
    const errored: Envelope = {
      version: "0",
      agent_id: "agent-a",
      ts: "2026-07-23T14:00:00Z",
      type: "result",
      state: "done",
      payload: { is_error: true },
    };
    const entries = conversationEntries({ "agent-a": [errored] });
    expect(entries[0]?.text).toBe("");
  });

  it("空 map / 空 transcript は空配列", () => {
    expect(conversationEntries({})).toEqual([]);
    expect(conversationEntries({ "agent-a": [] })).toEqual([]);
  });
});
