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
import {
  conversationEntryKey,
  type ConversationEntry,
} from "../src/lib/conversationTimeline";
import type { DirectoryEntry, Envelope } from "../src/lib/protocol";

const mounted: object[] = [];

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
  vi.useRealTimers();
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

function interAgent(agentId: string, to: string, ts: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    ts,
    type: "inter_agent_message",
    state: "tool_running",
    payload: { to, body: "handoff" },
  };
}

async function renderTimeline(options: {
  agents: Record<string, Envelope>;
  directory?: Record<string, DirectoryEntry>;
  logs: Record<string, Envelope[]>;
  now?: number;
  readTimelineEntryKeys?: ReadonlySet<string>;
  newTimelineEntryKeys?: ReadonlySet<string>;
  onMarkRead?: (key: string) => void;
  onArrivalAnimationComplete?: (key: string) => void;
  onSelectAgent?: (entry: ConversationEntry) => void;
}) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(ResponseTimeline, {
    target,
    props: {
      agents: options.agents,
      ...(options.directory ? { directory: options.directory } : {}),
      logs: options.logs,
      manifest: null,
      now: options.now ?? NOW,
      ...(options.readTimelineEntryKeys
        ? { readTimelineEntryKeys: options.readTimelineEntryKeys }
        : {}),
      ...(options.newTimelineEntryKeys
        ? { newTimelineEntryKeys: options.newTimelineEntryKeys }
        : {}),
      ...(options.onMarkRead ? { onMarkRead: options.onMarkRead } : {}),
      ...(options.onArrivalAnimationComplete
        ? { onArrivalAnimationComplete: options.onArrivalAnimationComplete }
        : {}),
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

  it("agent 発話は未閲覧で始まり、300ms hover または click で既読になる", async () => {
    vi.useFakeTimers();
    const onSelectAgent = vi.fn();
    const onMarkRead = vi.fn();
    const target = await renderTimeline({
      agents: { "lab-pc.a": stateEnv("lab-pc.a", "あお") },
      logs: { "lab-pc.a": [assistant("lab-pc.a", secAgo(10), "hi")] },
      onSelectAgent,
      onMarkRead,
    });
    const row = target.querySelector<HTMLButtonElement>(".row")!;
    expect(row.classList.contains("unread")).toBe(true);

    row.dispatchEvent(new MouseEvent("mouseenter"));
    await vi.advanceTimersByTimeAsync(299);
    expect(row.classList.contains("unread")).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await tick();
    expect(onMarkRead).toHaveBeenCalledWith(
      conversationEntryKey(assistant("lab-pc.a", secAgo(10), "hi")),
    );

    row.click();
    expect(onSelectAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        detailAgentId: "lab-pc.a",
        envelope: expect.objectContaining({
        agent_id: "lab-pc.a",
        type: "log",
        }),
      }),
    );
  });

  it("user prompt は初期から既読で、短い hover では未閲覧状態を作らない", async () => {
    vi.useFakeTimers();
    const target = await renderTimeline({
      agents: { "lab-pc.a": stateEnv("lab-pc.a", "あお") },
      logs: { "lab-pc.a": [user("lab-pc.a", secAgo(10), "hey")] },
    });
    const row = target.querySelector<HTMLButtonElement>(".row")!;
    expect(row.classList.contains("unread")).toBe(false);
    row.dispatchEvent(new MouseEvent("mouseenter"));
    await vi.advanceTimersByTimeAsync(300);
    await tick();
    expect(row.classList.contains("unread")).toBe(false);
  });

  it("live arrival key を渡した agent 行だけに一回限りの点滅 class を付ける", async () => {
    const env = assistant("lab-pc.a", secAgo(10), "live reply");
    const target = await renderTimeline({
      agents: { "lab-pc.a": stateEnv("lab-pc.a", "あお") },
      logs: { "lab-pc.a": [env] },
      newTimelineEntryKeys: new Set([conversationEntryKey(env)]),
    });
    expect(target.querySelector(".row")?.classList.contains("new-arrival")).toBe(
      true,
    );
  });

  it("row click → detail → close 相当の remount 後も既読を維持する", async () => {
    const env = assistant("lab-pc.a", secAgo(10), "read persists");
    let readKeys = new Set<string>();
    const first = await renderTimeline({
      agents: { "lab-pc.a": stateEnv("lab-pc.a", "あお") },
      logs: { "lab-pc.a": [env] },
      onMarkRead: (key) => (readKeys = new Set(readKeys).add(key)),
    });
    first.querySelector<HTMLButtonElement>(".row")!.click();
    expect(readKeys).toEqual(new Set([conversationEntryKey(env)]));

    // App owns this Set while the detail view unmounts the timeline. Closing
    // the detail mounts a fresh ResponseTimeline with the same session state.
    const remounted = await renderTimeline({
      agents: { "lab-pc.a": stateEnv("lab-pc.a", "あお") },
      logs: { "lab-pc.a": [env] },
      readTimelineEntryKeys: readKeys,
    });
    expect(remounted.querySelector(".row")?.classList.contains("unread")).toBe(false);
  });

  it("animationend で消費した arrival marker は remount 後に再点滅しない", async () => {
    const env = assistant("lab-pc.a", secAgo(10), "one shot");
    let arrivalKeys = new Set([conversationEntryKey(env)]);
    const first = await renderTimeline({
      agents: { "lab-pc.a": stateEnv("lab-pc.a", "あお") },
      logs: { "lab-pc.a": [env] },
      newTimelineEntryKeys: arrivalKeys,
      onArrivalAnimationComplete: (key) => {
        const next = new Set(arrivalKeys);
        next.delete(key);
        arrivalKeys = next;
      },
    });
    const row = first.querySelector<HTMLButtonElement>(".row")!;
    const end = new Event("animationend");
    Object.defineProperty(end, "animationName", { value: "timeline-arrival" });
    row.dispatchEvent(end);
    expect(arrivalKeys).toEqual(new Set());

    const remounted = await renderTimeline({
      agents: { "lab-pc.a": stateEnv("lab-pc.a", "あお") },
      logs: { "lab-pc.a": [env] },
      newTimelineEntryKeys: arrivalKeys,
    });
    expect(remounted.querySelector(".row")?.classList.contains("new-arrival")).toBe(false);
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

  it("row クリックで agent と該当 envelope を渡す", async () => {
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
    // user prompt でも click は送信先 agent と transcript anchor を渡す。
    expect(onSelectAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        detailAgentId: "lab-pc.a",
        envelope: expect.objectContaining({
          agent_id: "lab-pc.a",
          type: "log",
          payload: { kind: "user", text: "hey" },
        }),
      }),
    );
  });

  it("directory-only IA の click は directory fallback の sender pane を選ぶ", async () => {
    const onSelectAgent = vi.fn();
    const target = await renderTimeline({
      agents: {},
      directory: {
        "offline.sender": {
          persona: { id: "ao", name: "あお", sprite_set: "ao" },
          last_seen: null,
        },
      },
      logs: {
        "offline.sender": [
          interAgent("offline.sender", "agent-b", secAgo(10)),
        ],
      },
      onSelectAgent,
    });
    target.querySelector<HTMLButtonElement>(".row")!.click();
    expect(onSelectAgent).toHaveBeenCalledWith(
      expect.objectContaining({ detailAgentId: "offline.sender" }),
    );
  });

  it("server synthetic IA の click は recipient pane を選ぶ", async () => {
    const onSelectAgent = vi.fn();
    const target = await renderTimeline({
      agents: { "agent-b": stateEnv("agent-b", "もも") },
      logs: { "agent-b": [interAgent("server", "agent-b", secAgo(10))] },
      onSelectAgent,
    });
    target.querySelector<HTMLButtonElement>(".row")!.click();
    expect(onSelectAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "server",
        detailAgentId: "agent-b",
      }),
    );
  });

  it("空 summary の assistant は '(空応答)' を表示", async () => {
    const emptyAssistant: Envelope = {
      version: "0",
      agent_id: "lab-pc.a",
      ts: secAgo(5),
      type: "log",
      state: "thinking",
      payload: { kind: "assistant" },
    };
    const target = await renderTimeline({
      agents: { "lab-pc.a": stateEnv("lab-pc.a", "あお") },
      logs: { "lab-pc.a": [emptyAssistant] },
    });
    expect(target.querySelector(".summary")?.textContent?.trim()).toBe(
      "(空応答)",
    );
  });

  // ふじ 検収 2 fix-round A3 (2026-07-23): user 発の空 prompt は
  // "(空メッセージ)" を表示 (agent 発の "(空応答)" と区別)。
  it("空 summary の user prompt は '(空メッセージ)' を表示 (agent 側との区別)", async () => {
    const emptyUser: Envelope = {
      version: "0",
      agent_id: "lab-pc.a",
      ts: secAgo(5),
      type: "log",
      state: "sending",
      payload: { kind: "user" },
    };
    const target = await renderTimeline({
      agents: { "lab-pc.a": stateEnv("lab-pc.a", "あお") },
      logs: { "lab-pc.a": [emptyUser] },
    });
    expect(target.querySelector(".summary")?.textContent?.trim()).toBe(
      "(空メッセージ)",
    );
  });
});
