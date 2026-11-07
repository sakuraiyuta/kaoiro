import "../../../scripts/test/fixtures/test-isolation.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ThreadEvent } from "@openai/codex-sdk";
import { reduceStates } from "@kaoiro/agent-common";
import {
  codexErrorClassification,
  codexExecFailureRelay,
  extractJsonErrorFromStderr,
  MAX_ERROR_CODE_BYTES,
  MAX_RELAYED_STDERR_TAIL_BYTES,
  parseCodexExecErrorMessage,
  threadEventToEvents,
  threadEventToLogs,
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
  // Read the installed SDK source directly. A hand-built ThreadEvent cannot
  // show whether the SDK reshapes turn.failed before this wrapper sees it.
  it("pins: the installed @openai/codex-sdk source has no turn.failed reshaping and the exec-exit message format is unchanged", () => {
    const distPath = fileURLToPath(
      new URL("../node_modules/@openai/codex-sdk/dist/index.js", import.meta.url),
    );
    const dist = readFileSync(distPath, "utf8");

    // CodexExec.run()'s exit handler builds the "Codex Exec exited with
    // X: Y" message parseCodexExecErrorMessage's regex depends on.
    expect(dist).toContain(
      'throw new Error(`Codex Exec exited with ${detail}: ${stderrBuffer.toString("utf8")}`)',
    );

    // Isolate runStreamedInternal's body (the generator thread.runStreamed
    // actually wraps -- confirmed by `runStreamed` calling it directly a
    // few lines above in the same file) between its own signature and the
    // next method's doc comment, so the assertions below are scoped to
    // the function host.ts's #runTurn stream loop actually consumes, not
    // to the whole file.
    const bodyStart = dist.indexOf(
      "async *runStreamedInternal(input, turnOptions = {}) {",
    );
    const bodyEnd = dist.indexOf(
      "/** Provides the input to the agent and returns the completed turn. */",
    );
    expect(bodyStart).toBeGreaterThan(-1);
    expect(bodyEnd).toBeGreaterThan(bodyStart);
    const streamedBody = dist.slice(bodyStart, bodyEnd);

    // Every parsed JSONL line is yielded as-is; no case exists for
    // "turn.failed" inside this function, so its event (including
    // event.error.message) reaches host.ts completely unreshaped.
    expect(streamedBody).toContain("yield parsed;");
    expect(streamedBody).not.toContain('"turn.failed"');
    // The only two special-cased types, confirming the premise's "NONE
    // for turn.failed" claim isn't just an absence of matches elsewhere.
    expect(streamedBody).toContain('"thread.started"');
    expect(streamedBody).toContain('"turn.completed"');

    // Second, independent confirmation via Thread.run() (a convenience
    // wrapper over the same generator, not what host.ts calls, but built
    // from the identical stream): it assigns event.error to turnFailure
    // with no transformation at all before throwing turnFailure.message.
    expect(dist).toContain("turnFailure = event.error;");
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
  //  .toString("utf8")}\`);` -- identical to 0.144.1's, and reconfirmed
  // identical at 0.156.1 (dist/index.js SHA-256
  // d62ed107033bdba802b283c77d875e4bec3deb2704a910bb7e3f95059473b16f matches
  // 0.153.4's, re-fetched 2026-09-23 -- issue #399). If a future SDK
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

// maskCodexStderr's unit tests moved to
// wrapper/agent-common/test/redact.test.ts (issue #300 round 2, M2): the
// masking function itself moved to @kaoiro/agent-common so codex and
// claude-code share one implementation and one contract. codexExecFailureRelay
// below still exercises it end-to-end (e.g. the mask-before-clip ordering
// test), so masking behavior stays covered from this package too.

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

  it("matches the pre-#624 clip on a leading BOM, above and below the bound", () => {
    // The clip as it was at 6e635e46: a fatal TextDecoder drops a leading BOM
    // on the oversized branch; a value within the bound is returned as is.
    const previous = (value: string): string => {
      const bytes = Buffer.from(value, "utf8");
      if (bytes.length <= MAX_ERROR_CODE_BYTES) return value;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      for (let end = MAX_ERROR_CODE_BYTES; end > 0; end--) {
        try {
          return decoder.decode(bytes.subarray(0, end));
        } catch {
          continue;
        }
      }
      return "";
    };
    const bom = "\ufeff";
    const values = [
      bom + "a".repeat(10),
      bom + "a".repeat(MAX_ERROR_CODE_BYTES - 3),
      bom + "a".repeat(MAX_ERROR_CODE_BYTES - 2),
      bom + "a".repeat(300),
      bom + "\u3042".repeat(MAX_ERROR_CODE_BYTES),
      "a" + bom + "a".repeat(300),
    ];
    for (const value of values) {
      const code = codexErrorClassification({ message: "x", code: value })
        ?.error_code;
      expect(code).toBe(previous(value));
    }
    expect(
      codexErrorClassification({ message: "x", code: bom + "a".repeat(300) })
        ?.error_code,
    ).toBe("a".repeat(MAX_ERROR_CODE_BYTES - 3));
  });

  it.each([
    ["2-byte", "\u00e9"],
    ["3-byte", "\u3042"],
    ["4-byte", "\u{1F600}"],
  ])("cuts a %s error code at every offset at a character boundary (issue #624)", (_name, char) => {
    for (let pad = 0; pad < 4; pad += 1) {
      const value = "p".repeat(pad) + char.repeat(MAX_ERROR_CODE_BYTES);
      const code = codexErrorClassification({ message: "x", code: value })
        ?.error_code ?? "";
      const bytes = Buffer.byteLength(code, "utf8");
      expect(value.startsWith(code)).toBe(true);
      expect(bytes).toBeLessThanOrEqual(MAX_ERROR_CODE_BYTES);
      expect(bytes).toBeGreaterThan(
        MAX_ERROR_CODE_BYTES - Buffer.byteLength(char, "utf8"),
      );
    }
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

  it.each([0, 1, 2, 3])("keeps a 4-byte tail with %i padding at a character boundary (issue #624)", (pad) => {
    const tail = "\u{1F600}".repeat(MAX_RELAYED_STDERR_TAIL_BYTES) + "p".repeat(pad);
    const relay = codexExecFailureRelay(`Codex Exec exited with code 1: ${tail}`);
    expect(tail.endsWith(relay.error_detail)).toBe(true);
    expect(Buffer.byteLength(relay.error_detail, "utf8")).toBeLessThanOrEqual(
      MAX_RELAYED_STDERR_TAIL_BYTES,
    );
    expect(relay.error_detail).not.toContain("\uFFFD");
  });
});
