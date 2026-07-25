import { describe, expect, it } from "vitest";
import type { ThreadEvent } from "@openai/codex-sdk";
import { reduceStates } from "@kaoiro/agent-common";
import {
  threadEventToErrorDetail,
  threadEventToEvents,
  threadEventToFinalText,
  threadEventToLogs,
  threadEventToSessionId,
} from "../src/adapter.js";

const THREAD_STARTED: ThreadEvent = {
  type: "thread.started",
  thread_id: "019f4bdb-d821-7631-aee1-ec7982060311",
};

function agentMessage(id: string, text: string): ThreadEvent {
  return {
    type: "item.completed",
    item: { id, type: "agent_message", text },
  };
}

const COMMAND_STARTED: ThreadEvent = {
  type: "item.started",
  item: {
    id: "item_1",
    type: "command_execution",
    command: "ls -la",
    aggregated_output: "",
    status: "in_progress",
  },
};

const COMMAND_COMPLETED: ThreadEvent = {
  type: "item.completed",
  item: {
    id: "item_1",
    type: "command_execution",
    command: "ls -la",
    aggregated_output: "total 0",
    exit_code: 0,
    status: "completed",
  },
};

describe("threadEventToEvents", () => {
  it("典型的な 1 turn を idle 経由なしで thinking→tool_running→done に導出する", () => {
    const events: ThreadEvent[] = [
      THREAD_STARTED,
      { type: "turn.started" },
      COMMAND_STARTED,
      COMMAND_COMPLETED,
      {
        type: "item.started",
        item: { id: "m1", type: "agent_message", text: "" },
      },
      agentMessage("m1", "できました"),
      {
        type: "turn.completed",
        usage: {
          input_tokens: 10,
          cached_input_tokens: 0,
          output_tokens: 5,
          reasoning_output_tokens: 2,
        },
      },
    ];
    const adapterEvents = events.flatMap(threadEventToEvents);
    // user_send (sending) を先頭に置くと session_init が sending を保持する
    const trace = reduceStates(
      [{ kind: "user_send" }, ...adapterEvents],
      "idle",
    );
    expect(trace).toEqual([
      "sending",
      "thinking",
      "tool_running",
      "thinking",
      "thinking",
      "done",
      "waiting_input",
    ]);
  });

  it("turn.failed は error → waiting_input", () => {
    const adapterEvents = threadEventToEvents({
      type: "turn.failed",
      error: { message: "boom" },
    });
    expect(reduceStates(adapterEvents, "thinking")).toEqual([
      "error",
      "waiting_input",
    ]);
  });

  it("item.updated と todo_list は状態に影響しない", () => {
    expect(
      threadEventToEvents({
        type: "item.updated",
        item: { id: "t", type: "todo_list", items: [] },
      }),
    ).toEqual([]);
    expect(
      threadEventToEvents({
        type: "item.started",
        item: { id: "t", type: "todo_list", items: [] },
      }),
    ).toEqual([]);
  });

  it("reasoning は thinking 扱い", () => {
    const events = threadEventToEvents({
      type: "item.started",
      item: { id: "r", type: "reasoning", text: "…" },
    });
    expect(events).toEqual([{ kind: "assistant", blocks: ["thinking"] }]);
  });
});

describe("threadEventToLogs", () => {
  it("command_execution は tool_use / tool_result のペアになる", () => {
    expect(threadEventToLogs(COMMAND_STARTED)).toEqual([
      {
        kind: "tool_use",
        tool_use_id: "item_1",
        tool_name: "shell",
        input: { command: "ls -la" },
      },
    ]);
    expect(threadEventToLogs(COMMAND_COMPLETED)).toEqual([
      { kind: "tool_result", tool_use_id: "item_1", output: "total 0" },
    ]);
  });

  it("非ゼロ exit は output に exit code を前置する", () => {
    const logs = threadEventToLogs({
      type: "item.completed",
      item: {
        id: "item_2",
        type: "command_execution",
        command: "false",
        aggregated_output: "",
        exit_code: 1,
        status: "failed",
      },
    });
    expect(logs[0]?.kind).toBe("tool_result");
    expect((logs[0] as { output: string }).output).toContain("(exit 1)");
  });

  it("mcp_tool_call は FQN 名と結果テキストを持つ", () => {
    const started = threadEventToLogs({
      type: "item.started",
      item: {
        id: "mcp_1",
        type: "mcp_tool_call",
        server: "kaoiro",
        tool: "whoami",
        arguments: {},
        status: "in_progress",
      },
    });
    expect(started).toEqual([
      {
        kind: "tool_use",
        tool_use_id: "mcp_1",
        tool_name: "mcp__kaoiro__whoami",
        input: {},
      },
    ]);
    const completed = threadEventToLogs({
      type: "item.completed",
      item: {
        id: "mcp_1",
        type: "mcp_tool_call",
        server: "kaoiro",
        tool: "whoami",
        arguments: {},
        result: {
          content: [{ type: "text", text: '{"agent_id":"a"}' }],
          structured_content: null,
        },
        status: "completed",
      },
    });
    expect(completed).toEqual([
      {
        kind: "tool_result",
        tool_use_id: "mcp_1",
        output: '{"agent_id":"a"}',
      },
    ]);
  });

  it("agent_message 完了は assistant ログ、reasoning は中継しない", () => {
    expect(threadEventToLogs(agentMessage("m", "hi"))).toEqual([
      { kind: "assistant", text: "hi" },
    ]);
    expect(
      threadEventToLogs({
        type: "item.completed",
        item: { id: "r", type: "reasoning", text: "秘密の思考" },
      }),
    ).toEqual([]);
  });
});

describe("helpers", () => {
  it("threadEventToSessionId は thread.started の UUID を返す", () => {
    expect(threadEventToSessionId(THREAD_STARTED)).toBe(
      "019f4bdb-d821-7631-aee1-ec7982060311",
    );
    expect(threadEventToSessionId({ type: "turn.started" })).toBeNull();
  });

  it("threadEventToFinalText は最後の agent_message を返す", () => {
    expect(threadEventToFinalText(agentMessage("m", "final"))).toBe("final");
    expect(threadEventToFinalText(COMMAND_COMPLETED)).toBeNull();
  });

  it("threadEventToErrorDetail は turn.failed の error.message を返す (issue #131)", () => {
    expect(
      threadEventToErrorDetail({
        type: "turn.failed",
        error: { message: "rate limited" },
      }),
    ).toBe("rate limited");
    expect(threadEventToErrorDetail(COMMAND_COMPLETED)).toBeNull();
  });
});
