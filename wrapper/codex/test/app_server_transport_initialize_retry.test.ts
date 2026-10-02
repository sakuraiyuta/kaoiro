import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppServerConnectionError, AppServerRpcError, type AppServerNotification, type RpcObject } from "../src/app_server_rpc.js";
import * as rpcModule from "../src/app_server_rpc.js";
import type { AppServerRpcOptions } from "../src/app_server_rpc.js";
import type { AppServerContextEvent } from "../src/app_server_context.js";
import { AppServerTransport } from "../src/app_server_transport.js";

const SIGNATURE = "Error: failed to initialize sqlite state runtime under /scratch/codex-home: failed to initialize state runtime at /scratch/codex-home";
const historyConfig = { agent_id: "history", persona: { id: "fuji", name: "Fuji", sprite_set: "fuji" },
  display_name: "Fuji", server_url: "ws://localhost/wrapper" };
const historyNow = () => "2026-09-18T00:00:00Z";

interface FakeChild {
  child: ChildProcessWithoutNullStreams;
  sent: RpcObject[];
  respond(request: RpcObject, result: unknown): void;
  send(value: unknown): void;
  /** Writes to the child's stderr without ending anything. */
  printError(text: string): void;
  /** stdout ends first; the stderr text and `close` follow after `lateMs`. */
  fail(stderr: string, lateMs?: number): void;
  exit(): void;
}
type Script = (child: FakeChild, request: RpcObject) => void;

function fakeChild(script: Script | undefined, options: { lingers?: boolean } = {}): FakeChild {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const sent: RpcObject[] = [];
  const fake: FakeChild = {
    child, sent,
    send: value => { stdout.write(JSON.stringify(value) + "\n"); },
    respond: (request, result) => fake.send({ id: request.id, result }),
    printError: text => { stderr.write(text + "\n"); },
    fail(text, lateMs = 0) {
      Object.assign(child, { exitCode: 1 });
      stdout.end();
      setTimeout(() => {
        if (text) stderr.write(text + "\n");
        stderr.end();
        child.emit("close", 1, null);
      }, lateMs);
    },
    exit() {
      if (child.exitCode !== null) return;
      Object.assign(child, { exitCode: 0 });
      stdout.end();
      stderr.end();
      queueMicrotask(() => child.emit("close", 0, null));
    },
  };
  const stdin = new Writable({ write(chunk: Buffer, _encoding, callback) {
    const request = JSON.parse(chunk.toString()) as RpcObject;
    sent.push(request);
    if (typeof request.method === "string" && request.id !== undefined) script?.(fake, request);
    callback();
  } });
  Object.assign(child, { stdout, stderr, stdin, exitCode: null, signalCode: null });
  if (!options.lingers) stdin.on("finish", fake.exit);
  child.kill = vi.fn(() => { fake.exit(); return true; });
  return fake;
}

const okScript: Script = (child, request) => {
  if (request.method === "initialize") child.respond(request, { userAgent: "kaoiro/0.156.1 (test)" });
  if (request.method === "thread/start") child.respond(request, { thread: { id: "thread-1" } });
  if (request.method === "thread/read") child.respond(request, { thread: { id: "thread-1", turns: [] } });
  if (request.method === "turn/start") {
    child.respond(request, { turn: { id: "turn-1" } });
    child.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
  }
};
const failsWithSignature: Script = (child, request) => {
  if (request.method === "initialize") child.fail(SIGNATURE);
};

function harness(scripts: Script[], options: { requestTimeoutMs?: number; lingers?: boolean } = {}) {
  const children: FakeChild[] = [];
  const diagnostics: string[] = [];
  const disconnects: Error[] = [];
  const transport = new AppServerTransport({
    spawnChild: () => {
      const child = fakeChild(scripts[Math.min(children.length, scripts.length - 1)], { lingers: options.lingers ?? false });
      children.push(child);
      return child.child;
    },
    requestTimeoutMs: options.requestTimeoutMs ?? 1000,
    shutdownTimeoutMs: 50,
    onDiagnostic: message => diagnostics.push(message),
    onDisconnect: error => disconnects.push(error),
  });
  closers.push(() => transport.close());
  return { transport, children, diagnostics, disconnects };
}

const closers: (() => Promise<void>)[] = [];
beforeEach(() => {
  // The minimum of each delay range keeps the retries fast and deterministic.
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()));
  vi.restoreAllMocks();
});

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

describe("initialize retry on an sqlite state initialization failure", () => {
  it("retries after the child has closed, when its stderr arrives after stdout ended", async () => {
    const f = harness([(child, request) => { if (request.method === "initialize") child.fail(SIGNATURE, 25); }, okScript]);
    await f.transport.startThread();
    expect(f.children).toHaveLength(2);
    expect(f.children[1]!.sent.map(r => r.method)).toEqual(["initialize", "initialized", "thread/start"]);
    expect(f.transport.version).toBe("0.156.1");
    expect(f.diagnostics).toHaveLength(1);
    expect(f.diagnostics[0]).toContain("attempt 1/3");
    expect(f.diagnostics[0]).toContain("retrying in 100 ms");
    expect(f.diagnostics[0]).toContain("failed to initialize sqlite state runtime under /scratch/codex-home");
    expect(f.disconnects).toEqual([]);
  });

  it("stays usable after recovery: history, then a turn behind beforeDispatch", async () => {
    const f = harness([failsWithSignature, okScript]);
    await f.transport.startThread();
    expect(await f.transport.readHistory("thread-1", historyConfig, historyNow)).toEqual({ coverage: "full", logs: [] });
    const dispatched: string[] = [];
    const turn = await f.transport.startTurn({
      threadId: "thread-1", hostTurnToken: "host", input: "hello",
      beforeDispatch: async () => { dispatched.push("before"); },
      onDispatch: () => { dispatched.push("dispatch"); },
    });
    const events: AppServerNotification[] = [];
    for await (const event of turn.events) events.push(event);
    expect(dispatched).toEqual(["before", "dispatch"]);
    expect(events.map(e => e.method)).toEqual(["turn/completed"]);
    expect(f.children[1]!.sent.filter(r => r.method === "turn/start")).toHaveLength(1);
    expect(f.children[0]!.sent.map(r => r.method)).toEqual(["initialize"]);
    expect(f.disconnects).toEqual([]);
  });

  it("does not retry without the signature", async () => {
    const f = harness([(child, request) => { if (request.method === "initialize") child.fail("some other error"); }, okScript]);
    const error = await rejection(f.transport.startThread());
    expect(error).toBeInstanceOf(AppServerConnectionError);
    expect(error.message).not.toContain("attempt");
    expect(f.children).toHaveLength(1);
    expect(f.diagnostics).toEqual([]);
    expect(f.disconnects).toHaveLength(1);
  });

  it("stops after three attempts and reports the attempt count and the signature line", async () => {
    const f = harness([failsWithSignature]);
    const error = await rejection(f.transport.startThread());
    expect(f.children).toHaveLength(3);
    expect(error).toBeInstanceOf(AppServerConnectionError);
    expect(error.message).toContain("initialize attempt 3/3");
    expect(error.message).toContain("failed to initialize sqlite state runtime under /scratch/codex-home");
    expect(f.diagnostics).toHaveLength(2);
    expect(f.diagnostics[1]).toContain("retrying in 400 ms");
    expect(f.disconnects).toEqual([error]);
    expect(f.transport.stderrTail).toContain("failed to initialize sqlite state runtime");
    await expect(f.transport.readHistory("thread-1", historyConfig, historyNow)).rejects.toBe(error);
  });

  it("counts a child that fails between its initialize reply and the handshake continuing as a failed attempt", async () => {
    // The rpc asks for the next stdout chunk synchronously after routing the
    // reply, before the handshake's continuation runs. Failing the child in
    // that call puts the failure in the window just before promotion.
    let spawned = 0;
    const diagnostics: string[] = [];
    const disconnects: Error[] = [];
    const transport = new AppServerTransport({
      spawnChild: () => {
        spawned += 1;
        if (spawned > 1) return fakeChild(okScript).child;
        let deliver!: (chunk: Buffer) => void;
        const reply = new Promise<Buffer>(resolve => { deliver = resolve; });
        const fake = fakeChild((child, request) => {
          if (request.method !== "initialize") return;
          child.printError(SIGNATURE);
          deliver(Buffer.from(JSON.stringify({ id: request.id, result: { userAgent: "kaoiro/0.156.1 (test)" } }) + "\n"));
        });
        let pulls = 0;
        Object.assign(fake.child, { stdout: { [Symbol.asyncIterator]: () => ({
          next: () => {
            pulls += 1;
            if (pulls === 1) return reply.then(value => ({ done: false, value }));
            fake.child.emit("error", new Error("child died"));
            return new Promise<never>(() => {});
          },
          return: async () => ({ done: true, value: undefined }),
        }) } });
        return fake.child;
      },
      requestTimeoutMs: 1000, shutdownTimeoutMs: 50,
      onDiagnostic: message => diagnostics.push(message),
      onDisconnect: error => disconnects.push(error),
    });
    closers.push(() => transport.close());
    await transport.startThread();
    expect(spawned).toBe(2);
    expect(diagnostics).toHaveLength(1);
    expect(disconnects).toEqual([]);
    expect(await transport.readHistory("thread-1", historyConfig, historyNow)).toEqual({ coverage: "full", logs: [] });
  });

  it("does not retry a signature that appears after initialize succeeded", async () => {
    const f = harness([(child, request) => {
      if (request.method === "initialize") child.respond(request, { userAgent: "kaoiro/0.156.1 (test)" });
      if (request.method === "thread/start") child.fail(SIGNATURE);
    }, okScript]);
    const error = await rejection(f.transport.startThread());
    expect(error).toBeInstanceOf(AppServerConnectionError);
    expect(f.children).toHaveLength(1);
    expect(f.diagnostics).toEqual([]);
  });

  it("cancels the wait and spawns nothing when closed during the backoff", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const f = harness([failsWithSignature, okScript]);
    const started = Date.now();
    const pending = rejection(f.transport.startThread());
    while (f.diagnostics.length === 0) await new Promise<void>(resolve => setTimeout(resolve, 5));
    await f.transport.close();
    const error = await pending;
    expect(error.message).toContain("closed");
    // The wait would otherwise last the full 400 ms.
    expect(Date.now() - started).toBeLessThan(300);
    expect(f.children).toHaveLength(1);
    expect(f.disconnects).toEqual([]);
  });

  it("does not retry when closing was requested before the failure was judged", async () => {
    const f = harness([(child, request) => {
      if (request.method === "initialize") child.printError(SIGNATURE);
    }, okScript]);
    const pending = rejection(f.transport.startThread());
    await new Promise<void>(resolve => setTimeout(resolve, 5));
    await f.transport.close();
    const error = await pending;
    expect(error.message).toContain("closed");
    await new Promise<void>(resolve => setTimeout(resolve, 60));
    expect(f.children).toHaveLength(1);
    expect(f.diagnostics).toEqual([]);
    expect(f.disconnects).toEqual([]);
  });

  it("does not retry a child that never answers initialize", async () => {
    const f = harness([() => {}, okScript], { requestTimeoutMs: 100 });
    const error = await rejection(f.transport.startThread());
    expect(error).toBeInstanceOf(AppServerConnectionError);
    expect((error as AppServerConnectionError).kind).toBe("timeout");
    expect(f.children).toHaveLength(1);
    expect(f.diagnostics).toEqual([]);
  });

  it("does not retry a JSON-RPC error reply to initialize, even with the signature on stderr", async () => {
    const f = harness([(child, request) => {
      if (request.method === "initialize") {
        child.printError(SIGNATURE);
        child.send({ id: request.id, error: { code: -32600, message: "not initialized" } });
      }
    }, okScript]);
    const error = await rejection(f.transport.startThread());
    expect(error).toBeInstanceOf(AppServerRpcError);
    expect(f.children).toHaveLength(1);
    expect(f.diagnostics).toEqual([]);
    // The rpc did not fail by itself: our own close() is not a disconnect.
    expect(f.disconnects).toEqual([]);
  });

  it("does not retry a timed-out attempt whose child printed the signature but never exits", async () => {
    const f = harness([(child, request) => {
      if (request.method === "initialize") child.printError(SIGNATURE);
    }, okScript], { requestTimeoutMs: 100, lingers: true });
    const error = await rejection(f.transport.startThread());
    expect(error).toBeInstanceOf(AppServerConnectionError);
    expect((error as AppServerConnectionError).kind).toBe("timeout");
    expect(f.children).toHaveLength(1);
    expect(f.diagnostics).toEqual([]);
  });

  it("reports a spawn failure during a retry as the initialize failure", async () => {
    let spawned = 0;
    const transport = new AppServerTransport({
      spawnChild: () => {
        spawned += 1;
        if (spawned > 1) throw new Error("spawn EAGAIN");
        return fakeChild(failsWithSignature).child;
      },
      requestTimeoutMs: 1000,
    });
    closers.push(() => transport.close());
    await expect(transport.startThread()).rejects.toThrow("spawn EAGAIN");
    await expect(transport.readHistory("thread-1", historyConfig, historyNow)).rejects.toThrow("spawn EAGAIN");
    expect(transport.steer({ hostTurnToken: "host", input: "x", clientUserMessageId: "u", admit: () => null }))
      .toEqual({ kind: "refused", reason: "closed" });
  });
});

it("rejects context callbacks from a replaced RPC child and from the closed transport", async () => {
  const callbacks: NonNullable<AppServerRpcOptions["onNotification"]>[] = [];
  const ActualRpc = rpcModule.AppServerRpc;
  vi.spyOn(rpcModule, "AppServerRpc").mockImplementation(function (options?: AppServerRpcOptions) {
    callbacks.push(options!.onNotification!);return new ActualRpc(options);
  });
  let spawned = 0;const events: AppServerContextEvent[] = [];
  const transport = new AppServerTransport({ spawnChild: () => fakeChild(spawned++ === 0 ? failsWithSignature : okScript).child,
    shutdownTimeoutMs: 50, onContext: event => events.push(event) });closers.push(() => transport.close());
  await transport.startThread();expect(callbacks).toHaveLength(2);
  const compaction = (itemId: string): AppServerNotification => ({ method: "item/started", params: {
    threadId: "thread-1", turnId: "manual", item: { id: itemId, type: "contextCompaction" } } });
  callbacks[0]!(compaction("stale"));expect(events).toHaveLength(1);
  callbacks[1]!(compaction("current"));expect(events).toHaveLength(2);expect(events[1]).toMatchObject({ kind: "compaction", itemId: "current" });
  await transport.close();callbacks[1]!(compaction("closed"));expect(events).toHaveLength(2);
});
