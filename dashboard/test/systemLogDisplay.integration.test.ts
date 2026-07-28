// @vitest-environment jsdom
// phase-28 A1 (#168): log kind="system" — session-level events the wrapper
// observed (context compaction, conversation reset), which are neither party
// speaking. Pins that AgentDetail renders them AND that they stay out of the
// "latest reply" timeline, which is the whole reason they are not `assistant`.
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../src/lib/AgentDetail.svelte";
import { latestReplies } from "../src/lib/latestReply";
import type { Envelope } from "../src/lib/protocol";

let component: object | null = null;

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function state(agentId: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    persona: { id: agentId, name: "A", sprite_set: agentId },
    ts: "2026-07-28T05:00:00Z",
    type: "state_change",
    state: "idle",
    payload: {},
    ext: {},
  };
}

const systemLog: Envelope = {
  ...state("agent-a"),
  ts: "2026-07-28T05:00:01Z",
  type: "log",
  payload: {
    kind: "system",
    text: "手動コンテキスト圧縮が完了しました (前 22315 tokens → 後 882 tokens)",
  },
};

async function render(logs: Envelope[]) {
  const target = document.createElement("div");
  document.body.append(target);
  component = mount(AgentDetail, {
    target,
    props: {
      envelope: state("agent-a"),
      logs,
      agents: { "agent-a": state("agent-a") },
      onClose: vi.fn(),
    },
  });
  await tick();
  return target;
}

describe("log kind=system rendering (phase-28 A1 / #168)", () => {
  it("compact 通知を 1 行として描画する", async () => {
    const target = await render([systemLog]);
    const line = target.querySelector(".sysline");
    expect(line?.textContent).toContain("手動コンテキスト圧縮が完了しました");
    expect(line?.textContent).toContain("前 22315 tokens → 後 882 tokens");
  });

  it("assistant / user のバブルとしては描画しない", async () => {
    const target = await render([systemLog]);
    expect(target.querySelector(".msg.assistant")).toBeNull();
    expect(target.querySelector(".msg.user")).toBeNull();
  });

  it("返答タイムラインには載らない (assistant で代用しない理由)", () => {
    expect(latestReplies({ "agent-a": [systemLog] })).toEqual([]);
  });
});
