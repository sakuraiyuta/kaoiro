import "./isolation.setup";
// @vitest-environment jsdom
// issue #502: a reply, an operator instruction or an inter-agent message whose
// block quotes nest without limit must not take the detail view down. The bodies
// go through renderMarkdown in the template, so a throw there would break the
// whole transcript, not just the one bubble.
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../src/lib/AgentDetail.svelte";
import type { Envelope } from "../src/lib/protocol";

const HOSTILE = ">".repeat(100_000);
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
});

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
  localStorage.clear();
  vi.restoreAllMocks();
});

function stateEnvelope(): Envelope {
  return {
    version: "0",
    agent_id: "agent-a",
    ts: "2026-10-14T00:00:00Z",
    type: "state_change",
    state: "idle",
    payload: {},
    persona: { id: "a", name: "A", sprite_set: "a" },
  };
}

function logs(): Envelope[] {
  const base = { version: "0", agent_id: "agent-a", state: "thinking" };
  return [
    { ...base, ts: "2026-10-14T00:00:01Z", type: "log", payload: { kind: "assistant", text: HOSTILE } },
    { ...base, ts: "2026-10-14T00:00:02Z", type: "log", payload: { kind: "user", text: HOSTILE } },
    {
      ...base,
      ts: "2026-10-14T00:00:03Z",
      type: "inter_agent_message",
      payload: {
        to: "agent-b",
        conversation_id: "cnv-502",
        turn_number: 1,
        kind: "inform",
        body: HOSTILE,
        meta: { done: false },
        owner: { kind: "agent", id: "agent-a" },
      },
    },
  ] as Envelope[];
}

describe("AgentDetail with bodies that nest block quotes without limit", () => {
  // Measured 1.34-1.75 s across three bubbles (0.5-0.7 s each in marked.lexer), leaving little margin
  // under Vitest's 5,000 ms default during parallel runs; keep 100,000 '>' and allow 30,000 ms.
  it("renders each bubble as escaped text, with its time", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(
      mount(AgentDetail, {
        target,
        props: { envelope: stateEnvelope(), logs: logs(), agents: {}, onClose: vi.fn() },
      }),
    );
    await tick();

    expect(target.querySelector("blockquote")).toBeNull();
    for (const selector of [".msg.assistant", ".msg.user", ".msg.inter-agent"]) {
      const bubble = target.querySelector(selector);
      expect(bubble, `${selector} is missing`).not.toBeNull();
      expect(bubble!.querySelector("time")).not.toBeNull();
      const body = bubble!.querySelector("p:not(.inter-agent-head)");
      expect(body?.textContent, `${selector} body`).toBe(HOSTILE);
    }
  }, 30_000);
});
