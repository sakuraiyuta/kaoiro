// Adapter-level integration coverage for issue #177 review M4 (AC8/AC9/
// AC15): proves the glue sequence cli.ts's onInterAgentMessage handler
// runs (receiveInbound() -> disposition branch -> conditional host.send()
// / notePendingInjection()) against the REAL AgentHost + REAL
// InterAgentTool, not just InterAgentTool in isolation (which
// inter_agent.test.ts already covers exhaustively). Mirrors the harness
// style of inter_agent_injection_failure.test.ts (issue #136) — cli.ts
// itself has no test harness (its onInterAgentMessage handler lives
// inline in run(), like every other ServerLink callback in that file), so
// this reproduces the exact glue sequence directly against the two real
// classes instead of constructing cli.ts.
//
// A full 2-agent E2E (two live wrapper processes exchanging real network
// traffic through a real server) would need new test infrastructure this
// repo does not have; this adapter-level harness proves the same
// disposition-driven branching AC13 depends on (stale dropped before
// send, terminal skips notePendingInjection) without it. The 2-agent
// round-trip *count* claim in AC13 is covered separately at the
// engine-agnostic level in agent-common (two InterAgentTool instances
// relaying to each other in-process, no host/adapter involved).
import { describe, expect, it, vi } from "vitest";
import { InterAgentTool } from "@kaoiro/agent-common";
import type { Envelope, InterAgentMessagePayload, WrapperConfig } from "@kaoiro/agent-common";
import { AgentHost } from "../src/host.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
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

/** Reproduces cli.ts's onInterAgentMessage glue exactly — both engine
 *  adapters share this sequence (claude-code/src/cli.ts,
 *  codex/src/cli.ts): consumed waiters return early, a stale/duplicate
 *  turn is dropped before formatting or host.send() (AC9), and a
 *  terminal-mode inbound is still sent (informational) but never tracked
 *  via notePendingInjection (AC8). Async since issue #177 review round 2
 *  (ふじ差し戻し) made receiveInbound() async (it may gate briefly on a
 *  concurrently in-flight done=true send for the same conversation_id). */
async function runOnInterAgentMessageGlue(
  interAgent: InterAgentTool,
  host: AgentHost,
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

describe("issue #177 review M4: adapter-level lifecycle glue (claude-code)", () => {
  it("AC9: stale/duplicate turn は host.send() を一切呼ばない", async () => {
    const host = new AgentHost(config, { onState: () => {} });
    const sendSpy = vi.spyOn(host, "send");
    const tool = new InterAgentTool({
      config,
      getState: () => host.state,
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
    const host = new AgentHost(config, { onState: () => {} });
    const sendSpy = vi.spyOn(host, "send");
    const tool = new InterAgentTool({
      config,
      getState: () => host.state,
      send: () => {},
    });

    // 自分側が先に done=true を送信 (fire-and-forget accepted 前提)。
    const closing = await tool.invoke({
      to: "peer.agent",
      body: "bye",
      kind: "done",
      conversation_id: "cnv-terminal",
      done: true,
    });
    expect(closing.isError).toBeFalsy();

    // peer 側も done=true → 両側揃って terminal。
    await runOnInterAgentMessageGlue(
      tool,
      host,
      inboundEnvelope("cnv-terminal", 2, true),
    );

    expect(sendSpy).toHaveBeenCalledTimes(1);

    // notePendingInjection が呼ばれていなければ resolveTurnEnd は即座に
    // 空配列を返す — 何も pending になっていない証拠(呼ばれていれば
    // エラー通知が 1 件返るはず)。
    expect(
      tool.resolveTurnEnd("cnv-terminal", { code: "api_error", message: "x" }),
    ).toEqual([]);
  });

  it("対照: reply-owed な inbound は host.send() も notePendingInjection も両方走る", async () => {
    const host = new AgentHost(config, { onState: () => {} });
    const sendSpy = vi.spyOn(host, "send");
    const tool = new InterAgentTool({
      config,
      getState: () => host.state,
      send: () => {},
    });

    await runOnInterAgentMessageGlue(tool, host, inboundEnvelope("cnv-normal", 1));

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(
      tool.resolveTurnEnd("cnv-normal", { code: "api_error", message: "x" }),
    ).toHaveLength(1);
  });
});
