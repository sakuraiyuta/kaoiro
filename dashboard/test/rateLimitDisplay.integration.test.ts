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

function envelope(resetsAt: number): Envelope {
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

describe("AgentDetail rate-limit snapshot freshness (#164)", () => {
  it("reset が現在より過去なら stale utilization/status を捨てて窓明け表示にする", async () => {
    const target = await render(Date.parse("2026-07-28T09:59:59Z") / 1000);
    expect(rateValue(target, "5h")).toBe("リセット済み");
    expect(target.querySelector(".meter")?.getAttribute("data-status")).toBe("allowed");
  });

  it("reset が現在と等しい境界では snapshot をまだ live として扱う", async () => {
    const target = await render(Date.parse("2026-07-28T10:00:00Z") / 1000);
    expect(rateValue(target, "5h")).toBe("83%");
    expect(target.querySelector(".meter")?.getAttribute("data-status")).toBe("allowed_warning");
  });
});
