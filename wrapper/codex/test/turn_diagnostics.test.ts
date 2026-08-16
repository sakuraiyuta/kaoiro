import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ThreadEvent } from "@openai/codex-sdk";
import { InterAgentTool } from "@kaoiro/agent-common";
import type { Envelope, InterAgentMessagePayload, WrapperConfig } from "@kaoiro/agent-common";
import { CodexTurnDiagnostics } from "../src/turn_diagnostics.js";

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
  it("failure trace は 0600 で JSONL 末尾・child status・bridge stderr・固定分類を保存する", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kaoiro-trace-test-"));
    const trace = new CodexTurnDiagnostics(directory);
    await trace.begin();
    trace.recordEvent({
      type: "turn.failed",
      error: { message: "untrusted raw failure /private/path" },
    } as ThreadEvent);

    const path = await trace.writeFailure({
      sessionId: "session-1",
      turnToken: "turn-1",
      detail: "Codex Exec exited with code 1: /private/path",
      outcome: "run_streamed_rejected",
    });

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const record = JSON.parse(await readFile(path, "utf8")) as {
      session_id: string;
      turn_token: string;
      child: { exitCode?: number; stderrTail: string };
      stdout_jsonl_tail: string[];
      bridge_stderr_tail: string;
      wrapper_classification: { code: string; message: string };
    };
    expect(record.session_id).toBe("session-1");
    expect(record.turn_token).toBe("turn-1");
    expect(record.child.exitCode).toBe(1);
    expect(record.child.stderrTail).toContain("/private/path");
    expect(record.stdout_jsonl_tail.at(-1)).toContain("/private/path");
    expect(record.bridge_stderr_tail).toContain(trace.traceId);
    // Raw diagnostic text stays only in this local trace. The classification
    // is the fixed peer-notice template consumed by cli.ts.
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
});
