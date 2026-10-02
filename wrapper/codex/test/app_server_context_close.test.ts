import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { expect, it, vi } from "vitest";
import { AppServerRpc } from "../src/app_server_rpc.js";
import { AppServerTransport } from "../src/app_server_transport.js";
import type { AppServerContextEvent } from "../src/app_server_context.js";

it.each([
  { initialize: true, threadId: "thread" },
  { initialize: false, threadId: undefined },
  { initialize: false, threadId: "thread" },
])("rejects post-EOF context from a real child (initialized=$initialize, threadId=$threadId)", async ({ initialize, threadId }) => {
  // IPC holds exit until the parent observes the post-EOF bytes, avoiding an exit/read race.
  const child = spawn(process.execPath, ["-e", `
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    const requests = [];
    const threadParams = afterEof => afterEof ? ${JSON.stringify(threadId === undefined ? {} : { threadId })} : { threadId: 'thread' };
    const counts = { inputTokens: 10, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 11 };
    const response = afterEof => send({ method: 'item/completed', params: { ...threadParams(afterEof), turnId: 'turn', afterEof,
      item: { id: afterEof ? 'late-response' : 'response', type: 'agentMessage' } } });
    const usage = afterEof => send({ method: 'thread/tokenUsage/updated', params: { ...threadParams(afterEof), turnId: 'turn', afterEof,
      tokenUsage: { last: counts, total: counts, modelContextWindow: 100 } } });
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      requests.push(request.method);
      if (request.method === 'initialize') send({ id: request.id, result: { userAgent: 'context-close-test/1' } });
      if (request.method === 'thread/start') send({ id: request.id, result: { thread: { id: 'thread' } } });
      if (request.method === 'turn/start') {
        send({ id: request.id, result: { turn: { id: 'turn' } } });response(false);usage(false);
      }
    }).on('close', () => {
      send({ method: 'item/started', params: { ...threadParams(true), turnId: 'manual', afterEof: true, requests,
        item: { id: 'late-compaction', type: 'contextCompaction' } } });response(true);usage(true);
    });
    process.on('message', message => { if (message === 'exit') process.exit(0); });
  `], { stdio: ["pipe", "pipe", "pipe", "ipc"] }) as ChildProcessWithoutNullStreams;
  const order: string[] = [];
  const closed = new Promise<void>(resolve => child.once("close", () => { order.push("child-close");resolve(); }));
  const events: AppServerContextEvent[] = [];
  let buffered = "", lateNotifications = 0, lateExitCode: number | null | undefined;
  let lateRequests: unknown;
  child.stdout.on("data", (chunk: Buffer) => {
    buffered += chunk.toString();
    let newline: number;
    while ((newline = buffered.indexOf("\n")) !== -1) {
      const message = JSON.parse(buffered.slice(0, newline));buffered = buffered.slice(newline + 1);
      if (message.params?.afterEof === true) lateNotifications++;
      if (message.params?.requests !== undefined) lateRequests = message.params.requests;
    }
    if (lateNotifications === 3) {
      lateExitCode = child.exitCode;order.push("post-eof-notifications");child.send("exit");
    }
  });
  const actualClose = AppServerRpc.prototype.close;
  const closing = vi.spyOn(AppServerRpc.prototype, "close").mockImplementation(function (this: AppServerRpc) {
    const completion = actualClose.call(this);
    expect(this.failed).toBe(true);expect(child.exitCode).toBeNull();order.push("rpc-retired");
    return completion;
  });
  const transport = new AppServerTransport({ spawnChild: () => child, requestTimeoutMs: 2000,
    shutdownTimeoutMs: 2000, onContext: event => events.push(event) });
  try {
    const expected = initialize ? ["bound", "response", "usage"] : [];
    if (initialize) {
      const boundThreadId = await transport.startThread();
      await transport.startTurn({ threadId: boundThreadId, hostTurnToken: "host", input: "hello" });
      await vi.waitFor(() => expect(events.map(event => event.kind)).toEqual(expected));
    }
    const completion = transport.close();order.push("close-returned");
    await completion;await closed;
    expect(lateNotifications).toBe(3);expect(lateExitCode).toBeNull();
    expect(lateRequests).toEqual(initialize ? ["initialize", "initialized", "thread/start", "turn/start"] : []);
    expect(order).toEqual(["rpc-retired", "close-returned", "post-eof-notifications", "child-close"]);
    expect(events.map(event => event.kind)).toEqual(expected);
  } finally {
    closing.mockRestore();await transport.close();await closed;
  }
}, 10_000);
