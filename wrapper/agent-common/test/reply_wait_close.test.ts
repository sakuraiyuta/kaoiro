import "../../../scripts/test/fixtures/test-isolation.mjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InterAgentTool } from "../src/inter_agent.js";
import type { Envelope, WrapperConfig } from "../src/types.js";

const PERSONA = { id: "mio", name: "mio", sprite_set: "mio" };
const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: PERSONA,
  display_name: PERSONA.name,
  server_url: "ws://localhost:4000/wrapper",
};

function makeTool(): InterAgentTool {
  return new InterAgentTool({
    config,
    getState: () => "tool_running",
    getActiveInterAgentTurnToken: () => "test-turn",
    send: () => {},
    sendInterAgent: async () => ({ kind: "accepted", stamp: null }),
    now: () => "2026-11-15T00:00:00Z",
  });
}

function startWait(tool: InterAgentTool, conversationId: string, timeoutMs: number) {
  return tool.invoke({
    to: "peer.agent",
    body: "please reply",
    kind: "request",
    conversation_id: conversationId,
    wait_for_response: true,
    timeout_ms: timeoutMs,
  });
}

function reply(conversationId: string): Envelope {
  return {
    version: "0",
    agent_id: "peer.agent",
    persona: PERSONA,
    display_name: PERSONA.name,
    ts: "2026-11-15T00:00:01Z",
    type: "inter_agent_message",
    state: "tool_running",
    payload: {
      to: "self.agent",
      conversation_id: conversationId,
      turn_number: 2,
      kind: "response",
      body: "peer reply body",
      meta: { done: false, propose_next: "" },
      owner: { kind: "user", id: "operator" },
    },
    ext: {},
  };
}

const textOf = (result: Awaited<ReturnType<InterAgentTool["invoke"]>>) => result.content[0]!.text;

describe("wait_for_response waiters at wrapper stop", () => {
  describe("close()", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it("releases every pending waiter as reply_pending and clears every timer", async () => {
      const tool = makeTool();
      const baseline = vi.getTimerCount();
      const a = startWait(tool, "cid-a", 300_000);
      const b = startWait(tool, "cid-b", 300_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(baseline + 2);

      tool.close();

      expect(vi.getTimerCount()).toBe(baseline);
      for (const result of await Promise.all([a, b])) {
        expect(result.isError).toBeFalsy();
        expect(textOf(result)).toContain("reply_pending=true (timeout_ms=300000)");
      }
    });

    it("is idempotent and leaves a late reply for ordinary injection", async () => {
      const tool = makeTool();
      const pending = startWait(tool, "cid-late", 300_000);
      await vi.advanceTimersByTimeAsync(0);

      tool.close();
      const released = await pending;
      expect(() => tool.close()).not.toThrow();
      await vi.advanceTimersByTimeAsync(300_001);

      expect(textOf(released)).toContain("reply_pending=true");
      const late = await tool.receiveInbound(reply("cid-late"));
      expect(late.consumed).toBe(false);
      expect(late.inject).toBe(true);
    });

    it("does not overwrite a reply that already settled its waiter", async () => {
      const tool = makeTool();
      const pending = startWait(tool, "cid-done", 300_000);
      await vi.advanceTimersByTimeAsync(0);
      const inbound = reply("cid-done");
      expect((await tool.receiveInbound(inbound)).consumed).toBe(true);

      tool.close();

      expect(JSON.parse(textOf(await pending))).toMatchObject({ reply: inbound });
    });
  });

  it("does not let a pending reply timer keep the event loop alive", async () => {
    const created: Array<{ delay: number | undefined; timer: ReturnType<typeof setTimeout> }> = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: () => void,
      delay?: number,
      ...rest: unknown[]
    ) => {
      const timer = realSetTimeout(handler, delay, ...rest);
      created.push({ delay, timer });
      return timer;
    }) as typeof setTimeout);
    const tool = makeTool();
    try {
      const pending = startWait(tool, "cid-ref", 299_999);
      await vi.waitFor(() => expect(created.some(c => c.delay === 299_999)).toBe(true));
      const wait = created.find(c => c.delay === 299_999)!.timer;
      expect(wait.hasRef()).toBe(false);
      tool.close();
      expect(textOf(await pending)).toContain("reply_pending=true");
    } finally {
      spy.mockRestore();
      tool.close();
    }
  });
});
