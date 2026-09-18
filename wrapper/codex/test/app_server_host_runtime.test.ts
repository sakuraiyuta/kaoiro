import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  AppServerAdmissionError, AppServerHostRuntime, type AppServerHostSession, type AppServerRuntimeHooks,
} from "../src/app_server_host_runtime.js";
import { AppServerConnectionError, AppServerRpcError } from "../src/app_server_rpc.js";
import { appServerTurnSettings, type AppServerPendingSettings } from "../src/app_server_settings.js";
import type { AppServerProjection } from "../src/app_server_projection.js";
import { beginPermissionExecution, createPermissionState, permissionObservationApplied, requestPermission } from "../src/permission_state.js";

function deferred<T = void>() { let resolve!: (value: T) => void;const promise = new Promise<T>(r => { resolve = r; });return { promise, resolve }; }
const roots: string[] = [], runtimes: AppServerHostRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map(r => r.close()));for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const input = (token = "host-1") => ({ input: "hello", hostTurnToken: token });
function fixture(resume = false) {
  const root = mkdtempSync(join(tmpdir(), "fuji-348-runtime-"));roots.push(root);
  const path = join(root, "rollout-thread.jsonl");if (resume) writeFileSync(path, "");
  let pending: AppServerPendingSettings = { model: null, effort: null, effortReset: false };
  let permission = createPermissionState({ revision: 1, requested: { sandbox: "read-only", network_access: false } }, true);
  let status: "completed" | "failed" | "interrupted" = "completed";
  let terminalWait = Promise.resolve();
  let fault: Error | undefined;
  const configured = vi.fn(async () => ({ config: { model_reasoning_effort: "medium" } }));
  const sent: Array<Record<string, unknown>> = [];
  const initial = { model: "initial", effort: "high" };
  const session: AppServerHostSession = {
    initialSettings: initial,
    readHistory: vi.fn(async () => ({ coverage: "full" as const, logs: [] })),
    startThread: vi.fn(async () => "thread"), resumeThread: vi.fn(async () => "thread"),
    interrupt: vi.fn(async () => true), close: vi.fn(async () => {}),
    startProjectedTurn: vi.fn(async request => {
      const settings = await appServerTurnSettings(request.settings ?? {}, configured);
      await request.beforeDispatch?.(settings);
      request.onDispatch?.(request, settings);
      sent.push(settings);
      const turnId = `turn-${sent.length}`;
      const identity = { threadId: "thread", turnId, hostTurnToken: request.hostTurnToken, requestId: sent.length };
      const sandbox = request.settings?.permission?.sandbox ?? "read-only";
      appendFileSync(path, JSON.stringify({ type: "turn_context", payload: { turn_id: turnId, approval_policy: "never", sandbox_policy: {
        type: sandbox, ...(sandbox === "workspace-write" ? { network_access: request.settings?.permission?.networkAccess } : {}),
      } } }) + "\n");
      return { identity, usage: null, events: (async function* (): AsyncGenerator<AppServerProjection> {
        yield { kind: "log", payload: { kind: "assistant", text: "FIRST" } };
        await terminalWait;if (fault) throw fault;
        yield { kind: "adapter", event: { kind: "result", subtype: status === "completed" ? "success" : "error_during_execution" } };
        yield { kind: "result", status, payload: { text: "DONE", is_error: status !== "completed" } };
      })() };
    }),
  };
  const createSession = vi.fn(async () => session);
  const runtime = new AppServerHostRuntime({ session: { turnSignal: () => null }, effortIntent: "explicit", rolloutRoot: root,
    ...(resume ? { resumeThreadId: "thread" } : {}), createSession });runtimes.push(runtime);
  const hooks: AppServerRuntimeHooks = {
    snapshot: () => ({ pending, permission }), waitForPermissionSync: vi.fn(async () => {}),
    onDispatch: vi.fn(attempt => { if (attempt.permission) permission = beginPermissionExecution(permission, attempt.permission.submission); }),
    onPermission: vi.fn(result => { if (result.applied) permission = permissionObservationApplied(permission, result.observation).state; }),
    onProjection: vi.fn(),
  };
  return { runtime, session, hooks, sent, configured, createSession, path,
    set pending(value: AppServerPendingSettings) { pending = value; }, get pending() { return pending; },
    set permission(value) { permission = value; }, get permission() { return permission; },
    set status(value: typeof status) { status = value; }, set terminalWait(value: Promise<void>) { terminalWait = value; },
    set fault(value: Error) { fault = value; },
  };
}

it.each([false, true])("owns one session, opens once (resume=%s), and settles policy before exposing the terminal", async resume => {
  const f = fixture(resume);
  const first = await f.runtime.run(input(), f.hooks);
  expect(first.permission).toMatchObject({ applied: true, observation: { turn_id: "turn-1" } });
  expect(first.attempt.permission?.cursor.sessionId).toBe(resume ? "thread" : null);
  expect(f.hooks.onProjection).toHaveBeenCalledTimes(1);
  expect(f.hooks.onProjection).toHaveBeenCalledWith({ kind: "log", payload: { kind: "assistant", text: "FIRST" } });
  const second = await f.runtime.run(input("host-2"), f.hooks);
  expect(second.attempt.permission?.cursor.sessionId).toBe("thread");
  expect(f.createSession).toHaveBeenCalledTimes(1);
  expect(resume ? f.session.resumeThread : f.session.startThread).toHaveBeenCalledTimes(1);
  expect(resume ? f.session.startThread : f.session.resumeThread).not.toHaveBeenCalled();
  f.runtime.baseline!.model = "tampered";expect(f.runtime.baseline?.model).toBe("initial");
});

it("waits for initial server sync before creating the child", async () => {
  const f = fixture(), sync = deferred();f.hooks.waitForPermissionSync = vi.fn(() => sync.promise);
  const running = f.runtime.run(input(), f.hooks);
  await Promise.resolve();expect(f.createSession).not.toHaveBeenCalled();expect(f.sent).toHaveLength(0);
  sync.resolve();await running;expect(f.sent).toHaveLength(1);
});

it.each(["permission", "model", "effort", "reset"])("reprepares an unstarted turn after %s changes during default resolution", async field => {
  const f = fixture(), resolving = deferred<{ config: { model_reasoning_effort: string } }>(), rejoin = deferred();
  f.pending = { model: "old-choice", effort: null, effortReset: true };
  f.configured.mockImplementationOnce(() => resolving.promise);
  let waits = 0;f.hooks.waitForPermissionSync = vi.fn(() => ++waits === 2 ? rejoin.promise : Promise.resolve());
  const running = f.runtime.run(input(), f.hooks);
  await vi.waitFor(() => expect(f.configured).toHaveBeenCalledTimes(1));
  if (field === "permission") f.permission = requestPermission(f.permission, { revision: 2, requested: { sandbox: "workspace-write", network_access: true } });
  if (field === "model") f.pending = { ...f.pending, model: "new-choice" };
  if (field === "effort") f.pending = { ...f.pending, effort: "low", effortReset: false };
  if (field === "reset") f.pending = { ...f.pending, effortReset: false };
  resolving.resolve({ config: { model_reasoning_effort: "medium" } });
  await vi.waitFor(() => expect(waits).toBe(2));expect(f.sent).toHaveLength(0);expect(f.hooks.onDispatch).not.toHaveBeenCalled();
  rejoin.resolve();const completion = await running;
  expect(f.sent).toHaveLength(1);expect(f.hooks.onDispatch).toHaveBeenCalledTimes(1);
  expect(completion.attempt.permission?.cursor.sessionId).toBeNull();
  expect(completion.attempt.pending).toEqual(f.pending);
  expect(completion.attempt.permission?.submission.revision).toBe(field === "permission" ? 2 : 1);
  expect(f.session.startProjectedTurn).toHaveBeenCalledTimes(2);
});

it("keeps mid-turn changes pending and preserves the current execution's policy evidence", async () => {
  const f = fixture(), end = deferred();f.terminalWait = end.promise;
  const running = f.runtime.run(input(), f.hooks);await vi.waitFor(() => expect(f.sent).toHaveLength(1));
  f.pending = { model: "next-model", effort: "low", effortReset: false };
  f.permission = requestPermission(f.permission, { revision: 2, requested: { sandbox: "workspace-write", network_access: true } });
  end.resolve();const first = await running;
  expect(first.permission).toMatchObject({ applied: true, observation: { revision: 1 } });
  expect(f.runtime.baseline?.model).toBe("initial");
  const second = await f.runtime.run(input("host-2"), f.hooks);
  expect(second.permission).toMatchObject({ applied: true, observation: { revision: 2 } });
  expect(f.runtime.baseline).toEqual({ model: "next-model", effort: "low", effortIntent: "explicit" });
});

it.each(["failed", "interrupted"] as const)("does not update the successful baseline for a %s terminal and explicitly rolls back", async status => {
  const f = fixture();await f.runtime.run(input(), f.hooks);
  f.pending = { model: "rejected", effort: "low", effortReset: false };f.status = status;
  await f.runtime.run(input("host-2"), f.hooks);
  expect(f.runtime.baseline).toEqual({ model: "initial", effort: "high", effortIntent: "explicit" });
  f.pending = { model: null, effort: null, effortReset: false };f.status = "completed";
  await f.runtime.run(input("host-3"), f.hooks);
  expect(f.sent[2]).toMatchObject({ model: "initial", effort: "high" });
});

it("fences interrupts by token, waits for the terminal after interrupt acceptance, and refuses overlapping runs", async () => {
  const f = fixture(), end = deferred();f.terminalWait = end.promise;
  f.pending = { model: "abandoned", effort: "low", effortReset: false };
  const running = f.runtime.run(input(), f.hooks);await vi.waitFor(() => expect(f.sent).toHaveLength(1));
  expect(await f.runtime.interrupt("wrong")).toBe(false);expect(f.session.interrupt).not.toHaveBeenCalled();
  expect(await f.runtime.interrupt("host-1")).toBe(true);
  await expect(f.runtime.run(input("host-2"), f.hooks)).rejects.toThrow("active turn");
  expect(f.sent).toHaveLength(1);
  // A completed terminal already in flight must not commit an abandoned switch.
  end.resolve();await running;expect(f.runtime.baseline?.model).toBe("initial");
  expect(await f.runtime.interrupt("host-1")).toBe(false);
});

it.each(["interrupt", "close"])("releases a stuck sync wait on %s without dispatch", async action => {
  const f = fixture();f.hooks.waitForPermissionSync = () => new Promise(() => {});
  const running = f.runtime.run(input(), f.hooks);
  const rejected = expect(running).rejects.toMatchObject({ reason: "interrupted" });
  if (action === "interrupt") expect(await f.runtime.interrupt("host-1")).toBe(true);else await f.runtime.close();
  await rejected;expect(f.hooks.onDispatch).not.toHaveBeenCalled();expect(f.createSession).not.toHaveBeenCalled();
});

it("cancels a permission gate without replacing the child or emitting a dispatch", async () => {
  const f = fixture();let calls = 0;
  f.hooks.waitForPermissionSync = async () => { if (++calls === 2) throw new AppServerAdmissionError("permission_gate_blocked"); };
  await expect(f.runtime.run(input(), f.hooks)).rejects.toMatchObject({ reason: "permission_gate_blocked" });
  expect(f.sent).toHaveLength(0);expect(f.hooks.onDispatch).not.toHaveBeenCalled();
  await f.runtime.run(input("retry"), f.hooks);expect(f.createSession).toHaveBeenCalledTimes(1);
});

it.each(["stream", "opening"])("closes admission after %s failure and never creates another child", async at => {
  const f = fixture();
  if (at === "stream") f.fault = new AppServerConnectionError("fixture EOF");
  else vi.mocked(f.session.startThread).mockRejectedValueOnce(new AppServerConnectionError("fixture EOF"));
  await expect(f.runtime.run(input(), f.hooks)).rejects.toThrow("fixture EOF");
  expect(f.runtime.closed).toBe(true);
  await expect(f.runtime.run(input("next"), f.hooks)).rejects.toThrow("runtime closed");
  expect(f.createSession).toHaveBeenCalledTimes(1);expect(f.session.close).toHaveBeenCalled();
});

it("delivers the terminal boundary before policy observation and commits policy before the settings baseline", async () => {
  const f = fixture(), order: string[] = [];
  f.pending = { model: "changed", effort: "low", effortReset: false };
  f.hooks.onTerminal = () => {
    order.push("terminal");expect(f.permission.current?.status).toBe("applying");expect(f.runtime.baseline?.model).toBe("initial");
  };
  const apply = f.hooks.onPermission;
  f.hooks.onPermission = (result, attempt) => {
    order.push("permission");expect(f.runtime.baseline?.model).toBe("initial");apply(result, attempt);
  };
  await f.runtime.run(input(), f.hooks);
  expect(order).toEqual(["terminal", "permission"]);
  expect(f.permission.current?.status).toBe("applied");expect(f.runtime.baseline?.model).toBe("changed");
});

it("keeps an interrupted request's delayed acknowledgement from acting on the next token", async () => {
  const f = fixture(), ack = deferred<boolean>(), end = deferred();f.terminalWait = end.promise;
  vi.mocked(f.session.interrupt).mockImplementationOnce(() => ack.promise);
  const first = f.runtime.run(input(), f.hooks);await vi.waitFor(() => expect(f.sent).toHaveLength(1));
  const interrupt = f.runtime.interrupt("host-1");end.resolve();await first;
  const nextEnd = deferred();f.terminalWait = nextEnd.promise;
  const second = f.runtime.run(input("host-2"), f.hooks);await vi.waitFor(() => expect(f.sent).toHaveLength(2));
  ack.resolve(true);expect(await interrupt).toBe(true);
  expect(f.session.interrupt).toHaveBeenCalledTimes(1);expect(f.session.interrupt).toHaveBeenCalledWith("host-1");
  expect(await f.runtime.interrupt("host-1")).toBe(false);nextEnd.resolve();await second;
});

it("cancels preparation after a pending settings RPC without a turn dispatch", async () => {
  const f = fixture(), config = deferred<{ config: { model_reasoning_effort: string } }>();
  f.pending = { model: "changed", effort: null, effortReset: true };f.configured.mockImplementationOnce(() => config.promise);
  const running = f.runtime.run(input(), f.hooks);const rejected = expect(running).rejects.toMatchObject({ reason: "interrupted" });
  await vi.waitFor(() => expect(f.configured).toHaveBeenCalledTimes(1));expect(await f.runtime.interrupt("host-1")).toBe(true);
  config.resolve({ config: { model_reasoning_effort: "medium" } });await rejected;
  expect(f.sent).toHaveLength(0);expect(f.hooks.onDispatch).not.toHaveBeenCalled();
});

it("cleans up a session whose construction finishes after runtime close", async () => {
  const f = fixture(), creating = deferred<AppServerHostSession>();f.createSession.mockImplementationOnce(() => creating.promise);
  const running = f.runtime.run(input(), f.hooks);const rejected = expect(running).rejects.toMatchObject({ reason: "interrupted" });
  await vi.waitFor(() => expect(f.createSession).toHaveBeenCalledTimes(1));
  const closing = f.runtime.close();await rejected;
  creating.resolve(f.session);await closing;
  expect(f.session.startThread).not.toHaveBeenCalled();expect(f.session.close).toHaveBeenCalled();
  await expect(f.runtime.run(input("next"), f.hooks)).rejects.toThrow("runtime closed");expect(f.createSession).toHaveBeenCalledTimes(1);
});

it("fails closed on a projection stream that ends without a terminal", async () => {
  const f = fixture();const start = vi.mocked(f.session.startProjectedTurn).getMockImplementation()!;
  vi.mocked(f.session.startProjectedTurn).mockImplementationOnce(async request => {
    const turn = await start(request);
    return { ...turn, events: (async function* () {})() };
  });
  await expect(f.runtime.run(input(), f.hooks)).rejects.toThrow("without a terminal");
  expect(f.runtime.closed).toBe(true);expect(f.sent).toHaveLength(1);
});

it("rejects an unavailable initial baseline before dispatch without guessing thread settings", async () => {
  const f = fixture();Object.defineProperty(f.session, "initialSettings", { value: null });
  await expect(f.runtime.run(input(), f.hooks)).rejects.toMatchObject({ reason: "default_effort_unavailable" });
  expect(f.sent).toHaveLength(0);expect(f.hooks.onDispatch).not.toHaveBeenCalled();
});

it("rechecks legacy permission selection even without observation support", async () => {
  const f = fixture(), config = deferred<{ config: { model_reasoning_effort: string } }>();
  f.permission = { ...f.permission, syncSupported: false };
  f.pending = { model: "changed", effort: null, effortReset: true };f.configured.mockImplementationOnce(() => config.promise);
  const running = f.runtime.run(input(), f.hooks);await vi.waitFor(() => expect(f.configured).toHaveBeenCalledTimes(1));
  f.permission = { ...f.permission, next: { revision: 2, requested: { sandbox: "workspace-write", network_access: true } } };
  config.resolve({ config: { model_reasoning_effort: "medium" } });
  const completion = await running;expect(f.session.startProjectedTurn).toHaveBeenCalledTimes(2);
  expect(f.sent[0]).toMatchObject({ sandboxPolicy: { type: "workspaceWrite", networkAccess: true } });
  expect(completion.permission).toBeNull();expect(f.hooks.onPermission).not.toHaveBeenCalled();
});

it("starts closing an existing session synchronously before awaiting its shutdown", async () => {
  const f = fixture(), shutdown = deferred();await f.runtime.open();
  vi.mocked(f.session.close).mockImplementationOnce(() => shutdown.promise);
  const closing = f.runtime.close();expect(f.session.close).toHaveBeenCalledTimes(1);
  expect(f.runtime.closed).toBe(true);shutdown.resolve();await closing;
});

it("keeps an RPC-rejected attempt distinct from connection failure and rolls back on the same session", async () => {
  const f = fixture();const start = vi.mocked(f.session.startProjectedTurn).getMockImplementation()!;
  f.pending = { model: "rejected", effort: "low", effortReset: false };
  vi.mocked(f.session.startProjectedTurn).mockImplementationOnce(async request => {
    await start(request);throw new AppServerRpcError(-32600, "fixture rejection");
  });
  await expect(f.runtime.run(input(), f.hooks)).rejects.toBeInstanceOf(AppServerRpcError);
  expect(f.runtime.closed).toBe(false);expect(f.session.close).not.toHaveBeenCalled();
  expect(f.runtime.baseline?.model).toBe("initial");
  f.pending = { model: null, effort: null, effortReset: false };await f.runtime.run(input("next"), f.hooks);
  expect(f.sent[1]).toMatchObject({ model: "initial", effort: "high" });expect(f.createSession).toHaveBeenCalledTimes(1);
});


it("rejects a stable blocked gate even when the sync hook returns, and permits explicit reapplication", async () => {
  const f = fixture();
  f.permission = { ...f.permission, blocked: { revision: 1, reason: "policy_mismatch" } };
  await expect(f.runtime.run(input(), f.hooks)).rejects.toMatchObject({ reason: "permission_gate_blocked" });
  expect(f.sent).toHaveLength(0);expect(f.hooks.onDispatch).not.toHaveBeenCalled();
  expect(f.session.startProjectedTurn).not.toHaveBeenCalled();expect(f.createSession).toHaveBeenCalledTimes(1);
  expect(f.runtime.closed).toBe(false);expect(f.session.close).not.toHaveBeenCalled();
  f.permission = requestPermission(f.permission, { revision: 2, requested: { sandbox: "read-only", network_access: false } });
  await f.runtime.run(input("reapplied"), f.hooks);
  expect(f.sent).toHaveLength(1);expect(f.createSession).toHaveBeenCalledTimes(1);
});

it("rejects a block introduced during settings preparation without repeated configuration requests", async () => {
  const f = fixture();f.pending = { model: "changed", effort: null, effortReset: true };
  f.configured.mockImplementationOnce(async () => {
    f.permission = { ...f.permission, blocked: { revision: 1, reason: "policy_mismatch" } };
    return { config: { model_reasoning_effort: "medium" } };
  });
  await expect(f.runtime.run(input(), f.hooks)).rejects.toMatchObject({ reason: "permission_gate_blocked" });
  expect(f.configured).toHaveBeenCalledTimes(1);expect(f.sent).toHaveLength(0);
  expect(f.hooks.onDispatch).not.toHaveBeenCalled();expect(f.runtime.closed).toBe(false);
});

it.each(["terminal callback", "observation wait"])("rejects an interrupt after the terminal during %s without undoing a successful switch", async boundary => {
  const f = fixture(), reached = deferred();
  f.pending = { model: "changed", effort: "low", effortReset: false };
  let interrupt: Promise<boolean> | undefined;
  f.hooks.onTerminal = () => {
    // Remove the evidence to keep observation pending after the terminal.
    if (boundary === "observation wait") writeFileSync(f.path, "");
    else interrupt = f.runtime.interrupt("host-1");
    reached.resolve();
  };
  const running = f.runtime.run(input(), f.hooks);
  await reached.promise;
  if (boundary === "observation wait") interrupt = f.runtime.interrupt("host-1");
  const result = await running;
  expect(result.terminal.status).toBe("completed");
  expect(f.runtime.baseline).toEqual({ model: "changed", effort: "low", effortIntent: "explicit" });
  expect(await interrupt).toBe(false);expect(f.session.interrupt).not.toHaveBeenCalled();
  delete f.hooks.onTerminal;f.pending = { model: null, effort: null, effortReset: false };
  await f.runtime.run(input("next"), f.hooks);
  expect(f.sent[1]).toMatchObject({ effort: "low" });expect(f.sent[1]).not.toHaveProperty("model");
});

it.each(["plain", "rpc"])("treats a non-admission %s hook rejection as a connection failure", async kind => {
  const f = fixture();await f.runtime.open();
  f.hooks.waitForPermissionSync = async () => { throw kind === "plain" ? new Error("gate failure") : new AppServerRpcError(1, "gate failure"); };
  await expect(f.runtime.run(input(), f.hooks)).rejects.toBeInstanceOf(AppServerConnectionError);
  expect(f.runtime.closed).toBe(true);expect(f.session.close).toHaveBeenCalledTimes(1);expect(f.sent).toHaveLength(0);
});

it("excludes turn dispatch and concurrent reads while history is pending, then releases admission", async () => {
  const f = fixture(true), gate = deferred();
  const config = { agent_id: "h", persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P", server_url: "ws://unused" };
  vi.mocked(f.session.readHistory).mockImplementationOnce(async () => { await gate.promise;return { coverage: "full", logs: [] }; });
  const read = f.runtime.readHistory(config, () => "T");
  try {
    await vi.waitFor(() => expect(f.session.readHistory).toHaveBeenCalledTimes(1));
    await expect(f.runtime.run(input(), f.hooks)).rejects.toThrow("active");
    await expect(f.runtime.readHistory(config, () => "T")).rejects.toThrow("active");
    expect(f.sent).toHaveLength(0);
  } finally { gate.resolve();await read; }
  await expect(f.runtime.run(input(), f.hooks)).resolves.toMatchObject({ terminal: { status: "completed" } });
  expect(f.createSession).toHaveBeenCalledTimes(1);expect(f.session.resumeThread).toHaveBeenCalledTimes(1);
  await f.runtime.close();await expect(f.runtime.readHistory(config, () => "T")).rejects.toBeInstanceOf(AppServerConnectionError);
});
