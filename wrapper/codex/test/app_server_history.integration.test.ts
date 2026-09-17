import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AppServerSession } from "../src/app_server_session.js";
import { MAX_HISTORY } from "../src/history.js";

// The default pinned CLI may contact update services at startup. Local model
// and auth are sufficient; analytics and external plugin clones are disabled.
it("reads persisted full and bounded display history through the default session after resume", async () => {
  const home = await mkdtemp(join(tmpdir(), "fuji-348-history-"));
  let calls = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {}
    calls += 1;
    const output = Array.from({ length: calls === 1 ? 2 : 205 }, (_, n) => ({
      type: "message", id: `message_${calls}_${n}`, role: "assistant", status: "completed", phase: "final_answer",
      content: [{ type: "output_text", text: `ANSWER_${calls}_${n}`, annotations: [] }],
    }));
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id: `r${calls}`, object: "response", status: "in_progress", output: [] } },
      ...output.flatMap((item, output_index) => [
        { type: "response.output_item.added", output_index, item: { ...item, status: "in_progress" } },
        { type: "response.output_item.done", output_index, item },
      ]),
      { type: "response.completed", response: { id: `r${calls}`, object: "response", status: "completed", output,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  let session: AppServerSession | undefined;
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No local port");
    await writeFile(join(home, "config.toml"), `model = "gpt-5.6-sol"
model_provider = "local"
[model_providers.local]
name = "History test"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
[features]
shell_snapshot = false
plugins = false
[analytics]
enabled = false
`);
    vi.stubEnv("CODEX_HOME", home);
    vi.stubEnv("HOME", home);
    for (const name of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID"]) vi.stubEnv(name, undefined);
    const create = () => AppServerSession.create({ thread: { cwd: home, sandbox: "read-only" }, turnSignal: () => null });
    session = await create();
    const threadId = await session.startThread();
    const seed = await session.startTurn({ threadId, hostTurnToken: "seed",
      input: '[Inter-agent message — to reply, call send_to_agent with conversation_id="test".]\nIA_CONTENT' });
    for await (const _event of seed.events) {}
    await session.close();
    session = await create();
    expect(await session.resumeThread(threadId)).toBe(threadId);
    const config = { agent_id: "history", persona: { id: "fuji", name: "Fuji", sprite_set: "fuji" }, display_name: "Fuji", server_url: "ws://localhost/wrapper" };
    const now = () => "2026-09-18T00:00:00Z";
    const full = await session.readHistory(config, now);
    expect(full.coverage).toBe("full");
    expect(full.logs.map(log => log.payload)).toEqual([
      { kind: "assistant", text: "ANSWER_1_0" }, { kind: "assistant", text: "ANSWER_1_1" },
    ]);
    expect(calls).toBe(1);
    const large = await session.startTurn({ threadId, hostTurnToken: "large", input: "history tail" });
    for await (const _event of large.events) {}
    const tail = await session.readHistory(config, now);
    expect(tail.coverage).toBe("tail");
    expect(tail.logs.map(log => log.payload)).toEqual(Array.from({ length: MAX_HISTORY }, (_, n) => ({ kind: "assistant", text: `ANSWER_2_${n + 5}` })));
    for (const log of [...full.logs, ...tail.logs]) expect(log).toMatchObject({ type: "log", state: "idle", session_id: threadId, ts: now() });
    expect(calls).toBe(2);
  } finally {
    await session?.close();
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
}, 90_000);
