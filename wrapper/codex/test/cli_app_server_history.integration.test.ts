import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ServerLink } from "@kaoiro/wrapper-core";
import { AppServerSession } from "../src/app_server_session.js";
import { CodexHost } from "../src/host.js";
import { runCodexCli } from "../src/cli.js";
import { phoenixLoopback } from "./fixtures/phoenix_loopback.js";
import { MAX_HISTORY } from "../src/history.js";

// The default pinned CLI may contact update services at startup. Local model
// and auth are sufficient; analytics and external plugin clones are disabled.
it("wires full and tail history through the CLI, default Host session and real ServerLink across reconnect", async () => {
  const home = await mkdtemp(join(tmpdir(), "fuji-348-history-"));
  let calls = 0;
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const responses = new Map([3, 4].map(n => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    return [n, { ready, release }] as const;
  }));
  let resumeWire: (() => unknown) | undefined;
  const sent = vi.spyOn(ServerLink.prototype, "send");
  const scheduled = vi.spyOn(CodexHost.prototype, "scheduleHistoryReplay");
  const queued = vi.spyOn(CodexHost.prototype, "send");
  const wire = await phoenixLoopback(n => ({ hydration: { replay_required: true, replay_id: `r${n}` } }));
  let host: CodexHost | undefined, running: Promise<void> | undefined;
  const starts: string[] = [], finals: string[] = [];
  const signals = process.listeners("SIGINT");
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {}
    calls += 1;
    if (calls === 2) await hold;
    await responses.get(calls)?.ready;
    const output = Array.from({ length: calls === 2 ? 205 : 2 }, (_, n) => ({
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
    session = undefined;
    const config = { agent_id: "history-cli", persona: { id: "fuji", name: "Fuji", sprite_set: "fuji" }, display_name: "Fuji", server_url: wire.url, model: "gpt-5.6-sol" };
    running = runCodexCli({
      parseCliArgs: () => ({ configPath: "fixture", prompt: undefined, resume: threadId }), loadConfig: () => config,
      createHost: (value, options) => {
        host = new CodexHost(value, { ...options, backend: "app-server",
          onTurnStart: info => { starts.push(info.turnToken);options.onTurnStart?.(info); },
          onTurnFinalized: info => { finals.push(info.turnToken);options.onTurnFinalized?.(info); },
        });return host;
      },
    });
    const completes = () => wire.received.filter(e => e.event === "history_replay_complete");
    const results = () => wire.received.filter(e => e.event === "envelope" && e.payload.type === "result");
    const waitForResults = (count: number) => vi.waitFor(() => expect(results()).toHaveLength(count), { timeout: 25_000 });
    const window = (id: string) => {
      const begin = wire.received.findIndex(e => e.event === "history_reset" && e.payload.replay_id === id);
      const end = wire.received.findIndex(e => e.event === "history_replay_complete" && e.payload.replay_id === id);
      expect(begin).toBeGreaterThanOrEqual(0);expect(end).toBeGreaterThan(begin);
      return wire.received.slice(begin + 1, end).filter(e => e.event === "envelope").map(e => e.payload);
    };
    await vi.waitFor(() => expect(wire.joins).toBe(1), { timeout: 10_000 });
    wire.push("persona_prompt", { prompt: "History test" });
    await vi.waitFor(() => expect(completes()).toHaveLength(1), { timeout: 35_000 });
    expect(window("r1").map(e => e.payload)).toEqual([
      { kind: "assistant", text: "ANSWER_1_0" }, { kind: "assistant", text: "ANSWER_1_1" },
    ]);
    expect(calls).toBe(1);expect(starts).toEqual([]);expect(finals).toEqual([]);
    wire.push("instruction", { version: "0", text: "NEXT" });
    await vi.waitFor(() => expect(calls).toBe(2), { timeout: 25_000 });
    wire.drop();await vi.waitFor(() => expect(wire.joins).toBe(2), { timeout: 10_000 });
    wire.push("instruction", { version: "0", text: "AFTER" });
    await vi.waitFor(() => expect(scheduled).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(queued).toHaveBeenCalledWith("AFTER", undefined));
    await (sent.mock.contexts[0] as ServerLink).requestDirectory();
    expect(completes()).toHaveLength(1);expect(starts).toHaveLength(1);
    release();await vi.waitFor(() => expect(completes()).toHaveLength(2), { timeout: 25_000 });
    expect(window("r2").map(e => e.payload)).toEqual(Array.from({ length: MAX_HISTORY }, (_, n) => ({ kind: "assistant", text: `ANSWER_2_${n + 5}` })));
    expect(window("r2").every(e => e.type === "log" && e.session_id === threadId)).toBe(true);
    // Finalization is local; deliberately leave the wire receiver behind it.
    resumeWire = wire.pauseInbound();responses.get(3)!.release();
    await vi.waitFor(() => expect(finals).toHaveLength(2), { timeout: 25_000 });
    expect(results()).toHaveLength(1);
    const receivedSecond = waitForResults(2);
    resumeWire();resumeWire = undefined;await receivedSecond;
    const completedReplay = wire.received.findIndex(e => e.event === "history_replay_complete" && e.payload.replay_id === "r2");
    const thirdAnswer = wire.received.findIndex(e => e.event === "envelope" && (e.payload.payload as { text?: string })?.text === "ANSWER_3_0");
    expect(thirdAnswer).toBeGreaterThan(completedReplay);
    expect(results()).toHaveLength(2);
    expect(wire.received.filter(e => e.event === "delivery_ack")).toHaveLength(0);
    expect(calls).toBe(3);expect(starts).toHaveLength(2);
    // The first two cycles above use the untouched default path. Hold one read
    // here solely to make the live-user arrival window deterministic.
    let unblock!: () => void, reading = false;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const originalRead = AppServerSession.prototype.readHistory;
    const reader = vi.spyOn(AppServerSession.prototype, "readHistory").mockImplementationOnce(async function (this: AppServerSession, ...args) {
      reading = true;await blocked;return originalRead.apply(this, args);
    });
    const output = vi.spyOn(process.stdout, "write");
    try {
    wire.drop();await vi.waitFor(() => expect(reading).toBe(true), { timeout: 10_000 });
    const priorUsers = wire.received.filter(e => e.event === "envelope" && (e.payload.payload as { text?: string })?.text === "DURING_READ");
    expect(priorUsers).toHaveLength(0);
      wire.push("instruction", { version: "0", text: "DURING_READ" });
      await vi.waitFor(() => expect(output.mock.calls.some(([line]) => String(line).includes("DURING_READ"))).toBe(true));
      expect(sent.mock.calls.filter(([e]) => (e.payload as { text?: string })?.text === "DURING_READ")).toHaveLength(0);
      await (sent.mock.contexts[0] as ServerLink).requestDirectory();
      expect(wire.received.filter(e => e.event === "envelope" && (e.payload.payload as { text?: string })?.text === "DURING_READ")).toHaveLength(0);
      expect(calls).toBe(3);unblock();
      await vi.waitFor(() => expect(completes()).toHaveLength(3));
      resumeWire = wire.pauseInbound();responses.get(4)!.release();
      await vi.waitFor(() => expect(finals).toHaveLength(3), { timeout: 25_000 });
      expect(results()).toHaveLength(2);
      const receivedThird = waitForResults(3);
      resumeWire();resumeWire = undefined;await receivedThird;
      const complete = wire.received.findIndex(e => e.event === "history_replay_complete" && e.payload.replay_id === "r3");
      const user = wire.received.findIndex(e => e.event === "envelope" && (e.payload.payload as { text?: string })?.text === "DURING_READ");
      expect(complete).toBeGreaterThan(-1);expect(user).toBeGreaterThan(complete);expect(calls).toBe(4);
    } finally { unblock();reader.mockRestore();output.mockRestore(); }
  } finally {
    resumeWire?.();for (const response of responses.values()) response.release();
    release();host?.close();await running;await session?.close();await wire.close();
    sent.mockRestore();scheduled.mockRestore();queued.mockRestore();
    for (const listener of process.listeners("SIGINT")) if (!signals.includes(listener)) process.removeListener("SIGINT", listener);
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
}, 90_000);
