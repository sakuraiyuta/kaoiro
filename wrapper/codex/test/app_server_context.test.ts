import { describe, expect, it } from "vitest";
import { AppServerContextMeter } from "../src/app_server_context.js";

const identity = { threadId: "thread", turnId: "turn", hostTurnToken: "host" };
const counts = { inputTokens: 23955, cachedInputTokens: 100, cacheWriteInputTokens: 0, outputTokens: 263, reasoningOutputTokens: 252, totalTokens: 24218 };
const usage = (last = counts, modelContextWindow: unknown = 258400) => ({ last, total: { ...counts, totalTokens: 999999 }, modelContextWindow });
function fixture() {
  const meter = new AppServerContextMeter();meter.observe({ kind: "bound", threadId: "thread" });
  meter.begin("thread", "host", "model");
  const response = (sequence = 1) => meter.observe({ kind: "response", ...identity, sequence });
  const sample = (value: unknown = usage(), sequence = 2) => meter.observe({ kind: "usage", ...identity, value, sequence });
  const finish = (committed = true, model = "model") => meter.finish(identity, committed, model);
  const compact = (phase: "started" | "completed", sequence: number, itemId = "compact") => meter.observe({ kind: "compaction", ...identity, phase, sequence, itemId });
  return { meter, response, sample, finish, compact };
}

describe("host context publication", () => {
  it("uses the atomic native total without reconstructing, caching subtraction or adding reasoning", () => {
    const f = fixture();f.response();f.sample(usage({ ...counts, totalTokens: 25000 }));
    expect(f.meter.snapshot).toBeUndefined();f.finish();
    expect(f.meter.snapshot).toEqual({ used_tokens: 25000, max_tokens: 258400, used_percentage: 100 * (25000 / 258400) });
  });
  it("preserves a finite value above the reported window", () => {
    const f = fixture();f.response();f.sample(usage({ ...counts, totalTokens: 272534 }));f.finish();
    expect(f.meter.snapshot?.used_percentage).toBe(100 * (272534 / 258400));
    expect(f.meter.snapshot?.used_percentage).toBeGreaterThan(100);
  });
  it.each([[Number.MAX_SAFE_INTEGER, 1], [1, Number.MAX_SAFE_INTEGER]])("publishes finite percentages at accepted numeric extremes (%s/%s)", (tokens, window) => {
    const f = fixture();f.response();
    f.sample(usage({ inputTokens: tokens, cachedInputTokens: 0, cacheWriteInputTokens: 0,
      outputTokens: 0, reasoningOutputTokens: 0, totalTokens: tokens }, window));f.finish();
    expect(f.meter.snapshot).toEqual({ used_tokens: tokens, max_tokens: window, used_percentage: 100 * (tokens / window) });
    expect(Number.isFinite(f.meter.snapshot!.used_percentage)).toBe(true);
  });
  it.each([Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects an unbounded native total %s before calculating its percentage", totalTokens => {
    const f = fixture();f.response();f.sample(usage({ ...counts, totalTokens }));f.finish();
    expect(f.meter.snapshot).toBeUndefined();
  });
  it.each([null, undefined, 0, -1, "258400", Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])("withdraws a known value for an unavailable/invalid window %s", window => {
    const f = fixture();f.response();f.sample();f.finish();
    f.meter.begin("thread", "host", "model");f.response(3);
    expect(f.sample({ ...usage(), modelContextWindow: window }, 4)).toBe(true);
    expect(f.meter.snapshot).toBeUndefined();f.finish();expect(f.meter.snapshot).toBeUndefined();
  });
  it.each([NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "5"])("withdraws malformed current-owned counts %s", inputTokens => {
    const f = fixture();f.response();f.sample();f.finish();f.meter.begin("thread", "host", "model");
    expect(f.sample(usage({ ...counts, inputTokens } as typeof counts), 3)).toBe(true);
    expect(f.meter.snapshot).toBeUndefined();
  });
  it("rejects estimates, early usage and unsuccessful or uncommitted terminals", () => {
    for (const mode of ["estimate", "early", "failed", "model"] as const) {
      const f = fixture();if (mode !== "early") f.response();
      f.sample(usage(mode === "estimate" ? { ...counts, inputTokens: 0, totalTokens: 69748 } : counts));
      f.finish(mode !== "failed", mode === "model" ? "different" : "model");
      expect(f.meter.snapshot, mode).toBeUndefined();
    }
  });
  it("invalidates once at start, ignores estimates and recovers in the same automatic-compaction turn", () => {
    const f = fixture();f.response();f.sample();f.finish();f.meter.begin("thread", "host", "model");
    expect(f.compact("started", 3)).toBe(true);expect(f.meter.snapshot).toBeUndefined();
    expect(f.compact("started", 3)).toBe(false);
    f.sample(usage({ ...counts, inputTokens: 0, totalTokens: 69748 }), 4);
    f.compact("completed", 5);f.response(6);f.sample(usage({ ...counts, totalTokens: 136486 }), 7);
    f.compact("started", 3);f.compact("completed", 5);
    f.finish();expect(f.meter.snapshot?.used_tokens).toBe(136486);
  });
  it("does not let a pre-start buffered response cross a later boundary", () => {
    const f = fixture();f.compact("started", 4);f.compact("completed", 5);
    f.response(1);f.sample(usage(), 2);f.finish();expect(f.meter.snapshot).toBeUndefined();
  });
  it.each([4, 5])("rejects a response at or before the latest boundary (sequence %s)", sequence => {
    const f = fixture();f.compact("started", 4);f.compact("completed", 5);
    f.response(sequence);f.sample(usage(), 6);f.finish();expect(f.meter.snapshot).toBeUndefined();
  });
  it.each([4, 5])("requires usage strictly after the recorded response (sequence %s)", sequence => {
    const f = fixture();f.compact("started", 1);f.compact("completed", 2);
    f.response(5);f.sample(usage(), sequence);f.finish();expect(f.meter.snapshot).toBeUndefined();
  });
  it("requires a response after completion and rejects an unfinished compaction", () => {
    for (const complete of [false, true]) {
      const f = fixture();f.response();f.compact("started", 3);if (complete) f.compact("completed", 4);
      f.sample(usage(), 5);f.finish();expect(f.meter.snapshot).toBeUndefined();
    }
  });
  it.each(["thread", "token", "turn", "model", "reset", "closed", "finished"])("rejects replay or revoked %s ownership", mismatch => {
    const f = fixture();f.meter.handoff(identity);
    if (mismatch === "model") f.meter.modelChanged();
    if (mismatch === "reset") f.meter.reset();
    if (mismatch === "closed") f.meter.close();
    if (mismatch === "finished") f.finish();
    const owner = { ...identity, ...(mismatch === "thread" ? { threadId: "foreign" } : {}), ...(mismatch === "token" ? { hostTurnToken: "old" } : {}), ...(mismatch === "turn" ? { turnId: "old" } : {}) };
    f.meter.observe({ kind: "response", ...owner, sequence: 1 });
    f.meter.observe({ kind: "usage", ...owner, value: usage(), sequence: 2 });
    f.meter.finish(owner, true, "model");expect(f.meter.snapshot).toBeUndefined();
  });
  it("an idle bound-thread boundary retracts, but replay and foreign-thread boundaries do not restore", () => {
    const f = fixture();f.response();f.sample();f.finish();
    expect(f.meter.observe({ kind: "compaction", threadId: "other", turnId: "foreign", itemId: "x", phase: "started", sequence: 3 })).toBe(false);
    expect(f.meter.snapshot).toBeDefined();expect(f.compact("started", 3)).toBe(true);
    f.compact("completed", 4);f.sample(usage(), 5);expect(f.meter.snapshot).toBeUndefined();
  });
  it("failed dispatch and model requests revoke snapshots, including rollback", () => {
    const f = fixture();f.response();f.sample();f.finish();f.meter.modelChanged();expect(f.meter.snapshot).toBeUndefined();
    f.meter.begin("thread", "host", "model");f.response();f.sample();f.meter.fail("host");f.finish();expect(f.meter.snapshot).toBeUndefined();
  });
});
it.each(["threadId", "hostTurnToken", "turnId"] as const)("cannot commit a valid candidate using a different %s", field => {
  const f = fixture();f.response();f.sample();
  f.meter.finish({ ...identity, [field]: "foreign" }, true, "model");expect(f.meter.snapshot).toBeUndefined();
  f.finish();expect(f.meter.snapshot?.used_tokens).toBe(24218);
});
it("does not publish under an unknown effective model even with otherwise valid telemetry", () => {
  const f = fixture();f.meter.begin("thread", "host", null);f.response();f.sample();f.meter.finish(identity, true, null);expect(f.meter.snapshot).toBeUndefined();
});
