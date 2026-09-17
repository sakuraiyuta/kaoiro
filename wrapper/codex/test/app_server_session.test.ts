import { EventEmitter, once } from "node:events";
import { createConnection } from "node:net";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { access, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AppServerSession } from "../src/app_server_session.js";
import { ToolHost } from "../src/toolhost.js";
import { BRIDGE_TOOL_TIMEOUT_SEC } from "../src/host.js";

const sessions: AppServerSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(s => s.close()));
  // Keep the real socket fixtures disposable even when cleanup is mutated.
  if (vi.isMockFunction(ToolHost.listen)) {
    for (const result of vi.mocked(ToolHost.listen).mock.results) {
      if (result.type !== "return") continue;
      const host = await result.value;
      host.close();
      await rm(dirname(host.socketPath), { recursive: true, force: true });
    }
  }
  vi.restoreAllMocks();
});
function childFixture(closeDelayMs = 0, openDelayMs = 0) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough(), stderr = new PassThrough();
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  let fail = false;
  const ignored = new Set<string>();
  const stdin = new Writable({ write(chunk: Buffer, _encoding, cb) {
    const request = JSON.parse(chunk.toString()); sent.push(request);
    if (request.id !== undefined && !ignored.has(request.method)) {
      const reply = () => stdout.write(JSON.stringify(fail ? { id: request.id, error: { code: -1, message: "fixture failure" } } : {
        id: request.id, result: request.method === "initialize" ? { userAgent: "kaoiro/test" }
          : request.method === "account/rateLimits/read" ? { rateLimits: { limitId: "codex", primary: { usedPercent: 25, windowDurationMins: 300 } } }
          : request.method === "turn/start" ? { turn: { id: "turn" } } : { thread: { id: "thread" } },
      }) + "\n");
      if (openDelayMs && (request.method === "thread/start" || request.method === "thread/resume")) setTimeout(reply, openDelayMs);
      else reply();
    }
    cb();
  } });
  Object.assign(child, { stdin, stdout, stderr, exitCode: null, signalCode: null });
  const finish = () => { stdout.end(); stderr.end(); child.emit("close", 0); };
  stdin.on("finish", () => {
    if (closeDelayMs === 0) finish();
    else setTimeout(finish, closeDelayMs);
  });
  return { child, sent, fail() { fail = true; }, ignore(method: string) { ignored.add(method); } };
}
const tool = { name: "probe", description: "probe", inputSchema: { type: "object" }, handler: async () => ({ content: [] }) };

it.each([undefined, false, true])("uses exec-equivalent bridge settings and explicit multi_agent=%s", async internalSubagents => {
  const fixture = childFixture();
  const listen = vi.spyOn(ToolHost, "listen");
  const controller = new AbortController();
  const session = await AppServerSession.create({
    thread: { developerInstructions: "persona", sandbox: "read-only", cwd: "/tmp" },
    ...(internalSubagents === undefined ? {} : { internalSubagents }),
    tools: [tool], turnSignal: () => controller.signal, bridgeStderrPath: "/tmp/bridge.stderr.log",
    transport: { spawnChild: () => fixture.child },
  }); sessions.push(session);
  expect(await session.resumeThread("thread")).toBe("thread");
  expect(fixture.sent.filter(r => r.method === "account/rateLimits/read")).toHaveLength(1);
  expect(session.rateLimits).toEqual({ readStatus: "available", buckets: [
    { limitId: "codex", windows: { five_hour: { utilization: 0.25 } } },
  ] });
  const params = fixture.sent.find(r => r.method === "thread/resume")!.params;
  expect(params).toMatchObject({ developerInstructions: "persona", sandbox: "read-only", cwd: "/tmp", approvalPolicy: "never", approvalsReviewer: "user" });
  const config = params.config as { features: unknown; mcp_servers: { kaoiro: { command: string; args: string[]; env: Record<string, string>; tool_timeout_sec: number; default_tools_approval_mode: string } } };
  expect(config.features).toEqual({ multi_agent: internalSubagents ?? true });
  const bridge = config.mcp_servers.kaoiro;
  expect(bridge.command).toBe(process.execPath);
  expect(bridge.args[0]).toMatch(/\/dist\/bridge\.js$/);
  expect(bridge.tool_timeout_sec).toBe(BRIDGE_TOOL_TIMEOUT_SEC);
  expect(bridge.default_tools_approval_mode).toBe("approve");
  expect(bridge).toMatchObject({ required: true, startup_timeout_sec: 30 });
  expect(bridge.env.KAOIRO_BRIDGE_STDERR_PATH).toBe("/tmp/bridge.stderr.log");
  const host = await listen.mock.results[0]!.value as ToolHost;
  expect(bridge.env.KAOIRO_BRIDGE_SOCKET).toBe(host.socketPath);
  expect((await stat(dirname(host.socketPath))).mode & 0o777).toBe(0o700);
  expect((await stat(host.socketPath)).isSocket()).toBe(true);
  expect(listen.mock.calls[0]![1]!.turnSignal!()).toBe(controller.signal);
  await expect(session.startThread()).rejects.toThrow("already opening or bound");
  await expect(session.startTurn({ threadId: "foreign", hostTurnToken: "x", input: "hello" })).rejects.toThrow("does not match");
  await session.close(); await session.close();
  await expect(access(dirname(host.socketPath))).rejects.toThrow();
  await expect(session.startThread()).rejects.toThrow("closed");
  await expect(session.startTurn({ threadId: "thread", hostTurnToken: "x", input: "hello" })).rejects.toThrow("closed");
});

it("omits MCP for no descriptors and fences concurrent setup and premature turns", async () => {
  const fixture = childFixture(); const listen = vi.spyOn(ToolHost, "listen");
  const session = await AppServerSession.create({ turnSignal: () => null, transport: { spawnChild: () => fixture.child } }); sessions.push(session);
  await expect(session.startTurn({ threadId: "thread", hostTurnToken: "x", input: "hello" })).rejects.toThrow("not ready");
  const first = session.startThread();
  void first.catch(() => {});
  await expect(session.resumeThread("thread")).rejects.toThrow("already opening or bound");
  await expect(first).resolves.toBe("thread");
  expect(listen).not.toHaveBeenCalled();
  expect(fixture.sent.find(r => r.method === "thread/start")!.params.config).toEqual({ features: { multi_agent: true } });
});

it.each(["construction", "initialization"])("releases the real private socket on %s failure", async mode => {
  const fixture = childFixture(); const listen = vi.spyOn(ToolHost, "listen");
  const options = { tools: [tool], turnSignal: () => null, transport: { spawnChild: () => {
    if (mode === "construction") throw new Error("spawn failed");
    return fixture.child;
  } } };
  if (mode === "construction") await expect(AppServerSession.create(options)).rejects.toThrow("spawn failed");
  else {
    const session = await AppServerSession.create(options); sessions.push(session); fixture.fail();
    await expect(session.startThread()).rejects.toThrow("fixture failure");
  }
  const host = await listen.mock.results[0]!.value as ToolHost;
  await expect(access(dirname(host.socketPath))).rejects.toThrow();
});

it("rejects new tool connections as soon as close starts and waits for child exit", async () => {
  const fixture = childFixture(300);
  const listen = vi.spyOn(ToolHost, "listen");
  let childClosed = false, calls = 0;
  fixture.child.once("close", () => { childClosed = true; });
  const session = await AppServerSession.create({
    tools: [{ ...tool, handler: async () => { calls += 1; return { content: [] }; } }],
    turnSignal: () => new AbortController().signal,
    transport: { spawnChild: () => fixture.child },
  }); sessions.push(session);
  await session.startThread();
  const host = await listen.mock.results[0]!.value as ToolHost;
  const closing = session.close();
  expect(session.close()).toBe(closing);
  expect(childClosed).toBe(false);
  const socket = createConnection(host.socketPath);
  socket.once("connect", () => socket.write(JSON.stringify({ id: 1, method: "call_tool", name: "probe", input: {} }) + "\n"));
  try {
    await expect(once(socket, "connect")).rejects.toThrow();
    await closing;
    expect(childClosed).toBe(true);
    expect(calls).toBe(0);
    await expect(access(dirname(host.socketPath))).rejects.toThrow();
  } finally {
    socket.destroy();
    await closing;
  }
});

it("aborts an active tool handler synchronously before waiting for child exit", async () => {
  const fixture = childFixture(300);
  const listen = vi.spyOn(ToolHost, "listen");
  let childClosed = false;
  fixture.child.once("close", () => { childClosed = true; });
  let enter!: (signal: AbortSignal) => void;
  const entered = new Promise<AbortSignal>(resolve => { enter = resolve; });
  const session = await AppServerSession.create({
    tools: [{ ...tool, handler: async (_input, context) => {
      const signal = context!.signal!;
      enter(signal);
      return new Promise(resolve => signal.addEventListener("abort", () => resolve({ content: [] }), { once: true }));
    } }],
    turnSignal: () => new AbortController().signal,
    transport: { spawnChild: () => fixture.child },
  }); sessions.push(session);
  await session.startThread();
  const host = await listen.mock.results[0]!.value as ToolHost;
  const socket = createConnection(host.socketPath);
  const disconnected = once(socket, "close");
  try {
    await once(socket, "connect");
    socket.write(JSON.stringify({ id: 1, method: "call_tool", name: "probe", input: {} }) + "\n");
    const signal = await entered;
    expect(signal.aborted).toBe(false);
    const closing = session.close();
    expect(signal.aborted).toBe(true);
    expect(childClosed).toBe(false);
    await disconnected;
    await closing;
    expect(childClosed).toBe(true);
  } finally {
    socket.destroy();
    await session.close();
  }
});


it.each(["start", "resume"])("waits for required MCP during %s and permits a response after 30 seconds", async mode => {
  const fixture = childFixture(0, 31_000);
  const session = await AppServerSession.create({ tools: [tool], turnSignal: () => null,
    transport: { spawnChild: () => fixture.child } }); sessions.push(session);
  vi.useFakeTimers();
  try {
    const opening = mode === "start" ? session.startThread() : session.resumeThread("thread");
    const ready = expect(opening).resolves.toBe("thread");
    void ready.catch(() => {});
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(session.startTurn({ threadId: "thread", hostTurnToken: "early", input: "hello" })).rejects.toThrow("not ready");
    expect(fixture.sent.filter(r => r.method === "turn/start")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    await ready;
    await session.startTurn({ threadId: "thread", hostTurnToken: "ready", input: "hello" });
    expect(fixture.sent.filter(r => r.method === "turn/start")).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});

it.each([
  ["thread/start", true, undefined, 35_000],
  ["thread/resume", true, undefined, 35_000],
  ["thread/start", false, undefined, 25_000],
  ["thread/start", true, 200, 200],
  ["initialize", true, undefined, 25_000],
  ["account/rateLimits/read", true, undefined, 25_000],
  ["turn/start", true, undefined, 25_000],
] as const)("bounds %s (MCP=%s, override=%s) at %s ms", async (method, withTools, override, timeout) => {
  const fixture = childFixture(); fixture.ignore(method);
  const session = await AppServerSession.create({ ...(withTools ? { tools: [tool] } : {}), turnSignal: () => null,
    transport: { spawnChild: () => fixture.child, ...(override === undefined ? {} : { requestTimeoutMs: override }) } });
  sessions.push(session);
  vi.useFakeTimers();
  try {
    if (method === "turn/start") await session.startThread();
    const operation = method === "turn/start"
      ? session.startTurn({ threadId: "thread", hostTurnToken: "timeout", input: "hello" })
      : method === "thread/resume" ? session.resumeThread("thread") : session.startThread();
    let settled = false;
    void operation.then(() => { settled = true; }, () => { settled = true; });
    const failure = expect(operation).rejects.toThrow(`App-server response timeout: ${method}`);
    void failure.catch(() => {});
    await vi.advanceTimersByTimeAsync(timeout - 1);
    expect(settled).toBe(false);
    expect(fixture.child.stdin.writableEnded).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.child.stdin.writableEnded).toBe(true);
    await failure;
    if (method !== "turn/start") {
      expect(fixture.sent.filter(r => r.method === "turn/start")).toHaveLength(0);
      await expect(session.startTurn({ threadId: "thread", hostTurnToken: "after", input: "hello" })).rejects.toThrow("closed");
    }
  } finally { vi.useRealTimers(); }
});
