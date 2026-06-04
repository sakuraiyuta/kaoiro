import { describe, expect, it } from "vitest";
import type { AdapterEvent } from "../src/types.js";
import { deriveStates, makeStateChange, reduceStates } from "../src/state.js";

describe("deriveStates", () => {
  it("init を idle に導出する", () => {
    expect(deriveStates("idle", { kind: "session_init" })).toEqual(["idle"]);
  });

  it("text/thinking のみの assistant を thinking に導出する", () => {
    expect(
      deriveStates("idle", { kind: "assistant", blocks: ["text"] }),
    ).toEqual(["thinking"]);
    expect(
      deriveStates("idle", { kind: "assistant", blocks: ["thinking", "text"] }),
    ).toEqual(["thinking"]);
  });

  it("tool_use を含む assistant を tool_running に導出する", () => {
    expect(
      deriveStates("thinking", {
        kind: "assistant",
        blocks: ["text", "tool_use"],
      }),
    ).toEqual(["tool_running"]);
  });

  it("空 blocks の assistant は thinking に落とす(防御的既定)", () => {
    expect(deriveStates("idle", { kind: "assistant", blocks: [] })).toEqual([
      "thinking",
    ]);
  });

  it("assistant.error を error に導出する", () => {
    expect(
      deriveStates("thinking", {
        kind: "assistant",
        blocks: ["text"],
        error: true,
      }),
    ).toEqual(["error"]);
  });

  it("tool_result を thinking に導出する", () => {
    expect(deriveStates("tool_running", { kind: "tool_result" })).toEqual([
      "thinking",
    ]);
  });

  it("result success を done→waiting_input に導出する", () => {
    expect(
      deriveStates("thinking", { kind: "result", subtype: "success" }),
    ).toEqual(["done", "waiting_input"]);
  });

  it("result error_* を error→waiting_input に導出する", () => {
    expect(
      deriveStates("thinking", {
        kind: "result",
        subtype: "error_max_turns",
      }),
    ).toEqual(["error", "waiting_input"]);
  });

  it("permission_request を waiting_permission に導出する", () => {
    expect(
      deriveStates("tool_running", { kind: "permission_request" }),
    ).toEqual(["waiting_permission"]);
  });

  it("permission_resolved で tool_running に復帰する", () => {
    expect(
      deriveStates("waiting_permission", { kind: "permission_resolved" }),
    ).toEqual(["tool_running"]);
  });

  it("ignore は状態を変えない(空配列)", () => {
    expect(deriveStates("thinking", { kind: "ignore" })).toEqual([]);
  });
});

describe("reduceStates", () => {
  it("ツール実行 1 ターンの実動作列に追従する", () => {
    const events: AdapterEvent[] = [
      { kind: "session_init" },
      { kind: "assistant", blocks: ["text"] },
      { kind: "assistant", blocks: ["tool_use"] },
      { kind: "tool_result" },
      { kind: "result", subtype: "success" },
    ];
    expect(reduceStates(events)).toEqual([
      "idle",
      "thinking",
      "tool_running",
      "thinking",
      "done",
      "waiting_input",
    ]);
  });

  it("権限待ちを保留として挟む列に追従する", () => {
    const events: AdapterEvent[] = [
      { kind: "assistant", blocks: ["tool_use"] },
      { kind: "permission_request" },
      { kind: "permission_resolved" },
      { kind: "tool_result" },
      { kind: "result", subtype: "success" },
    ];
    expect(reduceStates(events)).toEqual([
      "tool_running",
      "waiting_permission",
      "tool_running",
      "thinking",
      "done",
      "waiting_input",
    ]);
  });

  it("ignore イベントはトレースに現れない", () => {
    const events: AdapterEvent[] = [
      { kind: "assistant", blocks: ["text"] },
      { kind: "ignore" },
      { kind: "result", subtype: "success" },
    ];
    expect(reduceStates(events)).toEqual(["thinking", "done", "waiting_input"]);
  });
});

describe("makeStateChange", () => {
  it("共通エンベロープ v0 に状態を載せる", () => {
    const config = {
      agent_id: "lab-pc-1/claude-a",
      persona: { id: "mio", name: "澪", sprite_set: "mio" },
    };
    const envelope = makeStateChange(
      config,
      "tool_running",
      "2026-06-04T11:55:00Z",
      { label: "Edit src/foo.ts" },
    );
    expect(envelope).toEqual({
      version: "0",
      agent_id: "lab-pc-1/claude-a",
      persona: { id: "mio", name: "澪", sprite_set: "mio" },
      ts: "2026-06-04T11:55:00Z",
      type: "state_change",
      state: "tool_running",
      payload: { label: "Edit src/foo.ts" },
      ext: {},
    });
  });
});
