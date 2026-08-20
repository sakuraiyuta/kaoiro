// @vitest-environment jsdom
// PersonaFace.svelte (issue #245): shared sprite-or-CSS-face renderer
// extracted from 4 manual copies (App.svelte's agent-strip, AgentCard,
// AgentDetail, ResponseTimeline). This is the direct contract test for
// the shared component itself — the acceptance criterion "changing one
// site reflects in all 4" is a consequence of the 4 call sites importing
// this exact component (enforced structurally + by the required-props
// type, see PersonaFace.svelte's Props interface with no optional
// fields); this test pins the component's own render contract per
// `size` preset so a future edit here cannot silently break a caller.
import { mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import PersonaFace from "../src/lib/PersonaFace.svelte";

const mounted: object[] = [];

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
});

function render(props: {
  sprite: string | null;
  variant: string;
  label: string;
  size: "chip" | "card" | "detail" | "timeline";
  imgAltLabelled: boolean;
  faceLabelled: boolean;
}) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(PersonaFace, { target, props: props as never });
  mounted.push(component);
  return target;
}

describe("PersonaFace", () => {
  it("sprite 有りは img を描画し face は描画しない", () => {
    const target = render({
      sprite: "/sprites/ao/idle.png",
      variant: "idle",
      label: "idle",
      size: "card",
      imgAltLabelled: true,
      faceLabelled: true,
    });
    const img = target.querySelector("img.portrait-sprite");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("/sprites/ao/idle.png");
    expect(img?.getAttribute("data-size")).toBe("card");
    expect(img?.getAttribute("data-state")).toBe("idle");
    expect(target.querySelector(".face")).toBeNull();
  });

  it("sprite 無しは face を描画し img は描画しない", () => {
    const target = render({
      sprite: null,
      variant: "thinking",
      label: "thinking",
      size: "detail",
      imgAltLabelled: true,
      faceLabelled: true,
    });
    expect(target.querySelector("img")).toBeNull();
    const face = target.querySelector(".face");
    expect(face).not.toBeNull();
    expect(face?.getAttribute("data-size")).toBe("detail");
    expect(face?.getAttribute("data-state")).toBe("thinking");
    expect(face?.querySelectorAll(".eye").length).toBe(2);
    expect(face?.querySelector(".mouth")).not.toBeNull();
  });

  it("imgAltLabelled=false は alt が空になる (chip / timeline 相当)", () => {
    const target = render({
      sprite: "/sprites/ao/idle.png",
      variant: "idle",
      label: "idle",
      size: "chip",
      imgAltLabelled: false,
      faceLabelled: false,
    });
    expect(target.querySelector("img")?.getAttribute("alt")).toBe("");
  });

  it("imgAltLabelled=true は alt がラベル文字列になる (card / detail 相当)", () => {
    const target = render({
      sprite: "/sprites/ao/idle.png",
      variant: "idle",
      label: "idle",
      size: "card",
      imgAltLabelled: true,
      faceLabelled: true,
    });
    expect(target.querySelector("img")?.getAttribute("alt")).toBe("idle");
  });

  it("faceLabelled=false は aria-hidden で role/aria-label を持たない (chip 相当)", () => {
    const target = render({
      sprite: null,
      variant: "idle",
      label: "idle",
      size: "chip",
      imgAltLabelled: false,
      faceLabelled: false,
    });
    const face = target.querySelector(".face");
    expect(face?.getAttribute("aria-hidden")).toBe("true");
    expect(face?.hasAttribute("role")).toBe(false);
    expect(face?.hasAttribute("aria-label")).toBe(false);
  });

  it("faceLabelled=true は role=img aria-label を持ち aria-hidden を持たない (card/detail/timeline 相当)", () => {
    const target = render({
      sprite: null,
      variant: "idle",
      label: "idle",
      size: "timeline",
      imgAltLabelled: false,
      faceLabelled: true,
    });
    const face = target.querySelector(".face");
    expect(face?.getAttribute("role")).toBe("img");
    expect(face?.getAttribute("aria-label")).toBe("idle");
    expect(face?.hasAttribute("aria-hidden")).toBe(false);
  });

  it.each(["chip", "card", "detail", "timeline"] as const)(
    "size=%s は data-size にそのまま反映される",
    (size) => {
      const target = render({
        sprite: null,
        variant: "idle",
        label: "idle",
        size,
        imgAltLabelled: false,
        faceLabelled: true,
      });
      expect(target.querySelector(".face")?.getAttribute("data-size")).toBe(
        size,
      );
    },
  );
});
