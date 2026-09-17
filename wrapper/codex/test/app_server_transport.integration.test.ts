import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AppServerTransport } from "../src/app_server_transport.js";
import type { AppServerNotification } from "../src/app_server_rpc.js";

// The real CLI can attempt outward startup traffic (including update checks).
// The model endpoint and authentication are local; offline startup may still be slower.
it("runs the default app-server composition through sequential turns and persisted resume", async () => {
  const home = await mkdtemp(join(tmpdir(), "fuji-348-app-server-"));
  let calls = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {}
    calls += 1;
    const id = `resp_${calls}`;
    const item = { type: "message", id: `message_${calls}`, role: "assistant", status: "completed",
      content: [{ type: "output_text", text: `藤 ${calls}`, annotations: [] }], phase: "final_answer" };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id, object: "response", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: `藤 ${calls}` },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id, object: "response", status: "completed", output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local port");
  let transport: AppServerTransport | undefined;
  const config = `approvals_reviewer = "auto_review"
model = "gpt-5.6-sol"
model_provider = "local"
[model_providers.local]
name = "Local integration test"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
[features]
shell_snapshot = false
[analytics]
enabled = false
`;
  try {
    await writeFile(join(home, "config.toml"), config);
    vi.stubEnv("CODEX_HOME", home);
    vi.stubEnv("HOME", home);
    for (const name of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID"]) vi.stubEnv(name, undefined);
    transport = new AppServerTransport();
    const threadId = await transport.startThread({ cwd: home, sandbox: "read-only" });
    const packageUrl = new URL("../node_modules/@openai/codex/package.json", import.meta.url);
    const installed = JSON.parse(await readFile(packageUrl, "utf8")) as { version: string };
    expect(transport.version).toBe(installed.version);
    const turnIds = new Set<string>();
    for (let index = 1; index <= 3; index += 1) {
      if (index === 3) {
        await transport.close();
        transport = new AppServerTransport();
        expect(await transport.resumeThread(threadId, { cwd: home, sandbox: "read-only" })).toBe(threadId);
      }
      const turn = await transport.startTurn({ threadId, hostTurnToken: `host-${index}`, clientUserMessageId: `user-${index}`, input: "Reply briefly without tools." });
      expect(turn.identity).toMatchObject({ threadId, hostTurnToken: `host-${index}`, clientUserMessageId: `user-${index}` });
      expect(typeof turn.identity.requestId).toBe("number");
      turnIds.add(turn.identity.turnId);
      const events: AppServerNotification[] = [];
      for await (const event of turn.events) events.push(event);
      expect(events.filter(e => e.method === "turn/completed")).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ method: "turn/completed", params: { turn: { id: turn.identity.turnId, status: "completed" } } });
      expect(events).toContainEqual(expect.objectContaining({ method: "item/completed", params: expect.objectContaining({ item: expect.objectContaining({ type: "agentMessage", text: `藤 ${index}` }) }) }));
      expect(events).toContainEqual(expect.objectContaining({ method: "item/completed", params: expect.objectContaining({ item: expect.objectContaining({ type: "userMessage", clientId: `user-${index}` }) }) }));
    }
    await transport.close();
    expect(turnIds.size).toBe(3);
    expect(calls).toBe(3);
    const sessions = join(home, "sessions");
    const contexts: Record<string, unknown>[] = [];
    for (const path of (await readdir(sessions, { recursive: true })).filter(p => p.endsWith(".jsonl"))) {
      for (const line of (await readFile(join(sessions, path), "utf8")).trim().split("\n")) {
        const record = JSON.parse(line);
        if (record.type === "turn_context") contexts.push(record.payload);
      }
    }
    expect(contexts).toHaveLength(3);
    for (const context of contexts) expect(context).toMatchObject({ approval_policy: "never", approvals_reviewer: "user" });
    expect(await readFile(join(home, "config.toml"), "utf8")).toBe(config);
    expect(await readdir(home)).not.toContain("auth.json");
    expect(transport.stderrTail).not.toMatch(/unknown.config/i);
  } finally {
    await transport?.close();
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
}, 90_000);
