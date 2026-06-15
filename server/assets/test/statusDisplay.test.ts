// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusQueue } from "../src/lib/statusDisplay.svelte";

describe("StatusQueue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("初期状態を即時表示する", () => {
    const q = new StatusQueue("idle", 2000);
    expect(q.shown).toBe("idle");
    q.dispose();
  });

  it("hold 中の状態はキューに積まれ、間引かず順に表示する (#43)", () => {
    const q = new StatusQueue("idle", 2000);
    q.push("thinking"); // no hold window open -> shown immediately
    expect(q.shown).toBe("thinking");

    q.push("tool_running"); // queued behind the hold window
    q.push("waiting_input"); // also queued (not coalesced away)
    expect(q.shown).toBe("thinking");

    vi.advanceTimersByTime(2000);
    expect(q.shown).toBe("tool_running");

    vi.advanceTimersByTime(2000);
    expect(q.shown).toBe("waiting_input");

    q.dispose();
  });

  it("連続する同一状態は重複表示しない", () => {
    const q = new StatusQueue("idle", 2000);
    q.push("thinking");
    q.push("thinking"); // dropped: equals the tail
    vi.advanceTimersByTime(2000);
    expect(q.shown).toBe("thinking"); // nothing queued behind it
    q.dispose();
  });

  it("dispose 後は保留中の状態へ進まない", () => {
    const q = new StatusQueue("idle", 2000);
    q.push("thinking");
    q.push("tool_running"); // queued
    q.dispose();
    vi.advanceTimersByTime(5000);
    expect(q.shown).toBe("thinking");
  });

  it("dispose 後の push は何も起こさない (遅延 envelope で遷移を復活させない)", () => {
    const q = new StatusQueue("idle", 2000);
    q.push("thinking");
    q.push("tool_running"); // queued behind the hold window
    q.dispose();
    q.push("waiting_input"); // late envelope during teardown -> no-op
    vi.advanceTimersByTime(5000);
    expect(q.shown).toBe("thinking"); // neither the queued nor the late state
  });
});
