// @vitest-environment jsdom
// AgentCard のペルソナ画像クリック (issue #232): `.sprite-slot` のクリックは
// onOpenPersonaDetail を呼び、カード全体をクリックしたときの onSelect とは
// 別の宛先になる。`.open` ボタン (button) の中に `.sprite-slot` をネストした
// まま (button 内 button は HTML 仕様違反のため独立ボタン化できない) なので、
// クリック先の分岐がここでの唯一の contract — 直接テストする。
import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import AgentCard from "../src/lib/AgentCard.svelte";
import type { Envelope } from "../src/lib/protocol";

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

async function render(props: {
  onSelect?: (origin?: { x: number; y: number }) => void;
  onOpenPersonaDetail?: (personaId: string) => void;
}) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(AgentCard, {
    target,
    props: { envelope: envelope(), manifest: null, ...props },
  });
  mounted.push(component);
  await tick();
  return target;
}

describe("AgentCard ペルソナ詳細モーダル (issue #232)", () => {
  it("`.sprite-slot` のクリックは onOpenPersonaDetail をペルソナ id で呼ぶ", async () => {
    const onSelect = vi.fn();
    const onOpenPersonaDetail = vi.fn();
    const target = await render({ onSelect, onOpenPersonaDetail });

    target
      .querySelector(".sprite-slot")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    expect(onOpenPersonaDetail).toHaveBeenCalledWith("p");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("`.sprite-slot` 以外のクリックは従来どおり onSelect を呼ぶ", async () => {
    const onSelect = vi.fn();
    const onOpenPersonaDetail = vi.fn();
    const target = await render({ onSelect, onOpenPersonaDetail });

    target
      .querySelector("h2")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onOpenPersonaDetail).not.toHaveBeenCalled();
  });

  it("onOpenPersonaDetail 未指定なら画像クリックも onSelect にフォールバックする", async () => {
    const onSelect = vi.fn();
    const target = await render({ onSelect });

    target
      .querySelector(".sprite-slot")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
