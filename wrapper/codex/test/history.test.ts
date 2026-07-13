import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { logEntryToPayload } from "@kaoiro/agent-common";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import type { ThreadEvent } from "@openai/codex-sdk";
import { threadEventToLogs } from "../src/adapter.js";
import {
  readCodexHistory,
  reconstructCodexHistory,
  replayCodexHistory,
} from "../src/history.js";

const CONFIG: WrapperConfig = {
  agent_id: "host-1.codex-history",
  persona: { id: "fuji", name: "藤", sprite_set: "fuji" },
  server_url: "ws://localhost:4000/wrapper",
};

function line(
  payload: Record<string, unknown>,
  timestamp: string | null = "2026-07-13T01:00:00Z",
) {
  return JSON.stringify({
    type: "response_item",
    ...(timestamp === null ? {} : { timestamp }),
    payload,
  });
}

function payloads(envelopes: Envelope[]) {
  return envelopes.map((envelope) => envelope.payload);
}

describe("Codex rollout history reconstruction (#106)", () => {
  it("user / assistant / exec / MCP をlive adapterと対称なpayloadへ写像する", () => {
    const jsonl = [
      line({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "調べて" }],
      }),
      line({
        type: "custom_tool_call",
        call_id: "c1",
        name: "exec",
        input: "pwd",
      }),
      line({
        type: "custom_tool_call_output",
        call_id: "c1",
        output: "/repo",
      }),
      line({
        type: "function_call",
        call_id: "c2",
        namespace: "kaoiro",
        name: "whoami",
        arguments: '{"detail":true}',
      }),
      line({ type: "function_call_output", call_id: "c2", output: "藤" }),
      line({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "完了です" }],
      }),
    ].join("\n");

    const replay = reconstructCodexHistory(
      jsonl,
      CONFIG,
      "uuid-history",
      () => "NOW",
    );
    expect(
      replay.every((envelope) => envelope.session_id === "uuid-history"),
    ).toBe(true);
    expect(payloads(replay)).toEqual([
      { kind: "user", text: "調べて" },
      livePayload({
        type: "item.started",
        item: {
          id: "c1",
          type: "command_execution",
          command: "pwd",
          status: "in_progress",
          aggregated_output: "",
        },
      }),
      livePayload({
        type: "item.completed",
        item: {
          id: "c1",
          type: "command_execution",
          command: "pwd",
          status: "completed",
          aggregated_output: "/repo",
          exit_code: 0,
        },
      }, new Map([["c1", "shell"]])),
      livePayload({
        type: "item.started",
        item: {
          id: "c2",
          type: "mcp_tool_call",
          server: "kaoiro",
          tool: "whoami",
          arguments: { detail: true },
          status: "in_progress",
        },
      }),
      livePayload({
        type: "item.completed",
        item: {
          id: "c2",
          type: "mcp_tool_call",
          server: "kaoiro",
          tool: "whoami",
          arguments: { detail: true },
          status: "completed",
          result: {
            content: [{ type: "text", text: "藤" }],
            structured_content: null,
          },
        },
      }, new Map([["c2", "mcp__kaoiro__whoami"]])),
      livePayload({
        type: "item.completed",
        item: { id: "m1", type: "agent_message", text: "完了です" },
      }),
    ]);
  });

  it("reasoning/developer/event_msg/破損行をskipしtimestamp fallbackを使う", () => {
    const jsonl = [
      line({ type: "reasoning", summary: [], encrypted_content: "opaque" }),
      line({
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "secret" }],
      }),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "agent_message", message: "duplicate" },
      }),
      "{broken",
      line(
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "ok" }],
        },
        null,
      ),
    ].join("\n");
    const [only] = reconstructCodexHistory(jsonl, CONFIG, "uuid", () => "FALLBACK");
    expect(only?.payload).toEqual({ kind: "assistant", text: "ok" });
    expect(only?.ts).toBe("FALLBACK");
  });

  it("server ringと同じ最新200 envelopeにcapする", () => {
    const jsonl = Array.from({ length: 205 }, (_, i) =>
      line({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `m${i + 1}` }],
      }),
    ).join("\n");
    const history = reconstructCodexHistory(jsonl, CONFIG, "uuid", () => "T");
    expect(history).toHaveLength(200);
    expect(history[0]?.payload).toEqual({ kind: "user", text: "m6" });
    expect(history.at(-1)?.payload).toEqual({ kind: "user", text: "m205" });
  });

  it("invalid id / missing / unreadable rolloutは[]", () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-codex-history-"));
    expect(readCodexHistory("../escape", CONFIG, root)).toEqual([]);
    expect(readCodexHistory("missing", CONFIG, root)).toEqual([]);
    mkdirSync(join(root, "rollout-unreadable.jsonl"));
    expect(readCodexHistory("unreadable", CONFIG, root)).toEqual([]);
  });

  it("resume配線はsession stamp→seed→reset→replayの順", () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-codex-history-"));
    const id = "uuid-replay";
    writeFileSync(
      join(root, `rollout-${id}.jsonl`),
      `${line({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "past" }],
      })}\n`,
    );
    const events: string[] = [];
    const sent: Envelope[] = [];
    const seed: Envelope = {
      version: "0",
      agent_id: CONFIG.agent_id,
      persona: CONFIG.persona,
      ts: "SEED",
      type: "state_change",
      state: "idle",
      payload: {},
      ext: {},
    };
    const history = replayCodexHistory(
      {
        setSessionId: (sessionId) => events.push(`session:${sessionId}`),
        sendHistoryReset: () => events.push("reset"),
        send: (envelope) => {
          events.push(`send:${envelope.type}`);
          sent.push(envelope);
        },
      },
      CONFIG,
      id,
      seed,
      root,
    );
    expect(events).toEqual([
      "session:uuid-replay",
      "send:state_change",
      "reset",
      "send:log",
    ]);
    expect(history).toHaveLength(1);
    expect(sent[1]?.payload).toEqual({ kind: "assistant", text: "past" });
  });
});

function livePayload(event: ThreadEvent, names = new Map<string, string>()) {
  const [entry] = threadEventToLogs(event);
  if (entry === undefined) throw new Error("fixture did not produce a live log");
  return logEntryToPayload(entry, names);
}
