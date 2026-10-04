import "./isolation.setup";
// @vitest-environment jsdom
// AgentCard の顔画像クリック: グリッドでは顔もカードの他の部分と同じく
// エージェント詳細 (タイムライン) を開く (2026-10-05 オペレータ決定)。
// ペルソナ詳細は AgentDetail の portrait から開く (別テスト)。
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
  directoryOnly?: boolean;
  onSelect?: (origin?: { x: number; y: number }) => void;
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

describe("AgentCard 顔クリック", () => {
  it("`.face-open` のクリックは onSelect を呼ぶ", async () => {
    const onSelect = vi.fn();
    const target = await render({ onSelect });

    const button = target.querySelector<HTMLButtonElement>(".face-open")!;
    expect(button.disabled).toBe(false);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("`.face-open` は `.open` と同じ動作なので Tab 順から外れている", async () => {
    const target = await render({ onSelect: vi.fn() });

    expect(target.querySelector(".face-open")!.getAttribute("tabindex")).toBe("-1");
    expect(target.querySelector(".open")!.hasAttribute("tabindex")).toBe(false);
  });

  it("directoryOnly なら `.face-open` は disabled", async () => {
    const onSelect = vi.fn();
    const target = await render({ directoryOnly: true, onSelect });

    const button = target.querySelector<HTMLButtonElement>(".face-open")!;
    expect(button.disabled).toBe(true);
  });

  it("顔クリックの expand origin は .open クリックと同じ card 全体基準になる", async () => {
    const onSelect = vi.fn();
    const target = await render({ onSelect });

    const card = target.querySelector("article.card")!;
    const cardRect = { left: 100, top: 200, width: 300, height: 150 } as DOMRect;
    vi.spyOn(card, "getBoundingClientRect").mockReturnValue(cardRect);

    target
      .querySelector<HTMLButtonElement>(".face-open")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    target.querySelector("h2")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    expect(onSelect).toHaveBeenNthCalledWith(1, { x: 250, y: 275 });
    expect(onSelect).toHaveBeenNthCalledWith(2, { x: 250, y: 275 });
  });
});
