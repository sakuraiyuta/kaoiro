import { describe, expect, it } from "vitest";
import { reconstructHistory, readSessionHistory, sessionSidecarPath
} from "../src/history.js";
import { isFormattedInterAgentMessage } from "@kaoiro/agent-common";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { InterAgentTurnCoordinator } from "../src/inter_agent_turn_coordinator.js";

const config: WrapperConfig = {
  agent_id: "test.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

const now = (): string => "2026-06-25T00:00:00.000Z";

/** Serializes one JSONL line from a partial shape. */
const line = (shape: Record<string, unknown>): string => JSON.stringify(shape);

function reconstruct(lines: string[]): Envelope[] {
  return reconstructHistory(lines.join("\n"), config, "sess-1", now);
}

function generatedStatusBatch(): string {
  const batches: Array<{ turnToken: string; peer: string; items: readonly unknown[]; conversationIds: readonly string[]; text: string }> = [];
  let sequence = 0;
  const coordinator = new InterAgentTurnCoordinator({
    createTurnToken: () => `history-${++sequence}`,
    onDispatch: batch => batches.push(batch),
  });
  const status = (deliverySeq: number, conversationId: string): Envelope => ({
    version: "0", agent_id: "server", persona: config.persona, display_name: "Kaoiro server",
    ts: "2026-09-30T00:00:00Z", type: "inter_agent_message", state: "idle",
    payload: { to: config.agent_id, conversation_id: conversationId, turn_number: 0, kind: "inform", body: "peer reconnected" },
    delivery_seq: deliverySeq,
  } as unknown as Envelope);
  coordinator.receive(status(0, "status-blocker"), "reply-owed");
  coordinator.receive(status(1, "status-first"), "reply-owed");
  coordinator.receive(status(2, "status-second"), "reply-owed");
  expect(batches).toHaveLength(1);
  coordinator.settle(batches[0]!.turnToken);
  coordinator.dispatchNextForPeer("server");
  expect(batches).toHaveLength(2);
  expect(batches[1]!.items).toHaveLength(2);
  return batches[1]!.text;
}

describe("reconstructHistory — JSONL transcript -> log envelopes", () => {
  it("skips a real two-notice server batch while retaining ordinary user text", () => {
    const batch = generatedStatusBatch();
    expect(batch.startsWith('[Inter-agent message — to reply, call send_to_agent with conversation_id="status-first".]')).toBe(true);
    expect(isFormattedInterAgentMessage(batch)).toBe(true);
    expect(batch).not.toContain("reply to each conversation_id");
    const envelopes = reconstruct([
      line({ type: "user", message: { role: "user", content: batch } }),
      line({ type: "user", message: { role: "user", content: "ordinary operator input" } }),
    ]);
    expect(envelopes.map(envelope => envelope.payload)).toEqual([{ kind: "user", text: "ordinary operator input" }]);
  });

  it("maps user/assistant lines to ordered log envelopes, backfilling tool_name", () => {
    const envelopes = reconstruct([
      line({
        type: "user",
        timestamp: "2026-06-25T00:00:01.000Z",
        message: { role: "user", content: "src/a.ts を読んで" },
      }),
      line({
        type: "assistant",
        timestamp: "2026-06-25T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "…" },
            { type: "text", text: "読みます" },
            { type: "tool_use", id: "tu1", name: "Read", input: { file: "a" } },
          ],
        },
      }),
      line({
        type: "user",
        timestamp: "2026-06-25T00:00:03.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu1",
              content: [{ type: "text", text: "中身" }],
            },
          ],
        },
      }),
    ]);

    expect(envelopes.map((e) => e.payload)).toEqual([
      { kind: "user", text: "src/a.ts を読んで" },
      { kind: "assistant", text: "読みます" },
      { kind: "tool_use", tool_name: "Read", tool_use_id: "tu1", input: { file: "a" } },
      { kind: "tool_result", output: "中身", tool_use_id: "tu1", tool_name: "Read" },
    ]);
    // Each carries the agent identity, the resume session_id, and is a log.
    for (const e of envelopes) {
      expect(e.type).toBe("log");
      expect(e.agent_id).toBe("test.agent");
      expect(e.session_id).toBe("sess-1");
    }
    // ts comes from the JSONL line, not `now`.
    expect(envelopes[0]?.ts).toBe("2026-06-25T00:00:01.000Z");
  });

  it("skips bookkeeping, system, meta, and unparseable lines", () => {
    const envelopes = reconstruct([
      line({ type: "system", subtype: "init", message: { content: [] } }),
      line({ type: "attachment", attachment: {} }),
      line({ type: "last-prompt", lastPrompt: "x" }),
      line({ type: "mode", mode: "default" }),
      line({ type: "queue-operation", op: "x" }),
      line({
        type: "user",
        isMeta: true,
        message: { role: "user", content: "<system-reminder>" },
      }),
      "{ not json",
      line({
        type: "user",
        message: { role: "user", content: "本物の指示" },
      }),
    ]);

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.payload).toEqual({ kind: "user", text: "本物の指示" });
  });

  it("keeps both the instruction text and tool_result of a mixed user line", () => {
    const envelopes = reconstruct([
      line({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "これも見て" },
            {
              type: "tool_result",
              tool_use_id: "tuX",
              content: [{ type: "text", text: "出力" }],
            },
          ],
        },
      }),
    ]);
    expect(envelopes.map((e) => e.payload)).toEqual([
      { kind: "user", text: "これも見て" },
      { kind: "tool_result", output: "出力", tool_use_id: "tuX" },
    ]);
  });

  it("skips an injected IA user echo but preserves a mixed tool_result", () => {
    const envelopes = reconstruct([
      line({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text:
                '[Inter-agent message — to reply, call send_to_agent with conversation_id="cnv-1".]\n\n[from peer] inform: ping',
            },
            {
              type: "tool_result",
              tool_use_id: "tuIA",
              content: [{ type: "text", text: "kept" }],
            },
          ],
        },
      }),
      line({
        type: "user",
        message: { role: "user", content: "ordinary instruction" },
      }),
    ]);

    expect(envelopes.map((e) => e.payload)).toEqual([
      { kind: "tool_result", output: "kept", tool_use_id: "tuIA" },
      { kind: "user", text: "ordinary instruction" },
    ]);
  });

  it("drops empty/whitespace user instructions", () => {
    const envelopes = reconstruct([
      line({ type: "user", message: { role: "user", content: "   " } }),
      line({ type: "user", message: { role: "user", content: "" } }),
    ]);
    expect(envelopes).toHaveLength(0);
  });

  it("keeps only the newest 200 lines (server ring-buffer parity)", () => {
    const lines = Array.from({ length: 250 }, (_, i) =>
      line({ type: "user", message: { role: "user", content: `m${i}` } }),
    );
    const envelopes = reconstruct(lines);
    expect(envelopes).toHaveLength(200);
    expect(envelopes[0]?.payload).toEqual({ kind: "user", text: "m50" });
    expect(envelopes[199]?.payload).toEqual({ kind: "user", text: "m249" });
  });

  it("falls back to `now` when a line has no timestamp", () => {
    const envelopes = reconstruct([
      line({ type: "user", message: { role: "user", content: "x" } }),
    ]);
    expect(envelopes[0]?.ts).toBe("2026-06-25T00:00:00.000Z");
  });
});

describe("readSessionHistory — filesystem read", () => {
  it("returns [] when the session JSONL is missing", () => {
    const envelopes = readSessionHistory(
      "/nonexistent/kaoiro/cwd",
      "no-such-session",
      config,
      now,
    );
    expect(envelopes).toEqual([]);
  });

  it("rejects a path-traversing session_id without touching the filesystem", () => {
    for (const bad of ["../../.npmrc", "a/b", "..", "id.with.dot", ""]) {
      expect(readSessionHistory("/home/user/git/kaoiro", bad, config, now)).toEqual(
        [],
      );
    }
  });
});

describe("sessionSidecarPath (ADR-0051 D3-2)", () => {
  it("transcript と同じディレクトリの <session-id>.ia.jsonl を返す", () => {
    const path = sessionSidecarPath("/home/u/proj", "abc-123");
    expect(path).not.toBeNull();
    expect(path).toMatch(/\/\.claude\/projects\/-home-u-proj\/abc-123\.ia\.jsonl$/);
  });

  it("パス成分にできない session_id は null (traversal fail-closed)", () => {
    expect(sessionSidecarPath("/home/u/proj", "../escape")).toBeNull();
    expect(sessionSidecarPath("/home/u/proj", "a/b")).toBeNull();
    expect(sessionSidecarPath("/home/u/proj", "")).toBeNull();
  });
});
