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

  it("0.144.1 code-mode rollout の実 tool 名と block output を復元する", () => {
    const runnerHeader = "Script completed\nWall time 0.2 seconds\nOutput:\n";
    const jsonl = [
      line({
        type: "custom_tool_call",
        call_id: "code-shell",
        name: "exec",
        input: [
          "const r = await tools.exec_command({",
          '  cmd: "printf KAOIRO_106_SHELL"',
          "});",
          "text(r.output);",
        ].join("\n"),
      }),
      line({
        type: "custom_tool_call_output",
        call_id: "code-shell",
        output: [
          { type: "input_text", text: runnerHeader },
          { type: "input_text", text: "KAOIRO_106_SHELL" },
        ],
      }),
      line({
        type: "custom_tool_call",
        call_id: "code-mcp",
        name: "exec",
        input:
          "const result = await tools.mcp__kaoiro__list_agents({});\ntext(result);",
      }),
      line({
        type: "custom_tool_call_output",
        call_id: "code-mcp",
        output: [
          { type: "input_text", text: runnerHeader },
          { type: "input_text", text: '{"agents":[]}' },
        ],
      }),
    ].join("\n");

    expect(
      payloads(
        reconstructCodexHistory(jsonl, CONFIG, "uuid-code-mode", () => "T"),
      ),
    ).toEqual([
      {
        kind: "tool_use",
        tool_name: "shell",
        tool_use_id: "code-shell",
        input: {
          command: [
            "const r = await tools.exec_command({",
            '  cmd: "printf KAOIRO_106_SHELL"',
            "});",
            "text(r.output);",
          ].join("\n"),
        },
      },
      {
        kind: "tool_result",
        tool_name: "shell",
        tool_use_id: "code-shell",
        output: "KAOIRO_106_SHELL",
      },
      {
        kind: "tool_use",
        tool_name: "mcp__kaoiro__list_agents",
        tool_use_id: "code-mcp",
        input: {
          arguments:
            "const result = await tools.mcp__kaoiro__list_agents({});\ntext(result);",
        },
      },
      {
        kind: "tool_result",
        tool_name: "mcp__kaoiro__list_agents",
        tool_use_id: "code-mcp",
        output: '{"agents":[]}',
      },
    ]);
  });

  it("code-mode の曖昧な tool 名と output variant は安全側へ fallback する", () => {
    const runnerHeader = "Script completed\nWall time 0.2 seconds\nOutput:\n";
    const jsonl = [
      line({
        type: "custom_tool_call",
        call_id: "ambiguous",
        name: "exec",
        input: "await tools.first({}); await tools.second({});",
      }),
      line({
        type: "custom_tool_call_output",
        call_id: "ambiguous",
        output: "legacy string",
      }),
      line({
        type: "custom_tool_call",
        call_id: "dynamic",
        name: "exec",
        input: "await tools[name]({});",
      }),
      line({
        type: "custom_tool_call_output",
        call_id: "dynamic",
        output: [
          { type: "future_block", text: "ignored" },
          { type: "input_text", text: "first" },
          { type: "input_text", text: "second" },
        ],
      }),
      line({
        type: "custom_tool_call",
        call_id: "header-only",
        name: "exec",
        input: "await tools.mcp__kaoiro__whoami({});",
      }),
      line({
        type: "custom_tool_call_output",
        call_id: "header-only",
        output: [{ type: "input_text", text: runnerHeader }],
      }),
    ].join("\n");

    expect(
      payloads(reconstructCodexHistory(jsonl, CONFIG, "uuid-edge", () => "T")),
    ).toEqual([
      {
        kind: "tool_use",
        tool_name: "shell",
        tool_use_id: "ambiguous",
        input: { command: "await tools.first({}); await tools.second({});" },
      },
      {
        kind: "tool_result",
        tool_name: "shell",
        tool_use_id: "ambiguous",
        output: "legacy string",
      },
      {
        kind: "tool_use",
        tool_name: "shell",
        tool_use_id: "dynamic",
        input: { command: "await tools[name]({});" },
      },
      {
        kind: "tool_result",
        tool_name: "shell",
        tool_use_id: "dynamic",
        output: "first\nsecond",
      },
      {
        kind: "tool_use",
        tool_name: "mcp__kaoiro__whoami",
        tool_use_id: "header-only",
        input: { arguments: "await tools.mcp__kaoiro__whoami({});" },
      },
      {
        kind: "tool_result",
        tool_name: "mcp__kaoiro__whoami",
        tool_use_id: "header-only",
        output: "",
      },
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

  it("IA framing user turn だけを除外し ordinary user turn は保持する", () => {
    const jsonl = [
      line({
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text:
            '[Inter-agent message — to reply, call send_to_agent with conversation_id="cnv-1".]\n\n[from peer] inform: ping',
        }],
      }),
      line({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "ordinary instruction" }],
      }),
    ].join("\n");

    expect(payloads(
      reconstructCodexHistory(jsonl, CONFIG, "uuid", () => "T"),
    )).toEqual([{ kind: "user", text: "ordinary instruction" }]);
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
