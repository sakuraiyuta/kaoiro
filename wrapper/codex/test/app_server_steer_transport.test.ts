import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServerNotification, RpcObject } from "../src/app_server_rpc.js";
import { AppServerForeignTurnError, AppServerTransport, type AppServerForeignTurn } from "../src/app_server_transport.js";

function fixture() {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const sent: RpcObject[] = [];
  let handle: (message: RpcObject) => void = () => {};
  const stdin = new Writable({ write(chunk: Buffer, _encoding, callback) {
    const message = JSON.parse(chunk.toString()) as RpcObject;
    sent.push(message);
    handle(message);
    callback();
  } });
  Object.assign(child, { stdout, stderr, stdin, exitCode: null, signalCode: null });
  const exit = () => {
    if (child.exitCode !== null) return;
    Object.assign(child, { exitCode: 0 });
    child.emit("exit", 0, null);
    stdout.end();
    stderr.end();
    queueMicrotask(() => child.emit("close", 0, null));
  };
  stdin.on("finish", exit);
  child.kill = vi.fn(() => { exit(); return true; });
  const send = (value: unknown) => stdout.write(JSON.stringify(value) + "\n");
  return { child, stdout, stderr, stdin, sent, exit, send,
    handle(fn: (message: RpcObject) => void) { handle = fn; },
    respond(request: RpcObject, result: unknown) { send({ id: request.id, result }); },
  };
}
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()));
  vi.restoreAllMocks();
});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const notification = (method: string, turnId = "turn-1", threadId = "thread-1"): AppServerNotification => ({
  method, params: method.startsWith("turn/") ? { threadId, turn: { id: turnId, status: "completed" } } : { threadId, turnId, text: "part" },
});
async function collect(events: AsyncIterable<AppServerNotification>) {
  const result: AppServerNotification[] = [];
  for await (const event of events) result.push(event);
  return result;
}
function transportFixture(onDisconnect?: (error: Error) => void) {
  const f = fixture();
  const transport = new AppServerTransport({ spawnChild: () => f.child, requestTimeoutMs: 1000, ...(onDisconnect ? { onDisconnect } : {}) });
  closers.push(() => transport.close());
  f.handle(request => {
    if (request.method === "initialize") f.respond(request, { userAgent: "kaoiro/0.153.4 (test)" });
    if (request.method === "thread/start" || request.method === "thread/resume") f.respond(request, { thread: { id: "thread-1" } });
  });
  return { ...f, transport };
}


function steerFixture(options: { enforceForeignTurn?: boolean } = {}) {
  const f = fixture();
  const foreign: AppServerForeignTurn[] = [];
  const transport = new AppServerTransport({
    spawnChild: () => f.child, requestTimeoutMs: 1000,
    onForeignTurn: turn => foreign.push(turn), ...options,
  });
  closers.push(() => transport.close());
  let onTurnStart: (request: RpcObject) => void = request => f.respond(request, { turn: { id: "turn-1" } });
  let onSteer: (request: RpcObject) => void = () => {};
  f.handle(request => {
    if (request.method === "initialize") f.respond(request, { userAgent: "kaoiro/0.156.1 (test)" });
    if (request.method === "thread/start") f.respond(request, { thread: { id: "thread-1" } });
    if (request.method === "turn/start") onTurnStart(request);
    if (request.method === "turn/steer") onSteer(request);
  });
  return { ...f, transport, foreign,
    onTurnStart(fn: (request: RpcObject) => void) { onTurnStart = fn; },
    onSteer(fn: (request: RpcObject) => void) { onSteer = fn; },
  };
}

async function activeTurn(f: ReturnType<typeof steerFixture>) {
  await f.transport.startThread();
  return f.transport.startTurn({ threadId: "thread-1", hostTurnToken: "host", input: "hello" });
}

const steer = (f: ReturnType<typeof steerFixture>, admit: (turnId: string) => string | null = () => null) =>
  f.transport.steer({ hostTurnToken: "host", input: "change it", clientUserMessageId: "kaoiro-steer:1", admit });

describe("turn/steer request", () => {
  it("writes the request in the same section as admit, with the captured turn", async () => {
    const f = steerFixture();
    await activeTurn(f);
    let sentAtAdmit = -1;
    const attempt = steer(f, turnId => { sentAtAdmit = f.sent.length; expect(turnId).toBe("turn-1"); return null; });
    expect(attempt.kind).toBe("sent");
    const steerRequest = f.sent.at(-1)!;
    expect(f.sent.length).toBe(sentAtAdmit + 1);
    expect(steerRequest).toMatchObject({ method: "turn/steer", params: {
      threadId: "thread-1", expectedTurnId: "turn-1", clientUserMessageId: "kaoiro-steer:1",
      input: [{ type: "text", text: "change it", text_elements: [] }] } });
  });

  it("sends nothing when admit declines", async () => {
    const f = steerFixture();
    await activeTurn(f);
    expect(steer(f, () => "pending_settings")).toEqual({ kind: "declined", reason: "pending_settings" });
    expect(f.sent.some(r => r.method === "turn/steer")).toBe(false);
  });

  it("is idle without an active turn of the same token and after the terminal is read", async () => {
    const f = steerFixture();
    await f.transport.startThread();
    expect(steer(f)).toEqual({ kind: "refused", reason: "idle" });
    await activeTurn(f);
    expect(f.transport.steer({ hostTurnToken: "other", input: "x", clientUserMessageId: "c", admit: () => null }))
      .toEqual({ kind: "refused", reason: "idle" });
    f.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    await tick();
    expect(steer(f)).toEqual({ kind: "refused", reason: "idle" });
  });

  it("reports starting until the turn/start response names the turn", async () => {
    const f = steerFixture();
    await f.transport.startThread();
    let respond!: () => void;
    f.onTurnStart(request => { respond = () => f.respond(request, { turn: { id: "turn-1" } }); });
    const started = f.transport.startTurn({ threadId: "thread-1", hostTurnToken: "host", input: "hello" });
    await tick();
    const attempt = steer(f);
    expect(attempt.kind).toBe("starting");
    respond();
    await started;
    if (attempt.kind === "starting") await attempt.ready;
    expect(steer(f).kind).toBe("sent");
  });

  const classify = async (reply: (f: ReturnType<typeof steerFixture>, request: RpcObject) => void) => {
    const f = steerFixture();
    await activeTurn(f);
    f.onSteer(request => reply(f, request));
    const attempt = steer(f);
    if (attempt.kind !== "sent") throw new Error(attempt.kind);
    return attempt.response;
  };

  it("classifies an accepted response with the same turn as A", async () => {
    expect(await classify((f, r) => f.respond(r, { turnId: "turn-1" }))).toEqual({ kind: "A" });
  });
  it("classifies a response naming another turn as V", async () => {
    expect(await classify((f, r) => f.respond(r, { turnId: "turn-2" }))).toEqual({ kind: "V", turnId: "turn-2" });
  });
  // Captured shapes from issue #366 probes L0 (no data) and L4 (codexErrorInfo).
  it("classifies the measured expected-turn rejections as P", async () => {
    expect(await classify((f, r) => f.send({ id: r.id, error: { code: -32600,
      message: "expected active turn id `wrong-turn-id` but found `01a0ee11-51ea-70f3-bc6b-68e4c5e0ad8b`" } })))
      .toEqual({ kind: "P", reason: "turn_changed" });
    expect(await classify((f, r) => f.send({ id: r.id, error: { code: -32600, message: "no active turn to steer" } })))
      .toEqual({ kind: "P", reason: "turn_changed" });
  });
  it("classifies the measured non-steerable rejection from its data as P", async () => {
    expect(await classify((f, r) => f.send({ id: r.id, error: { code: -32600, message: "cannot steer a compact turn",
      data: { message: "cannot steer a compact turn", codexErrorInfo: { activeTurnNotSteerable: { turnKind: "compact" } },
        additionalDetails: null, misalignment: null } } })))
      .toEqual({ kind: "P", reason: "not_steerable:compact" });
  });
  it("classifies any other error as E and a lost connection as C", async () => {
    expect(await classify((f, r) => f.send({ id: r.id, error: { code: -32602, message: "invalid params" } })))
      .toEqual({ kind: "E", code: -32602, message: "invalid params" });
    expect(await classify((f, r) => f.send({ id: r.id, error: { code: -32600, message: "cannot steer a compact turn" } })))
      .toEqual({ kind: "E", code: -32600, message: "cannot steer a compact turn" });
    expect(await classify(f => f.exit())).toEqual({ kind: "C" });
  });
});

describe("foreign-turn tripwire", () => {
  const started = (turnId: string, threadId = "thread-1"): AppServerNotification =>
    ({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress" } } });

  it("detects a foreign turn with no active turn", async () => {
    const f = steerFixture();
    await f.transport.startThread();
    f.send(started("foreign-1"));
    await tick();
    expect(f.foreign).toEqual([{ threadId: "thread-1", turnId: "foreign-1" }]);
  });

  it("detects a foreign item without any turn/started", async () => {
    const f = steerFixture();
    await f.transport.startThread();
    f.send({ method: "item/started", params: { threadId: "thread-1", turnId: "foreign-2", item: { id: "i", type: "reasoning" } } });
    await tick();
    expect(f.foreign).toEqual([{ threadId: "thread-1", turnId: "foreign-2" }]);
  });

  it("judges notifications buffered before the start response against the named turn", async () => {
    const f = steerFixture();
    await f.transport.startThread();
    f.onTurnStart(request => {
      f.send(started("turn-1"));
      f.send(started("foreign-3"));
      f.respond(request, { turn: { id: "turn-1" } });
    });
    await f.transport.startTurn({ threadId: "thread-1", hostTurnToken: "host", input: "hello" });
    expect(f.foreign).toEqual([{ threadId: "thread-1", turnId: "foreign-3" }]);
  });

  it("detects a different turn while one is active", async () => {
    const f = steerFixture();
    await activeTurn(f);
    f.send(started("foreign-4"));
    await tick();
    expect(f.foreign).toEqual([{ threadId: "thread-1", turnId: "foreign-4" }]);
  });

  it("does not treat own late items, other threads, or own turn events as foreign", async () => {
    const f = steerFixture();
    await activeTurn(f);
    f.send(started("turn-1"));
    f.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } } });
    f.send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "c", type: "commandExecution" } } });
    f.send(started("child-turn", "child-thread"));
    await tick();
    expect(f.foreign).toEqual([]);
  });

  it("with enforcement, stops steering and the next turn/start", async () => {
    const f = steerFixture({ enforceForeignTurn: true });
    await activeTurn(f);
    f.send(started("foreign-5"));
    await tick();
    expect(steer(f)).toEqual({ kind: "refused", reason: "foreign_turn" });
    f.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    await tick();
    await expect(f.transport.startTurn({ threadId: "thread-1", hostTurnToken: "next", input: "next" }))
      .rejects.toBeInstanceOf(AppServerForeignTurnError);
    expect(f.sent.filter(r => r.method === "turn/start")).toHaveLength(1);
  });

  it("without enforcement, only reports", async () => {
    const f = steerFixture();
    await activeTurn(f);
    f.send(started("foreign-6"));
    await tick();
    expect(steer(f).kind).toBe("sent");
    expect(f.foreign).toHaveLength(1);
  });
});
