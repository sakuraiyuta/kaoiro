import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { AppServerRpc, type AppServerNotification } from "../src/app_server_rpc.js";
import { AppServerSession } from "../src/app_server_session.js";
import { tapStdout } from "./fixtures/notice_tap.js";

// Pins, against the real pinned CLI, which history calls emit the
// deprecationNotice and which do not, so that a CLI update that changes the
// wording, stops or starts emitting it turns a test red. The notice is emitted
// once per deprecated call, not once per process (measured on 0.156.1). Every
// case still runs in its own freshly spawned app-server, so the raw-stdout tap
// and the case's notice list cannot see another case's output.
const RESUME_NOTICE = "Full-history hydration is deprecated for paginated threads; use `excludeTurns: true`, then page with `thread/turns/list` and `thread/items/list`.";
const READ_NOTICE = "Full-history hydration is deprecated for paginated threads; omit `includeTurns` or set it to `false`, then page with `thread/turns/list` and `thread/items/list`.";
const policy = { approvalPolicy: "never", approvalsReviewer: "user" };
const config = { agent_id: "notice", persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P", server_url: "ws://localhost/wrapper" };

let home = "", provider: Server | undefined;
const threads = { paginated: "", legacy: "" };

async function seed(historyMode: "paginated" | "legacy"): Promise<string> {
  let completed: () => void = () => {};
  const done = new Promise<void>(resolve => { completed = resolve; });
  const rpc = new AppServerRpc({ onNotification: event => { if (event.method === "turn/completed") completed(); } });
  try {
    // historyMode is experimental; the default thread/start (no historyMode) is what the wrapper sends.
    await rpc.request("initialize", { clientInfo: { name: "ao453-seed", version: "0" }, capabilities: { experimentalApi: historyMode === "legacy" } }).result;
    rpc.notify("initialized");
    const started = await rpc.request("thread/start", { ...policy, cwd: home, sandbox: "read-only",
      ...(historyMode === "legacy" ? { historyMode } : {}) }).result as { thread: { id: string; historyMode?: string } };
    expect(started.thread.historyMode, `premise: thread/start creates a ${historyMode} thread; a CLI that drops historyMode ends this test`).toBe(historyMode);
    await rpc.request("turn/start", { ...policy, threadId: started.thread.id, input: [{ type: "text", text: "SEED_QUESTION", text_elements: [] }] }).result;
    await done;
    return started.thread.id;
  } finally {
    await rpc.close();
  }
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "ao453-notice-"));
  provider = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", phase: "final_answer",
      content: [{ type: "output_text", text: "SEED_ANSWER", annotations: [] }] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id: "r", object: "response", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress" } },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "r", object: "response", status: "completed", output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>(resolve => provider!.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("No local port");
  await writeFile(join(home, "config.toml"), `model = "gpt-6-astra"
model_provider = "local"
[model_providers.local]
name = "Notice test"
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
  threads.paginated = await seed("paginated");
  threads.legacy = await seed("legacy");
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  provider?.closeAllConnections();
  await new Promise<void>(resolve => provider ? provider.close(() => resolve()) : resolve());
  await rm(home, { recursive: true, force: true });
});

type Notice = { summary?: unknown; details?: unknown };

// One fresh app-server per call. The barrier read is answered after any
// notification the earlier request produced, so silence is observed, not waited for.
async function fresh(run: (rpc: AppServerRpc) => Promise<unknown>, threadId: string, expectNotice: boolean): Promise<{ result: unknown; notices: Notice[] }> {
  const notices: Notice[] = [];
  const rpc = new AppServerRpc({ onNotification: (event: AppServerNotification) => {
    if (event.method === "deprecationNotice") notices.push(event.params as Notice);
  } });
  try {
    await rpc.request("initialize", { clientInfo: { name: "ao453-notice", version: "0" }, capabilities: { experimentalApi: false } }).result;
    rpc.notify("initialized");
    const result = await run(rpc);
    await rpc.request("thread/read", { threadId, includeTurns: false }).result;
    if (expectNotice) await vi.waitFor(() => expect(notices).toHaveLength(1), { timeout: 5000 });
    return { result, notices };
  } finally {
    await rpc.close();
  }
}

const turnsOf = (result: unknown) => (result as { thread: { turns: unknown[] } }).thread.turns;

it("paginated: a resume without excludeTurns emits the resume notice and hydrates the turns", async () => {
  const tap = tapStdout();
  try {
    const { result, notices } = await fresh(rpc => rpc.request("thread/resume", { ...policy, threadId: threads.paginated }).result, threads.paginated, true);
    expect(notices.map(n => n.summary)).toEqual([RESUME_NOTICE]);
    expect(turnsOf(result)).toHaveLength(1);
    expect(tap.sawNotice()).toBe(true);
  } finally { tap.restore(); }
}, 60_000);

it("paginated: thread/read with includeTurns emits the read notice", async () => {
  const { result, notices } = await fresh(rpc => rpc.request("thread/read", { threadId: threads.paginated, includeTurns: true }).result, threads.paginated, true);
  expect(notices.map(n => n.summary)).toEqual([READ_NOTICE]);
  expect(turnsOf(result)).toHaveLength(1);
}, 60_000);

it("paginated: a resume with excludeTurns emits no notice and returns no turns", async () => {
  const { result, notices } = await fresh(rpc => rpc.request("thread/resume", { ...policy, threadId: threads.paginated, excludeTurns: true }).result, threads.paginated, false);
  expect(notices).toEqual([]);
  expect(turnsOf(result)).toEqual([]);
}, 60_000);

it("paginated: the production resume and history read emit no notice", async () => {
  const tap = tapStdout();
  let session: AppServerSession | undefined;
  try {
    session = await AppServerSession.create({ thread: { cwd: home, sandbox: "read-only" }, turnSignal: () => null });
    expect(await session.resumeThread(threads.paginated)).toBe(threads.paginated);
    const history = await session.readHistory(config, () => "2026-09-30T00:00:00Z");
    expect(history.coverage).toBe("full");
    expect(history.logs.map(log => (log.payload as { text?: string }).text)).toContain("SEED_ANSWER");
    expect(tap.sawNotice()).toBe(false);
  } finally { tap.restore();await session?.close(); }
}, 60_000);

it.each([
  ["a resume without excludeTurns", (id: string) => (rpc: AppServerRpc) => rpc.request("thread/resume", { ...policy, threadId: id }).result],
  ["thread/read with includeTurns", (id: string) => (rpc: AppServerRpc) => rpc.request("thread/read", { threadId: id, includeTurns: true }).result],
])("legacy: %s emits no notice but still returns the turns", async (_name, make) => {
  const { result, notices } = await fresh(make(threads.legacy), threads.legacy, false);
  expect(notices).toEqual([]);
  expect(turnsOf(result)).toHaveLength(1);
}, 60_000);

it("legacy: the production resume and history read emit no notice", async () => {
  const tap = tapStdout();
  let session: AppServerSession | undefined;
  try {
    session = await AppServerSession.create({ thread: { cwd: home, sandbox: "read-only" }, turnSignal: () => null });
    expect(await session.resumeThread(threads.legacy)).toBe(threads.legacy);
    const history = await session.readHistory(config, () => "2026-09-30T00:00:00Z");
    expect(history.coverage).toBe("full");
    expect(history.logs.map(log => (log.payload as { text?: string }).text)).toContain("SEED_ANSWER");
    expect(tap.sawNotice()).toBe(false);
  } finally { tap.restore();await session?.close(); }
}, 60_000);
