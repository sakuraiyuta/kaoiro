import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppServerConnectionError, AppServerRpc, AppServerRpcError, type AppServerNotification, type RpcObject } from "../src/app_server_rpc.js";
import { AppServerTransport } from "../src/app_server_transport.js";
import { AppServerTurnStream } from "../src/app_server_stream.js";

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
function transportFixture() {
  const f = fixture();
  const transport = new AppServerTransport({ spawnChild: () => f.child, requestTimeoutMs: 1000 });
  closers.push(() => transport.close());
  f.handle(request => {
    if (request.method === "initialize") f.respond(request, { userAgent: "kaoiro/0.153.4 (test)" });
    if (request.method === "thread/start" || request.method === "thread/resume") f.respond(request, { thread: { id: "thread-1" } });
  });
  return { ...f, transport };
}

describe("app-server JSONL process", () => {
  it("routes account notifications outside turns and retains them when initial read is unavailable", async () => {
    const f = transportFixture();
    f.handle(request => {
      if (request.method === "initialize") f.respond(request, { userAgent: "test/0.153.4" });
      if (request.method === "account/rateLimits/read") {
        f.send({ method: "account/rateLimits/updated", params: { rateLimits: { limitId: "codex", primary: { usedPercent: 70, windowDurationMins: 300 } } } });
        f.send({ id: request.id, error: { code: -32600, message: "account auth required" } });
      }
    });
    expect(await f.transport.readRateLimits()).toEqual({ readStatus: "unavailable", buckets: [
      { limitId: "codex", windows: { five_hour: { utilization: 0.7 } } },
    ] });
    f.send({ method: "account/rateLimits/updated", params: { rateLimits: { limitId: "images", primary: { usedPercent: 20, windowDurationMins: 300 } } } });
    await tick();
    expect(f.transport.rateLimits.buckets.map(b => b.limitId)).toEqual(["codex", "images"]);
  });

  it("does not convert connection failure during account read into unknown telemetry", async () => {
    const f = transportFixture();
    f.handle(request => {
      if (request.method === "initialize") f.respond(request, { userAgent: "test/0.153.4" });
      if (request.method === "account/rateLimits/read") f.exit();
    });
    await expect(f.transport.readRateLimits()).rejects.toBeInstanceOf(AppServerConnectionError);
  });
  it("rejects relative images before turn RPC or admission changes", async () => {
    const f = transportFixture();
    f.handle(request => {
      if (request.method === "initialize") f.respond(request, { userAgent: "test/0.153.4" });
      if (request.method === "turn/start") {
        f.respond(request, { turn: { id: "turn-1" } });
        f.send(notification("turn/completed"));
      }
    });
    await expect(f.transport.startTurn({ threadId: "thread-1", hostTurnToken: "bad",
      input: [{ type: "local_image", path: "relative.png" }] })).rejects.toThrow(TypeError);
    expect(f.sent).toEqual([]);
    await collect((await f.transport.startTurn({ threadId: "thread-1", hostTurnToken: "good", input: "valid" })).events);
    expect(f.sent.filter(r => r.method === "turn/start")).toHaveLength(1);
  });
  it("correlates out-of-order responses and rejects server requests without echoing their payload", async () => {
    const f = fixture();
    const diagnostics: string[] = [];
    const rpc = new AppServerRpc({ spawnChild: () => f.child, onDiagnostic: message => diagnostics.push(message) });
    closers.push(() => rpc.close());
    const a = rpc.request("a", {}), b = rpc.request("b", {});
    f.send({ id: "approval", method: "item/commandExecution/requestApproval", params: { secret: "DO_NOT_LOG" } });
    f.send({ id: b.id, result: "second" });
    f.send({ id: a.id, result: "first" });
    expect(await a.result).toBe("first");
    expect(await b.result).toBe("second");
    expect(f.sent.at(-1)).toMatchObject({ id: "approval", error: { code: -32601 } });
    expect(diagnostics).toEqual(["Unexpected app-server request rejected"]);
  });

  it("decodes split UTF-8 and drains final unterminated JSON after child exit", async () => {
    const f = fixture();
    const notifications: AppServerNotification[] = [];
    const rpc = new AppServerRpc({ spawnChild: () => f.child, onNotification: e => notifications.push(e) });
    closers.push(() => rpc.close());
    const ticket = rpc.request("one", {});
    const wire = Buffer.from(JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "藤" } }) + "\n" + JSON.stringify({ id: ticket.id, result: "tail" }));
    const split = wire.indexOf(Buffer.from("藤")) + 1;
    f.stdout.write(wire.subarray(0, split));
    await tick();
    f.child.emit("exit", 0, null);
    f.stdout.end(wire.subarray(split));
    expect(await ticket.result).toBe("tail");
    expect(notifications).toEqual([{ method: "item/agentMessage/delta", params: { delta: "藤" } }]);
  });

  it("rejects all pending responses on EOF", async () => {
    const f = fixture();
    const rpc = new AppServerRpc({ spawnChild: () => f.child });
    closers.push(() => rpc.close());
    const a = rpc.request("a", {}), b = rpc.request("b", {});
    const outcomes = Promise.allSettled([a.result, b.result]);
    f.exit();
    expect((await outcomes).map(r => r.status)).toEqual(["rejected", "rejected"]);
    await expect(rpc.request("later", {}).result).rejects.toThrow("stdout ended");
  });

  it.each([Buffer.from('{bad}\n'), Buffer.concat([Buffer.from('{"id":1,"result":"'), Buffer.from([0xff]), Buffer.from('"}\n')]), Buffer.from('{"id":1,"result":1,"error":{"code":-32600,"message":"conflict"}}\n')])("fails closed on invalid protocol input %j", async bytes => {
    const f = fixture();
    const rpc = new AppServerRpc({ spawnChild: () => f.child });
    closers.push(() => rpc.close());
    const ticket = rpc.request("one", {});
    const rejected = expect(ticket.result).rejects.toBeInstanceOf(AppServerConnectionError);
    f.stdout.write(bytes);
    await rejected;
  });

  it("keeps explicit RPC rejection distinct from an indeterminate timeout", async () => {
    const f = fixture();
    const rpc = new AppServerRpc({ spawnChild: () => f.child, requestTimeoutMs: 20 });
    closers.push(() => rpc.close());
    const rejected = rpc.request("bad", {});
    f.send({ id: rejected.id, error: { code: -32600, message: "no thread" } });
    await expect(rejected.result).rejects.toBeInstanceOf(AppServerRpcError);
    const missing = rpc.request("missing", {});
    await expect(missing.result).rejects.toThrow("response timeout");
    await expect(rpc.request("retry", {}).result).rejects.toBeInstanceOf(AppServerConnectionError);
    expect(f.sent.map(x => x.method)).toEqual(["bad", "missing"]);
  });

  it("ignores unmatched responses without consuming a live waiter", async () => {
    const f = fixture();
    const diagnostics: string[] = [];
    const rpc = new AppServerRpc({ spawnChild: () => f.child, onDiagnostic: d => diagnostics.push(d) });
    closers.push(() => rpc.close());
    const ticket = rpc.request("one", {});
    f.send({ id: ticket.id + 10, result: "unrelated" });
    f.send({ id: ticket.id, result: "correct" });
    expect(await ticket.result).toBe("correct");
    expect(diagnostics).toEqual(["Unmatched app-server response ignored"]);
  });

  it.each([
    [], { id: null, method: "approval", params: {} },
    { method: "notification", params: null }, { id: "unexpected", result: 1 },
    { id: 1, error: { code: "bad", message: "bad" } },
  ])("rejects malformed RPC envelopes %j", async message => {
    const f = fixture();
    const rpc = new AppServerRpc({ spawnChild: () => f.child });
    closers.push(() => rpc.close());
    const ticket = rpc.request("one", {});
    const rejected = expect(ticket.result).rejects.toThrow("Invalid or interrupted");
    f.send(message);
    await rejected;
  });

  it("terminates only its owned child when graceful shutdown times out", async () => {
    const f = fixture();
    f.stdin.removeAllListeners("finish");
    const rpc = new AppServerRpc({ spawnChild: () => f.child, shutdownTimeoutMs: 10 });
    closers.push(() => rpc.close());
    await rpc.close();
    expect(f.child.kill).toHaveBeenCalledWith("SIGKILL");
    await rpc.close();
    expect(f.child.kill).toHaveBeenCalledTimes(1);
  });

  it("reports spawn failure and bounds retained stderr", async () => {
    const f = fixture();
    const rpc = new AppServerRpc({ spawnChild: () => f.child });
    closers.push(() => rpc.close());
    f.stderr.write("x".repeat(20_000));
    expect(rpc.stderrTail).toHaveLength(16_384);
    const ticket = rpc.request("one", {});
    const rejected = expect(ticket.result).rejects.toThrow("child failed");
    f.child.emit("error", new Error("spawn error"));
    await rejected;
  });
});

describe("app-server turn lifecycle", () => {
  it("buffers notifications before start response, filters other turns, and keeps identities separate", async () => {
    const f = transportFixture();
    expect(await f.transport.startThread()).toBe("thread-1");
    expect(f.transport.version).toBe("0.153.4");
    f.handle(request => {
      f.send(notification("item/completed", "old-turn"));
      f.send(notification("item/completed", "turn-1", "other-thread"));
      f.send(notification("item/completed"));
      f.send(notification("turn/completed"));
      f.respond(request, { turn: { id: "turn-1" } });
    });
    const turn = await f.transport.startTurn({ threadId: "thread-1", hostTurnToken: "host-7", input: "hello", clientUserMessageId: "user-9" });
    expect(turn.identity).toEqual({ threadId: "thread-1", turnId: "turn-1", hostTurnToken: "host-7", requestId: 3, clientUserMessageId: "user-9" });
    expect((await collect(turn.events)).map(x => x.method)).toEqual(["item/completed", "turn/completed"]);
    expect(f.sent.at(-1)).toMatchObject({ params: { approvalPolicy: "never", approvalsReviewer: "user", clientUserMessageId: "user-9" } });
    expect(f.sent[1]?.method).toBe("initialized");
  });

  it("drains buffered terminal after EOF even before turn/start promise resumes", async () => {
    const f = transportFixture();
    await f.transport.startThread();
    f.handle(request => {
      f.send(notification("item/completed"));
      f.send(notification("turn/completed"));
      f.stdout.write(JSON.stringify({ id: request.id, result: { turn: { id: "turn-1" } } }));
      f.exit();
    });
    const turn = await f.transport.startTurn({ threadId: "thread-1", hostTurnToken: "host", input: "hello" });
    await tick();
    expect((await collect(turn.events)).map(x => x.method)).toEqual(["item/completed", "turn/completed"]);
    await expect(f.transport.startTurn({ threadId: "thread-1", hostTurnToken: "next", input: "next" })).rejects.toBeInstanceOf(AppServerConnectionError);
  });

  it("unblocks a turn reader on EOF after delivering prior events", async () => {
    const f = transportFixture();
    await f.transport.startThread();
    f.handle(request => f.respond(request, { turn: { id: "turn-1" } }));
    const turn = await f.transport.startTurn({ threadId: "thread-1", hostTurnToken: "host", input: "hello" });
    f.send(notification("item/completed"));
    f.exit();
    const iterator = turn.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.method).toBe("item/completed");
    await expect(iterator.next()).rejects.toThrow("stdout ended");
  });

  it("rejects overlapping submissions and keeps an abandoned consumer from permitting steering", async () => {
    const f = transportFixture();
    await f.transport.startThread();
    let request: RpcObject | undefined;
    f.handle(r => { request = r; });
    const input = { threadId: "thread-1", hostTurnToken: "host", input: "hello" };
    const first = f.transport.startTurn(input);
    await expect(f.transport.startTurn(input)).rejects.toThrow("active or submitting");
    await tick();
    f.respond(request!, { turn: { id: "turn-1" } });
    const handle = await first;
    await handle.events[Symbol.asyncIterator]().return?.();
    await expect(f.transport.startTurn(input)).rejects.toThrow("active or submitting");
    f.send(notification("turn/completed"));
    await tick();
    f.handle(r => { f.respond(r, { turn: { id: "turn-2" } }); f.send(notification("turn/completed", "turn-2")); });
    const second = await f.transport.startTurn({ ...input, hostTurnToken: "next" });
    expect(second.identity.turnId).toBe("turn-2");
    expect((await collect(second.events))).toHaveLength(1);
    expect(f.sent.filter(r => r.method === "turn/start")).toHaveLength(2);
  });

  it("reserves thread setup across await and pins permissions on resume", async () => {
    const f = transportFixture();
    const opening = f.transport.resumeThread("thread-1");
    await expect(f.transport.startTurn({ threadId: "thread-1", hostTurnToken: "host", input: "hello" })).rejects.toThrow("active or submitting");
    await expect(f.transport.startThread()).rejects.toThrow("active operation");
    expect(await opening).toBe("thread-1");
    expect(f.sent.at(-1)).toMatchObject({ method: "thread/resume", params: { threadId: "thread-1", approvalPolicy: "never", approvalsReviewer: "user" } });
  });

  it("allows a new turn after explicit rejection without restarting or resending", async () => {
    const f = transportFixture();
    await f.transport.startThread();
    f.handle(r => f.send({ id: r.id, error: { code: -32600, message: "rejected" } }));
    await expect(f.transport.startTurn({ threadId: "thread-1", hostTurnToken: "one", input: "bad" })).rejects.toBeInstanceOf(AppServerRpcError);
    f.handle(r => { f.respond(r, { turn: { id: "accepted" } }); f.send(notification("turn/completed", "accepted")); });
    await collect((await f.transport.startTurn({ threadId: "thread-1", hostTurnToken: "two", input: "good" })).events);
    expect(f.sent.filter(r => r.method === "initialize")).toHaveLength(1);
    expect(f.sent.filter(r => r.method === "turn/start")).toHaveLength(2);
  });

  it("fails closed on malformed accepted-turn identity", async () => {
    const f = transportFixture();
    await f.transport.startThread();
    f.handle(r => f.respond(r, { turn: { id: 5 } }));
    const input = { threadId: "thread-1", hostTurnToken: "one", input: "hello" };
    await expect(f.transport.startTurn(input)).rejects.toThrow("Invalid turn/start response");
    await expect(f.transport.startTurn(input)).rejects.toThrow("Invalid turn/start response");
    expect(f.sent.filter(r => r.method === "turn/start")).toHaveLength(1);
  });

  it("closes invalid thread identity without allowing another submission", async () => {
    const f = transportFixture();
    f.handle(r => {
      if (r.method === "initialize") f.respond(r, { userAgent: "kaoiro/0.153.4" });
      if (r.method === "thread/start") f.respond(r, { thread: { id: null } });
    });
    await expect(f.transport.startThread()).rejects.toThrow("Invalid thread/start response");
    await expect(f.transport.startTurn({ threadId: "thread-1", hostTurnToken: "one", input: "hello" })).rejects.toThrow("Invalid thread/start response");
    expect(f.sent.filter(r => r.method === "turn/start")).toHaveLength(0);
  });

  it("supports the serverInfo version shape and closes failed initialization", async () => {
    const f = transportFixture();
    f.handle(r => {
      if (r.method === "initialize") f.respond(r, { serverInfo: { version: "0.154.0" } });
      if (r.method === "thread/start") f.respond(r, { thread: { id: "thread-1" } });
    });
    await f.transport.startThread();
    expect(f.transport.version).toBe("0.154.0");
    const bad = transportFixture();
    bad.handle(r => bad.respond(r, null));
    await expect(bad.transport.startThread()).rejects.toThrow("Invalid initialize response");
    expect(bad.stdin.writableEnded).toBe(true);
  });
});

it("wakes a waiting consumer and rejects concurrent readers", async () => {
  const stream = new AppServerTurnStream();
  const waiting = stream.next();
  await expect(stream.next()).rejects.toThrow("only one consumer");
  stream.push(notification("item/completed"));
  expect((await waiting).value?.method).toBe("item/completed");
  const done = stream.next();
  await stream.return();
  expect((await done).done).toBe(true);
});

const historyConfig = { agent_id: "history", persona: { id: "fuji", name: "Fuji", sprite_set: "fuji" },
  display_name: "Fuji", server_url: "ws://localhost/wrapper" };
const historyNow = () => "2026-09-18T00:00:00Z";
const historyInput = { threadId: "thread-1", hostTurnToken: "host", input: "hello" };

it("reserves the entire history read, rejects turns immediately, and releases the reservation on completion", async () => {
  const f = transportFixture();
  await f.transport.startThread();
  const reads: RpcObject[] = [];
  f.handle(r => { if (r.method === "thread/read") reads.push(r); });
  const history = f.transport.readHistory("thread-1", historyConfig, historyNow);
  await expect(f.transport.startTurn(historyInput)).rejects.toThrow("active or submitting");
  await expect(f.transport.resumeThread("thread-1")).rejects.toThrow("active operation");
  await expect(f.transport.readHistory("thread-1", historyConfig, historyNow)).rejects.toThrow("active operation");
  await tick();
  expect(reads).toHaveLength(1);
  f.respond(reads[0]!, { thread: { id: "thread-1", turns: [] } });
  await tick();
  expect(reads).toHaveLength(2);
  await expect(f.transport.startTurn(historyInput)).rejects.toThrow("active or submitting");
  expect(f.sent.filter(r => r.method === "turn/start")).toEqual([]);
  f.respond(reads[1]!, { thread: { id: "thread-1", turns: [{ id: "old-turn", items: [{ id: "old-item", type: "agentMessage", text: "restored" }] }] } });
  expect(await history).toMatchObject({ coverage: "full", logs: [{ type: "log", payload: { text: "restored" } }] });
  f.handle(r => { f.respond(r, { turn: { id: "turn-1" } }); f.send(notification("turn/completed")); });
  await collect((await f.transport.startTurn(historyInput)).events);
  expect(f.sent.filter(r => r.method === "turn/start")).toHaveLength(1);
});

it("rejects history while a turn or thread setup is active without sending history RPCs", async () => {
  const f = transportFixture();
  const opening = f.transport.startThread();
  await expect(f.transport.readHistory("thread-1", historyConfig, historyNow)).rejects.toThrow("active operation");
  await opening;
  f.handle(r => f.respond(r, { turn: { id: "turn-1" } }));
  const turn = await f.transport.startTurn(historyInput);
  await expect(f.transport.readHistory("thread-1", historyConfig, historyNow)).rejects.toThrow("active operation");
  expect(f.sent.filter(r => r.method === "thread/read")).toEqual([]);
  f.send(notification("turn/completed"));
  await collect(turn.events);
});

it.each(["close", "disconnect"])("releases an outstanding history read on %s and fences later work", async how => {
  const f = transportFixture();
  await f.transport.startThread();
  f.handle(() => {});
  const history = f.transport.readHistory("thread-1", historyConfig, historyNow);
  const rejected = expect(history).rejects.toBeInstanceOf(AppServerConnectionError);
  await tick();
  if (how === "close") await f.transport.close(); else f.exit();
  await rejected;
  await expect(f.transport.readHistory("thread-1", historyConfig, historyNow)).rejects.toBeInstanceOf(AppServerConnectionError);
  await expect(f.transport.startTurn(historyInput)).rejects.toBeInstanceOf(AppServerConnectionError);
});

it("releases history admission after an explicit RPC rejection without retrying it", async () => {
  const f = transportFixture();
  await f.transport.startThread();
  f.handle(r => f.send({ id: r.id, error: { code: -32600, message: "not supported" } }));
  expect(await f.transport.readHistory("thread-1", historyConfig, historyNow)).toMatchObject({ coverage: "incomplete", reason: "rpc_rejected" });
  f.handle(r => f.respond(r, { thread: { id: "thread-1", turns: [] } }));
  expect(await f.transport.readHistory("thread-1", historyConfig, historyNow)).toEqual({ coverage: "full", logs: [] });
  expect(f.sent.filter(r => r.method === "thread/read")).toHaveLength(3);
});

it("defers an early interrupt to the matching identity and waits for terminal after its acknowledgement", async () => {
  const f = transportFixture();
  await f.transport.startThread();
  let start: RpcObject | undefined;
  f.handle(r => {
    if (r.method === "turn/start") start = r;
    if (r.method === "turn/interrupt") f.respond(r, {});
  });
  const onDispatch = vi.fn(identity => {
    expect(identity).toEqual({ threadId: "thread-1", hostTurnToken: "host-a", clientUserMessageId: "client-a" });
    expect(start).toBeUndefined();
  });
  const opening = f.transport.startTurn({ threadId: "thread-1", hostTurnToken: "host-a", clientUserMessageId: "client-a", input: "a", onDispatch });
  const interrupted = f.transport.interrupt("host-a");
  const stale = f.transport.interrupt("stale");
  await tick();
  expect(f.sent.filter(r => r.method === "turn/interrupt")).toEqual([]);
  f.respond(start!, { turn: { id: "actual-turn-a" } });
  const turn = await opening;
  expect(await interrupted).toBe(true);
  expect(await stale).toBe(false);
  expect(await f.transport.interrupt("host-a")).toBe(true);
  expect(f.sent.filter(r => r.method === "turn/interrupt")).toEqual([
    expect.objectContaining({ params: { threadId: "thread-1", turnId: "actual-turn-a" } }),
  ]);
  expect(onDispatch).toHaveBeenCalledTimes(1);
  expect(turn.identity).toEqual({ threadId: "thread-1", turnId: "actual-turn-a", hostTurnToken: "host-a", clientUserMessageId: "client-a", requestId: start!.id });
  await expect(f.transport.startTurn(historyInput)).rejects.toThrow("active or submitting");
  f.send(notification("turn/completed", "actual-turn-a"));
  expect(await collect(turn.events)).toHaveLength(1);
  expect(await f.transport.interrupt("host-a")).toBe(false);
  f.handle(r => { f.respond(r, { turn: { id: "actual-turn-b" } }); });
  const next = await f.transport.startTurn({ ...historyInput, hostTurnToken: "host-b" });
  expect(await f.transport.interrupt("host-a")).toBe(false);
  expect(f.sent.filter(r => r.method === "turn/interrupt")).toHaveLength(1);
  f.send(notification("turn/completed", "actual-turn-b"));
  await collect(next.events);
});

it("does not interrupt a buffered terminal or a rejected submission", async () => {
  const f = transportFixture();
  await f.transport.startThread();
  f.handle(r => { f.send(notification("turn/completed")); f.respond(r, { turn: { id: "turn-1" } }); });
  const opening = f.transport.startTurn(historyInput);
  const interrupted = f.transport.interrupt("host");
  await collect((await opening).events);
  expect(await interrupted).toBe(false);
  f.handle(r => f.send({ id: r.id, error: { code: -32600, message: "rejected" } }));
  const failed = f.transport.startTurn(historyInput);
  const pending = f.transport.interrupt("host");
  await expect(failed).rejects.toBeInstanceOf(AppServerRpcError);
  expect(await pending).toBe(false);
  expect(f.sent.filter(r => r.method === "turn/interrupt")).toEqual([]);
});

it("keeps interrupt failure distinct from terminal and releases pending work on close", async () => {
  const f = transportFixture();
  await f.transport.startThread();
  f.handle(r => {
    if (r.method === "turn/start") f.respond(r, { turn: { id: "turn-1" } });
    if (r.method === "turn/interrupt") f.send({ id: r.id, error: { code: -32600, message: "rejected" } });
  });
  const turn = await f.transport.startTurn(historyInput);
  await expect(f.transport.interrupt("host")).rejects.toBeInstanceOf(AppServerRpcError);
  await expect(f.transport.startTurn(historyInput)).rejects.toThrow("active or submitting");
  await f.transport.close();
  await expect(collect(turn.events)).rejects.toBeInstanceOf(AppServerConnectionError);
  const g = transportFixture();
  await g.transport.startThread();g.handle(() => {});
  const opening = g.transport.startTurn(historyInput);
  const rejected = expect(opening).rejects.toBeInstanceOf(AppServerConnectionError);
  const interrupted = g.transport.interrupt("host");
  await tick();await g.transport.close();await rejected;
  expect(await interrupted).toBe(false);
});

it("resolves settings before dispatch and never submits an unresolved switch", async () => {
  const f = transportFixture();
  await f.transport.startThread();
  let config: RpcObject | undefined;
  f.handle(r => {
    if (r.method === "config/read") config = r;
    if (r.method === "model/list") f.respond(r, { data: [], nextCursor: null });
    if (r.method === "turn/start") { f.respond(r, { turn: { id: "turn-1" } }); f.send(notification("turn/completed")); }
  });
  const onDispatch = vi.fn();
  const settings = { cwd: "/work", model: "target", resetEffort: true,
    permission: { sandbox: "workspace-write" as const, networkAccess: false } };
  const opening = f.transport.startTurn({ ...historyInput, settings, onDispatch });
  await tick();
  expect(onDispatch).not.toHaveBeenCalled();
  await expect(f.transport.startTurn(historyInput)).rejects.toThrow("active or submitting");
  expect(config).toMatchObject({ params: { cwd: "/work" } });
  f.respond(config!, { config: { model_reasoning_effort: "low" } });
  await collect((await opening).events);
  expect(onDispatch).toHaveBeenCalledTimes(1);
  expect(f.sent.find(r => r.method === "turn/start")).toMatchObject({ params: {
    model: "target", effort: "low", cwd: "/work", approvalPolicy: "never", approvalsReviewer: "user",
    sandboxPolicy: { type: "workspaceWrite", networkAccess: false, writableRoots: ["/work"] },
  } });
  const unavailable = f.transport.startTurn({ ...historyInput, settings, onDispatch });
  const rejected = expect(unavailable).rejects.toMatchObject({ reason: "default_effort_unavailable" });
  await tick();f.respond(config!, { config: { model_reasoning_effort: null } });await rejected;
  expect(onDispatch).toHaveBeenCalledTimes(1);
  expect(f.sent.filter(r => r.method === "turn/start")).toHaveLength(1);
  await collect((await f.transport.startTurn(historyInput)).events);
});

it("honors a synchronous dispatch veto and a close during default resolution", async () => {
  const f = transportFixture();await f.transport.startThread();
  await expect(f.transport.startTurn({ ...historyInput, onDispatch: () => { throw new Error("permission changed"); } })).rejects.toThrow("permission changed");
  expect(f.sent.filter(r => r.method === "turn/start")).toEqual([]);
  f.handle(() => {});
  const onDispatch = vi.fn();
  const opening = f.transport.startTurn({ ...historyInput, settings: { model: "x", resetEffort: true }, onDispatch });
  const rejected = expect(opening).rejects.toBeInstanceOf(AppServerConnectionError);
  await tick();await f.transport.close();await rejected;
  expect(onDispatch).not.toHaveBeenCalled();
  expect(f.sent.filter(r => r.method === "turn/start")).toEqual([]);
});

it("does not dispatch when close wins the settings preparation microtask", async () => {
  const f = transportFixture();await f.transport.startThread();
  const onDispatch = vi.fn();
  const opening = f.transport.startTurn({ ...historyInput, onDispatch });
  const rejected = expect(opening).rejects.toBeInstanceOf(AppServerConnectionError);
  const closing = Promise.resolve().then(() => f.transport.close());
  await rejected;await closing;
  expect(onDispatch).not.toHaveBeenCalled();
  expect(f.sent.filter(r => r.method === "turn/start")).toEqual([]);
});
