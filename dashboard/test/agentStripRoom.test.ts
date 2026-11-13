import "./isolation.setup";
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import AgentStripRoom from "../src/lib/AgentStripRoom.svelte";
import { reactiveProps } from "./reactiveProps.svelte";
import { setLocale } from "../src/lib/i18n/index.svelte";

let component: object | null = null;
let callbacks: Map<number, FrameRequestCallback>;
let nextFrame = 0;
let change: (() => void) | undefined;
let media: { matches: boolean; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };
beforeEach(() => {
  setLocale("en");
  callbacks = new Map();
  media = { matches: false, addEventListener: vi.fn((_event, cb) => { change = cb; }), removeEventListener: vi.fn() };
  vi.stubGlobal("matchMedia", () => media);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callbacks.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { callbacks.delete(id); });
});
afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
async function setup() {
  const props = reactiveProps({ groupKey: "room:r1", label: "Review", open: false, count: 30, lamp: "waiting_question" as const, ontoggle: () => { props.open = !props.open; } });
  component = mount(AgentStripRoom, { target: document.body, props });
  await tick();
  return props;
}
const toggle = () => document.querySelector<HTMLButtonElement>("button")!;
const reveal = () => document.querySelector<HTMLElement>(".strip-reveal")!;
async function frame() { for (const [id, cb] of callbacks) { callbacks.delete(id); cb(0); } await tick(); }
function end(propertyName = "clip-path", target: Element = reveal()) {
  const event = new Event("transitionend", { bubbles: true });
  Object.defineProperty(event, "propertyName", { value: propertyName });
  target.dispatchEvent(event);
}
it("uses default motion and completes an actual toggle lifecycle with digits and accessible state", async () => {
  await setup();
  expect(toggle().getAttribute("aria-label")).toBe("Expand room Review, 30 agents, waiting for an answer");
  expect(toggle().getAttribute("aria-controls")).toBe(reveal().id);
  expect(document.querySelector(".strip-count")?.textContent).toBe("30");
  expect(document.querySelector(".state-lamp")?.getAttribute("data-state")).toBe("waiting_question");
  expect(reveal().getAttribute("aria-hidden")).toBe("true");
  expect(reveal().inert).toBe(true);
  toggle().click(); await tick(); await frame();
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  expect(reveal().classList.contains("clipped")).toBe(false);
  toggle().click(); await tick();
  expect(reveal().classList.contains("closed")).toBe(false);
  end("clip-path", document.querySelector(".strip-chips")!); await tick();
  expect(reveal().classList.contains("closed")).toBe(false);
  end("opacity"); await tick();
  expect(reveal().classList.contains("closed")).toBe(false);
  end(); await tick();
  expect(reveal().classList.contains("closed")).toBe(true);
});
it("settles closed when opening is cancelled before the next frame (N1)", async () => {
  await setup(); toggle().click(); await tick();
  expect(callbacks.size).toBe(1);
  toggle().click(); await tick();
  expect(callbacks.size).toBe(0);
  expect(reveal().classList.contains("closed")).toBe(true);
});
it("does not hide a reopened group on a stale closing transition", async () => {
  await setup(); toggle().click(); await tick(); await frame();
  toggle().click(); await tick(); toggle().click(); await tick();
  end(); await tick();
  expect(reveal().classList.contains("closed")).toBe(false);
  expect(reveal().classList.contains("clipped")).toBe(false);
});
it("settles immediately when reduced motion changes during a close and removes its listener", async () => {
  await setup(); toggle().click(); await tick(); await frame();
  toggle().click(); await tick(); media.matches = true; change?.(); await tick();
  expect(reveal().classList.contains("closed")).toBe(true);
  toggle().click(); await tick();
  expect(callbacks.size).toBe(0);
  expect(reveal().classList.contains("clipped")).toBe(false);
  await unmount(component!); component = null;
  expect(media.removeEventListener).toHaveBeenCalledOnce();
});
it("repaints the toggle name when the language changes", async () => {
  await setup(); setLocale("ja"); await tick();
  expect(toggle().getAttribute("aria-label")).toBe("部屋 Review を開く、30 件、回答待ち");
});

it("cancels queued opening work when unmounted", async () => {
  await setup(); toggle().click(); await tick();
  expect(callbacks.size).toBe(1);
  await unmount(component!); component = null;
  expect(callbacks.size).toBe(0);
});
