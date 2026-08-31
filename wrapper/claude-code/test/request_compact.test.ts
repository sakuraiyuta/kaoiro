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
  RESUME_PROMPT_MAX_BYTES,
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
    const reserved: (string | null)[] = [];
    const tool = requestCompactDescriptor({
      send: async (text) => {
        sent.push(text);
      },
      reserveResume: (prompt) => reserved.push(prompt),
    });
    const result = await tool.handler({});
    expect(sent).toEqual([COMPACT_COMMAND]);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("compaction reserved");
    // FIFO 1:1: every queued /compact gets a slot even when no
    // resume_prompt was given.
    expect(reserved).toEqual([null]);
  });

  it("reason は operator へ見せるだけで、投入テキストには混ぜない", async () => {
    const sent: string[] = [];
    const tool = requestCompactDescriptor({
      send: async (text) => {
        sent.push(text);
      },
      reserveResume: () => {},
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
      reserveResume: () => {},
    });
    const result = await tool.handler({ reason: 42 });
    expect(sent).toEqual([COMPACT_COMMAND]);
    expect(result.content[0]?.text).not.toContain("42");
  });

  it("queue が投入を拒めば予約成功を騙らない", async () => {
    const reserved: (string | null)[] = [];
    const tool = requestCompactDescriptor({
      send: async () => {
        throw new Error("agent host is closed");
      },
      reserveResume: (prompt) => reserved.push(prompt),
    });
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("agent host is closed");
    expect(reserved).toEqual([]);
  });

  // ADR-0055 phase-33 Stage A: resume_prompt が省略された既存の呼び出し
  // パターンは何も変わらない (opt-in の回帰テスト)。
  describe("resume_prompt (issue #200 Stage A)", () => {
    it("省略時は reserveResume を null で呼ぶ (FIFO 1:1)", async () => {
      const reserved: (string | null)[] = [];
      const tool = requestCompactDescriptor({
        send: async () => {},
        reserveResume: (prompt) => reserved.push(prompt),
      });
      const result = await tool.handler({});
      expect(reserved).toEqual([null]);
      expect(result.content[0]?.text).not.toContain("resume note");
    });

    it("承認後、send 成功後に resume_prompt を逐語で reserveResume へ渡す", async () => {
      const sent: string[] = [];
      const reserved: (string | null)[] = [];
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

    // Verbatim contract: only a pure-blank value collapses to null.
    // Anything else — leading/trailing whitespace and newlines included —
    // must reach reserveResume byte-for-byte, since it is redelivered
    // verbatim as the agent's own next turn (host.ts resumeInjectionText).
    it("前後の空白・改行を含む値は trim せず逐語で reserveResume へ渡す (verbatim contract)", async () => {
      const reserved: (string | null)[] = [];
      const tool = requestCompactDescriptor({
        send: async () => {},
        reserveResume: (prompt) => reserved.push(prompt),
      });
      const raw = "  続きはここから  \n";
      await tool.handler({ resume_prompt: raw });
      expect(reserved).toEqual([raw]);
    });

    it("空文字列/空白のみは reserveResume を null で呼ぶ (FIFO 1:1)", async () => {
      const reserved: (string | null)[] = [];
      const tool = requestCompactDescriptor({
        send: async () => {},
        reserveResume: (prompt) => reserved.push(prompt),
      });
      const result = await tool.handler({ resume_prompt: "   " });
      expect(reserved).toEqual([null]);
      expect(result.content[0]?.text).not.toContain("resume note");
    });

    it("resume_prompt が文字列でなければ黙って無視し reserveResume を null で呼ぶ", async () => {
      const reserved: (string | null)[] = [];
      const tool = requestCompactDescriptor({
        send: async () => {},
        reserveResume: (prompt) => reserved.push(prompt),
      });
      const result = await tool.handler({ resume_prompt: 42 });
      expect(reserved).toEqual([null]);
      expect(result.content[0]?.text).not.toContain("42");
    });

    // send() が失敗する = compaction 自体が queue されていない。この
    // resume_prompt を後から届いた別の compact_boundary で誤発火させない
    // ため、send 失敗時は reserveResume を呼んではいけない — FIFO 1:1 は
    // 「実際に queue された /compact」とだけ対応するので、失敗した呼び出し
    // はそもそも FIFO へエントリを持たない。
    it("send が失敗したら reserveResume を呼ばない", async () => {
      const reserved: (string | null)[] = [];
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

  // 8,192 UTF-8 byte raw cap on resume_prompt, PLUS the full serialized
  // input fitting PermissionBroker's own 16,384 byte approval-payload
  // ceiling (agent-common/src/permission.ts) — two independent limits,
  // both checked before /compact is queued so an oversized call fails the
  // whole request rather than reserving a note the operator's approval
  // dialog cannot show in full (director decision, issue #200).
  describe("resume_prompt byte cap", () => {
    it(`ちょうど ${RESUME_PROMPT_MAX_BYTES} bytes は通す`, async () => {
      const sent: string[] = [];
      const reserved: (string | null)[] = [];
      const atCap = "a".repeat(RESUME_PROMPT_MAX_BYTES);
      const tool = requestCompactDescriptor({
        send: async (text) => {
          sent.push(text);
        },
        reserveResume: (prompt) => reserved.push(prompt),
      });
      const result = await tool.handler({ resume_prompt: atCap });
      expect(result.isError).toBeUndefined();
      expect(sent).toEqual([COMPACT_COMMAND]);
      expect(reserved).toEqual([atCap]);
    });

    it(`${RESUME_PROMPT_MAX_BYTES} bytes を 1 byte 超えたら queue 前に全体 fail する`, async () => {
      const sent: string[] = [];
      const reserved: (string | null)[] = [];
      const overCap = "a".repeat(RESUME_PROMPT_MAX_BYTES + 1);
      const tool = requestCompactDescriptor({
        send: async (text) => {
          sent.push(text);
        },
        reserveResume: (prompt) => reserved.push(prompt),
      });
      const result = await tool.handler({ resume_prompt: overCap });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("byte cap");
      // 全体 fail: /compact 自体も queue されない (truncate ではなく fail)。
      expect(sent).toEqual([]);
      expect(reserved).toEqual([]);
    });

    // 文字数ではなく UTF-8 byte 数で判定すること — "あ" は 3 bytes/char
    // なので、文字数は cap よりずっと少なくても byte 数は超え得る。
    it("マルチバイト文字は文字数でなく byte 数で cap 判定する", async () => {
      const reserved: (string | null)[] = [];
      const tool = requestCompactDescriptor({
        send: async () => {},
        reserveResume: (prompt) => reserved.push(prompt),
      });
      const overCapMultiByte = "あ".repeat(2731); // 2731 * 3 = 8193 bytes
      expect(Buffer.byteLength(overCapMultiByte, "utf8")).toBe(8193);
      const result = await tool.handler({ resume_prompt: overCapMultiByte });
      expect(result.isError).toBe(true);
      expect(reserved).toEqual([]);

      const atCapMultiByte = "あ".repeat(2730) + "bb"; // 2730*3 + 2 = 8192
      expect(Buffer.byteLength(atCapMultiByte, "utf8")).toBe(
        RESUME_PROMPT_MAX_BYTES,
      );
      const result2 = await tool.handler({ resume_prompt: atCapMultiByte });
      expect(result2.isError).toBeUndefined();
      expect(reserved).toEqual([atCapMultiByte]);
    });

    // The raw cap applies to the RAW value, before the blank/whitespace
    // collapse — a whitespace-only value that is itself oversized must
    // not slip through as "empty" just because it collapses to null.
    it("空白のみでも raw byte 数が cap 超なら fail する (blank collapse の前に適用)", async () => {
      const sent: string[] = [];
      const reserved: (string | null)[] = [];
      const overCapWhitespace = " ".repeat(RESUME_PROMPT_MAX_BYTES + 1);
      const tool = requestCompactDescriptor({
        send: async (text) => {
          sent.push(text);
        },
        reserveResume: (prompt) => reserved.push(prompt),
      });
      const result = await tool.handler({
        resume_prompt: overCapWhitespace,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("byte cap");
      expect(sent).toEqual([]);
      expect(reserved).toEqual([]);
    });

    // A raw value under RESUME_PROMPT_MAX_BYTES can still push the FULL
    // serialized input over PermissionBroker's own ceiling: JSON escaping
    // (backslashes here) roughly doubles the content's size, independent
    // of the raw-byte check above.
    it("raw cap 内でも JSON escape で serialized ceiling を超えたら fail する", async () => {
      const sent: string[] = [];
      const reserved: (string | null)[] = [];
      const heavyEscape = "\\".repeat(RESUME_PROMPT_MAX_BYTES);
      expect(Buffer.byteLength(heavyEscape, "utf8")).toBe(
        RESUME_PROMPT_MAX_BYTES,
      );
      const tool = requestCompactDescriptor({
        send: async (text) => {
          sent.push(text);
        },
        reserveResume: (prompt) => reserved.push(prompt),
      });
      const result = await tool.handler({ resume_prompt: heavyEscape });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("approval-payload ceiling");
      expect(sent).toEqual([]);
      expect(reserved).toEqual([]);
    });

    // resume_prompt alone can be well within its own cap while `reason`
    // (sharing the SAME serialized input the broker measures) pushes the
    // total over — the resume_prompt-only raw check cannot catch this.
    it("resume_prompt は cap 内でも 長い reason で serialized ceiling を超えたら fail する", async () => {
      const sent: string[] = [];
      const reserved: (string | null)[] = [];
      const tool = requestCompactDescriptor({
        send: async (text) => {
          sent.push(text);
        },
        reserveResume: (prompt) => reserved.push(prompt),
      });
      const result = await tool.handler({
        reason: "r".repeat(20_000),
        resume_prompt: "ok",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("approval-payload ceiling");
      expect(sent).toEqual([]);
      expect(reserved).toEqual([]);
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
        descriptor: requestCompactDescriptor({
          send: async () => {},
          reserveResume: () => {},
        }),
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
