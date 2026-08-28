// @vitest-environment jsdom
// issue #228: AgentDetail のログから tool_use/tool_result kind を
// hideNonMessageLogEntries トグルで非表示にする。system・ターン境界・
// assistant/user 本文は対象外で常時表示される契約を固定する。
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../src/lib/AgentDetail.svelte";
import { updateSettings } from "../src/lib/settings.svelte";
import type { Envelope } from "../src/lib/protocol";

const mounted: object[] = [];

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  updateSettings({ hideNonMessageLogEntries: false });
});

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
  updateSettings({ hideNonMessageLogEntries: false });
  localStorage.clear();
  vi.restoreAllMocks();
});

function stateEnvelope(): Envelope {
  return {
    version: "0",
    agent_id: "host-a.p",
    ts: "2026-08-28T00:00:00Z",
    type: "state_change",
    state: "tool_running",
    payload: {},
    persona: { id: "p", name: "P", sprite_set: "p" },
  };
}

// One of each kind AgentDetail branches on, so a toggle regression that
// over-hides (e.g. swallows assistant/user too) or under-hides shows up
// immediately.
function logs(): Envelope[] {
  const agent_id = "host-a.p";
  return [
    {
      version: "0",
      agent_id,
      ts: "2026-08-28T00:00:01Z",
      type: "log",
      state: "thinking",
      payload: { kind: "assistant", text: "assistant reply" },
    },
    {
      version: "0",
      agent_id,
      ts: "2026-08-28T00:00:02Z",
      type: "log",
      state: "thinking",
      payload: { kind: "user", text: "user prompt" },
    },
    {
      version: "0",
      agent_id,
      ts: "2026-08-28T00:00:03Z",
      type: "log",
      state: "tool_running",
      payload: { kind: "system", text: "context compaction" },
    },
    {
      version: "0",
      agent_id,
      ts: "2026-08-28T00:00:04Z",
      type: "log",
      state: "tool_running",
      payload: {
        kind: "tool_use",
        tool_name: "Bash",
        tool_use_id: "tuid-1",
        input: {},
      },
    },
    {
      version: "0",
      agent_id,
      ts: "2026-08-28T00:00:05Z",
      type: "log",
      state: "tool_running",
      payload: {
        kind: "tool_result",
        tool_name: "Bash",
        tool_use_id: "tuid-1",
        output: "ok",
      },
    },
    {
      version: "0",
      agent_id,
      ts: "2026-08-28T00:00:06Z",
      type: "result",
      state: "done",
      payload: { is_error: false },
    },
  ];
}

async function render() {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(AgentDetail, {
    target,
    props: {
      envelope: stateEnvelope(),
      logs: logs(),
      agents: {},
      onClose: vi.fn(),
    },
  });
  mounted.push(component);
  await tick();
  return target;
}

describe("AgentDetail hideNonMessageLogEntries (issue #228)", () => {
  it("既定 (off) では tool_use/tool_result を含む全 kind を表示する", async () => {
    const target = await render();
    expect(target.querySelector('[data-kind="tool_use"]')).not.toBeNull();
    expect(target.querySelector('[data-kind="tool_result"]')).not.toBeNull();
    expect(target.querySelector(".msg.assistant")).not.toBeNull();
    expect(target.querySelector(".msg.user")).not.toBeNull();
    expect(target.querySelector(".sysline")).not.toBeNull();
    expect(target.querySelector(".turn-end")).not.toBeNull();
  });

  it("on にすると tool_use/tool_result のみ非表示になる", async () => {
    updateSettings({ hideNonMessageLogEntries: true });
    const target = await render();
    expect(target.querySelector('[data-kind="tool_use"]')).toBeNull();
    expect(target.querySelector('[data-kind="tool_result"]')).toBeNull();
    expect(target.querySelector(".msg.assistant")).not.toBeNull();
    expect(target.querySelector(".msg.user")).not.toBeNull();
    expect(target.querySelector(".sysline")).not.toBeNull();
    expect(target.querySelector(".turn-end")).not.toBeNull();
  });

  it("off に戻すと再び tool_use/tool_result を表示する", async () => {
    updateSettings({ hideNonMessageLogEntries: true });
    updateSettings({ hideNonMessageLogEntries: false });
    const target = await render();
    expect(target.querySelector('[data-kind="tool_use"]')).not.toBeNull();
    expect(target.querySelector('[data-kind="tool_result"]')).not.toBeNull();
  });

  // ふじ round-1 must-fix M1 (issue #228): row 内側の分岐だけでは hidden
  // entry の外枠 `.transcript-entry` が DOM に残り flex gap の空白になる。
  // 6 件の logs() のうち tool_use/tool_result の 2 件を除いた 4 件分だけが
  // 外枠ごと残ることを固定する。
  it("on にすると tool_use/tool_result は外枠 (.transcript-entry) ごと消える (M1a)", async () => {
    updateSettings({ hideNonMessageLogEntries: true });
    const target = await render();

    const entries = target.querySelectorAll(".transcript-entry");
    expect(entries.length).toBe(4);
    for (const entry of entries) {
      expect(entry.querySelector('[data-kind="tool_use"]')).toBeNull();
      expect(entry.querySelector('[data-kind="tool_result"]')).toBeNull();
    }
  });

  // ふじ round-1 must-fix M1 (3, 最重要): hidden entry が LOG_WINDOW_SIZE=200
  // の window を消費していたため、直近 201 件が tool なら読みたい
  // assistant/user message が window 外へ押し出されていた。on のとき
  // window は「表示対象の行」だけを数えるべき — assistant 1 件 + tool_use
  // 201 件でも assistant が window 内に残ることを固定する。
  it("assistant 1 件 + tool_use 201 件でも on なら assistant が表示される (M1b)", async () => {
    const agent_id = "host-a.p";
    const toolLogs: Envelope[] = Array.from({ length: 201 }, (_, i) => ({
      version: "0",
      agent_id,
      ts: `2026-08-28T00:01:${String(i % 60).padStart(2, "0")}Z`,
      seq: i + 1,
      type: "log",
      state: "tool_running",
      payload: {
        kind: "tool_use",
        tool_name: "Bash",
        tool_use_id: `tuid-${i}`,
        input: {},
      },
    }));
    const allLogs: Envelope[] = [
      {
        version: "0",
        agent_id,
        ts: "2026-08-28T00:00:00Z",
        seq: 0,
        type: "log",
        state: "thinking",
        payload: { kind: "assistant", text: "important assistant reply" },
      },
      ...toolLogs,
    ];

    updateSettings({ hideNonMessageLogEntries: true });
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(AgentDetail, {
      target,
      props: {
        envelope: stateEnvelope(),
        logs: allLogs,
        agents: {},
        onClose: vi.fn(),
      },
    });
    mounted.push(component);
    await tick();

    expect(target.querySelector(".msg.assistant")).not.toBeNull();
  });

  // ふじ round-1 must-fix M1 (c): 設定は $derived 経由でログ描画に効くため、
  // 既に mount 済みの画面でトグルを切り替えても再 mount 不要で即座に
  // 反映されることを固定する。
  it("mount 後の on/off 切替が即座に DOM へ反映される (M1c)", async () => {
    const target = await render();
    expect(target.querySelector('[data-kind="tool_use"]')).not.toBeNull();

    updateSettings({ hideNonMessageLogEntries: true });
    await tick();
    expect(target.querySelector('[data-kind="tool_use"]')).toBeNull();

    updateSettings({ hideNonMessageLogEntries: false });
    await tick();
    expect(target.querySelector('[data-kind="tool_use"]')).not.toBeNull();
  });
});
