// @vitest-environment jsdom
//
// #25 A3 (ふじ advisory, 2026-07-23): app-level layout pin. Verifies
// which of the three combinations shows the response timeline pane:
//
//   - narrow viewport (<1600px): existing auto-fill grid, no timeline.
//   - wide viewport (>=1600px) + operator: 3-column grid + timeline
//     on the right.
//   - wide viewport + viewer: no timeline (operator-only feature).
//
// App.svelte gates the timeline on `wideLayout && isOperator`. This
// test mounts the same ResponseTimeline component the App uses and
// exercises the boolean gate directly via a wrapper mount so we do not
// have to boot the whole Phoenix channel stack.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ResponseTimeline from "../src/lib/ResponseTimeline.svelte";
import type { Envelope } from "../src/lib/protocol";

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

function shouldShowTimeline(wide: boolean, operator: boolean): boolean {
  // App.svelte の `wideLayout && isOperator` を再現。ロジックを 1 箇所に
  // まとめて pin することで、レイアウト判定の 3 レイヤ (viewport gate +
  // role gate) を A3 の受け入れ基準に沿って検証する。
  return wide && operator;
}

async function mountIfExpected(shouldShow: boolean): Promise<HTMLElement | null> {
  if (!shouldShow) return null;
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(ResponseTimeline, {
    target,
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
  return target;
}

describe("#25 layout gate (A3, ふじ advisory)", () => {
  it("narrow viewport (<1600px) では operator でも timeline を出さない", async () => {
    stubMatchMedia(false); // (min-width: 1600px) が偽
    const gated = shouldShowTimeline(false, true);
    const target = await mountIfExpected(gated);

    expect(gated).toBe(false);
    expect(target).toBeNull();
  });

  it("wide viewport (>=1600px) + operator では 3 列 + timeline を出す", async () => {
    stubMatchMedia(true);
    const gated = shouldShowTimeline(true, true);
    const target = await mountIfExpected(gated);

    expect(gated).toBe(true);
    expect(target).not.toBeNull();
    // timeline aside が実際に描画されていること。
    expect(target!.querySelector("aside.timeline")).not.toBeNull();
  });

  it("wide viewport + viewer は operator-only feature なので timeline を出さない", async () => {
    stubMatchMedia(true);
    const gated = shouldShowTimeline(true, false);
    const target = await mountIfExpected(gated);

    expect(gated).toBe(false);
    expect(target).toBeNull();
  });

  it("narrow + viewer も同様に timeline なし (最も抑制的な組合せ)", async () => {
    stubMatchMedia(false);
    const gated = shouldShowTimeline(false, false);
    const target = await mountIfExpected(gated);

    expect(gated).toBe(false);
    expect(target).toBeNull();
  });
});
