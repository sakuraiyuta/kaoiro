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

/** Wraps an async generator into a Query (interrupt / getContextUsage are the
 *  only control methods the host exercises). */
function asQuery(
  gen: AsyncGenerator<SDKMessage, void>,
  interrupt: () => Promise<void> = async () => {},
  getContextUsage?: () => Promise<unknown>,
): Query {
  const controls: Record<string, unknown> = { interrupt };
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
});
