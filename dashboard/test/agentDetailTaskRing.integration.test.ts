// @vitest-environment jsdom
// AgentDetail の 頭上リング (issue #180 follow-up, 2026-08-10): AgentCard
// と同じ表示契約 (activeTaskCount > 0 のときだけ .task-ring を描画、数値
// は出さない) を AgentDetail 側でも固定する。マスター指摘: 32-3 実装時は
// AgentCard のみに実装され AgentDetail には無かった (phase-32 プラン
// 「Follow-up」節参照)。軌道半径は AgentCard の rem 固定と異なり、
// .portrait の可変幅に追随する cqw を使う (クロエ 2026-08-10) — その
// 換算値もここで固定する。
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../src/lib/AgentDetail.svelte";
import type { Envelope, PersonaManifest } from "../src/lib/protocol";

const mounted: object[] = [];

beforeEach(() => {
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
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function envelope(): Envelope {
  return {
    version: "0",
    agent_id: "host-a.p",
    ts: "2026-08-09T00:00:00Z",
    type: "state_change",
    state: "tool_running",
    payload: {},
    persona: { id: "p", name: "P", sprite_set: "p" },
  };
}

const manifestWithSprite: PersonaManifest = {
  version: "1",
  personas: {
    p: {
      states: {
        idle: { url: "/sprites/p/idle.png", hash: "sha256:idle" },
        tool_running: { url: "/sprites/p/tool_running.png", hash: "sha256:tr" },
      },
    },
  },
};

async function render(
  activeTaskCount?: number,
  manifest: PersonaManifest | null = null,
) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(AgentDetail, {
    target,
    props: {
      envelope: envelope(),
      manifest,
      onClose: vi.fn(),
      ...(activeTaskCount !== undefined ? { activeTaskCount } : {}),
    },
  });
  mounted.push(component);
  await tick();
  return target;
}

describe("AgentDetail 頭上リング (issue #180 follow-up)", () => {
  it("activeTaskCount 省略時 (既定 0) はリングを描画しない", async () => {
    const target = await render(undefined);
    expect(target.querySelector(".task-ring")).toBeNull();
  });

  it("activeTaskCount 0 はリングを描画しない", async () => {
    const target = await render(0);
    expect(target.querySelector(".task-ring")).toBeNull();
  });

  it("activeTaskCount > 0 はリングを描画するが、数値は表示しない", async () => {
    const target = await render(3);
    const ring = target.querySelector(".task-ring");
    expect(ring).not.toBeNull();
    expect(ring?.getAttribute("role")).toBe("img");
    expect(ring?.getAttribute("aria-label")).toBe("サブエージェント実行中");
    expect(target.querySelector(".portrait")?.textContent?.trim()).toBe("");
  });

  it("sprite 無し (face fallback) は face 比率の cqw 軌道半径を使う", async () => {
    const target = await render(1, null);
    expect(target.querySelector(".face")).not.toBeNull();
    const ring = target.querySelector(".task-ring") as HTMLElement | null;
    expect(ring).not.toBeNull();
    expect(ring?.classList.contains("face-orbit")).toBe(true);
    expect(ring?.style.getPropertyValue("--orbit-rx")).toBe("17.5cqw");
    expect(ring?.style.getPropertyValue("--orbit-ry")).toBe("6.3cqw");
  });

  it("sprite 有りは sprite 比率の cqw 軌道半径を使う", async () => {
    const target = await render(1, manifestWithSprite);
    expect(target.querySelector("img.sprite")).not.toBeNull();
    const ring = target.querySelector(".task-ring") as HTMLElement | null;
    expect(ring).not.toBeNull();
    expect(ring?.classList.contains("face-orbit")).toBe(false);
    expect(ring?.style.getPropertyValue("--orbit-rx")).toBe("25cqw");
    expect(ring?.style.getPropertyValue("--orbit-ry")).toBe("9cqw");
  });
});
