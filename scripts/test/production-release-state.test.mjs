import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { artifactBuildIdentity, BUILD_REPOSITORY_ID } from "../build-identity.mjs";
import { startReleaseAttempt, assertCompletionEnrollment } from "../production-release-record.mjs";
import { ROOT_LAYOUT, RELEASE_STATES, assertGrammarCoverage, releaseName, releaseStateTable,
  validateReleaseContext, validateReleaseReason, validateReleaseSkip } from "../production-release-state.mjs";
import { acquireReleaseLock, releaseReleaseLock, releaseEntryInventory, releaseBytesDigest,
  releaseJsonBytes, writePrivateRecord } from "../production-release-files.mjs";
import { projectReleaseHistory, readReleaseAttempt, readReleaseHistory } from "../production-release-history.mjs";
import { archiveReleaseAttempt, terminateReleaseAttempt } from "../production-release-lifecycle.mjs";

const scratch = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
const fixture = () => {
  const base = mkdtempSync(join(tmpdir(), "kaoiro-release-state-test-"));
  scratch.push(base);
  const root = join(base, "history");
  mkdirSync(root, { mode: 0o700 });
  const revision = "a".repeat(40);
  const identity = artifactBuildIdentity({ revision, dirty: false, version: "2026.10.09.1", branch: "develop", channel: "dev",
    landing: { schema: 1, kind: "landing", repository_id: BUILD_REPOSITORY_ID, revision,
      branch: "develop", version: "2026.10.09.1", original_run_id: 1, created_at: "2026-10-09T00:00:00Z" } });
  const attempt = startReleaseAttempt(root, identity, ["worker-a"], []);
  return { base, root, identity, ...attempt };
};
const inventory = [{ alias: "worker-a", runtime_host_id: "private-machine-marker" }];
const inspection = (changes = {}) => ({ observed_at: new Date().toISOString(), simulation: false, activity: "idle",
  server_revision: "b".repeat(40), runner_revisions: [{ alias: "worker-a", revision: "b".repeat(40) }], ...changes });
const terminate = (f, command, changes = {}) => terminateReleaseAttempt({ root: f.root,
  uuid: f.plan?.attempt_uuid ?? f.uuid, command, reason: "operator confirmed unused or invalid attempt",
  inventory, inspectionProvider: async () => inspection(), ...changes });
const rawInventory = root => {
  const result = [];
  for (const name of readdirSync(root)) {
    result.push({ scope: "root", name, type: "directory" });
    const scope = name.startsWith(".lock.") ? "administrative" : "attempt";
    for (const entry of readdirSync(join(root, name), { withFileTypes: true })) {
      result.push({ scope, name: entry.name, type: entry.isDirectory() ? "directory" : "file" });
      if (entry.name === "incident-evidence") for (const child of readdirSync(join(root, name, entry.name))) {
        result.push({ scope: "incident", name: child, type: "file" });
      }
    }
  }
  return result;
};

test("production-default start through first history read uses real ownership, durable writes and grammar", () => {
  const f = fixture();
  const history = readReleaseHistory(f.root);
  assert.equal(history.rows.length, 1);
  assert.equal(history.rows[0].state.id, "in_progress");
  assert.equal(assertGrammarCoverage(rawInventory(f.root)), true);
  assert.deepEqual(readdirSync(f.dir), ["attempt.json"]);
});

test("grammar coverage rejects old-class unknown lock and new-class unknown quarantine independently", () => {
  const f = fixture();
  const lock = acquireReleaseLock(f.root, "history", "root");
  assertGrammarCoverage(rawInventory(f.root));
  releaseReleaseLock(lock);
  mkdirSync(join(f.root, ".lock.unregistered"), { mode: 0o700 });
  assert.throws(() => assertGrammarCoverage(rawInventory(f.root)), /unknown release history entry/);
  rmSync(join(f.root, ".lock.unregistered"), { recursive: true });
  writeFileSync(join(f.dir, "unregistered-quarantine.json"), "{}", { mode: 0o600 });
  assert.throws(() => assertGrammarCoverage(rawInventory(f.root)), /unknown release history entry/);
});

test("coverage checker self-test detects an observed name missing from the source table", () => {
  assert.throws(() => assertGrammarCoverage([{ scope: "root", name: ".lock.unregistered", type: "directory" }]), /unknown/);
  assert.throws(() => assertGrammarCoverage([{ scope: "attempt", name: "unregistered-quarantine.json", type: "file" }]), /unknown/);
  assert.equal(assertGrammarCoverage(ROOT_LAYOUT.map(rule => ({ scope: rule.scope,
    name: rule.scope === "root" && rule.id === "history-lock" ? ".lock.history" : "", type: rule.type })).filter(row => row.name)), true);
  assert.ok(RELEASE_STATES.every(state => state.disposition && state.exit && Array.isArray(state.guards)));
  assert.ok(releaseStateTable().includes("invalid_quarantined"));
});

test("recognized stale root lock is diagnostic; unknown entry is a refusal", () => {
  const f = fixture();
  mkdirSync(join(f.root, ".lock.history"), { mode: 0o700 });
  assert.equal(readReleaseHistory(f.root).rows[0].state.id, "in_progress");
  assert.equal(readReleaseHistory(f.root).diagnostics.length, 1);
  mkdirSync(join(f.root, "unknown"), { mode: 0o700 });
  assert.throws(() => readReleaseHistory(f.root), /unknown release history entry/);
});

test("quarantine closes known corruption without claiming publication and preserves bytes", async () => {
  const f = fixture();
  writeFileSync(join(f.dir, "completion.json"), "broken-completion", { mode: 0o600 });
  assert.equal(readReleaseHistory(f.root).rows[0].state.id, "invalid_completion");
  const terminal = await terminate(f, "quarantine");
  assert.equal(assertGrammarCoverage(rawInventory(f.root)), true);
  assert.equal(terminal.kind, "invalid_quarantined");
  assert.equal(readFileSync(join(f.dir, "completion.json"), "utf8"), "broken-completion");
  const row = readReleaseHistory(f.root).rows[0];
  assert.equal(row.state.id, "invalid_quarantined");
  assert.ok(projectReleaseHistory(readReleaseHistory(f.root)).rows.every(row => !JSON.stringify(row).includes("operator confirmed")));
  const archived = await archiveReleaseAttempt({ root: f.root, uuid: f.plan.attempt_uuid });
  assert.equal(archived.status, "invalid_quarantined");
  assert.equal(readFileSync(join(archived.destination, "completion.json"), "utf8"), "broken-completion");
});

test("corrupt quarantine record has a resumable evidence-preserving exit", async () => {
  const f = fixture();
  writeFileSync(join(f.dir, "completion.json"), "broken-completion", { mode: 0o600 });
  await terminate(f, "quarantine");
  writeFileSync(join(f.dir, "quarantine.json"), "broken-quarantine", { mode: 0o600 });
  assert.equal(readReleaseAttempt(f.dir).state.id, "invalid_completion");
  await terminate(f, "quarantine");
  assert.equal(readReleaseAttempt(f.dir).state.id, "invalid_quarantined");
  assert.equal(readFileSync(join(f.dir, "incident-evidence", `${releaseBytesDigest(Buffer.from("broken-quarantine"))}.raw`), "utf8"), "broken-quarantine");
});

test("empty legacy UUID is known-invalid and can quarantine using the enrolled inventory", async () => {
  const f = fixture();
  const uuid = randomUUID();
  mkdirSync(join(f.root, uuid), { mode: 0o700 });
  assert.equal(readReleaseAttempt(join(f.root, uuid)).state.id, "invalid_completion");
  await terminate({ root: f.root, uuid }, "quarantine");
  assert.equal(readReleaseAttempt(join(f.root, uuid)).state.id, "invalid_quarantined");
});

test("quarantine refuses valid in-progress and unknown identity records", async () => {
  const f = fixture();
  await assert.rejects(terminate(f, "quarantine"), /known invalid/);
  writeFileSync(join(f.dir, "attempt.json"), JSON.stringify({ ...f.plan, attempt_uuid: randomUUID() }), { mode: 0o600 });
  await assert.rejects(terminate(f, "quarantine"), /unknown identity/);
  assert.throws(() => readReleaseHistory(f.root), /unknown attempt identity/);
});

test("ordinary abandonment refuses each applied/live/activity condition", async () => {
  const f = fixture();
  await assert.rejects(terminate(f, "abandon", { inspectionProvider: async () => inspection({ server_revision: f.identity.revision }) }), /healthy server/);
  await assert.rejects(terminate(f, "abandon", { inspectionProvider: async () => inspection({ runner_revisions: [{ alias: "worker-a", revision: f.identity.revision }] }) }), /runner is still/);
  for (const state of ["active", "unknown"]) {
    await assert.rejects(terminate(f, "abandon", { inspectionProvider: async () => inspection({ activity: state }) }), /queued\/running\/unknown/);
  }
  writePrivateRecord(f.dir, "runner-after-worker-a.json", {}, { kind: "runner-fact" });
  await assert.rejects(terminate(f, "abandon"), /applied attempt/);
  const retired = await terminate(f, "retire-deployed");
  assert.equal(retired.kind, "deployed_uncompleted");
  assert.equal(readReleaseAttempt(f.dir).state.id, "deployed_uncompleted");
});

test("unused idle attempt abandons; terminal bytes are immutable and archivable", async () => {
  const f = fixture();
  await terminate(f, "abandon");
  assert.equal(readReleaseAttempt(f.dir).state.id, "abandoned");
  await assert.rejects(terminate(f, "abandon"), /immutable/);
  await assert.rejects(terminate(f, "quarantine"), /immutable/);
  await archiveReleaseAttempt({ root: f.root, uuid: f.plan.attempt_uuid });
  assert.deepEqual(readReleaseHistory(f.root).rows, []);
});

test("archive refuses active state, existing destination and unsafe type", async () => {
  const f = fixture();
  await assert.rejects(archiveReleaseAttempt({ root: f.root, uuid: f.plan.attempt_uuid }), /unresolved/);
  await terminate(f, "abandon");
  mkdirSync(`${f.root}-archive`, { mode: 0o700 });
  mkdirSync(join(`${f.root}-archive`, f.plan.attempt_uuid), { mode: 0o700 });
  await assert.rejects(archiveReleaseAttempt({ root: f.root, uuid: f.plan.attempt_uuid }), /already exists/);
  const uuid = randomUUID();
  symlinkSync(f.dir, join(f.root, uuid));
  await assert.rejects(archiveReleaseAttempt({ root: f.root, uuid }), /unsafe private/);
});

test("own context, exact skip set and Unicode reasons fail closed", () => {
  const uuid = randomUUID();
  assert.deepEqual(validateReleaseContext(uuid, "a".repeat(64)), { attempt_uuid: uuid, plan_sha256: "a".repeat(64) });
  assert.throws(() => validateReleaseContext(uuid, null));
  assert.deepEqual(validateReleaseSkip(uuid, "operator verified pending attempt"), [uuid]);
  for (const reason of ["", "-option", "a\nB", "a\u0085b", "a\u202Eb", "a\u2028b", "a".repeat(513)]) {
    assert.throws(() => validateReleaseReason(reason));
  }
  assert.throws(() => validateReleaseSkip(`${uuid},${uuid}`, "reason"));
  assert.throws(() => validateReleaseSkip("", "reason"));
});

test("completion independently rejects a missing server or runner enrollment proof", () => {
  const f = fixture();
  const plan = { ...f.plan, authority: { server: { root: f.base, sha256: "a".repeat(64) },
    runners: [{ alias: "worker-a", root: f.base, sha256: "b".repeat(64) }] } };
  const context = { attempt_uuid: plan.attempt_uuid, plan_sha256: releaseBytesDigest(releaseJsonBytes(plan)) };
  const facts = { serverEvidence: { authority_sha256: plan.authority.server.sha256, root: f.base,
    release_context: context, pass: true }, runners: [{ alias: "worker-a", root: f.base,
    authority_sha256: "b".repeat(64), tool_sha256: "c".repeat(64), attempt_uuid: context.attempt_uuid,
    plan_sha256: context.plan_sha256, executed_audit: { pass: true } }],
    baselines: [{ alias: "worker-a", root: f.base, authority_sha256: "b".repeat(64), tool_sha256: "c".repeat(64),
      attempt_uuid: context.attempt_uuid, plan_sha256: context.plan_sha256, config_host_verified: true,
      target_revision: plan.identity.revision, executed_audit: { pass: true } }] };
  assertCompletionEnrollment(plan, facts);
  assert.throws(() => assertCompletionEnrollment(plan, { ...facts, serverEvidence: undefined }), /server completion/);
  assert.throws(() => assertCompletionEnrollment(plan, { ...facts, runners: [] }), /runner completion/);
  assert.throws(() => assertCompletionEnrollment(plan, { ...facts, baselines: [] }), /baseline/);
  for (const change of [{ authority_sha256: "d".repeat(64) }, { tool_sha256: "d".repeat(64) },
    { config_host_verified: false }, { target_revision: "d".repeat(40) }]) {
    assert.throws(() => assertCompletionEnrollment(plan, { ...facts, baselines: [{ ...facts.baselines[0], ...change }] }), /baseline/);
  }
});
