// @vitest-environment jsdom
//
// 実機検収 3 (2026-07-23 マスター指示): 右ペインは per-agent 最終応答
// 一覧 → 全 agent 会話ログの時系列マージ、に仕様変更。 純関数の
// 分類は conversationTimeline.test.ts が pin、この integration test は
// ResponseTimeline.svelte が正しく描画することを DOM level で pin。
//
// 主な差分:
//   - empty message: 「まだ応答なし」→ 「まだ会話なし」
//   - 1 agent の複数発話がそれぞれ独立行として出る (旧: 各 agent
//     latest 1 行だけ)
//   - kind=user 行は `.row.from-user` class を持ち、名前の代わりに
//     `→ <persona名>` 形式の badge を出す (operator が誰宛に送った
//     prompt かを示す)
//   - tool_use / tool_result / state_change / inter_agent_message
//     は除外

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

function user(agentId: string, ts: string, text: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    ts,
    type: "log",
    state: "sending",
    payload: { kind: "user", text },
  };
}

function toolUse(agentId: string, ts: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    ts,
    type: "log",
    state: "tool_running",
    payload: { kind: "tool_use", text: "cmd" },
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

describe("ResponseTimeline (#25 実機検収 3 仕様変更版)", () => {
  it("会話なしの状態は「まだ会話なし」を表示", async () => {
    const target = await renderTimeline({ agents: {}, logs: {} });
    expect(target.textContent).toContain("まだ会話なし");
    expect(target.querySelectorAll(".row").length).toBe(0);
  });

  it("全 agent の assistant / user / result を時系列マージ (新しい順)", async () => {
    const agents = {
      "lab-pc.a": stateEnv("lab-pc.a", "あお"),
      "lab-pc.b": stateEnv("lab-pc.b", "もも"),
    };
    const logs = {
      "lab-pc.a": [
        assistant("lab-pc.a", secAgo(600), "10 分前の a-assistant"),
        user("lab-pc.a", secAgo(60), "1 分前の operator prompt"),
      ],
      "lab-pc.b": [
        assistant("lab-pc.b", secAgo(30), "つい今の b-assistant"),
      ],
    };
    const target = await renderTimeline({ agents, logs });
    const rows = target.querySelectorAll(".row");
    // 3 行 (per-agent latest ではなく全 3 発話)。
    expect(rows.length).toBe(3);
    // 新しい順: b assistant(30s) > a user(60s) > a assistant(600s)。
    expect(rows[0]?.querySelector(".summary")?.textContent).toContain(
      "つい今の b-assistant",
    );
    expect(rows[1]?.querySelector(".summary")?.textContent).toContain(
      "1 分前の operator prompt",
    );
    expect(rows[2]?.querySelector(".summary")?.textContent).toContain(
      "10 分前の a-assistant",
    );
  });

  it("user prompt 行は .from-user class と `→ <persona名>` badge を持つ", async () => {
    const agents = { "lab-pc.a": stateEnv("lab-pc.a", "あお") };
    const logs = {
      "lab-pc.a": [user("lab-pc.a", secAgo(10), "hey")],
    };
    const target = await renderTimeline({ agents, logs });
    const row = target.querySelector(".row");
    expect(row).not.toBeNull();
    expect(row?.classList.contains("from-user")).toBe(true);
    // agent 発話用の class は付かない。
    expect(row?.classList.contains("from-agent")).toBe(false);
    const badge = row?.querySelector(".who-badge");
    expect(badge?.textContent).toContain("→");
    expect(badge?.textContent).toContain("あお");
  });

  it("agent 発話行は .from-agent class + persona 名 (badge なし)", async () => {
    const agents = { "lab-pc.a": stateEnv("lab-pc.a", "あお") };
    const logs = {
      "lab-pc.a": [assistant("lab-pc.a", secAgo(10), "hi")],
    };
    const target = await renderTimeline({ agents, logs });
    const row = target.querySelector(".row");
    expect(row?.classList.contains("from-agent")).toBe(true);
    expect(row?.classList.contains("from-user")).toBe(false);
    const badge = row?.querySelector(".who-badge");
    expect(badge).toBeNull();
    const name = row?.querySelector(".who-name");
    expect(name?.textContent).toBe("あお");
  });

  it("tool_use / tool_result / state_change / inter_agent_message は除外", async () => {
    const agents = { "lab-pc.a": stateEnv("lab-pc.a", "あお") };
    const logs = {
      "lab-pc.a": [
        assistant("lab-pc.a", secAgo(60), "keep"),
        toolUse("lab-pc.a", secAgo(30)),
      ],
    };
    const target = await renderTimeline({ agents, logs });
    const rows = target.querySelectorAll(".row");
    expect(rows.length).toBe(1);
    expect(rows[0]?.querySelector(".summary")?.textContent).toContain("keep");
  });

  it("row クリックで onSelectAgent(agentId) を発火 (送信先 agent を渡す)", async () => {
    const onSelectAgent = vi.fn();
    const target = await renderTimeline({
      agents: { "lab-pc.a": stateEnv("lab-pc.a", "あお") },
      logs: {
        "lab-pc.a": [user("lab-pc.a", secAgo(10), "hey")],
      },
      onSelectAgent,
    });
    const button = target.querySelector<HTMLButtonElement>(".row")!;
    button.click();
    // user prompt でも click は送信先 agent の詳細を開く。
    expect(onSelectAgent).toHaveBeenCalledWith("lab-pc.a");
  });

  it("空 summary の result は '(空応答)' の placeholder を表示", async () => {
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
