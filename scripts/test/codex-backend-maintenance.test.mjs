import "./fixtures/test-isolation.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../codex-backend-compatibility.mjs";

const host = "maintenance", agent = host + ".codex", other = host + ".other";
const revision = "a".repeat(40), invocation = "b".repeat(32), instance = "12345678-1234-1234-1234-123456789abc";
const hash = value => createHash("sha256").update(value).digest("hex");
const child = id => ({ agent_id: id, stopping: false, restarting: false, reset_pending: false });
const row = (id, engine = "codex") => ({ id, engine, directory: true, live: false, connected: false,
  pointer: "nil", reset_pending: false, transition_pending: false });
const args = (phase, ...extra) => ["--phase", phase, "--host", host, "--runner-sha", revision,
  "--compose-file", "fixture.yml", "--runner-config", "fixture.json", "--runner-unit", "fixture.service",
  ...(phase === "observe" ? ["--phase-target", "remove-pin"] : ["--maintenance-evidence", "maintenance.json"]),
  ...(phase === "restore-fresh" ? ["--agent", agent, "--backend", "exec", "--operator-config", "operator.json"] : []), ...extra];
const io = () => ({ stdout: { text: "", write(s) { this.text += s; } }, stderr: { text: "", write(s) { this.text += s; } } });

function fixture() {
  const state = {
    h: { schema: 1, host, rows: [row(agent), { ...row(other, "claude-code"), pointer: "non_nil", connected: true, live: true }] },
    r: { host, runnerSha: revision, invocationId: invocation, configHash: "c".repeat(64), configMtimeMs: 1000,
      configuredBackend: "exec", appliedBackend: "exec", appliedReceipt: { backend: "exec", source: "reload", timestampUs: 2_000_000 } },
    s: { version: "0", schema: 1, host, build_revision: revision, pid: 100, owner: "#PID<1.2.3>", instance_id: instance,
      request_id: "r".repeat(32), applied_backend: "exec", children: [], pending_spawns: [], pending_switches: [],
      invocationId: invocation, configHash: "c".repeat(64), configMtimeMs: 1000 },
    evidence: null, hook: () => {},
  };
  const calls = { host: 0, runner: 0, supervisor: 0, evidence: 0, cursor: 0, write: 0, ack: 0, open: 0, restore: 0, close: 0 };
  const record = key => { calls[key]++; state.hook(key, calls[key]); };
  const adapters = {
    async observeHost() { record("host"); return structuredClone(state.h); },
    async observeRunner() { record("runner"); return structuredClone(state.r); },
    async observeSupervisor() { record("supervisor"); return structuredClone({ ...state.s, request_id: String(calls.supervisor).padStart(32, "0") }); },
    async readMaintenanceEvidence() { record("evidence"); return state.evidence; },
    async captureAckCursor() { record("cursor"); return "cursor"; },
    async writeBackend({ selection }) {
      record("write");
      const backend = selection === "omitted" ? "app-server" : selection;
      Object.assign(state.r, { configuredBackend: selection, appliedBackend: backend, configHash: "d".repeat(64), configMtimeMs: 2000,
        appliedReceipt: { backend, source: "reload", timestampUs: 3_000_000 } });
      Object.assign(state.s, { applied_backend: backend, configHash: state.r.configHash, configMtimeMs: state.r.configMtimeMs });
      return { configHash: state.r.configHash, configMtimeMs: state.r.configMtimeMs };
    },
    async waitForAppliedBackend() { record("ack"); return true; },
    async openOperator() {
      record("open");
      return { async restore(id) { record("restore"); state.h.rows.find(r => r.id === id).connected = true; state.s.children.push(child(id)); },
        async close() { record("close"); } };
    },
  };
  return { state, calls, adapters };
}

async function accept(f, phase = "remove-pin") {
  const output = io(), argv = args("observe");
  argv[argv.indexOf("--phase-target") + 1] = phase;
  if (phase === "restore-fresh") argv.push("--agent", agent, "--backend", "exec");
  assert.equal(await main(argv, f.adapters, output), 0, output.stderr.text);
  const evidence = JSON.parse(output.stdout.text).maintenance_template;
  evidence.maintenance_owner_accepted = true;
  for (const entry of evidence.agents) {
    entry.current_backend = entry.classification === "codex" ? "exec" : "not-applicable";
    entry.evidence_refs = ["isolated-test-record"];
  }
  f.state.evidence = JSON.stringify(evidence);
  Object.keys(f.calls).forEach(key => { f.calls[key] = 0; });
  return evidence;
}

test("observe emits actual identities and the full roster without opening any mutation or credential adapter", async () => {
  const f = fixture(), output = io();
  for (const key of ["readMaintenanceEvidence", "captureAckCursor", "writeBackend", "waitForAppliedBackend", "openOperator"]) {
    f.adapters[key] = () => { assert.fail("observe reached " + key); };
  }
  assert.equal(await main(args("observe"), f.adapters, output), 0, output.stderr.text);
  const { maintenance_template: t } = JSON.parse(output.stdout.text);
  assert.equal(t.binding.owner, f.state.s.owner);
  assert.equal(t.binding.instance_id, instance);
  assert.deepEqual(t.binding.host_rows, f.state.h.rows);
  assert.deepEqual(t.agents.map(r => r.id), [agent, other]);
  assert.equal(t.maintenance_owner_accepted, false);
  assert.ok(t.agents.every(r => r.current_backend === "unknown" && r.evidence_refs.length === 0));
  assert.deepEqual([f.calls.host, f.calls.runner, f.calls.supervisor], [2, 2, 1]);
});

test("an unaccepted but otherwise complete template cannot reach a write", async () => {
  const f = fixture(), evidence = await accept(f), output = io();
  evidence.maintenance_owner_accepted = false;
  f.state.evidence = JSON.stringify(evidence);
  assert.equal(await main(args("remove-pin"), f.adapters, output), 1);
  assert.match(output.stderr.text, /maintenance-not-accepted/);
  assert.equal(f.calls.write, 0);
  assert.equal(f.calls.cursor, 0);
});

test("all non-restore phases reject operator-config before reading any adapter", async () => {
  for (const phase of ["prepare", "observe", "remove-pin", "pin-exec-fresh"]) {
    let opened = 0;
    const forbidden = new Proxy({}, { get() { opened++; throw new Error("unexpected read"); } });
    const argv = phase === "prepare" ? ["--phase", phase, "--host", host, "--runner-sha", revision, "--adapter-module", "unread.mjs", "--origin-evidence", "origin.json"] : args(phase);
    const output = io();
    assert.equal(await main([...argv, "--operator-config", "never-read.json"], forbidden, output), 1);
    assert.match(output.stderr.text, /invalid-arguments/);
    assert.equal(opened, 0);
  }
});

test("remove-pin changes only explicit exec and returns the exact accepted bytes hash", async () => {
  const f = fixture(); await accept(f);
  f.state.evidence += "\n ";
  const output = io();
  assert.equal(await main(args("remove-pin"), f.adapters, output), 0, output.stderr.text);
  assert.equal(JSON.parse(output.stdout.text).maintenance_evidence_sha256, hash(f.state.evidence));
  assert.equal(f.state.r.configuredBackend, "omitted");
  assert.deepEqual([f.calls.write, f.calls.ack, f.calls.open, f.calls.restore], [1, 1, 0, 0]);
});

for (const configured of ["omitted", "app-server"]) {
  test("remove-pin refuses source " + configured, async () => {
    const f = fixture(); Object.assign(f.state.r, { configuredBackend: configured, appliedBackend: "app-server" });
    f.state.s.applied_backend = "app-server";
    const e = await accept(f); e.agents[0].current_backend = "app-server"; f.state.evidence = JSON.stringify(e);
    const output = io(); assert.equal(await main(args("remove-pin"), f.adapters, output), 1);
    assert.match(output.stderr.text, /remove-pin-source-not-exec/); assert.equal(f.calls.write, 0);
  });
}

const refusals = {
  "non-nil target": f => { f.state.h.rows[0].pointer = "non_nil"; },
  "missing target": f => { f.state.h.rows[0].pointer = "missing"; },
  "connected target": f => { f.state.h.rows[0].connected = true; },
  "reset pending": f => { f.state.h.rows[0].reset_pending = true; },
  "non-Codex transition pending": f => { f.state.h.rows[1].transition_pending = true; },
  "child": f => { f.state.s.children = [child(agent)]; },
  "pending spawn": f => { f.state.s.pending_spawns = [agent]; },
  "pending switch": f => { f.state.s.pending_switches = [agent]; },
};
for (const [name, change] of Object.entries(refusals)) test("fresh boundary rejects " + name, async () => {
  const f = fixture(); change(f); await accept(f);
  const output = io(); assert.equal(await main(args("remove-pin"), f.adapters, output), 1, name);
  assert.equal(f.calls.write, 0); assert.equal(f.calls.restore, 0);
  assert.match(output.stderr.text, /host-not-fresh|pending-lifecycle|supervisor-not-empty/);
});

for (const [name, change] of Object.entries({
  owner: f => { f.state.s.owner = "#PID<1.2.4>"; },
  instance: f => { f.state.s.instance_id = "22345678-1234-1234-1234-123456789abc"; },
  roster: f => { f.state.h.rows.push(row(host + ".new", "grok")); },
  evidence: f => { f.state.evidence += " "; },
  config: f => { f.state.r.configHash = f.state.s.configHash = "e".repeat(64); },
})) test("immediate recheck rejects changed " + name, async () => {
  const f = fixture(); await accept(f);
  f.state.hook = key => { if (key === "cursor") change(f); };
  const output = io(); assert.equal(await main(args("remove-pin"), f.adapters, output), 1);
  assert.match(output.stderr.text, /observation-changed|maintenance-evidence-changed/); assert.equal(f.calls.write, 0);
});

test("failure after the write does not restore a pin or send restore", async () => {
  const f = fixture(); await accept(f);
  f.adapters.waitForAppliedBackend = async () => false;
  const output = io(); assert.equal(await main(args("remove-pin"), f.adapters, output), 1);
  assert.match(output.stderr.text, /after-write/);
  assert.equal(f.state.r.configuredBackend, "omitted"); assert.equal(f.calls.write, 1); assert.equal(f.calls.restore, 0);
});

test("pin-exec-fresh already-selected still requires fresh work and matching observations", async () => {
  const f = fixture(); await accept(f, "pin-exec-fresh"); const output = io();
  assert.equal(await main(args("pin-exec-fresh"), f.adapters, output), 0);
  assert.equal(JSON.parse(output.stdout.text).status, "already-selected"); assert.equal(f.calls.write, 0); assert.equal(f.calls.cursor, 0);
  assert.equal(f.calls.supervisor, 2);
});

test("restore-fresh permits a connected same-backend sibling and checks actual target connection", async () => {
  const f = fixture(), sibling = host + ".sibling";
  f.state.h.rows.push({ ...row(sibling), connected: true, pointer: "non_nil" }); f.state.s.children.push(child(sibling));
  await accept(f, "restore-fresh"); const output = io();
  assert.equal(await main(args("restore-fresh"), f.adapters, output), 0, output.stderr.text);
  assert.equal(JSON.parse(output.stdout.text).status, "restored");
  assert.deepEqual([f.calls.write, f.calls.open, f.calls.restore, f.calls.close, f.calls.supervisor], [0, 1, 1, 1, 3]);
});

test("restore transport failure is uncertain and never retried", async () => {
  const f = fixture(); await accept(f, "restore-fresh");
  f.adapters.openOperator = async () => ({ restore() { f.calls.restore++; throw new Error("private detail"); }, close() { f.calls.close++; } });
  const output = io(); assert.equal(await main(args("restore-fresh"), f.adapters, output), 1);
  assert.match(output.stderr.text, /restore-outcome-unknown/); assert.doesNotMatch(output.stderr.text, /private detail/);
  assert.equal(f.calls.restore, 1); assert.equal(f.calls.close, 1);
});

for (const [name, change] of Object.entries({
  "unknown field": e => { e.extra = true; },
  "wrong phase": e => { e.phase = "pin-exec-fresh"; },
  "wrong host": e => { e.host = "different"; },
  "wrong target": e => { e.agent = agent; },
  "wrong backend": e => { e.target_backend = "exec"; },
  "wrong binding": e => { e.binding.instance_id = "unrelated"; },
  "duplicate id": e => { e.agents.push(e.agents[0]); },
  "missing non-Codex id": e => { e.agents.pop(); },
  "extra id": e => { e.agents.push({ ...e.agents[0], id: host + ".unknown" }); },
  "unknown classification": e => { e.agents[0].classification = "unknown"; },
  "contradicting engine": e => { e.agents[0].classification = "not-codex"; },
  "unknown routing": e => { e.agents[0].current_backend = "unknown"; },
  "mixed routing": e => { e.agents[0].current_backend = "app-server"; },
  "non-Codex routing": e => { e.agents[1].current_backend = "exec"; },
  "empty evidence refs": e => { e.agents[0].evidence_refs = []; },
})) test("maintenance record rejects " + name, async () => {
  const f = fixture(), e = await accept(f); change(e); f.state.evidence = JSON.stringify(e);
  const output = io(); assert.equal(await main(args("remove-pin"), f.adapters, output), 1, name);
  assert.equal(f.calls.write, 0); assert.equal(f.calls.open, 0);
  assert.match(output.stderr.text, /maintenance-/);
});

test("none routing requires an actually empty lifecycle", async () => {
  for (const change of [f => { f.state.h.rows[0].connected = true; }, f => { f.state.h.rows[0].pointer = "non_nil"; }, f => { f.state.s.children.push(child(agent)); }]) {
    const f = fixture(); change(f); const e = await accept(f); e.agents[0].current_backend = "none"; f.state.evidence = JSON.stringify(e);
    const output = io(); assert.equal(await main(args("remove-pin"), f.adapters, output), 1);
    assert.match(output.stderr.text, /maintenance-routing-conflict/); assert.equal(f.calls.write, 0);
  }
});

test("inner bundle changes cannot produce a maintenance template", async () => {
  const f = fixture(); f.state.hook = (key, n) => { if (key === "runner" && n === 2) f.state.r.configHash = "e".repeat(64); };
  const output = io(); assert.equal(await main(args("observe"), f.adapters, output), 1);
  assert.match(output.stderr.text, /observation-changed/); assert.equal(output.stdout.text, "");
});

for (const [name, change] of Object.entries({
  pid: f => { f.state.s.pid = -1; },
  revision: f => { f.state.s.build_revision = "e".repeat(40); },
  config: f => { f.state.s.configHash = "e".repeat(64); },
  applied: f => { f.state.s.applied_backend = "app-server"; },
  duplicate: f => { f.state.s.pending_spawns = [agent, agent]; },
  foreign: f => { f.state.s.pending_spawns = ["foreign.agent"]; },
})) test("Supervisor boundary rejects " + name, async () => {
  const f = fixture(); change(f); const output = io();
  assert.equal(await main(args("observe"), f.adapters, output), 1); assert.equal(output.stdout.text, "");
  assert.match(output.stderr.text, /supervisor-/);
});

for (const [name, change] of Object.entries({
  "wrapper receipt": f => { f.state.r.appliedReceipt.source = "wrapper"; },
  "old receipt": f => { f.state.r.appliedReceipt.timestampUs = 0; },
  "wrong receipt backend": f => { f.state.r.appliedReceipt.backend = "exec"; },
  "different written bytes": f => { f.state.r.configHash = f.state.s.configHash = "e".repeat(64); },
  "new owner": f => { f.state.s.owner = "#PID<1.2.4>"; },
  "new work": f => { f.state.s.children.push(child(agent)); },
})) test("post-write verification refuses " + name, async () => {
  const f = fixture(); await accept(f); f.state.hook = key => { if (key === "ack") change(f); };
  const output = io(); assert.equal(await main(args("remove-pin"), f.adapters, output), 1);
  assert.match(output.stderr.text, /applied-selection-unverified/); assert.equal(f.calls.write, 1); assert.equal(f.calls.restore, 0);
});

test("restore reply alone is insufficient without the observed connection", async t => {
  const f = fixture(); await accept(f, "restore-fresh");
  f.adapters.openOperator = async () => ({ restore() { f.calls.restore++; f.state.s.children.push(child(agent)); }, close() {} });
  let now = 0; t.mock.method(Date, "now", () => now += 31_000);
  const output = io(); assert.equal(await main(args("restore-fresh"), f.adapters, output), 1);
  assert.match(output.stderr.text, /restore-unconfirmed/); assert.equal(f.calls.restore, 1);
});

test("restore rejects a non-fresh target before opening credentials", async () => {
  for (const change of [f => { f.state.h.rows[0].pointer = "non_nil"; }, f => { f.state.h.rows[0].connected = true; }, f => { f.state.s.pending_spawns.push(agent); }]) {
    const f = fixture(); change(f); await accept(f, "restore-fresh"); const output = io();
    assert.equal(await main(args("restore-fresh"), f.adapters, output), 1);
    assert.match(output.stderr.text, /target-not-fresh/); assert.equal(f.calls.open, 0);
  }
});

test("default local observe and remove-pin use real evidence and config bytes", async t => {
  const root = await mkdtemp(join(tmpdir(), "kogane564-maintenance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "runner.json"), evidencePath = join(root, "maintenance.json");
  await writeFile(configPath, JSON.stringify({ host_id: host, codex: { backend: "exec", model: "preserved" }, capabilities: ["codex"] }));
  const f = fixture(); let cursorCalls = 0;
  // Synchronous command boundary; the RPC payload matches the producer contract.
  const { readFileSync, statSync } = await import("node:fs");
  const runCommand = (command, argv) => {
    const bytes = readFileSync(configPath), config = JSON.parse(bytes), backend = config.codex.backend ?? "app-server";
    if (command === "systemctl") return argv.includes("MainPID") ? "100" : invocation;
    if (command === "docker") return JSON.stringify(argv.at(-1).includes("observe_host") ? f.state.h : { ...f.state.s, applied_backend: backend });
    if (argv.includes("--show-cursor")) { cursorCalls++; return "-- cursor: test-cursor"; }
    if (argv.some(a => a.startsWith("--after-cursor="))) return `runner: codex backend=${backend} for subsequent wrappers`;
    if (argv.includes("--output=cat")) return `runner: host=${host} rev=${revision} connecting to ws://example.invalid/runner`;
    return JSON.stringify({ MESSAGE: `runner: codex backend=${backend} for subsequent wrappers`, __REALTIME_TIMESTAMP: Math.floor(statSync(configPath).mtimeMs * 1000) + 1000 });
  };
  const localArgs = phase => {
    const a = args(phase); a[a.indexOf("--runner-config") + 1] = configPath;
    if (phase !== "observe") a[a.indexOf("--maintenance-evidence") + 1] = evidencePath;
    return a;
  };
  const observed = io(); assert.equal(await main(localArgs("observe"), undefined, observed, { runCommand }), 0, observed.stderr.text);
  assert.equal(cursorCalls, 0);
  const e = JSON.parse(observed.stdout.text).maintenance_template;
  assert.equal(e.binding.config_sha256, hash(await readFile(configPath)));
  e.maintenance_owner_accepted = true;
  for (const r of e.agents) { r.current_backend = r.classification === "codex" ? "exec" : "not-applicable"; r.evidence_refs = ["synthetic source"]; }
  await writeFile(evidencePath, JSON.stringify(e));
  const output = io(); assert.equal(await main(localArgs("remove-pin"), undefined, output, { runCommand }), 0, output.stderr.text);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).codex, { model: "preserved" });
  assert.equal(JSON.parse(output.stdout.text).maintenance_evidence_sha256, hash(await readFile(evidencePath)));
  assert.equal(cursorCalls, 1);
});
