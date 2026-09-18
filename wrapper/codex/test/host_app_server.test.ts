import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { SessionResetCoordinator, type Envelope, type WrapperConfig } from "@kaoiro/agent-common";
import { CodexHost, type CodexHostOptions } from "../src/host.js";
import { AppServerSession } from "../src/app_server_session.js";
import * as turnDiagnostics from "../src/turn_diagnostics.js";
import type { RpcObject } from "../src/app_server_rpc.js";

const config: WrapperConfig = { agent_id: "host-app", persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P",
  server_url: "ws://unused", model: "gpt-5.6-sol", effort: "high", codex_auth_mode: "chatgpt", codex_chatgpt_plan: "plus" };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn();vi.restoreAllMocks(); });
function deferred() { let resolve!: () => void;const promise = new Promise<void>(r => { resolve = r; });return { promise, resolve }; }
function holdStartup() {
  const entered = deferred(), release = deferred();
  const prune = turnDiagnostics.pruneCodexTurnTraceCaptureDirs;
  vi.spyOn(turnDiagnostics, "pruneCodexTurnTraceCaptureDirs").mockImplementation(async (...args) => {
    entered.resolve();await release.promise;return prune(...args);
  });
  cleanup.push(async () => release.resolve());
  return { entered: entered.promise, release: release.resolve };
}
function fixture(overrides: Partial<CodexHostOptions> = {}, launch = config) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough(), stderr = new PassThrough(), sent: RpcObject[] = [];
  let number = 0, active = 0, maxActive = 0;
  let holdConfig: Promise<void> | null = null, holdHistory: Promise<void> | null = null;
  let invalidHistory = false;
  let interrupted = true, autocomplete = false;
  const send = (value: unknown) => stdout.write(JSON.stringify(value) + "\n");
  const reply = (request: RpcObject, result: unknown) => send({ id: request.id, result });
  const terminal = (status = "completed") => {
    active -= 1;send({ method: "turn/completed", params: { threadId: "thread", turn: { id: `turn-${number}`, status } } });
  };
  const stdin = new Writable({ write(chunk, _encoding, cb) {
    const request = JSON.parse(String(chunk)) as RpcObject;sent.push(request);
    if (request.method === "initialize") reply(request, { userAgent: "test/0.153.4" });
    if (request.method === "thread/start" || request.method === "thread/resume") reply(request, { thread: { id: "thread" }, model: "gpt-5.6-sol", reasoningEffort: "medium" });
    if (request.method === "account/rateLimits/read") send({ id: request.id, error: { code: -32600, message: "no account" } });
    if (request.method === "config/read") void (holdConfig ?? Promise.resolve()).then(() => reply(request, { config: { model_reasoning_effort: "low" } }));
    if (request.method === "thread/read") void (holdHistory ?? Promise.resolve()).then(() => reply(request, invalidHistory ? {} : {
      thread: { id: "thread", turns: [{ id: "past", items: [{ id: "answer", type: "agentMessage", text: "PAST" }] }] },
    }));
    if (request.method === "turn/start") {
      number += 1;active += 1;maxActive = Math.max(active, maxActive);
      reply(request, { turn: { id: `turn-${number}` } });
      send({ method: "turn/started", params: { threadId: "thread", turn: { id: `turn-${number}` } } });
      if (autocomplete && number > 1) queueMicrotask(() => terminal());
    }
    if (request.method === "turn/interrupt") { reply(request, {});if (interrupted) terminal("interrupted"); }
    cb();
  } });
  Object.assign(child, { stdin, stdout, stderr, exitCode: null, signalCode: null });
  const exit = () => {
    if (child.exitCode !== null) return;
    Object.assign(child, { exitCode: 0 });child.emit("exit", 0, null);stdout.end();stderr.end();queueMicrotask(() => child.emit("close", 0, null));
  };
  stdin.on("finish", exit);child.kill = vi.fn(() => { exit();return true; });
  const states: Envelope[] = [], logs: Envelope[] = [], tasks: Envelope[] = [];
  const starts = vi.fn(), ends = vi.fn(), finals = vi.fn(), boundaries = vi.fn();
  const createSession = vi.fn(options => AppServerSession.create({ ...options, transport: { spawnChild: () => child, shutdownTimeoutMs: 100 } }));
  const host = new CodexHost(launch, { backend: "app-server", appServerSessionFactory: createSession,
    appendSystemPrompt: "PERSONA", onState: e => states.push(e), onLog: e => logs.push(e), onTask: e => tasks.push(e),
    onTurnStart: starts, onTurnEnd: ends, onTurnFinalized: finals, onTurnBoundary: boundaries, ...overrides });
  const running = host.run();cleanup.push(async () => { host.close();await running; });
  const turns = () => sent.filter(r => r.method === "turn/start");
  const until = (count: number) => vi.waitFor(() => expect(turns()).toHaveLength(count));
  return { host, sent, states, logs, tasks, starts, ends, finals, boundaries, createSession, send, terminal, exit, running, turns, until,
    set holdHistory(value: Promise<void>) { holdHistory = value; }, set invalidHistory(value: boolean) { invalidHistory = value; },
    get maxActive() { return maxActive; }, set autocomplete(value: boolean) { autocomplete = value; }, set holdConfig(value: Promise<void>) { holdConfig = value; }, set interrupted(value: boolean) { interrupted = value; } };
}

it("keeps queue order, maximum active one, and every queued input successful", async () => {
  const f = fixture();f.autocomplete = true;
  for (const text of ["A", "B", "C"]) await f.host.send(text, undefined, [text], text);
  await f.until(1);expect(f.starts.mock.calls.map(([x]) => x.turnToken)).toEqual(["A"]);
  f.terminal();await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(3));
  expect.soft(f.turns().map(r => (r.params as { input: { text: string }[] }).input[0]?.text), "dispatch order").toEqual(["A", "B", "C"]);
  expect.soft(f.maxActive, "maximum active").toBe(1);
  expect.soft(f.ends.mock.calls.map(([x]) => [x.turnToken, x.terminal, x.error]), "all queued inputs succeed").toEqual(["A", "B", "C"].map(t => [t, "turn.completed", undefined]));
  expect(f.logs.filter(e => e.type === "result")).toHaveLength(3);expect(f.boundaries).toHaveBeenCalledTimes(3);
  expect(f.createSession).toHaveBeenCalledTimes(1);
});

it("waits for permission sync before child creation and dispatch", async () => {
  const gate = deferred(), wait = vi.fn(() => gate.promise), f = fixture({ waitForPermissionSync: wait });
  await f.host.send("A");
  await vi.waitFor(() => expect(wait.mock.calls.length > 0 || f.turns().length > 0).toBe(true));
  expect.soft(f.createSession).not.toHaveBeenCalled();expect.soft(f.starts).not.toHaveBeenCalled();expect.soft(f.turns()).toHaveLength(0);
  gate.resolve();await f.until(1);f.terminal();
});

it("cancels a blocked gate with the admission type and reuses the session after reapplication", async () => {
  const f = fixture({ permissionSyncSupported: true, permissionGateTimeoutMs: 10 });
  await f.host.send("first");await f.until(1);f.terminal();await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(1));
  await f.host.send("blocked");await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(2));
  expect(f.ends.mock.calls[1]?.[0]).toMatchObject({ error: { reason: "permission_gate_blocked" }, cancellation: { started: false } });
  expect(f.createSession).toHaveBeenCalledTimes(1);expect(f.turns()).toHaveLength(1);
  await f.host.setPermission({ revision: 1, requested: { sandbox: "workspace-write", network_access: false } });
  await f.host.send("retry");await f.until(2);f.terminal();
});

it("reprepares model and effort while settings resolution is pending without duplicate starts", async () => {
  const { effort: _effort, ...withoutEffort } = config;
  const f = fixture({}, withoutEffort), gate = deferred();f.holdConfig = gate.promise;
  await f.host.setModel("gpt-6-astra");await f.host.send("A");
  await vi.waitFor(() => expect(f.sent.some(r => r.method === "config/read")).toBe(true));
  await f.host.setModel("gpt-5.6-sol");await f.host.setEffort("low");gate.resolve();await f.until(1);
  expect(f.turns()[0]?.params).toMatchObject({ model: "gpt-5.6-sol", effort: "low" });
  expect(f.starts).toHaveBeenCalledTimes(1);f.terminal();
});

it("projects logs, task snapshots and one result without re-normalizing omitted counts", async () => {
  const f = fixture();await f.host.send("A");await f.until(1);
  for (const text of ["FIRST", "DONE"]) f.send({ method: "item/completed", params: { threadId: "thread", turnId: "turn-1", item: { id: text, type: "agentMessage", text, phase: "final_answer" } } });
  const plan = Array.from({ length: 205 }, (_, i) => ({ step: `task ${i}`, status: "pending" }));
  for (let i = 0; i < 2; i++) f.send({ method: "turn/plan/updated", params: { threadId: "thread", turnId: "turn-1", plan } });
  f.terminal();await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(1));
  expect(f.logs.filter(e => e.type === "log").map(e => e.payload.text)).toEqual(["FIRST", "DONE"]);
  expect(f.logs.filter(e => e.type === "result")).toHaveLength(1);expect(f.tasks).toHaveLength(1);
  expect(f.tasks[0]?.payload.omitted).toMatchObject({ count: 155 });
});

it("keeps queued text after token-fenced interrupt and omits the reset-authorizing terminal", async () => {
  const f = fixture();await f.host.send("A", undefined, [], "A");await f.host.send("B", undefined, [], "B");await f.until(1);
  expect(f.host.requestInterruptForTurn("wrong")).toBe(false);
  expect(f.host.requestInterruptForTurn("A")).toBe(true);
  await f.until(2);expect(f.ends.mock.calls[0]?.[0]).toMatchObject({ error: { reason: "interrupted" }, abandoned: "watchdog_interrupt" });
  expect(f.ends.mock.calls[0]?.[0]).not.toHaveProperty("terminal");
  expect(f.host.requestInterruptForTurn("A")).toBe(false);f.terminal();
});

it("does not abandon a completed boundary from its onTurnBoundary callback", async () => {
  let f: ReturnType<typeof fixture>;let accepted: boolean | undefined;
  f = fixture({ onTurnBoundary: ({ turnToken }) => { accepted = f.host.requestInterruptForTurn(turnToken); } });
  await f.host.setModel("gpt-6-astra");await f.host.send("A", undefined, [], "A");await f.until(1);f.terminal();
  await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(1));expect(accepted).toBe(false);
  expect(f.ends.mock.calls[0]?.[0]).not.toHaveProperty("abandoned");
  expect(f.host.statusSnapshot().model).toBe("gpt-6-astra");
});

it.each(["idle", "active"])("closes admission once on %s disconnection without inventing an idle result", async phase => {
  const f = fixture();await f.host.send("A", undefined, [], "A");await f.until(1);
  if (phase === "idle") { f.terminal();await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(1)); }
  f.exit();f.exit();await f.running;
  await f.host.send("next");expect(f.createSession).toHaveBeenCalledTimes(1);expect(f.turns()).toHaveLength(1);
  expect(f.logs.filter(e => e.type === "result")).toHaveLength(1);expect(f.ends).toHaveBeenCalledTimes(1);expect(f.finals).toHaveBeenCalledTimes(1);
  expect(f.states.at(-1)?.state).toBe("error");
});

it("does not treat intentional idle close as a disconnect error", async () => {
  const f = fixture();await f.host.send("A");await f.until(1);f.terminal();await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(1));
  f.host.close();await f.running;expect(f.states.at(-1)?.state).not.toBe("error");expect(f.logs.filter(e => e.type === "result")).toHaveLength(1);
});

it("settles and finalizes once even if the result sink throws", async () => {
  const result = vi.fn(() => { throw new Error("sink failure"); });
  const f = fixture({ onLog: e => { if (e.type === "result") result(); } });
  await f.host.send("A");await f.until(1);f.terminal();await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(1));
  expect(result).toHaveBeenCalledTimes(1);
  expect(f.ends).toHaveBeenCalledTimes(1);expect(f.boundaries).toHaveBeenCalledTimes(1);
  expect(f.states.at(-1)?.state).toBe("waiting_input");
  expect(f.host.statusSnapshot().state).toBe("waiting_input");
});


it("does not dispatch a reserved session reset after an externally interrupted terminal", async () => {
  const request = vi.fn(async () => ({ requestId: "reset" })), notify = vi.fn(async () => {});
  const coordinator = new SessionResetCoordinator({ request, notify, log: () => {} });
  const f = fixture({ onTurnEnd: ({ turnToken, terminal, abandoned }) => {
    coordinator.onTurnEnd({ turnToken, authoritative: terminal !== undefined && abandoned === undefined });
  } });
  await f.host.send("A", undefined, [], "A");await f.until(1);coordinator.reserve("new", "fixture", "A");
  f.terminal("interrupted");await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(1));
  expect(request).not.toHaveBeenCalled();expect(coordinator.pending).toBe(false);expect(notify).toHaveBeenCalledTimes(1);
});

it("preserves queued text when operator interrupt precedes preparation", async () => {
  const startup = holdStartup(), gate = deferred(), wait = vi.fn(() => gate.promise);
  const f = fixture({ waitForPermissionSync: wait });
  await f.host.send("A", undefined, [], "A");await f.host.send("B", undefined, [], "B");
  await startup.entered;expect(wait).not.toHaveBeenCalled();await f.host.interrupt();
  expect(f.finals).not.toHaveBeenCalled();expect(f.starts).not.toHaveBeenCalled();
  startup.release();await vi.waitFor(() => expect(wait).toHaveBeenCalled());
  gate.resolve();await f.until(1);expect(f.starts.mock.calls[0]?.[0].turnToken).toBe("A");
  f.terminal();await f.until(2);expect(f.starts.mock.calls[1]?.[0].turnToken).toBe("B");
  f.terminal();await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(2));
  expect(f.ends.mock.calls.map(([end]) => end.terminal)).toEqual(["turn.completed", "turn.completed"]);
});

it("cancels unsent preparation on operator interrupt and preserves the next text input", async () => {
  const startup = holdStartup(), gate = deferred(), wait = vi.fn(() => gate.promise);
  const f = fixture({ waitForPermissionSync: wait });
  await f.host.send("A", undefined, [], "A");await f.host.send("B", undefined, [], "B");
  await startup.entered;expect(wait).not.toHaveBeenCalled();startup.release();
  await vi.waitFor(() => expect(wait).toHaveBeenCalled());await f.host.interrupt();
  await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(1));
  expect(f.starts).not.toHaveBeenCalled();gate.resolve();await f.until(1);
  expect(f.starts.mock.calls[0]?.[0].turnToken).toBe("B");f.terminal();
});


it("does not pin display-only default model and effort hints", async () => {
  const { model: _model, effort: _effort, ...withoutSelections } = config;
  const f = fixture({ resumeSnapshot: { model: "gpt-6-astra", model_source: "default", effort: "high", effort_source: "default" } }, withoutSelections);
  await f.host.send("A");await f.until(1);
  expect(f.sent.find(r => r.method === "thread/start")?.params).not.toHaveProperty("model");
  expect(f.turns()[0]?.params).not.toHaveProperty("model");expect(f.turns()[0]?.params).not.toHaveProperty("effort");f.terminal();
});

it("keeps the default exec factory, arguments and callbacks despite unrelated config and environment hints", async () => {
  const prior = process.env.KAOIRO_CODEX_BACKEND;process.env.KAOIRO_CODEX_BACKEND = "app-server";
  const appFactory = vi.fn(), starts = vi.fn(), ends = vi.fn(), finals = vi.fn(), logs: Envelope[] = [];
  const threadOptions: unknown[] = [], options: unknown[] = [];
  const launch = { ...config, backend: "app-server" };
  const host = new CodexHost(launch, { appServerSessionFactory: appFactory, appendSystemPrompt: "PERSONA",
    onState: () => {}, onLog: e => logs.push(e), onTurnStart: starts, onTurnEnd: ends, onTurnFinalized: finals,
    codexFactory: value => { options.push(value);return { startThread: value => { threadOptions.push(value);return {
      runStreamed: async () => ({ events: (async function* () { yield { type: "turn.completed" as const, usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } }; })() }),
    }; }, resumeThread: () => { throw new Error("unexpected resume"); } }; },
  });
  let running: Promise<void> | undefined;
  try {
    await host.send("A", undefined, ["c"], "token");running = host.run();await vi.waitFor(() => expect(finals).toHaveBeenCalledTimes(1));
    expect(appFactory).not.toHaveBeenCalled();expect(options).toEqual([{ config: { developer_instructions: "PERSONA", approvals_reviewer: "user", features: { multi_agent: true } } }]);
    expect(threadOptions).toEqual([expect.objectContaining({ model: "gpt-5.6-sol", modelReasoningEffort: "high", approvalPolicy: "never", sandboxMode: "workspace-write", networkAccessEnabled: false })]);
    expect(starts).toHaveBeenCalledWith({ turnToken: "token", conversationIds: ["c"] });
    expect(ends).toHaveBeenCalledWith({ turnToken: "token", conversationIds: ["c"], terminal: "turn.completed" });
    expect(logs.filter(e => e.type === "result")).toHaveLength(1);
  } finally { host.close();await running;if (prior === undefined) delete process.env.KAOIRO_CODEX_BACKEND;else process.env.KAOIRO_CODEX_BACKEND = prior; }
});

it("keeps runtime settings authoritative when an interrupted turn later completes", async () => {
  const f = fixture();f.interrupted = false;
  await f.host.send("initial", undefined, [], "initial");await f.until(1);f.terminal();
  await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(1));
  await f.host.setModel("gpt-6-astra");await f.host.send("changed", undefined, [], "changed");await f.until(2);
  expect(f.host.requestInterruptForTurn("changed")).toBe(true);f.terminal();
  await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(2));
  expect(f.host.statusSnapshot().model).toBe("gpt-5.6-sol");
  expect(f.states.flatMap(e => e.ext?.switch_error ? [e.ext.switch_error] : [])).toContainEqual(
    { kind: "model", requested: "gpt-6-astra", reason: "turn_failed", rolled_back_to: "gpt-5.6-sol" });
  await f.host.send("next");await f.until(3);
  expect(f.turns()[2]?.params).toMatchObject({ model: "gpt-5.6-sol", effort: "high" });f.terminal();
});

it("retires queued inputs once after an active disconnect without dispatching them", async () => {
  const f = fixture();
  for (const text of ["A", "B", "C"]) await f.host.send(text, undefined, [], text);
  await f.until(1);f.exit();await f.running;
  expect(f.starts.mock.calls.map(([x]) => x.turnToken)).toEqual(["A"]);
  expect(f.ends.mock.calls.map(([x]) => x.turnToken).sort()).toEqual(["A", "B", "C"]);
  expect(f.finals.mock.calls.map(([x]) => x.turnToken).sort()).toEqual(["A", "B", "C"]);
  expect(f.logs.filter(e => e.type === "result")).toHaveLength(1);
});

it("keeps watchdog fail-stop closed without a late active result or settlement", async () => {
  const f = fixture();await f.host.send("A", undefined, [], "A");await f.host.send("B", undefined, [], "B");await f.until(1);
  expect(f.host.failStopTurnForWatchdog("A")).toBe(true);await f.running;
  expect(f.turns()).toHaveLength(1);expect(f.logs.filter(e => e.type === "result")).toHaveLength(0);
  expect(f.ends.mock.calls.map(([x]) => x.turnToken)).toEqual(["B"]);
  expect(f.ends.mock.calls[0]?.[0]).toMatchObject({ cancellation: { kind: "watchdog_fail_stop", started: false } });
  expect(f.finals.mock.calls.map(([x]) => x.turnToken).sort()).toEqual(["A", "B"]);
  expect(f.states.at(-1)?.state).toBe("error");
});


it("reads resume history before any turn, using one session without lifecycle callbacks", async () => {
  const f = fixture({ resumeSessionId: "thread" }), snapshots: unknown[] = [];
  f.host.scheduleHistoryReplay(async read => { snapshots.push(await read()); });
  await vi.waitFor(() => expect(snapshots).toHaveLength(1));
  expect(snapshots[0]).toMatchObject({ coverage: "full", logs: [{ payload: { text: "PAST" } }] });
  expect(f.sent.filter(r => r.method === "thread/resume")).toHaveLength(1);expect(f.turns()).toHaveLength(0);
  expect(f.starts).not.toHaveBeenCalled();expect(f.ends).not.toHaveBeenCalled();expect(f.finals).not.toHaveBeenCalled();
  await f.host.send("next");await f.until(1);f.terminal();expect(f.createSession).toHaveBeenCalledTimes(1);
});

it("replays an empty fresh display without allocating a child or thread", async () => {
  const f = fixture(), snapshots: unknown[] = [];
  f.host.scheduleHistoryReplay(async read => { snapshots.push(await read()); });
  await vi.waitFor(() => expect(snapshots).toEqual([{ coverage: "full", logs: [] }]));
  expect(f.createSession).not.toHaveBeenCalled();expect(f.sent).toEqual([]);
});

it("coalesces pending history after settlement and holds the next turn through publication", async () => {
  const f = fixture(), gate = deferred(), publication = deferred(), order: string[] = [];
  await f.host.send("A");await f.until(1);await f.host.send("B");
  f.host.scheduleHistoryReplay(async () => { order.push("obsolete"); });
  f.holdHistory = gate.promise;
  f.host.scheduleHistoryReplay(async read => {
    order.push("read");expect(f.finals).toHaveBeenCalledTimes(1);
    const snapshot = await read();expect(snapshot.coverage).toBe("full");
    order.push("publish");await publication.promise;order.push("complete");
  });
  f.send({ method: "item/completed", params: { threadId: "thread", turnId: "turn-1",
    item: { id: "active", type: "agentMessage", text: "STILL_ACTIVE" } } });
  await vi.waitFor(() => expect(f.logs.some(e => e.payload.text === "STILL_ACTIVE")).toBe(true));
  expect(order).toEqual([]);
  f.terminal();await vi.waitFor(() => expect(order).toEqual(["read"]));
  expect(f.turns()).toHaveLength(1);gate.resolve();await vi.waitFor(() => expect(order).toEqual(["read", "publish"]));
  expect(f.turns()).toHaveLength(1);publication.resolve();await f.until(2);
  expect(order).toEqual(["read", "publish", "complete"]);expect(f.maxActive).toBe(1);f.terminal();
  await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(2));expect(f.ends.mock.calls.every(([x]) => x.terminal === "turn.completed")).toBe(true);
});

it("keeps turn admission open after an incomplete resume history read", async () => {
  const f = fixture({ resumeSessionId: "thread" });f.invalidHistory = true;let coverage: string | undefined;
  f.host.scheduleHistoryReplay(async read => { coverage = (await read()).coverage; });
  await vi.waitFor(() => expect(coverage).toBe("incomplete"));
  await f.host.send("live");await f.until(1);f.terminal();await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(1));
  expect(f.ends.mock.calls[0]?.[0].terminal).toBe("turn.completed");expect(f.createSession).toHaveBeenCalledTimes(1);
});

it.each(["close", "disconnect"])("releases a pending history read on %s without inventing a result", async mode => {
  const f = fixture({ resumeSessionId: "thread" }), gate = deferred();f.holdHistory = gate.promise;
  let published = false;
  f.host.scheduleHistoryReplay(async read => { await read();published = true; });
  await vi.waitFor(() => expect(f.sent.some(r => r.method === "thread/read")).toBe(true));
  if (mode === "close") f.host.close();else f.exit();
  await f.running;expect(published).toBe(false);expect(f.logs.filter(e => e.type === "result")).toHaveLength(0);
  expect(f.starts).not.toHaveBeenCalled();expect(f.ends).not.toHaveBeenCalled();expect(f.finals).not.toHaveBeenCalled();
});
