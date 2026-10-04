import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AppServerSession } from "../src/app_server_session.js";
import type { AppServerTurn } from "../src/app_server_transport.js";

// turn/steer on the pinned native against a local Responses provider. Each
// steer carries a nonce, and the provider's next request must contain it while
// the same turn runs to completion. The steer is sent on an observed event,
// never after a fixed sleep.

type Item = Record<string, unknown>;

function stream(response: ServerResponse, id: string, items: Item[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (event: Item) => response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
  send({ type: "response.created", response: { id, object: "response", status: "in_progress", output: [] } });
  items.forEach((item, index) => {
    send({ type: "response.output_item.added", output_index: index, item });
    send({ type: "response.output_item.done", output_index: index, item });
  });
  send({ type: "response.completed", response: { id, object: "response", status: "completed", output: items, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
  response.end();
}

const answer = (n: number): Item => ({ id: `answer-${n}`, type: "message", role: "assistant", phase: "final_answer", status: "completed",
  content: [{ type: "output_text", text: "DONE", annotations: [] }] });

async function withNative(
  respond: (n: number, body: string, response: ServerResponse) => void,
  run: (session: AppServerSession, threadId: string, bodies: string[]) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "kaoiro-steer-"));
  const bodies: string[] = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    bodies.push(body);
    respond(bodies.length, body, response);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No local port");
  // gpt-6-luna selects the code-mode tool surface the production peers use.
  await writeFile(join(home, "config.toml"), `model = "gpt-6-luna"
model_provider = "local"
[model_providers.local]
name = "Local steer test"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
[features]
shell_snapshot = false
plugins = false
[analytics]
enabled = false
`);
  let session: AppServerSession | undefined;
  try {
    vi.stubEnv("CODEX_HOME", home); vi.stubEnv("HOME", home);
    for (const name of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID"]) vi.stubEnv(name, undefined);
    session = await AppServerSession.create({ thread: { cwd: home, sandbox: "read-only" }, turnSignal: () => null });
    await run(session, await session.startThread(), bodies);
  } finally {
    await session?.close();
    vi.unstubAllEnvs();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
}

async function steer(session: AppServerSession, hostTurnToken: string, turnId: string, nonce: string): Promise<void> {
  const attempt = session.steer({ hostTurnToken, input: `steer ${nonce}`, clientUserMessageId: randomUUID(), admit: () => null });
  expect(attempt).toMatchObject({ kind: "sent", turnId });
  if (attempt.kind !== "sent") return;
  expect(await attempt.response).toEqual({ kind: "A" });
}

async function completedTurns(turn: AppServerTurn, onEvent?: (method: string, params: Item) => void): Promise<Item[]> {
  const completed: Item[] = [];
  for await (const event of turn.events) {
    const params = (event.params ?? {}) as Item;
    onEvent?.(event.method, params);
    if (event.method === "turn/completed") completed.push(params.turn as Item);
  }
  return completed;
}

it("steers a turn while its command runs, and the same turn completes with the input", async () => {
  const nonce = `nonce-${randomUUID()}`;
  await withNative((n, _body, response) => {
    if (n !== 1) return stream(response, `response-${n}`, [answer(n)]);
    stream(response, "response-1", [{ type: "custom_tool_call", id: "call-item-1", call_id: "call-1", name: "exec", namespace: "functions",
      input: 'await tools.exec_command({ cmd: "sleep 3" });\ntext("slept");', status: "completed" }]);
  }, async (session, threadId, bodies) => {
    const turn = await session.startTurn({ threadId, hostTurnToken: "host-command", input: "start" });
    let steered: Promise<void> | undefined;
    const completed = await completedTurns(turn, (method, params) => {
      if (method === "item/started" && (params.item as Item | undefined)?.type === "commandExecution" && steered === undefined) {
        steered = steer(session, "host-command", turn.identity.turnId, nonce);
        // Observed after the loop; keep an early failure from surfacing as unhandled.
        steered.catch(() => {});
      }
    });
    expect(steered).toBeDefined();
    await steered;
    expect(completed).toEqual([expect.objectContaining({ id: turn.identity.turnId, status: "completed" })]);
    expect(bodies[0]).not.toContain(nonce);
    expect(bodies.slice(1).some(body => body.includes(nonce))).toBe(true);
  });
}, 60_000);

it("steers a turn while the model is still streaming, and the next request carries the input", async () => {
  const nonce = `nonce-${randomUUID()}`;
  let streaming!: () => void;
  const started = new Promise<void>(resolve => { streaming = resolve; });
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  await withNative((n, _body, response) => {
    if (n !== 1) return stream(response, `response-${n}`, [answer(n)]);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "response-1", object: "response", status: "in_progress", output: [] } })}\n\n`);
    streaming();
    void released.then(() => {
      const item = answer(1);
      for (const event of [
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "response-1", object: "response", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
  }, async (session, threadId, bodies) => {
    const turn = await session.startTurn({ threadId, hostTurnToken: "host-stream", input: "start" });
    const completing = completedTurns(turn);
    completing.catch(() => {});
    await started;
    try {
      await steer(session, "host-stream", turn.identity.turnId, nonce);
    } finally {
      release();
    }
    expect(await completing).toEqual([expect.objectContaining({ id: turn.identity.turnId, status: "completed" })]);
    expect(bodies[0]).not.toContain(nonce);
    expect(bodies.slice(1).some(body => body.includes(nonce))).toBe(true);
  });
}, 60_000);
