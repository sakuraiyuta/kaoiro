// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../src/lib/AgentDetail.svelte";
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
});

function state(agentId: string, name: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    persona: { id: agentId, name, sprite_set: agentId },
    ts: "2026-07-13T05:00:00Z",
    type: "state_change",
    state: "idle",
    payload: {},
    ext: {},
  };
}

const message: Envelope = {
  ...state("agent-a", "A"),
  type: "inter_agent_message",
  payload: {
    to: "agent-b",
    conversation_id: "cnv-105-render",
    turn_number: 3,
    kind: "inform",
    body: "復元されたメッセージ",
    meta: { done: false, propose_next: "reply" },
    owner: { kind: "agent", id: "agent-a" },
  },
};

async function render(selected: Envelope) {
  const target = document.createElement("div");
  document.body.append(target);
  component = mount(AgentDetail, {
    target,
    props: {
      envelope: selected,
      logs: [message],
      agents: { "agent-a": state("agent-a", "A"), "agent-b": state("agent-b", "B") },
      onClose: vi.fn(),
    },
  });
  await tick();
  return target;
}

describe("inter-agent restored history rendering (#105)", () => {
  it("sender detail に outgoing bubble を描画する", async () => {
    const target = await render(state("agent-a", "A"));
    const bubble = target.querySelector(".inter-agent.outgoing");
    expect(bubble?.textContent).toContain("to B(agent-b)");
    expect(bubble?.textContent).toContain("復元されたメッセージ");
  });

  it("receiver detail に incoming bubble を描画する", async () => {
    const target = await render(state("agent-b", "B"));
    const bubble = target.querySelector(".inter-agent.incoming");
    expect(bubble?.textContent).toContain("from A(agent-a)");
    expect(bubble?.textContent).toContain("復元されたメッセージ");
  });
});
