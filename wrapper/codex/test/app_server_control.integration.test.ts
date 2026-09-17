import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AppServerSession } from "../src/app_server_session.js";
import type { AppServerTurn } from "../src/app_server_transport.js";
import type { AppServerTurnSettings } from "../src/app_server_settings.js";

// CLI startup may make outward update requests. Analytics/plugins are disabled;
// all model traffic and authentication in this test use the loopback fixture.
it("uses one default session for dynamic settings, resolved effort, interrupt, and subsequent turns", async () => {
  const home = await mkdtemp(join(tmpdir(), "fuji-348-control-"));
  const requests: Array<{ model: string; reasoning: { effort: string } }> = [];
  let hold = false;
  const server = createServer(async (request, response) => {
    let body = "";for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    if (hold) return;
    const id = `response-${requests.length}`;
    const item = { id: `answer-${requests.length}`, type: "message", role: "assistant", phase: "final_answer", status: "completed",
      content: [{ type: "output_text", text: "OK", annotations: [] }] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id, object: "response", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();if (!address || typeof address === "string") throw new Error("No local port");
  const configure = (effort?: string) => writeFile(join(home, "config.toml"), `model = "gpt-5.6-sol"
approvals_reviewer = "auto_review"
model_provider = "local"
${effort ? `model_reasoning_effort = "${effort}"` : ""}
[model_providers.local]
name = "Local control test"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
[features]
shell_snapshot = false
plugins = false
[analytics]
enabled = false
`);
  let session: AppServerSession | undefined;
  async function terminal(turn: AppServerTurn, status: string) {
    const events = [];for await (const event of turn.events) events.push(event);
    expect(events.filter(e => e.method === "turn/completed")).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ turn: expect.objectContaining({ id: turn.identity.turnId, status }) }) }),
    ]);
  }
  async function context(turn: AppServerTurn) {
    // Read before child shutdown and without a history RPC that could flush storage.
    let found: Record<string, unknown> | undefined;
    await vi.waitFor(async () => {
      for (const path of (await readdir(join(home, "sessions"), { recursive: true })).filter(p => p.endsWith(".jsonl"))) {
        const lines = (await readFile(join(home, "sessions", path), "utf8")).split("\n");
        for (const line of lines.slice(0, -1).filter(Boolean)) {
          const record = JSON.parse(line);
          if (record.type === "turn_context" && record.payload.turn_id === turn.identity.turnId) found = record.payload;
        }
      }
      expect(found).toBeDefined();
    }, { timeout: 1000, interval: 25 });
    expect(found).toMatchObject({ approval_policy: "never", approvals_reviewer: "user" });
    return found!;
  }
  try {
    await configure("medium");vi.stubEnv("CODEX_HOME", home);vi.stubEnv("HOME", home);
    for (const name of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID"]) vi.stubEnv(name, undefined);
    session = await AppServerSession.create({ thread: { cwd: home, sandbox: "read-only" }, turnSignal: () => null });
    const threadId = await session.startThread();
    let count = 0;
    const start = (settings?: AppServerTurnSettings) => session!.startTurn({ threadId, hostTurnToken: `host-${++count}`, input: "Reply OK", ...(settings === undefined ? {} : { settings }) });
    const first = await start({ model: "gpt-6-astra", effort: "high", permission: { sandbox: "workspace-write", networkAccess: false } });
    await terminal(first, "completed");
    expect(await context(first)).toMatchObject({ effort: "high", sandbox_policy: { type: "workspace-write", network_access: false } });
    await configure("low");
    const changed = await start({ model: "gpt-5.6-sol", resetEffort: true, permission: { sandbox: "workspace-write", networkAccess: true } });
    await terminal(changed, "completed");
    expect(await context(changed)).toMatchObject({ model: "gpt-5.6-sol", effort: "low", sandbox_policy: { type: "workspace-write", network_access: true } });
    await configure();
    // Set high again so the catalog fallback cannot pass by retaining the last value.
    const high = await start({ effort: "high" });await terminal(high, "completed");
    const fallback = await start({ model: "gpt-5.6-sol", resetEffort: true, permission: { sandbox: "read-only", networkAccess: false } });
    await terminal(fallback, "completed");
    expect(await context(fallback)).toMatchObject({ effort: "low", sandbox_policy: { type: "read-only" } });
    await expect(start({ model: "kaoiro-nonexistent-model", resetEffort: true })).rejects.toMatchObject({ reason: "default_effort_unavailable" });
    expect(requests).toHaveLength(4);
    hold = true;
    const interrupted = await start();
    await vi.waitFor(() => expect(requests).toHaveLength(5), { timeout: 10_000 });
    expect(await session.interrupt(interrupted.identity.hostTurnToken)).toBe(true);
    await terminal(interrupted, "interrupted");
    expect(await session.interrupt(interrupted.identity.hostTurnToken)).toBe(false);
    hold = false;
    const after = await start();await terminal(after, "completed");
    expect(after.identity.threadId).toBe(threadId);
    expect(new Set([first, changed, high, fallback, interrupted, after].map(t => t.identity.turnId)).size).toBe(6);
    expect(requests.map(r => r.reasoning.effort)).toEqual(["high", "low", "high", "low", "low", "low"]);
    expect(session.stderrTail).not.toMatch(/unknown.config/i);
  } finally {
    await session?.close();vi.unstubAllEnvs();server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
}, 90_000);
