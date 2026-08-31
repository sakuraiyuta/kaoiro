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
} from "../src/request_session_reset.js";
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

  // ADR-0055 phase-33 Stage A: resume_prompt が省略された既存の呼び出し
  // パターンは何も変わらない (opt-in の回帰テスト)。
  describe("resume_prompt (issue #200 Stage A)", () => {
    it("省略時は reserveResume を一切呼ばず、tool result にも何も足さない", async () => {
      const reserved: string[] = [];
      const tool = requestCompactDescriptor({
        send: async () => {},
        reserveResume: (prompt) => reserved.push(prompt),
      });
      const result = await tool.handler({});
      expect(reserved).toEqual([]);
      expect(result.content[0]?.text).not.toContain("resume note");
    });

    it("reserveResume を渡さなくても動作する (テスト/embedder 向けの省略可)", async () => {
      const tool = requestCompactDescriptor({ send: async () => {} });
      const result = await tool.handler({ resume_prompt: "続きはここから" });
      expect(result.isError).toBeUndefined();
    });

    it("承認後、send 成功後に resume_prompt を逐語で reserveResume へ渡す", async () => {
      const sent: string[] = [];
      const reserved: string[] = [];
      const tool = requestCompactDescriptor({
        send: async (text) => {
          sent.push(text);
        },
        reserveResume: (prompt) => reserved.push(prompt),
      });
      const result = await tool.handler({
        resume_prompt: "issue #200 Stage A の実装中。次は cli.ts の配線。",
      });
      expect(sent).toEqual([COMPACT_COMMAND]);
      expect(reserved).toEqual([
        "issue #200 Stage A の実装中。次は cli.ts の配線。",
      ]);
      expect(result.content[0]?.text).toContain("resume note is reserved");
    });

    it("前後の空白は trim してから reserveResume へ渡す", async () => {
      const reserved: string[] = [];
      const tool = requestCompactDescriptor({
        send: async () => {},
        reserveResume: (prompt) => reserved.push(prompt),
      });
      await tool.handler({ resume_prompt: "  続きはここから  \n" });
      expect(reserved).toEqual(["続きはここから"]);
    });

    it("空文字列/空白のみは reserveResume を呼ばない", async () => {
      const reserved: string[] = [];
      const tool = requestCompactDescriptor({
        send: async () => {},
        reserveResume: (prompt) => reserved.push(prompt),
      });
      const result = await tool.handler({ resume_prompt: "   " });
      expect(reserved).toEqual([]);
      expect(result.content[0]?.text).not.toContain("resume note");
    });

    it("resume_prompt が文字列でなければ黙って無視する", async () => {
      const reserved: string[] = [];
      const tool = requestCompactDescriptor({
        send: async () => {},
        reserveResume: (prompt) => reserved.push(prompt),
      });
      const result = await tool.handler({ resume_prompt: 42 });
      expect(reserved).toEqual([]);
      expect(result.content[0]?.text).not.toContain("42");
    });

    // send() が失敗する = compaction 自体が queue されていない。この
    // resume_prompt を後から届いた別の compact_boundary で誤発火させない
    // ため、send 失敗時は reserveResume を呼んではいけない。
    it("send が失敗したら reserveResume を呼ばない", async () => {
      const reserved: string[] = [];
      const tool = requestCompactDescriptor({
        send: async () => {
          throw new Error("agent host is closed");
        },
        reserveResume: (prompt) => reserved.push(prompt),
      });
      const result = await tool.handler({
        resume_prompt: "この予約は成立してはいけない",
      });
      expect(reserved).toEqual([]);
      expect(result.isError).toBe(true);
    });
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

  it("渡さなければ従来の 3 tool のまま (codex 側は出さない前提)", () => {
    // codex は InterAgentTool#descriptors() を直接使うため、request_compact
    // がそこに載っていないこと自体が「codex に出さない」の担保になる。
    const names = interAgent()
      .descriptors()
      .map((d) => d.name);
    expect(names).toEqual(["send_to_agent", "list_agents", "whoami"]);
    expect(kaoiroToolDescriptors(interAgent()).map((d) => d.name)).toEqual(
      names,
    );
  });
});
