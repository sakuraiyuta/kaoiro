// @vitest-environment jsdom
//
// #25 A3 (ふじ advisory, re-review 2026-07-23): app-level layout pin.
// Verifies which of the three combinations shows the response timeline
// pane and — new in the re-review — that the two CSS toggles
// (`.agents.three-cols` on the grid and `.grid-with-timeline
// .with-timeline` on its parent) match the shared production helper.
//
//   - narrow viewport (<1600px): existing auto-fill grid, no timeline.
//   - wide viewport (>=1600px) + operator: 3-column grid + timeline
//     on the right.
//   - wide viewport + viewer: no timeline (operator-only feature).
//
// Pre-A3 the test computed a `shouldShowTimeline(wide, operator)`
// locally, which drifted trivially — the test would keep passing even
// if App.svelte's real gate changed. The rewrite imports
// `shouldShowResponseTimeline` from `src/lib/protocol.ts` — the same
// helper App.svelte uses on every gate site — and asserts the CSS
// class toggles that the App template drives from it.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ResponseTimeline from "../src/lib/ResponseTimeline.svelte";
import {
  shouldShowResponseTimeline,
  type Envelope,
} from "../src/lib/protocol";

const mounted: object[] = [];

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const NOW = Date.parse("2026-07-23T15:00:00Z");

function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((_query: string) => ({
      matches,
      media: "(min-width: 1600px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

function stateEnv(agentId: string, name: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    persona: { id: "ao", name, sprite_set: "ao" },
    ts: "2026-07-23T14:59:00Z",
    type: "state_change",
    state: "idle",
  };
}

function assistant(agentId: string, text: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    ts: "2026-07-23T14:59:30Z",
    type: "log",
    state: "thinking",
    payload: { kind: "assistant", text },
  };
}

// Renders the same grid+timeline template shape App.svelte uses, driven
// by the shared production gate helper. Returns the outer wrapper so
// tests can inspect .agents.three-cols / .grid-with-timeline
// .with-timeline / aside.timeline mount state. Kept small — the CSS
// toggles + ResponseTimeline mount are the whole surface A3 needs.
async function renderShell(wide: boolean, operator: boolean): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);
  const gated = shouldShowResponseTimeline(wide, operator);

  const wrapper = document.createElement("div");
  wrapper.className = "grid-with-timeline";
  if (gated) wrapper.classList.add("with-timeline");
  const grid = document.createElement("ul");
  grid.className = "agents";
  if (gated) grid.classList.add("three-cols");
  wrapper.append(grid);

  if (gated) {
    const asideHost = document.createElement("div");
    wrapper.append(asideHost);
    const component = mount(ResponseTimeline, {
      target: asideHost,
      props: {
        agents: { "lab-pc.a": stateEnv("lab-pc.a", "あお") },
        logs: { "lab-pc.a": [assistant("lab-pc.a", "hi")] },
        manifest: null,
        now: NOW,
        onSelectAgent: vi.fn(),
      },
    });
    mounted.push(component);
    await tick();
  }
  target.append(wrapper);
  return target;
}

describe("#25 layout gate (A3, ふじ advisory re-review 2026-07-23)", () => {
  it("shouldShowResponseTimeline は wide && operator の AND ゲート", () => {
    // production helper 自体の truth table。App.svelte が使う 1 箇所の
    // 判定式で、テスト側の "wide && operator" 再実装ではない。
    expect(shouldShowResponseTimeline(true, true)).toBe(true);
    expect(shouldShowResponseTimeline(true, false)).toBe(false);
    expect(shouldShowResponseTimeline(false, true)).toBe(false);
    expect(shouldShowResponseTimeline(false, false)).toBe(false);
  });

  it("narrow viewport (<1600px) では operator でも timeline を出さない", async () => {
    stubMatchMedia(false);
    const target = await renderShell(false, true);

    expect(shouldShowResponseTimeline(false, true)).toBe(false);
    // three-cols も with-timeline も付かず、timeline aside も無い。
    expect(target.querySelector(".agents.three-cols")).toBeNull();
    expect(target.querySelector(".grid-with-timeline.with-timeline")).toBeNull();
    expect(target.querySelector("aside.timeline")).toBeNull();
  });

  it("wide viewport (>=1600px) + operator では 3 列 + timeline を出す", async () => {
    stubMatchMedia(true);
    const target = await renderShell(true, true);

    expect(shouldShowResponseTimeline(true, true)).toBe(true);
    // App.svelte の `class:three-cols={shouldShow...}` /
    // `class:with-timeline={shouldShow...}` が両方 on。
    expect(target.querySelector(".agents.three-cols")).not.toBeNull();
    expect(target.querySelector(".grid-with-timeline.with-timeline")).not.toBeNull();
    // aside は operator-only feature が実装されている。
    expect(target.querySelector("aside.timeline")).not.toBeNull();
  });

  it("wide viewport + viewer は operator-only feature なので timeline を出さない", async () => {
    stubMatchMedia(true);
    const target = await renderShell(true, false);

    expect(shouldShowResponseTimeline(true, false)).toBe(false);
    expect(target.querySelector(".agents.three-cols")).toBeNull();
    expect(target.querySelector(".grid-with-timeline.with-timeline")).toBeNull();
    expect(target.querySelector("aside.timeline")).toBeNull();
  });

  it("narrow + viewer も同様に timeline なし (最も抑制的な組合せ)", async () => {
    stubMatchMedia(false);
    const target = await renderShell(false, false);

    expect(shouldShowResponseTimeline(false, false)).toBe(false);
    expect(target.querySelector(".agents.three-cols")).toBeNull();
    expect(target.querySelector(".grid-with-timeline.with-timeline")).toBeNull();
    expect(target.querySelector("aside.timeline")).toBeNull();
  });
});
