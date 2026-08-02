// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../src/lib/AgentDetail.svelte";
import type { Envelope } from "../src/lib/protocol";

let component: object | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-28T10:00:00Z"));
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function envelope(
  resetsAt: number,
  sevenDay?: { status?: string; utilization?: number; resets_at?: number },
): Envelope {
  return {
    version: "0",
    agent_id: "host-a.p",
    ts: "2026-07-28T10:00:00Z",
    type: "state_change",
    state: "idle",
    payload: {},
    ext: {
      rate_limits: {
        five_hour: { status: "allowed_warning", utilization: 0.83, resets_at: resetsAt },
        ...(sevenDay ? { seven_day: sevenDay } : {}),
      },
    },
    persona: { id: "p", name: "P", sprite_set: "p" },
  };
}

async function render(resetsAt: number) {
  const target = document.createElement("div");
  document.body.append(target);
  component = mount(AgentDetail, {
    target,
    props: { envelope: envelope(resetsAt), onClose: vi.fn() },
  });
  await tick();
  return target;
}

function rateValue(target: Element, label: string): string | undefined {
  const dt = [...target.querySelectorAll("dt")].find((node) => node.textContent?.trim() === label);
  return dt?.nextElementSibling?.querySelector(".meter-val")?.textContent?.trim();
}

// Mirrors AgentDetail.svelte's private fmtReset() so tests can predict its
// locale-dependent MM/DD HH:MM output without exporting it from the component.
function fmtResetLike(resetsAtSeconds: number): string {
  return new Date(resetsAtSeconds * 1000).toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

describe("AgentDetail rate-limit snapshot freshness (#164)", () => {
  it("reset が現在より過去なら stale utilization/status を捨てて窓明け表示にする", async () => {
    const target = await render(Date.parse("2026-07-28T09:59:59Z") / 1000);
    expect(rateValue(target, "5h")).toBe("リセット済み");
    expect(target.querySelector(".meter")?.getAttribute("data-status")).toBe("allowed");
  });

  it("reset が現在と等しい境界では snapshot をまだ live として扱う", async () => {
    const target = await render(Date.parse("2026-07-28T10:00:00Z") / 1000);
    expect(rateValue(target, "5h")).toContain("83%");
    expect(target.querySelector(".meter")?.getAttribute("data-status")).toBe("allowed_warning");
  });

  it("panelを開いたまま次のresetを跨ぐとtimerでリセット済みへ更新する", async () => {
    const target = await render(Date.parse("2026-07-28T10:00:01Z") / 1000);
    expect(rateValue(target, "5h")).toContain("83%");

    await vi.advanceTimersByTimeAsync(1001);
    await tick();

    expect(rateValue(target, "5h")).toBe("リセット済み");
    expect(target.querySelector(".meter")?.getAttribute("data-status")).toBe("allowed");
  });

  it("far-future reset はint32上限のtimer sliceにして1ms hot loopを作らない", async () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const target = await render(1e20);
    // fmtReset() は 1e20 を Invalid Date とみなし reset=null を返すため、
    // pct のみの表示になる(併記の余地がない = 緩和不要な厳密比較)。
    expect(rateValue(target, "5h")).toBe("83%");
    expect(
      setTimeoutSpy.mock.calls.some(([, delay]) => delay === 2_147_483_647),
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    await tick();
    expect(rateValue(target, "5h")).toBe("83%");
  });

  it("#164 で pct が常時入るようになっても reset 時刻を併記する(排他フォールバック回帰の防止)", async () => {
    const target = await render(Date.parse("2026-07-28T10:00:01Z") / 1000);
    const value = rateValue(target, "5h");
    expect(value).toContain("83%");
    expect(value).toContain("リセット");
    expect(value).toMatch(/^83% ・ リセット /);
  });

  function sevenDayCell(target: Element): Element | null | undefined {
    const dt = [...target.querySelectorAll("dt")].find(
      (node) => node.textContent?.trim() === "7day",
    );
    return dt?.nextElementSibling;
  }

  it("seven_day が未受信(pct/reset とも無し)なら従来通り placeholder を表示する", async () => {
    // five_hour だけ入れて hasCcStatus のパネル表示ゲートを満たし、seven_day
    // キー自体は与えないことで「未受信」を再現する。
    const target = await render(Date.parse("2026-07-28T11:00:00Z") / 1000);
    expect(sevenDayCell(target)?.querySelector(".cc-pending")?.textContent?.trim()).toBe(
      "まだ情報がありません",
    );
  });

  it("seven_day が pct null + reset ありの sparse snapshot なら placeholder に隠さず reset を inline 表示する", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const resetsAt = Date.parse("2026-08-04T10:00:00Z") / 1000;
    const e = envelope(Date.parse("2026-07-28T11:00:00Z") / 1000, {
      status: "allowed",
      resets_at: resetsAt,
    });
    component = mount(AgentDetail, {
      target,
      props: { envelope: e, onClose: vi.fn() },
    });
    await tick();
    const dd = sevenDayCell(target);
    expect(dd?.querySelector(".cc-pending")).toBeNull();
    expect(dd?.querySelector(".meter-val")?.textContent?.trim()).toBe(
      "リセット " + fmtResetLike(resetsAt),
    );
  });
});
