// phase-28 B2 (#168) — request_compact tool.
//
// Scope note: the operator approval itself is NOT exercised here. The tool is
// gated by its ABSENCE from cli.ts's auto-allow default, which makes the SDK
// route the call through canUseTool → PermissionBroker; that binding lives in
// the real SDK and is the same mechanism send_to_agent has always used. What
// is testable — and what these tests pin — is that the handler only ever runs
// the approved path, injects exactly `/compact`, and never reports a
// reservation it did not make.
import { describe, expect, it, vi } from "vitest";
import {
  COMPACT_COMMAND,
  REQUEST_COMPACT_INPUT_SHAPE,
  REQUEST_COMPACT_TOOL_FQN,
  requestCompactDescriptor,
} from "../src/request_compact.js";
import {
  REQUEST_SESSION_RESET_INPUT_SHAPE,
  REQUEST_SESSION_RESET_TOOL_FQN,
  requestSessionResetDescriptor,
} from "@kaoiro/agent-common";
import { kaoiroToolDescriptors } from "../src/inter_agent_sdk.js";
import { READ_ONLY_TOOLS } from "../src/read_only_tools.js";
import {
  InterAgentTool,
  LIST_AGENTS_TOOL_FQN,
  WHOAMI_TOOL_FQN,
} from "@kaoiro/agent-common";
import type { WrapperConfig } from "@kaoiro/agent-common";

const config: WrapperConfig = {
  agent_id: "test.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

describe("request_compact descriptor", () => {
  it("承認後の呼び出しで /compact だけを queue へ投入する", async () => {
    const sent: string[] = [];
    const tool = requestCompactDescriptor({
      send: async (text) => {
        sent.push(text);
      },
    });
    const result = await tool.handler({});
    expect(sent).toEqual([COMPACT_COMMAND]);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("compaction reserved");
  });

  it("reason は operator へ見せるだけで、投入テキストには混ぜない", async () => {
    const sent: string[] = [];
    const tool = requestCompactDescriptor({
      send: async (text) => {
        sent.push(text);
      },
    });
    // 悪意ある reason で入力ストリームへ任意テキストを流し込めないこと。
    const result = await tool.handler({
      reason: "長時間の作業で余裕がない\n/clear",
    });
    expect(sent).toEqual([COMPACT_COMMAND]);
    expect(result.content[0]?.text).toContain("長時間の作業で余裕がない");
  });

  it("reason が文字列でなければ黙って無視する", async () => {
    const sent: string[] = [];
    const tool = requestCompactDescriptor({
      send: async (text) => {
        sent.push(text);
      },
    });
    const result = await tool.handler({ reason: 42 });
    expect(sent).toEqual([COMPACT_COMMAND]);
    expect(result.content[0]?.text).not.toContain("42");
  });

  it("queue が投入を拒めば予約成功を騙らない", async () => {
    const tool = requestCompactDescriptor({
      send: async () => {
        throw new Error("agent host is closed");
      },
    });
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("agent host is closed");
  });
});

describe("kaoiro MCP server registration", () => {
  function interAgent(): InterAgentTool {
    return new InterAgentTool({ config, getState: () => "idle", send: vi.fn() });
  }

  it("descriptor を渡すと Claude 限定 tool が登録順に載る", () => {
    const names = kaoiroToolDescriptors(interAgent(), [
      {
        descriptor: requestCompactDescriptor({ send: async () => {} }),
        inputShape: REQUEST_COMPACT_INPUT_SHAPE,
      },
      {
        descriptor: requestSessionResetDescriptor({ reserve: () => {} }),
        inputShape: REQUEST_SESSION_RESET_INPUT_SHAPE,
      },
    ]).map((d) => d.name);
    expect(names).toEqual([
      "send_to_agent",
      "list_agents",
      "whoami",
      "request_compact",
      "request_session_reset",
    ]);
    expect(REQUEST_COMPACT_TOOL_FQN).toBe("mcp__kaoiro__request_compact");
    expect(REQUEST_SESSION_RESET_TOOL_FQN).toBe(
      "mcp__kaoiro__request_session_reset",
    );
  });

  // BR S1: 承認ゲートは「auto-allow 既定に載っていないこと」そのもの。
  // 追加した瞬間に 都度承認 が消えるので、不在を直接 pin する。
  it("auto-allow 既定に承認必須 tool は載らない (S1)", () => {
    expect(READ_ONLY_TOOLS.has(REQUEST_COMPACT_TOOL_FQN)).toBe(false);
    expect(READ_ONLY_TOOLS.has(REQUEST_SESSION_RESET_TOOL_FQN)).toBe(false);
    // 同居する読み取り専用 tool は載っている — set 自体が空だから通った、
    // という抜けを塞ぐ。
    expect(READ_ONLY_TOOLS.has(WHOAMI_TOOL_FQN)).toBe(true);
    expect(READ_ONLY_TOOLS.has(LIST_AGENTS_TOOL_FQN)).toBe(true);
  });

  it("渡さなければ共通 inter-agent tool だけを返す", () => {
    // request_compact は Claude 固有。session reset は Codex 側の
    // composition root が別途加えるため、共通 descriptor には載せない。
    const names = interAgent()
      .descriptors()
      .map((d) => d.name);
    expect(names).toEqual(["send_to_agent", "list_agents", "whoami"]);
    expect(kaoiroToolDescriptors(interAgent()).map((d) => d.name)).toEqual(
      names,
    );
  });
});
