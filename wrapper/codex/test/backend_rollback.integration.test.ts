import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Codex } from "@openai/codex-sdk";
import { expect, it, vi } from "vitest";
import { AppServerSession } from "../src/app_server_session.js";
import { readCodexHistory } from "../src/history.js";
import { captureCodexPermissionRolloutCursor, codexPermissionContextAfter } from "../src/rollout.js";

// Native CLI startup may make outward update requests. Model/auth use loopback;
// analytics/plugins are disabled, and no external model reasoning is asserted.
it("resumes an app-server session with exec without losing identity, history or permission evidence", async () => {
  const home = await mkdtemp(join(tmpdir(), "fuji-348-rollback-")), codexHome = join(home, ".codex");
  await mkdir(codexHome);
  const requests: Array<{ input: Array<Record<string, unknown>> }> = [];
  const provider = createServer(async (request, response) => {
    let body = "";for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    const n = requests.length, id = `response-${n}`;
    const item = { id: `answer-${n}`, type: "message", role: "assistant", status: "completed", phase: "final_answer",
      content: [{ type: "output_text", text: `ANSWER_${n}`, annotations: [] }] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id, object: "response", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id, object: "response", status: "completed", output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();if (!address || typeof address === "string") throw new Error("No provider port");
  let session: AppServerSession | undefined;
  try {
    await writeFile(join(codexHome, "config.toml"), `model="gpt-5.6-sol"
model_provider="local"
approvals_reviewer="auto_review"
[model_providers.local]
name="Loopback"
base_url="http://127.0.0.1:${address.port}/v1"
wire_api="responses"
[features]
shell_snapshot=false
plugins=false
[analytics]
enabled=false
`);
    vi.stubEnv("HOME", home);vi.stubEnv("CODEX_HOME", codexHome);
    for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID"]) vi.stubEnv(key, undefined);
    const root = join(codexHome, "sessions");
    session = await AppServerSession.create({ thread: { cwd: home, sandbox: "workspace-write" }, turnSignal: () => null });
    const threadId = await session.startThread();
    for (let n = 1; n <= 2; n++) {
      const cursor = captureCodexPermissionRolloutCursor(root, n === 1 ? null : threadId);
      const turn = await session.startProjectedTurn({ threadId, hostTurnToken: `host-${n}`, clientUserMessageId: `user-${n}`, input: `QUESTION_${n}` });
      const events = [];for await (const event of turn.events) events.push(event);
      expect(events.filter(e => e.kind === "result")).toEqual([{ kind: "result", status: "completed", payload: { text: `ANSWER_${n}`, is_error: false } }]);
      await vi.waitFor(() => expect(codexPermissionContextAfter(cursor, threadId, turn.identity.turnId)).toMatchObject({ sessionId: threadId, approvalPolicy: "never", sandbox: "workspace-write", networkAccess: false }));
    }
    await session.close();session = undefined;
    const config = { agent_id: "rollback", persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P", server_url: "ws://unused" };
    const history = readCodexHistory(threadId, config, root);
    expect(history.filter(e => e.payload.kind === "assistant").map(e => e.payload.text)).toEqual(["ANSWER_1", "ANSWER_2"]);
    expect(history.every(e => e.type === "log" && e.session_id === threadId)).toBe(true);
    const cursor = captureCodexPermissionRolloutCursor(root, threadId);
    const sdk = new Codex({ config: { approvals_reviewer: "user" } });
    const thread = sdk.resumeThread(threadId, { workingDirectory: home, skipGitRepoCheck: true,
      sandboxMode: "workspace-write", networkAccessEnabled: false, approvalPolicy: "never" });
    const stream = await thread.runStreamed("QUESTION_3", { signal: AbortSignal.timeout(25_000) });
    const events = [];for await (const event of stream.events) events.push(event);
    expect(events.find(e => e.type === "thread.started")).toEqual({ type: "thread.started", thread_id: threadId });
    expect(thread.id).toBe(threadId);
    expect(events.filter(e => e.type === "turn.completed")).toHaveLength(1);
    expect(events.some(e => e.type === "item.completed" && e.item.type === "agent_message" && e.item.text === "ANSWER_3")).toBe(true);
    expect(requests).toHaveLength(3);
    for (const text of ["QUESTION_1", "ANSWER_1", "QUESTION_2", "ANSWER_2", "QUESTION_3"]) expect(JSON.stringify(requests[2]!.input)).toContain(text);
    const permission = codexPermissionContextAfter(cursor, threadId);
    expect(permission).toMatchObject({ sessionId: threadId, approvalPolicy: "never", sandbox: "workspace-write", networkAccess: false });
    expect(readCodexHistory(threadId, config, root).filter(e => e.payload.kind === "assistant").map(e => e.payload.text)).toEqual(["ANSWER_1", "ANSWER_2", "ANSWER_3"]);
  } finally {
    await session?.close();vi.unstubAllEnvs();provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));await rm(home, { recursive: true, force: true });
  }
}, 90_000);
