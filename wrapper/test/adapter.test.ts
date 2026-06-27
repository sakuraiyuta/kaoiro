import { describe, expect, it } from "vitest";
import type { HookInput, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  cwdChangedHookToCwd,
  sdkMessageToCost,
  sdkMessageToEvents,
  sdkMessageToInitMeta,
  sdkMessageToLogs,
  sdkMessageToRateLimit,
  sdkMessageToResult,
  sdkMessageToResultMeta,
  sdkMessageToSessionId,
  sdkMessageToStatusMeta,
} from "../src/adapter.js";
import { reduceStates } from "../src/state.js";

// The bridge only reads a few fields; build minimal shapes and cast.
function msg(shape: unknown): SDKMessage {
  return shape as SDKMessage;
}

const assistant = (content: unknown, error?: string): SDKMessage =>
  msg({ type: "assistant", message: { content }, error });
const user = (content: unknown): SDKMessage =>
  msg({ type: "user", message: { content } });

describe("sdkMessageToEvents", () => {
  it("system init -> session_init, other subtypes -> none", () => {
    expect(sdkMessageToEvents(msg({ type: "system", subtype: "init" }))).toEqual(
      [{ kind: "session_init" }],
    );
    expect(
      sdkMessageToEvents(msg({ type: "system", subtype: "permission_denied" })),
    ).toEqual([]);
  });

  it("assistant text/thinking -> assistant blocks", () => {
    expect(
      sdkMessageToEvents(assistant([{ type: "text", text: "hi" }])),
    ).toEqual([{ kind: "assistant", blocks: ["text"] }]);
    expect(
      sdkMessageToEvents(
        assistant([{ type: "thinking" }, { type: "redacted_thinking" }]),
      ),
    ).toEqual([{ kind: "assistant", blocks: ["thinking", "thinking"] }]);
  });

  it("assistant tool_use variants -> tool_use block", () => {
    expect(
      sdkMessageToEvents(
        assistant([{ type: "text" }, { type: "tool_use", name: "Read" }]),
      ),
    ).toEqual([{ kind: "assistant", blocks: ["text", "tool_use"] }]);
    expect(
      sdkMessageToEvents(assistant([{ type: "server_tool_use" }])),
    ).toEqual([{ kind: "assistant", blocks: ["tool_use"] }]);
  });

  it("assistant tool_use ids -> toolUseIds(string 以外の id は無視)", () => {
    expect(
      sdkMessageToEvents(
        assistant([
          { type: "tool_use", id: "tu_1", name: "Read" },
          { type: "tool_use", id: "tu_2", name: "Grep" },
          { type: "tool_use", id: 42, name: "Bash" },
        ]),
      ),
    ).toEqual([
      {
        kind: "assistant",
        blocks: ["tool_use", "tool_use", "tool_use"],
        toolUseIds: ["tu_1", "tu_2"],
      },
    ]);
  });

  it("assistant error -> error event", () => {
    expect(sdkMessageToEvents(assistant([{ type: "text" }], "rate_limit"))).toEqual(
      [{ kind: "assistant", blocks: [], error: true }],
    );
  });

  it("user tool_result -> tool_result, plain text -> none", () => {
    expect(
      sdkMessageToEvents(user([{ type: "tool_result", content: "ok" }])),
    ).toEqual([{ kind: "tool_result" }]);
    expect(sdkMessageToEvents(user("just text"))).toEqual([]);
  });

  it("user tool_result の tool_use_id -> toolUseIds(複数ブロック対応)", () => {
    expect(
      sdkMessageToEvents(
        user([
          { type: "tool_result", tool_use_id: "tu_1", content: "ok" },
          { type: "tool_result", tool_use_id: "tu_2", content: "ok" },
        ]),
      ),
    ).toEqual([{ kind: "tool_result", toolUseIds: ["tu_1", "tu_2"] }]);
  });

  it("result success/error map subtypes; unknown error coerced", () => {
    expect(
      sdkMessageToEvents(msg({ type: "result", subtype: "success" })),
    ).toEqual([{ kind: "result", subtype: "success" }]);
    expect(
      sdkMessageToEvents(msg({ type: "result", subtype: "error_max_turns" })),
    ).toEqual([{ kind: "result", subtype: "error_max_turns" }]);
    expect(
      sdkMessageToEvents(msg({ type: "result", subtype: "error_weird" })),
    ).toEqual([{ kind: "result", subtype: "error_during_execution" }]);
  });

  it("stream_event -> ignore, unknown types -> none", () => {
    expect(sdkMessageToEvents(msg({ type: "stream_event" }))).toEqual([
      { kind: "ignore" },
    ]);
    expect(sdkMessageToEvents(msg({ type: "status" }))).toEqual([]);
  });
});

describe("sdkMessageToLogs", () => {
  it("assistant の text は assistant ログ、thinking は出さない", () => {
    expect(
      sdkMessageToLogs(
        assistant([
          { type: "thinking", thinking: "secret" },
          { type: "text", text: "やります" },
        ]),
      ),
    ).toEqual([{ kind: "assistant", text: "やります" }]);
  });

  it("tool_use は tool_name/input/id を保持", () => {
    expect(
      sdkMessageToLogs(
        assistant([
          { type: "tool_use", id: "tu_1", name: "Edit", input: { path: "a" } },
        ]),
      ),
    ).toEqual([
      {
        kind: "tool_use",
        tool_use_id: "tu_1",
        tool_name: "Edit",
        input: { path: "a" },
      },
    ]);
  });

  it("errored assistant はログ無し", () => {
    expect(sdkMessageToLogs(assistant([{ type: "text", text: "x" }], "rl"))).toEqual(
      [],
    );
  });

  it("tool_result は文字列/text ブロックを output に集約", () => {
    expect(
      sdkMessageToLogs(
        user([{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }]),
      ),
    ).toEqual([{ kind: "tool_result", tool_use_id: "tu_1", output: "ok" }]);
    expect(
      sdkMessageToLogs(
        user([
          {
            type: "tool_result",
            tool_use_id: "tu_2",
            content: [
              { type: "text", text: "line1" },
              { type: "image" },
              { type: "text", text: "line2" },
            ],
          },
        ]),
      ),
    ).toEqual([
      { kind: "tool_result", tool_use_id: "tu_2", output: "line1\nline2" },
    ]);
  });

  it("非 tool メッセージはログ無し", () => {
    expect(sdkMessageToLogs(msg({ type: "system", subtype: "init" }))).toEqual(
      [],
    );
    expect(sdkMessageToLogs(msg({ type: "result", subtype: "success" }))).toEqual(
      [],
    );
  });
});

describe("sdkMessageToResult", () => {
  it("success は result text を返す", () => {
    expect(
      sdkMessageToResult(
        msg({ type: "result", subtype: "success", result: "完了" }),
      ),
    ).toEqual({ text: "完了" });
  });

  it("error subtype は is_error のみ", () => {
    expect(
      sdkMessageToResult(msg({ type: "result", subtype: "error_max_turns" })),
    ).toEqual({ is_error: true });
  });

  it("result 以外は null", () => {
    expect(sdkMessageToResult(assistant([{ type: "text", text: "x" }]))).toBeNull();
  });
});

describe("sdkMessageToCost", () => {
  it("result の total_cost_usd を返す", () => {
    expect(
      sdkMessageToCost(
        msg({ type: "result", subtype: "success", total_cost_usd: 0.0123 }),
      ),
    ).toBe(0.0123);
  });

  it("total_cost_usd が number でなければ null", () => {
    expect(
      sdkMessageToCost(msg({ type: "result", subtype: "success" })),
    ).toBeNull();
  });

  it("result 以外は null", () => {
    expect(sdkMessageToCost(assistant([{ type: "text", text: "x" }]))).toBeNull();
  });
});

describe("sdkMessageToRateLimit", () => {
  it("rate_limit_event の rate_limit_info を返す", () => {
    const info = {
      status: "allowed",
      rateLimitType: "five_hour",
      utilization: 0.42,
      resetsAt: 1781480000,
    };
    expect(
      sdkMessageToRateLimit(
        msg({ type: "rate_limit_event", rate_limit_info: info }),
      ),
    ).toEqual(info);
  });

  it("rate_limit_event 以外は null", () => {
    expect(sdkMessageToRateLimit(msg({ type: "result", subtype: "success" }))).toBeNull();
    expect(sdkMessageToRateLimit(assistant([{ type: "text", text: "x" }]))).toBeNull();
  });
});

describe("adapter + state machine", () => {
  it("derives the state trace of a realistic tool turn", () => {
    const stream: SDKMessage[] = [
      msg({ type: "system", subtype: "init" }),
      assistant([{ type: "text" }]),
      assistant([{ type: "tool_use", name: "Read" }]),
      user([{ type: "tool_result", content: "..." }]),
      msg({ type: "result", subtype: "success" }),
    ];
    const events = stream.flatMap(sdkMessageToEvents);
    expect(reduceStates(events)).toEqual([
      "idle",
      "thinking",
      "tool_running",
      "thinking",
      "done",
      "waiting_input",
    ]);
  });

  it("並列ツールターン: 全 tool_result が揃うまで tool_running を維持する", () => {
    const stream: SDKMessage[] = [
      msg({ type: "system", subtype: "init" }),
      assistant([
        { type: "tool_use", id: "tu_1", name: "Read" },
        { type: "tool_use", id: "tu_2", name: "Grep" },
      ]),
      user([{ type: "tool_result", tool_use_id: "tu_1", content: "..." }]),
      user([{ type: "tool_result", tool_use_id: "tu_2", content: "..." }]),
      msg({ type: "result", subtype: "success" }),
    ];
    const events = stream.flatMap(sdkMessageToEvents);
    expect(reduceStates(events)).toEqual([
      "idle",
      "tool_running",
      "thinking",
      "done",
      "waiting_input",
    ]);
  });
});

describe("cwdChangedHookToCwd", () => {
  // BaseHookInput requires session_id / transcript_path / cwd; HookInput is the
  // unioned shape. Tests only read hook_event_name / new_cwd, so cast suffices.
  const hook = (shape: unknown): HookInput => shape as HookInput;

  it("CwdChanged から new_cwd を返す", () => {
    expect(
      cwdChangedHookToCwd(
        hook({
          hook_event_name: "CwdChanged",
          old_cwd: "/a",
          new_cwd: "/b",
        }),
      ),
    ).toBe("/b");
  });

  it("他イベントは null", () => {
    expect(
      cwdChangedHookToCwd(
        hook({ hook_event_name: "PreToolUse", tool_name: "Read" }),
      ),
    ).toBeNull();
  });

  it("空 new_cwd は null", () => {
    expect(
      cwdChangedHookToCwd(
        hook({ hook_event_name: "CwdChanged", old_cwd: "/a", new_cwd: "" }),
      ),
    ).toBeNull();
  });
});

describe("permissionMode + fast_mode_state extraction (#57)", () => {
  it("init から permission_mode と fast_mode を取り出す", () => {
    const meta = sdkMessageToInitMeta(
      msg({
        type: "system",
        subtype: "init",
        permissionMode: "plan",
        fast_mode_state: "cooldown",
      }),
    );
    expect(meta).toMatchObject({
      permission_mode: "plan",
      fast_mode: "cooldown",
    });
  });

  it("init で permissionMode 欠落なら permission_mode は付与しない", () => {
    const meta = sdkMessageToInitMeta(msg({ type: "system", subtype: "init" }));
    expect(meta).not.toHaveProperty("permission_mode");
    expect(meta).not.toHaveProperty("fast_mode");
  });

  it("status/permissionMode から permission_mode を取り出す", () => {
    expect(
      sdkMessageToStatusMeta(
        msg({
          type: "system",
          subtype: "status",
          status: "requesting",
          permissionMode: "auto",
        }),
      ),
    ).toEqual({ permission_mode: "auto" });
  });

  it("status で permissionMode 欠落なら null", () => {
    expect(
      sdkMessageToStatusMeta(
        msg({ type: "system", subtype: "status", status: null }),
      ),
    ).toBeNull();
  });

  it("status 以外のメッセージは null", () => {
    expect(
      sdkMessageToStatusMeta(msg({ type: "system", subtype: "init" })),
    ).toBeNull();
  });

  it("result/fast_mode_state から fast_mode を取り出す", () => {
    expect(
      sdkMessageToResultMeta(
        msg({ type: "result", subtype: "success", fast_mode_state: "on" }),
      ),
    ).toEqual({ fast_mode: "on" });
  });

  it("result で fast_mode_state 欠落なら null", () => {
    expect(
      sdkMessageToResultMeta(msg({ type: "result", subtype: "success" })),
    ).toBeNull();
  });

  it("result 以外のメッセージは null", () => {
    expect(
      sdkMessageToResultMeta(msg({ type: "system", subtype: "init" })),
    ).toBeNull();
  });
});

describe("sdkMessageToSessionId", () => {
  it("session_id を取り出す", () => {
    expect(
      sdkMessageToSessionId(msg({ type: "system", session_id: "sess-1" })),
    ).toBe("sess-1");
  });

  it("空文字・欠落は null", () => {
    expect(
      sdkMessageToSessionId(msg({ type: "system", session_id: "" })),
    ).toBeNull();
    expect(sdkMessageToSessionId(msg({ type: "system" }))).toBeNull();
  });
});
