// @vitest-environment jsdom
//
// Response-timeline layout gate pin. Mounts the SAME production
// component App.svelte uses (`AgentGridShell.svelte`) so a drift in
// the gate is caught end-to-end.
//
//   - operator: 3-column grid + timeline pane on the right.
//   - viewer:   auto-fill grid, no timeline (operator-only per
//               ADR-0012 — reply logs are operator-only).
//
// The viewport-width threshold (`min-width: 1600px`, #25) was removed
// on 2026-07-24 so the pane shows at all widths for operators —
// narrow viewports accept smaller tiles instead of hiding the pane.

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

async function mountShell(operator: boolean): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);

  const component = mount(AgentGridShell, {
    target,
    props: {
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

describe("response-timeline layout gate (operator-only, ADR-0012)", () => {
  it("shouldShowResponseTimeline は operator gate に等価", () => {
    // production helper 自体の truth table。App.svelte /
    // AgentGridShell が使う 1 箇所の判定式で、test 側の再実装ではない。
    expect(shouldShowResponseTimeline(true)).toBe(true);
    expect(shouldShowResponseTimeline(false)).toBe(false);
  });

  it("operator では 3 列 + timeline を出す (viewport 幅に非依存)", async () => {
    const target = await mountShell(true);

    // AgentGridShell の class 切替が operator gate と同じ helper 経由
    // で両方 on になっていることを確認。
    expect(target.querySelector(".agents.three-cols")).not.toBeNull();
    expect(target.querySelector(".grid-with-timeline.with-timeline")).not.toBeNull();
    // production の ResponseTimeline が実際に mount されている
    // (test 側 hand-mount ではなく AgentGridShell からのマウント)。
    expect(target.querySelector("aside.timeline")).not.toBeNull();
  });

  it("viewer は operator-only feature なので timeline を出さない", async () => {
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
        operator: true,
        agents: {},
        directory: {
          "offline.sender": {
            persona: { id: "ao", name: "あお", sprite_set: "ao" },
            display_name: "あお",
            last_seen: null,
          },
          "offline.receiver": {
            persona: { id: "momo", name: "もも", sprite_set: "momo" },
            display_name: "もも",
            last_seen: null,
          },
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
