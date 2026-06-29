import { describe, expect, it } from "vitest";
import {
  INTER_AGENT_TOOL_FQN,
  InterAgentTool,
  formatInboundMessage,
} from "../src/inter_agent.js";
import type {
  Envelope,
  InterAgentMessagePayload,
  WrapperConfig,
} from "../src/types.js";

const PERSONA = { id: "mio", name: "澪", sprite_set: "mio" };

function configFor(agentId: string): WrapperConfig {
  return {
    agent_id: agentId,
    persona: PERSONA,
  };
}

interface Capture {
  envelopes: Envelope[];
  ids: string[];
  state: () => "tool_running";
  newId: () => string;
}

function makeTool(agentId: string): { tool: InterAgentTool; capture: Capture } {
  const capture: Capture = {
    envelopes: [],
    ids: [],
    state: () => "tool_running",
    newId: () => {
      const id = `cnv-${capture.envelopes.length}`;
      capture.ids.push(id);
      return id;
    },
  };
  const tool = new InterAgentTool({
    config: configFor(agentId),
    getState: capture.state,
    send: (env) => capture.envelopes.push(env),
    now: () => "2026-06-29T12:34:56Z",
    newId: capture.newId,
  });
  return { tool, capture };
}

// Direct dispatch via the public invoke() entry point — the same handler the
// SDK MCP wiring runs once the operator approves the call. Going through
// invoke instead of the SDK transport keeps the test deterministic and
// independent of MCP plumbing.
async function callTool(
  tool: InterAgentTool,
  args: Parameters<InterAgentTool["invoke"]>[0],
): Promise<{ result: Awaited<ReturnType<InterAgentTool["invoke"]>> }> {
  return { result: await tool.invoke(args) };
}

describe("InterAgentTool", () => {
  it("exposes the SDK-side tool name as mcp__kaoiro__send_to_agent", () => {
    expect(INTER_AGENT_TOOL_FQN).toBe("mcp__kaoiro__send_to_agent");
  });

  it("conversation_id 未指定で新規 UUID を割当て、turn_number=1 を採番する", async () => {
    const { tool, capture } = makeTool("agent-a");
    const { result } = await callTool(tool, {
      to: "agent-b",
      body: "やあ",
      kind: "inform",
    });
    expect(result.isError).toBeFalsy();
    expect(capture.envelopes).toHaveLength(1);
    const env = capture.envelopes[0]!;
    expect(env.type).toBe("inter_agent_message");
    expect(env.agent_id).toBe("agent-a");
    expect(env.state).toBe("tool_running");
    const payload = env.payload as unknown as InterAgentMessagePayload;
    expect(payload.to).toBe("agent-b");
    expect(payload.turn_number).toBe(1);
    expect(payload.conversation_id).toBe(capture.ids[0]);
    expect(payload.owner).toEqual({ kind: "user", id: "operator" });
    expect(result.content[0]?.text).toContain(payload.conversation_id);
  });

  it("同じ conversation_id を再利用すると turn_number が単調増加する", async () => {
    const { tool, capture } = makeTool("agent-a");
    await callTool(tool, {
      to: "agent-b",
      body: "Q",
      kind: "query",
      conversation_id: "cnv-shared",
    });
    await callTool(tool, {
      to: "agent-b",
      body: "Q2",
      kind: "query",
      conversation_id: "cnv-shared",
    });
    expect(
      (capture.envelopes[0]!.payload as unknown as InterAgentMessagePayload).turn_number,
    ).toBe(1);
    expect(
      (capture.envelopes[1]!.payload as unknown as InterAgentMessagePayload).turn_number,
    ).toBe(2);
  });

  it("observeInbound で記録された turn_number 以降にローカル送信が並ぶ", async () => {
    const { tool, capture } = makeTool("agent-a");
    tool.observeInbound("cnv-x", 7); // ピアから 7 ターンまで受信済
    await callTool(tool, {
      to: "agent-b",
      body: "返信",
      kind: "response",
      conversation_id: "cnv-x",
    });
    expect(
      (capture.envelopes[0]!.payload as unknown as InterAgentMessagePayload).turn_number,
    ).toBe(8);
  });

  it("自分自身を to に指定するとエラー結果を返し envelope を出さない", async () => {
    const { tool, capture } = makeTool("agent-a");
    const { result } = await callTool(tool, {
      to: "agent-a",
      body: "x",
      kind: "inform",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("cannot send to self");
    expect(capture.envelopes).toHaveLength(0);
  });

  it("kind=reject で reject_reason 欠落はエラーを返す", async () => {
    const { tool, capture } = makeTool("agent-a");
    const { result } = await callTool(tool, {
      to: "agent-b",
      body: "ng",
      kind: "reject",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("reject_reason");
    expect(capture.envelopes).toHaveLength(0);
  });

  it("optional フィールド(confidence/reject_reason/propose_next)を payload.meta に反映する", async () => {
    const { tool, capture } = makeTool("agent-a");
    await callTool(tool, {
      to: "agent-b",
      body: "対案",
      kind: "reject",
      reject_reason: "ベンチ未収束",
      confidence: 0.4,
      propose_next: "別案を検討",
      done: true,
    });
    const meta = (capture.envelopes[0]!.payload as unknown as InterAgentMessagePayload)
      .meta;
    expect(meta.confidence).toBe(0.4);
    expect(meta.reject_reason).toBe("ベンチ未収束");
    expect(meta.propose_next).toBe("別案を検討");
    expect(meta.done).toBe(true);
  });
});

describe("formatInboundMessage", () => {
  it("基本フォーマットに from/kind/body/meta を含める", () => {
    const env: Envelope = {
      version: "0",
      agent_id: "agent-a",
      persona: PERSONA,
      ts: "2026-06-29T12:00:00Z",
      type: "inter_agent_message",
      state: "tool_running",
      payload: {
        to: "agent-b",
        conversation_id: "cnv-9",
        turn_number: 3,
        kind: "propose",
        body: "CSV にしよう",
        meta: { done: false, propose_next: "B の同意" },
        owner: { kind: "user", id: "operator" },
      },
      ext: {},
    };
    const text = formatInboundMessage(env);
    expect(text).toContain("[from agent-a] propose: CSV にしよう");
    expect(text).toContain("conversation_id=cnv-9");
    expect(text).toContain("turn_number=3");
    expect(text).toContain("done=false");
    expect(text).toContain("propose_next=B の同意");
  });

  it("payload 欠損(server 合成 escalate skeleton)でも空値で頑健に整形する", () => {
    const env: Envelope = {
      version: "0",
      agent_id: "server",
      persona: PERSONA,
      ts: "2026-06-29T12:00:00Z",
      type: "inter_agent_message",
      state: "idle",
      payload: {
        to: "agent-a",
        conversation_id: "cnv-0",
        turn_number: 0,
        kind: "escalate-to-user",
        body: "conversation auto-terminated: max_turns",
        meta: { done: true, propose_next: "" },
        owner: { kind: "user", id: "system" },
      },
      ext: {},
    };
    const text = formatInboundMessage(env);
    expect(text).toContain("[from server] escalate-to-user");
    expect(text).toContain("done=true");
  });
});
