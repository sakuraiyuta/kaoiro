// @vitest-environment jsdom
// AgentCard のペルソナ画像クリック (issue #232 MF-2, ふじ round-1
// must-fix): `.persona-open` は `.open` の SIBLING <button> — 画像を
// `.open` の外に出したことで、画像アクションだけを Tab で個別に到達
// できる (旧・pointer 座標分岐実装は keyboard から到達不能だった)。
// keyboard activation (native <button> の click イベントとして観測)、
// 画像/非画像 pointer の宛先分離、callback 無し/persona id 無しの
// disabled fallback をそれぞれ pin する。
import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import AgentCard from "../src/lib/AgentCard.svelte";
import type { Envelope } from "../src/lib/protocol";

const mounted: object[] = [];

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
});

function envelope(personaId: string | undefined): Envelope {
  return {
    version: "0",
    agent_id: "host-a.p",
    ts: "2026-08-09T00:00:00Z",
    type: "state_change",
    state: "tool_running",
    payload: {},
    ...(personaId === undefined
      ? {}
      : { persona: { id: personaId, name: "P", sprite_set: "p" } }),
  };
}

async function render(props: {
  envelope?: Envelope;
  onSelect?: (origin?: { x: number; y: number }) => void;
  onOpenPersonaDetail?: (personaId: string) => void;
}) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(AgentCard, {
    target,
    props: {
      envelope: envelope("p"),
      manifest: null,
      ...props,
    },
  });
  mounted.push(component);
  await tick();
  return target;
}

describe("AgentCard ペルソナ詳細モーダル (issue #232)", () => {
  it("`.persona-open` のクリックは onOpenPersonaDetail をペルソナ id で呼ぶ", async () => {
    const onSelect = vi.fn();
    const onOpenPersonaDetail = vi.fn();
    const target = await render({ onSelect, onOpenPersonaDetail });

    const button = target.querySelector<HTMLButtonElement>(".persona-open")!;
    expect(button.disabled).toBe(false);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    expect(onOpenPersonaDetail).toHaveBeenCalledWith("p");
    expect(onSelect).not.toHaveBeenCalled();
  });

  // native <button> の click() は Enter/Space 押下でブラウザが発火する
  // のと同じイベントであり、jsdom でも同一の観測点 — 座標分岐だった旧
  // 実装ではここが到達不能だった(ふじ実測: onSelect=1/onOpenPersonaDetail=0)。
  it("`.persona-open` は keyboard activation (Enter/Space 相当) でも同じハンドラを呼ぶ", async () => {
    const onOpenPersonaDetail = vi.fn();
    const target = await render({ onOpenPersonaDetail });

    const button = target.querySelector<HTMLButtonElement>(".persona-open")!;
    button.focus();
    button.click();
    await tick();

    expect(onOpenPersonaDetail).toHaveBeenCalledWith("p");
  });

  it("`.open` (画像以外) のクリックは onSelect を呼び、onOpenPersonaDetail は呼ばない", async () => {
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

  it("onOpenPersonaDetail 未指定なら `.persona-open` が disabled になる (onSelect へのフォールバックは無い)", async () => {
    const onSelect = vi.fn();
    const target = await render({ onSelect });

    const button = target.querySelector<HTMLButtonElement>(".persona-open")!;
    expect(button.disabled).toBe(true);
  });

  it("persona id 不在なら `.persona-open` が disabled になる", async () => {
    const onOpenPersonaDetail = vi.fn();
    const target = await render({
      envelope: envelope(undefined),
      onOpenPersonaDetail,
    });

    const button = target.querySelector<HTMLButtonElement>(".persona-open")!;
    expect(button.disabled).toBe(true);
  });
});
