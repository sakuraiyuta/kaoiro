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
});
