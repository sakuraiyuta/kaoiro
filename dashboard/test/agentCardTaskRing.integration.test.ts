// @vitest-environment jsdom
// AgentCard の 頭上リング (issue #180, ADR-0019/0047/0048): activeTaskCount
// > 0 のときだけ .task-ring を描画する。数値そのものは表示しない
// (こはく scoping: 数値表示は対象外) — レンダリングされるのは on/off の
// 装飾要素のみであることを固定する。
import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import AgentCard from "../src/lib/AgentCard.svelte";
import {
  applyTaskEnvelope,
  computeActiveTaskCountByAgent,
} from "../src/lib/protocol";
import type { Envelope, PersonaManifest } from "../src/lib/protocol";

const mounted: object[] = [];

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
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
  const component = mount(AgentCard, {
    target,
    props: {
      envelope: envelope(),
      manifest,
      ...(activeTaskCount !== undefined ? { activeTaskCount } : {}),
    },
  });
  mounted.push(component);
  await tick();
  return target;
}

describe("AgentCard 頭上リング (issue #180)", () => {
  it("activeTaskCount 省略時 (既定 0) はリングを描画しない", async () => {
    const target = await render(undefined);
    expect(target.querySelector(".task-ring")).toBeNull();
  });

  it("activeTaskCount 0 はリングを描画しない", async () => {
    const target = await render(0);
    expect(target.querySelector(".task-ring")).toBeNull();
  });

  it("production task 集計では親自身の tasklist だけで AgentCard のリングを出さない (issue #188)", async () => {
    const parent = envelope();
    const tasklist = {
      ...parent,
      type: "task",
      payload: {
        agent_id: parent.agent_id,
        task_id: "tasklist",
        task_type: "tasklist",
        kind: "updated",
        status: "running",
        items: [{ text: "調査", status: "in_progress" }],
      },
    } as Envelope;
    const tasks = applyTaskEnvelope({}, tasklist);
    const count = computeActiveTaskCountByAgent(tasks)[parent.agent_id] ?? 0;

    // `activeTaskCount={0}` を手で渡すだけでなく、App.svelte が使う実際の
    // table -> production aggregator -> AgentCard prop の経路で固定する。
    expect(count).toBe(0);
    const target = await render(count);
    expect(target.querySelector(".task-ring")).toBeNull();
  });

  it("activeTaskCount > 0 はリングを描画するが、数値は表示しない", async () => {
    const target = await render(3);
    const ring = target.querySelector(".task-ring");
    expect(ring).not.toBeNull();
    // N1 (クロエ 2026-08-09): サブエージェント稼働の唯一のインジケータで
    // あり装飾ではないため、aria-hidden ではなく role="img" +
    // aria-label で読み上げ対象にする。
    expect(ring?.getAttribute("role")).toBe("img");
    expect(ring?.getAttribute("aria-label")).toBe("サブエージェント実行中");
    // 数値表示は対象外(こはく scoping) — ring 自体もその祖先である
    // .sprite-slot 配下にも "3" というテキストノードは存在しない。
    expect(target.querySelector(".sprite-slot")?.textContent?.trim()).toBe("");
  });

  // S1 (クロエ 最終版, 2026-08-09): face fallback は sprite より小さいため
  // 専用の軌道半径 (.face-orbit) を持つ。manifest 無しなら face fallback、
  // manifest 有り(sprite URL 解決)なら sprite が使われる。
  it("sprite 無し (face fallback) は .task-ring.face-orbit を付与する", async () => {
    const target = await render(1, null);
    expect(target.querySelector(".face")).not.toBeNull();
    const ring = target.querySelector(".task-ring");
    expect(ring).not.toBeNull();
    expect(ring?.classList.contains("face-orbit")).toBe(true);
  });

  it("sprite 有りは .task-ring に face-orbit を付与しない", async () => {
    const target = await render(1, manifestWithSprite);
    expect(target.querySelector("img.portrait-sprite")).not.toBeNull();
    const ring = target.querySelector(".task-ring");
    expect(ring).not.toBeNull();
    expect(ring?.classList.contains("face-orbit")).toBe(false);
  });
});
