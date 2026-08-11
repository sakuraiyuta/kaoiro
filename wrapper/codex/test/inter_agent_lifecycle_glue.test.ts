// Adapter-level integration coverage for issue #177 review M4 (AC8/AC9/
// AC15): proves the glue sequence cli.ts's onInterAgentMessage handler
// runs (receiveInbound() -> disposition branch -> conditional host.send()
// / notePendingInjection()) against the REAL CodexHost + REAL
// InterAgentTool, not just InterAgentTool in isolation (which
// inter_agent.test.ts already covers exhaustively). Mirrors
// claude-code/test/inter_agent_lifecycle_glue.test.ts — same glue, same
// assertions, CodexHost in place of AgentHost — to demonstrate AC15
// (both engine adapters share identical lifecycle behaviour) is not just
// a claim about the shared agent-common code but is observably true
// through each engine's own host too. codex/src/cli.ts has no test
// harness of its own (like claude-code's cli.ts), so this reproduces its
// exact glue directly. CodexHost.send() only needs to reach its internal
// queue (#queue.push + #wake?.(), host.ts) — no live thread / run() is
// required, the same reason the claude-code AgentHost variant does not
// call run() either.
import { describe, expect, it, vi } from "vitest";
import { InterAgentTool } from "@kaoiro/agent-common";
import type { Envelope, InterAgentMessagePayload, WrapperConfig } from "@kaoiro/agent-common";
import { CodexHost } from "../src/host.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

const PEER_PERSONA = { id: "peer", name: "Peer", sprite_set: "peer" };

function inboundEnvelope(
  conversationId: string,
  turnNumber: number,
  done = false,
): Envelope {
  return {
    version: "0",
    agent_id: "peer.agent",
    persona: PEER_PERSONA,
    display_name: PEER_PERSONA.name,
    ts: "2026-08-08T00:00:00Z",
    type: "inter_agent_message",
    state: "tool_running",
    payload: {
      to: config.agent_id,
      conversation_id: conversationId,
      turn_number: turnNumber,
      kind: "inform",
      body: "hi",
      meta: { done, propose_next: "" },
      owner: { kind: "user", id: "operator" },
    },
    ext: {},
  };
}

function makeHost(): CodexHost {
  return new CodexHost(config, { onState: () => {}, appendSystemPrompt: "p" });
}

/** Reproduces cli.ts's onInterAgentMessage glue exactly — identical to
 *  claude-code's cli.ts (and to the sibling helper in
 *  claude-code/test/inter_agent_lifecycle_glue.test.ts), modulo the host
 *  type. Async since issue #177 review round 2 (ふじ差し戻し) made
 *  receiveInbound() async (it may gate briefly on a concurrently in-flight
 *  done=true send for the same conversation_id). */
async function runOnInterAgentMessageGlue(
  interAgent: InterAgentTool,
  host: CodexHost,
  envelope: Envelope,
): Promise<void> {
  const disposition = await interAgent.receiveInbound(envelope);
  if (disposition.consumed) return;
  if (!disposition.inject) return;
  const payload = envelope.payload as unknown as InterAgentMessagePayload;
  const text = `[glue] ${payload.body}`;
  if (disposition.mode !== "terminal") {
    interAgent.notePendingInjection(envelope);
  }
  void host.send(text, undefined, payload.conversation_id).catch(() => {});
}

describe("issue #177 review M4: adapter-level lifecycle glue (codex)", () => {
  it("AC9: stale/duplicate turn は host.send() を一切呼ばない", async () => {
    const host = makeHost();
    const sendSpy = vi.spyOn(host, "send");
    const tool = new InterAgentTool({
      config,
      getState: () => "tool_running",
      send: () => {},
    });

    await runOnInterAgentMessageGlue(tool, host, inboundEnvelope("cnv-stale", 2));
    expect(sendSpy).toHaveBeenCalledTimes(1);
    sendSpy.mockClear();

    // 重複 (直前と同じ turn_number) — SDK 入力に一切触れない。
    await runOnInterAgentMessageGlue(tool, host, inboundEnvelope("cnv-stale", 2));
    expect(sendSpy).not.toHaveBeenCalled();

    // 遅延到着 (既知の最大値より低い) も同様。
    await runOnInterAgentMessageGlue(tool, host, inboundEnvelope("cnv-stale", 1));
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("AC8: terminal な inbound は host.send() は呼ぶが notePendingInjection は呼ばない", async () => {
    const host = makeHost();
    const sendSpy = vi.spyOn(host, "send");
    const tool = new InterAgentTool({
      config,
      getState: () => "tool_running",
      send: () => {},
    });

    const closing = await tool.invoke({
      to: "peer.agent",
      body: "bye",
      kind: "done",
      conversation_id: "cnv-terminal",
      done: true,
    });
    expect(closing.isError).toBeFalsy();

    await runOnInterAgentMessageGlue(
      tool,
      host,
      inboundEnvelope("cnv-terminal", 2, true),
    );

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(
      tool.resolveTurnEnd("cnv-terminal", { code: "api_error", message: "x" }),
    ).toEqual([]);
  });

  it("対照: reply-owed な inbound は host.send() も notePendingInjection も両方走る", async () => {
    const host = makeHost();
    const sendSpy = vi.spyOn(host, "send");
    const tool = new InterAgentTool({
      config,
      getState: () => "tool_running",
      send: () => {},
    });

    await runOnInterAgentMessageGlue(tool, host, inboundEnvelope("cnv-normal", 1));

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(
      tool.resolveTurnEnd("cnv-normal", { code: "api_error", message: "x" }),
    ).toHaveLength(1);
  });
});
