import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  Codex,
  type CodexOptions,
  type ThreadEvent,
  type ThreadOptions,
} from "@openai/codex-sdk";
import type {
  Envelope,
  ToolDescriptor,
  WrapperConfig,
} from "@kaoiro/agent-common";
import { makeStateChange } from "@kaoiro/agent-common";
import { CodexHost, initialStatusExt } from "../src/host.js";
import type { CodexClientLike, CodexThreadLike } from "../src/host.js";
import {
  CodexTurnDiagnostics,
  codexTurnTraceCaptureDir,
} from "../src/turn_diagnostics.js";
import {
  codexRateLimitsFromRolloutIn,
  repairRolloutCorruption,
  verifyRolloutCorruption,
  type CodexRateLimitSnapshot,
  type CodexRateLimitWindow,
} from "../src/rollout.js";

const CONFIG: WrapperConfig = {
  agent_id: "host-1.codex-a",
  persona: { id: "kuroe", name: "クロエ", sprite_set: "kuroe" },
  display_name: "クロエ",
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
        supports_attachments: true,
        attachment_types: ["image"],
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
    ).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra"]);
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

  // issue #292: codex_extra_models (relayed from runner.config.json's
  // codex.extra_models) merges into the resolved catalog before ext.models
  // is stamped.
  it("appends a new codex_extra_models model to ext.models (issue #292)", () => {
    const config: WrapperConfig = {
      ...CONFIG,
      codex_extra_models: [
        {
          value: "gpt-9-nova",
          display_name: "GPT-9 Nova",
          effort_levels: ["low", "high"],
          default_effort: "low",
        },
      ],
    };
    const initial = initialStatusExt(config);
    expect(
      (initial.models as { value: string }[]).map((m) => m.value),
    ).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-6-astra",
      "gpt-9-nova",
    ]);
  });

  it("codex_extra_models overrides an existing value (issue #292)", () => {
    const config: WrapperConfig = {
      ...CONFIG,
      codex_extra_models: [
        { value: "gpt-5.6-luna", display_name: "overridden" },
      ],
    };
    const initial = initialStatusExt(config);
    const luna = (
      initial.models as { value: string; display_name: string }[]
    ).find((m) => m.value === "gpt-5.6-luna");
    expect(luna?.display_name).toBe("overridden");
  });

  it("does not stamp an extra model above the bundled Codex version", () => {
    const initial = initialStatusExt({
      ...CONFIG,
      codex_extra_models: [
        {
          value: "requires-newer-codex",
          display_name: "Requires newer Codex",
          minimal_client_version: "999.0.0",
        },
      ],
    });
    expect((initial.models as { value: string }[]).map((model) => model.value)).not.toContain(
      "requires-newer-codex",
    );
  });
});

describe("CodexHost — display_name rename (issue #197 段階3, revised issue #219 D19/D23)", () => {
  // A FRESH object per call, NOT a shared const — renameDisplayName
  // reassigns #config.display_name, and CodexHost holds the SAME object
  // reference it was constructed with (no clone). A single const reused
  // across both `it` blocks below would let the first test's rename
  // mutate the object the second test starts from (review round1
  // finding, same as the claude-code AgentHost twin of this suite).
  function freshRenameConfig(): WrapperConfig {
    return {
      agent_id: "test.rename-agent",
      persona: { id: "kuroe", name: "クロエ", sprite_set: "kuroe" },
      display_name: "クロエ",
      server_url: "ws://localhost:4000/wrapper",
    };
  }

  it("revision が新しければ display_name を更新し state_change を即時再送する。persona は不変", () => {
    const envs: Envelope[] = [];
    const host = new CodexHost(freshRenameConfig(), {
      onState: (e) => envs.push(e),
      appendSystemPrompt: "p",
      now: () => "T",
    });

    host.renameDisplayName("クロエ(改名)", 1);

    expect(envs.at(-1)?.display_name).toBe("クロエ(改名)");
    expect(envs.at(-1)?.persona).toEqual({
      id: "kuroe",
      name: "クロエ",
      sprite_set: "kuroe",
    });
  });

  it("revision が現在値以下なら無視し state_change を再送しない (D15)", () => {
    const envs: Envelope[] = [];
    const host = new CodexHost(freshRenameConfig(), {
      onState: (e) => envs.push(e),
      appendSystemPrompt: "p",
      now: () => "T",
    });

    host.renameDisplayName("先勝ち", 2);
    expect(envs).toHaveLength(1);

    host.renameDisplayName("同revision再送", 2);
    host.renameDisplayName("古いrevision", 1);

    expect(envs).toHaveLength(1);
    expect(envs.at(-1)?.display_name).toBe("先勝ち");
  });
});

describe("CodexHost — own tasklist envelopes (issue #188)", () => {
  it("todo_list を tasklist envelope にし、完全重複は送らない", async () => {
    const tasks: Envelope[] = [];
    const todoList: ThreadEvent = {
      type: "item.updated",
      item: {
        id: "todos",
        type: "todo_list",
        items: [
          { text: "調査", completed: false },
          { text: "実装", completed: true },
        ],
      },
    };
    const { client } = makeClient([[todoList, todoList, usageEvent()]]);
    const host = new CodexHost(CONFIG, {
      onState: () => {},
      onTask: (envelope) => tasks.push(envelope),
      appendSystemPrompt: "p",
      codexFactory: () => client,
      now: () => "T",
    });

    await runOneTurn(host, "todo", client);

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      type: "task",
      payload: {
        agent_id: "host-1.codex-a",
        task_id: "tasklist",
        task_type: "tasklist",
        kind: "updated",
        status: "running",
        items: [
          { text: "調査", status: "pending" },
          { text: "実装", status: "completed" },
        ],
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
      cache_write_input_tokens: 0,
    },
  };
}

/** Scripted client: each runStreamed call yields the next event batch and
 *  records the thread options / resume ids it was constructed with. */
type ScriptedTurn = ThreadEvent[] | Error;

type ScriptedClient = CodexClientLike & {
  /** Resolves after the host has consumed every event from the given turn. */
  waitForTurn(index: number): Promise<void>;
};

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function makeClient(turns: ScriptedTurn[]): {
  client: ScriptedClient;
  calls: {
    resume: (string | null)[];
    options: (ThreadOptions | undefined)[];
    inputs: Array<string | Array<{ type: "text"; text: string } | { type: "local_image"; path: string }>>;
  };
} {
  let turn = 0;
  const turnConsumed = turns.map(() => deferred<void>());
  const calls: {
    resume: (string | null)[];
    options: (ThreadOptions | undefined)[];
    inputs: Array<string | Array<{ type: "text"; text: string } | { type: "local_image"; path: string }>>;
  } = { resume: [], options: [], inputs: [] };
  const thread: CodexThreadLike = {
    async runStreamed(input) {
      calls.inputs.push(input);
      const turnIndex = turn;
      const scripted = turns[turnIndex] ?? [];
      turn += 1;
      if (scripted instanceof Error) {
        turnConsumed[turnIndex]?.resolve();
        throw scripted;
      }
      const events = scripted;
      async function* gen(): AsyncGenerator<ThreadEvent> {
        try {
          for (const event of events) yield event;
        } finally {
          // An async generator resumes after each yielded event is consumed.
          // Resolving here therefore means the host observed the terminal
          // event (or stream end), not merely that the mock started.
          turnConsumed[turnIndex]?.resolve();
        }
      }
      return { events: gen() };
    },
  };
  const client: ScriptedClient = {
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
    waitForTurn(index) {
      const consumed = turnConsumed[index];
      if (consumed === undefined) {
        throw new Error(`No scripted turn at index ${index}`);
      }
      return consumed.promise;
    },
  };
  return { client, calls };
}

/** Runs the host for one prompt turn, closing it after the turn settles. */
async function runOneTurn(
  host: CodexHost,
  prompt: string,
  client: ScriptedClient,
  settled?: Promise<void>,
): Promise<void> {
  const done = host.run(prompt);
  // The run loop waits for the queue after the turn; close() wakes it.
  // Await the mock's consumption signal rather than a wall-clock delay: run()
  // reaches startThread only after non-timer async setup completes.
  await client.waitForTurn(0);
  // Account-default and rate-limit refreshes deliberately run after the
  // terminal event. Tests that observe those projections provide their own
  // event-driven completion signal here before close() can cancel the work.
  await settled;
  host.close();
  await done;
}

describe("CodexHost", () => {
  it("fails startup for a curated model newer than the bundled Codex CLI", () => {
    expect(
      () =>
        new CodexHost(
          { ...CONFIG, model: "gpt-6-astra" },
          {
            onState: () => {},
            appendSystemPrompt: "p",
            codexClientVersion: "0.144.1",
          },
        ),
    ).toThrow(
      "codex: model gpt-6-astra requires Codex >= 0.153.0, bundled version is 0.144.1",
    );
  });

  it("surfaces a switch error for a curated model newer than the bundled Codex CLI", async () => {
    const states: Envelope[] = [];
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const { client } = makeClient([
      [{ type: "thread.started", thread_id: "last-good" }, usageEvent()],
    ]);
    const host = new CodexHost(
      { ...CONFIG, model: "gpt-5.6-terra" },
      {
        onState: (state) => states.push(state),
        appendSystemPrompt: "p",
        codexFactory: () => client,
        codexClientVersion: "0.144.1",
      },
    );
    const running = host.run("establish last good");
    await client.waitForTurn(0);
    await vi.waitFor(() => {
      expect(states.some((state) => state.state === "done")).toBe(true);
    });
    const statesBeforeSwitch = states.length;

    await expect(host.setModel("gpt-6-astra")).resolves.toBeUndefined();
    expect(states).toHaveLength(statesBeforeSwitch + 1);
    expect(states.at(-1)?.ext.switch_error).toEqual({
      kind: "model",
      requested: "gpt-6-astra",
      reason: "client_version_too_old",
      rolled_back_to: "gpt-5.6-terra",
    });
    expect(stderr).toHaveBeenCalledWith(
      "codex: codex: model gpt-6-astra requires Codex >= 0.153.0, bundled version is 0.144.1\n",
    );
    host.close();
    await running;
    stderr.mockRestore();
  });

  it("leaves an explicitly declared operator model outside the curated startup gate", () => {
    expect(
      () =>
        new CodexHost(
          {
            ...CONFIG,
            model: "operator-model",
            codex_extra_models: [
              {
                value: "operator-model",
                display_name: "Operator model",
                minimal_client_version: "0.153.0",
              },
            ],
          },
          {
            onState: () => {},
            appendSystemPrompt: "p",
            codexClientVersion: "0.144.1",
          },
        ),
    ).not.toThrow();
  });

  it("finishes a real SDK stream when command output contains U+2028", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaoiro-codex-sdk-line-split-"));
    const executable = join(root, "fake-codex");
    const script = [
      "#!/usr/bin/env node",
      "const separator = String.fromCodePoint(0x2028);",
      "const write = (item) => process.stdout.write(`${JSON.stringify(item)}\\n`);",
      "write({ type: 'thread.started', thread_id: 'sdk-line-split' });",
      "write({ type: 'turn.started' });",
      "const item = {",
      "  id: 'command',",
      "  type: 'command_execution',",
      "  command: 'echo fixture',",
      "  aggregated_output: `before${separator}after`,",
      "  status: 'completed',",
      "  exit_code: 0,",
      "};",
      "write({ type: 'item.completed', item });",
      "write({",
      "  type: 'turn.completed',",
      "  usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, cache_write_input_tokens: 0 },",
      "});",
    ].join("\n");
    await writeFile(executable, script, "utf8");
    await chmod(executable, 0o700);

    const logs: Envelope[] = [];
    const ended = deferred<void>();
    const host = new CodexHost(CONFIG, {
      onState: () => {},
      onLog: (envelope) => logs.push(envelope),
      onTurnEnd: () => ended.resolve(),
      appendSystemPrompt: "p",
      codexFactory: () =>
        new Codex({ codexPathOverride: executable }) as CodexClientLike,
      now: () => "T",
    });
    const running = host.run("exercise patched reader");

    try {
      await ended.promise;
      expect(logs).toContainEqual(
        expect.objectContaining({
          type: "result",
          state: "done",
          payload: expect.not.objectContaining({ is_error: true }),
        }),
      );
    } finally {
      host.close();
      await running;
      await rm(root, { recursive: true, force: true });
    }
  });

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
      permission: {
        sandbox: "workspace-write",
        approval: "never",
        enforcement: "os",
      },
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
      await runOneTurn(host, "hi", client);
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
    await runOneTurn(host, "hi", client);
    expect(
      (captured?.config as Record<string, unknown> | undefined)?.features,
    ).toEqual({ multi_agent: true });
  });

  it.each([
    ["chatgpt", "free", ["gpt-5.6-terra"]],
    ["chatgpt", "go", ["gpt-5.6-terra"]],
    [
      "chatgpt",
      "plus",
      ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra"],
    ],
    [
      "chatgpt",
      "pro",
      ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra"],
    ],
    [
      "chatgpt",
      "business",
      ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra"],
    ],
    [
      "chatgpt",
      "enterprise",
      ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra"],
    ],
    [
      "apikey",
      undefined,
      [
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-6-astra",
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
        await runOneTurn(host, "catalog", client);
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
    await runOneTurn(host, "hello", client);

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
    ).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra"]);
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
    await client.waitForTurn(0);
    await host.setModel("gpt-5.4-mini");
    await host.send("second");
    await client.waitForTurn(1);
    host.close();
    await done;

    expect(calls.resume).toEqual([null, "uuid-2"]);
    expect(calls.options[1]).toMatchObject({ model: "gpt-5.4-mini" });
  });

  it("実行中のsetModelは現turnを変えず次turnへpendingする", async () => {
    const states: Envelope[] = [];
    const firstTurnStarted = deferred<void>();
    const turnConsumed = [deferred<void>(), deferred<void>()];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: (ThreadOptions | undefined)[] = [];
    const client: CodexClientLike = {
      startThread(options) {
        calls.push(options);
        return {
          async runStreamed() {
            async function* events(): AsyncGenerator<ThreadEvent> {
              try {
                yield { type: "thread.started", thread_id: "boundary" };
                yield { type: "turn.started" };
                // This runs only after the host consumes turn.started, keeping
                // setModel inside the active turn rather than after it settles.
                firstTurnStarted.resolve();
                await gate;
                yield usageEvent();
              } finally {
                turnConsumed[0]!.resolve();
              }
            }
            return { events: events() };
          },
        };
      },
      resumeThread(_id, options) {
        calls.push(options);
        return {
          async runStreamed() {
            async function* events(): AsyncGenerator<ThreadEvent> {
              try {
                yield usageEvent();
              } finally {
                turnConsumed[1]!.resolve();
              }
            }
            return { events: events() };
          },
        };
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
    await firstTurnStarted.promise;
    await host.setModel("gpt-5.6-sol");
    expect(calls[0]?.model).toBe("gpt-5.6-terra");
    expect(states.at(-1)?.ext.pending_model).toBe("gpt-5.6-sol");
    release();
    await turnConsumed[0]!.promise;
    expect(states.at(-1)?.ext.pending_model).toBe("gpt-5.6-sol");
    await host.send("second");
    await turnConsumed[1]!.promise;
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
    await client.waitForTurn(0);
    await host.setModel("gpt-5.6-sol");
    expect(states.at(-1)?.ext).toMatchObject({
      pending_model: "gpt-5.6-sol",
      effective: { model: "gpt-5.6-terra" },
    });
    await host.send("second");
    await client.waitForTurn(1);
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
      await client.waitForTurn(0);
      await host.setModel("not-entitled");
      await host.send("second");
      await client.waitForTurn(1);
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
      await client.waitForTurn(2);
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
    await client.waitForTurn(0);
    await host.setEffort("high");
    expect(states.at(-1)?.ext.pending_effort).toBe("high");
    await host.send("second");
    await client.waitForTurn(1);
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
    await client.waitForTurn(0);
    await host.setModel("gpt-5.6-luna");
    expect(states.at(-1)?.ext.effort_reset).toBe(true);
    expect(states.at(-1)?.ext.pending_effort).toBeUndefined();
    await host.send("second");
    await client.waitForTurn(1);
    host.close();
    await done;
    expect(calls.options[1]).not.toHaveProperty("modelReasoningEffort");
    expect(states.at(-1)?.ext.effort_reset).toBeUndefined();
    expect(states.at(-1)?.ext.effective).toMatchObject({ effort: "medium" });
  });

  // issue #292: codex_extra_models must reach the LIVE catalog the
  // constructor builds (this.#catalog), not just initialStatusExt's
  // static snapshot -- setModel's effort-compatibility check is the only
  // observable signal that a declared extra model's own effort_levels
  // are actually consulted (the model value itself is never rejected at
  // the wrapper layer; only the SDK can reject a switch, via the
  // existing 400/404 switch_error path tested above).
  it("switching to a codex_extra_models model resets an effort incompatible with its own effort_levels (issue #292)", async () => {
    const states: Envelope[] = [];
    const { client, calls } = makeClient([
      [{ type: "thread.started", thread_id: "extra-model-reset" }, usageEvent()],
      [usageEvent()],
    ]);
    const host = new CodexHost(
      {
        ...CONFIG,
        model: "gpt-5.6-sol",
        effort: "ultra",
        codex_extra_models: [
          {
            value: "gpt-9-nova",
            display_name: "GPT-9 Nova",
            effort_levels: ["low"],
            default_effort: "low",
          },
        ],
      },
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
    await client.waitForTurn(0);
    await host.setModel("gpt-9-nova");
    expect(states.at(-1)?.ext.effort_reset).toBe(true);
    expect(states.at(-1)?.ext.pending_effort).toBeUndefined();
    await host.send("second");
    await client.waitForTurn(1);
    host.close();
    await done;
    expect(calls.options[1]).not.toHaveProperty("modelReasoningEffort");
    expect(states.at(-1)?.ext.effort_reset).toBeUndefined();
    expect(states.at(-1)?.ext.effective).toMatchObject({ effort: "low" });
  });

  it("account default の実効 model を rollout から解決して ext に載せる", async () => {
    const states: Envelope[] = [];
    const modelStamped = deferred<void>();
    const { client } = makeClient([
      [
        { type: "thread.started", thread_id: "uuid-model" },
        { type: "turn.started" },
        usageEvent(),
      ],
    ]);
    const host = new CodexHost(CONFIG, {
      onState: (e) => {
        states.push(e);
        if (e.ext.model === "gpt-5.6-sol") modelStamped.resolve();
      },
      appendSystemPrompt: "p",
      codexFactory: () => client,
      modelResolver: async (id) => (id === "uuid-model" ? "gpt-5.6-sol" : null),
      now: () => "T",
    });

    await runOneTurn(host, "hello", client, modelStamped.promise);

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
    const modelStamped = deferred<void>();
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
      onState: (e) => {
        states.push(e);
        if (e.ext.model === "gpt-delayed") modelStamped.resolve();
      },
      appendSystemPrompt: "p",
      codexFactory: () => client,
      modelResolver: resolver,
      now: () => "T",
    });

    await runOneTurn(host, "hello", client, modelStamped.promise);

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
    const firstModelStamped = deferred<void>();
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
      onState: (e) => {
        states.push(e);
        if (e.ext.model === "gpt-first") firstModelStamped.resolve();
      },
      appendSystemPrompt: "p",
      codexFactory: () => client,
      modelResolver: async () => resolved.shift() ?? null,
      now: () => "T",
    });

    const done = host.run("first");
    await client.waitForTurn(0);
    await firstModelStamped.promise;
    await host.send("second");
    await client.waitForTurn(1);
    host.close();
    await done;

    expect(states.some((e) => e.ext.model === "gpt-first")).toBe(true);
    expect(states.at(-1)?.ext).not.toHaveProperty("model");
    expect(states.at(-1)?.ext).not.toHaveProperty("model_source");
    expect(host.statusSnapshot()).not.toHaveProperty("model");
  });

  it("遅い旧 turn の model refresh は新 turn の解決値を上書きしない", async () => {
    const states: Envelope[] = [];
    const oldRefreshStarted = deferred<void>();
    const newModelStamped = deferred<void>();
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
      onState: (e) => {
        states.push(e);
        if (e.ext.model === "gpt-new-turn") newModelStamped.resolve();
      },
      appendSystemPrompt: "p",
      codexFactory: () => client,
      modelResolver: () => {
        calls += 1;
        if (calls === 1) return Promise.resolve(null);
        if (calls === 2) {
          oldRefreshStarted.resolve();
          return oldRefresh;
        }
        return Promise.resolve("gpt-new-turn");
      },
      now: () => "T",
    });

    const done = host.run("first");
    await client.waitForTurn(0);
    await oldRefreshStarted.promise;
    await host.send("second");
    await client.waitForTurn(1);
    await newModelStamped.promise;
    releaseOld("gpt-old-refresh");
    await oldRefresh;
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
    const firstModelStamped = deferred<void>();
    const secondModelStamped = deferred<void>();
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
      onState: (e) => {
        states.push(e);
        if (e.ext.model === "gpt-first") firstModelStamped.resolve();
        if (e.ext.model === "gpt-second") secondModelStamped.resolve();
      },
      appendSystemPrompt: "p",
      codexFactory: () => client,
      modelResolver: async () => models.shift() ?? null,
      now: () => "T",
    });

    const done = host.run("first");
    await client.waitForTurn(0);
    await firstModelStamped.promise;
    await host.send("second");
    await client.waitForTurn(1);
    await secondModelStamped.promise;
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
    await runOneTurn(host, "again", client);
    expect(calls.resume).toEqual(["uuid-resume"]);
  });

  it("terminal event 無しの stream 終了は error → waiting_input に畳む", async () => {
    const states: Envelope[] = [];
    const turnEnded = deferred<void>();
    const { client } = makeClient([
      [{ type: "thread.started", thread_id: "u" }, { type: "turn.started" }],
    ]);
    const host = new CodexHost(CONFIG, {
      onState: (e) => states.push(e),
      appendSystemPrompt: "p",
      codexFactory: () => client,
      onTurnEnd: () => turnEnded.resolve(),
      now: () => "T",
    });
    await runOneTurn(host, "x", client, turnEnded.promise);
    expect(states.map((e) => e.state)).toEqual([
      "sending",
      "thinking",
      "error",
      "waiting_input",
    ]);
  });

  it("画像 upload を SDK local_image input にし、turn 後に temp file を削除する", async () => {
    const { client, calls } = makeClient([[usageEvent()]]);
    const host = new CodexHost(CONFIG, {
      onState: () => {},
      appendSystemPrompt: "p",
      codexFactory: () => client,
      now: () => "T",
    });
    host.attachOpen({ upload_id: "up-1", filename: "screen.png", mime: "image/png", size: 3, chunks: 1 });
    const id = new TextEncoder().encode("up-1");
    const payload = new Uint8Array(4 + id.length + 4 + 3);
    new DataView(payload.buffer).setUint32(0, id.length, false);
    payload.set(id, 4);
    new DataView(payload.buffer).setUint32(4 + id.length, 0, false);
    payload.set([1, 2, 3], 4 + id.length + 4);
    host.attachChunk(payload);
    host.attachClose("up-1");
    await host.send("with image", ["up-1"]);
    const running = host.run();
    await client.waitForTurn(0);
    host.close();
    await running;
    expect(calls.inputs).toHaveLength(1);
    expect(calls.inputs[0]).toMatchObject([
      { type: "text", text: "with image" },
      { type: "local_image" },
    ]);
    const input = calls.inputs[0] as Array<{ type: string; path?: string }>;
    await expect(import("node:fs/promises").then(({ access }) => access(input[1]!.path!))).rejects.toThrow();
  });

  it("非画像 upload は attach_rejected で loud に弾く", () => {
    const rejected: Envelope[] = [];
    const { client } = makeClient([]);
    const host = new CodexHost(CONFIG, {
      onState: () => {}, appendSystemPrompt: "p", codexFactory: () => client,
      onAttachRejected: (e) => rejected.push(e), now: () => "T",
    });
    host.attachOpen({ upload_id: "not-image", filename: "note.txt", mime: "text/plain", size: 1, chunks: 1 });
    expect(rejected[0]?.payload).toMatchObject({ upload_id: "not-image", reason: "mime_denied" });
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
    await runOneTurn(host, "hi", client);

    const config = captured!.config as Record<string, unknown>;
    const mcp = config.mcp_servers as Record<string, Record<string, unknown>>;
    expect(mcp.kaoiro!.default_tools_approval_mode).toBe("approve");
    expect(mcp.kaoiro!.tool_timeout_sec).toBe(310);
    expect(config.developer_instructions).toBe("persona");
  });

  it("materialize 中の interrupt は completion 後にも local_image turn を enqueue しない (#112 M5)", async () => {
    const { client, calls } = makeClient([[usageEvent()]]);
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const host = new CodexHost(CONFIG, {
      onState: () => {},
      appendSystemPrompt: "p",
      codexFactory: () => client,
      materializeImages: async (_agentId, _uploads, lifecycle) => {
        lifecycle.onDirectoryCreated("/tmp/kaoiro-test-race");
        entered();
        await barrier;
        if (lifecycle.cancelled()) {
          lifecycle.onDirectoryDisposed("/tmp/kaoiro-test-race");
          throw new Error("cancelled");
        }
        return { dir: "/tmp/kaoiro-test-race", paths: ["/tmp/kaoiro-test-race/image.png"] };
      },
    });
    host.attachOpen({ upload_id: "race", filename: "race.png", mime: "image/png", size: 1, chunks: 1 });
    const id = new TextEncoder().encode("race");
    const payload = new Uint8Array(4 + id.length + 4 + 1);
    new DataView(payload.buffer).setUint32(0, id.length, false);
    payload.set(id, 4);
    new DataView(payload.buffer).setUint32(4 + id.length, 0, false);
    payload[payload.length - 1] = 1;
    host.attachChunk(payload);
    host.attachClose("race");
    const sending = host.send("race", ["race"]);
    await enteredPromise;
    await host.interrupt();
    release();
    await sending;
    const running = host.run();
    // Drive a known follow-up through the run loop. If the cancelled image
    // turn were resurrected, it would run before this prompt and fail here.
    await host.send("follow-up");
    await client.waitForTurn(0);
    host.close();
    await running;
    expect(calls.inputs).toEqual(["follow-up"]);
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
    await runOneTurn(host, "hi", client);
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
    await runOneTurn(host, "hi", client);
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
    await runOneTurn(host, "hi", client);
    // session_capabilities は #statusExt から unconditional に stamp されるため
    // 全 state_change に乗る (ADR-0034 F1)。Codex は毎ターン exec spawn モデル
    // のため adapter 構築時に決めた capability が turn の外 (idle) でも state_change
    // で advertise される。states[0] は turn 開始の sending 状態。
    // supports_session_reset は phase-17 17-6 で adapter 側の flip が完了。
    // Codex は startThread() を fresh 経路とする F2 handshake を提供する
    // ため true stamp + 対応 modes 列挙。thread ID の lazy 採番は server
    // 側で to_session_id=null の completed broadcast を許容する経路で吸収。
    //
    // Phase-23 dogfood 再回帰対策 (藤 修正版方針 3): supports_effort_switch
    // は `effortLevelsForModel(catalog, model).length > 0` で判定。ここでは
    // model 未指定 (config.model 無し) + chatgpt+plus catalog (SOL/TERRA/LUNA)
    // の intersection = ["low","medium","high","xhigh","max"] が非空なので
    // true。model=null (account default 経路) でも catalog に共通 effort が
    // 揃うなら button を有効化するのが本 fix の意図 (旧: catalog.find(null)
    // → undefined → false で account default 経路が非表示だった)。
    const first = states[0]!;
    expect(first.ext?.session_capabilities).toEqual({
      supports_attachments: true,
      attachment_types: ["image"],
      supports_user_input_dialog: true,
      supports_model_switch: true,
      supports_effort_switch: true,
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
    await runOneTurn(host, "hi", client);
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
    await runOneTurn(host, "hi", client);
    expect(states[0]?.ext.session_capabilities).toMatchObject({
      supports_model_switch: true,
      supports_effort_switch: true,
    });
  });

  it("model 未報告 (account default 経路) でも intersection 非空なら supports_effort_switch=true (P23 dogfood 再回帰対策)", async () => {
    // Phase-23 dogfood 再回帰対策 (藤 修正版方針 3): account default で
    // this.#model=null かつ resume_snapshot に hint も無い場合 (前回セッションが
    // turn 未完了で snapshot 未 stamp) でも、catalog に共通 effort levels があれば
    // effort switch button を有効化する。旧挙動 (`catalog.find(null)=undefined`
    // で必ず false) が藤 dogfood 回帰の直接原因だった経路の pin。
    const states: Envelope[] = [];
    const { client } = makeClient([[usageEvent()]]);
    // CONFIG は chatgpt/plus (SOL+TERRA+LUNA)。config.model は undefined
    // (account default 委任) 、resumeSnapshot も undefined (fresh spawn 相当) 。
    const host = new CodexHost(CONFIG, {
      onState: (event) => states.push(event),
      appendSystemPrompt: "p",
      codexFactory: () => client,
      now: () => "T",
    });
    await runOneTurn(host, "hi", client);
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
      await runOneTurn(host, "hi", client);
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
      await runOneTurn(host, "hi", client);
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
      await runOneTurn(host, "hi", client);
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
      await runOneTurn(host, "hi", client);
      expect(calls.options[0]?.networkAccessEnabled).toBe(false);
      expect(host.statusSnapshot().network_access).toBe(false);
    });

    // Phase-22 dogfood audit (藤): sandbox=danger-full-access は network
    // が sandbox に内包されるため、素の toggle (未設定 = false) をそのまま
    // effective に出すと実効状態と矛盾する semantic mismatch になる (restore
    // relay が true を落とした直接証拠はなく、regression 断定ではない)。
    // #threadOptions は
    // 元々 workspace-write の時しか networkAccessEnabled を渡さない(実効
    // enforcement は不変)ので、この fix は表示/永続化のみを是正する。
    it("danger-full-access + network_access 省略は effective で true に正規化される", async () => {
      const { client, calls } = makeClient([
        [{ type: "thread.started", thread_id: "danger-legacy" }, usageEvent()],
      ]);
      const host = new CodexHost(
        { ...CONFIG, sandbox: "danger-full-access" },
        {
          onState: () => {},
          appendSystemPrompt: "p",
          codexFactory: () => client,
          now: () => "T",
        },
      );
      await runOneTurn(host, "hi", client);
      expect(calls.options[0]?.networkAccessEnabled).toBeUndefined();
      expect(host.statusSnapshot().network_access).toBe(true);
    });

    // Legacy 自己修復: サーバ DETS に永続化された誤った snapshot
    // ({sandbox: danger-full-access, network_access: false}) が resume_snapshot
    // としてそのまま乗ってきても、正規化された effective (=true) との差分が
    // resume_drift に一度出て、次の record_snapshot でサーバ側 DETS が
    // true に上書きされる (server/runner 側は無変更、wrapper 側の是正のみで
    // 自己修復する)。
    it("legacy snapshot (danger-full-access + network_access=false) は resume_drift で自己修復する", async () => {
      const states: Envelope[] = [];
      const { client } = makeClient([
        [{ type: "thread.started", thread_id: "danger-selfheal" }, usageEvent()],
      ]);
      const host = new CodexHost(
        { ...CONFIG, sandbox: "danger-full-access", network_access: false },
        {
          onState: (event) => states.push(event),
          appendSystemPrompt: "p",
          resumeSnapshot: {
            sandbox: "danger-full-access",
            network_access: false,
          },
          codexFactory: () => client,
          now: () => "T",
        },
      );
      await runOneTurn(host, "hi", client);
      const last = states.at(-1);
      expect(last?.ext.resume_drift).toEqual([
        { field: "network_access", prev: false, now: true },
      ]);
      expect(
        (last?.ext.effective as { network_access?: boolean } | undefined)
          ?.network_access,
      ).toBe(true);
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
      await runOneTurn(host, "hi", client);
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
      await runOneTurn(host, "hi", client);
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
      await runOneTurn(host, "hi", client);
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
      await runOneTurn(host, "hi", client);
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
      await runOneTurn(host, "hi", client);
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

      await runOneTurn(host, "hi", client);
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
      await runOneTurn(host, "hi", client);
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
      await runOneTurn(host, "hi", client);
      expect(states.some((e) => e.ext.effort_reset === true)).toBe(true);
      // effort は non-pin (source="default" gate)
      expect(calls.options[0]?.modelReasoningEffort).toBeUndefined();
    });
  });

  describe("rate_limits (rollout tail)", () => {
    it("resume host.run の fallback も初回 SDK turn 前に snapshot を取得する", async () => {
      const states: Envelope[] = [];
      const turnStarted = deferred<void>();
      const releaseTerminal = deferred<void>();
      const turnFinished = deferred<void>();
      const resolver = vi.fn(async () =>
        new Map<CodexRateLimitWindow, CodexRateLimitSnapshot>([
          ["seven_day", { utilization: 0.29, resets_at: 1787371202 }],
        ]),
      );
      const client: CodexClientLike = {
        startThread: () => {
          throw new Error("resume session must not start a new thread");
        },
        resumeThread: () => ({
          async runStreamed() {
            async function* events(): AsyncGenerator<ThreadEvent> {
              try {
                yield { type: "turn.started" };
                turnStarted.resolve();
                await releaseTerminal.promise;
                yield usageEvent();
              } finally {
                turnFinished.resolve();
              }
            }
            return { events: events() };
          },
        }),
      };
      const host = new CodexHost(CONFIG, {
        onState: (event) => states.push(event),
        appendSystemPrompt: "p",
        resumeSessionId: "uuid-resume-host-run",
        codexFactory: () => client,
        rateLimitResolver: resolver,
        now: () => "T",
      });

      const done = host.run("resume");
      try {
        await turnStarted.promise;

        expect(resolver).toHaveBeenCalledTimes(1);
        expect(resolver).toHaveBeenCalledWith("uuid-resume-host-run");
        expect(states[0]).toMatchObject({
          state: "idle",
          ext: {
            rate_limits: {
              seven_day: { utilization: 0.29, resets_at: 1787371202 },
            },
          },
        });
      } finally {
        releaseTerminal.resolve();
        await turnFinished.promise;
        host.close();
        await done;
      }
    });

    it("fresh thread.started でも terminal event 前に既存 snapshot を読む", async () => {
      const states: Envelope[] = [];
      const turnStarted = deferred<void>();
      const releaseTerminal = deferred<void>();
      const turnFinished = deferred<void>();
      const resolver = vi.fn(async () =>
        new Map<CodexRateLimitWindow, CodexRateLimitSnapshot>([
          ["seven_day", { utilization: 0.31, resets_at: 1787371201 }],
        ]),
      );
      const client: CodexClientLike = {
        startThread: () => ({
          async runStreamed() {
            async function* events(): AsyncGenerator<ThreadEvent> {
              try {
                yield { type: "thread.started", thread_id: "uuid-fresh-rate-limits" };
                yield { type: "turn.started" };
                // This defensive case covers a rollout that already has a
                // token_count at thread.started. Current observed rollouts
                // usually write it later, after session metadata; the terminal
                // refresh below remains the ordinary path for those sessions.
                turnStarted.resolve();
                await releaseTerminal.promise;
                yield usageEvent();
              } finally {
                turnFinished.resolve();
              }
            }
            return { events: events() };
          },
        }),
        resumeThread: () => {
          throw new Error("fresh session must not resume");
        },
      };
      const host = new CodexHost(CONFIG, {
        onState: (event) => states.push(event),
        appendSystemPrompt: "p",
        codexFactory: () => client,
        rateLimitResolver: resolver,
        now: () => "T",
      });

      const done = host.run("first");
      await turnStarted.promise;

      expect(resolver).toHaveBeenCalledTimes(1);
      expect(resolver).toHaveBeenCalledWith("uuid-fresh-rate-limits");
      expect(
        states.find((event) => event.ext.rate_limits !== undefined),
      ).toMatchObject({
        // turn.started has not been allowed to complete until this point;
        // this is the pre-turn state emitted by the initial lookup.
        state: "sending",
        ext: {
          rate_limits: {
            seven_day: { utilization: 0.31, resets_at: 1787371201 },
          },
        },
      });

      releaseTerminal.resolve();
      await turnFinished.promise;
      host.close();
      await done;
    });

    it("turn.completed 後の refresh で ext.rate_limits を stamp する", async () => {
      const states: Envelope[] = [];
      const rateLimitsStamped = deferred<void>();
      const { client } = makeClient([
        [
          { type: "thread.started", thread_id: "uuid-rl-a" },
          { type: "turn.started" },
          usageEvent(),
        ],
      ]);
      const snapshot: Map<CodexRateLimitWindow, CodexRateLimitSnapshot> =
        new Map([["five_hour", { utilization: 0.42, resets_at: 1785090000 }]]);
      const host = new CodexHost(CONFIG, {
        onState: (e) => {
          states.push(e);
          if (e.ext.rate_limits !== undefined) rateLimitsStamped.resolve();
        },
        appendSystemPrompt: "p",
        codexFactory: () => client,
        rateLimitResolver: async () => snapshot,
        now: () => "T",
      });

      await runOneTurn(host, "hi", client, rateLimitsStamped.promise);

      expect(states[0]?.ext).not.toHaveProperty("rate_limits");
      expect(states.at(-1)?.ext.rate_limits).toEqual({
        five_hour: { utilization: 0.42, resets_at: 1785090000 },
      });
    });

    // issue #254: 自分の rate limit を自分で観測できるようにする。list_agents
    // は呼び出し元を除外するので、ここが唯一の自己観測点になる。
    it("rollout snapshot が無い間は whoami から key ごと省略する", () => {
      const host = new CodexHost(CONFIG, {
        onState: () => {},
        appendSystemPrompt: "p",
      });
      expect(host.statusSnapshot()).not.toHaveProperty("rate_limits");
    });

    it("不完全な production rollout は parser から whoami まで absent=unknown に保つ", async () => {
      const root = await mkdtemp(join(tmpdir(), "kaoiro-codex-rl-empty-"));
      const sessionId = "uuid-rate-limit-window-only";
      await writeFile(
        join(root, `rollout-${sessionId}.jsonl`),
        `${JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            rate_limits: {
              // Actual rollout shape observed in production: the window can
              // arrive before either measurable field. A name alone is not
              // evidence of a usable limit snapshot.
              primary: { window_minutes: 300 },
              secondary: null,
            },
          },
        })}\n`,
      );
      const states: Envelope[] = [];
      const { client } = makeClient([
        [
          { type: "thread.started", thread_id: sessionId },
          { type: "turn.started" },
          usageEvent(),
        ],
      ]);
      const host = new CodexHost(CONFIG, {
        onState: (event) => states.push(event),
        appendSystemPrompt: "p",
        codexFactory: () => client,
        // Keep the filesystem source deterministic, but call the production
        // parser rather than hand-writing an empty Map in this fixture.
        rateLimitResolver: async (id) => codexRateLimitsFromRolloutIn(root, id),
        now: () => "T",
      });

      await runOneTurn(host, "hi", client);

      expect(host.statusSnapshot()).not.toHaveProperty("rate_limits");
      expect(states.every((event) => event.ext.rate_limits === undefined)).toBe(
        true,
      );
    });

    it("whoami の rate_limits は host が stamp する ext.rate_limits と同一値になる", async () => {
      // 「同形」ではなく「同値」を固定する。両者が別経路で組み立てられるように
      // なった瞬間に、自己観測と peer 観測が食い違っても誰も気づかなくなる。
      const states: Envelope[] = [];
      const rateLimitsStamped = deferred<void>();
      const { client } = makeClient([
        [
          { type: "thread.started", thread_id: "uuid-rl-whoami" },
          { type: "turn.started" },
          usageEvent(),
        ],
      ]);
      const snapshot: Map<CodexRateLimitWindow, CodexRateLimitSnapshot> =
        new Map([["seven_day", { utilization: 0.17, resets_at: 1787456530 }]]);
      const host = new CodexHost(CONFIG, {
        onState: (e) => {
          states.push(e);
          if (e.ext.rate_limits !== undefined) rateLimitsStamped.resolve();
        },
        appendSystemPrompt: "p",
        codexFactory: () => client,
        rateLimitResolver: async () => snapshot,
        now: () => "T",
      });

      await runOneTurn(host, "hi", client, rateLimitsStamped.promise);

      expect(host.statusSnapshot().rate_limits).toEqual(
        states.at(-1)?.ext.rate_limits,
      );
      expect(host.statusSnapshot()).toMatchObject({
        rate_limits: {
          seven_day: { utilization: 0.17, resets_at: 1787456530 },
        },
      });
    });

    it("初期取得済みと同値の terminal refresh は state_change を追加発火しない", async () => {
      const states: Envelope[] = [];
      const terminalRefreshStarted = deferred<void>();
      const terminalMapCompared = deferred<void>();
      const terminalRefreshResult = deferred<
        Map<CodexRateLimitWindow, CodexRateLimitSnapshot>
      >();
      const { client } = makeClient([
        [
          { type: "thread.started", thread_id: "uuid-rl-b" },
          { type: "turn.started" },
          usageEvent(),
        ],
      ]);
      const snapshot = new Map<CodexRateLimitWindow, CodexRateLimitSnapshot>([
        ["five_hour", { utilization: 0.1, resets_at: 1 }],
      ]);
      const sameSnapshot = new Map<CodexRateLimitWindow, CodexRateLimitSnapshot>(
        [["five_hour", { utilization: 0.1, resets_at: 1 }]],
      );
      const sameSnapshotIterator = sameSnapshot[Symbol.iterator].bind(sameSnapshot);
      sameSnapshot[Symbol.iterator] = function* (): Generator<
        [CodexRateLimitWindow, CodexRateLimitSnapshot],
        undefined,
        unknown
      > {
        try {
          yield* sameSnapshotIterator();
        } finally {
          // rateLimitsDiffer consumes this iterator only after it has checked
          // the two Maps' sizes; resolving here proves the no-op comparison
          // itself completed, rather than merely that its resolver returned.
          terminalMapCompared.resolve();
        }
        return undefined;
      };
      let resolverCalls = 0;
      const resolver = vi.fn<
        () => Promise<Map<CodexRateLimitWindow, CodexRateLimitSnapshot>>
      >(() => {
        resolverCalls += 1;
        if (resolverCalls === 1) return Promise.resolve(snapshot);
        if (resolverCalls === 2) {
          terminalRefreshStarted.resolve();
          return terminalRefreshResult.promise;
        }
        throw new Error("unexpected extra rate-limit refresh");
      });
      const host = new CodexHost(CONFIG, {
        onState: (e) => states.push(e),
        appendSystemPrompt: "p",
        codexFactory: () => client,
        rateLimitResolver: resolver,
        now: () => "T",
      });

      const done = host.run("hi");
      await client.waitForTurn(0);
      await terminalRefreshStarted.promise;
      const beforeNoopComparison = states.length;
      terminalRefreshResult.resolve(sameSnapshot);
      await terminalMapCompared.promise;
      expect(states).toHaveLength(beforeNoopComparison);
      host.close();
      await done;

      expect(resolver).toHaveBeenCalledTimes(2);
      expect(states.some((s) => s.ext.rate_limits !== undefined)).toBe(true);
    });

    it("turn.failed でも refresh が走る (429 / max-output で rate_limits が更新される経路)", async () => {
      const states: Envelope[] = [];
      const rateLimitsStamped = deferred<void>();
      const { client } = makeClient([
        [
          { type: "thread.started", thread_id: "uuid-rl-c" },
          { type: "turn.started" },
          { type: "turn.failed", error: { message: "rate_limit" } },
        ],
      ]);
      const resolver = vi.fn<
        () => Promise<Map<CodexRateLimitWindow, CodexRateLimitSnapshot>>
      >(async () =>
        new Map([["seven_day", { utilization: 0.98, resets_at: 999 }]]),
      );
      const host = new CodexHost(CONFIG, {
        onState: (e) => {
          states.push(e);
          if (e.ext.rate_limits !== undefined) rateLimitsStamped.resolve();
        },
        appendSystemPrompt: "p",
        codexFactory: () => client,
        rateLimitResolver: resolver,
        now: () => "T",
      });

      await runOneTurn(host, "hi", client, rateLimitsStamped.promise);

      expect(resolver).toHaveBeenCalledTimes(2);
      expect(states.at(-1)?.ext.rate_limits).toEqual({
        seven_day: { utilization: 0.98, resets_at: 999 },
      });
    });

    it("resolver が空 Map を返す間は ext.rate_limits を出さない", async () => {
      const states: Envelope[] = [];
      const emptyRefreshStarted = deferred<void>();
      const emptyMapCompared = deferred<void>();
      const emptyRefreshResult = deferred<
        Map<CodexRateLimitWindow, CodexRateLimitSnapshot>
      >();
      const { client } = makeClient([
        [
          { type: "thread.started", thread_id: "uuid-rl-d" },
          { type: "turn.started" },
          usageEvent(),
        ],
      ]);
      const initialEmptySnapshot = new Map<
        CodexRateLimitWindow,
        CodexRateLimitSnapshot
      >();
      const terminalEmptySnapshot = new Map<
        CodexRateLimitWindow,
        CodexRateLimitSnapshot
      >();
      Object.defineProperty(terminalEmptySnapshot, "size", {
        get() {
          // rateLimitsDiffer first compares the sizes; empty Maps have no
          // iterator entries, so this is the production no-op boundary.
          emptyMapCompared.resolve();
          return 0;
        },
      });
      let resolverCalls = 0;
      const host = new CodexHost(CONFIG, {
        onState: (e) => states.push(e),
        appendSystemPrompt: "p",
        codexFactory: () => client,
        rateLimitResolver: () => {
          resolverCalls += 1;
          if (resolverCalls === 1) {
            return Promise.resolve(initialEmptySnapshot);
          }
          if (resolverCalls === 2) {
            emptyRefreshStarted.resolve();
            return emptyRefreshResult.promise;
          }
          throw new Error("unexpected extra rate-limit refresh");
        },
        now: () => "T",
      });

      const done = host.run("hi");
      await client.waitForTurn(0);
      await emptyRefreshStarted.promise;
      const beforeNoopComparison = states.length;
      emptyRefreshResult.resolve(terminalEmptySnapshot);
      await emptyMapCompared.promise;
      expect(states).toHaveLength(beforeNoopComparison);
      host.close();
      await done;

      for (const s of states) {
        expect(s.ext).not.toHaveProperty("rate_limits");
      }
      expect(resolverCalls).toBe(2);
    });
  });

  describe("onTurnEnd (issue #131)", () => {
    it("turn.failed は onTurnEnd に conversationIds=[](未タグ) + error.detail を渡す", async () => {
      const turnEnds: {
        turnToken: string;
        conversationIds: readonly string[];
        error?: { reason?: string; detail?: string };
      }[] = [];
      const { client } = makeClient([
        [
          { type: "thread.started", thread_id: "uuid-err-1" },
          { type: "turn.started" },
          { type: "turn.failed", error: { message: "rate limited" } },
        ],
      ]);
      const host = new CodexHost(CONFIG, {
        onState: () => {},
        appendSystemPrompt: "p",
        codexFactory: () => client,
        onTurnEnd: (info) => turnEnds.push(info),
        now: () => "T",
      });

      await runOneTurn(host, "hi", client);

      expect(turnEnds).toHaveLength(1);
      expect(turnEnds[0]).toMatchObject({
        conversationIds: [],
        error: { detail: "rate limited" },
      });
      expect(turnEnds[0]?.turnToken).toEqual(expect.any(String));
    });

    it("成功 turn は onTurnEnd に conversationIds のみ(error無し)で渡す", async () => {
      const turnEnds: unknown[] = [];
      const { client } = makeClient([[usageEvent()]]);
      const host = new CodexHost(CONFIG, {
        onState: () => {},
        appendSystemPrompt: "p",
        codexFactory: () => client,
        onTurnEnd: (info) => turnEnds.push(info),
        now: () => "T",
      });

      await runOneTurn(host, "hi", client);

      expect(turnEnds).toHaveLength(1);
      expect(turnEnds[0]).toMatchObject({ conversationIds: [] });
      expect(turnEnds[0]).toHaveProperty("turnToken", expect.any(String));
    });

    it("terminal boundary hook は failed persistence より先に exact token を終える", async () => {
      const persistenceStarted = deferred<void>();
      const releasePersistence = deferred<void>();
      const boundaries: string[] = [];
      const persist = vi
        .spyOn(CodexTurnDiagnostics.prototype, "writeFailure")
        .mockImplementation(async () => {
          persistenceStarted.resolve();
          await releasePersistence.promise;
          return "/tmp/synthetic-codex-trace.jsonl";
        });
      const { client } = makeClient([[
        { type: "thread.started", thread_id: "boundary-before-persist" },
        { type: "turn.failed", error: { message: "persist-late" } },
      ]]);
      const host = new CodexHost(CONFIG, {
        onState: () => {},
        appendSystemPrompt: "p",
        codexFactory: () => client,
        onTurnBoundary: ({ turnToken }) => boundaries.push(turnToken),
        now: () => "T",
      });

      const running = host.run("hi");
      try {
        await persistenceStarted.promise;
        expect(boundaries).toHaveLength(1);
        releasePersistence.resolve();
        await client.waitForTurn(0);
      } finally {
        releasePersistence.resolve();
        host.close();
        await running;
        persist.mockRestore();
      }
    });

    it.each([
      {
        label: "completed→failed",
        events: [
          usageEvent(),
          { type: "turn.failed" as const, error: { message: "late failure" } },
        ],
        expectedError: undefined,
      },
      {
        label: "failed→completed",
        events: [
          { type: "turn.failed" as const, error: { message: "first failure" } },
          usageEvent(),
        ],
        expectedError: "first failure",
      },
    ])(
      "$label は最初の terminal だけを authoritative として onTurnEnd/result を一度だけ発火する",
      async ({ events, expectedError }) => {
        const turnEnds: {
          turnToken: string;
          conversationIds: readonly string[];
          error?: { reason?: string; detail?: string };
        }[] = [];
        const logs: Envelope[] = [];
        const { client } = makeClient([events]);
        const host = new CodexHost(CONFIG, {
          onState: () => {},
          onLog: (envelope) => logs.push(envelope),
          appendSystemPrompt: "p",
          codexFactory: () => client,
          onTurnEnd: (info) => turnEnds.push(info),
          now: () => "T",
        });

        await runOneTurn(host, "hi", client);

        expect(turnEnds).toHaveLength(1);
        if (expectedError === undefined) {
          expect(turnEnds[0]?.error).toBeUndefined();
        } else {
          expect(turnEnds[0]).toMatchObject({
            error: { detail: expectedError },
          });
        }
        const results = logs.filter((envelope) => envelope.type === "result");
        expect(results).toHaveLength(1);
        if (expectedError === undefined) {
          expect(results[0]?.payload).not.toMatchObject({ is_error: true });
        } else {
          expect(results[0]?.payload).toMatchObject({ is_error: true });
        }
      },
    );

    it("terminal event 後は通常の EOF と durability gate を待って次 turn を開始する", async () => {
      const firstEnded = deferred<void>();
      const releaseDurability = deferred<void>();
      const secondStarted = deferred<void>();
      const secondEnded = deferred<void>();
      const starts: string[] = [];
      const ends: string[] = [];
      let firstCleanupDone = false;
      let cleanupDoneBeforeSecondStart = false;
      let runCount = 0;
      const thread: CodexThreadLike = {
        async runStreamed() {
          const current = ++runCount;
          async function* events(): AsyncGenerator<ThreadEvent> {
            try {
              yield usageEvent();
              if (current === 1) await releaseDurability.promise;
            } finally {
              if (current === 1) firstCleanupDone = true;
            }
          }
          return { events: events() };
        },
      };
      const client: CodexClientLike = {
        startThread: () => thread,
        resumeThread: () => thread,
      };
      const host = new CodexHost(CONFIG, {
        onState: () => {},
        appendSystemPrompt: "p",
        codexFactory: () => client,
        onTurnStart: ({ turnToken }) => {
          starts.push(turnToken);
          if (turnToken === "turn-2") {
            cleanupDoneBeforeSecondStart = firstCleanupDone;
            secondStarted.resolve();
          }
        },
        onTurnEnd: ({ turnToken }) => {
          ends.push(turnToken);
          if (turnToken === "turn-1") firstEnded.resolve();
          if (turnToken === "turn-2") secondEnded.resolve();
        },
        now: () => "T",
      });
      const running = host.run();

      try {
        await host.send("first", undefined, ["cnv-1"], "turn-1");
        await firstEnded.promise;
        await host.send("second", undefined, ["cnv-2"], "turn-2");

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(starts).toEqual(["turn-1"]);
        releaseDurability.resolve();
        await secondStarted.promise;
        await secondEnded.promise;
      } finally {
        releaseDurability.resolve();
        host.close();
        await running;
      }

      expect(ends).toEqual(["turn-1", "turn-2"]);
      expect(cleanupDoneBeforeSecondStart).toBe(true);
    });

    it.each([
      {
        label: "turn.completed",
        terminal: usageEvent(),
        errorDetail: undefined,
      },
      {
        label: "turn.failed",
        terminal: { type: "turn.failed" as const, error: { message: "boom" } },
        errorDetail: "boom",
      },
    ])(
      "$label 後は bounded grace 超過時に cleanup 完了後の次 turn へ進み、terminal を一度だけ解決する",
      async ({ terminal, errorDetail }) => {
        const firstEnded = deferred<void>();
        const secondStarted = deferred<void>();
        const secondEnded = deferred<void>();
        const starts: string[] = [];
        let firstCleanupDone = false;
        let cleanupDoneBeforeSecondStart = false;
        const turnEnds: {
          turnToken: string;
          conversationIds: readonly string[];
          error?: { reason?: string; detail?: string };
        }[] = [];
        let runCount = 0;
        const thread: CodexThreadLike = {
          async runStreamed(_input, turnOptions) {
            const current = ++runCount;
            const signal = turnOptions?.signal;
            if (signal === undefined) throw new Error("probe requires abort signal");
            const abort = new Promise<void>((resolve) => {
              if (signal.aborted) {
                resolve();
                return;
              }
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
            async function* events(): AsyncGenerator<ThreadEvent> {
              try {
                yield terminal;
                if (current === 1) await abort;
              } finally {
                if (current === 1) firstCleanupDone = true;
              }
            }
            return { events: events() };
          },
        };
        const client: CodexClientLike = {
          startThread: () => thread,
          resumeThread: () => thread,
        };
        const host = new CodexHost(CONFIG, {
          onState: () => {},
          appendSystemPrompt: "p",
          codexFactory: () => client,
          terminalDrainGraceMs: 20,
          onTurnStart: ({ turnToken }) => {
            starts.push(turnToken);
            if (turnToken === "turn-2") {
              cleanupDoneBeforeSecondStart = firstCleanupDone;
              secondStarted.resolve();
            }
          },
          onTurnEnd: (info) => {
            turnEnds.push(info);
            if (info.turnToken === "turn-1") firstEnded.resolve();
            if (info.turnToken === "turn-2") secondEnded.resolve();
          },
          now: () => "T",
        });
        const running = host.run();

        try {
          await host.send("first", undefined, ["cnv-1"], "turn-1");
          await firstEnded.promise;
          await host.send("second", undefined, ["cnv-2"], "turn-2");
          await secondStarted.promise;
          await secondEnded.promise;
        } finally {
          host.close();
          await running;
        }

        expect(starts).toEqual(["turn-1", "turn-2"]);
        expect(cleanupDoneBeforeSecondStart).toBe(true);
        expect(turnEnds).toHaveLength(2);
        const firstEnds = turnEnds.filter(({ turnToken }) => turnToken === "turn-1");
        expect(firstEnds).toHaveLength(1);
        if (errorDetail === undefined) {
          expect(firstEnds[0]?.error).toBeUndefined();
        } else {
          expect(firstEnds[0]).toMatchObject({ error: { detail: errorDetail } });
        }
      },
    );

    it("timeout cleanup は pending settlement → iterator.return() → 次 turn の順序を守る", async () => {
      const firstEnded = deferred<void>();
      const returnCalled = deferred<void>();
      const secondStarted = deferred<void>();
      const secondEnded = deferred<void>();
      let returnCalledAfterPending = false;
      let returnCompleted = false;
      let returnCompletedBeforeSecondStart = false;
      let runCount = 0;
      let firstIteratorNextCalls = 0;
      let resolvePending: ((result: IteratorResult<ThreadEvent>) => void) | null = null;
      let pendingPromiseSettled = false;
      const firstIterator: AsyncIterator<ThreadEvent> & AsyncIterable<ThreadEvent> = {
        next() {
          firstIteratorNextCalls += 1;
          if (firstIteratorNextCalls === 1) {
            return Promise.resolve({ value: usageEvent(), done: false });
          }
          if (firstIteratorNextCalls > 2) {
            return Promise.resolve({ value: undefined, done: true });
          }
          const pending = new Promise<IteratorResult<ThreadEvent>>((resolve) => {
            resolvePending = resolve;
          });
          pending.then(() => {
            pendingPromiseSettled = true;
          });
          return pending;
        },
        return() {
          returnCalledAfterPending = pendingPromiseSettled;
          returnCalled.resolve();
          return new Promise<IteratorResult<ThreadEvent>>((resolve) => {
            setTimeout(() => {
              returnCompleted = true;
              resolve({ value: undefined, done: true });
            }, 20);
          });
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
      const thread: CodexThreadLike = {
        async runStreamed(_input, turnOptions) {
          const current = ++runCount;
          if (current === 1) {
            const signal = turnOptions?.signal;
            if (signal === undefined) throw new Error("probe requires abort signal");
            signal.addEventListener(
              "abort",
              () => {
                resolvePending?.({
                  value: { type: "error", message: "late" },
                  done: false,
                });
                resolvePending = null;
              },
              { once: true },
            );
            return { events: firstIterator };
          }
          async function* secondEvents(): AsyncGenerator<ThreadEvent> {
            yield usageEvent();
          }
          return { events: secondEvents() };
        },
      };
      const client: CodexClientLike = {
        startThread: () => thread,
        resumeThread: () => thread,
      };
      const host = new CodexHost(CONFIG, {
        onState: () => {},
        appendSystemPrompt: "p",
        codexFactory: () => client,
        terminalDrainGraceMs: 20,
        onTurnStart: ({ turnToken }) => {
          if (turnToken === "turn-2") {
            returnCompletedBeforeSecondStart = returnCompleted;
            secondStarted.resolve();
          }
        },
        onTurnEnd: ({ turnToken }) => {
          if (turnToken === "turn-1") firstEnded.resolve();
          if (turnToken === "turn-2") secondEnded.resolve();
        },
        now: () => "T",
      });
      const running = host.run();

      try {
        await host.send("first", undefined, ["cnv-1"], "turn-1");
        await firstEnded.promise;
        await host.send("second", undefined, ["cnv-2"], "turn-2");
        await returnCalled.promise;
        expect(returnCalledAfterPending).toBe(true);
        await secondStarted.promise;
        await secondEnded.promise;
      } finally {
        host.close();
        await running;
      }

      expect(returnCompleted).toBe(true);
      expect(returnCompletedBeforeSecondStart).toBe(true);
    });

    it("終端イベント無しでストリームが終わると detail 無しの error で onTurnEnd を呼ぶ", async () => {
      const turnEnds: unknown[] = [];
      const boundaries: string[] = [];
      const turnEnded = deferred<void>();
      const { client } = makeClient([
        [{ type: "thread.started", thread_id: "uuid-err-2" }],
      ]);
      const host = new CodexHost(CONFIG, {
        onState: () => {},
        appendSystemPrompt: "p",
        codexFactory: () => client,
        onTurnBoundary: ({ turnToken }) => boundaries.push(turnToken),
        onTurnEnd: (info) => {
          turnEnds.push(info);
          turnEnded.resolve();
        },
        now: () => "T",
      });

      await runOneTurn(host, "hi", client, turnEnded.promise);

      expect(turnEnds).toHaveLength(1);
      expect(boundaries).toEqual([(turnEnds[0] as { turnToken: string }).turnToken]);
      expect(turnEnds[0]).toMatchObject({ conversationIds: [], error: {} });
      expect(turnEnds[0]).toHaveProperty("turnToken", expect.any(String));
    });

    it("stream-level error は record-only で、後続 turn.completed を失敗扱いにしない", async () => {
      const turnEnds: unknown[] = [];
      const { client } = makeClient([[
        { type: "thread.started", thread_id: "uuid-record-only" },
        { type: "error", message: "bridge socket transient /private/path" },
        usageEvent(),
      ]]);
      const host = new CodexHost(CONFIG, {
        onState: () => {},
        appendSystemPrompt: "p",
        codexFactory: () => client,
        onTurnEnd: (info) => turnEnds.push(info),
        now: () => "T",
      });

      await runOneTurn(host, "hi", client);

      expect(turnEnds).toHaveLength(1);
      expect(turnEnds[0]).toMatchObject({ conversationIds: [] });
      expect(turnEnds[0]).not.toHaveProperty("error");
    });

    it("malformed item.completed のあと turn.completed が来れば成功のまま終え、peer error を作らない", async () => {
      const turnEnds: {
        conversationIds: readonly string[];
        error?: { detail?: string };
      }[] = [];
      const { client } = makeClient([[
        { type: "item.completed", item: null } as unknown as ThreadEvent,
        usageEvent(),
      ]]);
      const host = new CodexHost(CONFIG, {
        onState: () => {},
        appendSystemPrompt: "p",
        codexFactory: () => client,
        onTurnEnd: (info) => turnEnds.push(info),
        now: () => "T",
      });

      await runOneTurn(host, "inbound", client);

      expect(turnEnds).toHaveLength(1);
      expect(turnEnds[0]).toMatchObject({ conversationIds: [] });
      expect(turnEnds[0]).not.toHaveProperty("error");
    });

    it("failure trace の永続化失敗は SDK failure の onTurnEnd と host.run を置き換えない", async () => {
      const turnEnds: {
        conversationIds: readonly string[];
        error?: { detail?: string };
      }[] = [];
      const persist = vi
        .spyOn(CodexTurnDiagnostics.prototype, "writeFailure")
        .mockRejectedValueOnce(new Error("trace disk full"));
      const { client } = makeClient([new Error("Codex Exec exited with code 1")]);
      const host = new CodexHost(CONFIG, {
        onState: () => {},
        appendSystemPrompt: "p",
        codexFactory: () => client,
        onTurnEnd: (info) => turnEnds.push(info),
        now: () => "T",
      });

      await runOneTurn(host, "inbound", client);

      expect(persist).toHaveBeenCalledOnce();
      expect(turnEnds).toHaveLength(1);
      expect(turnEnds[0]).toMatchObject({
        conversationIds: [],
        error: { detail: "Error: Codex Exec exited with code 1" },
      });
    });

    it("host 起動時に agent の古い trace capture dir を20件までへ GC する", async () => {
      const traceDir = await mkdtemp(join(tmpdir(), "kaoiro-trace-gc-test-"));
      const captures = await Promise.all(
        Array.from({ length: 21 }, async (_, index) => {
          const capture = codexTurnTraceCaptureDir(
            traceDir,
            CONFIG.agent_id,
            `former-${String(index).padStart(2, "0")}`,
          );
          await mkdir(capture, { recursive: true });
          await utimes(capture, index + 1, index + 1);
          return capture;
        }),
      );
      const { client } = makeClient([[usageEvent()]]);
      const host = new CodexHost(CONFIG, {
        onState: () => {},
        appendSystemPrompt: "p",
        codexFactory: () => client,
        turnTraceDir: traceDir,
      });

      await runOneTurn(host, "gc", client);

      const agentDir = dirname(captures[0]!);
      const remaining = await readdir(agentDir);
      expect(remaining).toHaveLength(21); // 20 retained former captures + this host.
      expect(remaining).not.toContain("former-00");
    });

    it("診断 capture dir が壊れていても SDK turn は開始・完了する (fail-soft)", async () => {
      const { client } = makeClient([[usageEvent()]]);
      const host = new CodexHost(CONFIG, {
        onState: () => {},
        appendSystemPrompt: "p",
        codexFactory: () => client,
        turnTraceDir: "/dev/null/kaoiro-trace",
      });

      await runOneTurn(host, "hi", client);
      await client.waitForTurn(0);
    });

    it("壊れた診断 dir でも injection 無しの既定 Codex factory を構築して host.run を継続する", async () => {
      const host = new CodexHost(CONFIG, {
        onState: () => {},
        appendSystemPrompt: "p",
        turnTraceDir: "/dev/null/kaoiro-trace",
      });

      const running = host.run();
      // run() executes the default `new Codex(...)` before its first await.
      // Closing immediately keeps this composition test offline: no SDK turn
      // or child process is started, but an eager trace mkdir would reject.
      host.close();
      await expect(running).resolves.toBeUndefined();
    });

    it("終端なしの production host 経路は 0600 failure trace を一件だけ残す", async () => {
      const traceDir = await mkdtemp(join(tmpdir(), "kaoiro-host-trace-test-"));
      const { client } = makeClient([[
        { type: "thread.started", thread_id: "uuid-trace" },
        { type: "error", message: "bridge disconnected /private/path" },
      ]]);
      const host = new CodexHost(CONFIG, {
        onState: () => {},
        appendSystemPrompt: "p",
        codexFactory: () => client,
        turnTraceDir: traceDir,
        now: () => "T",
      });

      await host.send("coalesced inbound", undefined, ["cid-a", "cid-b"]);
      const done = host.run();
      await client.waitForTurn(0);
      host.close();
      await done;

      const agentDirs = await readdir(join(traceDir, "agents"));
      expect(agentDirs).toHaveLength(1);
      const captureDir = join(
        traceDir,
        "agents",
        agentDirs[0]!,
        (await readdir(join(traceDir, "agents", agentDirs[0]!)))[0]!,
      );
      const traces = (await readdir(captureDir)).filter((name) => name.endsWith(".jsonl"));
      expect(traces).toHaveLength(1);
      const tracePath = join(captureDir, traces[0]!);
      expect((await stat(tracePath)).mode & 0o777).toBe(0o600);
      const trace = JSON.parse(await readFile(tracePath, "utf8")) as {
        outcome: string;
        conversation_ids: string[];
        captured_at: string;
        stdout_jsonl_tail: Record<string, unknown>[];
        wrapper_classification: { message: string };
      };
      expect(trace.outcome).toBe("stream_ended_without_terminal");
      expect(trace.conversation_ids).toEqual(["cid-a", "cid-b"]);
      expect(trace.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(trace.stdout_jsonl_tail).toEqual([
        { type: "thread.started" },
        { type: "error", error_code: "api_error" },
      ]);
      expect(trace.wrapper_classification.message).toBe(
        "the peer reported an unspecified error",
      );
    });

    it("runStreamed の reject は err を detail 文字列化して onTurnEnd に渡す (must-fix 2: raw文字列は message に出ないことは classifyInterAgentError 側で保証)", async () => {
      const turnEnds: {
        turnToken: string;
        conversationIds: readonly string[];
        error?: { reason?: string; detail?: string };
      }[] = [];
      const boundaries: string[] = [];
      const turnEnded = deferred<void>();
      const { client } = makeClient([new Error("exec exited 1")]);
      const host = new CodexHost(CONFIG, {
        onState: () => {},
        appendSystemPrompt: "p",
        codexFactory: () => client,
        onTurnBoundary: ({ turnToken }) => boundaries.push(turnToken),
        onTurnEnd: (info) => {
          turnEnds.push(info);
          turnEnded.resolve();
        },
        now: () => "T",
      });

      await runOneTurn(host, "hi", client, turnEnded.promise);

      expect(turnEnds).toHaveLength(1);
      expect(boundaries).toEqual([turnEnds[0]!.turnToken]);
      expect(turnEnds[0]?.conversationIds).toEqual([]);
      expect(turnEnds[0]?.error?.detail).toContain("exec exited 1");
    });

    it("並存する複数 inter-agent injection は各ターンの conversationIds だけを解決する (must-fix 1)", async () => {
      const turnEnds: {
        turnToken: string;
        conversationIds: readonly string[];
        error?: { detail?: string };
      }[] = [];
      const { client } = makeClient([
        [
          { type: "thread.started", thread_id: "uuid-multi" },
          { type: "turn.started" },
          { type: "turn.failed", error: { message: "boom" } },
        ],
        [usageEvent()],
      ]);
      const host = new CodexHost(CONFIG, {
        onState: () => {},
        appendSystemPrompt: "p",
        codexFactory: () => client,
        onTurnEnd: (info) => turnEnds.push(info),
        now: () => "T",
      });

      // Queue turn 1's tag before run() starts (matches the file's existing
      // send()-before-run() pattern), let it settle, then queue turn 2's tag
      // — verifying the SECOND turn's outcome never gets attributed to the
      // FIRST (still-registered-as-pending only via notePendingInjection,
      // which this host-level test doesn't exercise) conversation_id.
      await host.send("peer A injection", undefined, ["cnv-a"]);
      const done = host.run();
      await client.waitForTurn(0);
      await host.send("peer B injection", undefined, ["cnv-b"]);
      await client.waitForTurn(1);
      host.close();
      await done;

      expect(turnEnds).toHaveLength(2);
      expect(turnEnds[0]).toMatchObject({
        conversationIds: ["cnv-a"],
        error: { detail: "boom" },
      });
      expect(turnEnds[1]).toMatchObject({ conversationIds: ["cnv-b"] });
      expect(turnEnds.every((info) => typeof info.turnToken === "string")).toBe(true);
    });

    it("1回の send() に複数 cid を渡すと1ターンとして onTurnEnd に全件まとめて渡す (issue #221 段階3, 合流turn)", async () => {
      const turnEnds: { turnToken: string; conversationIds: readonly string[] }[] = [];
      const { client } = makeClient([[usageEvent()]]);
      const host = new CodexHost(CONFIG, {
        onState: () => {},
        appendSystemPrompt: "p",
        codexFactory: () => client,
        onTurnEnd: (info) => turnEnds.push(info),
        now: () => "T",
      });

      // runOneTurn() drives host.run(prompt) — the initial-prompt path,
      // which pushes straight onto #queue without going through send()'s
      // conversationIds tagging. Reproduce the "並存する複数..." test's own
      // pattern instead: tag via send() before run().
      await host.send("coalesced batch text", undefined, [
        "cnv-p",
        "cnv-q",
        "cnv-r",
      ]);
      const done = host.run();
      await client.waitForTurn(0);
      host.close();
      await done;

      expect(turnEnds).toHaveLength(1);
      expect(turnEnds[0]).toMatchObject({
        conversationIds: ["cnv-p", "cnv-q", "cnv-r"],
      });
      expect(turnEnds[0]).toHaveProperty("turnToken", expect.any(String));
    });
  });
});

describe("issue #262: rollout 破損の安全な自動修復", () => {
  // "あ" (U+3042、UTF-8 で E3 81 82 の3バイト) の最終バイトを欠いたまま
  // 行が終わる — issue #263 の実インシデントと同じ壊れ方 (ENOSPC が
  // マルチバイト文字の書き込み途中でディスクを使い切った形)。
  const UTF8_TRUNCATED_TAIL = Buffer.concat([
    Buffer.from(
      '{"type":"event_msg","payload":{"type":"agent_message","message":"',
      "utf8",
    ),
    Buffer.from([0xe3, 0x81]),
  ]);

  function corruptedRolloutContent(): Buffer {
    const validLine = JSON.stringify({ type: "turn_context", payload: {} });
    return Buffer.concat([
      Buffer.from(`${validLine}\n`, "utf8"),
      UTF8_TRUNCATED_TAIL,
    ]);
  }

  function cleanRolloutContent(): Buffer {
    return Buffer.from(
      `${JSON.stringify({ type: "turn_context", payload: {} })}\n`,
      "utf8",
    );
  }

  async function writeFixtureRollout(
    root: string,
    sessionId: string,
    content: Buffer,
  ): Promise<void> {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, `rollout-${sessionId}.jsonl`), content);
  }

  it("candidate 文言 + 実 rollout 破損の一致で backup・修復・全行 verify を経て同じ入力の resume を回復する", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaoiro-codex-corrupt-e2e-"));
    const sessionId = "corrupt-session-e2e";
    await writeFixtureRollout(root, sessionId, corruptedRolloutContent());

    const logs: Envelope[] = [];
    const turnEnds: unknown[] = [];
    const turnStarts: unknown[] = [];
    const turnSettled = [deferred<void>(), deferred<void>()];
    const { client, calls } = makeClient([
      [{ type: "thread.started", thread_id: sessionId }, usageEvent()],
      new Error(
        "Codex Exec exited with code 1: stream did not contain valid UTF-8 (code -32603)",
      ),
      [usageEvent()],
    ]);
    const host = new CodexHost(CONFIG, {
      onState: () => {},
      onLog: (e) => logs.push(e),
      appendSystemPrompt: "p",
      codexFactory: () => client,
      // 本物の verifyRolloutCorruption を fixture root へ向けるだけ — 検証
      // ロジック自体はモックしない (MF-2 の貫通要件)。
      rolloutCorruptionVerifier: (id) => verifyRolloutCorruption(id, root),
      rolloutCorruptionRepairer: (id) => repairRolloutCorruption(id, root),
      onTurnStart: (info) => turnStarts.push(info),
      onTurnEnd: (info) => {
        turnEnds.push(info);
        turnSettled[turnEnds.length - 1]?.resolve();
      },
      now: () => "T",
    });

    const done = host.run("hi");
    await turnSettled[0]!.promise;
    await host.send("continue 1");
    await turnSettled[1]!.promise;
    host.close();
    await done;

    expect(calls.resume).toEqual([null, sessionId, sessionId]);
    expect(calls.inputs).toEqual(["hi", "continue 1", "continue 1"]);
    expect(turnStarts).toHaveLength(2);

    const results = logs.filter((e) => e.type === "result");
    expect(results).toHaveLength(2);
    expect(results[0]?.payload).not.toMatchObject({ is_error: true });
    expect(results[1]?.payload).not.toMatchObject({ is_error: true });
    expect(verifyRolloutCorruption(sessionId, root)).toBe("clean");

    await rm(root, { recursive: true, force: true });
  });

  it("0 有効行の repair は原本を置換せず error_rollout_corrupted を返して手動 fallback する", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaoiro-codex-corrupt-empty-e2e-"));
    const sessionId = "corrupt-empty-session-e2e";
    const path = join(root, `rollout-${sessionId}.jsonl`);
    const original = Buffer.from(" \n\t\n", "utf8");
    await writeFixtureRollout(root, sessionId, original);

    const logs: Envelope[] = [];
    const turnEnds: unknown[] = [];
    const turnSettled = [deferred<void>(), deferred<void>(), deferred<void>()];
    const { client, calls } = makeClient([
      [{ type: "thread.started", thread_id: sessionId }, usageEvent()],
      new Error("stream did not contain valid UTF-8 (code -32603)"),
      [usageEvent()],
    ]);
    const host = new CodexHost(CONFIG, {
      onState: () => {},
      onLog: (e) => logs.push(e),
      appendSystemPrompt: "p",
      codexFactory: () => client,
      rolloutCorruptionVerifier: (id) => verifyRolloutCorruption(id, root),
      rolloutCorruptionRepairer: (id) => repairRolloutCorruption(id, root),
      onTurnEnd: (info) => {
        turnEnds.push(info);
        turnSettled[turnEnds.length - 1]?.resolve();
      },
      now: () => "T",
    });

    const done = host.run("hi");
    await turnSettled[0]!.promise;
    await host.send("continue 1");
    await turnSettled[1]!.promise;
    await host.send("continue 2");
    await turnSettled[2]!.promise;
    host.close();
    await done;

    await expect(readFile(path)).resolves.toEqual(original);
    expect(calls.resume).toEqual([null, sessionId]);
    const results = logs.filter((e) => e.type === "result");
    expect(results[1]?.payload).toMatchObject({
      is_error: true,
      error_subtype: "error_rollout_corrupted",
      error_detail: "Error: stream did not contain valid UTF-8 (code -32603)",
    });
    expect(results[2]?.payload).toMatchObject({
      is_error: true,
      error_subtype: "error_rollout_corrupted",
      error_detail: "Error: stream did not contain valid UTF-8 (code -32603)",
    });

    await rm(root, { recursive: true, force: true });
  });

  it("修復後 retry の同期 throw でも onTurnEnd を一度だけ発火し、backup を stderr に出す", async () => {
    const sessionId = "repair-retry-throws";
    const turnEnds: {
      conversationIds: readonly string[];
      error?: { detail?: string };
    }[] = [];
    const turnSettled = [deferred<void>(), deferred<void>()];
    const { client, calls } = makeClient([
      [{ type: "thread.started", thread_id: sessionId }, usageEvent()],
      new Error("stream did not contain valid UTF-8 (code -32603)"),
    ]);
    const resumeThread = client.resumeThread.bind(client);
    let resumeAttempts = 0;
    client.resumeThread = ((id, options) => {
      resumeAttempts += 1;
      if (id === sessionId && resumeAttempts === 2) {
        throw new Error("retry resume construction failed");
      }
      return resumeThread(id, options);
    }) as typeof client.resumeThread;
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const host = new CodexHost(CONFIG, {
        onState: () => {},
        appendSystemPrompt: "p",
        codexFactory: () => client,
        rolloutCorruptionVerifier: () => "corrupted",
        rolloutCorruptionRepairer: () => ({
          repaired: true,
          backupPath: "/tmp/rollout-repair.bak",
        }),
        onTurnEnd: (info) => {
          turnEnds.push(info);
          turnSettled[turnEnds.length - 1]?.resolve();
        },
        now: () => "T",
      });

      const done = host.run("hi");
      await turnSettled[0]!.promise;
      await host.send("continue", undefined, ["cnv-repair"]);
      await turnSettled[1]!.promise;
      host.close();
      await done;

      expect(calls.resume).toEqual([null, sessionId]);
      expect(resumeAttempts).toBe(2);
      expect(turnEnds).toEqual([
        expect.objectContaining({ conversationIds: [] }),
        expect.objectContaining({
          conversationIds: ["cnv-repair"],
          error: { detail: "Error: retry resume construction failed" },
        }),
      ]);
      expect(stderr).toHaveBeenCalledWith(
        `codex rollout repaired for session ${sessionId}; backup: /tmp/rollout-repair.bak\n`,
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it("修復成功の stderr 診断が throw しても retry を続けて通常成功する", async () => {
    const sessionId = "repair-stderr-throws";
    const logs: Envelope[] = [];
    const turnSettled = [deferred<void>(), deferred<void>()];
    let resultCount = 0;
    const { client, calls } = makeClient([
      [{ type: "thread.started", thread_id: sessionId }, usageEvent()],
      new Error("stream did not contain valid UTF-8 (code -32603)"),
      [usageEvent()],
    ]);
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((message) => {
        if (String(message).startsWith("codex rollout repaired")) {
          throw new Error("broken stderr");
        }
        return true;
      });
    try {
      const host = new CodexHost(CONFIG, {
        onState: () => {},
        onLog: (entry) => {
          logs.push(entry);
          if (entry.type === "result") resultCount += 1;
        },
        appendSystemPrompt: "p",
        codexFactory: () => client,
        rolloutCorruptionVerifier: () => "corrupted",
        rolloutCorruptionRepairer: () => ({
          repaired: true,
          backupPath: "/tmp/rollout-repair.bak",
        }),
        onTurnEnd: () => {
          turnSettled[resultCount - 1]?.resolve();
        },
        now: () => "T",
      });

      const done = host.run("hi");
      await turnSettled[0]!.promise;
      await host.send("continue");
      await turnSettled[1]!.promise;
      host.close();
      await done;

      expect(calls.resume).toEqual([null, sessionId, sessionId]);
      const results = logs.filter((entry) => entry.type === "result");
      expect(results).toHaveLength(2);
      expect(results[1]?.payload).not.toMatchObject({ is_error: true });
    } finally {
      stderr.mockRestore();
    }
  });

  it("修復 retry の終結 callback が throw しても元 turn の result と peer 通知を重ねない", async () => {
    const sessionId = "repair-settle-callback-throws";
    const logs: Envelope[] = [];
    const turnEnds: unknown[] = [];
    const firstTurnSettled = deferred<void>();
    const { client, calls } = makeClient([
      [{ type: "thread.started", thread_id: sessionId }, usageEvent()],
      new Error("stream did not contain valid UTF-8 (code -32603)"),
      new Error("retry stream connection failed"),
    ]);
    const host = new CodexHost(CONFIG, {
      onState: () => {},
      onLog: (entry) => logs.push(entry),
      appendSystemPrompt: "p",
      codexFactory: () => client,
      rolloutCorruptionVerifier: () => "corrupted",
      rolloutCorruptionRepairer: () => ({
        repaired: true,
        backupPath: "/tmp/rollout-repair.bak",
      }),
      onTurnEnd: (info) => {
        turnEnds.push(info);
        if (turnEnds.length === 1) firstTurnSettled.resolve();
        if (turnEnds.length === 2) throw new Error("peer callback failed");
      },
      now: () => "T",
    });

    const done = host.run("hi");
    await firstTurnSettled.promise;
    await host.send("continue", undefined, ["cnv-settle"]);
    await client.waitForTurn(2);
    host.close();
    await done;

    expect(calls.resume).toEqual([null, sessionId, sessionId]);
    expect(turnEnds).toHaveLength(2);
    expect(turnEnds[1]).toEqual(
      expect.objectContaining({ conversationIds: ["cnv-settle"] }),
    );
    expect(logs.filter((entry) => entry.type === "result")).toHaveLength(2);
  });

  it("rollout verifier の throw は通常失敗へ fallback して turn を完結する", async () => {
    const sessionId = "repair-verifier-throws";
    const logs: Envelope[] = [];
    const turnEnds: {
      conversationIds: readonly string[];
      error?: { detail?: string };
    }[] = [];
    const turnSettled = [deferred<void>(), deferred<void>()];
    const { client, calls } = makeClient([
      [{ type: "thread.started", thread_id: sessionId }, usageEvent()],
      new Error("stream did not contain valid UTF-8 (code -32603)"),
    ]);
    const host = new CodexHost(CONFIG, {
      onState: () => {},
      onLog: (entry) => logs.push(entry),
      appendSystemPrompt: "p",
      codexFactory: () => client,
      rolloutCorruptionVerifier: () => {
        throw new Error("rollout inspection unavailable");
      },
      onTurnEnd: (info) => {
        turnEnds.push(info);
        turnSettled[turnEnds.length - 1]?.resolve();
      },
      now: () => "T",
    });

    const done = host.run("hi");
    await turnSettled[0]!.promise;
    await host.send("continue", undefined, ["cnv-verifier"]);
    await turnSettled[1]!.promise;
    host.close();
    await done;

    expect(calls.resume).toEqual([null, sessionId]);
    expect(turnEnds).toEqual([
      expect.objectContaining({ conversationIds: [] }),
      expect.objectContaining({
        conversationIds: ["cnv-verifier"],
        error: {
          detail: "Error: stream did not contain valid UTF-8 (code -32603)",
        },
      }),
    ]);
    const results = logs.filter((entry) => entry.type === "result");
    expect(results[1]?.payload).toMatchObject({ is_error: true });
    expect(
      (results[1]?.payload as { error_subtype?: string }).error_subtype,
    ).toBeUndefined();
  });

  it("candidate 文言にマッチしても rollout ファイルが正常なら恒久分類しない (negative control: 他依存関係の同文 stderr による false positive を防ぐ)", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaoiro-codex-clean-e2e-"));
    const sessionId = "clean-session-e2e";
    await writeFixtureRollout(root, sessionId, cleanRolloutContent());

    const logs: Envelope[] = [];
    const turnEnds: unknown[] = [];
    const turnSettled = [deferred<void>(), deferred<void>(), deferred<void>()];
    const { client, calls } = makeClient([
      [{ type: "thread.started", thread_id: sessionId }, usageEvent()],
      // candidate 文言にマッチするが、実際の rollout は無事 — 別の
      // 依存関係が同じ汎用文言を吐いた偽陽性シナリオ (ふじ MF-1 の核心)。
      new Error("stream did not contain valid UTF-8 (code -32603)"),
      [usageEvent()],
    ]);
    const host = new CodexHost(CONFIG, {
      onState: () => {},
      onLog: (e) => logs.push(e),
      appendSystemPrompt: "p",
      codexFactory: () => client,
      rolloutCorruptionVerifier: (id) => verifyRolloutCorruption(id, root),
      onTurnEnd: (info) => {
        turnEnds.push(info);
        turnSettled[turnEnds.length - 1]?.resolve();
      },
      now: () => "T",
    });

    const done = host.run("hi");
    await turnSettled[0]!.promise;
    await host.send("continue 1");
    await turnSettled[1]!.promise;
    await host.send("continue 2");
    await turnSettled[2]!.promise;
    host.close();
    await done;

    // rollout は無事なので、candidate 文言だけでは恒久分類されず、
    // turn 3 でも resumeThread が再試行される。
    expect(calls.resume).toEqual([null, sessionId, sessionId]);

    const results = logs.filter((e) => e.type === "result");
    expect(results[1]?.payload).toMatchObject({ is_error: true });
    expect(
      (results[1]!.payload as { error_subtype?: string }).error_subtype,
    ).toBeUndefined();

    await rm(root, { recursive: true, force: true });
  });

  it("candidate 文言にマッチしても対応する rollout が見つからなければ恒久分類しない (negative control: lookup 不能は unknown 扱い)", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaoiro-codex-nolookup-e2e-"));
    // root ディレクトリは作るが、このセッション用の rollout ファイルは
    // 一切置かない — verifyRolloutCorruption が "unknown" を返す経路。
    const sessionId = "no-rollout-session-e2e";

    const logs: Envelope[] = [];
    const turnEnds: unknown[] = [];
    const turnSettled = [deferred<void>(), deferred<void>(), deferred<void>()];
    const { client, calls } = makeClient([
      [{ type: "thread.started", thread_id: sessionId }, usageEvent()],
      new Error("stream did not contain valid UTF-8 (code -32603)"),
      [usageEvent()],
    ]);
    const host = new CodexHost(CONFIG, {
      onState: () => {},
      onLog: (e) => logs.push(e),
      appendSystemPrompt: "p",
      codexFactory: () => client,
      rolloutCorruptionVerifier: (id) => verifyRolloutCorruption(id, root),
      onTurnEnd: (info) => {
        turnEnds.push(info);
        turnSettled[turnEnds.length - 1]?.resolve();
      },
      now: () => "T",
    });

    const done = host.run("hi");
    await turnSettled[0]!.promise;
    await host.send("continue 1");
    await turnSettled[1]!.promise;
    await host.send("continue 2");
    await turnSettled[2]!.promise;
    host.close();
    await done;

    expect(calls.resume).toEqual([null, sessionId, sessionId]);
    const results = logs.filter((e) => e.type === "result");
    expect(
      (results[1]!.payload as { error_subtype?: string }).error_subtype,
    ).toBeUndefined();

    await rm(root, { recursive: true, force: true });
  });

  it("fresh startThread の mid-stream 失敗は candidate 文言・実破損 rollout があっても恒久分類しない (必須pin: resume failure に限定)", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaoiro-codex-fresh-e2e-"));
    const sessionId = "fresh-session-e2e";
    // わざと「本当に破損している」rollout を置いても、fresh start の
    // 失敗には適用されないことを確認する — このセッションはまだ resume
    // 対象ではなく、その rollout が壊れていることに意味がない。
    await writeFixtureRollout(root, sessionId, corruptedRolloutContent());

    const freshMidStreamClient: CodexClientLike = {
      startThread: () => ({
        async runStreamed() {
          async function* gen(): AsyncGenerator<ThreadEvent> {
            // thread_id イベントで #sessionId が確立された「後」に
            // ストリームが中断する — ふじが指摘した mid-stream 失敗。
            yield { type: "thread.started", thread_id: sessionId };
            throw new Error(
              "stream did not contain valid UTF-8 (code -32603)",
            );
          }
          return { events: gen() };
        },
      }),
      resumeThread: () => {
        throw new Error("fresh session must not resume");
      },
    };

    const logs: Envelope[] = [];
    const turnEnds: unknown[] = [];
    const turnEnded = deferred<void>();
    const host = new CodexHost(CONFIG, {
      onState: () => {},
      onLog: (e) => logs.push(e),
      appendSystemPrompt: "p",
      codexFactory: () => freshMidStreamClient,
      rolloutCorruptionVerifier: (id) => verifyRolloutCorruption(id, root),
      onTurnEnd: (info) => {
        turnEnds.push(info);
        turnEnded.resolve();
      },
      now: () => "T",
    });

    const done = host.run("hi");
    await turnEnded.promise;
    host.close();
    await done;

    const results = logs.filter((e) => e.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0]?.payload).toMatchObject({ is_error: true });
    expect(
      (results[0]!.payload as { error_subtype?: string }).error_subtype,
    ).toBeUndefined();

    await rm(root, { recursive: true, force: true });
  });

  it("未知の resume 失敗は従来どおり分類せず、次のターンでも resumeThread を再試行する (fall back、rollout 検査自体が走らない)", async () => {
    const logs: Envelope[] = [];
    const turnEnds: unknown[] = [];
    const turnSettled = [deferred<void>(), deferred<void>(), deferred<void>()];
    const { client, calls } = makeClient([
      [
        { type: "thread.started", thread_id: "unknown-fail-session" },
        usageEvent(),
      ],
      new Error("network timeout"),
      [usageEvent()],
    ]);
    const host = new CodexHost(CONFIG, {
      onState: () => {},
      onLog: (e) => logs.push(e),
      appendSystemPrompt: "p",
      codexFactory: () => client,
      onTurnEnd: (info) => {
        turnEnds.push(info);
        turnSettled[turnEnds.length - 1]?.resolve();
      },
      now: () => "T",
    });

    const done = host.run("hi");
    await turnSettled[0]!.promise;
    await host.send("continue 1");
    await turnSettled[1]!.promise;
    await host.send("continue 2");
    await turnSettled[2]!.promise;
    host.close();
    await done;

    // 未知のエラーでは resumeThread を毎ターン再試行する — issue #263
    // 導入前と変わらない従来挙動 (未知の失敗は分類せず fall back)。
    expect(calls.resume).toEqual([
      null,
      "unknown-fail-session",
      "unknown-fail-session",
    ]);

    const results = logs.filter((e) => e.type === "result");
    expect(results).toHaveLength(3);
    expect(results[1]?.payload).toMatchObject({ is_error: true });
    expect(
      (results[1]!.payload as { error_subtype?: string }).error_subtype,
    ).toBeUndefined();
    // turn 3 は resume が再試行され、正常完了する。
    expect(results[2]?.payload).not.toMatchObject({ is_error: true });
  });
});
