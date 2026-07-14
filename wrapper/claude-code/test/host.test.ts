import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { AgentHost, initialStatusExt } from "../src/host.js";
import type { AgentHostOptions } from "../src/host.js";
import { makeStateChange } from "@kaoiro/agent-common";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import {
  PENDING_UPLOAD_TTL_MS,
  SharpImageDownsizer,
  setDefaultImageDownsizer,
} from "../src/upload.js";
import { buildChunkPayload } from "./helpers.js";

const config: WrapperConfig = {
  agent_id: "test.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  server_url: "ws://localhost:4000/wrapper",
};

describe("initialStatusExt", () => {
  it("initial idle に engine と capabilities を stamp する (#107)", () => {
    const initial = makeStateChange(
      config,
      "idle",
      "T",
      {},
      initialStatusExt(),
    );
    expect(initial.ext).toMatchObject({
      engine: "claude-code",
      session_capabilities: {
        supports_attachments: true,
        supports_user_input_dialog: true,
        supports_model_switch: true,
        supports_effort_switch: true,
        supports_session_reset: true,
        session_reset_modes: ["new", "clear"],
      },
    });
    expect(
      (initial.ext.models as { value: string }[]).map((m) => m.value),
    ).toEqual([
      "default",
      "opus[1m]",
      "claude-fable-5[1m]",
      "sonnet",
      "sonnet[1m]",
      "haiku",
      "claude-opus-4-7",
    ]);
  });
});

describe("AgentHost whoami effective projection (#113)", () => {
  it("model/effort/source と engine-neutral permission を同じ snapshot から返す", () => {
    const host = new AgentHost(
      { ...config, permission_mode: "plan" },
      {
        onState: () => {},
        queryOptions: { model: "claude-opus-4-7", effort: "high" },
        modelSource: "config",
        effortSource: "config",
      },
    );

    expect(host.statusSnapshot()).toMatchObject({
      engine: "claude-code",
      model: "claude-opus-4-7",
      model_source: "config",
      effort: "high",
      effort_source: "config",
      permission_mode: "plan",
      permission: { sandbox: "read-only", approval: "on-request" },
    });
    expect(host.statusSnapshot()).not.toHaveProperty("network_access");
  });
});

// The host reads only a few SDK fields; build minimal shapes and cast.
const msg = (shape: unknown): SDKMessage => shape as SDKMessage;
const system = (): SDKMessage => msg({ type: "system", subtype: "init" });
const assistant = (content: unknown): SDKMessage =>
  msg({ type: "assistant", message: { content } });
const user = (content: unknown): SDKMessage =>
  msg({ type: "user", message: { content } });
const result = (
  subtype: string,
  extra: Record<string, unknown> = {},
): SDKMessage => msg({ type: "result", subtype, ...extra });

type QueryFn = NonNullable<AgentHostOptions["queryFn"]>;
type QueryArgs = { prompt: AsyncIterable<SDKUserMessage>; options: Options };

/** Wraps an async generator into a Query. interrupt / getContextUsage are the
 *  control methods most tests exercise; `extra` injects the rest (setModel,
 *  applyFlagSettings, supportedModels — #54). */
function asQuery(
  gen: AsyncGenerator<SDKMessage, void>,
  interrupt: () => Promise<void> = async () => {},
  getContextUsage?: () => Promise<unknown>,
  extra?: Record<string, unknown>,
): Query {
  const controls: Record<string, unknown> = { interrupt, ...extra };
  if (getContextUsage) controls.getContextUsage = getContextUsage;
  return Object.assign(gen, controls) as unknown as Query;
}

/** Wraps a per-test query implementation as a QueryFn — the one cast site
 *  (the local QueryArgs shape does not exactly match the SDK signature). */
function makeQueryFn(fn: (args: QueryArgs) => Query): QueryFn {
  return fn as unknown as QueryFn;
}

/** queryFn that yields a fixed message list, ignoring the input prompt. */
function scriptedQuery(messages: SDKMessage[]): QueryFn {
  return makeQueryFn(() => {
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      for (const m of messages) yield m;
    }
    return asQuery(gen());
  });
}

describe("AgentHost — query injection", () => {
  it("onState で1ターンの状態遷移を辿る", async () => {
    const states: string[] = [];
    const host = new AgentHost(config, {
      onState: (e) => states.push(e.state),
      queryFn: scriptedQuery([
        system(),
        assistant([{ type: "text", text: "hi" }]),
        assistant([{ type: "tool_use", id: "tu_1", name: "Read", input: {} }]),
        user([{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }]),
        result("success", { result: "done" }),
      ]),
      now: () => "T",
    });
    await host.run();
    expect(states).toEqual([
      "idle",
      "thinking",
      "tool_running",
      "thinking",
      "done",
      "waiting_input",
    ]);
  });

  it("onLog で tool_use_id (#40) と ext.cost (#8) を中継する", async () => {
    const logs: Envelope[] = [];
    const host = new AgentHost(config, {
      onState: () => {},
      onLog: (e) => logs.push(e),
      queryFn: scriptedQuery([
        assistant([
          { type: "tool_use", id: "tu_1", name: "Read", input: { path: "a" } },
        ]),
        user([{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }]),
        result("success", { result: "done!", total_cost_usd: 0.0123 }),
      ]),
      now: () => "T",
    });
    await host.run();

    const toolUse = logs.find((l) => l.payload.kind === "tool_use");
    expect(toolUse?.payload).toMatchObject({
      kind: "tool_use",
      tool_name: "Read",
      tool_use_id: "tu_1",
      input: { path: "a" },
    });

    // tool_name is backfilled from the tool_use map, keyed by tool_use_id.
    const toolResult = logs.find((l) => l.payload.kind === "tool_result");
    expect(toolResult?.payload).toMatchObject({
      kind: "tool_result",
      tool_name: "Read",
      tool_use_id: "tu_1",
      output: "ok",
    });

    const res = logs.find((l) => l.type === "result");
    expect(res?.ext).toEqual({ cost: 0.0123 });
    expect(res?.payload).toMatchObject({ text: "done!" });
  });

  it("コスト不明の result は ext.cost を付けない", async () => {
    const logs: Envelope[] = [];
    const host = new AgentHost(config, {
      onState: () => {},
      onLog: (e) => logs.push(e),
      queryFn: scriptedQuery([result("success", { result: "x" })]),
      now: () => "T",
    });
    await host.run();
    const res = logs.find((l) => l.type === "result");
    expect(res?.ext).toEqual({});
  });

  it("rate_limit_event を ext.rate_limits として state_change に付与する (#16)", async () => {
    const envs: Envelope[] = [];
    const host = new AgentHost(config, {
      onState: (e) => envs.push(e),
      queryFn: scriptedQuery([
        msg({
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed",
            rateLimitType: "five_hour",
            utilization: 0.5,
            resetsAt: 1781480000,
          },
        }),
        assistant([{ type: "text", text: "hi" }]),
      ]),
      now: () => "T",
    });
    await host.run();
    // rate_limit_event yields no state; the next state_change carries the ext.
    const thinking = envs.find((e) => e.state === "thinking");
    expect(thinking?.ext).toMatchObject({
      rate_limits: {
        five_hour: {
          status: "allowed",
          utilization: 0.5,
          resets_at: 1781480000,
        },
      },
    });
  });

  it("init メッセージから ext.model / ext.cwd を付与する (#16)", async () => {
    const envs: Envelope[] = [];
    const host = new AgentHost(config, {
      onState: (e) => envs.push(e),
      queryFn: scriptedQuery([
        msg({
          type: "system",
          subtype: "init",
          model: "claude-x",
          cwd: "/repo",
        }),
        assistant([{ type: "text", text: "hi" }]),
      ]),
      now: () => "T",
    });
    await host.run();
    const e = envs.find((env) => env.state === "thinking");
    expect(e?.ext).toMatchObject({ model: "claude-x", cwd: "/repo" });
  });

  it("楽観 stamp: options.modelSource='config' で SDK init 前から ext.model_source が付き、init 後も source を維持する (phase-15 15-4b)", async () => {
    const envs: Envelope[] = [];
    const host = new AgentHost(config, {
      onState: (e) => envs.push(e),
      modelSource: "config",
      queryOptions: { model: "claude-opus-4-7" },
      queryFn: scriptedQuery([
        // SDK init が別値 (正規化名等) を返しても source は "config" のまま維持されること
        // — 値の由来を伝える field なので default に書き換えない。
        msg({
          type: "system",
          subtype: "init",
          model: "claude-opus-4-7-normalized",
          cwd: "/repo",
        }),
        assistant([{ type: "text", text: "hi" }]),
      ]),
      now: () => "T",
    });
    await host.run();
    const afterInit = envs.find((e) => e.state === "thinking");
    expect(afterInit?.ext).toMatchObject({
      model: "claude-opus-4-7-normalized",
      model_source: "config",
    });
  });

  it("楽観 stamp: options.modelSource='env' でも SDK init 後 source を維持する (phase-15 15-4b)", async () => {
    const envs: Envelope[] = [];
    const host = new AgentHost(config, {
      onState: (e) => envs.push(e),
      modelSource: "env",
      queryOptions: { model: "claude-from-env" },
      queryFn: scriptedQuery([
        msg({
          type: "system",
          subtype: "init",
          model: "claude-from-env",
          cwd: "/repo",
        }),
        assistant([{ type: "text", text: "hi" }]),
      ]),
      now: () => "T",
    });
    await host.run();
    const afterInit = envs.find((e) => e.state === "thinking");
    expect(afterInit?.ext).toMatchObject({
      model: "claude-from-env",
      model_source: "env",
    });
  });

  it("楽観 stamp: modelSource 未指定なら SDK init で model_source='default' が初出現する (phase-15 15-4b)", async () => {
    const envs: Envelope[] = [];
    const host = new AgentHost(config, {
      onState: (e) => envs.push(e),
      queryFn: scriptedQuery([
        msg({
          type: "system",
          subtype: "init",
          model: "claude-sonnet-x",
          cwd: "/repo",
        }),
        assistant([{ type: "text", text: "hi" }]),
      ]),
      now: () => "T",
    });
    await host.run();
    const afterInit = envs.find((e) => e.state === "thinking");
    expect(afterInit?.ext).toMatchObject({
      model: "claude-sonnet-x",
      model_source: "default",
    });
  });

  it("session_capabilities を engine と一緒に stamp する (ADR-0034 F1, phase-15 15-14)", async () => {
    const envs: Envelope[] = [];
    const host = new AgentHost(config, {
      onState: (e) => envs.push(e),
      queryFn: scriptedQuery([
        msg({
          type: "system",
          subtype: "init",
          model: "claude-x",
          cwd: "/repo",
        }),
        assistant([{ type: "text", text: "hi" }]),
      ]),
      now: () => "T",
    });
    await host.run();
    // session_capabilities は #statusExt から unconditional に stamp されるため
    // 全 state_change に乗る (ADR-0034 F1、spawn-direct advertise の実装契約)。
    // envs[0] を採るのは「init 到達を待たない」ことの demonstrate 用。
    // supports_session_reset は phase-17 17-6 で adapter 側の flip が完了。
    // wrapper/runner/server が F2 fresh-relaunch handshake を提供する
    // session としての true 明示 + 対応 modes 列挙。dashboard 側の
    // Composer intercept (17-8) は δ で追加。
    const first = envs[0]!;
    expect(first.ext?.session_capabilities).toEqual({
      supports_attachments: true,
      supports_user_input_dialog: true,
      supports_model_switch: true,
      supports_effort_switch: true,
      supports_session_reset: true,
      session_reset_modes: ["new", "clear"],
    });
  });

  it("init の slash_commands を ext.slash_commands に付与する (#34)", async () => {
    const envs: Envelope[] = [];
    const host = new AgentHost(config, {
      onState: (e) => envs.push(e),
      queryFn: scriptedQuery([
        msg({
          type: "system",
          subtype: "init",
          model: "claude-x",
          cwd: "/repo",
          slash_commands: ["model", "review", "clear"],
        }),
        assistant([{ type: "text", text: "hi" }]),
      ]),
      now: () => "T",
    });
    await host.run();
    const e = envs.find((env) => env.state === "thinking");
    expect(e?.ext?.slash_commands).toEqual(["model", "review", "clear"]);
  });

  it("getContextUsage を ext.context / ext.model として付与する (#16)", async () => {
    const envs: Envelope[] = [];
    const usage = {
      totalTokens: 50,
      maxTokens: 100,
      percentage: 50,
      model: "claude-test",
    };
    const queryFn = makeQueryFn(() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield assistant([{ type: "text", text: "hi" }]);
        yield result("success", { result: "ok" });
        // A state_change AFTER the result, by which point the fire-and-forget
        // context refresh has resolved and is stamped into ext.
        yield assistant([{ type: "text", text: "more" }]);
      }
      return asQuery(
        gen(),
        async () => {},
        async () => usage,
      );
    });
    const host = new AgentHost(config, {
      onState: (e) => envs.push(e),
      queryFn,
      now: () => "T",
    });
    await host.run();
    const withCtx = envs.filter((e) => e.state === "thinking").at(-1);
    expect(withCtx?.ext).toMatchObject({
      model: "claude-test",
      context: { used_tokens: 50, max_tokens: 100, used_percentage: 50 },
    });
  });

  it("config.permission_mode が SDK の permissionMode に渡る (#58)", async () => {
    let captured!: Options;
    const queryFn = makeQueryFn((args: QueryArgs) => {
      captured = args.options;
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield result("success", { result: "ok" });
      }
      return asQuery(gen());
    });
    const host = new AgentHost(
      { ...config, permission_mode: "plan" },
      { onState: () => {}, queryFn, now: () => "T" },
    );
    await host.run();
    expect(captured?.permissionMode).toBe("plan");
    // allowDangerouslySkipPermissions is opt-in to bypassPermissions only.
    expect(captured?.allowDangerouslySkipPermissions).toBeUndefined();
  });

  it("config.permission_mode が bypassPermissions なら allowDangerouslySkipPermissions が立つ (#58)", async () => {
    let captured!: Options;
    const queryFn = makeQueryFn((args: QueryArgs) => {
      captured = args.options;
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield result("success", { result: "ok" });
      }
      return asQuery(gen());
    });
    const host = new AgentHost(
      { ...config, permission_mode: "bypassPermissions" },
      { onState: () => {}, queryFn, now: () => "T" },
    );
    await host.run();
    expect(captured?.permissionMode).toBe("bypassPermissions");
    expect(captured?.allowDangerouslySkipPermissions).toBe(true);
  });

  it("appendSystemPrompt が SDK systemPrompt.append に渡る (ADR-0026)", async () => {
    let captured!: Options;
    const queryFn = makeQueryFn((args: QueryArgs) => {
      captured = args.options;
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield result("success", { result: "ok" });
      }
      return asQuery(gen());
    });
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn,
      appendSystemPrompt: "口調ガイド + フッター",
      now: () => "T",
    });
    await host.run();
    expect(captured?.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "口調ガイド + フッター",
    });
  });

  it("appendSystemPrompt を指定しなければ append フィールドは出さない", async () => {
    let captured!: Options;
    const queryFn = makeQueryFn((args: QueryArgs) => {
      captured = args.options;
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield result("success", { result: "ok" });
      }
      return asQuery(gen());
    });
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn,
      now: () => "T",
    });
    await host.run();
    expect(captured?.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
    });
  });

  it("run() 前の setPermissionMode は SDK 開始時のモードを上書きする (#58)", async () => {
    let captured!: Options;
    const queryFn = makeQueryFn((args: QueryArgs) => {
      captured = args.options;
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield result("success", { result: "ok" });
      }
      return asQuery(gen());
    });
    const host = new AgentHost(
      { ...config, permission_mode: "default" },
      { onState: () => {}, queryFn, now: () => "T" },
    );
    // Simulates the server after_join push arriving before the first turn.
    await host.setPermissionMode("acceptEdits");
    await host.run();
    expect(captured?.permissionMode).toBe("acceptEdits");
  });

  it("mid-session setPermissionMode は SDK の query.setPermissionMode を呼ぶ (#58)", async () => {
    const calls: string[] = [];
    let hostRef!: AgentHost;
    const queryFn = makeQueryFn(() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        // Hand a chance to flip mode while the session is open.
        await hostRef.setPermissionMode("acceptEdits");
        yield result("success", { result: "ok" });
      }
      return asQuery(gen(), async () => {}, undefined, {
        setPermissionMode: async (mode: string) => {
          calls.push(mode);
        },
      });
    });
    hostRef = new AgentHost(config, {
      onState: () => {},
      queryFn,
      now: () => "T",
    });
    await hostRef.run();
    expect(calls).toEqual(["acceptEdits"]);
  });

  it("init / status / result から ext.permission_mode と ext.fast_mode を付与する (#57)", async () => {
    const envs: Envelope[] = [];
    const host = new AgentHost(config, {
      onState: (e) => envs.push(e),
      queryFn: scriptedQuery([
        msg({
          type: "system",
          subtype: "init",
          model: "claude-x",
          cwd: "/repo",
          permissionMode: "default",
          fast_mode_state: "off",
        }),
        assistant([{ type: "text", text: "hi" }]),
        // Mid-session mode flip via /mode — SDK status message.
        msg({
          type: "system",
          subtype: "status",
          status: "requesting",
          permissionMode: "plan",
        }),
        assistant([{ type: "text", text: "after-mode" }]),
        // result carries the new fast_mode_state (cooldown only surfaces here).
        result("success", { result: "ok", fast_mode_state: "cooldown" }),
        assistant([{ type: "text", text: "next" }]),
      ]),
      now: () => "T",
    });
    await host.run();
    const thinkings = envs.filter((e) => e.state === "thinking");
    // First thinking: init values.
    expect(thinkings[0]?.ext).toMatchObject({
      permission_mode: "default",
      fast_mode: "off",
    });
    // Post-status thinking: permission_mode updated, fast_mode unchanged.
    expect(thinkings[1]?.ext).toMatchObject({
      permission_mode: "plan",
      fast_mode: "off",
    });
    // Post-result thinking: fast_mode updated to cooldown.
    expect(thinkings.at(-1)?.ext).toMatchObject({
      permission_mode: "plan",
      fast_mode: "cooldown",
    });
  });

  it("ext.permission (二軸写像) と ext.engine を付与する (ADR-0033 F1/F2)", async () => {
    const envs: Envelope[] = [];
    const host = new AgentHost(config, {
      onState: (e) => envs.push(e),
      queryFn: scriptedQuery([
        msg({
          type: "system",
          subtype: "init",
          permissionMode: "default",
        }),
        assistant([{ type: "text", text: "hi" }]),
        // Mid-session mode flip: the two-axis projection follows the mode.
        msg({
          type: "system",
          subtype: "status",
          status: "requesting",
          permissionMode: "plan",
        }),
        assistant([{ type: "text", text: "after-mode" }]),
        result("success", { result: "ok" }),
      ]),
      now: () => "T",
    });
    await host.run();
    const thinkings = envs.filter((e) => e.state === "thinking");
    expect(thinkings[0]?.ext).toMatchObject({
      engine: "claude-code",
      permission: { sandbox: "workspace-write", approval: "untrusted" },
    });
    expect(thinkings.at(-1)?.ext).toMatchObject({
      permission: { sandbox: "read-only", approval: "on-request" },
    });
  });

  it("CwdChanged フックで mid-session に ext.cwd を更新する (#64)", async () => {
    const envs: Envelope[] = [];
    const queryFn = makeQueryFn((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield msg({ type: "system", subtype: "init", cwd: "/repo" });
        yield assistant([{ type: "text", text: "hi" }]);
        // Fire the registered CwdChanged hook (the host always pushes one
        // entry whose .hooks[0] is its handler).
        const cwdHook =
          args.options.hooks?.CwdChanged?.[
            args.options.hooks.CwdChanged.length - 1
          ]?.hooks[0];
        await cwdHook?.(
          {
            session_id: "s",
            transcript_path: "",
            cwd: "/repo",
            hook_event_name: "CwdChanged",
            old_cwd: "/repo",
            new_cwd: "/repo/sub",
          } as never,
          undefined,
          { signal: new AbortController().signal },
        );
        // The next state_change after the hook should carry the new cwd.
        yield assistant([{ type: "text", text: "after-cd" }]);
        yield result("success", { result: "ok" });
      }
      return asQuery(gen());
    });
    const host = new AgentHost(config, {
      onState: (e) => envs.push(e),
      queryFn,
      now: () => "T",
    });
    await host.run();
    // First thinking still has /repo (init cwd), the post-hook thinking has /repo/sub.
    const thinkings = envs.filter((e) => e.state === "thinking");
    expect(thinkings[0]?.ext?.cwd).toBe("/repo");
    expect(thinkings.at(-1)?.ext?.cwd).toBe("/repo/sub");
  });

  it("CwdChanged フックは queryOptions.hooks のユーザ登録を保持してマージする (#64)", async () => {
    const userHookCalls: string[] = [];
    const queryFn = makeQueryFn((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        // Run BOTH the user's hook and the host's appended hook.
        const matchers = args.options.hooks?.CwdChanged ?? [];
        for (const m of matchers) {
          for (const cb of m.hooks) {
            await cb(
              {
                session_id: "s",
                transcript_path: "",
                cwd: "/repo",
                hook_event_name: "CwdChanged",
                old_cwd: "/repo",
                new_cwd: "/repo/x",
              } as never,
              undefined,
              { signal: new AbortController().signal },
            );
          }
        }
        yield assistant([{ type: "text", text: "hi" }]);
        yield result("success", { result: "ok" });
      }
      return asQuery(gen());
    });
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn,
      queryOptions: {
        hooks: {
          CwdChanged: [
            {
              hooks: [
                async (input) => {
                  userHookCalls.push(
                    (input as { new_cwd: string }).new_cwd ?? "",
                  );
                  return {};
                },
              ],
            },
          ],
        },
      },
      now: () => "T",
    });
    await host.run();
    expect(userHookCalls).toEqual(["/repo/x"]);
  });

  it("SDK の session_id を onSessionId で報告し、変化時のみ再通知する (ADR-0014)", async () => {
    const ids: string[] = [];
    const host = new AgentHost(config, {
      onState: () => {},
      onSessionId: (id) => ids.push(id),
      queryFn: scriptedQuery([
        msg({ type: "system", subtype: "init", session_id: "sess-1" }),
        // Same id: must not re-notify. A helper-built message carries none.
        msg({
          type: "assistant",
          session_id: "sess-1",
          message: { content: [] },
        }),
        assistant([{ type: "text", text: "hi" }]),
        // New id (e.g. compaction forks the session): notify again.
        result("success", { result: "ok", session_id: "sess-2" }),
      ]),
      now: () => "T",
    });
    await host.run();
    expect(ids).toEqual(["sess-1", "sess-2"]);
  });

  it("getContextUsage が reject してもセッションは正常終了する (#16)", async () => {
    const queryFn = makeQueryFn(() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield result("success", { result: "ok" });
      }
      return asQuery(
        gen(),
        async () => {},
        async () => {
          throw new Error("context usage unavailable");
        },
      );
    });
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn,
      now: () => "T",
    });
    await expect(host.run()).resolves.toBeUndefined();
  });
});

describe("AgentHost — permission", () => {
  it("decidePermission が waiting_permission→tool_running を駆動する(allow)", async () => {
    const states: string[] = [];
    let toolResultYielded = false;
    const queryFn = makeQueryFn((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield assistant([
          { type: "tool_use", id: "tu_1", name: "Read", input: {} },
        ]);
        const decision = (await args.options.canUseTool!(
          "Read",
          {},
          {} as never,
        ))!;
        if (decision.behavior === "allow") {
          toolResultYielded = true;
          yield user([
            { type: "tool_result", tool_use_id: "tu_1", content: "ok" },
          ]);
        }
        yield result("success", { result: "ok" });
      }
      return asQuery(gen());
    });

    const host = new AgentHost(config, {
      onState: (e) => states.push(e.state),
      decidePermission: () => ({ allow: true }),
      queryFn,
      now: () => "T",
    });
    await host.run();

    expect(toolResultYielded).toBe(true);
    const wpIdx = states.indexOf("waiting_permission");
    expect(wpIdx).toBeGreaterThanOrEqual(0);
    expect(states[wpIdx + 1]).toBe("tool_running");
  });

  it("decider 未配線なら fail-closed で deny する", async () => {
    let behavior = "";
    const queryFn = makeQueryFn((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield assistant([
          { type: "tool_use", id: "tu_1", name: "Read", input: {} },
        ]);
        const decision = (await args.options.canUseTool!(
          "Read",
          {},
          {} as never,
        ))!;
        behavior = decision.behavior;
        yield result("success", { result: "x" });
      }
      return asQuery(gen());
    });

    const host = new AgentHost(config, {
      onState: () => {},
      queryFn,
      now: () => "T",
    });
    await host.run();
    expect(behavior).toBe("deny");
  });

  it("setPendingPermission で state_change(waiting_permission) の ext に pending_permission が乗る (ADR-0022)", async () => {
    const states: { state: string; ext: Record<string, unknown> }[] = [];
    const pendingRecord = {
      request_id: "req-x",
      tool_name: "Read",
      input: { path: "a.ts" },
      ts: "T",
    };

    let hostRef!: AgentHost;
    const queryFn = makeQueryFn((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield assistant([
          { type: "tool_use", id: "tu_1", name: "Read", input: {} },
        ]);
        const decision = (await args.options.canUseTool!(
          "Read",
          {},
          {} as never,
        ))!;
        expect(decision.behavior).toBe("allow");
        yield result("success", { result: "ok" });
      }
      return asQuery(gen());
    });

    hostRef = new AgentHost(config, {
      onState: (e) => states.push({ state: e.state, ext: e.ext }),
      // Mimic the broker's wiring: stamp pending sync inside decide, then
      // resolve. The order is critical (ADR-0022 F3): the state_change
      // emitted by host's #apply MUST already carry ext.pending_permission.
      decidePermission: () => {
        hostRef.setPendingPermission(pendingRecord);
        // Broker would normally clear pending on resolve; replicate that
        // through the host helper since the test's decider stands in.
        queueMicrotask(() => hostRef.setPendingPermission(null));
        return { allow: true };
      },
      queryFn,
      now: () => "T",
    });

    await hostRef.run();

    const wp = states.find((s) => s.state === "waiting_permission");
    expect(wp).toBeDefined();
    expect(wp!.ext).toMatchObject({ pending_permission: pendingRecord });

    // The follow-up state_change must NOT carry pending_permission anymore.
    const trIdx = states.findIndex((s) => s.state === "tool_running");
    expect(trIdx).toBeGreaterThanOrEqual(0);
    expect(states[trIdx]!.ext).not.toHaveProperty("pending_permission");
  });
});

describe("AgentHost — question (AskUserQuestion, ADR-0027)", () => {
  const questions = [
    {
      question: "どれ?",
      header: "選択",
      multiSelect: false,
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" },
      ],
    },
  ];

  it("decideQuestion が waiting_question→tool_running を駆動し answers を返す", async () => {
    const states: string[] = [];
    let updatedInput: Record<string, unknown> | undefined;
    const queryFn = makeQueryFn((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield assistant([
          {
            type: "tool_use",
            id: "tu_1",
            name: "AskUserQuestion",
            input: { questions },
          },
        ]);
        const decision = (await args.options.canUseTool!(
          "AskUserQuestion",
          { questions },
          {} as never,
        ))!;
        if (decision.behavior === "allow") updatedInput = decision.updatedInput;
        yield result("success", { result: "ok" });
      }
      return asQuery(gen());
    });

    const host = new AgentHost(config, {
      onState: (e) => states.push(e.state),
      decideQuestion: () => ({ cancelled: false, answers: { "どれ?": "A" } }),
      queryFn,
      now: () => "T",
    });
    await host.run();

    const wqIdx = states.indexOf("waiting_question");
    expect(wqIdx).toBeGreaterThanOrEqual(0);
    expect(states[wqIdx + 1]).toBe("tool_running");
    expect(updatedInput).toMatchObject({
      questions,
      answers: { "どれ?": "A" },
    });
  });

  it("cancelled は deny を返す", async () => {
    let behavior = "";
    const queryFn = makeQueryFn((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield assistant([
          {
            type: "tool_use",
            id: "tu_1",
            name: "AskUserQuestion",
            input: { questions },
          },
        ]);
        const decision = (await args.options.canUseTool!(
          "AskUserQuestion",
          { questions },
          {} as never,
        ))!;
        behavior = decision.behavior;
        yield result("success", { result: "x" });
      }
      return asQuery(gen());
    });

    const host = new AgentHost(config, {
      onState: () => {},
      decideQuestion: () => ({ cancelled: true }),
      queryFn,
      now: () => "T",
    });
    await host.run();
    expect(behavior).toBe("deny");
  });

  it("decideQuestion 未配線なら permission 経路に落ちて deny する", async () => {
    let behavior = "";
    const queryFn = makeQueryFn((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield assistant([
          {
            type: "tool_use",
            id: "tu_1",
            name: "AskUserQuestion",
            input: { questions },
          },
        ]);
        const decision = (await args.options.canUseTool!(
          "AskUserQuestion",
          { questions },
          {} as never,
        ))!;
        behavior = decision.behavior;
        yield result("success", { result: "x" });
      }
      return asQuery(gen());
    });

    // No decideQuestion and no decidePermission: AskUserQuestion falls through
    // to the permission path, which fail-closed denies.
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn,
      now: () => "T",
    });
    await host.run();
    expect(behavior).toBe("deny");
  });

  it("setPendingQuestion で waiting_question の ext に pending_question が乗る", async () => {
    const states: { state: string; ext: Record<string, unknown> }[] = [];
    const pendingRecord = { request_id: "q-x", questions, ts: "T" };

    let hostRef!: AgentHost;
    const queryFn = makeQueryFn((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield assistant([
          {
            type: "tool_use",
            id: "tu_1",
            name: "AskUserQuestion",
            input: { questions },
          },
        ]);
        const decision = (await args.options.canUseTool!(
          "AskUserQuestion",
          { questions },
          {} as never,
        ))!;
        expect(decision.behavior).toBe("allow");
        yield result("success", { result: "ok" });
      }
      return asQuery(gen());
    });

    hostRef = new AgentHost(config, {
      onState: (e) => states.push({ state: e.state, ext: e.ext }),
      decideQuestion: () => {
        hostRef.setPendingQuestion(pendingRecord);
        queueMicrotask(() => hostRef.setPendingQuestion(null));
        return { cancelled: false, answers: { "どれ?": "A" } };
      },
      queryFn,
      now: () => "T",
    });

    await hostRef.run();

    const wq = states.find((s) => s.state === "waiting_question");
    expect(wq).toBeDefined();
    expect(wq!.ext).toMatchObject({ pending_question: pendingRecord });

    // The tool_running that follows the question must not carry it anymore.
    const wqIdx = states.findIndex((s) => s.state === "waiting_question");
    const trAfter = states
      .slice(wqIdx + 1)
      .find((s) => s.state === "tool_running");
    expect(trAfter).toBeDefined();
    expect(trAfter!.ext).not.toHaveProperty("pending_question");
  });
});

describe("AgentHost — input queue/notify/close", () => {
  it("send でキューに積み close でセッションが終わる", async () => {
    const received: string[] = [];
    const queryFn = makeQueryFn((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        for await (const m of args.prompt) {
          const content = m.message.content;
          received.push(typeof content === "string" ? content : "");
        }
      }
      return asQuery(gen());
    });

    const host = new AgentHost(config, {
      onState: () => {},
      queryFn,
      now: () => "T",
    });
    const done = host.run();
    host.send("a");
    host.send("b");
    host.close();
    await done;
    expect(received).toEqual(["a", "b"]);
  });

  it("send は rest 状態で sending を発行する (#32)", async () => {
    const states: string[] = [];
    const queryFn = makeQueryFn((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        for await (const _ of args.prompt) void _;
      }
      return asQuery(gen());
    });
    const host = new AgentHost(config, {
      onState: (e) => states.push(e.state),
      queryFn,
      now: () => "T",
    });
    const done = host.run();
    host.send("hello");
    host.close();
    await done;
    expect(states).toContain("sending");
  });

  it("close 後の send は投げる", async () => {
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn: scriptedQuery([]),
      now: () => "T",
    });
    host.close();
    await expect(host.send("x")).rejects.toThrow(/closed/);
  });

  it("interrupt は query.interrupt へ委譲する", async () => {
    const interrupt = vi.fn(async () => {});
    const queryFn = makeQueryFn((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        // Stay open until the input stream closes.
        for await (const _ of args.prompt) void _;
      }
      return asQuery(gen(), interrupt);
    });

    const host = new AgentHost(config, {
      onState: () => {},
      queryFn,
      now: () => "T",
    });
    const done = host.run();
    await host.interrupt();
    expect(interrupt).toHaveBeenCalledOnce();
    host.close();
    await done;
  });

  it("interrupt は run 前は no-op (#51)", async () => {
    // protocol.md A6: a stale/early interrupt is left to the wrapper to
    // absorb. Before run(), #query is null and interrupt() must resolve
    // without throwing — the optional-chain on #query?.interrupt() is the
    // wrapper-side no-op contract the server relays into.
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn: scriptedQuery([]),
      now: () => "T",
    });
    await expect(host.interrupt()).resolves.toBeUndefined();
  });

  it("interrupt の連打はそのつど SDK へ伝播する (#51)", async () => {
    // B3: idempotency is delegated to the SDK; the wrapper relays each call
    // verbatim, so two operator clicks reach Query.interrupt() twice.
    const interrupt = vi.fn(async () => {});
    const queryFn = makeQueryFn((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        for await (const _ of args.prompt) void _;
      }
      return asQuery(gen(), interrupt);
    });
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn,
      now: () => "T",
    });
    const done = host.run();
    await host.interrupt();
    await host.interrupt();
    expect(interrupt).toHaveBeenCalledTimes(2);
    host.close();
    await done;
  });
});

describe("AgentHost — model/effort 切替 (#54)", () => {
  const modelInfos = [
    {
      value: "default",
      displayName: "Default (recommended)",
      description: "d",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    // Haiku has no effort support: effort_levels must be omitted.
    { value: "haiku", displayName: "Haiku", description: "h" },
  ];

  it("run 前の model/effort choice を first Query Options へ保持する (#110)", async () => {
    const envs: Envelope[] = [];
    let seenOptions: Options | undefined;
    const host = new AgentHost(config, {
      onState: (e) => envs.push(e),
      queryFn: makeQueryFn((args) => {
        seenOptions = args.options;
        async function* gen(): AsyncGenerator<SDKMessage, void> {}
        return asQuery(gen());
      }),
      now: () => "T",
    });

    await host.setModel("claude-fable-5[1m]");
    await host.setEffort("max");
    await host.run();

    expect(seenOptions).toMatchObject({
      model: "claude-fable-5[1m]",
      effort: "max",
    });
    expect(host.statusExtSnapshot()).toMatchObject({
      model: "claude-fable-5[1m]",
      model_source: "config",
      effort: "max",
      effort_source: "config",
      effective: {
        model: "claude-fable-5[1m]",
        effort: "max",
      },
    });
    expect(envs.at(-1)?.ext).toMatchObject({
      model: "claude-fable-5[1m]",
      effort: "max",
    });
  });

  it("idle run 後の first-turn 前 choice も Query生成まで buffer する (#110)", async () => {
    let seenOptions: Options | undefined;
    let queryCreated = false;
    const host = new AgentHost(config, {
      onState: () => {},
      deferQueryUntilFirstInput: true,
      queryFn: makeQueryFn((args) => {
        queryCreated = true;
        seenOptions = args.options;
        async function* gen(): AsyncGenerator<SDKMessage, void> {}
        return asQuery(gen());
      }),
      now: () => "T",
    });

    const done = host.run();
    await Promise.resolve();
    expect(queryCreated).toBe(false);
    await host.setModel("claude-fable-5[1m]");
    await host.setEffort("max");
    await host.send("first turn");
    await done;

    expect(queryCreated).toBe(true);
    expect(seenOptions).toMatchObject({
      model: "claude-fable-5[1m]",
      effort: "max",
    });
  });

  it("idle Query待機は first turn 前の close で終了する (#110)", async () => {
    const queryFn = vi.fn(scriptedQuery([]));
    const host = new AgentHost(config, {
      onState: () => {},
      deferQueryUntilFirstInput: true,
      queryFn,
      now: () => "T",
    });
    const done = host.run();
    await Promise.resolve();
    host.close();
    await done;
    expect(queryFn).not.toHaveBeenCalled();
  });

  it("run 前は account default の effort を model choice より先に選べる (#110)", async () => {
    let seenOptions: Options | undefined;
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn: makeQueryFn((args) => {
        seenOptions = args.options;
        async function* gen(): AsyncGenerator<SDKMessage, void> {}
        return asQuery(gen());
      }),
      now: () => "T",
    });
    await host.setEffort("high");
    await host.run();
    expect(seenOptions?.model).toBeUndefined();
    expect(seenOptions?.effort).toBe("high");
  });

  it("supportedModels を ext.models に付与する", async () => {
    const envs: Envelope[] = [];
    const queryFn = makeQueryFn(() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield msg({ type: "system", subtype: "init", model: "claude-x" });
        yield assistant([{ type: "text", text: "hi" }]);
        yield result("success", { result: "ok" });
        // A later state_change, by which point the fire-and-forget
        // supportedModels fetch (triggered on init) has resolved.
        yield assistant([{ type: "text", text: "more" }]);
      }
      return asQuery(gen(), async () => {}, undefined, {
        supportedModels: async () => modelInfos,
      });
    });
    const host = new AgentHost(config, {
      onState: (e) => envs.push(e),
      queryFn,
      now: () => "T",
    });
    await host.run();
    const withModels = envs.filter((e) => e.state === "thinking").at(-1);
    expect(withModels?.ext?.models).toEqual([
      {
        value: "default",
        display_name: "Default (recommended)",
        description: "d",
        effort_levels: ["low", "medium", "high", "xhigh", "max"],
      },
      { value: "haiku", display_name: "Haiku", description: "h" },
    ]);
  });

  it("明示 startup effort/source を ext と SDK Options に反映する (#108)", async () => {
    const envs: Envelope[] = [];
    let seenOptions: Options | undefined;
    const host = new AgentHost(config, {
      onState: (e) => envs.push(e),
      effortSource: "config",
      queryOptions: { effort: "high" },
      queryFn: (args) => {
        seenOptions = args.options;
        async function* gen(): AsyncGenerator<SDKMessage, void> {
          yield assistant([{ type: "text", text: "hi" }]);
        }
        return asQuery(gen());
      },
      now: () => "T",
    });
    await host.run();
    expect(seenOptions?.effort).toBe("high");
    expect(envs[0]?.ext).toMatchObject({
      effort: "high",
      effort_source: "config",
      effective: { effort: "high", effort_source: "config" },
    });
  });

  it("setModel は query.setModel へエイリアスを委譲する", async () => {
    const setModel = vi.fn(async () => {});
    const queryFn = makeQueryFn((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        for await (const _ of args.prompt) void _;
      }
      return asQuery(gen(), async () => {}, undefined, { setModel });
    });
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn,
      now: () => "T",
    });
    const done = host.run();
    await host.setModel("opus[1m]");
    expect(setModel).toHaveBeenCalledWith("opus[1m]");
    host.close();
    await done;
  });

  it("setEffort は pending を出して control ack で即時 commit する (max 含む)", async () => {
    const envs: Envelope[] = [];
    const applyFlagSettings = vi.fn(async () => {});
    const queryFn = makeQueryFn((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        for await (const _ of args.prompt) void _;
      }
      return asQuery(gen(), async () => {}, undefined, { applyFlagSettings });
    });
    const host = new AgentHost(config, {
      onState: (e) => envs.push(e),
      queryFn,
      now: () => "T",
    });
    const done = host.run();
    await host.setEffort("max");
    expect(applyFlagSettings).toHaveBeenCalledWith({ effortLevel: "max" });
    expect(envs.at(-2)?.ext.pending_effort).toBe("max");
    expect(envs.at(-1)?.ext).toMatchObject({
      effort: "max",
      effort_source: "config",
      effective: { effort: "max", effort_source: "config" },
    });
    expect(envs.at(-1)?.ext.pending_effort).toBeUndefined();
    host.close();
    await done;
  });

  it("setEffort reject は last-good へ rollback して loud failure を出す", async () => {
    const envs: Envelope[] = [];
    const applyFlagSettings = vi.fn(async () => {
      throw new Error("rejected");
    });
    const queryFn = makeQueryFn((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        for await (const _ of args.prompt) void _;
      }
      return asQuery(gen(), async () => {}, undefined, { applyFlagSettings });
    });
    const host = new AgentHost(config, {
      onState: (e) => envs.push(e),
      queryFn,
      now: () => "T",
      effortSource: "config",
      queryOptions: { effort: "low" },
    });
    const done = host.run();
    await expect(host.setEffort("high")).rejects.toThrow("rejected");
    expect(envs.at(-1)?.ext).toMatchObject({
      effort: "low",
      effort_source: "config",
      switch_error: {
        kind: "effort",
        requested: "high",
        reason: "control_rejected",
        rolled_back_to: "low",
      },
    });
    host.close();
    await done;
  });

  it("新modelで無効なeffortをnull clearし effort_reset を明示する", async () => {
    const envs: Envelope[] = [];
    const setModel = vi.fn(async () => {});
    const applyFlagSettings = vi.fn(async () => {});
    const queryFn = makeQueryFn((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield msg({ type: "system", subtype: "init", model: "default" });
        for await (const _ of args.prompt) void _;
      }
      return asQuery(gen(), async () => {}, undefined, {
        setModel,
        applyFlagSettings,
        supportedModels: async () => modelInfos,
      });
    });
    const host = new AgentHost(config, {
      onState: (e) => envs.push(e),
      queryFn,
      now: () => "T",
      effortSource: "config",
      queryOptions: { effort: "high" },
    });
    const done = host.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await host.setModel("haiku");
    expect(setModel).toHaveBeenCalledWith("haiku");
    expect(applyFlagSettings).toHaveBeenCalledWith({ effortLevel: null });
    expect(envs.some((e) => e.ext.effort_reset === true)).toBe(true);
    expect(envs.at(-1)?.ext.effort).toBeUndefined();
    expect(envs.at(-1)?.ext.session_capabilities).toMatchObject({
      supports_effort_switch: false,
    });
    host.close();
    await done;
  });

  it("effort reset reject は half-state を残して loud failure を出す", async () => {
    const envs: Envelope[] = [];
    const applyFlagSettings = vi.fn(async () => {
      throw new Error("clear rejected");
    });
    const queryFn = makeQueryFn((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield msg({ type: "system", subtype: "init", model: "default" });
        for await (const _ of args.prompt) void _;
      }
      return asQuery(gen(), async () => {}, undefined, {
        setModel: async () => {},
        applyFlagSettings,
        supportedModels: async () => modelInfos,
      });
    });
    const host = new AgentHost(config, {
      onState: (e) => envs.push(e),
      queryFn,
      now: () => "T",
      effortSource: "config",
      queryOptions: { effort: "high" },
    });
    const done = host.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(host.setModel("haiku")).rejects.toThrow("clear rejected");
    expect(envs.at(-1)?.ext).toMatchObject({
      model: "haiku",
      effort: "high",
      switch_error: {
        kind: "effort",
        requested: "default",
        reason: "effort_reset_failed",
        rolled_back_to: "high",
      },
    });
    host.close();
    await done;
  });

  it("setModel / setEffort は run 前の startup state に buffer する (#110)", async () => {
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn: scriptedQuery([]),
      now: () => "T",
    });
    await expect(host.setModel("opus[1m]")).resolves.toBeUndefined();
    await expect(host.setEffort("high")).resolves.toBeUndefined();
    expect(host.statusExtSnapshot()).toMatchObject({
      model: "opus[1m]",
      effort: "high",
    });
  });

  it("supportedModels が reject してもセッションは正常終了する", async () => {
    const queryFn = makeQueryFn(() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield msg({ type: "system", subtype: "init", model: "claude-x" });
        yield result("success", { result: "ok" });
      }
      return asQuery(gen(), async () => {}, undefined, {
        supportedModels: async () => {
          throw new Error("supportedModels unavailable");
        },
      });
    });
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn,
      now: () => "T",
    });
    await expect(host.run()).resolves.toBeUndefined();
  });
});

describe("AgentHost — ファイルアップロード (ADR-0025)", () => {
  // Stub the image downsizer with a pass-through so dispatch / E2E tests
  // can ride synthetic byte arrays (sharp would reject "image/png" claims
  // that are not real PNG headers). The real SharpImageDownsizer keeps its
  // own coverage in upload.test.ts where the fixtures are sharp-generated.
  beforeEach(() => {
    setDefaultImageDownsizer({
      fit: async (bytes, mime) => ({ bytes, mime }),
    });
  });
  afterEach(() => {
    setDefaultImageDownsizer(new SharpImageDownsizer());
  });

  /** queryFn that drains args.prompt into `captured` and yields nothing —
   *  lets a test inspect the SDKUserMessage list the host queued. */
  function captureQueryFn(captured: SDKUserMessage[]): QueryFn {
    return makeQueryFn((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        for await (const m of args.prompt) captured.push(m);
      }
      return asQuery(gen());
    });
  }

  const png = (size = 3) => ({
    upload_id: "u1",
    filename: "a.png",
    mime: "image/png",
    size,
    chunks: 1,
  });

  it("画像 1 枚を attach -> instruction で SDK content blocks に組み込む", async () => {
    const captured: SDKUserMessage[] = [];
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn: captureQueryFn(captured),
      now: () => "T",
    });
    const done = host.run();
    host.attachOpen(png(3));
    host.attachChunk(buildChunkPayload("u1", 0, new Uint8Array([1, 2, 3])));
    host.attachClose("u1");
    await host.send("見て", ["u1"]);
    host.close();
    await done;

    expect(captured.length).toBe(1);
    expect(captured[0]!.message.content).toEqual([
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: Buffer.from([1, 2, 3]).toString("base64"),
        },
      },
      { type: "text", text: "見て" },
    ]);
  });

  it("text 空 + 添付ありなら image block のみ送る", async () => {
    const captured: SDKUserMessage[] = [];
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn: captureQueryFn(captured),
      now: () => "T",
    });
    const done = host.run();
    host.attachOpen(png(1));
    host.attachChunk(buildChunkPayload("u1", 0, new Uint8Array([9])));
    host.attachClose("u1");
    await host.send("", ["u1"]);
    host.close();
    await done;
    expect(Array.isArray(captured[0]!.message.content)).toBe(true);
    expect((captured[0]!.message.content as unknown[]).length).toBe(1);
  });

  it("添付なしの send は string content の従来挙動", async () => {
    const captured: SDKUserMessage[] = [];
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn: captureQueryFn(captured),
      now: () => "T",
    });
    const done = host.run();
    host.send("hello");
    host.close();
    await done;
    expect(captured[0]!.message.content).toBe("hello");
  });

  it("attachOpen の不正 MIME は attach_rejected を発火しエントリは作らない", async () => {
    const rejected: Envelope[] = [];
    const captured: SDKUserMessage[] = [];
    const host = new AgentHost(config, {
      onState: () => {},
      onAttachRejected: (e) => rejected.push(e),
      queryFn: captureQueryFn(captured),
      now: () => "T",
    });
    const done = host.run();
    host.attachOpen({
      upload_id: "bad",
      filename: "x.zip",
      mime: "application/zip",
      size: 10,
      chunks: 1,
    });
    // No entry was created — subsequent chunks are dropped silently.
    host.attachChunk(buildChunkPayload("bad", 0, new Uint8Array([1])));
    host.attachClose("bad");
    host.close();
    await done;

    expect(rejected.length).toBe(1);
    expect(rejected[0]!.type).toBe("attach_rejected");
    expect(rejected[0]!.payload).toMatchObject({
      upload_id: "bad",
      reason: "mime_denied",
    });
  });

  it("attachOpen の上限超サイズは attach_rejected (size_over)", async () => {
    const rejected: Envelope[] = [];
    const host = new AgentHost(config, {
      onState: () => {},
      onAttachRejected: (e) => rejected.push(e),
      queryFn: captureQueryFn([]),
      now: () => "T",
    });
    const done = host.run();
    host.attachOpen({
      upload_id: "big",
      filename: "big.png",
      mime: "image/png",
      size: 1024 * 1024 * 1024, // 1 GB > 128 MB protocol cap
      chunks: 1,
    });
    host.close();
    await done;
    expect(rejected.length).toBe(1);
    expect(rejected[0]!.payload).toMatchObject({
      upload_id: "big",
      reason: "size_over",
    });
  });

  it("attachClose 時に欠損 chunk があれば attach_rejected (timeout) + エントリ破棄", async () => {
    const rejected: Envelope[] = [];
    const host = new AgentHost(config, {
      onState: () => {},
      onAttachRejected: (e) => rejected.push(e),
      queryFn: captureQueryFn([]),
      now: () => "T",
    });
    const done = host.run();
    host.attachOpen({ ...png(5), chunks: 2 });
    host.attachChunk(buildChunkPayload("u1", 0, new Uint8Array([1, 2, 3])));
    // chunk 1 を送らずに close
    host.attachClose("u1");
    host.close();
    await done;
    expect(rejected[0]!.payload).toMatchObject({
      upload_id: "u1",
      reason: "timeout",
    });
  });

  it("未知 attachment_id を送ろうとすると instruction_rejected", async () => {
    const captured: SDKUserMessage[] = [];
    const rejected: Envelope[] = [];
    const states: string[] = [];
    const host = new AgentHost(config, {
      onState: (e) => states.push(e.state),
      onInstructionRejected: (e) => rejected.push(e),
      queryFn: captureQueryFn(captured),
      now: () => "T",
    });
    const done = host.run();
    host.send("見て", ["nope"]);
    host.close();
    await done;

    expect(captured.length).toBe(0); // not queued
    expect(rejected.length).toBe(1);
    expect(rejected[0]!.type).toBe("instruction_rejected");
    expect(rejected[0]!.payload).toMatchObject({
      attachment_ids: ["nope"],
      reason: "timeout",
    });
    // No sending state — the turn was atomically aborted before #apply.
    expect(states).not.toContain("sending");
  });

  it("addition test: 添付付き send が成功すれば uploads は消費されて再利用不可", async () => {
    const captured: SDKUserMessage[] = [];
    const rejected: Envelope[] = [];
    const host = new AgentHost(config, {
      onState: () => {},
      onInstructionRejected: (e) => rejected.push(e),
      queryFn: captureQueryFn(captured),
      now: () => "T",
    });
    const done = host.run();
    host.attachOpen(png(2));
    host.attachChunk(buildChunkPayload("u1", 0, new Uint8Array([1, 2])));
    host.attachClose("u1");
    await host.send("a", ["u1"]); // consumes
    await host.send("b", ["u1"]); // u1 no longer in pendingUploads -> rejected
    host.close();
    await done;
    expect(captured.length).toBe(1);
    expect(rejected.length).toBe(1);
  });

  it("attach_close 成功後の attach_chunk は sealed で破棄(再書き込み防止)", async () => {
    const captured: SDKUserMessage[] = [];
    const rejected: Envelope[] = [];
    const host = new AgentHost(config, {
      onState: () => {},
      onAttachRejected: (e) => rejected.push(e),
      queryFn: captureQueryFn(captured),
      now: () => "T",
    });
    const done = host.run();
    host.attachOpen(png(3));
    host.attachChunk(buildChunkPayload("u1", 0, new Uint8Array([1, 2, 3])));
    host.attachClose("u1"); // seals
    // 攻撃者再送: 同一 chunk_index で異なる中身 — sealed で無視される
    host.attachChunk(buildChunkPayload("u1", 0, new Uint8Array([9, 9, 9])));
    await host.send("", ["u1"]);
    host.close();
    await done;

    expect(rejected.length).toBe(0); // chunk silently dropped
    const block = (
      captured[0]!.message.content as unknown as Array<{
        source?: { data: string };
      }>
    )[0];
    expect(block?.source?.data).toBe(Buffer.from([1, 2, 3]).toString("base64"));
  });

  it("declared サイズ超過の累積 chunk は attach_rejected(size_over)+ エントリ破棄", async () => {
    const rejected: Envelope[] = [];
    const host = new AgentHost(config, {
      onState: () => {},
      onAttachRejected: (e) => rejected.push(e),
      queryFn: captureQueryFn([]),
      now: () => "T",
    });
    const done = host.run();
    host.attachOpen({ ...png(2), chunks: 2 }); // declared size 2
    host.attachChunk(buildChunkPayload("u1", 0, new Uint8Array([1, 2])));
    // chunk 1 で累積 4 byte に乗ろうとする — declared(2) 超過で reject
    host.attachChunk(buildChunkPayload("u1", 1, new Uint8Array([3, 4])));
    // エントリは破棄、後続 chunk も無視
    host.attachChunk(buildChunkPayload("u1", 1, new Uint8Array([5, 6])));
    host.close();
    await done;
    expect(rejected.length).toBe(1);
    expect(rejected[0]!.payload).toMatchObject({
      upload_id: "u1",
      reason: "size_over",
    });
  });

  it("tickGC は addedAt + TTL を超えたエントリを timeout で drop (F13)", async () => {
    let t = 1_000_000;
    const rejected: Envelope[] = [];
    const host = new AgentHost(config, {
      onState: () => {},
      onAttachRejected: (e) => rejected.push(e),
      queryFn: captureQueryFn([]),
      now: () => "T",
      nowMs: () => t,
    });
    const done = host.run();
    host.attachOpen({
      upload_id: "old",
      filename: "x.png",
      mime: "image/png",
      size: 1,
      chunks: 1,
    });
    // Advance past TTL — use the exported constant so a TTL change in
    // upload.ts cannot silently keep this test green at the old boundary.
    t += PENDING_UPLOAD_TTL_MS + 1_000;
    host.attachOpen({
      upload_id: "fresh",
      filename: "y.png",
      mime: "image/png",
      size: 1,
      chunks: 1,
    });
    host.tickGC();
    host.close();
    await done;

    // 'old' は TTL 超え、 'fresh' は同じ tick(中の addedAt) なので残る
    expect(rejected.length).toBe(1);
    expect(rejected[0]!.payload).toMatchObject({
      upload_id: "old",
      reason: "timeout",
    });
  });

  it("tickGC は TTL 未満なら no-op", async () => {
    let t = 1_000_000;
    const rejected: Envelope[] = [];
    const host = new AgentHost(config, {
      onState: () => {},
      onAttachRejected: (e) => rejected.push(e),
      queryFn: captureQueryFn([]),
      now: () => "T",
      nowMs: () => t,
    });
    const done = host.run();
    host.attachOpen({
      upload_id: "u",
      filename: "x.png",
      mime: "image/png",
      size: 1,
      chunks: 1,
    });
    t += 60_000; // 1 min — well under 5 min TTL
    host.tickGC();
    host.close();
    await done;
    expect(rejected).toEqual([]);
  });

  it("interrupt は pending_uploads を全 drop し attach_rejected{interrupted} を per-id 発火 (F11)", async () => {
    const rejected: Envelope[] = [];
    const interruptSpy = vi.fn(async () => {});
    const queryFn = makeQueryFn((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        for await (const _ of args.prompt) void _;
      }
      return asQuery(gen(), interruptSpy);
    });
    const host = new AgentHost(config, {
      onState: () => {},
      onAttachRejected: (e) => rejected.push(e),
      queryFn,
      now: () => "T",
    });
    const done = host.run();
    host.attachOpen({
      upload_id: "ua",
      filename: "a.png",
      mime: "image/png",
      size: 1,
      chunks: 1,
    });
    host.attachOpen({
      upload_id: "ub",
      filename: "b.png",
      mime: "image/png",
      size: 1,
      chunks: 1,
    });
    // Close 前なので sealed ではないが、 interrupt は sealed 問わず全 drop
    await host.interrupt();
    host.close();
    await done;

    expect(interruptSpy).toHaveBeenCalledOnce();
    // 2 件分の interrupted reject(順序は Map イテレーション順)
    expect(rejected.length).toBe(2);
    expect(
      rejected.map((e) => (e.payload as { reason: string }).reason),
    ).toEqual(["interrupted", "interrupted"]);
    expect(
      new Set(
        rejected.map((e) => (e.payload as { upload_id: string }).upload_id),
      ),
    ).toEqual(new Set(["ua", "ub"]));
  });

  it("interrupt は sealed 済みエントリも drop する", async () => {
    // Close 後の sealed エントリも pending_uploads に残っているので
    // interrupt の対象になる。 unsealed の loop と同じ keys() 走査でも
    // sealed 経路の coverage を直接 担保する。
    const rejected: Envelope[] = [];
    const interruptSpy = vi.fn(async () => {});
    const queryFn = makeQueryFn((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        for await (const _ of args.prompt) void _;
      }
      return asQuery(gen(), interruptSpy);
    });
    const host = new AgentHost(config, {
      onState: () => {},
      onAttachRejected: (e) => rejected.push(e),
      queryFn,
      now: () => "T",
    });
    const done = host.run();
    host.attachOpen(png(2));
    host.attachChunk(buildChunkPayload("u1", 0, new Uint8Array([1, 2])));
    host.attachClose("u1"); // seals
    await host.interrupt();
    host.close();
    await done;

    expect(interruptSpy).toHaveBeenCalledOnce();
    expect(rejected.length).toBe(1);
    expect(rejected[0]!.payload).toMatchObject({
      upload_id: "u1",
      reason: "interrupted",
    });
  });

  it("interrupt は pending_uploads 空なら attach_rejected を出さない(前方互換)", async () => {
    const rejected: Envelope[] = [];
    const interruptSpy = vi.fn(async () => {});
    const queryFn = makeQueryFn((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        for await (const _ of args.prompt) void _;
      }
      return asQuery(gen(), interruptSpy);
    });
    const host = new AgentHost(config, {
      onState: () => {},
      onAttachRejected: (e) => rejected.push(e),
      queryFn,
      now: () => "T",
    });
    const done = host.run();
    await host.interrupt();
    host.close();
    await done;
    expect(interruptSpy).toHaveBeenCalledOnce();
    expect(rejected).toEqual([]);
  });

  it("chunk_index >= meta.chunks は無視(out-of-bounds)", async () => {
    const rejected: Envelope[] = [];
    const host = new AgentHost(config, {
      onState: () => {},
      onAttachRejected: (e) => rejected.push(e),
      queryFn: captureQueryFn([]),
      now: () => "T",
    });
    const done = host.run();
    host.attachOpen({ ...png(1), chunks: 1 });
    // chunk_index=5 は宣言された 1 chunk を超えるので無視
    host.attachChunk(buildChunkPayload("u1", 5, new Uint8Array([1, 2, 3])));
    host.close();
    await done;
    expect(rejected.length).toBe(0);
  });

  it("in-flight 上限(20)に達した attachOpen は count_over で reject", async () => {
    const rejected: Envelope[] = [];
    const host = new AgentHost(config, {
      onState: () => {},
      onAttachRejected: (e) => rejected.push(e),
      queryFn: captureQueryFn([]),
      now: () => "T",
    });
    const done = host.run();
    // 20 件まで受理(chunks=1 のまま close せず in-flight に積む)
    for (let i = 0; i < 20; i++) {
      host.attachOpen({
        upload_id: `u${i}`,
        filename: `a${i}.png`,
        mime: "image/png",
        size: 1,
        chunks: 1,
      });
    }
    // 21 件目は cap で reject
    host.attachOpen({
      upload_id: "u20",
      filename: "overflow.png",
      mime: "image/png",
      size: 1,
      chunks: 1,
    });
    host.close();
    await done;
    expect(rejected.length).toBe(1);
    expect(rejected[0]!.payload).toMatchObject({
      upload_id: "u20",
      reason: "count_over",
    });
  });

  it("application/pdf の添付は fit-to-SDK 後 document block として SDK へ渡る", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]).drawText("hi");
    const body = await pdf.save();

    const captured: SDKUserMessage[] = [];
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn: captureQueryFn(captured),
      now: () => "T",
    });
    const done = host.run();
    host.attachOpen({
      upload_id: "u1",
      filename: "report.pdf",
      mime: "application/pdf",
      size: body.byteLength,
      chunks: 1,
    });
    host.attachChunk(buildChunkPayload("u1", 0, body));
    host.attachClose("u1");
    await host.send("レビューして", ["u1"]);
    host.close();
    await done;

    expect(captured.length).toBe(1);
    const content = captured[0]!.message.content as Array<{
      type: string;
      source?: { media_type?: string };
      text?: string;
    }>;
    expect(content[0]?.type).toBe("document");
    expect(content[0]?.source?.media_type).toBe("application/pdf");
    expect(content[1]).toEqual({ type: "text", text: "レビューして" });
  });

  it("text/plain の添付は text block(filename prefix 付き)として SDK へ渡る", async () => {
    const captured: SDKUserMessage[] = [];
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn: captureQueryFn(captured),
      now: () => "T",
    });
    const done = host.run();
    const body = new TextEncoder().encode("hello\nworld");
    host.attachOpen({
      upload_id: "u1",
      filename: "greet.txt",
      mime: "text/plain",
      size: body.byteLength,
      chunks: 1,
    });
    host.attachChunk(buildChunkPayload("u1", 0, body));
    host.attachClose("u1");
    await host.send("これ要約して", ["u1"]);
    host.close();
    await done;

    expect(captured.length).toBe(1);
    expect(captured[0]!.message.content).toEqual([
      { type: "text", text: "[file: greet.txt]\nhello\nworld" },
      { type: "text", text: "これ要約して" },
    ]);
  });

  it("合計 base64 サイズが 32 MB 超なら total_request_over で reject(消費せず)", async () => {
    // 合計 32 MB 超を 1 件の text 添付で再現する(text block は raw、
    // image/document は base64 後だが、 wireSize 計算は同じ式)。 text
    // bytes 33 MB → renderTextBlock が 1 MB に truncate → 約 1 MB の
    // text block しか出来ない、 のでこのケースは合計超えない。 そこで
    // 直接 image branch を使う: pass-through downsizer 越しに 33 MB の
    // image bytes を仕立て、 base64 後 ~44 MB で 32 MB 超を踏ませる。
    setDefaultImageDownsizer({
      fit: async (bytes, mime) => ({ bytes, mime }),
    });
    const captured: SDKUserMessage[] = [];
    const rejected: Envelope[] = [];
    const host = new AgentHost(config, {
      onState: () => {},
      onInstructionRejected: (e) => rejected.push(e),
      queryFn: captureQueryFn(captured),
      now: () => "T",
    });
    const done = host.run();
    const bigChunk = new Uint8Array(33 * 1024 * 1024);
    host.attachOpen({
      upload_id: "u1",
      filename: "big.png",
      mime: "image/png",
      size: bigChunk.byteLength,
      chunks: 1,
    });
    host.attachChunk(buildChunkPayload("u1", 0, bigChunk));
    host.attachClose("u1");
    await host.send("見て", ["u1"]);
    // 非消費の証拠: 直後に再 send しても resolveAttachments が同じ
    // upload_id を見つけ、 同じ total_request_over で再 reject される。
    // 消費されていたら 2 回目は timeout (unknown upload_id) で reject
    // されるので、 reason の同一性 = 非消費 atomicity の証明。
    await host.send("もう一度", ["u1"]);
    host.close();
    await done;

    expect(captured.length).toBe(0); // not queued
    expect(rejected.length).toBe(2);
    expect(rejected[0]!.payload).toMatchObject({
      attachment_ids: ["u1"],
      reason: "total_request_over",
    });
    expect(rejected[1]!.payload).toMatchObject({
      attachment_ids: ["u1"],
      reason: "total_request_over",
    });
  });

  it("instruction の attachment_ids が 10 件超なら count_over で reject(消費せず)", async () => {
    const captured: SDKUserMessage[] = [];
    const rejected: Envelope[] = [];
    const host = new AgentHost(config, {
      onState: () => {},
      onInstructionRejected: (e) => rejected.push(e),
      queryFn: captureQueryFn(captured),
      now: () => "T",
    });
    const done = host.run();
    // 11 件のダミー id を渡す(pending_uploads 不在でも cap が先に弾く)
    const ids = Array.from({ length: 11 }, (_, i) => `u${i}`);
    host.send("見て", ids);
    host.close();
    await done;
    expect(captured.length).toBe(0);
    expect(rejected.length).toBe(1);
    expect(rejected[0]!.payload).toMatchObject({
      attachment_ids: ids,
      reason: "count_over",
    });
  });
});
