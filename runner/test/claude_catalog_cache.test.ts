import { describe, expect, it } from "vitest";
import { ClaudeCatalogCache } from "../src/claude_catalog_cache.js";
import type { ProbeOutcome } from "../src/claude_probe.js";
import type { EngineModelInfo } from "@kaoiro/protocol";

const MODELS: EngineModelInfo[] = [
  { value: "default", display_name: "Default", description: "" },
  { value: "opus[1m]", display_name: "Opus", description: "" },
];

/** Deterministic clock so TTL windows are exact in tests. */
function fakeClock() {
  let now = 1_000_000;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function successOutcome(models: EngineModelInfo[] = MODELS): ProbeOutcome {
  return { ok: true, models, elapsed_ms: 100, source: "init" };
}

function failureOutcome(): ProbeOutcome {
  return { ok: false, reason: "auth_failed", elapsed_ms: 5 };
}

describe("ClaudeCatalogCache", () => {
  it("成功した probe の結果を cache し、fresh なら probe を再実行しない", async () => {
    const clock = fakeClock();
    const cache = new ClaudeCatalogCache({
      ttlMs: 60_000,
      now: clock.now,
    });
    let probeCalls = 0;
    const probe = async () => {
      probeCalls++;
      return successOutcome();
    };
    const r1 = await cache.refresh(probe, false);
    expect(r1.ok).toBe(true);
    expect(r1.models).toEqual(MODELS);
    expect(probeCalls).toBe(1);

    // TTL 内: probe を回さず cache hit
    clock.advance(30_000);
    const r2 = await cache.refresh(probe, false);
    expect(r2.ok).toBe(true);
    expect(r2.models).toEqual(MODELS);
    expect(probeCalls).toBe(1);
  });

  it("TTL 超過後は probe を再実行する", async () => {
    const clock = fakeClock();
    const cache = new ClaudeCatalogCache({
      ttlMs: 60_000,
      now: clock.now,
    });
    let probeCalls = 0;
    const probe = async () => {
      probeCalls++;
      return successOutcome();
    };
    await cache.refresh(probe, false);
    clock.advance(60_001);
    await cache.refresh(probe, false);
    expect(probeCalls).toBe(2);
  });

  it("force=true は cache が fresh でも probe を実行する", async () => {
    const clock = fakeClock();
    const cache = new ClaudeCatalogCache({
      ttlMs: 60_000,
      now: clock.now,
    });
    let probeCalls = 0;
    const probe = async () => {
      probeCalls++;
      return successOutcome();
    };
    await cache.refresh(probe, false);
    await cache.refresh(probe, true);
    expect(probeCalls).toBe(2);
  });

  it("同時に走る probe は 1 subprocess にまとめる (dedup)", async () => {
    const cache = new ClaudeCatalogCache();
    let probeCalls = 0;
    let resolveProbe: (o: ProbeOutcome) => void = () => {};
    const probe = () =>
      new Promise<ProbeOutcome>((resolve) => {
        probeCalls++;
        resolveProbe = resolve;
      });
    const p1 = cache.refresh(probe, false);
    const p2 = cache.refresh(probe, false);
    const p3 = cache.refresh(probe, true);
    expect(probeCalls).toBe(1);
    resolveProbe(successOutcome());
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(true);
  });

  it("失敗した probe は cache を更新しない (前回値を保持)", async () => {
    const clock = fakeClock();
    const cache = new ClaudeCatalogCache({
      ttlMs: 60_000,
      now: clock.now,
    });
    await cache.refresh(async () => successOutcome(), false);
    clock.advance(60_001);
    const r = await cache.refresh(async () => failureOutcome(), true);
    expect(r.ok).toBe(false);
    expect(cache.getStale()).toEqual(MODELS);
  });

  it("getStale は TTL 超過後も last-known-good を返す", async () => {
    const clock = fakeClock();
    const cache = new ClaudeCatalogCache({
      ttlMs: 60_000,
      now: clock.now,
    });
    await cache.refresh(async () => successOutcome(), false);
    clock.advance(60_001);
    expect(cache.getIfFresh()).toBeNull();
    expect(cache.getStale()).toEqual(MODELS);
  });

  it("probe が reject しても inFlight を必ず解放し、次回 refresh を許可する", async () => {
    // 藤 must-fix 5: 以前は .then だけで inFlight を null 化していたため、
    // probe が throw すると inFlight が残ったまま以降 retry 不能になっていた。
    const cache = new ClaudeCatalogCache();
    let calls = 0;
    const probe = async (): Promise<never> => {
      calls++;
      throw new Error("boom");
    };
    const r1 = await cache.refresh(probe, true);
    expect(r1.ok).toBe(false);
    expect(cache.peek().inFlight).toBeNull();
    // 2 回目も probe が呼ばれる (inFlight leak していたら呼ばれない)
    const r2 = await cache.refresh(probe, true);
    expect(r2.ok).toBe(false);
    expect(calls).toBe(2);
  });

  it("cache-hit は source: 'cache' を返す (orchestrator の updateRegister 抑制シグナル)", async () => {
    const cache = new ClaudeCatalogCache({ ttlMs: 60_000 });
    await cache.refresh(async () => successOutcome(), false);
    const r = await cache.refresh(async () => successOutcome(), false);
    expect(r.ok).toBe(true);
    expect(r.source).toBe("cache");
  });

  it("dedup 待機側は source: 'cache' を受け取り、初回だけが 'init' を持つ", async () => {
    const cache = new ClaudeCatalogCache();
    let resolveProbe: (o: ProbeOutcome) => void = () => {};
    const probe = () =>
      new Promise<ProbeOutcome>((resolve) => {
        resolveProbe = resolve;
      });
    const p1 = cache.refresh(probe, false);
    const p2 = cache.refresh(probe, false);
    resolveProbe({ ok: true, models: MODELS, elapsed_ms: 5, source: "init" });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.source).toBe("init");
    expect(r2.source).toBe("cache");
  });
});
