// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ResponseTimeline from "../src/lib/ResponseTimeline.svelte";
import type { Envelope } from "../src/lib/protocol";

const mounted: object[] = [];

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
});

const NOW = Date.parse("2026-07-23T15:00:00Z");
const secAgo = (n: number) =>
  new Date(NOW - n * 1000).toISOString().replace(/\.000Z$/, "Z");

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

function assistant(agentId: string, ts: string, text: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    ts,
    type: "log",
    state: "thinking",
    payload: { kind: "assistant", text },
  };
}

async function renderTimeline(options: {
  agents: Record<string, Envelope>;
  logs: Record<string, Envelope[]>;
  now?: number;
  onSelectAgent?: (id: string) => void;
}) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(ResponseTimeline, {
    target,
    props: {
      agents: options.agents,
      logs: options.logs,
      manifest: null,
      now: options.now ?? NOW,
      onSelectAgent: options.onSelectAgent ?? vi.fn(),
    },
  });
  mounted.push(component);
  await tick();
  return target;
}

describe("ResponseTimeline (#25)", () => {
  it("応答なしの状態は「まだ応答なし」を表示", async () => {
    const target = await renderTimeline({ agents: {}, logs: {} });
    expect(target.textContent).toContain("まだ応答なし");
    expect(target.querySelectorAll(".row").length).toBe(0);
  });

  it("agent ごとの最新応答を新しい順に並べる (persona 名 + 相対時刻)", async () => {
    const agents = {
      "lab-pc.a": stateEnv("lab-pc.a", "あお"),
      "lab-pc.b": stateEnv("lab-pc.b", "もも"),
    };
    const logs = {
      "lab-pc.a": [assistant("lab-pc.a", secAgo(600), "10 分前の返答")],
      "lab-pc.b": [assistant("lab-pc.b", secAgo(30), "つい今の返答")],
    };
    const target = await renderTimeline({ agents, logs });
    const rows = target.querySelectorAll(".row");
    expect(rows.length).toBe(2);
    // 新しい順 = もも が先頭。
    expect(rows[0]?.querySelector(".name")?.textContent).toBe("もも");
    expect(rows[0]?.querySelector(".summary")?.textContent).toContain(
      "つい今の返答",
    );
    expect(rows[0]?.querySelector(".when")?.textContent).toBe("30 秒前");
    expect(rows[1]?.querySelector(".name")?.textContent).toBe("あお");
    expect(rows[1]?.querySelector(".when")?.textContent).toBe("10 分前");
  });

  it("row クリックで onSelectAgent(agentId) を発火", async () => {
    const onSelectAgent = vi.fn();
    const target = await renderTimeline({
      agents: { "lab-pc.a": stateEnv("lab-pc.a", "あお") },
      logs: { "lab-pc.a": [assistant("lab-pc.a", secAgo(10), "hi")] },
      onSelectAgent,
    });
    const button = target.querySelector<HTMLButtonElement>(".row")!;
    button.click();
    expect(onSelectAgent).toHaveBeenCalledWith("lab-pc.a");
  });

  it("空 summary の応答は '(空応答)' の placeholder を表示", async () => {
    const emptyResult: Envelope = {
      version: "0",
      agent_id: "lab-pc.a",
      ts: secAgo(5),
      type: "result",
      state: "done",
      payload: { is_error: true },
    };
    const target = await renderTimeline({
      agents: { "lab-pc.a": stateEnv("lab-pc.a", "あお") },
      logs: { "lab-pc.a": [emptyResult] },
    });
    expect(target.querySelector(".summary")?.textContent?.trim()).toBe(
      "(空応答)",
    );
  });
});
