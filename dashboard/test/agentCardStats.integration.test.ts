// @vitest-environment jsdom
// AgentCard の engine・model・effort / ctx・5h・7day 追加表示 (issue #193)。
// agent_id 行は #193 以前からの既存表示でこのトグルの対象外(常時表示) —
// 別途固定する。ext は viewer に配信されない (ADR-0021) ので、"ext があれば
// 出す" だけで operator 限定要件を満たす — ext 有無・値欠落・resets_at 過去/
// 未来・設定トグルの各ケースを固定する。
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentCard from "../src/lib/AgentCard.svelte";
import type { Envelope } from "../src/lib/protocol";
import { updateSettings } from "../src/lib/settings.svelte";

const mounted: object[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-04T10:00:00Z"));
  // Reset the shared settings singleton (module-level $state persists
  // across tests in this file) to a known baseline before each case.
  updateSettings({ agentCardStatsEnabled: true });
});

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function envelope(ext?: Record<string, unknown>): Envelope {
  return {
    version: "0",
    agent_id: "host-a.p",
    ts: "2026-08-04T10:00:00Z",
    type: "state_change",
    state: "idle",
    payload: {},
    ...(ext !== undefined ? { ext } : {}),
    persona: { id: "p", name: "P", sprite_set: "p" },
  };
}

async function render(ext?: Record<string, unknown>) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(AgentCard, { target, props: { envelope: envelope(ext) } });
  mounted.push(component);
  await tick();
  return target;
}

function statRow(target: Element, label: string): Element | null {
  const dt = [...target.querySelectorAll(".stat-label")].find(
    (node) => node.textContent?.trim() === label,
  );
  return dt?.parentElement ?? null;
}

describe("AgentCard stats (issue #193)", () => {
  it("ext が無ければ (viewer 相当) 追加行を一切描画しない", async () => {
    const target = await render(undefined);
    expect(target.querySelector(".stats")).toBeNull();
    expect(target.querySelector(".meta-line")).toBeNull();
  });

  it("engine/model/effort/生窓/5h/7day が揃っていれば全て描画する", async () => {
    const target = await render({
      engine: "claude-code",
      model: "claude-opus-5",
      effective: { effort: "high" },
      context: { used_percentage: 42 },
      rate_limits: {
        five_hour: {
          status: "allowed",
          utilization: 0.3,
          resets_at: Date.parse("2026-08-04T15:24:00Z") / 1000,
        },
        seven_day: {
          status: "allowed",
          utilization: 0.6,
          resets_at: Date.parse("2026-08-07T00:00:00Z") / 1000,
        },
      },
    });

    expect(target.querySelector(".meta-line")?.textContent?.trim()).toBe(
      "claude-code / claude-opus-5 / high",
    );

    const ctx = statRow(target, "生窓");
    expect(ctx?.querySelector(".meter-fill")?.getAttribute("style")).toContain("width: 42%");
    expect(ctx?.querySelector(".meter-val")?.textContent?.trim()).toBe("42%");

    const fiveHour = statRow(target, "5h");
    expect(fiveHour?.querySelector(".meter-val")?.textContent?.trim()).toContain("30%");
    // HH:MM in local time, per the issue's sketch ("05:24" style), no date.
    const fiveHourVal = fiveHour?.querySelector(".meter-val")?.textContent ?? "";
    expect(fiveHourVal).toMatch(/\d{2}:\d{2}/);
    expect(fiveHourVal).not.toMatch(/\//); // no month/day in the 5h reset

    const sevenDay = statRow(target, "7day");
    const sevenDayVal = sevenDay?.querySelector(".meter-val")?.textContent ?? "";
    expect(sevenDayVal).toContain("60%");
    // M/D, no zero-padding, no time-of-day.
    expect(sevenDayVal).toMatch(/\d{1,2}\/\d{1,2}/);
    expect(sevenDayVal).not.toMatch(/:/);
  });

  it("context_budget があれば raw 生窓と作業予算を token 分母付きで並べる (#264)", async () => {
    const target = await render({
      context: {
        used_tokens: 150000,
        max_tokens: 200000,
        used_percentage: 75,
      },
      context_budget: {
        work_budget_tokens: 100000,
        work_budget_percentage: 150,
      },
    });
    const raw = statRow(target, "生窓");
    expect(raw?.querySelector(".meter-val")?.textContent).toMatch(
      /75%\s+\(150k\/200k\)/,
    );
    const budget = statRow(target, "作業予算");
    expect(budget?.querySelector(".meter-val")?.textContent).toMatch(
      /150%\s+\(150k\/100k\)/,
    );
    // 100%超を数値で残しつつ、bar は描画可能な幅に留める。
    expect(budget?.querySelector(".meter-fill")?.getAttribute("style")).toContain(
      "width: 100%",
    );
  });

  it("不正な作業予算分母は card でも隠し、生窓を残す (#264)", async () => {
    const target = await render({
      context: {
        used_tokens: 5000,
        max_tokens: 200000,
        used_percentage: 3,
      },
      context_budget: {
        work_budget_tokens: 0,
        work_budget_percentage: 5,
      },
    });
    expect(statRow(target, "生窓")).not.toBeNull();
    expect(statRow(target, "作業予算")).toBeNull();
  });

  it("一部の値だけ欠落しても行/バー単位で非表示にしレイアウトを崩さない (engine 欠落)", async () => {
    const target = await render({
      model: "claude-opus-5",
      effective: { effort: "high" },
    });
    expect(target.querySelector(".meta-line")?.textContent?.trim()).toBe(
      "claude-opus-5 / high",
    );
    expect(statRow(target, "ctx")).toBeNull();
    expect(statRow(target, "5h")).toBeNull();
    expect(statRow(target, "7day")).toBeNull();
  });

  it("ctx だけ欠落していれば ctx 行のみ非表示、他は描画する", async () => {
    const target = await render({
      engine: "claude-code",
      rate_limits: {
        five_hour: { status: "allowed", utilization: 0.1, resets_at: Date.parse("2026-08-04T12:00:00Z") / 1000 },
      },
    });
    expect(statRow(target, "ctx")).toBeNull();
    expect(statRow(target, "5h")).not.toBeNull();
  });

  it("resets_at が過去なら stale utilization を捨てて「リセット済み」表示にする", async () => {
    const target = await render({
      rate_limits: {
        five_hour: {
          status: "allowed_warning",
          utilization: 0.83,
          resets_at: Date.parse("2026-08-04T09:59:59Z") / 1000,
        },
      },
    });
    const fiveHour = statRow(target, "5h");
    expect(fiveHour?.querySelector(".meter-val")?.textContent?.trim()).toBe("リセット済み");
    expect(fiveHour?.querySelector(".meter")?.getAttribute("data-status")).toBe("allowed");
    expect(fiveHour?.querySelector(".meter-fill")?.getAttribute("style")).toContain("width: 0%");
  });

  it("resets_at が現在と等しい境界では snapshot をまだ live として扱う", async () => {
    const target = await render({
      rate_limits: {
        five_hour: {
          status: "allowed_warning",
          utilization: 0.83,
          resets_at: Date.parse("2026-08-04T10:00:00Z") / 1000,
        },
      },
    });
    const fiveHour = statRow(target, "5h");
    expect(fiveHour?.querySelector(".meter-val")?.textContent?.trim()).toContain("83%");
    expect(fiveHour?.querySelector(".meter")?.getAttribute("data-status")).toBe("allowed_warning");
  });

  it("表示中に reset 境界を跨ぐと timer でリセット済みへ更新する", async () => {
    const target = await render({
      rate_limits: {
        five_hour: {
          status: "allowed_warning",
          utilization: 0.83,
          resets_at: Date.parse("2026-08-04T10:00:01Z") / 1000,
        },
      },
    });
    expect(statRow(target, "5h")?.querySelector(".meter-val")?.textContent).toContain("83%");

    await vi.advanceTimersByTimeAsync(1001);
    await tick();

    expect(statRow(target, "5h")?.querySelector(".meter-val")?.textContent?.trim()).toBe(
      "リセット済み",
    );
  });

  it("rejected status は data-status で赤系スタイルに乗る", async () => {
    const target = await render({
      rate_limits: {
        seven_day: {
          status: "rejected",
          utilization: 1,
          resets_at: Date.parse("2026-08-07T00:00:00Z") / 1000,
        },
      },
    });
    expect(statRow(target, "7day")?.querySelector(".meter")?.getAttribute("data-status")).toBe(
      "rejected",
    );
  });

  it("設定トグル off なら ext が揃っていても追加行を描画しない", async () => {
    updateSettings({ agentCardStatsEnabled: false });
    const target = await render({
      engine: "claude-code",
      model: "claude-opus-5",
      effective: { effort: "high" },
      context: { used_percentage: 42 },
    });
    expect(target.querySelector(".stats")).toBeNull();
  });

  it("agent_id 行は #193 以前からの既存表示でトグル対象外 — 設定に関わらず常に表示する", async () => {
    updateSettings({ agentCardStatsEnabled: false });
    const target = await render({ engine: "claude-code" });
    expect(target.querySelector(".id")?.textContent?.trim()).toBe("host-a.p");
  });

  describe("空文字・不正な値のフォールバック (ふじ round-2 S2)", () => {
    it("model / effort が空文字なら null 扱いにして meta line から落とす", async () => {
      const target = await render({
        engine: "claude-code",
        model: "",
        effective: { effort: "" },
      });
      expect(target.querySelector(".meta-line")?.textContent?.trim()).toBe(
        "claude-code",
      );
    });

    it("model / effort が空白のみなら null 扱いにする (trim 後空)", async () => {
      const target = await render({
        engine: "claude-code",
        model: "   ",
        effective: { effort: "\t" },
      });
      expect(target.querySelector(".meta-line")?.textContent?.trim()).toBe(
        "claude-code",
      );
    });

    it("engine が無く model/effort が空文字なら meta line 自体を非表示にする", async () => {
      const target = await render({ model: "", effective: { effort: "" } });
      expect(target.querySelector(".meta-line")).toBeNull();
    });

    it("resets_at が finite でも Date 範囲外なら NaN 表示せず欠落扱いにする", async () => {
      const target = await render({
        rate_limits: {
          five_hour: {
            status: "allowed",
            utilization: 0.3,
            // Finite number, but far outside the ~±273,790 year range a JS
            // Date can represent — new Date(atMs).getTime() is NaN.
            resets_at: 1e20,
          },
        },
      });
      const fiveHour = statRow(target, "5h");
      const val = fiveHour?.querySelector(".meter-val")?.textContent ?? "";
      expect(val).not.toContain("NaN");
      // pct alone still renders — only the reset portion is dropped.
      expect(val.trim()).toBe("30%");
    });
  });

  describe("statsClock タイマーのライフサイクル (ふじ round-2 S1)", () => {
    // Delay math mirrors AgentCard's own: (resetsAtMs - now) + 1, capped at
    // MAX_TIMER_DELAY_MS. Asserting on this EXACT delay (not just "some
    // setTimeout happened") avoids false positives from unrelated timers
    // Svelte or jsdom may schedule internally.
    const RESETS_AT_SEC = Date.parse("2026-08-04T11:00:00Z") / 1000;
    const EXPECTED_DELAY = 3_600_001;

    function statsTimerCalls(spy: { mock: { calls: unknown[][] } }) {
      return spy.mock.calls.filter((call) => call[1] === EXPECTED_DELAY);
    }

    function statsTimerCallIndex(spy: { mock: { calls: unknown[][] } }): number {
      return spy.mock.calls.findIndex((call) => call[1] === EXPECTED_DELAY);
    }

    it("表示中 (トグル on) は該当 delay で timer を 1 つだけ張る", async () => {
      const setTimeoutSpy = vi.spyOn(window, "setTimeout");
      await render({
        rate_limits: {
          five_hour: { status: "allowed", utilization: 0.3, resets_at: RESETS_AT_SEC },
        },
      });
      expect(statsTimerCalls(setTimeoutSpy)).toHaveLength(1);
    });

    it("トグル off なら該当 delay の timer を張らない", async () => {
      updateSettings({ agentCardStatsEnabled: false });
      const setTimeoutSpy = vi.spyOn(window, "setTimeout");
      await render({
        rate_limits: {
          five_hour: { status: "allowed", utilization: 0.3, resets_at: RESETS_AT_SEC },
        },
      });
      expect(statsTimerCalls(setTimeoutSpy)).toHaveLength(0);
    });

    it("表示中にトグルを off にすると既存 timer を clear する", async () => {
      const setTimeoutSpy = vi.spyOn(window, "setTimeout");
      const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
      await render({
        rate_limits: {
          five_hour: { status: "allowed", utilization: 0.3, resets_at: RESETS_AT_SEC },
        },
      });
      const idx = statsTimerCallIndex(setTimeoutSpy);
      expect(idx).toBeGreaterThanOrEqual(0);
      const timerId = setTimeoutSpy.mock.results[idx]?.value;

      updateSettings({ agentCardStatsEnabled: false });
      await tick();

      expect(clearTimeoutSpy.mock.calls.some(([id]) => id === timerId)).toBe(true);
    });

    it("unmount すると timer を clear する", async () => {
      const setTimeoutSpy = vi.spyOn(window, "setTimeout");
      const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
      const target = document.createElement("div");
      document.body.append(target);
      const component = mount(AgentCard, {
        target,
        props: {
          envelope: envelope({
            rate_limits: {
              five_hour: { status: "allowed", utilization: 0.3, resets_at: RESETS_AT_SEC },
            },
          }),
        },
      });
      await tick();
      const idx = statsTimerCallIndex(setTimeoutSpy);
      expect(idx).toBeGreaterThanOrEqual(0);
      const timerId = setTimeoutSpy.mock.results[idx]?.value;

      await unmount(component);

      expect(clearTimeoutSpy.mock.calls.some(([id]) => id === timerId)).toBe(true);
    });

    it("描画されないウィンドウ (seven_day_opus 等) は deadline 候補に含めない", async () => {
      const setTimeoutSpy = vi.spyOn(window, "setTimeout");
      await render({
        rate_limits: {
          seven_day_opus: { status: "allowed", utilization: 0.3, resets_at: RESETS_AT_SEC },
        },
      });
      expect(statsTimerCalls(setTimeoutSpy)).toHaveLength(0);
    });
  });
});
