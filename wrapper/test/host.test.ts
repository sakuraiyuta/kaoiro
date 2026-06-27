import { describe, expect, it, vi } from "vitest";
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { AgentHost } from "../src/host.js";
import type { AgentHostOptions } from "../src/host.js";
import type { Envelope, WrapperConfig } from "../src/types.js";
import { buildChunkPayload } from "./helpers.js";

const config: WrapperConfig = {
  agent_id: "test.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
};

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
        five_hour: { status: "allowed", utilization: 0.5, resets_at: 1781480000 },
      },
    });
  });

  it("init メッセージから ext.model / ext.cwd を付与する (#16)", async () => {
    const envs: Envelope[] = [];
    const host = new AgentHost(config, {
      onState: (e) => envs.push(e),
      queryFn: scriptedQuery([
        msg({ type: "system", subtype: "init", model: "claude-x", cwd: "/repo" }),
        assistant([{ type: "text", text: "hi" }]),
      ]),
      now: () => "T",
    });
    await host.run();
    const e = envs.find((env) => env.state === "thinking");
    expect(e?.ext).toMatchObject({ model: "claude-x", cwd: "/repo" });
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
      return asQuery(gen(), async () => {}, async () => usage);
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

  it("SDK の session_id を onSessionId で報告し、変化時のみ再通知する (ADR-0014)", async () => {
    const ids: string[] = [];
    const host = new AgentHost(config, {
      onState: () => {},
      onSessionId: (id) => ids.push(id),
      queryFn: scriptedQuery([
        msg({ type: "system", subtype: "init", session_id: "sess-1" }),
        // Same id: must not re-notify. A helper-built message carries none.
        msg({ type: "assistant", session_id: "sess-1", message: { content: [] } }),
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
      return asQuery(gen(), async () => {}, async () => {
        throw new Error("context usage unavailable");
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

describe("AgentHost — permission", () => {
  it("decidePermission が waiting_permission→tool_running を駆動する(allow)", async () => {
    const states: string[] = [];
    let toolResultYielded = false;
    const queryFn = makeQueryFn((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield assistant([
          { type: "tool_use", id: "tu_1", name: "Read", input: {} },
        ]);
        const decision = await args.options.canUseTool!("Read", {}, {} as never);
        if (decision.behavior === "allow") {
          toolResultYielded = true;
          yield user([{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }]);
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
        const decision = await args.options.canUseTool!("Read", {}, {} as never);
        behavior = decision.behavior;
        yield result("success", { result: "x" });
      }
      return asQuery(gen());
    });

    const host = new AgentHost(config, { onState: () => {}, queryFn, now: () => "T" });
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
        const decision = await args.options.canUseTool!("Read", {}, {} as never);
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

    const host = new AgentHost(config, { onState: () => {}, queryFn, now: () => "T" });
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

  it("close 後の send は投げる", () => {
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn: scriptedQuery([]),
      now: () => "T",
    });
    host.close();
    expect(() => host.send("x")).toThrow(/closed/);
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

    const host = new AgentHost(config, { onState: () => {}, queryFn, now: () => "T" });
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
    const host = new AgentHost(config, { onState: () => {}, queryFn, now: () => "T" });
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

  it("setModel は query.setModel へエイリアスを委譲する", async () => {
    const setModel = vi.fn(async () => {});
    const queryFn = makeQueryFn((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        for await (const _ of args.prompt) void _;
      }
      return asQuery(gen(), async () => {}, undefined, { setModel });
    });
    const host = new AgentHost(config, { onState: () => {}, queryFn, now: () => "T" });
    const done = host.run();
    await host.setModel("opus[1m]");
    expect(setModel).toHaveBeenCalledWith("opus[1m]");
    host.close();
    await done;
  });

  it("setEffort は applyFlagSettings({ effortLevel }) へ委譲する (max 含む)", async () => {
    const applyFlagSettings = vi.fn(async () => {});
    const queryFn = makeQueryFn((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        for await (const _ of args.prompt) void _;
      }
      return asQuery(gen(), async () => {}, undefined, { applyFlagSettings });
    });
    const host = new AgentHost(config, { onState: () => {}, queryFn, now: () => "T" });
    const done = host.run();
    await host.setEffort("max");
    expect(applyFlagSettings).toHaveBeenCalledWith({ effortLevel: "max" });
    host.close();
    await done;
  });

  it("setModel / setEffort は run 前は no-op", async () => {
    // Symmetric with interrupt: #query is null before run(), so the
    // optional-chain makes the control a no-op the server can relay into.
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn: scriptedQuery([]),
      now: () => "T",
    });
    await expect(host.setModel("opus")).resolves.toBeUndefined();
    await expect(host.setEffort("high")).resolves.toBeUndefined();
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
    const host = new AgentHost(config, { onState: () => {}, queryFn, now: () => "T" });
    await expect(host.run()).resolves.toBeUndefined();
  });
});

describe("AgentHost — ファイルアップロード (ADR-0025 phase-0)", () => {
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

  const png = (size = 3) =>
    ({
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
    host.send("見て", ["u1"]);
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
    host.send("", ["u1"]);
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
      size: 1024 * 1024 * 1024, // 1 GB > 5 MB phase-0 cap
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
    host.send("a", ["u1"]); // consumes
    host.send("b", ["u1"]); // u1 no longer in pendingUploads -> rejected
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
    host.send("", ["u1"]);
    host.close();
    await done;

    expect(rejected.length).toBe(0); // chunk silently dropped
    const block = (captured[0]!.message.content as unknown as Array<{
      source?: { data: string };
    }>)[0];
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
});
