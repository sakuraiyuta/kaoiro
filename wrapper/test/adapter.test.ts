import { describe, expect, it } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { sdkMessageToEvents } from "../src/adapter.js";
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
