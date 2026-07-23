// @vitest-environment jsdom
//
// #25 A3 (ふじ advisory, re-review 2026-07-23) + A1 (ふじ 3rd review
// re-re-review 2026-07-23): true App-integration layout gate pin.
// Verifies which of the three combinations shows the response timeline
// pane and — new since A1 — that the pin actually mounts the same
// production component App.svelte uses (`AgentGridShell.svelte`) and
// derives `wide` from the stubbed matchMedia matcher instead of
// passing an explicit boolean.
//
//   - narrow viewport (<1600px): existing auto-fill grid, no timeline.
//   - wide viewport (>=1600px) + operator: 3-column grid + timeline
//     on the right.
//   - wide viewport + viewer: no timeline (operator-only feature).
//
// Pre-A3 the test computed a `shouldShowTimeline(wide, operator)`
// locally, which drifted trivially. Pre-A1 the test derived `wide`
// from an explicit arg (stubMatchMedia was set but never consulted).
// The rewrite mounts AgentGridShell — the same component App.svelte
// wraps its tile list with — and derives `wide` from
// `window.matchMedia("(min-width: 1600px)").matches`, so the
// stubMatchMedia effect actually flows into the gate the same way it
// does in App.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentGridShell from "../src/lib/AgentGridShell.svelte";
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
const MEDIA_QUERY = "(min-width: 1600px)";

function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((_query: string) => ({
      matches,
      media: MEDIA_QUERY,
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

// Mount AgentGridShell with `wide` sourced from the stubbed matchMedia
// (the same matchMedia read App.svelte's onMount performs, so the stub
// actually flows into the gate). `operator` still rides an explicit
// arg because App derives it from role assignment which is out of
// scope for a layout test.
async function mountShell(operator: boolean): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);
  // App.svelte reads `window.matchMedia(MEDIA_QUERY).matches`; do the
  // same here so stubMatchMedia decides `wide`.
  const wide = window.matchMedia(MEDIA_QUERY).matches;

  const component = mount(AgentGridShell, {
    target,
    props: {
      wide,
      operator,
      agents: { "lab-pc.a": stateEnv("lab-pc.a", "あお") },
      directory: {},
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

describe("#25 layout gate (A3, ふじ 3rd review re-re-review 2026-07-23)", () => {
  it("shouldShowResponseTimeline は wide && operator の AND ゲート", () => {
    // production helper 自体の truth table。App.svelte /
    // AgentGridShell が使う 1 箇所の判定式で、test 側の
    // "wide && operator" 再実装ではない。
    expect(shouldShowResponseTimeline(true, true)).toBe(true);
    expect(shouldShowResponseTimeline(true, false)).toBe(false);
    expect(shouldShowResponseTimeline(false, true)).toBe(false);
    expect(shouldShowResponseTimeline(false, false)).toBe(false);
  });

  it("narrow viewport (<1600px) では operator でも timeline を出さない", async () => {
    stubMatchMedia(false);
    const target = await mountShell(true);

    // three-cols も with-timeline も付かず、timeline aside も無い。
    expect(target.querySelector(".agents.three-cols")).toBeNull();
    expect(target.querySelector(".grid-with-timeline.with-timeline")).toBeNull();
    expect(target.querySelector("aside.timeline")).toBeNull();
  });

  it("wide viewport (>=1600px) + operator では 3 列 + timeline を出す", async () => {
    stubMatchMedia(true);
    const target = await mountShell(true);

    // App.svelte が持つ `class:three-cols={shouldShow...}` /
    // `class:with-timeline={shouldShow...}` の gate は AgentGridShell
    // に移設済み。同じ helper 経由で両方 on になっている。
    expect(target.querySelector(".agents.three-cols")).not.toBeNull();
    expect(target.querySelector(".grid-with-timeline.with-timeline")).not.toBeNull();
    // production の ResponseTimeline が実際に mount されている
    // (test 側 hand-mount ではなく AgentGridShell からのマウント)。
    expect(target.querySelector("aside.timeline")).not.toBeNull();
  });

  it("wide viewport + viewer は operator-only feature なので timeline を出さない", async () => {
    stubMatchMedia(true);
    const target = await mountShell(false);

    expect(target.querySelector(".agents.three-cols")).toBeNull();
    expect(target.querySelector(".grid-with-timeline.with-timeline")).toBeNull();
    expect(target.querySelector("aside.timeline")).toBeNull();
  });

  it("narrow + viewer も同様に timeline なし (最も抑制的な組合せ)", async () => {
    stubMatchMedia(false);
    const target = await mountShell(false);

    expect(target.querySelector(".agents.three-cols")).toBeNull();
    expect(target.querySelector(".grid-with-timeline.with-timeline")).toBeNull();
    expect(target.querySelector("aside.timeline")).toBeNull();
  });

  it("restart 後も directory persona で durable IA の送信元を表示する", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const ia: Envelope = {
      version: "0",
      agent_id: "offline.sender",
      ts: "2026-07-23T14:59:30Z",
      type: "inter_agent_message",
      state: "done",
      payload: { to: "offline.receiver", body: "durable message" },
    };
    const component = mount(AgentGridShell, {
      target,
      props: {
        wide: true,
        operator: true,
        agents: {},
        directory: {
          "offline.sender": { persona: { id: "ao", name: "あお", sprite_set: "ao" }, last_seen: null },
          "offline.receiver": { persona: { id: "momo", name: "もも", sprite_set: "momo" }, last_seen: null },
        },
        logs: { "offline.sender": [ia] },
        manifest: null,
        now: NOW,
        onSelectAgent: vi.fn(),
      },
    });
    mounted.push(component);
    await tick();
    expect(target.querySelector(".who-name")?.textContent).toContain("あお");
    expect(target.querySelector(".receiver")?.textContent).toContain("もも");
    expect(target.querySelector(".portrait-fallback")).not.toBeNull();
  });

  it("production timeline は初期50件から bottom scroll ごとに増分描画する", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const logs = Array.from({ length: 101 }, (_, index) => ({
      ...assistant("lab-pc.a", `row ${index + 1}`),
      seq: index + 1,
    }));
    const component = mount(AgentGridShell, {
      target,
      props: {
        wide: true,
        operator: true,
        agents: { "lab-pc.a": stateEnv("lab-pc.a", "あお") },
        directory: {},
        logs: { "lab-pc.a": logs },
        manifest: null,
        now: NOW,
        onSelectAgent: vi.fn(),
      },
    });
    mounted.push(component);
    await tick();

    const rows = target.querySelector("ul.rows") as HTMLElement;
    expect(rows.querySelectorAll("li")).toHaveLength(50);
    Object.defineProperties(rows, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, value: 0, writable: true },
    });

    rows.dispatchEvent(new Event("scroll"));
    await tick();
    expect(rows.querySelectorAll("li")).toHaveLength(100);
    rows.dispatchEvent(new Event("scroll"));
    await tick();
    expect(rows.querySelectorAll("li")).toHaveLength(101);
    rows.dispatchEvent(new Event("scroll"));
    await tick();
    expect(rows.querySelectorAll("li")).toHaveLength(101);
  });
});
