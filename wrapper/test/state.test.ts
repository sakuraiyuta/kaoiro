import { describe, expect, it } from "vitest";
import type { AdapterEvent } from "../src/types.js";
import {
  initialMachineState,
  makeLog,
  makeResult,
  makeStateChange,
  reduceStates,
  stepState,
} from "../src/state.js";

const CONFIG = {
  agent_id: "lab-pc-1.claude-a",
  persona: { id: "mio", name: "澪", sprite_set: "mio" },
};

describe("stepState", () => {
  it("init を idle に導出する", () => {
    const { next, emitted } = stepState(initialMachineState(), {
      kind: "session_init",
    });
    expect(emitted).toEqual(["idle"]);
    expect(next).toEqual(initialMachineState("idle"));
  });

  it("text/thinking のみの assistant を thinking に導出する", () => {
    expect(
      stepState(initialMachineState(), {
        kind: "assistant",
        blocks: ["text"],
      }).emitted,
    ).toEqual(["thinking"]);
    expect(
      stepState(initialMachineState(), {
        kind: "assistant",
        blocks: ["thinking", "text"],
      }).emitted,
    ).toEqual(["thinking"]);
  });

  it("tool_use を含む assistant を tool_running に導出し ids を保持する", () => {
    const { next, emitted } = stepState(initialMachineState("thinking"), {
      kind: "assistant",
      blocks: ["text", "tool_use"],
      toolUseIds: ["tu_1", "tu_2"],
    });
    expect(emitted).toEqual(["tool_running"]);
    expect(next.state).toBe("tool_running");
    expect(next.pendingToolUses).toEqual(new Set(["tu_1", "tu_2"]));
  });

  it("空 blocks の assistant は thinking に落とす(防御的既定)", () => {
    expect(
      stepState(initialMachineState(), { kind: "assistant", blocks: [] })
        .emitted,
    ).toEqual(["thinking"]);
  });

  it("assistant.error を error に導出する", () => {
    expect(
      stepState(initialMachineState("thinking"), {
        kind: "assistant",
        blocks: ["text"],
        error: true,
      }).emitted,
    ).toEqual(["error"]);
  });

  it("ids 無しの tool_result を thinking に導出する(レガシー経路)", () => {
    const { next, emitted } = stepState(
      initialMachineState("tool_running"),
      { kind: "tool_result" },
    );
    expect(emitted).toEqual(["thinking"]);
    expect(next.pendingToolUses.size).toBe(0);
  });

  it("result success を done→waiting_input に導出する", () => {
    expect(
      stepState(initialMachineState("thinking"), {
        kind: "result",
        subtype: "success",
      }).emitted,
    ).toEqual(["done", "waiting_input"]);
  });

  it("result error_* を error→waiting_input に導出する", () => {
    expect(
      stepState(initialMachineState("thinking"), {
        kind: "result",
        subtype: "error_max_turns",
      }).emitted,
    ).toEqual(["error", "waiting_input"]);
  });

  it("permission_request を waiting_permission に導出する", () => {
    expect(
      stepState(initialMachineState("tool_running"), {
        kind: "permission_request",
      }).emitted,
    ).toEqual(["waiting_permission"]);
  });

  it("permission_resolved で tool_running に復帰する", () => {
    expect(
      stepState(initialMachineState("waiting_permission"), {
        kind: "permission_resolved",
      }).emitted,
    ).toEqual(["tool_running"]);
  });

  it("ignore は状態を変えない(空 emitted)", () => {
    const machine = initialMachineState("thinking");
    const { next, emitted } = stepState(machine, { kind: "ignore" });
    expect(emitted).toEqual([]);
    expect(next).toBe(machine);
  });

  it("並列ツール: 全 tool_result が揃うまで tool_running を維持する", () => {
    const issued = stepState(initialMachineState("thinking"), {
      kind: "assistant",
      blocks: ["tool_use", "tool_use"],
      toolUseIds: ["tu_1", "tu_2"],
    });
    const first = stepState(issued.next, {
      kind: "tool_result",
      toolUseIds: ["tu_1"],
    });
    expect(first.emitted).toEqual([]);
    expect(first.next.state).toBe("tool_running");
    expect(first.next.pendingToolUses).toEqual(new Set(["tu_2"]));

    const second = stepState(first.next, {
      kind: "tool_result",
      toolUseIds: ["tu_2"],
    });
    expect(second.emitted).toEqual(["thinking"]);
    expect(second.next.state).toBe("thinking");
  });

  it("並列ツール中の ids 無し tool_result は pending をクリアする(固着回避)", () => {
    const issued = stepState(initialMachineState("thinking"), {
      kind: "assistant",
      blocks: ["tool_use", "tool_use"],
      toolUseIds: ["tu_1", "tu_2"],
    });
    const { next, emitted } = stepState(issued.next, { kind: "tool_result" });
    expect(emitted).toEqual(["thinking"]);
    expect(next.pendingToolUses.size).toBe(0);
  });

  it("permission の往復で pending が保存される", () => {
    const issued = stepState(initialMachineState("thinking"), {
      kind: "assistant",
      blocks: ["tool_use"],
      toolUseIds: ["tu_1", "tu_2"],
    });
    const asked = stepState(issued.next, { kind: "permission_request" });
    const resolved = stepState(asked.next, { kind: "permission_resolved" });
    expect(resolved.next.pendingToolUses).toEqual(new Set(["tu_1", "tu_2"]));
  });

  it("tool_running 以外での tool_result は no-op(迷子メッセージ防御)", () => {
    for (const state of ["idle", "thinking", "waiting_input"] as const) {
      const machine = initialMachineState(state);
      const { next, emitted } = stepState(machine, {
        kind: "tool_result",
        toolUseIds: ["tu_stray"],
      });
      expect(emitted).toEqual([]);
      expect(next).toBe(machine);
    }
  });

  it("未知 id のみの tool_result は pending を消さない(誤終了防止)", () => {
    const issued = stepState(initialMachineState("thinking"), {
      kind: "assistant",
      blocks: ["tool_use"],
      toolUseIds: ["tu_1"],
    });
    const { next, emitted } = stepState(issued.next, {
      kind: "tool_result",
      toolUseIds: ["tu_foreign"],
    });
    expect(emitted).toEqual([]);
    expect(next.state).toBe("tool_running");
    expect(next.pendingToolUses).toEqual(new Set(["tu_1"]));
  });

  it("新しい assistant が stale な pending をリセットする(自己回復)", () => {
    const issued = stepState(initialMachineState("thinking"), {
      kind: "assistant",
      blocks: ["tool_use"],
      toolUseIds: ["tu_stale"],
    });
    const { next } = stepState(issued.next, {
      kind: "assistant",
      blocks: ["text"],
    });
    expect(next.state).toBe("thinking");
    expect(next.pendingToolUses.size).toBe(0);
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

  it("並列ツール実行のターンに追従する(途中の tool_result で遷移しない)", () => {
    const events: AdapterEvent[] = [
      { kind: "session_init" },
      {
        kind: "assistant",
        blocks: ["tool_use", "tool_use"],
        toolUseIds: ["tu_1", "tu_2"],
      },
      { kind: "tool_result", toolUseIds: ["tu_1"] },
      { kind: "tool_result", toolUseIds: ["tu_2"] },
      { kind: "result", subtype: "success" },
    ];
    expect(reduceStates(events)).toEqual([
      "idle",
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
      agent_id: "lab-pc-1.claude-a",
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
      agent_id: "lab-pc-1.claude-a",
      persona: { id: "mio", name: "澪", sprite_set: "mio" },
      ts: "2026-06-04T11:55:00Z",
      type: "state_change",
      state: "tool_running",
      payload: { label: "Edit src/foo.ts" },
      ext: {},
    });
  });
});

describe("makeLog", () => {
  it("log エンベロープに現在状態と payload を載せる", () => {
    const envelope = makeLog(CONFIG, "thinking", "2026-06-04T11:55:00Z", {
      kind: "assistant",
      text: "考え中です",
    });
    expect(envelope).toEqual({
      version: "0",
      agent_id: "lab-pc-1.claude-a",
      persona: { id: "mio", name: "澪", sprite_set: "mio" },
      ts: "2026-06-04T11:55:00Z",
      type: "log",
      state: "thinking",
      payload: { kind: "assistant", text: "考え中です" },
      ext: {},
    });
  });
});

describe("makeResult", () => {
  it("成功時は state=done", () => {
    const envelope = makeResult(CONFIG, "2026-06-04T11:55:00Z", {
      text: "完了しました",
    });
    expect(envelope).toMatchObject({
      type: "result",
      state: "done",
      payload: { text: "完了しました" },
    });
  });

  it("is_error 時は state=error", () => {
    const envelope = makeResult(CONFIG, "2026-06-04T11:55:00Z", {
      is_error: true,
    });
    expect(envelope).toMatchObject({
      type: "result",
      state: "error",
      payload: { is_error: true },
    });
  });
});
