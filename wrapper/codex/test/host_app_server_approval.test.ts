import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionBroker, type Envelope, type WrapperConfig } from "@kaoiro/agent-common";
import { CODEX_APPROVAL_SWITCH_AXES, CodexHost, type CodexHostOptions } from "../src/host.js";
import { AppServerSession } from "../src/app_server_session.js";
import type { RpcObject } from "../src/app_server_rpc.js";

// The host end of app-server approvals (ADR-0064): the dialog rides the one
// ADR-0022 slot, every host abort drops a pending request before anything is
// written, and the axis is advertised only for an opted-in persona.

const config: WrapperConfig = { agent_id: "host-approval", persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P",
  server_url: "ws://unused", model: "gpt-5.6-sol", effort: "high", codex_auth_mode: "chatgpt", codex_chatgpt_plan: "plus" };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); vi.restoreAllMocks(); });

function fixture(options: { approvals?: boolean; overrides?: Partial<CodexHostOptions> } = {}) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough(), stderr = new PassThrough(), sent: RpcObject[] = [];
  let number = 0;
  const send = (value: unknown) => { if (!stdout.writableEnded) stdout.write(JSON.stringify(value) + "\n"); };
  const reply = (request: RpcObject, result: unknown) => send({ id: request.id, result });
  const stdin = new Writable({ write(chunk, _encoding, cb) {
    for (const line of String(chunk).split("\n")) {
      if (!line.trim()) continue;
      const request = JSON.parse(line) as RpcObject;sent.push(request);
      if (request.method === "initialize") reply(request, { userAgent: "test/0.156.1" });
      if (request.method === "thread/start" || request.method === "thread/resume") reply(request, { thread: { id: "thread" }, model: "gpt-5.6-sol", reasoningEffort: "medium" });
      if (request.method === "account/rateLimits/read") send({ id: request.id, error: { code: -32600, message: "no account" } });
      if (request.method === "turn/start") {
        number += 1;
        reply(request, { turn: { id: `turn-${number}` } });
        send({ method: "turn/started", params: { threadId: "thread", turn: { id: `turn-${number}` } } });
      }
      if (request.method === "turn/interrupt") {
        reply(request, {});
        send({ method: "turn/completed", params: { threadId: "thread", turn: { id: `turn-${number}`, status: "interrupted" } } });
      }
    }
    cb();
  } });
  Object.assign(child, { stdin, stdout, stderr, exitCode: null, signalCode: null });
  const exit = () => {
    if (child.exitCode !== null) return;
    Object.assign(child, { exitCode: 0 });child.emit("exit", 0, null);stdout.end();stderr.end();queueMicrotask(() => child.emit("close", 0, null));
  };
  stdin.on("finish", exit);child.kill = vi.fn(() => { exit();return true; });
  const states: Envelope[] = [];
  let host!: CodexHost;
  const broker = new PermissionBroker({ config, send: () => {}, onPendingChange: pending => host?.setPendingPermission(pending) });
  let sessionOptions: Parameters<typeof AppServerSession.create>[0] | undefined;
  const createSession = vi.fn(opts => {
    sessionOptions = opts;
    return AppServerSession.create({ ...opts, transport: { spawnChild: () => child, shutdownTimeoutMs: 100 } });
  });
  host = new CodexHost(config, {
    backend: "app-server", appServerSessionFactory: createSession, appendSystemPrompt: "PERSONA",
    onState: e => states.push(e), onTurnStart: vi.fn(),
    ...(options.approvals === false ? {} : {
      appServerApprovals: {
        decide: (tool, input, signal, opts) => broker.decide(tool, input, signal, opts),
        deadlineMs: null, inactivityLimitMs: 1_800_000,
      },
    }),
    ...options.overrides,
  });
  const running = host.run();cleanup.push(async () => { host.close();await running; });
  const turns = () => sent.filter(r => r.method === "turn/start");
  const replies = (id: number) => sent.filter(r => r.method === undefined && r.id === id);
  const ask = () => send({ id: 7, method: "item/commandExecution/requestApproval", params: {
    threadId: "thread", turnId: `turn-${number}`, itemId: "exec-1", startedAtMs: 1, kind: "command", command: "touch x", cwd: "/w",
  } });
  const lastExt = () => states.at(-1)?.ext as Record<string, unknown> | undefined;
  return { host, broker, sent, states, turns, replies, ask, lastExt, send, sessionOptions: () => sessionOptions, get number() { return number; } };
}

async function pendingApproval(f: ReturnType<typeof fixture>, approval: "on-request" | "never" = "on-request") {
  f.host.setPermissionSyncSupported(true);
  await f.host.setPermission({ revision: 2, requested: { sandbox: "workspace-write", network_access: false, approval } });
  await f.host.send("go", undefined, [], "tok");
  await vi.waitFor(() => expect(f.turns()).toHaveLength(1));
  expect(f.turns()[0]!.params).toMatchObject({ approvalPolicy: approval });
  f.ask();
  if (approval === "never") return;
  await vi.waitFor(() => expect(f.lastExt()?.pending_permission).toMatchObject({ tool_name: "codex:command_execution" }));
  expect(f.states.at(-1)?.state).toBe("waiting_permission");
}

describe("CodexHost app-server approvals", () => {
  it("shows the request in the single slot and writes the operator's accept", async () => {
    const f = fixture();
    await pendingApproval(f);
    const pending = f.lastExt()!.pending_permission as { request_id: string; input: Record<string, unknown> };
    expect(pending.input).toMatchObject({ command: "touch x", inactivity_limit_ms: 1_800_000 });
    f.broker.resolve({ request_id: pending.request_id, allow: true });
    await vi.waitFor(() => expect(f.replies(7)).toEqual([{ id: 7, result: { decision: "accept" } }]));
    expect(f.lastExt()?.pending_permission).toBeUndefined();
  });

  it.each([
    ["operator interrupt", (f: ReturnType<typeof fixture>) => { void f.host.interrupt(); }],
    ["watchdog interrupt", (f: ReturnType<typeof fixture>) => { f.host.requestInterruptForTurn("tok"); }],
    ["watchdog fail-stop", (f: ReturnType<typeof fixture>) => { f.host.failStopTurnForWatchdog("tok"); }],
    ["host close", (f: ReturnType<typeof fixture>) => { f.host.close(); }],
  ])("%s drops the pending request with no write and clears the slot; a late allow is ignored", async (_label, abort) => {
    const f = fixture();
    await pendingApproval(f);
    const pending = f.lastExt()!.pending_permission as { request_id: string };
    abort(f);
    f.broker.resolve({ request_id: pending.request_id, allow: true });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.replies(7)).toEqual([]);
    expect(f.states.some(s => (s.ext as Record<string, unknown> | undefined)?.pending_permission !== undefined)).toBe(true);
    expect(f.lastExt()?.pending_permission).toBeUndefined();
  });

  it("aborts approvals before the turn scope, so no abort wake-up re-shows the approval", async () => {
    const f = fixture();
    f.host.setPermissionSyncSupported(true);
    await f.host.setPermission({ revision: 2, requested: { sandbox: "workspace-write", network_access: false, approval: "on-request" } });
    await f.host.send("go", undefined, [], "tok");
    await vi.waitFor(() => expect(f.turns()).toHaveLength(1));
    // An older bridge-tool dialog bound to the turn scope, as the gated
    // bridge tools do, then the newer approval takes the slot.
    const signal = f.sessionOptions()!.turnSignal()!;
    void f.broker.decide("mcp__kaoiro__request_session_reset", {}, signal);
    f.ask();
    await vi.waitFor(() => expect(f.lastExt()?.pending_permission).toMatchObject({ tool_name: "codex:command_execution" }));
    const approvalId = (f.lastExt()!.pending_permission as { request_id: string }).request_id;
    const from = f.states.length;
    void f.host.interrupt();
    const shownAfter = f.states.slice(from)
      .map(s => (s.ext as Record<string, unknown> | undefined)?.pending_permission as { request_id?: string } | undefined)
      .filter(p => p?.request_id === approvalId);
    expect(shownAfter).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.replies(7)).toEqual([]);
    expect(f.lastExt()?.pending_permission).toBeUndefined();
  });

  it("answers -32601 for a turn submitted with never, with no dialog", async () => {
    const f = fixture();
    await pendingApproval(f, "never");
    await vi.waitFor(() => expect(f.replies(7)).toEqual([{ id: 7, error: { code: -32601, message: "Client approval and server-request handling are disabled" } }]));
    expect(f.states.some(s => (s.ext as Record<string, unknown> | undefined)?.pending_permission !== undefined)).toBe(false);
  });

  it("advertises the approval axis only with sync support and the opt-in", async () => {
    const on = fixture();
    on.host.setPermissionSyncSupported(true);
    expect((on.host.statusExtSnapshot().session_capabilities as Record<string, unknown>).permission_switch_axes).toEqual(CODEX_APPROVAL_SWITCH_AXES);
    const off = fixture({ approvals: false });
    off.host.setPermissionSyncSupported(true);
    expect(off.host.statusExtSnapshot().session_capabilities).not.toHaveProperty("permission_switch_axes");
    const noSync = fixture();
    expect(noSync.host.statusExtSnapshot().session_capabilities).not.toHaveProperty("permission_switch_axes");
  });

  it("refuses an approval selection without the axis or outside its values (final gate)", async () => {
    const off = fixture({ approvals: false });
    off.host.setPermissionSyncSupported(true);
    await expect(off.host.setPermission({ revision: 2, requested: { sandbox: "workspace-write", network_access: false, approval: "on-request" } }))
      .rejects.toThrow("not an advertised approval value");
    const on = fixture();
    on.host.setPermissionSyncSupported(true);
    await expect(on.host.setPermission({ revision: 2, requested: { sandbox: "workspace-write", network_access: false, approval: "local" } }))
      .rejects.toThrow("not an advertised approval value");
    await expect(on.host.setPermission({ revision: 3, requested: { sandbox: "workspace-write", network_access: false, approval: "untrusted" } }))
      .resolves.toBeUndefined();
    await expect(off.host.setPermission({ revision: 4, requested: { sandbox: "read-only", network_access: false } })).resolves.toBeUndefined();
  });

  it("keeps turn/start at never and answers -32601 without the opt-in", async () => {
    const f = fixture({ approvals: false });
    f.host.setPermissionSyncSupported(true);
    f.host.applyPermissionSync({ version: "0", control: null, next: null });
    await f.host.send("go", undefined, [], "tok");
    await vi.waitFor(() => expect(f.turns()).toHaveLength(1));
    expect(f.turns()[0]!.params).toMatchObject({ approvalPolicy: "never", approvalsReviewer: "user" });
    f.ask();
    await vi.waitFor(() => expect(f.replies(7)).toHaveLength(1));
    expect(f.replies(7)[0]).toMatchObject({ error: { code: -32601 } });
  });
});
