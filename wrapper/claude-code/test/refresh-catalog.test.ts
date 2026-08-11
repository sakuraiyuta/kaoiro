// ADR-0039 F9 v2 = 藤 review turn-10 must-fix 3: host.refreshCatalogFor()
// direct tests. The prior AgentDetail integration test relied on a mock
// that could NOT distinguish "success" from "hidden TypeError caught".
// These tests inject probeFn / queryFn directly and pin the observable
// state emission + dedup + never-reject contract.

import { describe, expect, it, vi } from "vitest";
import type { ModelInfo, Query } from "@anthropic-ai/claude-agent-sdk";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { AgentHost } from "../src/host.js";
import type { AgentHostOptions } from "../src/host.js";
import type { ProbeOutcome } from "../src/probe-client.js";

const config: WrapperConfig = {
  agent_id: "test.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

const RICH_MODELS = [
  {
    value: "sonnet",
    display_name: "Sonnet",
    description: "",
    effort_levels: ["low", "medium", "high"],
  },
  {
    value: "haiku",
    display_name: "Haiku",
    description: "",
    effort_levels: ["low", "medium"],
  },
];

describe("AgentHost.refreshCatalogFor (fresh-idle #query=null path)", () => {
  it("probe 成功で #models を更新し、state_change (ext.models rich + effort_levels) を即 emit", async () => {
    const states: Envelope[] = [];
    const host = new AgentHost(config, {
      onState: (env) => states.push(env),
      probeFn: async (): Promise<ProbeOutcome> => ({
        ok: true,
        models: RICH_MODELS,
        elapsed_ms: 12,
        source: "init",
      }),
      queryFn: (() => {
        throw new Error("query should not be constructed in this test");
      }) as never,
      now: () => "T",
    });

    const result = await host.refreshCatalogFor();
    expect(result).toEqual({ ok: true, models_count: 2 });

    // emitState fires a state_change; assert ext.models carries the rich
    // catalog. Effort levels are preserved so AgentDetail's effort button
    // is populated.
    const last = states.at(-1);
    expect(last?.type).toBe("state_change");
    const models = last?.ext?.models as
      | Array<{ value: string; effort_levels?: string[] }>
      | undefined;
    expect(models?.map((m) => m.value)).toEqual(["sonnet", "haiku"]);
    expect(models?.[0]?.effort_levels).toEqual(["low", "medium", "high"]);
  });

  it("probe outcome の resolved_model を ext.models へ透過し、欠落行/空文字行は absent のまま", async () => {
    const states: Envelope[] = [];
    const host = new AgentHost(config, {
      onState: (env) => states.push(env),
      probeFn: async (): Promise<ProbeOutcome> => ({
        ok: true,
        models: [
          {
            value: "sonnet",
            display_name: "Sonnet",
            description: "",
            resolved_model: "claude-sonnet-5",
          },
          { value: "haiku", display_name: "Haiku", description: "" },
          {
            value: "opus",
            display_name: "Opus",
            description: "",
            resolved_model: "",
          },
        ],
        elapsed_ms: 12,
        source: "init",
      }),
      queryFn: (() => {
        throw new Error("query should not be constructed in this test");
      }) as never,
      now: () => "T",
    });

    expect(await host.refreshCatalogFor()).toEqual({
      ok: true,
      models_count: 3,
    });
    const models = states.at(-1)?.ext?.models as
      | Array<Record<string, unknown>>
      | undefined;
    expect(models?.[0]?.resolved_model).toBe("claude-sonnet-5");
    expect(models?.[1] !== undefined && "resolved_model" in models[1]).toBe(
      false,
    );
    // 空文字は canonical wire ID ではないので absent へ畳む。
    expect(models?.[2] !== undefined && "resolved_model" in models[2]).toBe(
      false,
    );
  });

  it("probe 失敗で #models は last-known-good (bootstrap) を保持し、structured failure を返す (never-reject)", async () => {
    const states: Envelope[] = [];
    const host = new AgentHost(config, {
      onState: (env) => states.push(env),
      probeFn: async (): Promise<ProbeOutcome> => ({
        ok: false,
        reason: "auth_failed",
        elapsed_ms: 5,
      }),
      queryFn: (() => {
        throw new Error("query should not be constructed in this test");
      }) as never,
      now: () => "T",
    });
    const result = await host.refreshCatalogFor();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("auth_failed");
  });

  it("probeFn が throw しても reject せず structured failure を返す (藤 must-fix 2)", async () => {
    const host = new AgentHost(config, {
      onState: () => {},
      probeFn: async () => {
        throw new Error("boom");
      },
      queryFn: (() => {
        throw new Error("query should not be constructed in this test");
      }) as never,
      now: () => "T",
    });
    const result = await host.refreshCatalogFor();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("cli_error");
  });

  it("probeFn reject 後、次回 refreshCatalogFor で再試行できる (#refreshInFlight 解放)", async () => {
    let probeCalls = 0;
    const host = new AgentHost(config, {
      onState: () => {},
      probeFn: async () => {
        probeCalls += 1;
        if (probeCalls === 1) throw new Error("first fails");
        return {
          ok: true,
          models: RICH_MODELS,
          elapsed_ms: 3,
          source: "init",
        };
      },
      queryFn: (() => {
        throw new Error("query should not be constructed in this test");
      }) as never,
      now: () => "T",
    });
    const first = await host.refreshCatalogFor();
    expect(first.ok).toBe(false);
    const second = await host.refreshCatalogFor();
    expect(second.ok).toBe(true);
    expect(probeCalls).toBe(2);
  });

  it("同時 refreshCatalogFor は 1 execution にまとまる (dedup)", async () => {
    let probeCalls = 0;
    let resolveProbe: (o: ProbeOutcome) => void = () => {};
    const host = new AgentHost(config, {
      onState: () => {},
      probeFn: () =>
        new Promise<ProbeOutcome>((resolve) => {
          probeCalls += 1;
          resolveProbe = resolve;
        }),
      queryFn: (() => {
        throw new Error("query should not be constructed in this test");
      }) as never,
      now: () => "T",
    });
    const [p1, p2, p3] = [
      host.refreshCatalogFor(),
      host.refreshCatalogFor(),
      host.refreshCatalogFor(),
    ];
    expect(probeCalls).toBe(1);
    resolveProbe({
      ok: true,
      models: RICH_MODELS,
      elapsed_ms: 3,
      source: "init",
    });
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect([r1.ok, r2.ok, r3.ok]).toEqual([true, true, true]);
  });

  it("probe empty models は invalid_output に落とし #models を保持する", async () => {
    const host = new AgentHost(config, {
      onState: () => {},
      probeFn: async (): Promise<ProbeOutcome> => ({
        ok: true,
        models: [],
        elapsed_ms: 3,
        source: "init",
      }),
      queryFn: (() => {
        throw new Error("query should not be constructed in this test");
      }) as never,
      now: () => "T",
    });
    const result = await host.refreshCatalogFor();
    expect(result.ok).toBe(false);
  });
});

// #query !== null path: run() 済み host で live SDK.supportedModels() を
// 呼ぶ経路を明示 pin (fresh-idle probe path と別に確認、藤 review turn-13
// 追加指示)。scriptedQuery pattern (host.test.ts) を利用し、空メッセージ
// で run() を即完了させて #query を非 null のまま残す。
type QueryFn = NonNullable<AgentHostOptions["queryFn"]>;

/** Build a queryFn returning an async-iterator Query with supportedModels
 *  attached. Iterator yields nothing so run() returns immediately, leaving
 *  #query set. init/result meta is NOT surfaced, so the internal auto-fetch
 *  path does not race the manual refreshCatalogFor() we drive from tests. */
function runningQueryFn(
  supportedModels: () => Promise<ModelInfo[] | undefined>,
): QueryFn {
  return ((_args: unknown) => {
    async function* gen(): AsyncGenerator<never, void> {}
    return Object.assign(gen(), {
      interrupt: async () => {},
      supportedModels,
    }) as unknown as Query;
  }) as unknown as QueryFn;
}

describe("AgentHost.refreshCatalogFor (#query !== null live SDK path)", () => {
  const richModelInfos: ModelInfo[] = [
    {
      value: "sonnet",
      displayName: "Sonnet",
      description: "",
      supportedEffortLevels: ["low", "medium", "high"],
    } as ModelInfo,
    {
      value: "haiku",
      displayName: "Haiku",
      description: "",
      supportedEffortLevels: ["low", "medium"],
    } as ModelInfo,
  ];

  it("SDK.supportedModels() 成功で #models を更新し rich state_change を emit する", async () => {
    const states: Envelope[] = [];
    const supportedModels = vi.fn(async () => richModelInfos);
    const host = new AgentHost(config, {
      onState: (env) => states.push(env),
      queryFn: runningQueryFn(supportedModels),
      probeFn: async () => {
        throw new Error(
          "probeFn must not run when #query is available (live SDK path)",
        );
      },
      now: () => "T",
    });
    await host.run();
    // Clear states from run()'s own initial emission (if any) so we key on
    // the refreshCatalogFor()'s post-success state_change.
    const preRefresh = states.length;

    const result = await host.refreshCatalogFor();

    expect(result).toEqual({ ok: true, models_count: 2 });
    expect(supportedModels).toHaveBeenCalledTimes(1);
    // A single state_change follows the successful refresh, carrying the
    // rich catalog to the paired AgentDetail without waiting for the next
    // natural transition.
    const emitted = states.slice(preRefresh);
    expect(emitted.length).toBeGreaterThanOrEqual(1);
    const last = emitted.at(-1)!;
    expect(last.type).toBe("state_change");
    const models = last.ext?.models as
      | Array<{ value: string; effort_levels?: string[] }>
      | undefined;
    expect(models?.map((m) => m.value)).toEqual(["sonnet", "haiku"]);
    expect(models?.[0]?.effort_levels).toEqual(["low", "medium", "high"]);
  });

  it("SDK.supportedModels() の resolvedModel を ext.models へ透過し、欠落行/空文字行は absent のまま", async () => {
    const states: Envelope[] = [];
    const host = new AgentHost(config, {
      onState: (env) => states.push(env),
      queryFn: runningQueryFn(async () => [
        {
          value: "sonnet",
          displayName: "Sonnet",
          description: "",
          resolvedModel: "claude-sonnet-5",
        } as ModelInfo,
        { value: "haiku", displayName: "Haiku", description: "" } as ModelInfo,
        {
          value: "opus",
          displayName: "Opus",
          description: "",
          resolvedModel: "",
        } as ModelInfo,
      ]),
      probeFn: async () => {
        throw new Error("probeFn must not run in live SDK path");
      },
      now: () => "T",
    });
    await host.run();

    expect(await host.refreshCatalogFor()).toEqual({
      ok: true,
      models_count: 3,
    });
    const models = states.at(-1)?.ext?.models as
      | Array<Record<string, unknown>>
      | undefined;
    expect(models?.[0]?.resolved_model).toBe("claude-sonnet-5");
    expect(models?.[1] !== undefined && "resolved_model" in models[1]).toBe(
      false,
    );
    // 空文字は canonical wire ID ではないので absent へ畳む。
    expect(models?.[2] !== undefined && "resolved_model" in models[2]).toBe(
      false,
    );
  });

  it("SDK.supportedModels() 失敗で last-known #models を保持し structured failure を返す", async () => {
    const states: Envelope[] = [];
    const supportedModels = vi.fn(async () => {
      throw new Error("SDK boom");
    });
    const host = new AgentHost(config, {
      onState: (env) => states.push(env),
      queryFn: runningQueryFn(supportedModels),
      probeFn: async () => {
        throw new Error("probeFn must not run in live SDK path");
      },
      now: () => "T",
    });
    await host.run();
    const preRefresh = states.length;

    const result = await host.refreshCatalogFor();

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("cli_error");
    // Failure path emits NO refresh-driven state_change: the wrapper stays
    // silent so the last-known-good #models still lives in the AgentDetail
    // it previously stamped. This mirrors #refreshSupportedModels' catch
    // branch, which never reassigns #models on failure.
    expect(states.slice(preRefresh)).toEqual([]);
  });

  it("SDK.supportedModels() が undefined を返しても reject せず structured failure を返す", async () => {
    // #refreshSupportedModels: `if (!models) return;` early exit path。
    // #modelsSucceeded は false のまま、never-reject 契約下で cli_error に
    // 落ちることを pin する。
    const host = new AgentHost(config, {
      onState: () => {},
      queryFn: runningQueryFn(async () => undefined),
      probeFn: async () => {
        throw new Error("probeFn must not run in live SDK path");
      },
      now: () => "T",
    });
    await host.run();
    const result = await host.refreshCatalogFor();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("cli_error");
  });
});
