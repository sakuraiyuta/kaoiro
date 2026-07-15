import { describe, expect, it, vi } from "vitest";
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
import { makeStateChange } from "@kaoiro/agent-common";
import { CodexHost, initialStatusExt } from "../src/host.js";
import type { CodexClientLike, CodexThreadLike } from "../src/host.js";

const CONFIG: WrapperConfig = {
  agent_id: "host-1.codex-a",
  persona: { id: "kuroe", name: "クロエ", sprite_set: "kuroe" },
  server_url: "ws://localhost:4000/wrapper",
  codex_auth_mode: "chatgpt",
  codex_chatgpt_plan: "plus",
};

describe("initialStatusExt", () => {
  it("initial idle に config-static capabilities を stamp する (#107)", () => {
    const config = { ...CONFIG, model: "gpt-5.6-sol" };
    const initial = makeStateChange(
      config,
      "idle",
      "T",
      {},
      initialStatusExt(config),
    );
    expect(initial.ext).toMatchObject({
      engine: "codex",
      session_capabilities: {
        supports_attachments: false,
        supports_user_input_dialog: true,
        supports_model_switch: true,
        supports_effort_switch: true,
        supports_session_reset: true,
        session_reset_modes: ["new", "clear"],
        supports_context_usage: false,
      },
    });
    expect(
      (initial.ext.models as { value: string }[]).map((m) => m.value),
    ).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
  });

  it("未申告 catalog は switch capability を fail-closed にする (#107)", () => {
    expect(
      initialStatusExt({ ...CONFIG, codex_auth_mode: "unknown" }),
    ).toMatchObject({
      session_capabilities: {
        supports_model_switch: false,
        supports_effort_switch: false,
      },
    });
  });
});

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
async function runOneTurn(host: CodexHost, prompt: string): Promise<void> {
  const done = host.run(prompt);
  // The run loop waits for the queue after the turn; close() wakes it.
  await new Promise((resolve) => setTimeout(resolve, 20));
  host.close();
  await done;
}

describe("CodexHost", () => {
  it("whoami は effective snapshot の model/effort/source/permission を返す", () => {
    const { client } = makeClient([]);
    const host = new CodexHost(
      {
        ...CONFIG,
        model: "gpt-5.6-sol",
        effort: "xhigh",
        sandbox: "workspace-write",
        network_access: true,
      },
      {
        onState: () => {},
        appendSystemPrompt: "p",
        modelSource: "config",
        effortSource: "config",
        codexFactory: () => client,
      },
    );

    expect(host.statusSnapshot()).toMatchObject({
      engine: "codex",
      model: "gpt-5.6-sol",
      model_source: "config",
      effort: "xhigh",
      effort_source: "config",
      permission: { sandbox: "workspace-write", approval: "never" },
      network_access: true,
    });
  });

  it("codex_internal_subagents を features.multi_agent へ常に注入する (true/false)", async () => {
    for (const [flag, expected] of [
      [false, false],
      [true, true],
    ] as const) {
      const { client } = makeClient([
        [{ type: "thread.started", thread_id: "t1" }, usageEvent()],
      ]);
      let captured: CodexOptions | undefined;
      const host = new CodexHost(
        { ...CONFIG, codex_internal_subagents: flag },
        {
          onState: () => {},
          appendSystemPrompt: "p",
          codexFactory: (options) => {
            captured = options;
            return client;
          },
          now: () => "T",
        },
      );
      await runOneTurn(host, "hi");
      expect(
        (captured?.config as Record<string, unknown> | undefined)?.features,
      ).toEqual({ multi_agent: expected });
    }
  });

  it("codex_internal_subagents 未指定は default=true を明示注入する", async () => {
    const { client } = makeClient([
      [{ type: "thread.started", thread_id: "t1" }, usageEvent()],
    ]);
    let captured: CodexOptions | undefined;
    const host = new CodexHost(
      { ...CONFIG },
      {
        onState: () => {},
        appendSystemPrompt: "p",
        codexFactory: (options) => {
          captured = options;
          return client;
        },
        now: () => "T",
      },
    );
    await runOneTurn(host, "hi");
    expect(
      (captured?.config as Record<string, unknown> | undefined)?.features,
    ).toEqual({ multi_agent: true });
  });

  it.each([
    ["chatgpt", "free", ["gpt-5.6-terra"]],
    ["chatgpt", "go", ["gpt-5.6-terra"]],
    ["chatgpt", "plus", ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]],
    ["chatgpt", "pro", ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]],
    ["chatgpt", "business", ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]],
    ["chatgpt", "enterprise", ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]],
    [
      "apikey",
      undefined,
      [
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
        "gpt-5.4-mini",
      ],
    ],
    ["chatgpt", undefined, undefined],
    ["unknown", undefined, undefined],
  ] as const)(
    "catalog resolver の %s/%s を state_change まで同じ値で中継する",
    async (authMode, plan, expected) => {
      const states: Envelope[] = [];
      const stderr = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      const { client } = makeClient([
        [
          { type: "thread.started", thread_id: `catalog-${authMode}-${plan}` },
          usageEvent(),
        ],
      ]);
      const { codex_chatgpt_plan: _configuredPlan, ...baseConfig } = CONFIG;
      const host = new CodexHost(
        {
          ...baseConfig,
          codex_auth_mode: authMode,
          ...(plan === undefined ? {} : { codex_chatgpt_plan: plan }),
        },
        {
          onState: (event) => states.push(event),
          appendSystemPrompt: "p",
          codexFactory: () => client,
          now: () => "T",
        },
      );

      try {
        await runOneTurn(host, "catalog");
        const models = states.at(-1)?.ext.models as
          | { value: string }[]
          | undefined;
        expect(models?.map((model) => model.value)).toEqual(expected);
        expect(states.at(-1)?.ext.session_capabilities).toMatchObject({
          supports_model_switch: expected !== undefined,
        });
      } finally {
        stderr.mockRestore();
      }
    },
  );

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
      {
        ...CONFIG,
        sandbox: "read-only",
        model: "gpt-5.6-sol",
        codex_auth_mode: "chatgpt",
        codex_chatgpt_plan: "plus",
      },
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
    // ext: engine / permission 二軸。model は config で明示指定した値を透過。
    // models は runner register と同じ resolver の出力を使う。
    expect(states.at(-1)?.ext).toMatchObject({
      engine: "codex",
      permission: { sandbox: "read-only", approval: "never" },
      model: "gpt-5.6-sol",
    });
    expect(
      (states.at(-1)?.ext.models as { value: string }[]).map(
        (model) => model.value,
      ),
    ).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    // result envelope: 最後の agent_message が最終応答
    const result = logs.find((e) => e.type === "result");
    expect(result?.payload).toMatchObject({ text: "了解しました" });
    // assistant log も中継
    expect(
      logs.some((e) => e.type === "log" && e.payload.kind === "assistant"),
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

  it("実行中のsetModelは現turnを変えず次turnへpendingする", async () => {
    const states: Envelope[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: (ThreadOptions | undefined)[] = [];
    let turn = 0;
    const client: CodexClientLike = {
      startThread(options) {
        calls.push(options);
        return {
          async runStreamed() {
            async function* events(): AsyncGenerator<ThreadEvent> {
              yield { type: "thread.started", thread_id: "boundary" };
              yield { type: "turn.started" };
              await gate;
              yield usageEvent();
            }
            return { events: events() };
          },
        };
      },
      resumeThread(_id, options) {
        calls.push(options);
        return makeClient([[usageEvent()]]).client.startThread(options);
      },
    };
    const host = new CodexHost(
      { ...CONFIG, model: "gpt-5.6-terra" },
      {
        onState: (event) => states.push(event),
        appendSystemPrompt: "p",
        modelSource: "config",
        codexFactory: () => client,
        now: () => "T",
      },
    );
    const done = host.run("first");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await host.setModel("gpt-5.6-sol");
    expect(calls[0]?.model).toBe("gpt-5.6-terra");
    expect(states.at(-1)?.ext.pending_model).toBe("gpt-5.6-sol");
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(states.at(-1)?.ext.pending_model).toBe("gpt-5.6-sol");
    await host.send("second");
    await new Promise((resolve) => setTimeout(resolve, 20));
    host.close();
    await done;
    expect(calls[1]?.model).toBe("gpt-5.6-sol");
  });

  it("switch成功でpendingをeffectiveへ確定しdriftから除外する", async () => {
    const states: Envelope[] = [];
    const { client } = makeClient([
      [{ type: "thread.started", thread_id: "switch-ok" }, usageEvent()],
      [usageEvent()],
    ]);
    const host = new CodexHost(
      { ...CONFIG, model: "gpt-5.6-terra", effort: "medium" },
      {
        onState: (event) => states.push(event),
        appendSystemPrompt: "p",
        modelSource: "config",
        effortSource: "config",
        resumeSnapshot: {
          model: "gpt-5.6-terra",
          model_source: "config",
          effort: "medium",
          effort_source: "config",
          sandbox: "workspace-write",
          network_access: false,
        },
        codexFactory: () => client,
        now: () => "T",
      },
    );
    const done = host.run("first");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await host.setModel("gpt-5.6-sol");
    expect(states.at(-1)?.ext).toMatchObject({
      pending_model: "gpt-5.6-sol",
      effective: { model: "gpt-5.6-terra" },
    });
    await host.send("second");
    await new Promise((resolve) => setTimeout(resolve, 20));
    host.close();
    await done;
    expect(states.at(-1)?.ext.pending_model).toBeUndefined();
    expect(states.at(-1)?.ext.effective).toMatchObject({
      model: "gpt-5.6-sol",
    });
    expect(
      (states.at(-1)?.ext.resume_drift as { field: string }[]).some(
        (entry) => entry.field === "model" || entry.field === "model_source",
      ),
    ).toBe(false);
  });

  it.each(["400", "404"])(
    "%s switch失敗はloud failし1回stamp後last-goodへrollbackする",
    async (status) => {
      const states: Envelope[] = [];
      const { client, calls } = makeClient([
        [{ type: "thread.started", thread_id: "switch-fail" }, usageEvent()],
        [{ type: "turn.failed", error: { message: status } }],
        [usageEvent()],
      ]);
      const host = new CodexHost(
        { ...CONFIG, model: "gpt-5.6-terra" },
        {
          onState: (event) => states.push(event),
          appendSystemPrompt: "p",
          modelSource: "config",
          codexFactory: () => client,
          now: () => "T",
        },
      );
      const done = host.run("first");
      await new Promise((resolve) => setTimeout(resolve, 20));
      await host.setModel("not-entitled");
      await host.send("second");
      await new Promise((resolve) => setTimeout(resolve, 20));
      const errors = states.filter(
        (state) => state.ext.switch_error !== undefined,
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]?.ext.switch_error).toEqual({
        kind: "model",
        requested: "not-entitled",
        reason: "turn_failed",
        rolled_back_to: "gpt-5.6-terra",
      });
      expect(errors[0]?.ext.pending_model).toBeUndefined();
      expect(errors[0]?.ext.effective).toMatchObject({
        model: "gpt-5.6-terra",
      });
      await host.send("third");
      await new Promise((resolve) => setTimeout(resolve, 20));
      host.close();
      await done;
      expect(calls.options[1]?.model).toBe("not-entitled");
      expect(calls.options[2]?.model).toBe("gpt-5.6-terra");
      expect(states.at(-1)?.ext.switch_error).toBeUndefined();
      expect(states.at(-1)?.ext.pending_model).toBeUndefined();
      expect(states.at(-1)?.ext.effective).toMatchObject({
        model: "gpt-5.6-terra",
      });
    },
  );

  it("setEffortはpendingから成功turn後にeffectiveへ確定する", async () => {
    const states: Envelope[] = [];
    const { client, calls } = makeClient([
      [{ type: "thread.started", thread_id: "effort" }, usageEvent()],
      [usageEvent()],
    ]);
    const host = new CodexHost(
      { ...CONFIG, model: "gpt-5.6-sol", effort: "low" },
      {
        onState: (event) => states.push(event),
        appendSystemPrompt: "p",
        modelSource: "config",
        effortSource: "config",
        codexFactory: () => client,
        now: () => "T",
      },
    );
    const done = host.run("first");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await host.setEffort("high");
    expect(states.at(-1)?.ext.pending_effort).toBe("high");
    await host.send("second");
    await new Promise((resolve) => setTimeout(resolve, 20));
    host.close();
    await done;
    expect(calls.options[1]?.modelReasoningEffort).toBe("high");
    expect(states.at(-1)?.ext.pending_effort).toBeUndefined();
    expect(states.at(-1)?.ext.effective).toMatchObject({ effort: "high" });
  });

  it("新modelで無効なeffortを明示resetし既定値へ確定する", async () => {
    const states: Envelope[] = [];
    const { client, calls } = makeClient([
      [{ type: "thread.started", thread_id: "reset" }, usageEvent()],
      [usageEvent()],
    ]);
    const host = new CodexHost(
      { ...CONFIG, model: "gpt-5.6-sol", effort: "ultra" },
      {
        onState: (event) => states.push(event),
        appendSystemPrompt: "p",
        modelSource: "config",
        effortSource: "config",
        codexFactory: () => client,
        now: () => "T",
      },
    );
    const done = host.run("first");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await host.setModel("gpt-5.6-luna");
    expect(states.at(-1)?.ext.effort_reset).toBe(true);
    expect(states.at(-1)?.ext.pending_effort).toBeUndefined();
    await host.send("second");
    await new Promise((resolve) => setTimeout(resolve, 20));
    host.close();
    await done;
    expect(calls.options[1]).not.toHaveProperty("modelReasoningEffort");
    expect(states.at(-1)?.ext.effort_reset).toBeUndefined();
    expect(states.at(-1)?.ext.effective).toMatchObject({ effort: "medium" });
  });

  it("account default の実効 model を rollout から解決して ext に載せる", async () => {
    const states: Envelope[] = [];
    const { client } = makeClient([
      [
        { type: "thread.started", thread_id: "uuid-model" },
        { type: "turn.started" },
        usageEvent(),
      ],
    ]);
    const host = new CodexHost(CONFIG, {
      onState: (e) => states.push(e),
      appendSystemPrompt: "p",
      codexFactory: () => client,
      modelResolver: async (id) => (id === "uuid-model" ? "gpt-5.6-sol" : null),
      now: () => "T",
    });

    await runOneTurn(host, "hello");

    expect(states[0]?.ext).not.toHaveProperty("model");
    expect(states.at(-1)?.ext).toMatchObject({
      model: "gpt-5.6-sol",
      model_source: "default",
      effective: {
        model: "gpt-5.6-sol",
        model_source: "default",
      },
    });
  });

  it("turn.completed 後の background retry で account default を解決する", async () => {
    const states: Envelope[] = [];
    const { client } = makeClient([
      [
        { type: "thread.started", thread_id: "uuid-delayed-model" },
        { type: "turn.started" },
        usageEvent(),
      ],
    ]);
    const resolved = [null, "gpt-delayed"];
    const resolver = vi.fn(async () => resolved.shift() ?? null);
    const host = new CodexHost(CONFIG, {
      onState: (e) => states.push(e),
      appendSystemPrompt: "p",
      codexFactory: () => client,
      modelResolver: resolver,
      now: () => "T",
    });

    await runOneTurn(host, "hello");

    expect(resolver).toHaveBeenCalledTimes(2);
    expect(
      states.some(
        (state) =>
          state.state === "waiting_input" &&
          !("model" in state.ext),
      ),
    ).toBe(true);
    expect(states.at(-1)?.ext).toMatchObject({
      model: "gpt-delayed",
      model_source: "default",
    });
    expect(host.statusSnapshot()).toMatchObject({
      model: "gpt-delayed",
      model_source: "default",
    });
  });

  it("account default の再解決失敗時は前 turn の model を stale 保持しない", async () => {
    const states: Envelope[] = [];
    const { client } = makeClient([
      [
        { type: "thread.started", thread_id: "uuid-unknown-model" },
        { type: "turn.started" },
        usageEvent(),
      ],
      [{ type: "turn.started" }, usageEvent()],
    ]);
    const resolved = ["gpt-first", null, null];
    const host = new CodexHost(CONFIG, {
      onState: (e) => states.push(e),
      appendSystemPrompt: "p",
      codexFactory: () => client,
      modelResolver: async () => resolved.shift() ?? null,
      now: () => "T",
    });

    const done = host.run("first");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await host.send("second");
    await new Promise((resolve) => setTimeout(resolve, 20));
    host.close();
    await done;

    expect(states.some((e) => e.ext.model === "gpt-first")).toBe(true);
    expect(states.at(-1)?.ext).not.toHaveProperty("model");
    expect(states.at(-1)?.ext).not.toHaveProperty("model_source");
    expect(host.statusSnapshot()).not.toHaveProperty("model");
  });

  it("遅い旧 turn の model refresh は新 turn の解決値を上書きしない", async () => {
    const states: Envelope[] = [];
    const { client } = makeClient([
      [
        { type: "thread.started", thread_id: "uuid-generation" },
        { type: "turn.started" },
        usageEvent(),
      ],
      [{ type: "turn.started" }, usageEvent()],
    ]);
    let releaseOld!: (model: string) => void;
    const oldRefresh = new Promise<string>((resolve) => {
      releaseOld = resolve;
    });
    let calls = 0;
    const host = new CodexHost(CONFIG, {
      onState: (e) => states.push(e),
      appendSystemPrompt: "p",
      codexFactory: () => client,
      modelResolver: async () => {
        calls += 1;
        if (calls === 1) return null;
        if (calls === 2) return oldRefresh;
        return "gpt-new-turn";
      },
      now: () => "T",
    });

    const done = host.run("first");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await host.send("second");
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseOld("gpt-old-refresh");
    await Promise.resolve();
    host.close();
    await done;

    expect(host.statusSnapshot()).toMatchObject({
      model: "gpt-new-turn",
      model_source: "default",
    });
    expect(states.at(-1)?.ext.model).toBe("gpt-new-turn");
  });

  it("account default は pin せず turn ごとの実効 model を更新する", async () => {
    const states: Envelope[] = [];
    const { client, calls } = makeClient([
      [
        { type: "thread.started", thread_id: "uuid-routing" },
        { type: "turn.started" },
        usageEvent(),
      ],
      [{ type: "turn.started" }, usageEvent()],
    ]);
    const models = ["gpt-first", "gpt-second"];
    const host = new CodexHost(CONFIG, {
      onState: (e) => states.push(e),
      appendSystemPrompt: "p",
      codexFactory: () => client,
      modelResolver: async () => models.shift() ?? null,
      now: () => "T",
    });

    const done = host.run("first");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await host.send("second");
    await new Promise((resolve) => setTimeout(resolve, 20));
    host.close();
    await done;

    expect(calls.options[1]).not.toHaveProperty("model");
    expect(states.at(-1)?.ext).toMatchObject({
      model: "gpt-second",
      model_source: "default",
    });
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
    // supports_session_reset は phase-17 17-6 で adapter 側の flip が完了。
    // Codex は startThread() を fresh 経路とする F2 handshake を提供する
    // ため true stamp + 対応 modes 列挙。thread ID の lazy 採番は server
    // 側で to_session_id=null の completed broadcast を許容する経路で吸収。
    const first = states[0]!;
    expect(first.ext?.session_capabilities).toEqual({
      supports_attachments: false,
      supports_user_input_dialog: true,
      supports_model_switch: true,
      supports_effort_switch: false,
      supports_session_reset: true,
      session_reset_modes: ["new", "clear"],
      supports_context_usage: false,
    });
  });

  it("Codex は ext.context を絶対に stamp しない (ADR-0040)", async () => {
    // capability=false と一貫: turn.completed.usage.input_tokens は
    // per-turn 入力のみで context 使用率にならないため、estimated 投影も
    // 行わない。全 envelope で ext.context が存在しないことを検査。
    const states: Envelope[] = [];
    const { client } = makeClient([[usageEvent()]]);
    const host = new CodexHost(CONFIG, {
      onState: (e) => states.push(e),
      appendSystemPrompt: "persona",
      codexFactory: () => client,
      now: () => "T",
    });
    await runOneTurn(host, "hi");
    for (const env of states) {
      expect(env.ext).not.toHaveProperty("context");
    }
  });

  it("active modelとcatalogからswitch capabilityをstampする", async () => {
    const states: Envelope[] = [];
    const { client } = makeClient([[usageEvent()]]);
    const host = new CodexHost(
      { ...CONFIG, model: "gpt-5.6-sol" },
      {
        onState: (event) => states.push(event),
        appendSystemPrompt: "p",
        modelSource: "config",
        codexFactory: () => client,
        now: () => "T",
      },
    );
    await runOneTurn(host, "hi");
    expect(states[0]?.ext.session_capabilities).toMatchObject({
      supports_model_switch: true,
      supports_effort_switch: true,
    });
  });

  it("空catalogではswitch capabilityをfail-closedする", async () => {
    const states: Envelope[] = [];
    const { client } = makeClient([[usageEvent()]]);
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const host = new CodexHost(
        {
          ...CONFIG,
          model: "gpt-5.6-sol",
          codex_auth_mode: "unknown",
        },
        {
          onState: (event) => states.push(event),
          appendSystemPrompt: "p",
          modelSource: "config",
          codexFactory: () => client,
          now: () => "T",
        },
      );
      await runOneTurn(host, "hi");
      expect(states[0]?.ext.session_capabilities).toMatchObject({
        supports_model_switch: false,
        supports_effort_switch: false,
      });
    } finally {
      stderr.mockRestore();
    }
  });

  // Resume privilege restoration regression pin (ADR-0014 F1 追補,
  // resume-privilege-restoration 藤 P0). The wrapper reads
  // `config.sandbox` / `config.network_access` verbatim: the actual
  // apply happens on the runner side (`applyResumeSnapshot`), and
  // this fixture confirms the wrapper doesn't silently downgrade the
  // restored value.
  describe("resume privilege restoration (P0 pin)", () => {
    it("config.sandbox = danger-full-access + network_access=true が ThreadOptions に載る", async () => {
      const { client, calls } = makeClient([
        [{ type: "thread.started", thread_id: "restore-danger" }, usageEvent()],
      ]);
      const host = new CodexHost(
        {
          ...CONFIG,
          sandbox: "danger-full-access",
          network_access: true,
        },
        {
          onState: () => {},
          appendSystemPrompt: "p",
          codexFactory: () => client,
          now: () => "T",
        },
      );
      await runOneTurn(host, "hi");
      // ThreadOptions は startThread の呼出時に登録される。
      expect(calls.options[0]?.sandboxMode).toBe("danger-full-access");
      // Codex SDK は workspace-write の時だけ networkAccessEnabled を許す。
      // danger-full-access では network は sandbox に内包されるので options
      // には出ないのが正 (host.ts の #threadOptions gate)。
      expect(calls.options[0]?.networkAccessEnabled).toBeUndefined();
      // whoami は復元された sandbox を effective として返す。
      expect(host.statusSnapshot()).toMatchObject({
        permission: { sandbox: "danger-full-access", approval: "never" },
        network_access: true,
      });
    });

    it("config.sandbox=workspace-write + network_access=true は options に networkAccessEnabled=true", async () => {
      const { client, calls } = makeClient([
        [{ type: "thread.started", thread_id: "restore-ws-net" }, usageEvent()],
      ]);
      const host = new CodexHost(
        {
          ...CONFIG,
          sandbox: "workspace-write",
          network_access: true,
        },
        {
          onState: () => {},
          appendSystemPrompt: "p",
          codexFactory: () => client,
          now: () => "T",
        },
      );
      await runOneTurn(host, "hi");
      expect(calls.options[0]?.sandboxMode).toBe("workspace-write");
      expect(calls.options[0]?.networkAccessEnabled).toBe(true);
    });

    it("config.network_access=false (explicit) は truthy 判定で落ちない", async () => {
      const { client, calls } = makeClient([
        [
          { type: "thread.started", thread_id: "restore-ws-nonet" },
          usageEvent(),
        ],
      ]);
      const host = new CodexHost(
        {
          ...CONFIG,
          sandbox: "workspace-write",
          network_access: false,
        },
        {
          onState: () => {},
          appendSystemPrompt: "p",
          codexFactory: () => client,
          now: () => "T",
        },
      );
      await runOneTurn(host, "hi");
      expect(calls.options[0]?.networkAccessEnabled).toBe(false);
      expect(host.statusSnapshot().network_access).toBe(false);
    });

    it("resumeSnapshot と effective が一致すれば resume_drift は空", async () => {
      const states: Envelope[] = [];
      const { client } = makeClient([
        [{ type: "thread.started", thread_id: "restore-clean" }, usageEvent()],
      ]);
      const host = new CodexHost(
        {
          ...CONFIG,
          sandbox: "danger-full-access",
          network_access: true,
        },
        {
          onState: (event) => states.push(event),
          appendSystemPrompt: "p",
          // Runner が同じ値を config へも snapshot へも渡す想定。
          resumeSnapshot: {
            sandbox: "danger-full-access",
            network_access: true,
          },
          codexFactory: () => client,
          now: () => "T",
        },
      );
      await runOneTurn(host, "hi");
      const last = states.at(-1);
      expect(last?.ext.resume_drift).toEqual([]);
      expect(last?.ext.resume_snapshot).toEqual({
        sandbox: "danger-full-access",
        network_access: true,
      });
    });
  });

  // Phase-23 (ADR-0014 F1 追補「P1 pair-aware apply」). The runner now
  // restores model / effort / *_source alongside the P0 privilege axes on
  // resume. The wrapper's catalog check in the constructor is the last
  // line of defence: if the restored effort no longer matches the model's
  // effort_levels (catalog updated between sessions), the pending reset
  // must engage the existing effort_reset one-shot instead of silently
  // sending an unsupported effort to the SDK.
  describe("resume model/effort restoration (P1 catalog reset)", () => {
    it("model + effort が catalog と整合していれば reset は engage しない", async () => {
      const states: Envelope[] = [];
      const { client, calls } = makeClient([
        [{ type: "thread.started", thread_id: "p1-ok" }, usageEvent()],
      ]);
      // gpt-5.6-terra は chatgpt plus catalog で effort_levels に "high" を含む。
      const host = new CodexHost(
        {
          ...CONFIG,
          codex_auth_mode: "chatgpt",
          codex_chatgpt_plan: "plus",
          model: "gpt-5.6-terra",
          effort: "high",
        },
        {
          onState: (event) => states.push(event),
          appendSystemPrompt: "p",
          modelSource: "launch",
          effortSource: "config",
          codexFactory: () => client,
          now: () => "T",
        },
      );
      await runOneTurn(host, "hi");
      // reset は起きないので effort_reset は stamp されない。
      expect(states.some((e) => e.ext.effort_reset === true)).toBe(false);
      // ThreadOptions に effort が渡っている。
      expect(calls.options[0]?.modelReasoningEffort).toBe("high");
    });

    it("resume 経路で effort が catalog の effort_levels に無い場合、constructor で effort_reset に接続する", async () => {
      const states: Envelope[] = [];
      const { client, calls } = makeClient([
        [{ type: "thread.started", thread_id: "p1-reset" }, usageEvent()],
      ]);
      // gpt-5.6-luna の effort_levels は ["low","medium","high","xhigh","max"] で "ultra" を含まない。
      // catalog 更新で "ultra" が実際は sol/terra 系のみになった、というシナリオ。
      const host = new CodexHost(
        {
          ...CONFIG,
          codex_auth_mode: "chatgpt",
          codex_chatgpt_plan: "plus",
          model: "gpt-5.6-luna",
          effort: "ultra",
        },
        {
          onState: (event) => states.push(event),
          appendSystemPrompt: "p",
          modelSource: "launch",
          effortSource: "launch",
          // resume 経路のみ constructor reset を engage する (藤 R1 guard)。
          resumeSnapshot: {
            model: "gpt-5.6-luna",
            model_source: "launch",
            effort: "ultra",
            effort_source: "launch",
          },
          codexFactory: () => client,
          now: () => "T",
        },
      );
      // constructor 直後の statusExt は effort_reset=true を含む (one-shot)。
      const initial = host.statusExtSnapshot();
      expect(initial.effort_reset).toBe(true);
      await runOneTurn(host, "hi");
      // 少なくとも 1 つの state_change が effort_reset=true を stamp した。
      expect(states.some((e) => e.ext.effort_reset === true)).toBe(true);
      // ThreadOptions は effortResetPending 経由で effort を skip する
      // (#threadOptions gate 対応)。
      expect(calls.options[0]?.modelReasoningEffort).toBeUndefined();
    });

    it("fresh spawn (resumeSnapshot 無し) の incompatible effort では reset を engage しない (藤 R1 regression)", async () => {
      const states: Envelope[] = [];
      const { client, calls } = makeClient([
        [{ type: "thread.started", thread_id: "p1-fresh" }, usageEvent()],
      ]);
      // 同じ mismatch シナリオ (luna + ultra) だが resumeSnapshot なし →
      // constructor reset は engage せず、SDK 側 error path に委ねる従来挙動。
      const host = new CodexHost(
        {
          ...CONFIG,
          codex_auth_mode: "chatgpt",
          codex_chatgpt_plan: "plus",
          model: "gpt-5.6-luna",
          effort: "ultra",
        },
        {
          onState: (event) => states.push(event),
          appendSystemPrompt: "p",
          modelSource: "launch",
          effortSource: "launch",
          // resumeSnapshot 未設定: fresh spawn。
          codexFactory: () => client,
          now: () => "T",
        },
      );
      // fresh spawn では reset guard に阻まれ effort_reset one-shot が立たない。
      expect(host.statusExtSnapshot().effort_reset).toBeUndefined();
      await runOneTurn(host, "hi");
      expect(states.some((e) => e.ext.effort_reset === true)).toBe(false);
      // effort は SDK に渡り、SDK 側 error / 既存 switch_error rollback に委任される。
      expect(calls.options[0]?.modelReasoningEffort).toBe("ultra");
    });

    it("model が catalog に不在なら reset は engage しない (SDK 委任)", async () => {
      const states: Envelope[] = [];
      const { client } = makeClient([
        [{ type: "thread.started", thread_id: "p1-unknown" }, usageEvent()],
      ]);
      // apikey mode + chatgpt-only な model 名 ("gpt-5.6-luna" が chatgpt-only ではないが、
      // ここでは "unknown-model" で catalog 不在を模す)。
      const host = new CodexHost(
        {
          ...CONFIG,
          codex_auth_mode: "apikey",
          model: "unknown-model",
          effort: "medium",
        },
        {
          onState: (event) => states.push(event),
          appendSystemPrompt: "p",
          modelSource: "launch",
          effortSource: "config",
          codexFactory: () => client,
          now: () => "T",
        },
      );
      expect(host.statusExtSnapshot().effort_reset).toBeUndefined();
      await runOneTurn(host, "hi");
      expect(states.some((e) => e.ext.effort_reset === true)).toBe(false);
    });
  });

  // Phase-23 dogfood 回帰対策 (ADR-0014 F1 追補 P1「launch pin vs display
  // hint」). Case 2 (source=default) は runner apply が config.model /
  // config.effort を unset するが、config.resume_snapshot には sanitize 通過
  // した (value, source="default") ペアが保持されている。wrapper host は
  // これを display / catalog resolve の hint として consume することで、
  // resume 直後の「model 確認待ち」「effort 復元されない」「effort switch
  // ボタン非表示」を解消する。SDK には委任継続のため threadOptions には
  // pin しない (source="default" gate)。
  describe("resume Case 2 display hint fallback (P1 dogfood 回帰対策)", () => {
    it("config.model absent + resume_snapshot default pair → this.#model 復元、supports_effort_switch=true", async () => {
      const states: Envelope[] = [];
      const { client, calls } = makeClient([
        [{ type: "thread.started", thread_id: "hint-restore" }, usageEvent()],
      ]);
      const host = new CodexHost(
        {
          ...CONFIG,
          codex_auth_mode: "chatgpt",
          codex_chatgpt_plan: "plus",
          // config.model / config.effort は Case 2 で unset された想定
        },
        {
          onState: (event) => states.push(event),
          appendSystemPrompt: "p",
          // options.modelSource / effortSource も undefined (resolveCodexSources
          // が config.model absent で undefined を返す)
          resumeSnapshot: {
            model: "gpt-5.6-terra",
            model_source: "default",
            effort: "high",
            effort_source: "default",
          },
          codexFactory: () => client,
          now: () => "T",
        },
      );
      // whoami / effective は hint 由来で model/effort/source を stamp
      expect(host.statusSnapshot()).toMatchObject({
        model: "gpt-5.6-terra",
        model_source: "default",
        effort: "high",
        effort_source: "default",
      });
      // catalog resolve が model="gpt-5.6-terra" で動き effort_levels から
      // supports_effort_switch=true を stamp できる
      const initial = host.statusExtSnapshot();
      const caps = initial.session_capabilities as Record<string, unknown>;
      expect(caps.supports_effort_switch).toBe(true);
      // initial idle 時点: hint 復元と effective が一致するため drift 空
      // (turn 実行後は既存 accountDefault semantics で #model が SDK 側
      // 実 default に再解決され drift 出る可能性がある — その 2 段階挙動は
      // Codex 既存契約であり、本 hint 復元は「initial idle 表示」を担う)
      const initialDrift = initial.resume_drift as { field: string }[] | undefined;
      expect(
        initialDrift?.some(
          (e) =>
            e.field === "model" ||
            e.field === "model_source" ||
            e.field === "effort" ||
            e.field === "effort_source",
        ),
      ).toBeFalsy();

      await runOneTurn(host, "hi");
      // SDK 委任継続: source="default" は threadOptions.model /
      // modelReasoningEffort に pin されない
      expect(calls.options[0]?.model).toBeUndefined();
      expect(calls.options[0]?.modelReasoningEffort).toBeUndefined();
    });

    it("Case 3 explicit source (config.model set) は hint fallback より優先、SDK に pin される", async () => {
      const { client, calls } = makeClient([
        [{ type: "thread.started", thread_id: "explicit-wins" }, usageEvent()],
      ]);
      const host = new CodexHost(
        {
          ...CONFIG,
          codex_auth_mode: "chatgpt",
          codex_chatgpt_plan: "plus",
          model: "gpt-5.6-sol", // Case 3 で config へ載っている
          effort: "medium",
        },
        {
          onState: () => {},
          appendSystemPrompt: "p",
          modelSource: "launch",
          effortSource: "launch",
          // resume_snapshot は別の hint を持っていても config が優先
          resumeSnapshot: {
            model: "gpt-5.6-terra",
            model_source: "default",
            effort: "high",
            effort_source: "default",
          },
          codexFactory: () => client,
          now: () => "T",
        },
      );
      expect(host.statusSnapshot()).toMatchObject({
        model: "gpt-5.6-sol",
        model_source: "launch",
        effort: "medium",
        effort_source: "launch",
      });
      await runOneTurn(host, "hi");
      // explicit source は SDK に pin
      expect(calls.options[0]?.model).toBe("gpt-5.6-sol");
      expect(calls.options[0]?.modelReasoningEffort).toBe("medium");
    });

    it("hint 復元後 catalog effort_levels 不整合なら既存 catalog reset が engage", async () => {
      const states: Envelope[] = [];
      const { client, calls } = makeClient([
        [
          { type: "thread.started", thread_id: "hint-catalog-reset" },
          usageEvent(),
        ],
      ]);
      // luna は "ultra" を effort_levels に含まないので、hint 復元後の
      // catalog 互換 reset が engage する想定 (R1 fix の resume 経路限定
      // guard も pass する — hint 復元自体が resume 経路)。
      const host = new CodexHost(
        {
          ...CONFIG,
          codex_auth_mode: "chatgpt",
          codex_chatgpt_plan: "plus",
        },
        {
          onState: (event) => states.push(event),
          appendSystemPrompt: "p",
          resumeSnapshot: {
            model: "gpt-5.6-luna",
            model_source: "default",
            effort: "ultra",
            effort_source: "default",
          },
          codexFactory: () => client,
          now: () => "T",
        },
      );
      // constructor 直後 effort_reset one-shot が立つ
      expect(host.statusExtSnapshot().effort_reset).toBe(true);
      await runOneTurn(host, "hi");
      expect(states.some((e) => e.ext.effort_reset === true)).toBe(true);
      // effort は non-pin (source="default" gate)
      expect(calls.options[0]?.modelReasoningEffort).toBeUndefined();
    });
  });
});
