import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { vi } from "vitest";
import { PermissionBroker, type PendingPermissionExt, type WrapperConfig } from "@kaoiro/agent-common";
import type { RpcObject } from "../src/app_server_rpc.js";
import { AppServerTransport, type AppServerForeignTurn } from "../src/app_server_transport.js";
import type { ApprovalPolicy, ApprovalTransition } from "../src/app_server_approval.js";

// A fake app-server child driven line by line, a real AppServerTransport and a
// real PermissionBroker. Shared by the approval transport tests.

export const THREAD = "thread-1";
export const COMMAND = "item/commandExecution/requestApproval";
export const FILE = "item/fileChange/requestApproval";

const config: WrapperConfig = {
  agent_id: "test.approval",
  persona: { id: "kuroe", name: "クロエ", sprite_set: "kuroe" },
  display_name: "クロエ",
  server_url: "ws://localhost:4000/wrapper",
};

export const tick = () => new Promise<void>(resolve => setImmediate(resolve));
export async function settle(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await tick();
}

export function fakeChild() {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const sent: RpcObject[] = [];
  let handle: (message: RpcObject) => void = () => {};
  let ended = false;
  const stdin = new Writable({ write(chunk: Buffer, _encoding, callback) {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      const message = JSON.parse(line) as RpcObject;
      sent.push(message);
      handle(message);
    }
    callback();
  } });
  Object.assign(child, { stdout, stderr, stdin, exitCode: null, signalCode: null });
  const exit = () => {
    if (child.exitCode !== null) return;
    Object.assign(child, { exitCode: 0 });
    child.emit("exit", 0, null);
    if (!ended) { ended = true; stdout.end(); }
    stderr.end();
    queueMicrotask(() => child.emit("close", 0, null));
  };
  stdin.on("finish", exit);
  child.kill = vi.fn(() => { exit(); return true; });
  return {
    child, sent,
    get ended() { return ended; },
    /** A real child cannot write after EOF. */
    send(value: unknown) { if (!ended) stdout.write(JSON.stringify(value) + "\n"); },
    eof() { if (!ended) { ended = true; stdout.end(); } },
    handle(fn: (message: RpcObject) => void) { handle = fn; },
    /** Client responses to server requests, in write order. */
    replies(): RpcObject[] { return sent.filter(m => m.method === undefined); },
  };
}

export interface HarnessOptions {
  approvals?: boolean;
  policy?: ApprovalPolicy;
  deadlineMs?: number | null;
  enforceForeignTurn?: boolean;
  maxBeforeResponse?: number;
  maxServerRequestIds?: number;
  onPendingChange?: (slot: PendingPermissionExt | null) => void;
  onTransition?: (transition: ApprovalTransition) => void;
  requestTimeoutMs?: number;
}

export async function harness(options: HarnessOptions = {}) {
  const f = fakeChild();
  const transitions: ApprovalTransition[] = [];
  const slots: Array<PendingPermissionExt | null> = [];
  const foreign: AppServerForeignTurn[] = [];
  let counter = 0;
  const broker = new PermissionBroker({
    config, send: () => {}, newId: () => `req-${++counter}`,
    onPendingChange: slot => { slots.push(slot); options.onPendingChange?.(slot); },
  });
  const transport = new AppServerTransport({
    spawnChild: () => f.child, requestTimeoutMs: options.requestTimeoutMs ?? 1_000_000_000, shutdownTimeoutMs: 10,
    ...(options.maxServerRequestIds === undefined ? {} : { maxServerRequestIds: options.maxServerRequestIds }),
    ...(options.maxBeforeResponse === undefined ? {} : { maxBeforeResponse: options.maxBeforeResponse }),
    enforceForeignTurn: options.enforceForeignTurn ?? false,
    onForeignTurn: turn => foreign.push(turn),
    ...(options.approvals === false ? {} : {
      approvals: {
        decide: (tool, input, signal, opts) => broker.decide(tool, input, signal, opts),
        deadlineMs: options.deadlineMs === undefined ? 1_000 : options.deadlineMs,
        onTransition: t => { transitions.push(t); options.onTransition?.(t); },
      },
    }),
  });
  const turnStarts: RpcObject[] = [];
  f.handle(request => {
    if (request.method === "initialize") f.send({ id: request.id, result: { userAgent: "kaoiro/0.156.1 (test)" } });
    if (request.method === "thread/start" || request.method === "thread/resume") f.send({ id: request.id, result: { thread: { id: THREAD } } });
    if (request.method === "turn/start") turnStarts.push(request);
  });
  await transport.startThread();

  let turn: Promise<unknown> | undefined;
  let turnError: unknown;
  let turnValue: unknown;
  const policy = options.policy ?? "on-request";
  return {
    f, transport, broker, transitions, slots, foreign, turnStarts,
    get turnError() { return turnError; },
    get turnValue() { return turnValue; },
    get turn() { return turn; },
    /** Reserves a turn and waits until its turn/start is on the wire. */
    async reserve(hostTurnToken = "tok", approval: ApprovalPolicy | undefined = policy,
      extra: Partial<Parameters<AppServerTransport["startTurn"]>[0]> = {}) {
      const before = turnStarts.length;
      turnError = undefined;
      turn = transport.startTurn({
        threadId: THREAD, hostTurnToken, input: "x",
        settings: { permission: { sandbox: "workspace-write", networkAccess: false, ...(approval === undefined ? {} : { approval }) } },
        ...extra,
      }).then(value => { turnValue = value; }, error => { turnError = error; });
      for (let i = 0; i < 20 && turnStarts.length === before; i += 1) await tick();
      if (turnStarts.length === before) throw new Error("turn/start was not written");
      return turnStarts.at(-1)!;
    },
    request(id: number | string, turnId = "t1", over: RpcObject = {}, method = COMMAND) {
      f.send({ id, method, params: { threadId: THREAD, turnId, itemId: `item-${id}`, startedAtMs: 1, kind: "command", command: "ls", cwd: "/w", ...over } });
    },
    startNamed(turnId: string) { f.send({ id: turnStarts.at(-1)!.id, result: { turn: { id: turnId } } }); },
    startError() { f.send({ id: turnStarts.at(-1)!.id, error: { code: -32600, message: "rejected" } }); },
    startInvalid() { f.send({ id: turnStarts.at(-1)!.id, result: { nope: true } }); },
    resolved(id: number | string) { f.send({ method: "serverRequest/resolved", params: { threadId: THREAD, requestId: id } }); },
    completed(turnId: string, threadId = THREAD) { f.send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } }); },
    item(turnId: string, method = "item/started", item: RpcObject = { id: "x", type: "agentMessage" }) {
      f.send({ method, params: { threadId: THREAD, turnId, item } });
    },
    /** Resolves every live broker request (unknown ids are ignored). */
    decideAll(allow: boolean) {
      for (let n = 1; n <= counter; n += 1) broker.resolve({ request_id: `req-${n}`, allow });
    },
    decide(requestId: string, allow: boolean) { broker.resolve({ request_id: requestId, allow }); },
    get requestIds(): number { return counter; },
    async finish() {
      await transport.close();
      await turn;
    },
  };
}
