import { chmod, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ThreadEvent } from "@openai/codex-sdk";
import { InterAgentTool } from "@kaoiro/agent-common";
import type { Envelope, InterAgentMessagePayload, WrapperConfig } from "@kaoiro/agent-common";
import {
  CodexTurnDiagnostics,
  codexTurnTraceCaptureDir,
} from "../src/turn_diagnostics.js";

const CONFIG: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "momo", name: "もも", sprite_set: "momo" },
  display_name: "もも",
  server_url: "ws://localhost:4000/wrapper",
};

function inbound(): Envelope {
  return {
    version: "0", agent_id: "peer.agent", persona: CONFIG.persona,
    display_name: "peer", ts: "T", type: "inter_agent_message", state: "idle",
    payload: {
      to: CONFIG.agent_id, conversation_id: "cid", turn_number: 1,
      kind: "inform", body: "hi", meta: { done: false, propose_next: "" },
      owner: { kind: "user", id: "operator" },
    }, ext: {},
  };
}

describe("CodexTurnDiagnostics (issue #255)", () => {
  it("failure trace は 0600、CID/時刻、sanitized event tail、child/bridge 診断、固定分類を保存する", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kaoiro-trace-test-"));
    const trace = new CodexTurnDiagnostics(directory);
    await trace.begin();
    trace.recordEvent({
      type: "item.completed",
      item: {
        id: "mcp-1",
        type: "mcp_tool_call",
        server: "kaoiro",
        tool: "send_to_agent",
        status: "completed",
        arguments: { authorization: "Bearer secret-token", api_key: "sk-secret" },
        result: { content: [{ type: "text", text: "secret result" }] },
      },
    } as ThreadEvent);

    const path = await trace.writeFailure({
      sessionId: "session-1",
      turnToken: "turn-1",
      conversationIds: ["cid-a", "cid-b"],
      detail: "Codex Exec exited with code 1: /private/path",
      outcome: "run_streamed_rejected",
    });

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const record = JSON.parse(await readFile(path, "utf8")) as {
      captured_at: string;
      session_id: string;
      turn_token: string;
      conversation_ids: string[];
      child: { exitCode?: number; stderrTail: string };
      stdout_jsonl_tail: Record<string, unknown>[];
      bridge_stderr_tail: string;
      wrapper_classification: { code: string; message: string };
    };
    expect(record.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(record.session_id).toBe("session-1");
    expect(record.turn_token).toBe("turn-1");
    expect(record.conversation_ids).toEqual(["cid-a", "cid-b"]);
    expect(record.child.exitCode).toBe(1);
    expect(record.child.stderrTail).toContain("/private/path");
    expect(record.stdout_jsonl_tail).toEqual([{
      type: "item.completed",
      item_type: "mcp_tool_call",
      item_id: "mcp-1",
      status: "completed",
      server: "kaoiro",
      tool: "send_to_agent",
      error_code: null,
    }]);
    expect(JSON.stringify(record.stdout_jsonl_tail)).not.toContain("secret-token");
    expect(JSON.stringify(record.stdout_jsonl_tail)).not.toContain("sk-secret");
    expect(JSON.stringify(record.stdout_jsonl_tail)).not.toContain("secret result");
    expect(record.bridge_stderr_tail).toContain(trace.traceId);
    expect(record.wrapper_classification).toEqual({
      code: "api_error",
      message: "the peer reported an unspecified error",
    });

    const tool = new InterAgentTool({
      config: CONFIG,
      getState: () => "idle",
      send: () => {},
    });
    tool.notePendingInjection(inbound(), "turn-1");
    const notice = tool.resolveTurnEnd("turn-1", ["cid"], record.wrapper_classification)[0]!;
    const payload = notice.payload as unknown as InterAgentMessagePayload;
    expect(payload.body).toBe("peer error (api_error): the peer reported an unspecified error");
    expect(payload.body).not.toContain("/private/path");
  });

  it("既存の 0755 capture dir と 0644 bridge log を begin が 0700/0600 へ矯正する", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kaoiro-trace-mode-test-"));
    await chmod(directory, 0o755);
    const bridgePath = join(directory, "bridge.stderr.log");
    await writeFile(bridgePath, "old\n", { mode: 0o644 });
    await chmod(bridgePath, 0o644);

    const trace = new CodexTurnDiagnostics(directory);
    await trace.begin();

    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(bridgePath)).mode & 0o777).toBe(0o600);
  });

  it("別 host capture は bridge marker を混ぜず、first trace が second marker を読まない", async () => {
    const base = await mkdtemp(join(tmpdir(), "kaoiro-trace-host-test-"));
    const firstDirectory = codexTurnTraceCaptureDir(base, "agent-a", "host-a");
    const secondDirectory = codexTurnTraceCaptureDir(base, "agent-a", "host-b");
    expect(firstDirectory).not.toBe(secondDirectory);
    const first = new CodexTurnDiagnostics(firstDirectory);
    const second = new CodexTurnDiagnostics(secondDirectory);
    await first.begin();
    await second.begin();

    const firstPath = await first.writeFailure({
      sessionId: null,
      turnToken: "turn-a",
      conversationIds: ["cid-a"],
      outcome: "stream_ended_without_terminal",
    });
    const firstRecord = JSON.parse(await readFile(firstPath, "utf8")) as {
      bridge_stderr_tail: string;
    };
    expect(firstRecord.bridge_stderr_tail).toContain(first.traceId);
    expect(firstRecord.bridge_stderr_tail).not.toContain(second.traceId);
  });

  it("failure trace は host-private capture 内で最大20件に rotation する", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kaoiro-trace-rotation-test-"));
    for (let index = 0; index < 21; index += 1) {
      const trace = new CodexTurnDiagnostics(directory);
      await trace.begin();
      await trace.writeFailure({
        sessionId: null,
        turnToken: `turn-${index}`,
        conversationIds: [],
        outcome: "stream_ended_without_terminal",
      });
    }
    expect((await readdir(directory)).filter((name) => name.endsWith(".jsonl"))).toHaveLength(20);
  });
});
