import { expect, it, vi } from "vitest";
import { makeLog, type WrapperConfig, type SidecarRecord } from "@kaoiro/agent-common";
import { CodexHistoryReplay, type AppServerHistoryJob } from "../src/app_server_replay.js";
import { MAX_HISTORY } from "../src/history.js";

const config: WrapperConfig = { agent_id: "history", persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P", server_url: "ws://unused" };
const row = (text: string, kind: "assistant" | "user" = "assistant") => makeLog(config, "idle", "T", { kind, text });
function deferred() { let resolve!: () => void;const promise = new Promise<void>(r => { resolve = r; });return { promise, resolve }; }
function fixture(backend: "exec" | "app-server" = "app-server", resume = true) {
  const events: unknown[] = [], jobs: AppServerHistoryJob[] = [];
  let connected = true, generation = 1;
  const readTranscript = vi.fn(() => [row("exec")]), readSidecar = vi.fn((): SidecarRecord[] => []), warn = vi.fn();
  const replay = new CodexHistoryReplay({ backend: () => backend, schedule: job => jobs.push(job),
    captureFence: () => { const captured = generation;return () => connected && captured === generation; },
    seedState: () => events.push("state"), sessionId: () => "thread", readTranscript, readSidecar,
    sendHistoryReset: id => events.push(["reset", id]), sendEnvelope: e => events.push(e),
    sendReplayIa: id => events.push(["ia", id]), sendHistoryReplayComplete: id => events.push(["complete", id]),
    ...(resume ? { legacyResumeSessionId: "thread" } : {}), warn });
  const verdict = (id: string) => replay.onVerdict({ replay_required: true, replay_id: id });
  return { replay, events, jobs, readTranscript, readSidecar, warn, verdict,
    disconnect: () => { connected = false; }, rejoin: () => { generation += 1;connected = true; } };
}

it.each(["full", "tail"] as const)("publishes %s in bounded display order only after readiness and asynchronous completion", async coverage => {
  const f = fixture(), logs = [row("first"), row("last")];f.verdict("r1");expect(f.jobs).toHaveLength(0);
  f.replay.markReady();expect(f.jobs).toHaveLength(1);const gate = deferred();
  const job = f.jobs[0]!(async () => { await gate.promise;return { coverage, logs }; });
  expect(f.events).toEqual([]);gate.resolve();await job;
  expect(f.events).toEqual(["state", ["reset", "r1"], ...logs, ["complete", "r1"]]);
  expect(f.readTranscript).not.toHaveBeenCalled();expect(f.readSidecar).toHaveBeenCalledTimes(1);
});

it("leaves the projection intact on incomplete history and retries only a new modern replay id", async () => {
  const f = fixture();f.replay.markReady();f.verdict("r1");
  await f.jobs[0]!(async () => ({ coverage: "incomplete", reason: "invalid_response", logs: [row("partial")] }));
  expect(f.events).toEqual([]);expect(f.readSidecar).not.toHaveBeenCalled();expect(f.warn).toHaveBeenCalledTimes(1);
  expect(f.warn.mock.calls[0]?.[0]).toContain("history_unavailable: invalid_response");
  f.verdict("r1");expect(f.jobs).toHaveLength(1);
  f.rejoin();f.verdict("r2");f.verdict("r2");expect(f.jobs).toHaveLength(2);
  await f.jobs[1]!(async () => ({ coverage: "full", logs: [row("retry")] }));
  expect(f.events).toEqual(["state", ["reset", "r2"], row("retry"), ["complete", "r2"]]);
});

it("does not retry a legacy resume after incomplete history or read a fresh legacy session", async () => {
  const f = fixture();f.replay.onVerdict(null);f.replay.markReady();
  await f.jobs[0]!(async () => ({ coverage: "incomplete", reason: "rpc_rejected", logs: [] }));
  f.rejoin();f.replay.onVerdict(null);expect(f.jobs).toHaveLength(1);expect(f.events).toEqual([]);
  const fresh = fixture("app-server", false);fresh.replay.onVerdict(null);fresh.replay.markReady();expect(fresh.jobs).toHaveLength(0);
});

it("discards an obsolete snapshot and carries user rows through the replacement replay", async () => {
  const f = fixture(), gate = deferred();f.replay.markReady();f.verdict("old");
  const old = f.jobs[0]!(async () => { await gate.promise;return { coverage: "full", logs: [row("obsolete")] }; });
  f.replay.sendLiveLog(row("queued", "user"));f.replay.sendLiveLog(row("live assistant"));
  f.rejoin();f.verdict("new");gate.resolve();await old;
  expect(f.events).toEqual([row("live assistant")]);
  await f.jobs[1]!(async () => ({ coverage: "full", logs: [row("current")] }));
  expect(f.events).toEqual([row("live assistant"), "state", ["reset", "new"], row("current"), ["complete", "new"], row("queued", "user")]);
});

it("never publishes into a disconnected socket before a replacement verdict arrives", async () => {
  const f = fixture(), gate = deferred();f.replay.markReady();f.verdict("old");
  const old = f.jobs[0]!(async () => { await gate.promise;return { coverage: "full", logs: [row("obsolete")] }; });
  f.replay.sendLiveLog(row("queued", "user"));f.disconnect();gate.resolve();await old;expect(f.events).toEqual([]);
  f.rejoin();f.replay.onVerdict({ replay_required: false });expect(f.events).toEqual([row("queued", "user")]);
});

it("bounds only the user rows held during read and synchronous replay publication", async () => {
  const f = fixture(), gate = deferred();f.replay.markReady();f.replay.sendLiveLog(row("before", "user"));f.verdict("r");
  const job = f.jobs[0]!(async () => { await gate.promise;return { coverage: "full", logs: [] }; });
  for (let n = 0; n <= MAX_HISTORY; n++) f.replay.sendLiveLog(row(String(n), "user"));
  expect(f.events).toEqual([row("before", "user")]);gate.resolve();await job;
  expect(f.events).toEqual([row("before", "user"), "state", ["reset", "r"], ["complete", "r"], ...Array.from({ length: MAX_HISTORY }, (_, n) => row(String(n + 1), "user"))]);
  f.replay.sendLiveLog(row("after", "user"));expect(f.events.at(-1)).toEqual(row("after", "user"));
});

it("releases buffered user rows after incomplete history without a reset", async () => {
  const f = fixture(), gate = deferred();f.replay.markReady();f.verdict("r");
  const job = f.jobs[0]!(async () => { await gate.promise;return { coverage: "incomplete", logs: [] }; });
  f.replay.sendLiveLog(row("queued", "user"));gate.resolve();await job;
  expect(f.events).toEqual([row("queued", "user")]);expect(f.warn).toHaveBeenCalledTimes(1);
});

it("coalesces obsolete requests before reading and suppresses publication after close", async () => {
  const f = fixture();f.replay.markReady();f.verdict("old");f.verdict("new");
  const read = vi.fn(async () => ({ coverage: "full" as const, logs: [] }));await f.jobs[0]!(read);expect(read).not.toHaveBeenCalled();
  const gate = deferred(), job = f.jobs[1]!(async () => { await gate.promise;return { coverage: "full", logs: [] }; });
  f.replay.sendLiveLog(row("held", "user"));f.replay.close();gate.resolve();await job;expect(f.events).toEqual([]);
});

it("preserves synchronous exec replay and live log sending without scheduling an app-server read", () => {
  const f = fixture("exec");f.verdict("r");f.replay.markReady();
  expect(f.events).toEqual(["state", ["reset", "r"], row("exec"), ["complete", "r"]]);
  expect(f.readTranscript).toHaveBeenCalledWith("thread");expect(f.jobs).toHaveLength(0);
  f.replay.sendLiveLog(row("live", "user"));expect(f.events.at(-1)).toEqual(row("live", "user"));
});


it("keeps sidecar replay between transcript logs and completion", async () => {
  const f = fixture();f.readSidecar.mockReturnValue([{ ingress_stamp: [1, 1], envelope: row("sidecar") }]);
  f.replay.markReady();f.verdict("r");
  await f.jobs[0]!(async () => ({ coverage: "full", logs: [row("history")] }));
  expect(f.events).toEqual(["state", ["reset", "r"], row("history"), ["ia", "r"], ["complete", "r"]]);
});

it("does not replace an in-flight read with the same verdict", async () => {
  const f = fixture(), gate = deferred();f.replay.markReady();f.verdict("r");
  const job = f.jobs[0]!(async () => { await gate.promise;return { coverage: "full", logs: [row("history")] }; });
  f.verdict("r");gate.resolve();await job;expect(f.jobs).toHaveLength(1);
  expect(f.events).toEqual(["state", ["reset", "r"], row("history"), ["complete", "r"]]);
});

it("rejects a replay request without an id without reading or resetting", () => {
  const f = fixture();f.replay.markReady();f.replay.onVerdict({ replay_required: true });
  expect(f.jobs).toHaveLength(0);expect(f.events).toEqual([]);expect(f.warn).toHaveBeenCalledTimes(1);
});
