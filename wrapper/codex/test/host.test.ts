import { describe, expect, it } from "vitest";
import type {
  CodexOptions,
  ThreadEvent,
  ThreadOptions,
} from "@openai/codex-sdk";
import type {
  Envelope,
  ToolDescriptor,
  WrapperConfig,
} from "@kaoiro/agent-common";
import { CodexHost } from "../src/host.js";
import type { CodexClientLike, CodexThreadLike } from "../src/host.js";

const CONFIG: WrapperConfig = {
  agent_id: "host-1.codex-a",
  persona: { id: "kuroe", name: "クロエ", sprite_set: "kuroe" },
  server_url: "ws://localhost:4000/wrapper",
};

function usageEvent(): ThreadEvent {
  return {
    type: "turn.completed",
    usage: {
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
    },
  };
}

/** Scripted client: each runStreamed call yields the next event batch and
 *  records the thread options / resume ids it was constructed with. */
function makeClient(turns: ThreadEvent[][]): {
  client: CodexClientLike;
  calls: { resume: (string | null)[]; options: (ThreadOptions | undefined)[] };
} {
  let turn = 0;
  const calls: {
    resume: (string | null)[];
    options: (ThreadOptions | undefined)[];
  } = { resume: [], options: [] };
  const thread: CodexThreadLike = {
    async runStreamed() {
      const events = turns[turn] ?? [];
      turn += 1;
      async function* gen(): AsyncGenerator<ThreadEvent> {
        for (const event of events) yield event;
      }
      return { events: gen() };
    },
  };
  const client: CodexClientLike = {
    startThread(options) {
      calls.resume.push(null);
      calls.options.push(options);
      return thread;
    },
    resumeThread(id, options) {
      calls.resume.push(id);
      calls.options.push(options);
      return thread;
    },
  };
  return { client, calls };
}

/** Runs the host for one prompt turn, closing it after the turn settles. */
async function runOneTurn(
  host: CodexHost,
  prompt: string,
): Promise<void> {
  const done = host.run(prompt);
  // The run loop waits for the queue after the turn; close() wakes it.
  await new Promise((resolve) => setTimeout(resolve, 20));
  host.close();
  await done;
}

describe("CodexHost", () => {
  it("1 turn: 状態遷移・session_id 通知・result と ext を出す", async () => {
    const states: Envelope[] = [];
    const logs: Envelope[] = [];
    const sessionIds: string[] = [];
    const { client, calls } = makeClient([
      [
        { type: "thread.started", thread_id: "uuid-1" },
        { type: "turn.started" },
        {
          type: "item.completed",
          item: { id: "m1", type: "agent_message", text: "了解しました" },
        },
        usageEvent(),
      ],
    ]);
    const host = new CodexHost(
      { ...CONFIG, sandbox: "read-only", model: "gpt-5.6-sol" },
      {
        onState: (e) => states.push(e),
        onLog: (e) => logs.push(e),
        appendSystemPrompt: "persona",
        onSessionId: (id) => sessionIds.push(id),
        codexFactory: () => client,
        now: () => "T",
      },
    );
    await runOneTurn(host, "hello");

    expect(sessionIds).toEqual(["uuid-1"]);
    expect(calls.resume).toEqual([null]);
    expect(calls.options[0]).toMatchObject({
      sandboxMode: "read-only",
      model: "gpt-5.6-sol",
      skipGitRepoCheck: true,
    });
    const stateTrace = states.map((e) => e.state);
    expect(stateTrace).toEqual([
      "sending",
      "thinking",
      "done",
      "waiting_input",
    ]);
    // ext: engine / permission 二軸。model は config で明示指定した値を透過
    // (host は catalog 照合しない)。ext.models は catalog が空のため省かれる。
    expect(states.at(-1)?.ext).toMatchObject({
      engine: "codex",
      permission: { sandbox: "read-only", approval: "never" },
      model: "gpt-5.6-sol",
    });
    expect(states.at(-1)?.ext.models).toBeUndefined();
    // result envelope: 最後の agent_message が最終応答
    const result = logs.find((e) => e.type === "result");
    expect(result?.payload).toMatchObject({ text: "了解しました" });
    // assistant log も中継
    expect(
      logs.some(
        (e) => e.type === "log" && e.payload.kind === "assistant",
      ),
    ).toBe(true);
  });

  it("2 turn 目は resumeThread(session_id) で再開し setModel が次 turn に効く", async () => {
    const { client, calls } = makeClient([
      [{ type: "thread.started", thread_id: "uuid-2" }, usageEvent()],
      [usageEvent()],
    ]);
    const host = new CodexHost(CONFIG, {
      onState: () => {},
      appendSystemPrompt: "p",
      codexFactory: () => client,
      now: () => "T",
    });
    const done = host.run("first");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await host.setModel("gpt-5.4-mini");
    await host.send("second");
    await new Promise((resolve) => setTimeout(resolve, 20));
    host.close();
    await done;

    expect(calls.resume).toEqual([null, "uuid-2"]);
    expect(calls.options[1]).toMatchObject({ model: "gpt-5.4-mini" });
  });

  it("resumeSessionId 指定時は初回から resumeThread する", async () => {
    const { client, calls } = makeClient([[usageEvent()]]);
    const host = new CodexHost(CONFIG, {
      onState: () => {},
      appendSystemPrompt: "p",
      resumeSessionId: "uuid-resume",
      codexFactory: () => client,
      now: () => "T",
    });
    await runOneTurn(host, "again");
    expect(calls.resume).toEqual(["uuid-resume"]);
  });

  it("terminal event 無しの stream 終了は error → waiting_input に畳む", async () => {
    const states: Envelope[] = [];
    const { client } = makeClient([
      [{ type: "thread.started", thread_id: "u" }, { type: "turn.started" }],
    ]);
    const host = new CodexHost(CONFIG, {
      onState: (e) => states.push(e),
      appendSystemPrompt: "p",
      codexFactory: () => client,
      now: () => "T",
    });
    await runOneTurn(host, "x");
    expect(states.map((e) => e.state)).toEqual([
      "sending",
      "thinking",
      "error",
      "waiting_input",
    ]);
  });

  it("添付付き指示は instruction_rejected で弾く", async () => {
    const rejected: Envelope[] = [];
    const { client } = makeClient([]);
    const host = new CodexHost(CONFIG, {
      onState: () => {},
      appendSystemPrompt: "p",
      onInstructionRejected: (e) => rejected.push(e),
      codexFactory: () => client,
      now: () => "T",
    });
    await host.send("with files", ["up-1"]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.type).toBe("instruction_rejected");
    expect(rejected[0]?.payload).toMatchObject({
      attachment_ids: ["up-1"],
      reason: "sdk_error",
    });
  });

  it("setPendingQuestion が waiting_question / 復帰を駆動する", () => {
    const states: Envelope[] = [];
    const { client } = makeClient([]);
    const host = new CodexHost(CONFIG, {
      onState: (e) => states.push(e),
      appendSystemPrompt: "p",
      codexFactory: () => client,
      now: () => "T",
    });
    host.setPendingQuestion({
      request_id: "q1",
      questions: [],
      ts: "T",
    });
    expect(states.at(-1)?.state).toBe("waiting_question");
    expect(states.at(-1)?.ext.pending_question).toMatchObject({
      request_id: "q1",
    });
    host.setPendingQuestion(null);
    expect(states.at(-1)?.state).toBe("tool_running");
    expect(states.at(-1)?.ext.pending_question).toBeUndefined();
  });

  it("setPermissionMode は launch-fixed として reject する", async () => {
    const { client } = makeClient([]);
    const host = new CodexHost(CONFIG, {
      onState: () => {},
      appendSystemPrompt: "p",
      codexFactory: () => client,
      now: () => "T",
    });
    await expect(host.setPermissionMode("default")).rejects.toThrow(
      /launch-fixed/,
    );
  });

  it("toolDescriptors 指定時、mcp_servers.kaoiro に default_tools_approval_mode: approve を載せる", async () => {
    // codex exec は approval_policy=never を強制するため、この設定が無いと
    // MCP tool 呼び出しが "user cancelled MCP tool call" で自動拒否される
    // (2026-07-11 実機検証)。SDK に渡す config を捕捉して回帰を防ぐ。
    const { client } = makeClient([[usageEvent()]]);
    let captured: CodexOptions | null = null;
    const descriptor: ToolDescriptor = {
      name: "whoami",
      description: "self",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({ content: [{ type: "text", text: "{}" }] }),
    };
    const host = new CodexHost(CONFIG, {
      onState: () => {},
      appendSystemPrompt: "persona",
      toolDescriptors: [descriptor],
      codexFactory: (options) => {
        captured = options;
        return client;
      },
      now: () => "T",
    });
    await runOneTurn(host, "hi");

    const config = captured!.config as Record<string, unknown>;
    const mcp = config.mcp_servers as Record<string, Record<string, unknown>>;
    expect(mcp.kaoiro!.default_tools_approval_mode).toBe("approve");
    expect(config.developer_instructions).toBe("persona");
  });

  it("楽観 stamp: modelSource='config' + effortSource='config' で ext に stamp する (phase-15 15-4c)", async () => {
    const states: Envelope[] = [];
    const { client } = makeClient([[usageEvent()]]);
    const host = new CodexHost(
      { ...CONFIG, model: "gpt-5.6-sol", effort: "high" },
      {
        onState: (e) => states.push(e),
        appendSystemPrompt: "persona",
        modelSource: "config",
        effortSource: "config",
        codexFactory: () => client,
        now: () => "T",
      },
    );
    await runOneTurn(host, "hi");
    // 起動直後の最初の state_change に楽観 stamp されているはず (Codex は SDK が
    // model を再報告しないため、source は起動時決定でそのまま維持される)。
    const first = states[0]!;
    expect(first.ext).toMatchObject({
      model: "gpt-5.6-sol",
      model_source: "config",
      effort: "high",
      effort_source: "config",
    });
  });

  it("楽観 stamp: modelSource / effortSource が undefined なら stamp なし (アカウント既定委任、phase-15 15-4c)", async () => {
    const states: Envelope[] = [];
    const { client } = makeClient([[usageEvent()]]);
    const host = new CodexHost(CONFIG, {
      onState: (e) => states.push(e),
      appendSystemPrompt: "persona",
      codexFactory: () => client,
      now: () => "T",
    });
    await runOneTurn(host, "hi");
    const first = states[0]!;
    expect(first.ext).not.toHaveProperty("model_source");
    expect(first.ext).not.toHaveProperty("effort_source");
    expect(first.ext).not.toHaveProperty("model");
    expect(first.ext).not.toHaveProperty("effort");
  });

  it("session_capabilities を engine と一緒に stamp する (ADR-0034 F1, phase-15 15-14)", async () => {
    const states: Envelope[] = [];
    const { client } = makeClient([[usageEvent()]]);
    const host = new CodexHost(CONFIG, {
      onState: (e) => states.push(e),
      appendSystemPrompt: "persona",
      codexFactory: () => client,
      now: () => "T",
    });
    await runOneTurn(host, "hi");
    // session_capabilities は #statusExt から unconditional に stamp されるため
    // 全 state_change に乗る (ADR-0034 F1)。Codex は毎ターン exec spawn モデル
    // のため adapter 構築時に決めた capability が turn の外 (idle) でも state_change
    // で advertise される。states[0] は turn 開始の sending 状態。
    // supports_session_reset は phase-17 17-2 で追加された field。chunk α では
    // false stamp を保証し、chunk γ (17-6) 完了時に true + modes へ flip する。
    const first = states[0]!;
    expect(first.ext?.session_capabilities).toEqual({
      supports_attachments: false,
      supports_user_input_dialog: true,
      supports_session_reset: false,
    });
  });
});
