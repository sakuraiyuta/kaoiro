import { describe, expect, it } from "vitest";
import type { HookInput, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  cwdChangedHookToCwd,
  sdkMessageToCompactNotice,
  sdkMessageToCost,
  sdkMessageToEvents,
  sdkMessageToInitMeta,
  sdkMessageToLogs,
  sdkMessageToRateLimit,
  sdkMessageToResult,
  sdkMessageToResultMeta,
  sdkMessageToSessionId,
  sdkMessageToStatusMeta,
  sdkMessageToTask,
  sdkMessageToTasklistTriggers,
  sdkMessageToToolResultIds,
  sdkMessageToTerminalReason,
} from "../src/adapter.js";
import { reduceStates } from "@kaoiro/agent-common";

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

// phase-28 A1 (#168). Shapes follow Track S's measured order:
// status(compacting) -> status(null, compact_result) -> compact_boundary
// -> empty result.
describe("sdkMessageToCompactNotice", () => {
  it("status(compacting) -> 圧縮中の通知", () => {
    expect(
      sdkMessageToCompactNotice(
        msg({ type: "system", subtype: "status", status: "compacting" }),
      ),
    ).toEqual({ kind: "compacting", text: "コンテキストを圧縮しています…" });
  });

  it("compact_boundary は trigger と前後 token を載せる", () => {
    expect(
      sdkMessageToCompactNotice(
        msg({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: {
            trigger: "manual",
            pre_tokens: 22315,
            post_tokens: 882,
            // Track S saw undeclared extras alongside the typed fields.
            cumulative_dropped_tokens: 21433,
            duration_ms: 13692,
          },
        }),
      ),
    ).toEqual({
      kind: "compact_boundary",
      text: "手動コンテキスト圧縮が完了しました (前 22315 tokens → 後 882 tokens) 13.7 秒",
      // BR MF1-R: host は表示文字列ではなく数値そのものを要る。undeclared
      // な extras (cumulative_dropped_tokens) は載せない。
      tokens: { pre: 22315, post: 882 },
      // ADR-0055 phase-33 Stage B: raw trigger も host が要る (session_lifecycle
      // の trigger 判定材料)。
      sdkTrigger: "manual",
    });
  });

  // 実機受け入れ (2026-07-28) で post_tokens 欠落は型どおり起こり得ると
  // 確認済み。落とさず、pre だけを渡す。
  it("post_tokens 欠落でも pre だけを載せる (MF1-R)", () => {
    expect(
      sdkMessageToCompactNotice(
        msg({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "manual", pre_tokens: 293221 },
        }),
      ),
    ).toEqual({
      kind: "compact_boundary",
      text: "手動コンテキスト圧縮が完了しました (前 293221 tokens)",
      tokens: { pre: 293221 },
      sdkTrigger: "manual",
    });
  });

  it("relink 系など未知の metadata は本文に出さない", () => {
    const notice = sdkMessageToCompactNotice(
      msg({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: {
          trigger: "auto",
          pre_tokens: 100,
          preserved_segment: { head_uuid: "h", anchor_uuid: "a", tail_uuid: "t" },
          uuids: ["u1", "u2"],
        },
      }),
    );
    expect(notice?.text).toBe("自動コンテキスト圧縮が完了しました (前 100 tokens)");
    expect(notice?.sdkTrigger).toBe("auto");
  });

  // ADR-0055 phase-33 Stage B: an unrecognized trigger value (future SDK
  // addition, or a malformed field) must not be guessed into "auto" or
  // "manual" — omit it rather than mislabel the lifecycle record.
  it("未知の trigger 値は sdkTrigger を省略する", () => {
    const notice = sdkMessageToCompactNotice(
      msg({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "scheduled", pre_tokens: 100 },
      }),
    );
    expect(notice).not.toHaveProperty("sdkTrigger");
  });

  it("compact_metadata が欠けても通知は落とさない", () => {
    expect(
      sdkMessageToCompactNotice(
        msg({ type: "system", subtype: "compact_boundary" }),
      ),
    ).toEqual({ kind: "compact_boundary", text: "コンテキストを圧縮しました" });
  });

  it("compact_result=failed は compact_error を添えて通知", () => {
    expect(
      sdkMessageToCompactNotice(
        msg({
          type: "system",
          subtype: "status",
          status: null,
          compact_result: "failed",
          compact_error: "context too small",
        }),
      ),
    ).toEqual({
      kind: "compact_result",
      text: "コンテキスト圧縮に失敗しました: context too small",
    });
  });

  it("compact_result=success は boundary と二重になるので通知しない", () => {
    expect(
      sdkMessageToCompactNotice(
        msg({
          type: "system",
          subtype: "status",
          status: null,
          compact_result: "success",
        }),
      ),
    ).toBeNull();
  });

  it("conversation_reset は新 conversation_id を添えて通知", () => {
    expect(
      sdkMessageToCompactNotice(
        msg({ type: "conversation_reset", new_conversation_id: "c-9" }),
      ),
    ).toEqual({ kind: "conversation_reset", text: "会話がリセットされました (c-9)" });
  });

  it("無関係な message は null", () => {
    expect(
      sdkMessageToCompactNotice(msg({ type: "system", subtype: "init" })),
    ).toBeNull();
    expect(
      sdkMessageToCompactNotice(
        msg({ type: "system", subtype: "status", permissionMode: "default" }),
      ),
    ).toBeNull();
    expect(
      sdkMessageToCompactNotice(msg({ type: "result", subtype: "success" })),
    ).toBeNull();
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

  it("error subtype は is_error と error_subtype を返す (issue #127)", () => {
    expect(
      sdkMessageToResult(msg({ type: "result", subtype: "error_max_turns" })),
    ).toEqual({ is_error: true, error_subtype: "error_max_turns" });
  });

  it("error result の errors[] は error_detail に join される (issue #127)", () => {
    expect(
      sdkMessageToResult(
        msg({
          type: "result",
          subtype: "error_during_execution",
          errors: ["tool failed"],
        }),
      ),
    ).toEqual({
      is_error: true,
      error_subtype: "error_during_execution",
      error_detail: "tool failed",
    });
  });

  it("errors[] が複数なら '; ' で連結 (issue #127)", () => {
    expect(
      sdkMessageToResult(
        msg({
          type: "result",
          subtype: "error_during_execution",
          errors: ["tool crashed", "cleanup failed"],
        }),
      ),
    ).toEqual({
      is_error: true,
      error_subtype: "error_during_execution",
      error_detail: "tool crashed; cleanup failed",
    });
  });

  it("errors[] が空なら stop_reason を fallback で使う (issue #127)", () => {
    expect(
      sdkMessageToResult(
        msg({
          type: "result",
          subtype: "error_max_turns",
          errors: [],
          stop_reason: "max_turns_reached",
        }),
      ),
    ).toEqual({
      is_error: true,
      error_subtype: "error_max_turns",
      error_detail: "max_turns_reached",
    });
  });

  it("success 時は error_subtype / error_detail を載せない (issue #127)", () => {
    const payload = sdkMessageToResult(
      msg({ type: "result", subtype: "success", result: "完了" }),
    );
    expect(payload).toEqual({ text: "完了" });
    expect(payload).not.toHaveProperty("error_subtype");
    expect(payload).not.toHaveProperty("error_detail");
  });

  it("error result で errors 空 + stop_reason なしなら error_detail は載せない (issue #127)", () => {
    expect(
      sdkMessageToResult(
        msg({ type: "result", subtype: "error_max_budget_usd", errors: [] }),
      ),
    ).toEqual({ is_error: true, error_subtype: "error_max_budget_usd" });
  });

  it("result 以外は null", () => {
    expect(sdkMessageToResult(assistant([{ type: "text", text: "x" }]))).toBeNull();
  });
});

describe("sdkMessageToTerminalReason (issue #131)", () => {
  it("result message の terminal_reason を返す", () => {
    expect(
      sdkMessageToTerminalReason(
        msg({
          type: "result",
          subtype: "error_during_execution",
          terminal_reason: "prompt_too_long",
        }),
      ),
    ).toBe("prompt_too_long");
  });

  it("terminal_reason 欠落なら undefined", () => {
    expect(
      sdkMessageToTerminalReason(
        msg({ type: "result", subtype: "success", result: "完了" }),
      ),
    ).toBeUndefined();
  });

  it("result 以外は undefined", () => {
    expect(
      sdkMessageToTerminalReason(assistant([{ type: "text", text: "x" }])),
    ).toBeUndefined();
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

describe("sdkMessageToTasklistTriggers", () => {
  it("TaskCreate / TaskUpdate / TaskList の tool_use id を post-execution refresh に記録する", () => {
    expect(
      sdkMessageToTasklistTriggers(
        assistant([
          {
            type: "tool_use",
            id: "create-1",
            name: "TaskCreate",
            input: { subject: "調査する", description: "調べる" },
          },
          {
            type: "tool_use",
            id: "update-1",
            name: "TaskUpdate",
            input: { taskId: "1", status: "in_progress" },
          },
          { type: "tool_use", id: "list-1", name: "TaskList", input: {} },
        ]),
      ),
    ).toEqual([
      { kind: "refresh", toolUseId: "create-1" },
      { kind: "refresh", toolUseId: "update-1" },
      { kind: "refresh", toolUseId: "list-1" },
    ]);
  });

  it("tasklist tool_use に id がなければ fail-visible にする", () => {
    expect(
      sdkMessageToTasklistTriggers(
        assistant([{ type: "tool_use", name: "TaskList", input: {} }]),
      ),
    ).toEqual([{ kind: "invalid", reason: "TaskList tool_use id is missing" }]);
  });

  it("TodoWrite compatibility path は whole-list snapshot を直接返す", () => {
    expect(
      sdkMessageToTasklistTriggers(
        assistant([
          {
            type: "tool_use",
            name: "TodoWrite",
            input: {
              todos: [
                { content: "調査する", status: "in_progress", activeForm: "調査中" },
                { content: "報告する", status: "pending", activeForm: "報告を準備中" },
              ],
            },
          },
        ]),
      ),
    ).toEqual([
      {
        kind: "updated",
        items: [
          { text: "調査する", status: "in_progress" },
          { text: "報告する", status: "pending" },
        ],
      },
    ]);
  });

  it("壊れた TodoWrite input は stale list にせず fail-visible にする", () => {
    expect(
      sdkMessageToTasklistTriggers(
        assistant([{ type: "tool_use", name: "TodoWrite", input: { todos: [] } }]),
      ),
    ).toEqual([{ kind: "updated", items: [] }]);
    expect(
      sdkMessageToTasklistTriggers(
        assistant([
          {
            type: "tool_use",
            name: "TodoWrite",
            input: { todos: [{ content: "調査する", status: "unknown" }] },
          },
        ]),
      ),
    ).toEqual([{ kind: "invalid", reason: "TodoWrite todo.status is invalid" }]);
  });

  it("TaskGet と background task 操作は refresh も warn も起こさない", () => {
    expect(
      sdkMessageToTasklistTriggers(
        assistant([
          { type: "tool_use", name: "Task", input: { prompt: "調べる" } },
          { type: "tool_use", name: "TaskGet", input: { taskId: "1" } },
          {
            type: "tool_use",
            name: "TaskOutput",
            input: { task_id: "bg-1", block: false, timeout: 0 },
          },
          { type: "tool_use", name: "TaskStop", input: { task_id: "bg-1" } },
        ]),
      ),
    ).toEqual([]);
  });

  it("未知の Task* は input 形状によらず fail-visible にする", () => {
    expect(
      sdkMessageToTasklistTriggers(
        assistant([
          {
            type: "tool_use",
            name: "TaskModify",
            input: { taskId: "1", status: "completed" },
          },
        ]),
      ),
    ).toEqual([{ kind: "unrecognized", name: "TaskModify" }]);
  });

  it("通常の tool_use と assistant error は無視する", () => {
    expect(
      sdkMessageToTasklistTriggers(
        assistant([{ type: "tool_use", name: "Read", input: {} }]),
      ),
    ).toEqual([]);
    expect(
      sdkMessageToTasklistTriggers(
        assistant([{ type: "tool_use", name: "TaskFuture", input: {} }]),
      ),
    ).toEqual([{ kind: "unrecognized", name: "TaskFuture" }]);
    expect(
      sdkMessageToTasklistTriggers(
        assistant([{ type: "tool_use", name: "TaskUpdate" }], "boom"),
      ),
    ).toEqual([]);
  });
});

describe("sdkMessageToToolResultIds", () => {
  it("user tool_result の tool_use id だけを返す", () => {
    expect(
      sdkMessageToToolResultIds(
        user([
          { type: "tool_result", tool_use_id: "create-1", content: "ok" },
          { type: "text", text: "ignore" },
          { type: "tool_result", content: "id absent" },
        ]),
      ),
    ).toEqual(["create-1"]);
    expect(sdkMessageToToolResultIds(assistant([]))).toEqual([]);
  });
});

// issue #180 (ADR-0019 F2-F4, ADR-0047): task_started / task_progress /
// task_notification -> TaskEvent. Field shapes verified against the
// installed @anthropic-ai/claude-agent-sdk@0.3.220 type declarations AND a
// real captured stream (2026-08-09) — see host.ts's #applyTaskEvent for the
// task_type backfill / throttle logic this pure mapper deliberately does
// NOT own.
describe("sdkMessageToTask", () => {
  it("task_started -> kind:started (task_type 込み)", () => {
    expect(
      sdkMessageToTask(
        msg({
          type: "system",
          subtype: "task_started",
          task_id: "t1",
          task_type: "local_agent",
          subagent_type: "general-purpose",
          description: "Summarize README",
          skip_transcript: false,
        }),
      ),
    ).toEqual({
      kind: "started",
      task_id: "t1",
      task_type: "local_agent",
      subagent_type: "general-purpose",
      description: "Summarize README",
      skip_transcript: false,
    });
  });

  it("task_started で task_type 欠落/空文字は task_type フィールド自体が付かない(host 側の fail-visible ドロップの入力になる)", () => {
    expect(
      sdkMessageToTask(msg({ type: "system", subtype: "task_started", task_id: "t1" })),
    ).toEqual({ kind: "started", task_id: "t1" });
    expect(
      sdkMessageToTask(
        msg({ type: "system", subtype: "task_started", task_id: "t1", task_type: "" }),
      ),
    ).toEqual({ kind: "started", task_id: "t1" });
  });

  it("task_started は workflow_name / prompt を持ちうるが prompt は配線しない(未承認フィールド、こはく判断)", () => {
    const event = sdkMessageToTask(
      msg({
        type: "system",
        subtype: "task_started",
        task_id: "t1",
        task_type: "local_workflow",
        workflow_name: "spec",
        prompt: "full instructions to the subagent, content-bearing",
      }),
    );
    expect(event).toEqual({
      kind: "started",
      task_id: "t1",
      task_type: "local_workflow",
      workflow_name: "spec",
    });
    expect(event).not.toHaveProperty("prompt");
  });

  it("task_progress -> kind:updated (task_type は含まない — host 側でキャッシュから backfill)", () => {
    expect(
      sdkMessageToTask(
        msg({
          type: "system",
          subtype: "task_progress",
          task_id: "t1",
          subagent_type: "general-purpose",
          description: "Running",
          usage: { total_tokens: 100, tool_uses: 1, duration_ms: 500 },
          last_tool_name: "Bash",
          summary: "in progress",
        }),
      ),
    ).toEqual({
      kind: "updated",
      task_id: "t1",
      subagent_type: "general-purpose",
      description: "Running",
      usage: { total_tokens: 100, tool_uses: 1, duration_ms: 500 },
      last_tool_name: "Bash",
      summary: "in progress",
    });
    expect(
      sdkMessageToTask(msg({ type: "system", subtype: "task_progress", task_id: "t1" })),
    ).not.toHaveProperty("task_type");
  });

  it("task_notification -> kind:completed (status が既知の3値のいずれか)", () => {
    for (const status of ["completed", "failed", "stopped"] as const) {
      expect(
        sdkMessageToTask(
          msg({
            type: "system",
            subtype: "task_notification",
            task_id: "t1",
            status,
            summary: "done",
            usage: { total_tokens: 200, tool_uses: 2, duration_ms: 1000 },
          }),
        ),
      ).toEqual({
        kind: "completed",
        task_id: "t1",
        status,
        summary: "done",
        usage: { total_tokens: 200, tool_uses: 2, duration_ms: 1000 },
      });
    }
  });

  it("task_notification は output_file を配線しない(未承認フィールド、こはく判断)", () => {
    const event = sdkMessageToTask(
      msg({
        type: "system",
        subtype: "task_notification",
        task_id: "t1",
        status: "completed",
        summary: "done",
        output_file: "/tmp/claude-1000/-tmp/sess/tasks/t1.output",
      }),
    );
    expect(event).not.toHaveProperty("output_file");
  });

  it("task_notification で status が未知値でも terminal として completed を返す(M2 fix-round: status='failed' へフォールバックし raw_status に元値を保持)", () => {
    expect(
      sdkMessageToTask(
        msg({
          type: "system",
          subtype: "task_notification",
          task_id: "t1",
          status: "killed",
        }),
      ),
    ).toEqual({
      kind: "completed",
      task_id: "t1",
      status: "failed",
      raw_status: "killed",
    });
  });

  it("task_notification で status が非文字列(未知値)でも terminal として completed を返す", () => {
    expect(
      sdkMessageToTask(
        msg({
          type: "system",
          subtype: "task_notification",
          task_id: "t1",
          status: 42,
        }),
      ),
    ).toEqual({
      kind: "completed",
      task_id: "t1",
      status: "failed",
      raw_status: "42",
    });
  });

  it("task_notification で status が既知3値なら raw_status を持たない", () => {
    const event = sdkMessageToTask(
      msg({
        type: "system",
        subtype: "task_notification",
        task_id: "t1",
        status: "stopped",
      }),
    );
    expect(event).not.toHaveProperty("raw_status");
  });

  it("task_updated は null (ADR-0019 の明示的対象外 — #180 実測 2026-08-09 参照)", () => {
    expect(
      sdkMessageToTask(
        msg({
          type: "system",
          subtype: "task_updated",
          task_id: "t1",
          patch: { status: "killed" },
        }),
      ),
    ).toBeNull();
  });

  it("task_* 以外の system subtype、および system 以外の type は null", () => {
    expect(sdkMessageToTask(msg({ type: "system", subtype: "init" }))).toBeNull();
    expect(sdkMessageToTask(msg({ type: "result", subtype: "success" }))).toBeNull();
  });
});
