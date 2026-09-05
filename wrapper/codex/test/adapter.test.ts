import { describe, expect, it } from "vitest";
import type { ThreadEvent } from "@openai/codex-sdk";
import { reduceStates } from "@kaoiro/agent-common";
import {
  codexErrorClassification,
  codexExecFailureRelay,
  extractJsonErrorFromStderr,
  MAX_ERROR_CODE_BYTES,
  MAX_RELAYED_STDERR_TAIL_BYTES,
  maskCodexStderr,
  parseCodexExecErrorMessage,
  threadEventToErrorDetail,
  threadEventToEvents,
  threadEventToFinalText,
  threadEventToLogs,
  threadEventToSessionId,
  threadEventToTasklist,
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
          cache_write_input_tokens: 0,
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

describe("threadEventToTasklist", () => {
  it("todo_list の全項目を pending/completed に写す", () => {
    expect(
      threadEventToTasklist({
        type: "item.updated",
        item: {
          id: "todos",
          type: "todo_list",
          items: [
            { text: "調査", completed: false },
            { text: "実装", completed: true },
          ],
        },
      }),
    ).toEqual([
      { text: "調査", status: "pending" },
      { text: "実装", status: "completed" },
    ]);
  });

  it("todo_list 以外と item event 以外は対象にしない", () => {
    expect(threadEventToTasklist(COMMAND_STARTED)).toBeNull();
    expect(threadEventToTasklist({ type: "turn.started" })).toBeNull();
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

  // issue #300 (director-requested premise pin, turn 7): the assumption
  // that a turn.failed event's error.message carries the CLI's own JSON
  // error body VERBATIM, with no SDK-side reshaping, is what lets
  // codexExecFailureRelay (called on this same value in host.ts) run its
  // JSON extraction directly on it. Pinned against @openai/codex-sdk
  // 0.153.4's actual source (fetched via `npm pack`), not assumed:
  // - dist/index.d.ts: `type ThreadError = { message: string }` (no
  //   code/type/structured fields at the SDK's own type level -- any
  //   JSON structure must ride inside this one string), and
  //   `TurnFailedEvent`/`ThreadErrorEvent` are documented as "Top-level
  //   JSONL events emitted by codex exec" -- i.e. the raw CLI protocol,
  //   not an SDK-synthesized shape.
  // - dist/index.js's runStreamedInternal (~lines 78-90): every stdout
  //   JSONL line is `JSON.parse`d and yielded as the ThreadEvent as-is;
  //   the only special-casing is for `thread.started` (captures
  //   thread_id) and `turn.completed` (defaults a usage field) --
  //   `turn.failed` receives NONE, so `event.error.message` is exactly
  //   what the CLI itself wrote, unmodified by the SDK.
  // If a future SDK release starts reshaping this field (e.g. splitting
  // it into structured code/type/message properties), this premise
  // breaks silently for anyone reading only the wrapper's own tests --
  // this test's own failure is the signal to re-derive the assumption,
  // not just re-fix the fixture.
  it("pins: turn.failed's event.error.message is the CLI's raw JSON body, unreshaped by the SDK (issue #300)", () => {
    const cliJson =
      '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"boom"}}';
    const event: ThreadEvent = {
      type: "turn.failed",
      error: { message: cliJson },
    };
    expect(threadEventToErrorDetail(event)).toBe(cliJson);
  });
});

// issue #300: exec-failure stderr relay. codexExecFailureRelay's own doc
// covers the pipeline end to end; the unit tests below pin each stage
// (parse / extract / mask / classify) independently so a future change
// that breaks one stage fails at that stage, not only in the integration
// test at the bottom.
describe("parseCodexExecErrorMessage (issue #300)", () => {
  // Pinned against @openai/codex-sdk 0.153.4's dist/index.js (fetched via
  // `npm pack @openai/codex-sdk@0.153.4`), CodexExec.run()'s exit handler:
  // `const detail = signal ? \`signal ${signal}\` : \`code ${code ?? 1}\`;
  //  throw new Error(\`Codex Exec exited with ${detail}: ${stderrBuffer
  //  .toString("utf8")}\`);` -- identical to 0.144.1's. If a future SDK
  // release changes this wording, this test is the first thing to fail,
  // flagging that parseCodexExecErrorMessage's fallback-to-raw path (see
  // its own doc) is now doing the work instead of the structured split.
  it("splits the SDK's own exec-exit-nonzero message format", () => {
    expect(
      parseCodexExecErrorMessage("Codex Exec exited with code 1: boom"),
    ).toEqual({ exitDetail: "code 1", stderrTail: "boom" });
    expect(
      parseCodexExecErrorMessage("Codex Exec exited with signal SIGKILL: "),
    ).toEqual({ exitDetail: "signal SIGKILL", stderrTail: "" });
  });

  it("keeps a colon inside the stderr tail intact (JSON stderr has many)", () => {
    expect(
      parseCodexExecErrorMessage(
        'Codex Exec exited with code 1: {"error":{"message":"x: y"}}',
      ),
    ).toEqual({
      exitDetail: "code 1",
      stderrTail: '{"error":{"message":"x: y"}}',
    });
  });

  it("returns null for a message that does not match the SDK's shape", () => {
    expect(parseCodexExecErrorMessage("some unrelated error")).toBeNull();
  });
});

describe("extractJsonErrorFromStderr (issue #300)", () => {
  // Real `codex exec` invocation (codex CLI v0.153.0, ChatGPT auth,
  // 2026-09) with a nonexistent model name, reproducing issue #300's own
  // scenario. codex CLI prints the JSON error with an "ERROR: " log-level
  // prefix (not bare JSON), and prints it twice; both must be handled.
  const REAL_CLI_STDERR = [
    "warning: Model metadata for `this-model-does-not-exist-xyz` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.",
    'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'this-model-does-not-exist-xyz\' model is not supported when using Codex with a ChatGPT account."}}',
    'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'this-model-does-not-exist-xyz\' model is not supported when using Codex with a ChatGPT account."}}',
  ].join("\n");

  it("extracts a JSON error printed with a log-level prefix (real codex CLI output)", () => {
    expect(extractJsonErrorFromStderr(REAL_CLI_STDERR)).toEqual({
      message:
        "The 'this-model-does-not-exist-xyz' model is not supported when using Codex with a ChatGPT account.",
      type: "invalid_request_error",
    });
  });

  it("extracts message/code/type from a single-line JSON error", () => {
    expect(
      extractJsonErrorFromStderr(
        '{"error":{"message":"bad request","code":"model_not_found","type":"invalid_request_error"}}',
      ),
    ).toEqual({
      message: "bad request",
      code: "model_not_found",
      type: "invalid_request_error",
    });
  });

  it("extracts message-only when code/type are absent", () => {
    expect(
      extractJsonErrorFromStderr('{"error":{"message":"bad request"}}'),
    ).toEqual({ message: "bad request" });
  });

  it("scans from the last line and skips leading non-JSON boilerplate", () => {
    expect(
      extractJsonErrorFromStderr(
        'Reading prompt from stdin...\n{"error":{"message":"bad request"}}',
      ),
    ).toEqual({ message: "bad request" });
  });

  it("still finds JSON on a middle line when the last line is not JSON", () => {
    expect(
      extractJsonErrorFromStderr(
        '{"error":{"message":"bad request"}}\ntrailing warning line',
      ),
    ).toEqual({ message: "bad request" });
  });

  it("returns null for stderr with no JSON error object", () => {
    expect(extractJsonErrorFromStderr("")).toBeNull();
    expect(extractJsonErrorFromStderr("plain text only")).toBeNull();
    expect(extractJsonErrorFromStderr('{"unrelated":"shape"}')).toBeNull();
    expect(extractJsonErrorFromStderr("{not valid json")).toBeNull();
  });
});

describe("maskCodexStderr (issue #300)", () => {
  it("masks an sk-style API key to its last 4 characters", () => {
    expect(maskCodexStderr("key=sk-abcdefghijklmnopqrstuvwxyz")).toBe(
      "key=sk-**********************wxyz",
    );
  });

  it("masks an Authorization/Bearer header value, keeping the keyword", () => {
    expect(maskCodexStderr("Authorization: Bearer abcdef123456")).toBe(
      "Authorization: Bearer ********3456",
    );
  });

  it("masks a bare api_key assignment", () => {
    expect(maskCodexStderr("api_key=abcdef123456")).toBe(
      "api_key=********3456",
    );
  });

  it("masks a 4-or-fewer character value in full", () => {
    expect(maskCodexStderr("api_key=ab12")).toBe("api_key=****");
  });

  it("masks a JSON-quoted api_key field, preserving the quotes (issue #300 review finding)", () => {
    // Regression: the earlier pattern required the separator to follow the
    // bare keyword directly, so a JSON key's closing quote (as in the
    // Codex CLI's own stderr JSON error bodies) broke the match and left
    // the value fully unmasked.
    expect(
      maskCodexStderr('{"api_key": "abcdef1234567890"}'),
    ).toBe('{"api_key": "************7890"}');
  });

  it("leaves ordinary text untouched (negative control)", () => {
    const text = "Reading prompt from stdin...\nthread failed to start";
    expect(maskCodexStderr(text)).toBe(text);
  });

  it("leaves filesystem paths untouched", () => {
    const text = "config not found at /home/operator/.codex/config.toml";
    expect(maskCodexStderr(text)).toBe(text);
  });
});

describe("codexErrorClassification (issue #300)", () => {
  it("uses error.code when present, from the closed table", () => {
    expect(
      codexErrorClassification({ message: "too fast", code: "rate_limit_error" }),
    ).toEqual({
      error_code: "rate_limit_error",
      error_summary: "レート制限に達しました。",
      recovery_hint: "しばらく待ってから再送してください。",
    });
  });

  it("falls back to error.type when error.code is absent", () => {
    expect(
      codexErrorClassification({
        message: "bad request",
        type: "invalid_request_error",
      }),
    ).toEqual({
      error_code: "invalid_request_error",
      error_summary: "リクエストが不正と判定されました。",
    });
  });

  it("narrows recovery_hint by message keyword without changing the code", () => {
    expect(
      codexErrorClassification({
        message:
          "The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.",
        type: "invalid_request_error",
      }),
    ).toEqual({
      error_code: "invalid_request_error",
      error_summary: "リクエストが不正と判定されました。",
      recovery_hint:
        "kaoiro が同梱する Codex CLI の更新が必要です。operator に連絡してください。",
    });
  });

  it("degrades to a generic summary for an unrecognized code, but still forwards it", () => {
    expect(
      codexErrorClassification({ message: "x", code: "some_future_code" }),
    ).toEqual({
      error_code: "some_future_code",
      error_summary: "Codex でエラーが発生しました。",
    });
  });

  it("returns null (never fabricates a code) when neither code nor type is present", () => {
    expect(codexErrorClassification({ message: "x" })).toBeNull();
  });

  it("head-clips an oversized code to MAX_ERROR_CODE_BYTES (issue #300 review finding)", () => {
    // Regression: error_code previously rode the envelope with no size
    // bound at all, unlike error_detail (clipped) and error_summary/
    // recovery_hint (from a fixed, short table) -- a malformed or
    // reflected long code/type value would have broken the envelope-size
    // invariant every sibling field upholds.
    const oversized = "x".repeat(MAX_ERROR_CODE_BYTES + 50);
    const result = codexErrorClassification({ message: "x", code: oversized });
    expect(result?.error_code).toBe("x".repeat(MAX_ERROR_CODE_BYTES));
    expect(Buffer.byteLength(result?.error_code ?? "", "utf8")).toBe(
      MAX_ERROR_CODE_BYTES,
    );
  });

  it("backs off from a multi-byte codepoint straddling the clip boundary, never exceeding the byte bound (issue #300 review finding, round 2)", () => {
    // Regression: a straight byte cut at MAX_ERROR_CODE_BYTES can land
    // mid-codepoint; the UTF-8 decoder then substitutes a 3-byte U+FFFD
    // for the dangling partial sequence, which can push the decoded
    // string's OWN byte length back over the declared bound -- exactly
    // the invariant this clip exists to enforce. "あ" (3 UTF-8 bytes)
    // straddles byte 256 here (255 ASCII bytes + its first byte).
    const value = "a".repeat(255) + "あ" + "b".repeat(10);
    const result = codexErrorClassification({ message: "x", code: value });
    expect(result?.error_code).toBe("a".repeat(255));
    expect(result?.error_code).not.toContain("�");
    expect(
      Buffer.byteLength(result?.error_code ?? "", "utf8"),
    ).toBeLessThanOrEqual(MAX_ERROR_CODE_BYTES);
  });
});

describe("codexExecFailureRelay (issue #300)", () => {
  it("relays the reproduced gpt-6-astra 400 end to end", () => {
    // Verbatim capture from a real Codex 0.144.1 400 response (issue #300
    // turn 3 decision).
    const json =
      '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6-astra\' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."}}';
    const relay = codexExecFailureRelay(`Codex Exec exited with code 1: ${json}`);
    expect(relay).toEqual({
      error_detail: json,
      error_code: "invalid_request_error",
      error_summary: "リクエストが不正と判定されました。",
      recovery_hint:
        "kaoiro が同梱する Codex CLI の更新が必要です。operator に連絡してください。",
    });
  });

  it("relays a REAL codex CLI 400 (live `codex exec` reproduction, issue #300)", () => {
    // Captured 2026-09 from `codex exec --model this-model-does-not-exist-xyz`
    // against a real ChatGPT-authenticated codex CLI v0.153.0 (director's
    // go-ahead reproduction step) -- multi-line stderr with a leading
    // warning and the JSON error printed twice, both "ERROR: "-prefixed.
    const cliStderr = [
      "warning: Model metadata for `this-model-does-not-exist-xyz` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.",
      'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'this-model-does-not-exist-xyz\' model is not supported when using Codex with a ChatGPT account."}}',
      'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'this-model-does-not-exist-xyz\' model is not supported when using Codex with a ChatGPT account."}}',
    ].join("\n");
    const relay = codexExecFailureRelay(
      `Codex Exec exited with code 1: ${cliStderr}`,
    );
    expect(relay).toEqual({
      error_detail: cliStderr,
      error_code: "invalid_request_error",
      error_summary: "リクエストが不正と判定されました。",
      // No recovery_hint: this message does not match the
      // "requires a newer version of codex" keyword, unlike the
      // gpt-6-astra case above -- same code, generic table summary only.
    });
  });

  it("negative control: empty stderr still yields the current message shape", () => {
    const relay = codexExecFailureRelay("Codex Exec exited with code 1: ");
    expect(relay).toEqual({ error_detail: "" });
  });

  it("falls back to relaying the raw message when it does not match the SDK's shape", () => {
    const relay = codexExecFailureRelay("spawn ENOENT");
    expect(relay).toEqual({ error_detail: "spawn ENOENT" });
  });

  it("clips to the last MAX_RELAYED_STDERR_TAIL_BYTES bytes, keeping the tail", () => {
    const filler = "x".repeat(MAX_RELAYED_STDERR_TAIL_BYTES + 100);
    const relay = codexExecFailureRelay(
      `Codex Exec exited with code 1: ${filler}TAIL_MARKER`,
    );
    expect(Buffer.byteLength(relay.error_detail, "utf8")).toBe(
      MAX_RELAYED_STDERR_TAIL_BYTES,
    );
    expect(relay.error_detail.endsWith("TAIL_MARKER")).toBe(true);
  });

  it("masks a secret straddling the tail-clip boundary (mask-before-clip ordering)", () => {
    // The secret sits AHEAD of a trailing block just under
    // MAX_RELAYED_STDERR_TAIL_BYTES long, so the tail-clip boundary lands
    // INSIDE the secret's value, keeping only its last few characters --
    // masking must therefore run BEFORE clipping (adapter.ts's
    // codexExecFailureRelay doc), or those surviving raw characters would
    // no longer match the api_key pattern (its "api_key=" anchor is what
    // got clipped away) and would reach error_detail unmasked.
    const secret = "api_key=abcdef123456";
    const after = "y".repeat(MAX_RELAYED_STDERR_TAIL_BYTES - 10);
    const relay = codexExecFailureRelay(
      `Codex Exec exited with code 1: ${secret}${after}`,
    );
    // "def1" sits in the middle of the value, a region maskValue() always
    // replaces with asterisks (only the LAST 4 characters, "3456", stay
    // visible by design) -- so it surviving raw proves masking never saw
    // the "api_key=" anchor, i.e. the clip ran first and cut it away.
    expect(relay.error_detail).not.toContain("def1");
  });
});
