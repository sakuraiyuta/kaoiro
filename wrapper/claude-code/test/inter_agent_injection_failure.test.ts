// Regression test for issue #136: notePendingInjection()-registered
// conversations must not leak forever when the injection itself never
// reaches the SDK queue (host.send() rejects, e.g. MAX_QUEUED_TURNS
// overflow). Without the fix, cli.ts's onInterAgentMessage .catch() only
// logs the failure — the turn was never queued, so AgentHost never fires
// onTurnEnd for this conversation_id, and resolveTurnEnd (the only other
// path that clears a pending entry) never runs either.
//
// Uses the REAL AgentHost so the queue-full condition is genuine, not
// mocked, and the REAL InterAgentTool so resolveTurnEnd's behavior is
// exercised end to end. The production `handleInterAgentMessage()` is now
// called directly by inter_agent_lifecycle_glue.test.ts; this narrower test
// starts at its injection-dispatch edge so the queue-full failure and its
// cleanup sequence (notePendingInjection -> host.send() -> .catch()) still
// run against the two real classes instead of a mocked queue.
import { describe, expect, it } from "vitest";
import {
  InterAgentTool,
  classifyInterAgentError,
} from "@kaoiro/agent-common";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { AgentHost } from "../src/host.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

const PEER_PERSONA = { id: "peer", name: "Peer", sprite_set: "peer" };

function inboundEnvelope(conversationId: string): Envelope {
  return {
    version: "0",
    agent_id: "peer.agent",
    persona: PEER_PERSONA,
    display_name: PEER_PERSONA.name,
    ts: "2026-08-05T00:00:00Z",
    type: "inter_agent_message",
    state: "tool_running",
    payload: {
      to: config.agent_id,
      conversation_id: conversationId,
      turn_number: 1,
      kind: "query",
      body: "hi",
      meta: { done: false, propose_next: "" },
      owner: { kind: "user", id: "operator" },
    },
    ext: {},
  };
}

/** Fills AgentHost's input queue to MAX_QUEUED_TURNS (1000, host.ts) without
 *  ever calling run() — the queue then never drains, matching the
 *  "close 後の send は投げる" test's no-run() simplicity. The next send()
 *  synchronously rejects with the real "agent host input queue is full"
 *  error, the exact failure issue #136 names ("MAX_QUEUED_TURNS 超過等"). */
async function makeFullHost(): Promise<AgentHost> {
  const host = new AgentHost(config, { onState: () => {} });
  for (let i = 0; i < 1000; i++) {
    await host.send(`filler ${i}`);
  }
  return host;
}

describe("inter-agent pending injection leak on host.send() failure (issue #136)", () => {
  it("再現: notePendingInjection 後に host.send() が失敗しても、catch が resolveTurnEnd を呼ばなければ pending は残留する", async () => {
    const host = await makeFullHost();
    const tool = new InterAgentTool({
      config,
      getState: () => host.state,
      send: () => {},
    });

    tool.notePendingInjection(inboundEnvelope("cnv-leak"), "test-turn");

    // cli.ts's ORIGINAL (pre-fix) catch: log only, no cleanup.
    await expect(
      host.send("late injection", undefined, ["cnv-leak"]),
    ).rejects.toThrow(/queue is full/);

    // Nothing else in the system will ever call resolveTurnEnd(["cnv-leak"])
    // now — the turn was never queued, so AgentHost never runs a turn for
    // it and onTurnEnd never fires. Simulate a later, unrelated probe: a
    // non-empty result proves the entry never self-cleared.
    const leaked = tool.resolveTurnEnd("test-turn", ["cnv-leak"], {
      code: "api_error",
      message: "later probe",
    });
    expect(leaked).toHaveLength(1);
    expect(leaked[0]?.payload).toMatchObject({
      to: "peer.agent",
      conversation_id: "cnv-leak",
    });
  });

  it("修正: catch で resolveTurnEnd を呼ぶと同じ catch 内で即座に解消し、peer_error 通知が組み立てられる", async () => {
    const host = await makeFullHost();
    const tool = new InterAgentTool({
      config,
      getState: () => host.state,
      send: () => {},
    });

    tool.notePendingInjection(inboundEnvelope("cnv-fixed"), "test-turn");

    // The issue #136 fix wiring, exactly as applied in both cli.ts files'
    // onInterAgentMessage .catch() block (see claude-code/src/cli.ts and
    // codex/src/cli.ts).
    const linkSent: Envelope[] = [];
    await host
      .send("late injection", undefined, ["cnv-fixed"])
      .catch((err: unknown) => {
        const classified = classifyInterAgentError({ detail: String(err) });
        for (const notice of tool.resolveTurnEnd("test-turn", ["cnv-fixed"], classified)) {
          linkSent.push(notice);
        }
      });

    expect(linkSent).toHaveLength(1);
    expect(linkSent[0]?.payload).toMatchObject({
      to: "peer.agent",
      conversation_id: "cnv-fixed",
      kind: "inform",
    });
    expect(
      (linkSent[0]?.payload as { error?: { code: string } }).error?.code,
    ).toBe("api_error");

    // The entry is gone now — a later probe must be a no-op, proving no
    // leak and no double-resolution.
    expect(
      tool.resolveTurnEnd("test-turn", ["cnv-fixed"], { code: "api_error", message: "late" }),
    ).toEqual([]);
  });
});
