import "./isolation.setup";
// @vitest-environment jsdom
// AgentCard face click: in the grid the face opens the agent detail
// (timeline) like the rest of the card (PR #908, operator accepted
// 2026-11-01, supersedes the grid-face part of issue #232). Persona detail
// opens from AgentDetail's portrait (a separate test).
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

  it("`.face-open` is hidden from the accessibility tree, `.open` is not (one \"open detail\" button for a screen reader)", async () => {
    const target = await render({ onSelect: vi.fn() });

    // aria-hidden on a focusable element is only safe when it cannot be
    // reached by Tab; tabindex=-1 (previous test) is what allows it
    expect(target.querySelector(".face-open")!.getAttribute("aria-hidden")).toBe("true");
    expect(target.querySelector(".open")!.hasAttribute("aria-hidden")).toBe(false);
    expect(
      target.querySelectorAll('button[aria-label$="の詳細を開く"]:not([aria-hidden="true"])'),
    ).toHaveLength(1);
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
