import { RecoveryReporter, readRecoveryCheckpoint } from "@kaoiro/wrapper-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../../../scripts/test/fixtures/test-isolation.mjs";
import { PermissionSyncTimeoutError } from "@kaoiro/wrapper-core";
import { afterEach, expect, it, vi } from "vitest";
import { SessionResetCoordinator, type WrapperConfig } from "@kaoiro/agent-common";
import { appServerHostFixture } from "./fixtures/host_app_server.js";
import * as turnDiagnostics from "../src/turn_diagnostics.js";

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
function fixture(...args: Parameters<typeof appServerHostFixture>) {
  const f = appServerHostFixture(...args);
  cleanup.push(f.close);
  return f;
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

it("skips an obsolete host-queued input before turn/start and preserves pending settings", async () => {
  let skip = false;
  const f = fixture({ prepareInput: token => token === "stale" && skip ? null : undefined });
  await f.host.send("active", undefined, [], "active");
  await f.until(1);
  await f.host.setModel("gpt-6-astra");
  await f.host.setEffort("low");
  await f.host.send("obsolete", undefined, ["closed"], "stale");
  skip = true;
  f.terminal();
  await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(2));
  expect(f.turns()).toHaveLength(1);
  expect(f.starts).toHaveBeenCalledTimes(1);
  expect(f.ends).toHaveBeenCalledTimes(1);
  expect(f.logs.filter(e => e.type === "result")).toHaveLength(1);
  expect(f.states.at(-1)?.state).toBe("waiting_input");
  expect(f.host.activeInterAgentTurnToken()).toBeNull();
  expect(f.createSession).toHaveBeenCalledTimes(1);

  await f.host.send("next", undefined, [], "next");
  await f.until(2);
  expect(f.turns()[1]?.params).toMatchObject({ model: "gpt-6-astra", effort: "low" });
  f.terminal();
});

it("replaces host-queued app-server text and conversation IDs at the final boundary", async () => {
  const f = fixture({ prepareInput: token => token === "queued"
    ? { text: "prepared text", conversationIds: ["survivor"] } : undefined });
  await f.host.send("active", undefined, [], "active");
  await f.until(1);
  await f.host.send("stale text", undefined, ["removed", "survivor"], "queued");
  f.terminal();
  await f.until(2);
  expect((f.turns()[1]?.params as { input: Array<{ text: string }> }).input[0]?.text).toBe("prepared text");
  expect(f.starts.mock.calls[1]?.[0]).toMatchObject({ turnToken: "queued", conversationIds: ["survivor"] });
  f.terminal();
  await vi.waitFor(() => expect(f.ends.mock.calls[1]?.[0]).toMatchObject({ conversationIds: ["survivor"] }));
});

it("does not emit an extra ready state when skipped input has a queued successor", async () => {
  const f = fixture({ prepareInput: token => token === "stale" ? null : undefined });
  await f.host.send("active", undefined, [], "active");
  await f.until(1);
  await f.host.send("obsolete", undefined, ["closed"], "stale");
  await f.host.send("next", undefined, ["open"], "next");
  const readyBefore = f.states.filter(e => e.state === "waiting_input").length;
  f.terminal();
  await f.until(2);
  expect(f.starts.mock.calls.map(([info]) => info.turnToken)).toEqual(["active", "next"]);
  expect(f.ends).toHaveBeenCalledTimes(1);
  expect(f.states.filter(e => e.state === "waiting_input")).toHaveLength(readyBefore + 1);
  expect(f.host.activeInterAgentTurnToken()).toBe("next");
  f.terminal();
});

it("does not emit ready when app-server input preparation closes the host", async () => {
  let f!: ReturnType<typeof fixture>;
  let readyAtClose = -1;
  f = fixture({ prepareInput: token => {
    if (token !== "stale") return undefined;
    readyAtClose = f.states.filter(e => e.state === "waiting_input").length;
    f.host.close();
    return null;
  } });
  await f.host.send("active", undefined, [], "active");
  await f.until(1);
  await f.host.send("obsolete", undefined, ["closed"], "stale");
  f.terminal();
  await f.running;
  expect(f.turns()).toHaveLength(1);
  expect(readyAtClose).toBeGreaterThanOrEqual(0);
  expect(f.states.filter(e => e.state === "waiting_input")).toHaveLength(readyAtClose);
  expect(f.host.activeInterAgentTurnToken()).toBeNull();
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

// issue #391 S1: AppServerRpc's own shutdownTimeoutMs default (5000ms)
// leaves almost no margin below the runner's RESET_TERMINATION_GRACE_MS
// (5000ms, runner/src/supervisor.ts) -- a SIGKILL escalation racing the
// runner's own SIGKILL. Pin that CodexHost's app-server wiring overrides
// it below that grace, not that AppServerRpc's own default changed (that
// default is a separate, deliberately conservative fallback for direct
// AppServerRpc/AppServerTransport callers that never construct through
// CodexHost).
it("wires the app-server child's shutdownTimeoutMs below the runner's reset grace", async () => {
  const f = fixture();
  await f.host.send("A");
  await vi.waitFor(() => expect(f.createSession).toHaveBeenCalledTimes(1));
  const options = f.createSession.mock.calls[0]?.[0] as { transport?: { shutdownTimeoutMs?: number } };
  expect(options.transport?.shutdownTimeoutMs).toBe(2_000);
});

// The runtime buffers notifications until the turn/start response, so these
// controls hold or reorder the response to separate "accepted" from dispatch
// and from the first notification.
const HANDOFF = { turnToken: "A", handoff: "turn_start_accepted" };
const settleWindow = () => new Promise<void>(resolve => setTimeout(resolve, 30));

it("reports the input handoff at the turn/start response, not at dispatch or the first notification", async () => {
  const handed = vi.fn(), f = fixture({ onInputHandedOff: handed });f.startReply = "held";
  await f.host.send("A", undefined, [], "A");await f.until(1);
  await vi.waitFor(() => expect(f.starts).toHaveBeenCalledTimes(1));await settleWindow();
  expect(handed).not.toHaveBeenCalled();
  f.releaseReply();await vi.waitFor(() => expect(handed).toHaveBeenCalledTimes(1));
  expect(handed).toHaveBeenCalledWith(HANDOFF);
  f.terminal();await vi.waitFor(() => expect(f.ends).toHaveBeenCalledTimes(1));
  expect(handed).toHaveBeenCalledTimes(1);
});

it("reports the input handoff once the response arrives even when no notification follows", async () => {
  const handed = vi.fn(), f = fixture({ onInputHandedOff: handed });f.startReply = "silent";
  await f.host.send("A", undefined, [], "A");
  await vi.waitFor(() => expect(handed).toHaveBeenCalledWith(HANDOFF));
  expect(f.ends).not.toHaveBeenCalled();f.terminal();
});

it("reports the input handoff before the turn ends when the terminal precedes the response", async () => {
  const order: string[] = [], f = fixture({ onInputHandedOff: () => order.push("handoff"), onTurnEnd: () => order.push("end") });
  f.startReply = "held-terminal";
  await f.host.send("A", undefined, [], "A");await f.until(1);await settleWindow();
  expect(order).toEqual([]);
  f.releaseReply();await vi.waitFor(() => expect(order).toEqual(["handoff", "end"]));
});

it("reports no input handoff when turn/start is rejected", async () => {
  const handed = vi.fn(), f = fixture({ onInputHandedOff: handed });f.startReply = "error";
  await f.host.send("A", undefined, [], "A");
  await vi.waitFor(() => expect(f.ends).toHaveBeenCalledTimes(1));
  expect(f.ends.mock.calls[0]?.[0]).toMatchObject({ turnToken: "A", error: { detail: expect.stringContaining("rejected") } });
  expect(handed).not.toHaveBeenCalled();
});

it("reports no input handoff for an input skipped before turn/start", async () => {
  const handed = vi.fn(), f = fixture({ onInputHandedOff: handed, prepareInput: () => null });
  await f.host.send("A", undefined, [], "A");
  await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(1));
  expect(f.turns()).toHaveLength(0);expect(handed).not.toHaveBeenCalled();
});

it("reports the input handoff exactly once after a superseded admission is retried", async () => {
  const { effort: _effort, ...withoutEffort } = config;
  const handed = vi.fn(), f = fixture({ onInputHandedOff: handed }, withoutEffort), gate = deferred();f.holdConfig = gate.promise;
  await f.host.setModel("gpt-6-astra");await f.host.send("A", undefined, [], "A");
  await vi.waitFor(() => expect(f.sent.some(r => r.method === "config/read")).toBe(true));
  await f.host.setModel("gpt-5.6-sol");gate.resolve();await f.until(1);
  await vi.waitFor(() => expect(handed).toHaveBeenCalledTimes(1));
  expect(f.sent.filter(r => r.method === "config/read").length).toBeGreaterThan(1);
  f.terminal();await vi.waitFor(() => expect(f.ends).toHaveBeenCalledTimes(1));
  expect(handed).toHaveBeenCalledTimes(1);
});

it("keeps the turn running when the input handoff callback throws", async () => {
  const f = fixture({ onInputHandedOff: () => { throw new Error("report failed"); } });
  await f.host.send("A", undefined, [], "A");await f.until(1);f.terminal();
  await vi.waitFor(() => expect(f.ends).toHaveBeenCalledTimes(1));
  expect(f.ends.mock.calls[0]?.[0].error).toBeUndefined();expect(f.createSession).toHaveBeenCalledTimes(1);
});

it("marks only the active turn's outcome unknown when the app-server ends after turn/start was written", async () => {
  const f = fixture();f.startReply = "exit";
  await f.host.send("A", undefined, [], "A");await f.host.send("B", undefined, [], "B");
  await vi.waitFor(() => expect(f.ends).toHaveBeenCalledTimes(2));
  const ended = (token: string) => f.ends.mock.calls.map(([info]) => info).find(info => info.turnToken === token)!;
  expect(ended("A").handoff).toEqual({ outcome: "unknown", reason: "turn_start_disconnected" });
  expect(ended("A").error?.reason).toBe("timeout");
  expect(ended("B")).not.toHaveProperty("handoff");
  expect(ended("B").error).toBeDefined();
  expect(ended("B").error).not.toHaveProperty("reason");
});

it("does not mark the outcome unknown when turn/start is rejected, skipped or succeeds", async () => {
  const rejected = fixture();rejected.startReply = "error";
  await rejected.host.send("A", undefined, [], "A");
  await vi.waitFor(() => expect(rejected.ends).toHaveBeenCalledTimes(1));
  expect(rejected.ends.mock.calls[0]![0]).not.toHaveProperty("handoff");
  expect(rejected.ends.mock.calls[0]![0].error).not.toHaveProperty("reason");

  const skipped = fixture({ prepareInput: () => null });
  await skipped.host.send("A", undefined, [], "A");
  await vi.waitFor(() => expect(skipped.finals).toHaveBeenCalledTimes(1));
  expect(skipped.ends).not.toHaveBeenCalled();

  const ok = fixture();
  await ok.host.send("A", undefined, [], "A");await ok.until(1);ok.terminal();
  await vi.waitFor(() => expect(ok.ends).toHaveBeenCalledTimes(1));
  expect(ok.ends.mock.calls[0]![0]).not.toHaveProperty("handoff");
});

const contextCounts = { inputTokens: 23955, cachedInputTokens: 100, outputTokens: 263, reasoningOutputTokens: 252, totalTokens: 24218 };
const contextUsage = (window: number | null = 258400) => ({ last: contextCounts, total: { ...contextCounts, totalTokens: 900000 }, modelContextWindow: window });
const contextOf = (f: ReturnType<typeof fixture>) => f.states.at(-1)?.ext?.context;
function contextFact(f: ReturnType<typeof fixture>, method: string, extra: Record<string, unknown>, turnId = "turn-1", threadId = "thread") {
  f.send({ method, params: { threadId, turnId, ...extra } });
}
function contextResponse(f: ReturnType<typeof fixture>, turn = "turn-1", window: number | null = 258400) {
  contextFact(f, "item/completed", { item: { id: "reply", type: "agentMessage", text: "DONE" } }, turn);
  contextFact(f, "thread/tokenUsage/updated", { tokenUsage: contextUsage(window) }, turn);
}
it("publishes committed context through transport, session and runtime, then retracts an idle boundary immediately", async () => {
  const f = fixture();await f.host.send("ordinary");await f.until(1);
  expect(f.states[0]?.ext?.session_capabilities).toMatchObject({ supports_context_usage: true });
  contextResponse(f);await new Promise(resolve => setImmediate(resolve));expect(contextOf(f)).toBeUndefined();
  f.terminal();await vi.waitFor(() => expect(contextOf(f)).toEqual({ used_tokens: 24218, max_tokens: 258400, used_percentage: 100 * (24218 / 258400) }));
  contextFact(f, "thread/tokenUsage/updated", { tokenUsage: contextUsage(null) }, "old");
  contextFact(f, "item/started", { item: { id: "other", type: "contextCompaction" } }, "manual", "other-thread");
  await new Promise(resolve => setImmediate(resolve));expect(contextOf(f)).toBeDefined();
  contextFact(f, "item/started", { item: { id: "compact", type: "contextCompaction" } }, "manual");
  await vi.waitFor(() => expect(contextOf(f)).toBeUndefined());
  contextFact(f, "item/completed", { item: { id: "compact", type: "contextCompaction" } }, "manual");
  contextFact(f, "thread/tokenUsage/updated", { tokenUsage: contextUsage() }, "turn-1");
  await new Promise(resolve => setImmediate(resolve));expect(contextOf(f)).toBeUndefined();
});
it("does not publish buffered usage across a compaction before its start reply", async () => {
  const f = fixture();f.startReply = "held";await f.host.send("buffered");await f.until(1);
  contextResponse(f);
  contextFact(f, "item/started", { item: { id: "compact", type: "contextCompaction" } });
  contextFact(f, "item/completed", { item: { id: "compact", type: "contextCompaction" } });
  f.terminal();f.releaseReply();await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(1));
  expect(contextOf(f)).toBeUndefined();
});
it("publishes buffered ordinary response only after the validated start and settings commit", async () => {
  const f = fixture();f.startReply = "held";await f.host.send("buffered");await f.until(1);contextResponse(f);f.terminal();
  await new Promise(resolve => setImmediate(resolve));expect(contextOf(f)).toBeUndefined();
  f.releaseReply();await vi.waitFor(() => expect(contextOf(f)).toBeDefined());
});
it("keeps a concurrent model request from publishing the old in-flight model, then recovers after the new model commits", async () => {
  const f = fixture();await f.host.send("old");await f.until(1);contextResponse(f);
  await f.host.setModel("gpt-6-sol");f.terminal();await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(1));expect(contextOf(f)).toBeUndefined();
  await f.host.send("new");await f.until(2);contextResponse(f, "turn-2");f.terminal();await vi.waitFor(() => expect(contextOf(f)).toBeDefined());
  await f.host.setModel("gpt-5.6-sol");expect(contextOf(f)).toBeUndefined();
});
it("retracts null windows and does not recover after failure or close", async () => {
  const f = fixture();await f.host.send("known");await f.until(1);contextResponse(f);f.terminal();await vi.waitFor(() => expect(contextOf(f)).toBeDefined());
  await f.host.send("null");await f.until(2);contextResponse(f, "turn-2", null);await vi.waitFor(() => expect(contextOf(f)).toBeUndefined());f.terminal();
  await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(2));await f.host.send("failure");await f.until(3);contextResponse(f, "turn-3");f.terminal("failed");
  await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(3));expect(contextOf(f)).toBeUndefined();
  await f.host.send("closing");await f.until(4);contextResponse(f, "turn-4");const beforeClose = f.states.length;f.host.close();await f.running;
  expect(f.states.slice(beforeClose).every(e => e.ext?.context === undefined)).toBe(true);
});
it("ignores old-turn and foreign-thread usage while an owned turn is active", async () => {
  const f = fixture();await f.host.send("known");await f.until(1);contextResponse(f);f.terminal();await vi.waitFor(() => expect(contextOf(f)).toBeDefined());
  await f.host.send("owned");await f.until(2);
  contextFact(f, "thread/tokenUsage/updated", { tokenUsage: contextUsage(null) }, "turn-1");
  contextFact(f, "thread/tokenUsage/updated", { tokenUsage: contextUsage(null) }, "turn-2", "foreign");
  await new Promise(resolve => setImmediate(resolve));expect(contextOf(f)).toBeDefined();
  contextResponse(f, "turn-2");f.terminal();await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(2));expect(contextOf(f)).toBeDefined();
});
it("keeps unknown across a failed model switch and recovers only on the rollback turn's response", async () => {
  const f = fixture();await f.host.send("known");await f.until(1);contextResponse(f);f.terminal();await vi.waitFor(() => expect(contextOf(f)).toBeDefined());
  await f.host.setModel("gpt-6-sol");expect(contextOf(f)).toBeUndefined();await f.host.send("switch");await f.until(2);contextResponse(f, "turn-2");f.terminal("failed");
  await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(2));expect(contextOf(f)).toBeUndefined();
  await f.host.send("rollback");await f.until(3);expect(contextOf(f)).toBeUndefined();contextResponse(f, "turn-3");f.terminal();await vi.waitFor(() => expect(contextOf(f)).toBeDefined());
});
it("does not qualify usage after a malformed response item", async () => {
  const f = fixture();await f.host.send("ordinary");await f.until(1);
  contextFact(f, "item/completed", { item: { type: "agentMessage", text: "no native identity" } });
  contextFact(f, "thread/tokenUsage/updated", { tokenUsage: contextUsage() });f.terminal();
  await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(1));expect(contextOf(f)).toBeUndefined();
});
it("withdraws at automatic compaction and publishes the post-boundary response in that same owned turn", async () => {
  const f = fixture();await f.host.send("known");await f.until(1);contextResponse(f);f.terminal();await vi.waitFor(() => expect(contextOf(f)).toBeDefined());
  await f.host.send("automatic");await f.until(2);
  contextFact(f, "item/started", { item: { id: "automatic", type: "contextCompaction" } }, "turn-2");
  await vi.waitFor(() => expect(contextOf(f)).toBeUndefined());
  contextFact(f, "thread/tokenUsage/updated", { tokenUsage: { ...contextUsage(), last: { ...contextCounts, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 69748 } } }, "turn-2");
  contextFact(f, "item/completed", { item: { id: "automatic", type: "contextCompaction" } }, "turn-2");
  contextFact(f, "item/completed", { item: { id: "reply", type: "agentMessage", text: "POST" } }, "turn-2");
  contextFact(f, "thread/tokenUsage/updated", { tokenUsage: { ...contextUsage(), last: { ...contextCounts, inputTokens: 136479, outputTokens: 7, reasoningOutputTokens: 0, totalTokens: 136486 } } }, "turn-2");
  await new Promise(resolve => setImmediate(resolve));expect(contextOf(f)).toBeUndefined();
  f.terminal();await vi.waitFor(() => expect(contextOf(f)).toMatchObject({ used_tokens: 136486, max_tokens: 258400 }));
});
it("withdraws a known context when close lands at the terminal before settings commit", async () => {
  let f!: ReturnType<typeof fixture>;
  f = fixture({ onTurnBoundary: event => { if (event.turnToken === "closing") f.host.close(); } });
  await f.host.send("known");await f.until(1);contextResponse(f);f.terminal();await vi.waitFor(() => expect(contextOf(f)).toBeDefined());
  await f.host.send("closing", undefined, [], "closing");await f.until(2);contextResponse(f, "turn-2");const beforeClose = f.states.length;f.terminal();await f.running;
  expect(f.states.slice(beforeClose).every(e => e.ext?.context === undefined)).toBe(true);
});
it("withdraws context from the watchdog error state", async () => {
  const f = fixture();await f.host.send("known");await f.until(1);contextResponse(f);f.terminal();await vi.waitFor(() => expect(contextOf(f)).toBeDefined());
  f.host.failStopForWatchdogAttributionUnknown();expect(f.states.at(-1)?.state).toBe("error");expect(contextOf(f)).toBeUndefined();
});
it("preserves the context when compatibility rejects a model request before acceptance", async () => {
  const launch = { ...config };delete launch.model;
  const f = fixture({ codexClientVersion: "0.144.1" }, launch);await f.host.send("known");await f.until(1);contextResponse(f);f.terminal();await vi.waitFor(() => expect(contextOf(f)).toBeDefined());
  await f.host.setModel("gpt-6-astra");expect(contextOf(f)).toBeDefined();expect(f.states.at(-1)?.ext?.switch_error).toMatchObject({ reason: "client_version_too_old" });
});

it("runs the app-server runtime when raw Host backend is omitted", async () => {
  const f = fixture({}, config, true);
  await f.host.send("omitted runtime", undefined, [], "default-turn");
  await f.until(1);
  expect(f.createSession).toHaveBeenCalledTimes(1);
  f.terminal(); await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(1));
});

it("settles permission sync expiry without opening app-server or losing pending settings",async()=>{
  let blocked=true;const f=fixture({waitForPermissionSync:()=>blocked?Promise.reject(new PermissionSyncTimeoutError()):Promise.resolve()});
  await f.host.setModel("gpt-6-sol");await f.host.send("blocked");await vi.waitFor(()=>expect(f.ends).toHaveBeenCalledTimes(1));
  expect(f.createSession).not.toHaveBeenCalled();expect(f.starts).not.toHaveBeenCalled();
  expect(f.logs.filter(e=>e.type==="result")).toEqual([expect.objectContaining({payload:expect.objectContaining({is_error:true,error_detail:expect.stringContaining("No execution was started")})})]);
  expect(f.host.statusExtSnapshot()).toMatchObject({pending_model:"gpt-6-sol"});expect(f.states.at(-1)?.state).toBe("waiting_input");
  blocked=false;await f.host.send("recovered");await f.until(1);f.terminal();await vi.waitFor(()=>expect(f.ends).toHaveBeenCalledTimes(2));
});

it("renames the display once per revision while preserving the persona through a turn", async () => {
  const f = fixture({}, { ...config });
  f.host.renameDisplayName("Renamed", 2);
  const before = f.states.length;
  f.host.renameDisplayName("Duplicate", 2);f.host.renameDisplayName("Stale", 1);
  expect(f.states).toHaveLength(before);
  await f.host.send("first");await f.until(1);f.terminal();
  await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(1));
  expect(f.states.at(-1)).toMatchObject({ display_name: "Renamed", persona: config.persona });
});

it("keeps effective settings and whoami unchanged until the successful next dispatch", async () => {
  const f = fixture({ modelSource: "config", effortSource: "config" });
  await f.host.send("first");await f.until(1);
  const before = f.host.statusSnapshot();
  await f.host.setModel("gpt-6-astra");await f.host.setEffort("low");
  expect(f.host.statusSnapshot().model).toBe(before.model);
  expect(f.sent.find(r => r.method === "thread/start")?.params).toMatchObject({ model: "gpt-5.6-sol" });
  expect(f.turns()[0]?.params).toMatchObject({ effort: "high" });
  f.terminal();await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(1));
  await f.host.send("second");await f.until(2);
  expect(f.turns()[1]?.params).toMatchObject({ model: "gpt-6-astra", effort: "low" });
  f.terminal();await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(2));
  expect(f.host.statusSnapshot()).toMatchObject({ model: "gpt-6-astra", effort: "low", session_id: "thread" });
  expect(f.host.statusExtSnapshot()).toMatchObject({ model: "gpt-6-astra", effort: "low" });
});

it("rolls a rejected model switch back on the same session and keeps the error for one stamp", async () => {
  const f = fixture({ modelSource: "config", effortSource: "config" });
  await f.host.send("first");await f.until(1);f.terminal();
  await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(1));
  await f.host.setModel("gpt-6-astra");f.startReply = "error";
  await f.host.send("rejected");await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(2));
  expect(f.host.statusSnapshot().model).toBe("gpt-5.6-sol");
  const errors = f.states.filter(e => e.ext?.switch_error);
  expect(errors).toHaveLength(1);
  expect(errors[0]?.ext.switch_error).toMatchObject({ kind: "model", requested: "gpt-6-astra", rolled_back_to: "gpt-5.6-sol" });
  f.startReply = "immediate";await f.host.send("retry");await f.until(3);
  expect(f.turns()[2]?.params).toMatchObject({ model: "gpt-5.6-sol" });
  f.terminal();await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(3));
  expect(f.createSession).toHaveBeenCalledTimes(1);
});

it("completes an app-server turn when diagnostic capture storage is unavailable", async () => {
  const f = fixture({ turnTraceDir: "/dev/null/kaoiro-trace" });
  await f.host.send("continue without diagnostic storage");
  await f.until(1);
  f.terminal();
  await vi.waitFor(() => expect(f.ends).toHaveBeenCalledOnce());
  expect(f.ends.mock.calls[0]?.[0]).not.toHaveProperty("error");
});

it("keeps an in-progress native thread candidate and confirms its actual terminal", async () => {
  const root = mkdtempSync(join(tmpdir(), "kaoiro-codex-recovery-")); const path = join(root, "checkpoint");
  const recovery = new RecoveryReporter({ ...config, recovery_checkpoint_path: path }, undefined, () => {});
  const f = fixture({ recovery }); cleanup.push(async () => { rmSync(root, { recursive: true, force: true }); });
  await f.host.send("first turn"); await f.until(1);
  expect(readRecoveryCheckpoint(path)).toMatchObject({ ok: true, record: { state: "unbound", candidate_id: "thread" } });
  f.terminal(); await vi.waitFor(() => expect(f.finals).toHaveBeenCalledTimes(1));
  expect(readRecoveryCheckpoint(path)).toMatchObject({ ok: true, record: { state: "live", session_id: "thread" } });
});
