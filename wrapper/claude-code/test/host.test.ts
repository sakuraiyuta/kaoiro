import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EffortLevel,
  ModelInfo,
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
        supports_context_usage: true,
      },
    });
    expect(
      (initial.ext.models as { value: string }[]).map((m) => m.value),
    ).toEqual(["default"]);
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

  // phase-28 A2 (#168): 自分の context を whoami で見られるようにする。
  it("context 未取得なら key ごと省略する (absent = unknown)", () => {
    const host = new AgentHost(config, { onState: () => {} });
    expect(host.statusSnapshot()).not.toHaveProperty("context");
  });

  it("getContextUsage 済みなら whoami に context が載る", async () => {
    const queryFn = makeQueryFn(() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield result("success", { result: "ok" });
      }
      return asQuery(gen(), async () => {}, async () => ({
        totalTokens: 42000,
        maxTokens: 200000,
        percentage: 21,
      }));
    });
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn,
      now: () => "T",
    });
    await host.run();
    expect(host.statusSnapshot()).toMatchObject({
      context: { used_tokens: 42000, max_tokens: 200000, used_percentage: 21 },
    });
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

  // phase-28 A1 (#168). Message order mirrors Track S's measurement.
  it("compact の一連イベントを kind=system の log として中継する", async () => {
    const logs: Envelope[] = [];
    const host = new AgentHost(config, {
      onState: () => {},
      onLog: (e) => logs.push(e),
      queryFn: scriptedQuery([
        msg({ type: "system", subtype: "status", status: "compacting" }),
        msg({
          type: "system",
          subtype: "status",
          status: null,
          compact_result: "success",
        }),
        msg({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: {
            trigger: "auto",
            pre_tokens: 180000,
            post_tokens: 9000,
          },
        }),
        msg({ type: "conversation_reset", new_conversation_id: "c-2" }),
        result("success", { result: "" }),
      ]),
      now: () => "T",
    });
    await host.run();

    // compact_result=success は boundary と重複するので中継しない。
    expect(
      logs.filter((l) => l.payload.kind === "system").map((l) => l.payload.text),
    ).toEqual([
      "コンテキストを圧縮しています…",
      "自動コンテキスト圧縮が完了しました (前 180000 tokens → 後 9000 tokens)",
      "会話がリセットされました (c-2)",
    ]);
  });

  it("compact_boundary は context refresh を kick する (#168)", async () => {
    const getContextUsage = vi.fn(async () => ({
      totalTokens: 9000,
      maxTokens: 200000,
      percentage: 5,
    }));
    const queryFn = makeQueryFn(() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield msg({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "manual", pre_tokens: 22315 },
        });
      }
      return asQuery(gen(), async () => {}, getContextUsage);
    });
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn,
      now: () => "T",
    });
    await host.run();
    // Track S: 直後値は減少を反映しないので、これは meter の eventual な
    // 更新のための kick。呼ばれること自体を pin する。
    expect(getContextUsage).toHaveBeenCalled();
  });

  // 藤 review MF1: boundary / reset は context epoch の確定境界。generation を
  // 上げないと、境界前から in-flight の応答が境界後に landing して圧縮前の値が
  // 残る。setModel と同じ invalidate を踏むことを pin する。
  it("compact_boundary は取得済み context を retract する (MF1)", async () => {
    const envs: Envelope[] = [];
    const pre = { totalTokens: 180000, maxTokens: 200000, percentage: 90 };
    let call = 0;
    // 境界後の refresh は決着させない — 「次の計測が成功するまで absent」を
    // 決定論的に観測するため。
    const getContextUsage = vi.fn(async () => {
      call += 1;
      if (call === 1) return pre;
      await new Promise(() => {});
      return pre;
    });
    const queryFn = makeQueryFn(() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield result("success", { result: "ok" });
        // 圧縮前の値が #context に載るまで待つ。
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield msg({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "auto", pre_tokens: 180000 },
        });
      }
      return asQuery(gen(), async () => {}, getContextUsage);
    });
    const host = new AgentHost(config, {
      onState: (e) => envs.push(e),
      queryFn,
      now: () => "T",
    });
    await host.run();
    const ctxOf = (e: Envelope) =>
      (e.ext as { context?: { used_tokens?: number } }).context;
    // 境界前は圧縮前の値が載り、境界を跨いだ最後の envelope では消えている。
    expect(envs.some((e) => ctxOf(e)?.used_tokens === 180000)).toBe(true);
    expect(ctxOf(envs.at(-1) as Envelope)).toBeUndefined();
  });

  it("境界前 inflight の応答は epoch 不一致で採用しない (MF1)", async () => {
    const stale = { totalTokens: 180000, maxTokens: 200000, percentage: 90 };
    let releaseStale: () => void = () => {};
    const stalePending = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    let call = 0;
    // 境界後の refresh は決着させない。こうすると #context に入りうる値は
    // 境界前 inflight の stale だけになり、「捨てられた」ことを直接観測できる
    // (境界後に fresh を返させると、fix の有無に関わらず最終値が fresh に
    // なってしまい MF1 を差別化できない)。
    const getContextUsage = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        // 境界前に発火した refresh。境界を跨いでから resolve させる。
        await stalePending;
        return stale;
      }
      await new Promise(() => {});
      return stale;
    });
    const queryFn = makeQueryFn(() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield result("success", { result: "ok" });
        await new Promise((resolve) => setTimeout(resolve, 10));
        yield msg({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "manual", pre_tokens: 180000 },
        });
        releaseStale();
        // stale が resolve して landing しうる猶予を与える。
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return asQuery(gen(), async () => {}, getContextUsage);
    });
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn,
      now: () => "T",
    });
    await host.run();
    expect(getContextUsage.mock.calls.length).toBeGreaterThanOrEqual(2);
    // 圧縮前の epoch で測った値は、境界後に届いても採用されない。
    expect(host.statusSnapshot()).not.toHaveProperty("context");
  });

  it("conversation_reset も context epoch を切る (MF1)", async () => {
    const envs: Envelope[] = [];
    const pre = { totalTokens: 50000, maxTokens: 200000, percentage: 25 };
    let call = 0;
    const getContextUsage = vi.fn(async () => {
      call += 1;
      if (call === 1) return pre;
      await new Promise(() => {});
      return pre;
    });
    const queryFn = makeQueryFn(() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield result("success", { result: "ok" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield msg({ type: "conversation_reset", new_conversation_id: "c-3" });
      }
      return asQuery(gen(), async () => {}, getContextUsage);
    });
    const host = new AgentHost(config, {
      onState: (e) => envs.push(e),
      queryFn,
      now: () => "T",
    });
    await host.run();
    const ctxOf = (e: Envelope) =>
      (e.ext as { context?: { used_tokens?: number } }).context;
    // reset 前には載っていた値が、reset 後の envelope では消えている。
    expect(envs.some((e) => ctxOf(e)?.used_tokens === 50000)).toBe(true);
    expect(ctxOf(envs.at(-1) as Envelope)).toBeUndefined();
  });

  // phase-28 B1 (#168 P3): 閾値超過を epoch あたり 1 回だけ agent へ通知する。
  // 注入は instruction queue 経由なので、SDK には user turn として現れる。
  function contextQueryFn(
    usages: { totalTokens: number; maxTokens: number; percentage: number }[],
    script: () => AsyncGenerator<SDKMessage, void>,
  ): { queryFn: QueryFn; injected: string[] } {
    const injected: string[] = [];
    let call = 0;
    const queryFn = makeQueryFn((args: QueryArgs) => {
      // Drain the input stream so queued turns (the B1 notice among them)
      // are observable — the host only injects, it never renders.
      void (async () => {
        for await (const turn of args.prompt) {
          const content = turn.message.content;
          if (typeof content === "string") injected.push(content);
        }
      })();
      return asQuery(
        script(),
        async () => {},
        async () => usages[Math.min(call++, usages.length - 1)],
      );
    });
    return { queryFn, injected };
  }

  it("閾値超過で通知を 1 回だけ注入する (B1)", async () => {
    const { queryFn, injected } = contextQueryFn(
      [
        { totalTokens: 150000, maxTokens: 200000, percentage: 75 },
        { totalTokens: 160000, maxTokens: 200000, percentage: 80 },
      ],
      async function* () {
        yield result("success", { result: "1" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield result("success", { result: "2" });
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    );
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn,
      now: () => "T",
    });
    await host.run();
    // 2 回目の refresh (80%) では再送しない — epoch あたり 1 回。
    const notices = injected.filter((t) => t.startsWith("[kaoiro] Context"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("75%");
    expect(notices[0]).toContain("request_compact");
    // 切迫を煽らない文言であること (P3)。
    expect(notices[0]).toContain("There is no need to act now");
  });

  it("閾値未満では注入しない (B1)", async () => {
    const { queryFn, injected } = contextQueryFn(
      [{ totalTokens: 100000, maxTokens: 200000, percentage: 50 }],
      async function* () {
        yield result("success", { result: "1" });
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    );
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn,
      now: () => "T",
    });
    await host.run();
    expect(injected.filter((t) => t.startsWith("[kaoiro] Context"))).toEqual(
      [],
    );
  });

  // BR MF1 (a): 境界直後の `getContextUsage()` は圧縮前の総量を返し得る
  // (Track S 実測)。その値で 2 通目を出すと、たった今 compact した使用量に
  // ついてもう一度警告することになる。**この 3 本は元々「境界直後の 78%
  // で 2 通目が出る」を期待していた旧テストの置き換えであり、旧版は誤動作
  // の方を pin していた** (BR MF1)。
  it("境界直後の stale な reading では 2 通目を出さない (MF1-a)", async () => {
    const { queryFn, injected } = contextQueryFn(
      [
        { totalTokens: 150000, maxTokens: 200000, percentage: 75 },
        // 境界を跨いでも SDK がまだ返してくる圧縮前の値。閾値超えだが、
        // 新 epoch の実態を表していないので通知の根拠にならない。
        { totalTokens: 155000, maxTokens: 200000, percentage: 78 },
      ],
      async function* () {
        yield result("success", { result: "1" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield msg({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "manual", pre_tokens: 150000 },
        });
        await new Promise((resolve) => setTimeout(resolve, 40));
      },
    );
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn,
      now: () => "T",
    });
    await host.run();
    const notices = injected.filter((t) => t.startsWith("[kaoiro] Context"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("75%");
    expect(notices.some((t) => t.includes("78%"))).toBe(false);
  });

  // BR MF1-R 反例 1: 直前 epoch に成功 reading が無くても、境界直後の
  // reading が stale high である可能性は消えない。「比較対象が無いから
  // 確定扱い」にすると、そこで誤通知できてしまう。
  it("直前 epoch に reading が無くても境界直後の stale では通知しない (MF1-R)", async () => {
    const { queryFn, injected } = contextQueryFn(
      // この epoch で取れる唯一の reading。閾値超えだが圧縮前の値。
      [{ totalTokens: 155000, maxTokens: 200000, percentage: 78 }],
      async function* () {
        // result より先に境界が来る = 直前 epoch の cached reading が無い。
        yield msg({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "manual", pre_tokens: 150000 },
        });
        await new Promise((resolve) => setTimeout(resolve, 40));
      },
    );
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn,
      now: () => "T",
    });
    await host.run();
    expect(injected.filter((t) => t.startsWith("[kaoiro] Context"))).toEqual(
      [],
    );
  });

  // BR MF1-R 反例 2: 観測は離散なので、境界後の reading が一度も
  // `atOrBelow` を下回らない列は普通に成立する (大きな turn が挟まる等)。
  // 大小比較だけを確定条件にすると、その epoch の正当な通知が永久に
  // 出なくなる。readings 上限がその liveness を担保する。
  it("観測列が終始 atOrBelow を上回っても永久 mute にしない (MF1-R)", async () => {
    const { queryFn, injected } = contextQueryFn(
      [
        { totalTokens: 150000, maxTokens: 200000, percentage: 75 },
        // 以降すべて pre_tokens 以上のまま推移する。
        { totalTokens: 155000, maxTokens: 200000, percentage: 78 },
        { totalTokens: 158000, maxTokens: 200000, percentage: 79 },
        { totalTokens: 160000, maxTokens: 200000, percentage: 80 },
      ],
      async function* () {
        yield result("success", { result: "1" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield msg({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "manual", pre_tokens: 150000 },
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield result("success", { result: "2" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield result("success", { result: "3" });
        await new Promise((resolve) => setTimeout(resolve, 40));
      },
    );
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn,
      now: () => "T",
    });
    await host.run();
    const notices = injected.filter((t) => t.startsWith("[kaoiro] Context"));
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain("75%");
    // 3 回目の reading で allowance を使い切り、そこで通知が復活する。
    expect(notices[1]).toContain("80%");
  });

  // BR MF1-R2: settle counter は「値が変化した reading」ではなく
  // 「計測回数」でなければならない。圧縮しても使用量が同じ高い値に
  // 貼り付いたままの列では、equality dedup が先に効くと counter が
  // 一度も進まず liveness bound が成立しない。
  it("同値の reading でも settle counter は進む (MF1-R2)", async () => {
    const { queryFn, injected } = contextQueryFn(
      [
        // 境界後、まったく同じ high 値が 3 回返る。
        { totalTokens: 155000, maxTokens: 200000, percentage: 78 },
      ],
      async function* () {
        yield msg({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "manual", pre_tokens: 150000 },
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield result("success", { result: "1" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield result("success", { result: "2" });
        await new Promise((resolve) => setTimeout(resolve, 40));
      },
    );
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn,
      now: () => "T",
    });
    await host.run();
    const notices = injected.filter((t) => t.startsWith("[kaoiro] Context"));
    // 1・2 回目は未確定で無通知、3 回目で allowance を使い切り 1 通出る。
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("78%");
  });

  // BR MF1-R: post_tokens が報告された境界では、それが新 epoch の
  // 権威ある基準になる。allowance を使い切るまで待たずに 1 回目の
  // reading で確定する。
  it("post_tokens があれば最初の reading で確定する (MF1-R)", async () => {
    const { queryFn, injected } = contextQueryFn(
      [
        { totalTokens: 150000, maxTokens: 200000, percentage: 75 },
        { totalTokens: 9000, maxTokens: 200000, percentage: 5 },
        { totalTokens: 145000, maxTokens: 200000, percentage: 72 },
      ],
      async function* () {
        yield result("success", { result: "1" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield msg({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: {
            trigger: "manual",
            pre_tokens: 150000,
            post_tokens: 9000,
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield result("success", { result: "2" });
        await new Promise((resolve) => setTimeout(resolve, 40));
      },
    );
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn,
      now: () => "T",
    });
    await host.run();
    const notices = injected.filter((t) => t.startsWith("[kaoiro] Context"));
    expect(notices).toHaveLength(2);
    expect(notices[1]).toContain("72%");
  });

  // BR MF1 (b): 圧縮が見えた reading を観測して初めて新 epoch の判定を
  // 再開し、そこから改めて閾値を跨いだときだけ 1 通出す。
  it("信頼できる post 値の後に閾値を跨いだときだけ次の 1 通を出す (MF1-b)", async () => {
    const { queryFn, injected } = contextQueryFn(
      [
        { totalTokens: 150000, maxTokens: 200000, percentage: 75 },
        { totalTokens: 155000, maxTokens: 200000, percentage: 78 }, // stale
        { totalTokens: 20000, maxTokens: 200000, percentage: 10 }, // 圧縮確認
        { totalTokens: 146000, maxTokens: 200000, percentage: 73 }, // 再超過
      ],
      async function* () {
        yield result("success", { result: "1" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield msg({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "manual", pre_tokens: 150000 },
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield result("success", { result: "2" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield result("success", { result: "3" });
        await new Promise((resolve) => setTimeout(resolve, 40));
      },
    );
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn,
      now: () => "T",
    });
    await host.run();
    const notices = injected.filter((t) => t.startsWith("[kaoiro] Context"));
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain("75%");
    expect(notices[1]).toContain("73%");
  });

  // BR MF1 (c): compact が予約され境界が来た epoch の通知は、queue で
  // 順番待ちしている間に無効になる。後追いで注入してはいけない。
  it("epoch が変わった後の通知は queue から破棄する (MF1-c / MF2)", async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const { queryFn, injected } = contextQueryFn(
      [
        { totalTokens: 150000, maxTokens: 200000, percentage: 75 },
        { totalTokens: 20000, maxTokens: 200000, percentage: 10 },
      ],
      async function* () {
        yield result("success", { result: "1" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield msg({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "manual", pre_tokens: 150000 },
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        // 境界が確定してから初めて queue を流す。
        releaseGate();
        await new Promise((resolve) => setTimeout(resolve, 40));
      },
    );
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn,
      now: () => "T",
      enqueueInjection: async (task) => {
        await gate;
        await task();
      },
    });
    await host.run();
    expect(injected.filter((t) => t.startsWith("[kaoiro] Context"))).toEqual(
      [],
    );
  });

  // BR MF2: 通知は operator instruction と同じ直列化に乗る。先に積まれた
  // 遅い send を追い越して SDK 入力ストリームへ出てはいけない。
  it("先行する遅い send を追い越さない (MF2)", async () => {
    let host!: AgentHost;
    let chain: Promise<void> = Promise.resolve();
    const enqueueInjection = (task: () => Promise<void>): Promise<void> => {
      const queued = chain.then(task);
      chain = queued.catch(() => {});
      return queued;
    };
    const { queryFn, injected } = contextQueryFn(
      [{ totalTokens: 150000, maxTokens: 200000, percentage: 75 }],
      async function* () {
        yield result("success", { result: "1" });
        await new Promise((resolve) => setTimeout(resolve, 120));
      },
    );
    host = new AgentHost(config, {
      onState: () => {},
      queryFn,
      now: () => "T",
      enqueueInjection,
    });
    // 大きな添付のレンダリングなどで詰まった先行 instruction を模す。
    void enqueueInjection(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      await host.send("prior instruction");
    });
    await host.run();
    const noticeAt = injected.findIndex((t) =>
      t.startsWith("[kaoiro] Context"),
    );
    expect(noticeAt).toBeGreaterThan(-1);
    expect(injected.indexOf("prior instruction")).toBeLessThan(noticeAt);
  });

  // BR MF2: 同一 epoch での queue 失敗は budget を戻す — 通知 1 通を
  // 届かなかった send に食わせない。
  it("同 epoch の queue 失敗は次の変化した reading で再送する (MF2)", async () => {
    let call = 0;
    const { queryFn, injected } = contextQueryFn(
      [
        { totalTokens: 150000, maxTokens: 200000, percentage: 75 },
        { totalTokens: 160000, maxTokens: 200000, percentage: 80 },
      ],
      async function* () {
        yield result("success", { result: "1" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield result("success", { result: "2" });
        await new Promise((resolve) => setTimeout(resolve, 40));
      },
    );
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn,
      now: () => "T",
      enqueueInjection: (task) => {
        call += 1;
        return call === 1
          ? Promise.reject(new Error("queue full"))
          : task();
      },
    });
    await host.run();
    const notices = injected.filter((t) => t.startsWith("[kaoiro] Context"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("80%");
  });

  // BR MF2: 旧 epoch の遅延 reject が、新 epoch が既に確保した budget を
  // 巻き戻してはいけない (巻き戻すと新 epoch で 2 通目が出る)。
  it("旧 epoch の遅延 reject は新 epoch の budget を戻さない (MF2)", async () => {
    let rejectStale!: (err: Error) => void;
    let call = 0;
    const { queryFn, injected } = contextQueryFn(
      [
        { totalTokens: 150000, maxTokens: 200000, percentage: 75 },
        { totalTokens: 20000, maxTokens: 200000, percentage: 10 }, // 圧縮確認
        { totalTokens: 150000, maxTokens: 200000, percentage: 75 }, // 再超過
        { totalTokens: 160000, maxTokens: 200000, percentage: 80 },
      ],
      async function* () {
        yield result("success", { result: "1" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield msg({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "manual", pre_tokens: 150000 },
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield result("success", { result: "2" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield result("success", { result: "3" });
        await new Promise((resolve) => setTimeout(resolve, 40));
      },
    );
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn,
      now: () => "T",
      enqueueInjection: (task) => {
        call += 1;
        // 1 本目 (旧 epoch) は宙吊りにし、新 epoch が通知を確保した直後に
        // 初めて reject させる。
        if (call === 1) {
          return new Promise<void>((_resolve, reject) => {
            rejectStale = reject;
          });
        }
        return task().then(() => rejectStale(new Error("late")));
      },
    });
    await host.run();
    const notices = injected.filter((t) => t.startsWith("[kaoiro] Context"));
    // 新 epoch の 1 通だけ。80% の reading で 2 通目が出ていない。
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("75%");
    expect(notices.some((t) => t.includes("80%"))).toBe(false);
  });

  // 藤 review S1: compact_error は SDK 由来の任意長文字列。log 上限を
  // 素通りしないことを path 全体で pin する。
  it("巨大な compact_error は system log として clip される (S1)", async () => {
    const logs: Envelope[] = [];
    const host = new AgentHost(config, {
      onState: () => {},
      onLog: (e) => logs.push(e),
      queryFn: scriptedQuery([
        msg({
          type: "system",
          subtype: "status",
          status: null,
          compact_result: "failed",
          compact_error: "e".repeat(20_000),
        }),
      ]),
      now: () => "T",
    });
    await host.run();
    const line = logs.find((l) => l.payload.kind === "system");
    expect(line?.payload.truncated).toBe(true);
    expect(
      Buffer.byteLength(line?.payload.text as string, "utf8"),
    ).toBeLessThanOrEqual(16_384);
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

  it("error result は payload に is_error / error_subtype / error_detail を relay (issue #127)", async () => {
    const logs: Envelope[] = [];
    const host = new AgentHost(config, {
      onState: () => {},
      onLog: (e) => logs.push(e),
      queryFn: scriptedQuery([
        result("error_during_execution", {
          errors: ["tool crashed: EACCES"],
        }),
      ]),
      now: () => "T",
    });
    await host.run();
    const res = logs.find((l) => l.type === "result");
    expect(res?.payload).toEqual({
      is_error: true,
      error_subtype: "error_during_execution",
      error_detail: "tool crashed: EACCES",
    });
  });

  it("error result は onTurnEnd に conversationId=null(未タグ) + terminal_reason/error_detail を渡す (issue #131)", async () => {
    const turnEnds: {
      conversationId: string | null;
      error?: { reason?: string; detail?: string };
    }[] = [];
    const host = new AgentHost(config, {
      onState: () => {},
      onTurnEnd: (info) => turnEnds.push(info),
      queryFn: scriptedQuery([
        result("error_during_execution", {
          errors: ["tool crashed: EACCES"],
          terminal_reason: "prompt_too_long",
        }),
      ]),
      now: () => "T",
    });
    await host.run();
    expect(turnEnds).toEqual([
      {
        conversationId: null,
        error: { reason: "prompt_too_long", detail: "tool crashed: EACCES" },
      },
    ]);
  });

  it("success result は onTurnEnd に conversationId のみ(error無し)で渡す (issue #131)", async () => {
    const turnEnds: unknown[] = [];
    const host = new AgentHost(config, {
      onState: () => {},
      onTurnEnd: (info) => turnEnds.push(info),
      queryFn: scriptedQuery([result("success", { result: "done" })]),
      now: () => "T",
    });
    await host.run();
    expect(turnEnds).toEqual([{ conversationId: null }]);
  });

  it("並存する複数 inter-agent injection は各ターンの conversationId だけを解決する (issue #131 must-fix 1)", async () => {
    const turnEnds: {
      conversationId: string | null;
      error?: { reason?: string; detail?: string };
    }[] = [];
    // Faithfully drains args.prompt (unlike scriptedQuery, which replays a
    // fixed script blind to input) so #input()'s per-turn tag shifting is
    // actually exercised: turn 1 (cnv-a) fails, turn 2 (cnv-b) succeeds.
    const queryFn = makeQueryFn((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        let turn = 0;
        for await (const _m of args.prompt) {
          turn += 1;
          if (turn === 1) {
            yield msg({
              type: "result",
              subtype: "error_during_execution",
              errors: ["boom"],
            });
          } else {
            yield msg({ type: "result", subtype: "success", result: "ok" });
          }
        }
      }
      return asQuery(gen());
    });
    const host = new AgentHost(config, {
      onState: () => {},
      onTurnEnd: (info) => turnEnds.push(info),
      queryFn,
      now: () => "T",
    });
    const done = host.run();
    await host.send("peer A injection", undefined, "cnv-a");
    await host.send("peer B injection", undefined, "cnv-b");
    host.close();
    await done;

    expect(turnEnds).toEqual([
      { conversationId: "cnv-a", error: { detail: "boom" } },
      { conversationId: "cnv-b" },
    ]);
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

  it("partial な rate_limit_event でも既知 utilization を失わず、overage 込み週次を 7day に統合する", async () => {
    const envs: Envelope[] = [];
    const host = new AgentHost(config, {
      onState: (e) => envs.push(e),
      queryFn: scriptedQuery([
        msg({
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed",
            rateLimitType: "five_hour",
            utilization: 0.42,
            resetsAt: 1781480000,
          },
        }),
        msg({
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed",
            rateLimitType: "five_hour",
            resetsAt: 1781490000,
          },
        }),
        msg({
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed_warning",
            rateLimitType: "seven_day_overage_included",
            utilization: 0.73,
            resetsAt: 1782000000,
          },
        }),
        assistant([{ type: "text", text: "hi" }]),
      ]),
      now: () => "T",
    });
    await host.run();

    const thinking = envs.find((e) => e.state === "thinking");
    expect(thinking?.ext).toMatchObject({
      rate_limits: {
        five_hour: {
          status: "allowed",
          utilization: 0.42,
          resets_at: 1781490000,
        },
        seven_day: {
          status: "allowed_warning",
          utilization: 0.73,
          resets_at: 1782000000,
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
      supports_context_usage: true,
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

  it("init 直後にも getContextUsage が発火し ext.context が付く (ADR-0040)", async () => {
    // init trigger 追加後の効果: 従来は result 到達まで context が乗らなかった
    // (L380 の legacy test を参照)。init 直後の #refreshContextUsageForInit
    // で system_prompt / tools / MCP / memory_files 分の usage が
    // 最初の assistant state_change 時点で ext に載る。
    const envs: Envelope[] = [];
    const usage = {
      totalTokens: 5000,
      maxTokens: 200000,
      percentage: 3,
      model: "claude-init",
    };
    const getContextUsage = vi.fn(async () => usage);
    const queryFn = makeQueryFn(() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield msg({
          type: "system",
          subtype: "init",
          model: "claude-init",
          cwd: "/repo",
        });
        // init 直後の refresh が settle するのを待ってから状態遷移を進める。
        // 実装は fire-and-forget なので tick を回す。
        await new Promise((resolve) => setTimeout(resolve, 30));
        yield assistant([{ type: "text", text: "hi" }]);
        yield result("success", { result: "ok" });
      }
      return asQuery(gen(), async () => {}, getContextUsage);
    });
    const host = new AgentHost(config, {
      onState: (e) => envs.push(e),
      queryFn,
      now: () => "T",
    });
    await host.run();
    const firstThinking = envs.find((e) => e.state === "thinking");
    expect(firstThinking?.ext).toMatchObject({
      context: {
        used_tokens: 5000,
        max_tokens: 200000,
        used_percentage: 3,
      },
    });
    // getContextUsage は少なくとも init 由来で 1 回、result 由来で 1 回発火する。
    expect(getContextUsage.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("init trigger は 1 回目 throw でも短い backoff で再試行する (ADR-0040 must-fix D、turn-5 R3)", async () => {
    // 実 SDK の init race は control_request が throw する形で観測される
    // ため、1 回目 throw → 2 回目 success の retry を pin する。
    // #refreshContextUsage は内部で try/catch 済のため throw は握り潰され、
    // #context は null のまま → for-init helper の bounded retry へ進む。
    const envs: Envelope[] = [];
    let call = 0;
    const usage = {
      totalTokens: 1200,
      maxTokens: 200000,
      percentage: 1,
      model: "claude-retry",
    };
    const getContextUsage = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error("transient control race");
      return usage;
    });
    const queryFn = makeQueryFn(() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield msg({
          type: "system",
          subtype: "init",
          model: "claude-retry",
          cwd: "/repo",
        });
        // 2 回目の refresh (初期 backoff = 100ms) が settle する前に result
        // で状態が進むと retry 効果が観測できないため、余裕を持って待つ。
        await new Promise((resolve) => setTimeout(resolve, 200));
        yield assistant([{ type: "text", text: "hi" }]);
        yield result("success", { result: "ok" });
      }
      return asQuery(gen(), async () => {}, getContextUsage);
    });
    const host = new AgentHost(config, {
      onState: (e) => envs.push(e),
      queryFn,
      now: () => "T",
    });
    await host.run();
    expect(call).toBeGreaterThanOrEqual(2);
    const firstThinking = envs.find((e) => e.state === "thinking");
    expect(firstThinking?.ext.context).toMatchObject({
      used_tokens: 1200,
      used_percentage: 1,
    });
  });

  it("同値 refresh は追加 state_change を発火しない (dedup 厳密、藤 review turn-5 R2)", async () => {
    // 藤 review R2: dedup を削除しても通る過去 test を厳密化。
    // 同一 script (同数の result / 同数の state 遷移) 下で、getContextUsage が
    // 「毎回同値を返す」場合と「毎回異値を返す」場合の envelope 総数を比較。
    // dedup が働いていれば同値 side は追加 emit ゼロ、異値 side は毎 refresh
    // ごとに 1 追加 emit する — 差分が「dedup により抑止された emit の数」。
    // 差 == 発火想定回数 (= result 数) を assert し、dedup 消去時の regression
    // (差 == 0 になり test fail) を検出できる。
    async function runWith(
      getContextUsage: () => Promise<unknown>,
    ): Promise<Envelope[]> {
      const envs: Envelope[] = [];
      const queryFn = makeQueryFn(() => {
        async function* gen(): AsyncGenerator<SDKMessage, void> {
          yield msg({
            type: "system",
            subtype: "init",
            model: "claude-dedup",
            cwd: "/repo",
          });
          // init 由来 refresh が settle するのを待つ (両 branch 共通の baseline)。
          await new Promise((resolve) => setTimeout(resolve, 200));
          yield result("success", { result: "1" });
          await new Promise((resolve) => setTimeout(resolve, 50));
          yield result("success", { result: "2" });
          await new Promise((resolve) => setTimeout(resolve, 50));
          yield result("success", { result: "3" });
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return asQuery(gen(), async () => {}, getContextUsage);
      });
      const host = new AgentHost(config, {
        onState: (e) => envs.push(e),
        queryFn,
        now: () => "T",
      });
      await host.run();
      return envs;
    }

    const staticUsage = {
      totalTokens: 42,
      maxTokens: 100,
      percentage: 42,
      model: "claude-dedup",
    };
    const staticGetter = vi.fn(async () => staticUsage);
    const staticEnvs = await runWith(staticGetter);

    let seq = 0;
    const changingGetter = vi.fn(async () => {
      seq += 1;
      // 毎 refresh で異値を返す → dedup が抑止しない (changed=true 判定)。
      return {
        totalTokens: 42 + seq * 10,
        maxTokens: 100,
        percentage: 42 + seq * 10 > 100 ? 100 : 42 + seq * 10,
        model: "claude-dedup",
      };
    });
    const changingEnvs = await runWith(changingGetter);

    // 前提: 両 run で getContextUsage 呼び出し回数と script は同じ。
    expect(staticGetter.mock.calls.length).toBe(
      changingGetter.mock.calls.length,
    );
    // dedup 効果: 同値 side は refresh 由来の追加 emit ゼロ、異値 side は
    // (初回除く) 各 refresh で追加 emit → changing > static になる。
    // 差は 3 (3 result 由来 refresh の分)。dedup を消すと差が 0 になり fail。
    const delta = changingEnvs.length - staticEnvs.length;
    expect(delta).toBeGreaterThanOrEqual(1);
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

    await host.setModel("default");
    await host.setEffort("max");
    await host.run();

    expect(seenOptions).toMatchObject({
      model: "default",
      effort: "max",
    });
    expect(host.statusExtSnapshot()).toMatchObject({
      model: "default",
      model_source: "config",
      effort: "max",
      effort_source: "config",
      effective: {
        model: "default",
        effort: "max",
      },
    });
    expect(envs.at(-1)?.ext).toMatchObject({
      model: "default",
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
    await host.setModel("default");
    await host.setEffort("max");
    await host.send("first turn");
    await done;

    expect(queryCreated).toBe(true);
    expect(seenOptions).toMatchObject({
      model: "default",
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

  it("setModel 成功で context 世代が進み古い refresh 結果が捨てられる (ADR-0040 must-fix C)", async () => {
    // model 切替中に旧 model の refresh が in-flight → 新 trigger は
    // inflight guard で drop、finally の re-kick で新 generation の refresh が
    // 動く。旧 usage は generation guard で捨てられる。
    const envs: Envelope[] = [];
    let releaseFirst!: (value: unknown) => void;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    // 1 回目 (init 由来): pending Promise で保持し、setModel 完了後まで解決させない
    // 2 回目以降 (post-switch): 即座に新 usage を返す
    let call = 0;
    const staleUsage = {
      totalTokens: 10000,
      maxTokens: 200000,
      percentage: 5,
      model: "default",
    };
    const freshUsage = {
      totalTokens: 500,
      maxTokens: 1000000,
      percentage: 0,
      model: "opus[1m]",
    };
    const getContextUsage = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        await firstGate;
        return staleUsage;
      }
      return freshUsage;
    });
    const setModel = vi.fn(async () => {});
    const queryFn = makeQueryFn((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield msg({ type: "system", subtype: "init", model: "default" });
        for await (const _ of args.prompt) void _;
      }
      return asQuery(gen(), async () => {}, getContextUsage, {
        setModel,
        supportedModels: async () => modelInfos,
      });
    });
    const host = new AgentHost(config, {
      onState: (e) => envs.push(e),
      queryFn,
      now: () => "T",
    });
    const done = host.run();
    // init が流れて #refreshContextUsageForInit が inflight に入るのを待つ
    await new Promise((resolve) => setTimeout(resolve, 10));
    await host.setModel("default");
    // 旧 refresh を release。generation guard により結果は破棄される。
    releaseFirst(undefined);
    // finally の re-kick により fresh generation の refresh が完了するのを待つ
    await new Promise((resolve) => setTimeout(resolve, 50));
    // 最後の envelope に載る context は fresh (staleUsage ではなく freshUsage)
    const lastCtx = envs
      .filter((e) => (e.ext as { context?: unknown }).context !== undefined)
      .at(-1);
    expect(lastCtx?.ext.context).toMatchObject({
      used_tokens: 500,
      max_tokens: 1000000,
    });
    host.close();
    await done;
  });

  it("setModel 成功後の effort reset 失敗でも旧 context は残らない (藤 review turn-5 R1)", async () => {
    // R1 must-fix: setModel resolve 直後・applyFlagSettings reject 時に、
    // 旧 model の #context が authoritative に残る不整合を防ぐ。
    // model apply 成功を境に generation bump + #context=null を実行し、
    // catch path でも新 model 用 refresh を kick する。
    const envs: Envelope[] = [];
    const staleContextUsage = {
      totalTokens: 8000,
      maxTokens: 200000,
      percentage: 4,
      model: "default",
    };
    const freshContextUsage = {
      totalTokens: 100,
      maxTokens: 1000000,
      percentage: 0,
      model: "haiku",
    };
    // 1 回目 (init retry で最初の refresh): 旧 model 用の値。以降は新 model 用。
    let call = 0;
    const getContextUsage = vi.fn(async () => {
      call += 1;
      return call === 1 ? staleContextUsage : freshContextUsage;
    });
    const setModel = vi.fn(async () => {});
    // applyFlagSettings は必ず reject
    const applyFlagSettings = vi.fn(async () => {
      throw new Error("effort reset rejected");
    });
    const queryFn = makeQueryFn((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield msg({ type: "system", subtype: "init", model: "default" });
        for await (const _ of args.prompt) void _;
      }
      return asQuery(gen(), async () => {}, getContextUsage, {
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
    // init/init-retry の refresh が着地し stale context が authoritative に
    // 乗るのを待つ (baseline)。
    await new Promise((resolve) => setTimeout(resolve, 250));
    const beforeSwitch = envs.at(-1);
    expect(beforeSwitch?.ext.context).toMatchObject({
      used_tokens: 8000,
      max_tokens: 200000,
    });
    // haiku (無 effort) へ切替 → applyFlagSettings reject で throw
    await expect(host.setModel("haiku")).rejects.toThrow("effort reset rejected");
    // 直後 (switch_error を運ぶ envelope): 旧 context が「絶対に」乗っていない
    const switchErrEnv = envs
      .filter((e) => e.ext.switch_error !== undefined)
      .at(-1);
    expect(switchErrEnv?.ext.context).toBeUndefined();
    expect(switchErrEnv?.ext.model).toBe("haiku");
    // catch path の refresh kick が完了するのを待つ
    await new Promise((resolve) => setTimeout(resolve, 50));
    // 以降の envelope に fresh context (新 model 用) が乗っている
    const lastCtx = envs
      .filter((e) => (e.ext as { context?: unknown }).context !== undefined)
      .at(-1);
    expect(lastCtx?.ext.context).toMatchObject({
      used_tokens: 100,
      max_tokens: 1000000,
    });
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
    await expect(host.setModel("default")).resolves.toBeUndefined();
    await expect(host.setEffort("high")).resolves.toBeUndefined();
    expect(host.statusExtSnapshot()).toMatchObject({
      model: "default",
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

  it("supportedModels() の連続失敗は上限 3 回で throttle される (ADR-0037 F6)", async () => {
    // Pins the retry semantics: init counts as trial 1, each result-driven
    // retry as one further trial. Total attempts must be exactly 3 (init +
    // 2 result retries), regardless of how many result messages follow.
    let callCount = 0;
    const queryFn = makeQueryFn(() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield msg({ type: "system", subtype: "init", model: "claude-x" });
        // Five result yields give five retry opportunities; only the first
        // two should actually reach supportedModels() (init already used trial
        // 1, so trials 2 and 3 land on the first two results, and trials 4-5
        // must be throttled).
        for (let i = 0; i < 5; i += 1) {
          yield result("success", { result: `t${i}` });
        }
      }
      return asQuery(gen(), async () => {}, undefined, {
        supportedModels: async () => {
          callCount += 1;
          throw new Error("supportedModels down");
        },
      });
    });
    // The give-up moment writes a diagnostic to stderr (host.ts); silence it
    // during the test so the run output stays readable. The pin below is on
    // callCount, not on stderr, because vitest's stream spies do not always
    // intercept process.stderr.write reliably.
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn,
      now: () => "T",
    });
    try {
      await host.run();
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(callCount).toBe(3);
  });

  it("supportedModels() 成功後は後続 turn で再 fetch されない", async () => {
    // Once the catalog is cached the SDK contract treats it as static per
    // session (ADR-0020); subsequent result-driven retries must short-circuit.
    let callCount = 0;
    const queryFn = makeQueryFn(() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield msg({ type: "system", subtype: "init", model: "claude-x" });
        yield result("success", { result: "t0" });
        yield result("success", { result: "t1" });
        yield result("success", { result: "t2" });
      }
      return asQuery(gen(), async () => {}, undefined, {
        supportedModels: async () => {
          callCount += 1;
          return modelInfos;
        },
      });
    });
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn,
      now: () => "T",
    });
    await host.run();
    expect(callCount).toBe(1);
  });

  it("retrySupportedModels() は cap 済み silent 状態から再 fetch を kick する (ADR-0037 F6, phase-18-5)", async () => {
    // The point of the manual retry is that it MUST overcome the auto-retry
    // cap. After 3 continuous failures the host is silent; the operator's
    // refresh_models control resets count + succeeded and kicks a fresh
    // attempt. That attempt succeeds here, so callCount must be 4 (3 pre-cap
    // trials + 1 post-reset), NOT stay at 3 (which would mean the reset did
    // not actually re-open the retry path).
    let callCount = 0;
    let hostRef: AgentHost | undefined;
    const queryFn = makeQueryFn(() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield msg({ type: "system", subtype: "init", model: "claude-x" });
        // 3 result turns trigger auto retries 2/3; cap is reached after the
        // third failure. The 4th result carries the manual retry effect.
        yield result("success", { result: "t0" });
        yield result("success", { result: "t1" });
        // At this point auto retry is exhausted. Fire the manual retry from
        // outside — before the loop pulls the next result.
        await Promise.resolve();
        hostRef?.retrySupportedModels();
        yield result("success", { result: "t2" });
      }
      return asQuery(gen(), async () => {}, undefined, {
        supportedModels: async () => {
          callCount += 1;
          // Fail the first three (init + result 0 + result 1) then succeed.
          if (callCount <= 3) throw new Error("supportedModels down");
          return modelInfos;
        },
      });
    });
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    hostRef = new AgentHost(config, {
      onState: () => {},
      queryFn,
      now: () => "T",
    });
    try {
      await hostRef.run();
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(callCount).toBe(4);
  });

  it("inflight guard: 同 turn 内の concurrent trigger は 1 回にまとまる", async () => {
    // If init's supportedModels() await is still pending when a result
    // arrives, the second trigger must observe #modelsInflight and skip.
    // The slow mock forces the ordering deterministically.
    let callCount = 0;
    const queryFn = makeQueryFn(() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield msg({ type: "system", subtype: "init", model: "claude-x" });
        yield result("success", { result: "ok" });
      }
      return asQuery(gen(), async () => {}, undefined, {
        supportedModels: async () => {
          callCount += 1;
          await new Promise((r) => setTimeout(r, 20));
          return modelInfos;
        },
      });
    });
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn,
      now: () => "T",
    });
    await host.run();
    expect(callCount).toBe(1);
  });

  it("ext.models_error は throw で cap 到達時に立つ (ADR-0037 F6, phase-18-6)", async () => {
    // Continuous throw path: 3 failures reach the auto-retry cap; the
    // last state_change ext must carry models_error=true so a late-
    // connecting client can see the degraded state.
    const envs: Envelope[] = [];
    const queryFn = makeQueryFn(() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield msg({ type: "system", subtype: "init", model: "claude-x" });
        yield result("success", { result: "t0" });
        yield result("success", { result: "t1" });
      }
      return asQuery(gen(), async () => {}, undefined, {
        supportedModels: async () => {
          throw new Error("supportedModels down");
        },
      });
    });
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    const host = new AgentHost(config, {
      onState: (e) => envs.push(e),
      queryFn,
      now: () => "T",
    });
    try {
      await host.run();
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(envs.at(-1)?.ext?.models_error).toBe(true);
  });

  it("ext.models_error は null-return で cap 到達時にも立つ (ADR-0037 F6, phase-18-6)", async () => {
    // The derive-always design closes the gap in phase-18-4's catch-only
    // stderr breadcrumb: when supportedModels() returns null / undefined /
    // empty instead of throwing, the trial is still consumed and the cap is
    // still reached, so the ext flag must fire on this path too.
    const envs: Envelope[] = [];
    const queryFn = makeQueryFn(() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield msg({ type: "system", subtype: "init", model: "claude-x" });
        yield result("success", { result: "t0" });
        yield result("success", { result: "t1" });
      }
      return asQuery(gen(), async () => {}, undefined, {
        supportedModels: async () => null as unknown as ModelInfo[],
      });
    });
    const host = new AgentHost(config, {
      onState: (e) => envs.push(e),
      queryFn,
      now: () => "T",
    });
    await host.run();
    expect(envs.at(-1)?.ext?.models_error).toBe(true);
  });

  it("ext.models_error は success 後は absent (false-derive 保護)", async () => {
    // Negative case: !succeeded is the gate. If any code path accidentally
    // set the flag after a success, this test catches it.
    const envs: Envelope[] = [];
    const queryFn = makeQueryFn(() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield msg({ type: "system", subtype: "init", model: "claude-x" });
        yield result("success", { result: "t0" });
        yield result("success", { result: "t1" });
        yield result("success", { result: "t2" });
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
    for (const env of envs) {
      expect(env.ext?.models_error).toBeUndefined();
    }
  });

  it("persist alias が SDK 実測に含まれない場合は default に fallback + switch_error (ADR-0037 F8, phase-18-7)", async () => {
    // Startup persist path: queryOptions.model mirrors spawn config / env
    // KAOIRO_CLAUDE_CODE_DEFAULT_MODEL / resume snapshot. The mock catalog
    // lacks "opus[1m]", so the wrapper must swap the effective model to
    // "default" and stamp switch_error with reason=persist_alias_unknown.
    const envs: Envelope[] = [];
    const queryFn = makeQueryFn(() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield msg({ type: "system", subtype: "init", model: "claude-x" });
        yield result("success", { result: "ok" });
      }
      return asQuery(gen(), async () => {}, undefined, {
        supportedModels: async () => modelInfos,
      });
    });
    const host = new AgentHost(config, {
      onState: (e) => envs.push(e),
      queryOptions: { model: "opus[1m]" },
      modelSource: "config",
      queryFn,
      now: () => "T",
    });
    await host.run();
    expect(host.statusExtSnapshot()).toMatchObject({
      model: "default",
      // Paired reset — the config source that supplied the discarded alias
      // must no longer own model_source, else consumers read the fallback
      // default as an explicit config-driven pick.
      model_source: "default",
    });
    const errEnv = envs.find((e) => e.ext?.switch_error !== undefined);
    expect(errEnv?.ext?.switch_error).toMatchObject({
      kind: "model",
      requested: "opus[1m]",
      reason: "persist_alias_unknown",
      rolled_back_to: "default",
    });
  });

  it("persist alias が SDK 実測に含まれる場合は fallback を発火しない (F8 negative)", async () => {
    // "haiku" is present in modelInfos, so the F8 fallback must NOT fire.
    // Do not assert on #model itself: init.model in this mock overwrites
    // #model, which is normal (host.ts:1231). The pin here is the absence
    // of a persist-alias switch_error.
    const envs: Envelope[] = [];
    const queryFn = makeQueryFn(() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield msg({ type: "system", subtype: "init", model: "claude-x" });
        yield result("success", { result: "ok" });
      }
      return asQuery(gen(), async () => {}, undefined, {
        supportedModels: async () => modelInfos,
      });
    });
    const host = new AgentHost(config, {
      onState: (e) => envs.push(e),
      queryOptions: { model: "haiku" },
      modelSource: "config",
      queryFn,
      now: () => "T",
    });
    await host.run();
    for (const env of envs) {
      expect(env.ext?.switch_error).toBeUndefined();
    }
  });

  it("persist model が未指定なら validation は no-op (F8 negative, null-guard)", async () => {
    // Without queryOptions.model, #model stays null; the validation must
    // return early and never trip switch_error even if the catalog is
    // populated later.
    const envs: Envelope[] = [];
    const queryFn = makeQueryFn(() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield msg({ type: "system", subtype: "init", model: "claude-x" });
        yield result("success", { result: "ok" });
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
    for (const env of envs) {
      expect(env.ext?.switch_error).toBeUndefined();
    }
  });

  it("retry cycle integration: 3 失敗で cap → 手動 retry → 4 回目 success で ext.models 置換 + models_error 解消 (ADR-0037 F6, phase-18-12)", async () => {
    // The wrapper-side end-to-end of the cap → manual-retry → success path
    // that phase-18-4/5/6 built. Individual pins live in the earlier tests
    // in this describe block; this one observes the transitions together:
    // (a) callCount === 4 (init + 2 result-driven retries + 1 manual retry),
    // (b) ext.models_error present while cap held, absent after success,
    // (c) ext.models replaces the floor catalog with modelInfos on success.
    let callCount = 0;
    let hostRef: AgentHost | undefined;
    const envs: Envelope[] = [];
    const queryFn = makeQueryFn(() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield msg({ type: "system", subtype: "init", model: "claude-x" });
        yield result("success", { result: "t0" });
        yield result("success", { result: "t1" });
        // Cap reached after t1's retry (init=1 + t0=2 + t1=3). Fire the
        // manual retry, then a fresh turn's result triggers the 4th call.
        await Promise.resolve();
        hostRef?.retrySupportedModels();
        yield result("success", { result: "t2" });
      }
      return asQuery(gen(), async () => {}, undefined, {
        supportedModels: async () => {
          callCount += 1;
          if (callCount <= 3) throw new Error("supportedModels down");
          return modelInfos;
        },
      });
    });
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    hostRef = new AgentHost(config, {
      onState: (e) => envs.push(e),
      queryFn,
      now: () => "T",
    });
    try {
      await hostRef.run();
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(callCount).toBe(4);
    // models_error must appear while cap held (after the 3rd throw). Find
    // the envelope that carries it — there must be at least one — and the
    // FINAL envelope must NOT carry it (success cleared #modelsSucceeded).
    const cappedEnv = envs.find((e) => e.ext?.models_error === true);
    expect(cappedEnv).toBeDefined();
    expect(envs.at(-1)?.ext?.models_error).toBeUndefined();
    // ext.models must eventually reflect the SDK's real catalog, not the
    // floor default. The final envelope must carry the modelInfos shape.
    const finalModels = envs.at(-1)?.ext?.models as
      | { value: string }[]
      | undefined;
    expect(finalModels?.map((m) => m.value)).toEqual(
      modelInfos.map((m) => m.value),
    );
  });

  it("init → success で ext.models は BOOTSTRAP floor から SDK 実測へ置換される (phase-18-12)", async () => {
    // Complements the retry-cycle test: pins the healthy-path substitution
    // sequence — first observable state carries the floor catalog, and by
    // the time supportedModels() has succeeded and a further state_change
    // fires, ext.models is the SDK's actual catalog. No models_error ever
    // fires on this path.
    const envs: Envelope[] = [];
    const queryFn = makeQueryFn(() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield msg({ type: "system", subtype: "init", model: "claude-x" });
        yield assistant([{ type: "text", text: "warm-up" }]);
        yield result("success", { result: "ok" });
        // Trailing chunk gives one more state_change after the fire-and-
        // forget supportedModels() has settled, so the last envelope
        // definitely carries the SDK-replaced catalog.
        yield assistant([{ type: "text", text: "post-refresh" }]);
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
    // First observable envelope carries the BOOTSTRAP floor (default only).
    const firstModels = envs[0]?.ext?.models as
      | { value: string }[]
      | undefined;
    expect(firstModels?.map((m) => m.value)).toEqual(["default"]);
    // Final envelope carries the SDK-measured catalog after refresh success.
    const finalModels = envs.at(-1)?.ext?.models as
      | { value: string }[]
      | undefined;
    expect(finalModels?.map((m) => m.value)).toEqual(
      modelInfos.map((m) => m.value),
    );
    // Healthy path never trips models_error.
    for (const env of envs) {
      expect(env.ext?.models_error).toBeUndefined();
    }
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

// Resume privilege restoration regression pin (ADR-0014 F1 追補,
// resume-privilege-restoration 藤 P0). The wrapper reads
// `config.permission_mode` at init time and hands it to the SDK; the
// actual apply happens on the runner side (`applyResumeSnapshot`).
// This fixture confirms the wrapper doesn't silently downgrade the
// restored value.
describe("resume privilege restoration (P0 pin)", () => {
  it("config.permission_mode=bypassPermissions を SDK options に受け渡し allowDangerouslySkip も立てる", async () => {
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
    expect(captured.permissionMode).toBe("bypassPermissions");
    expect(captured.allowDangerouslySkipPermissions).toBe(true);
  });

  it("resumeSnapshot と effective が一致すれば resume_drift は空 (permission_mode)", async () => {
    const states: Envelope[] = [];
    const queryFn = makeQueryFn(() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield result("success", { result: "ok" });
      }
      return asQuery(gen());
    });
    const host = new AgentHost(
      { ...config, permission_mode: "bypassPermissions" },
      {
        onState: (event) => states.push(event),
        queryFn,
        // Runner が同じ値を config へも snapshot へも渡す想定。
        resumeSnapshot: { permission_mode: "bypassPermissions" },
        now: () => "T",
      },
    );
    await host.run();
    const last = states.at(-1);
    // permission_mode field は drift entry に載らない (同値)。
    const drift = last?.ext.resume_drift as
      | { field: string }[]
      | undefined;
    expect(
      drift?.some((entry) => entry.field === "permission_mode"),
    ).toBeFalsy();
    expect(last?.ext.resume_snapshot).toEqual({
      permission_mode: "bypassPermissions",
    });
  });
});

// Phase-23 (ADR-0014 F1 追補「P1 pair-aware apply」). The runner now
// restores model / effort / *_source alongside the P0 privilege axes on
// resume. This regression pin confirms the AgentHost surfaces those
// restored pairs verbatim on the whoami / effective projection and does
// not emit them as drift when the snapshot matches the effective values.
describe("resume model/effort restoration (P1 pair-aware pin)", () => {
  it("Case 3 explicit source (launch) が effective に stamp され drift が空", async () => {
    const states: Envelope[] = [];
    const queryFn = makeQueryFn(() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield result("success", { result: "ok" });
      }
      return asQuery(gen());
    });
    const host = new AgentHost(
      { ...config },
      {
        onState: (event) => states.push(event),
        queryFn,
        // Runner が pair rule Case 3 で source=launch を preserve して届けた想定。
        queryOptions: { model: "opus[1m]", effort: "high" },
        modelSource: "launch",
        effortSource: "launch",
        resumeSnapshot: {
          model: "opus[1m]",
          model_source: "launch",
          effort: "high",
          effort_source: "launch",
        },
        now: () => "T",
      },
    );
    // whoami は resume 由来 source を effective として返す。
    expect(host.statusSnapshot()).toMatchObject({
      model: "opus[1m]",
      model_source: "launch",
      effort: "high",
      effort_source: "launch",
    });
    await host.run();
    const last = states.at(-1);
    const drift = last?.ext.resume_drift as { field: string }[] | undefined;
    expect(
      drift?.some(
        (entry) =>
          entry.field === "model" ||
          entry.field === "model_source" ||
          entry.field === "effort" ||
          entry.field === "effort_source",
      ),
    ).toBeFalsy();
    expect(last?.ext.resume_snapshot).toEqual({
      model: "opus[1m]",
      model_source: "launch",
      effort: "high",
      effort_source: "launch",
    });
  });
});

// Phase-23 dogfood 回帰対策 (ADR-0014 F1 追補 P1「launch pin vs display hint」).
// runner の 5-case pair rule Case 2 (source=default) は config.model /
// config.effort を unset するが、config.resume_snapshot には sanitize 通過
// した (value, source="default") ペアが保持されている。AgentHost は
// constructor でこの pair を display hint として consume し、SDK Query の
// options には source="default" gate で pin しない (SDK 委任継続)。
describe("resume Case 2 display hint fallback (P1 dogfood 回帰対策)", () => {
  it("queryOptions absent + resume_snapshot default pair → this.#model 復元、Options に非 pin", async () => {
    let captured!: Options;
    const queryFn = makeQueryFn((args: QueryArgs) => {
      captured = args.options;
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield result("success", { result: "ok" });
      }
      return asQuery(gen());
    });
    const host = new AgentHost(
      { ...config },
      {
        onState: () => {},
        queryFn,
        // queryOptions.model / .effort は Case 2 で unset された想定
        // modelSource / effortSource も CLI resolver から undefined を受ける
        resumeSnapshot: {
          model: "opus[1m]",
          model_source: "default",
          effort: "high",
          effort_source: "default",
        },
        now: () => "T",
      },
    );
    // whoami は hint 復元で model / effort / source を stamp
    expect(host.statusSnapshot()).toMatchObject({
      model: "opus[1m]",
      model_source: "default",
      effort: "high",
      effort_source: "default",
    });
    await host.run();
    // source="default" は SDK Options に pin されない (SDK 委任継続)
    expect(captured.model).toBeUndefined();
    expect(captured.effort).toBeUndefined();
  });

  it("Case 3 explicit source (queryOptions.model set) は hint fallback より優先、SDK Options に pin される", async () => {
    let captured!: Options;
    const queryFn = makeQueryFn((args: QueryArgs) => {
      captured = args.options;
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield result("success", { result: "ok" });
      }
      return asQuery(gen());
    });
    const host = new AgentHost(
      { ...config },
      {
        onState: () => {},
        queryFn,
        queryOptions: { model: "sonnet", effort: "medium" },
        modelSource: "launch",
        effortSource: "launch",
        // resume_snapshot は別の hint を持っていても explicit が優先
        resumeSnapshot: {
          model: "opus[1m]",
          model_source: "default",
          effort: "high",
          effort_source: "default",
        },
        now: () => "T",
      },
    );
    expect(host.statusSnapshot()).toMatchObject({
      model: "sonnet",
      model_source: "launch",
      effort: "medium",
      effort_source: "launch",
    });
    await host.run();
    expect(captured.model).toBe("sonnet");
    expect(captured.effort).toBe("medium");
  });

  it("resume_snapshot.effort が CLAUDE_EFFORT_LEVELS 外なら pair drop + warn", async () => {
    const stderrWrites: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const host = new AgentHost(
        { ...config },
        {
          onState: () => {},
          resumeSnapshot: {
            model: "opus[1m]",
            model_source: "default",
            effort: "godmode", // catalog 外
            effort_source: "default",
          },
        },
      );
      // model hint は復元、effort はペア drop
      expect(host.statusSnapshot()).toMatchObject({
        model: "opus[1m]",
        model_source: "default",
      });
      expect(host.statusSnapshot()).not.toHaveProperty("effort");
      expect(host.statusSnapshot()).not.toHaveProperty("effort_source");
      expect(
        stderrWrites.some((s) =>
          s.includes("unsupported claude-code effort hint"),
        ),
      ).toBe(true);
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  // 藤 3 次 review R6 + R4 統合: bootstrap default fallback ではなく、
  // 現実的な runner-transported catalog (default alias 無し、hint model
  // だけ含む) を渡した状態で hint 復元後の button 契約と persist_alias
  // 非発火を同時 pin する。dogfood 実機で観測された「両 engine effort
  // 切替ボタン非表示」の直接原因は、live catalog に default alias が
  // 含まれず active model = null かつ fallback default も見つからず
  // effortLevels=[] になるケース。bootstrap 依存 test では再現できない。
  it("現実的 catalog (default 無し) + default hint 復元 → supports_effort_switch=true (R6) & persist_alias_unknown 非発火 (R4)", async () => {
    const envs: Envelope[] = [];
    const supportedModels = vi.fn(async () => [
      // SDK 側 measured catalog も default alias 無し。opus[1m] のみ。
      {
        value: "opus[1m]",
        display_name: "Opus 1M",
        effort_levels: ["low", "medium", "high", "xhigh", "max"] as EffortLevel[],
      },
    ]);
    const queryFn = makeQueryFn((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield msg({ type: "system", subtype: "init", model: "opus[1m]" });
        for await (const _ of args.prompt) void _;
      }
      return asQuery(gen(), async () => {}, undefined, {
        supportedModels,
      });
    });
    const host = new AgentHost(
      {
        ...config,
        // runner-transported live catalog: default alias 無し、hint model
        // だけ含む realistic な shape (typical: ADR-0039 F9 追補が cache
        // する Claude 実 model list)。
        claude_engine_catalog: [
          {
            value: "opus[1m]",
            display_name: "Opus 1M",
            effort_levels: ["low", "medium", "high", "xhigh", "max"],
          },
        ],
      },
      {
        onState: (e) => envs.push(e),
        queryFn,
        // queryOptions.model / effort は Case 2 で unset された想定 —
        // 実 dogfood のシナリオ: config.model / config.effort どちらも
        // 未設定、resolve*Sources は modelSource/effortSource=undefined を返す。
        resumeSnapshot: {
          model: "opus[1m]",
          model_source: "default",
          effort: "high",
          effort_source: "default",
        },
        now: () => "T",
      },
    );
    // hint 復元 (constructor 直後)
    expect(host.statusSnapshot()).toMatchObject({
      model: "opus[1m]",
      model_source: "default",
      effort: "high",
      effort_source: "default",
    });
    // R6: statusExt.models に active model が存在、active entry の
    // effort_levels 非空、UI 側 gate が通る supports_effort_switch=true。
    const initial = host.statusExtSnapshot();
    const models = initial.models as Array<{
      value: string;
      effort_levels?: string[];
    }>;
    const active = models.find((m) => m.value === "opus[1m]");
    expect(active).toBeDefined();
    expect(active?.effort_levels?.length ?? 0).toBeGreaterThan(0);
    const caps = initial.session_capabilities as Record<string, unknown>;
    expect(caps.supports_effort_switch).toBe(true);
    // R4: SDK init を trigger → #refreshSupportedModels → 内部で
    // #validatePersistModelAgainstCatalog が回る。default hint は
    // #persistedModel に載っていないため validation は早期 return し、
    // switch_error(persist_alias_unknown) は発火しない。
    const done = host.run();
    // init の yield と supportedModels の resolve を待つ。
    await new Promise((resolve) => setTimeout(resolve, 20));
    const persistUnknownErrors = envs
      .map((e) => e.ext.switch_error)
      .filter(
        (se) =>
          se !== undefined &&
          (se as { reason?: string }).reason === "persist_alias_unknown",
      );
    expect(persistUnknownErrors).toEqual([]);
    // supportedModels が呼ばれたことも確認 (refresh 経路が実行された)。
    expect(supportedModels).toHaveBeenCalled();
    host.close();
    await done;
  });
});
