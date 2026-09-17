import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppServerAccountTelemetry, appServerUsage } from "../src/app_server_telemetry.js";
import { codexRateLimitWindow, codexRateLimitsFromRolloutIn } from "../src/rollout.js";

const counts = { inputTokens: 40, cachedInputTokens: 3, cacheWriteInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 1, totalTokens: 45 };
const window = (usedPercent: unknown, windowDurationMins: unknown = 300, resetsAt: unknown = null) => ({ usedPercent, windowDurationMins, resetsAt });
const bucket = (limitId: unknown, usedPercent = 12) => ({ limitId, primary: window(usedPercent), secondary: window(34, 10080, 1234),
  credits: { balance: "PRIVATE" }, planType: "PRIVATE", accountId: "PRIVATE" });

describe("app-server native usage", () => {
  it("retains last and total counts separately without converting them to context percentages", () => {
    const total = { ...counts, inputTokens: 4000, totalTokens: 4005 };
    expect(appServerUsage({ last: counts, total, modelContextWindow: 1000, private: "DROP" })).toEqual({ last: counts, total, modelContextWindow: 1000 });
    const { cacheWriteInputTokens: _, ...withoutCacheWrite } = counts;
    expect(appServerUsage({ last: withoutCacheWrite, total: counts })).toEqual({
      last: { ...counts, cacheWriteInputTokens: 0 }, total: counts, modelContextWindow: null,
    });
  });
  it.each([null, {}, { last: counts }, { last: { ...counts, totalTokens: "45" }, total: counts },
    { last: { ...counts, inputTokens: -1 }, total: counts }, { last: counts, total: { ...counts, outputTokens: Infinity } },
    { last: counts, total: counts, modelContextWindow: 0 }, { last: { ...counts, cacheWriteInputTokens: null }, total: counts }])("rejects invalid usage %j", value => {
    expect(appServerUsage(value)).toBeNull();
  });
});

describe("account telemetry meters", () => {
  it("separates buckets and windows, drops private metadata, and returns detached snapshots", () => {
    const account = new AppServerAccountTelemetry();
    expect(account.snapshot).toEqual({ readStatus: "not-read", buckets: [] });
    account.update(bucket("codex")); account.update(bucket("other", 91));
    expect(account.snapshot).toEqual({ readStatus: "not-read", buckets: [
      { limitId: "codex", windows: { five_hour: { utilization: 0.12 }, seven_day: { utilization: 0.34, resets_at: 1234 } } },
      { limitId: "other", windows: { five_hour: { utilization: 0.91 }, seven_day: { utilization: 0.34, resets_at: 1234 } } },
    ] });
    expect(JSON.stringify(account.snapshot)).not.toMatch(/PRIVATE|credits|planType|accountId/);
    const copy = account.snapshot; copy.buckets[0]!.windows.five_hour!.utilization = 999; copy.buckets.length = 0;
    expect(account.snapshot.buckets[0]!.windows.five_hour!.utilization).toBe(0.12);
    account.update({ limitId: "codex", primary: null, secondary: window(50, 10080) });
    expect(account.snapshot.buckets[0]).toEqual({ limitId: "codex", windows: { seven_day: { utilization: 0.5 } } });
    expect(account.snapshot.buckets[1]!.windows.five_hour!.utilization).toBe(0.91);
  });

  it("uses the keyed read as authoritative rather than merging the legacy meter into another bucket", () => {
    const account = new AppServerAccountTelemetry();
    account.finishRead(account.beginRead(), { accountId: "PRIVATE", rateLimits: bucket("legacy", 99), rateLimitsByLimitId: {
      codex: bucket("codex", 10), images: { primary: window(20), secondary: null },
    } });
    expect(account.snapshot).toEqual({ readStatus: "available", buckets: [
      { limitId: "codex", windows: { five_hour: { utilization: 0.1 }, seven_day: { utilization: 0.34, resets_at: 1234 } } },
      { limitId: "images", windows: { five_hour: { utilization: 0.2 } } },
    ] });
    account.finishRead(account.beginRead(), { rateLimits: bucket(null, 7), rateLimitsByLimitId: null });
    expect(account.snapshot.buckets.map(b => b.limitId)).toEqual([null]);
    expect(account.snapshot.buckets[0]!.windows.five_hour).toEqual({ utilization: 0.07 });
  });

  it("does not merge unidentified or malformed meters into codex", () => {
    const account = new AppServerAccountTelemetry();
    account.update(bucket(null)); account.update(bucket("codex", 60));
    account.update(bucket(1)); account.update(null);
    expect(account.snapshot.buckets.map(b => b.limitId)).toEqual([null, "codex"]);
    account.finishRead(account.beginRead(), { rateLimitsByLimitId: { codex: bucket("other") } });
    expect(account.snapshot.readStatus).toBe("unavailable");
    expect(account.snapshot.buckets[1]!.windows.five_hour).toEqual({ utilization: 0.6 });
    account.update({ limitId: "unrecognized", primary: window(50, 1), secondary: window("bad") });
    expect(account.snapshot.buckets.at(-1)).toEqual({ limitId: "unrecognized", windows: {} });
  });

  it("retains notifications received during reads, including unavailable reads and reversed replies", () => {
    const account = new AppServerAccountTelemetry();
    const pending = account.beginRead();
    account.update(bucket("codex", 80));
    account.finishRead(pending, { rateLimits: bucket("codex", 1) });
    expect(account.snapshot.buckets[0]!.windows.five_hour).toEqual({ utilization: 0.8 });
    account.finishRead(account.beginRead(), null);
    expect(account.snapshot.readStatus).toBe("unavailable");
    expect(account.snapshot.buckets[0]!.windows.five_hour).toEqual({ utilization: 0.8 });
    const old = account.beginRead(), latest = account.beginRead();
    account.finishRead(latest, { rateLimits: bucket("codex", 90) });
    account.finishRead(old, { rateLimits: bucket("codex", 1) });
    expect(account.snapshot.buckets[0]!.windows.five_hour).toEqual({ utilization: 0.9 });
    account.finishRead(old, null);
    expect(account.snapshot.readStatus).toBe("available");
  });
});

describe("exec numeric conversion remains unchanged", () => {
  it("pins both original JSONL routing and shared conversion including finite out-of-range values", () => {
    const root = mkdtempSync(join(tmpdir(), "fuji-348-rate-parity-"));
    try {
      const cases = [
        { minutes: 300, used: 42.5, reset: 123, expected: { utilization: 0.425, resets_at: 123 } },
        { minutes: 10080, used: 110, reset: null, expected: { utilization: 1.1 } },
        { minutes: 300, used: -10, reset: -5, expected: { utilization: -0.1, resets_at: -5 } },
        { minutes: 300, used: null, reset: 0, expected: { resets_at: 0 } },
      ];
      for (const [i, c] of cases.entries()) {
        const id = `parity-${i}`;
        writeFileSync(join(root, `rollout-${id}.jsonl`), JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: {
          primary: { window_minutes: c.minutes, used_percent: c.used, resets_at: c.reset }, secondary: null,
        } } }) + "\n");
        const key = c.minutes === 300 ? "five_hour" : "seven_day";
        expect([...codexRateLimitsFromRolloutIn(root, id)]).toEqual([[key, c.expected]]);
        expect(codexRateLimitWindow(c.minutes, c.used, c.reset)).toEqual({ window: key, snapshot: c.expected });
      }
      expect(codexRateLimitWindow(999, 50, 123)).toBeNull();
      expect(codexRateLimitWindow(300, NaN, Infinity)).toBeNull();
      expect(codexRateLimitWindow(10080, undefined, null)).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
