import { describe, expect, it } from "vitest";
import {
  RELATIVE_TIME_TICK_MS,
  formatRelativeJa,
} from "../src/lib/relativeTime";

// Deterministic clock; each test picks a stamp relative to it so the
// case reads as a duration, not a pair of raw dates.
const NOW = Date.parse("2026-07-23T15:00:00Z");
const secAgo = (n: number) =>
  new Date(NOW - n * 1000).toISOString().replace(/\.000Z$/, "Z");

describe("formatRelativeJa (#25)", () => {
  it("5 秒未満は「たった今」", () => {
    expect(formatRelativeJa(secAgo(0), NOW)).toBe("たった今");
    expect(formatRelativeJa(secAgo(4), NOW)).toBe("たった今");
  });

  it("60 秒未満は「N 秒前」", () => {
    expect(formatRelativeJa(secAgo(5), NOW)).toBe("5 秒前");
    expect(formatRelativeJa(secAgo(59), NOW)).toBe("59 秒前");
  });

  it("1 時間未満は「N 分前」", () => {
    expect(formatRelativeJa(secAgo(60), NOW)).toBe("1 分前");
    expect(formatRelativeJa(secAgo(59 * 60), NOW)).toBe("59 分前");
  });

  it("24 時間未満は「N 時間前」", () => {
    expect(formatRelativeJa(secAgo(60 * 60), NOW)).toBe("1 時間前");
    expect(formatRelativeJa(secAgo(23 * 60 * 60), NOW)).toBe("23 時間前");
  });

  it("24 時間以上は「N 日前」", () => {
    expect(formatRelativeJa(secAgo(24 * 60 * 60), NOW)).toBe("1 日前");
    expect(formatRelativeJa(secAgo(3 * 24 * 60 * 60), NOW)).toBe("3 日前");
  });

  it("空文字 / 不正 ISO / 未来 ts は '—' に倒す", () => {
    expect(formatRelativeJa("", NOW)).toBe("—");
    expect(formatRelativeJa("not-a-date", NOW)).toBe("—");
    // Future ts はレイアウトが揺れないようダッシュ (clock skew fallback)。
    expect(formatRelativeJa(secAgo(-60), NOW)).toBe("—");
  });

  it("RELATIVE_TIME_TICK_MS は 30 秒", () => {
    // 秒→分の切替頻度を pin。半分の周期未満で切替が visible になる想定。
    expect(RELATIVE_TIME_TICK_MS).toBe(30_000);
  });
});
