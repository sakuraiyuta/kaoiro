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

  it("done は短 hold より長く保持され、自然継承の waiting_input は順次表示する", () => {
    const q = new StatusQueue("thinking", 2000, 180_000);
    q.push("done");
    expect(q.shown).toBe("done");

    q.push("waiting_input"); // natural follow-up: queued behind the long hold
    vi.advanceTimersByTime(2000);
    expect(q.shown).toBe("done"); // short hold has elapsed but long hold still holds

    vi.advanceTimersByTime(180_000 - 2000);
    expect(q.shown).toBe("waiting_input");

    q.dispose();
  });

  it("done hold 中の能動的遷移はキューを破棄し即時表示する", () => {
    const q = new StatusQueue("thinking", 2000, 180_000);
    q.push("done");
    q.push("waiting_input"); // queued
    q.push("sending"); // active transition: interrupt the long hold
    expect(q.shown).toBe("sending");

    // Once shown, sending follows the short hold.
    vi.advanceTimersByTime(2000);
    expect(q.shown).toBe("sending"); // dropped waiting_input never resurfaces

    q.dispose();
  });

  it("done が来たら backlog を破棄、現在表示の hold は尊重して #release 後に表示される (#79)", () => {
    const q = new StatusQueue("idle", 2000, 180_000);
    q.push("thinking"); // shown immediately
    expect(q.shown).toBe("thinking");
    q.push("tool_running"); // queued
    q.push("thinking"); // queued
    q.push("tool_running"); // queued

    q.push("done"); // terminal arrival drops backlog

    // Display still holds "thinking" for the rest of its MIN_DISPLAY_MS.
    expect(q.shown).toBe("thinking");
    vi.advanceTimersByTime(1999);
    expect(q.shown).toBe("thinking");
    // #release fires -> done shown without waiting for the dropped backlog.
    vi.advanceTimersByTime(1);
    expect(q.shown).toBe("done");
    q.dispose();
  });

  it("done の重複 push でも intermediate が確実に破棄される (#79)", () => {
    const q = new StatusQueue("idle", 2000, 180_000);
    q.push("thinking"); // shown
    q.push("tool_running"); // queue=[tool_running]
    q.push("done"); // backlog-drop branch fires -> queue=[done]
    q.push("done"); // dedup tail (no change) -> queue still [done]

    vi.advanceTimersByTime(2000); // thinking's hold elapses
    expect(q.shown).toBe("done"); // not "tool_running"
    q.dispose();
  });

  it("error も #79 backlog-drop ブランチに従う", () => {
    const q = new StatusQueue("idle", 2000, 180_000);
    q.push("thinking");
    q.push("tool_running"); // queued
    q.push("error"); // terminal arrival drops backlog
    expect(q.shown).toBe("thinking");
    vi.advanceTimersByTime(2000);
    expect(q.shown).toBe("error");
    q.dispose();
  });

  it("hold 中の push は shown を変えず、unhold で最新 live が即時表示される (#82)", () => {
    const q = new StatusQueue("idle", 2000);
    q.push("waiting_permission");
    expect(q.shown).toBe("waiting_permission");

    q.hold("waiting_permission");
    q.push("tool_running"); // dialog open: must not surface
    q.push("thinking"); // dialog open: overwritten, only latest kept
    expect(q.shown).toBe("waiting_permission");

    // Even after the normal short-hold elapses, the pin holds.
    vi.advanceTimersByTime(5000);
    expect(q.shown).toBe("waiting_permission");

    q.unhold();
    expect(q.shown).toBe("thinking"); // latest live shown immediately

    q.dispose();
  });

  it("hold は shown が一致しない場合でも pin 値へ即時切り替える (#82)", () => {
    const q = new StatusQueue("thinking", 2000);
    expect(q.shown).toBe("thinking");

    q.hold("waiting_permission");
    expect(q.shown).toBe("waiting_permission");

    q.unhold();
    expect(q.shown).toBe("waiting_permission"); // no live arrived: stays
    q.dispose();
  });

  it("error も done と同じ長 hold と割込みに従う", () => {
    const q = new StatusQueue("thinking", 2000, 180_000);
    q.push("error");
    expect(q.shown).toBe("error");

    vi.advanceTimersByTime(2000);
    expect(q.shown).toBe("error"); // long hold still holds

    q.push("sending"); // active transition: interrupt
    expect(q.shown).toBe("sending");

    q.dispose();
  });
});
