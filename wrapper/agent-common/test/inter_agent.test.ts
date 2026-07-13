import { describe, expect, it } from "vitest";
import {
  INTER_AGENT_TOOL_FQN,
  InterAgentTool,
  LIST_AGENTS_TOOL_FQN,
  WHOAMI_TOOL_FQN,
  formatInboundMessage,
  type WhoamiSnapshot,
} from "../src/inter_agent.js";
import type { DirectoryEntry } from "@kaoiro/wrapper-core";
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
    server_url: "ws://localhost:4000/wrapper",
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
  it("基本フォーマットに role directive + from/kind/body/meta を含める", () => {
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
    // Role directive must lead so the receiving model treats this as an
    // inter-agent reply and goes straight to send_to_agent (Phase 1 spec)
    // instead of asking the operator "should I respond with X?" first.
    expect(text).toMatch(
      /^\[Inter-agent message — to reply, call send_to_agent with conversation_id="cnv-9"\.\]/,
    );
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

describe("list_agents / whoami companion tools", () => {
  it("companion tool FQN を公開する", () => {
    expect(LIST_AGENTS_TOOL_FQN).toBe("mcp__kaoiro__list_agents");
    expect(WHOAMI_TOOL_FQN).toBe("mcp__kaoiro__whoami");
  });

  it("list_agents は requestDirectory の結果を JSON として返す", async () => {
    const directory: DirectoryEntry[] = [
      {
        agent_id: "lab.peer-1",
        persona: { id: "ao", name: "あお", sprite_set: "ao" },
        state: "idle",
        engine: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
      },
      {
        agent_id: "lab.peer-2",
        persona: { id: "kuroe", name: "クロエ", sprite_set: "kuroe" },
        state: "thinking",
      },
    ];
    const tool = new InterAgentTool({
      config: configFor("self.agent"),
      getState: () => "tool_running",
      send: () => {},
      requestDirectory: async () => directory,
    });

    const result = await tool.listAgents();
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0]!.text) as { agents: DirectoryEntry[] };
    expect(parsed.agents).toEqual(directory);
  });

  it("list_agents は requestDirectory 未配線でエラー結果を返す", async () => {
    const tool = new InterAgentTool({
      config: configFor("self.agent"),
      getState: () => "tool_running",
      send: () => {},
    });
    const result = await tool.listAgents();
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("list_agents unavailable");
  });

  it("list_agents は requestDirectory の reject をエラー結果に変換する", async () => {
    const tool = new InterAgentTool({
      config: configFor("self.agent"),
      getState: () => "tool_running",
      send: () => {},
      requestDirectory: async () => {
        throw new Error("boom");
      },
    });
    const result = await tool.listAgents();
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("list_agents failed");
    expect(result.content[0]!.text).toContain("boom");
  });

  it("whoami は getWhoami の snapshot を JSON として返す", () => {
    const snapshot: WhoamiSnapshot = {
      agent_id: "self.agent",
      persona: { id: "mio", name: "澪", sprite_set: "mio" },
      state: "thinking",
      model: "claude-sonnet-4-6",
      cwd: "/home/user",
      permission_mode: "default",
    };
    const tool = new InterAgentTool({
      config: configFor("self.agent"),
      getState: () => "thinking",
      send: () => {},
      getWhoami: () => snapshot,
    });
    const result = tool.whoami();
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text)).toEqual(snapshot);
  });

  it("whoami は getWhoami 未配線で wrapper config からのフォールバックを返す", () => {
    const tool = new InterAgentTool({
      config: configFor("self.agent"),
      getState: () => "idle",
      send: () => {},
    });
    const result = tool.whoami();
    const parsed = JSON.parse(result.content[0]!.text) as WhoamiSnapshot;
    expect(parsed.agent_id).toBe("self.agent");
    expect(parsed.persona).toEqual(PERSONA);
    expect(parsed.state).toBe("idle");
    // SDK 由来のフィールドは存在しないので omit される
    expect(parsed.model).toBeUndefined();
  });
});

describe("descriptors (共通 Tool 記述層, ADR-0032 F5)", () => {
  it("send_to_agent handler は不正入力を isError で弾き invoke へ到達させない", async () => {
    const { tool, capture } = makeTool("self.agent");
    const send = tool.descriptors().find((d) => d.name === "send_to_agent")!;
    const bad = await send.handler({ to: "peer", body: "" });
    expect(bad.isError).toBe(true);
    expect(capture.envelopes).toHaveLength(0);
  });

  it("send_to_agent handler は有効入力で envelope を送出する", async () => {
    const { tool, capture } = makeTool("self.agent");
    const send = tool.descriptors().find((d) => d.name === "send_to_agent")!;
    const ok = await send.handler({
      to: "peer.agent",
      body: "hello",
      kind: "inform",
    });
    expect(ok.isError).toBeFalsy();
    expect(capture.envelopes).toHaveLength(1);
  });

  it("3 tool の inputSchema が JSON Schema object で揃う", () => {
    const { tool } = makeTool("self.agent");
    const descriptors = tool.descriptors();
    expect(descriptors.map((d) => d.name).sort()).toEqual([
      "list_agents",
      "send_to_agent",
      "whoami",
    ]);
    for (const d of descriptors) {
      expect((d.inputSchema as { type?: string }).type).toBe("object");
    }
    expect(
      descriptors.find((d) => d.name === "list_agents")?.description,
    ).toContain("engine/model/effort when reported");
  });
});
