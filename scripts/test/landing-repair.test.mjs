import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runLandingRepair, operatorLandingContext, AlreadyRepaired, ReceiptRecoveryRequired } from "../landing-repair.mjs";
import { landingCandidates, auditLandingBacklog, originalPushRecord } from "../landing-backlog.mjs";
import { repairRefs, readLocalRepairRecord, writeLocalRepairRecord } from "../landing-repair-records.mjs";
import { sshGreetingActor, operatorSshSnapshot } from "../landing-repair-ssh.mjs";
import { workflowPermissionRefusal } from "../landing-tags.mjs";
import { repairFixture } from "./fixtures/landing-repair-fixture.mjs";
const greeting = actor => `Hi ${actor}! You've successfully authenticated, but GitHub does not provide shell access.\n`;
const config = "hostname github.com\nuser git\nport 22\nidentityfile /fixture/key\nidentitiesonly yes\n";
const withFixture = async work => {
  const f = repairFixture(), saved = { ...process.env };
  Object.assign(process.env, f.env);
  try { await work(f); }
  finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); f.dispose(); }
};
const atomicCalls = f => f.calls().filter(args => args[0] === "push" && args.includes("--atomic"));

test("SSH greeting is stderr-only, anchored, bounded, exit-1-only and case-sensitive", () => {
  const good = { status: 1, stderr: greeting("OperatorOne") };
  assert.equal(sshGreetingActor(good, "OperatorOne"), "OperatorOne");
  for (const bad of [
    { ...good, status: 0 }, { ...good, status: 255 }, { ...good, signal: "SIGTERM" },
    { ...good, error: new Error("timeout") }, { ...good, stderr: "", stdout: good.stderr },
    { ...good, stderr: `warning\n${good.stderr}` }, { ...good, stderr: `${good.stderr}extra` },
    { ...good, stderr: greeting("-invalid") }, { ...good, stderr: greeting("operatorone") },
    { ...good, stderr: "x".repeat(4097) },
  ]) assert.throws(() => sshGreetingActor(bad, "OperatorOne"));
});

test("SSH snapshot fixes one destination and reuses its key/environment selection without HTTP configuration", () => {
  let captured;
  const snapshot = operatorSshSnapshot("OperatorOne", {
    env: { SSH_AUTH_SOCK: "/fixture/agent", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraheader", GIT_CONFIG_VALUE_0: "inert" },
    readConfig: () => ({ status: 0, stdout: config }),
    probe: (args, env) => { captured = { args, env }; return { status: 1, stderr: greeting("OperatorOne") }; },
  });
  assert.equal(captured.env.SSH_AUTH_SOCK, snapshot.gitEnv.SSH_AUTH_SOCK);
  assert.ok(captured.args.includes("-oidentityfile=/fixture/key"));
  assert.ok(captured.args.includes("-oLogLevel=QUIET"));
  assert.match(snapshot.gitEnv.GIT_SSH_COMMAND, /identityfile=\/fixture\/key/);
  assert.equal(snapshot.gitEnv.GIT_ALLOW_PROTOCOL, "ssh");
  assert.equal(snapshot.gitEnv.GIT_CONFIG_COUNT, undefined);
  assert.equal(snapshot.gitEnv.GIT_CONFIG_GLOBAL, "/dev/null");
  for (const suffix of ["proxycommand arbitrary\n", "port 443\n", "hostname attacker.invalid\n"])
    assert.throws(() => operatorSshSnapshot("OperatorOne", { readConfig: () => ({ status: 0, stdout: config + suffix }),
      probe: () => ({ status: 1, stderr: greeting("OperatorOne") }) }), /fixed GitHub destination required/);
});

test("correct greeting with exit 255 or case-only actor mismatch causes no Git push", async () => withFixture(async f => {
  for (const result of [{ status: 255, stderr: greeting("OperatorOne") }, { status: 1, stderr: greeting("operatorone") }]) {
    await assert.rejects(runLandingRepair("repair", f.args(), { ...f.dependencies,
      sshSnapshot: actor => operatorSshSnapshot(actor, { readConfig: () => ({ status: 0, stdout: config }), probe: () => result }) }));
    assert.equal(atomicCalls(f).length, 0);
    assert.equal(readLocalRepairRecord(f.repo, repairRefs(Number(f.env.GITHUB_REPOSITORY_ID), 1).intent), null);
  }
}));

test("manual repair requires explicit SSH before any Git push", async () => withFixture(async f => {
  for (const value of ["https", "", "auto"])
    await assert.rejects(runLandingRepair("repair", ["--git-transport", value, ...f.args().slice(2)], f.dependencies), /requires --git-transport ssh|invalid or repeated release option/);
  await assert.rejects(runLandingRepair("repair", f.args().slice(2), f.dependencies), /requires --git-transport ssh/);
  await assert.rejects(runLandingRepair("repair", [...f.args(), "--git-transport", "ssh"], f.dependencies), /repeated release option/);
  assert.equal(atomicCalls(f).length, 0);
}));

test("exact target, activation boundary, reviewed control and operator allow-list are independently bound before push", async () => withFixture(async f => {
  const wrongTarget = f.args(); wrongTarget[wrongTarget.length - 1] = f.second;
  await assert.rejects(runLandingRepair("repair", wrongTarget, f.dependencies), /expected target differs/);
  f.data.variables.KAOIRO_LANDING_FIRST_RUN_ID = "2";
  await assert.rejects(runLandingRepair("repair", f.args(), f.dependencies), /predates/);
  f.data.variables.KAOIRO_LANDING_FIRST_RUN_ID = "1";
  f.data.variables.KAOIRO_LANDING_CONTROL_SHA = f.second;
  await assert.rejects(runLandingRepair("repair", f.args(), f.dependencies), /control|gate/);
  f.data.variables.KAOIRO_LANDING_CONTROL_SHA = f.control;
  f.data.actor = "OtherActor";
  await assert.rejects(runLandingRepair("repair", f.args(), f.dependencies), /allow-list/);
  assert.equal(atomicCalls(f).length, 0);
}));

test("repair preserves original clock and target, writes intent before push and receipt afterward, duplicate is 73", async () => withFixture(async f => {
  const before = await runLandingRepair("audit", ["--repository", "fixture/repo"], f.dependencies);
  assert.equal(before.pending_count, 2); assert.equal(before.exit_code, 78);
  const result = await runLandingRepair("repair", f.args(), f.dependencies);
  assert.equal(result.exit_code, 0); assert.equal(result.identity.revision, f.control);
  assert.equal(result.identity.created_at, "2026-10-09T00:00:00Z");
  assert.equal(result.identity.version, "2026.10.09.1");
  assert.equal(f.git("cat-file", "-t", result.intent_object), "blob");
  assert.equal(f.git("cat-file", "-t", result.receipt_object), "blob");
  const savedIntent = readLocalRepairRecord(f.repo, result.intent_ref);
  assert.throws(() => writeLocalRepairRecord(f.repo, result.intent_ref, savedIntent.value), /update-ref refused/);
  assert.equal(readLocalRepairRecord(f.repo, result.intent_ref).object, savedIntent.object);
  const calls = f.calls(), push = calls.findIndex(args => args[0] === "push" && args.includes("--atomic"));
  assert.ok(calls.findIndex(args => args[0] === "update-ref" && args[1] === result.intent_ref) < push);
  assert.ok(calls.findIndex(args => args[0] === "update-ref" && args[1] === result.receipt_ref) > push);
  const refs = f.git("ls-remote", "--refs", "--tags", f.remote);
  assert.equal(refs.split("\n").length, 2); assert.ok(refs.split("\n").every(row => row.startsWith(result.pair_object)));
  const pushes = atomicCalls(f).length;
  await assert.rejects(runLandingRepair("repair", f.args(), f.dependencies), error => error instanceof AlreadyRepaired && error.exitCode === 73);
  assert.equal(atomicCalls(f).length, pushes); assert.equal(f.git("ls-remote", "--refs", "--tags", f.remote), refs);
  assert.equal((await runLandingRepair("audit", ["--repository", "fixture/repo"], f.dependencies)).pending_count, 1);
  await runLandingRepair("repair", f.args(1), f.dependencies);
  assert.equal((await runLandingRepair("audit", ["--repository", "fixture/repo"], f.dependencies)).exit_code, 0);
}));

test("failed intent recording cannot push; a rejected push can be explicitly resumed with the retained intent", async () => withFixture(async f => {
  process.env.FUJI_FAIL_REF = "intent";
  await assert.rejects(runLandingRepair("repair", f.args(), f.dependencies), /update-ref refused/);
  assert.equal(atomicCalls(f).length, 0);
  delete process.env.FUJI_FAIL_REF;
  f.dependencies.sshSnapshot = () => ({ configurationSha256: "f".repeat(64), gitEnv: { ...f.env, FUJI_REFUSAL: "generic" } });
  await assert.rejects(runLandingRepair("repair", f.args(), f.dependencies));
  const intent = readLocalRepairRecord(f.repo, repairRefs(Number(f.env.GITHUB_REPOSITORY_ID), 1).intent);
  assert.ok(intent);
  await assert.rejects(runLandingRepair("repair", f.args(), f.dependencies), /use explicit resume/);
  f.dependencies.sshSnapshot = () => ({ configurationSha256: "f".repeat(64), gitEnv: f.env });
  const result = await runLandingRepair("resume", f.args(), f.dependencies);
  assert.equal(result.intent_object, intent.object); assert.equal(result.exit_code, 0);
}));

test("failed post-push receipt records exact recovery; record-existing adds receipt without another push", async () => withFixture(async f => {
  process.env.FUJI_FAIL_REF = "receipt";
  await assert.rejects(runLandingRepair("repair", f.args(), f.dependencies), error =>
    error instanceof ReceiptRecoveryRequired && error.result.exit_code === 78 &&
    error.result.identity.revision === f.control && error.result.recovery_command.includes("record-existing"));
  const pushes = atomicCalls(f).length;
  delete process.env.FUJI_FAIL_REF;
  await assert.rejects(runLandingRepair("resume", f.args(), f.dependencies), /record-existing/);
  const result = await runLandingRepair("record-existing", f.args(), f.dependencies);
  assert.equal(result.exit_code, 0); assert.equal(atomicCalls(f).length, pushes);
}));

test("unknown local evidence and changed original artifact refuse without a push", async () => withFixture(async f => {
  await assert.rejects(runLandingRepair("resume", f.args(), f.dependencies), /existing local/);
  const original = f.dependencies.readArtifact;
  f.dependencies.readArtifact = (...args) => { const value = original(...args); return { ...value, record: { ...value.record, createdAt: "2026-10-10T00:00:00Z" } }; };
  await assert.rejects(runLandingRepair("repair", f.args(), f.dependencies), /original push record rejected/);
  f.dependencies.readArtifact = original;
  const ref = repairRefs(Number(f.env.GITHUB_REPOSITORY_ID), 1).intent;
  const object = f.git("hash-object", "-w", "--stdin");
  f.git("update-ref", ref, object);
  await assert.rejects(runLandingRepair("repair", f.args(), f.dependencies), /repair record|repair blob/);
  assert.equal(atomicCalls(f).length, 0);
}));

test("actual audit CLI uses production constructors and returns nonzero for an unclaimed original event", async () => withFixture(async f => {
  const result = f.cli("landing-repair.mjs", ["audit", "--repository", "fixture/repo"]);
  assert.equal(result.status, 78, result.stderr);
  const report = JSON.parse(result.stdout); assert.equal(report.pending_count, 2);
  await runLandingRepair("repair", f.args(), f.dependencies);
  await runLandingRepair("repair", f.args(1), f.dependencies);
  const green = f.cli("landing-repair.mjs", ["audit", "--repository", "fixture/repo"]);
  assert.equal(green.status, 0, green.stderr); assert.equal(JSON.parse(green.stdout).pending_count, 0);
}));

test("only measured atomic workflow refusal is classified, with exact two-ref binding", () => {
  const object = "a".repeat(40), target = "b".repeat(40), tag = "v2026.10.09.1";
  const reason = "refusing to allow a GitHub App to create or update workflow `.github/workflows/production-release.yml` without `workflows` permission";
  const stderr = `To https://fixture.invalid\n ! [remote rejected] ${object} -> ${tag} (${reason})\n ! [remote rejected] ${object} -> identity/landing/${target} (atomic push failure)\nerror: failed to push some refs\n`;
  const good = { status: 1, stderr };
  assert.equal(workflowPermissionRefusal(good, { object, target, tag }), ".github/workflows/production-release.yml");
  for (const result of [{ ...good, status: 255 }, { ...good, error: new Error("timeout") },
    { ...good, stderr: stderr.replace(reason, "403 permission denied") },
    { ...good, stderr: stderr.replace(target, "c".repeat(40)) },
    { ...good, stderr: stderr.split("\n").slice(0, 2).join("\n") }])
    assert.equal(workflowPermissionRefusal(result, { object, target, tag }), null);
});

test("workflow entry stops writes at a classified refusal and preserves full bounded diagnostic artifact and summary", async () => withFixture(async f => {
  const artifact = join(f.root, "result.json"), summary = join(f.root, "summary");
  const result = f.cli("landing-workflow.mjs", ["reconcile"], { FUJI_REFUSAL: "workflow", KAOIRO_LANDING_RESULT_PATH: artifact, GITHUB_STEP_SUMMARY: summary });
  assert.equal(result.status, 77, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "landing_operator_repair_required"); assert.equal(report.pending_count, 2);
  assert.equal(report.inventory_scope.kind, "all_post_activation"); assert.equal(atomicCalls(f).length, 1);
  assert.equal(report.target, f.control); assert.match(report.repair_command, /--git-transport.*ssh/);
  assert.equal(readFileSync(artifact, "utf8"), readFileSync(summary, "utf8"));
  assert.equal(report.identities[0].status, "operator_repair_required");
}));

test("generic push failure remains 78 with unknown remaining scope", async () => withFixture(async f => {
  const result = f.cli("landing-workflow.mjs", ["reconcile"], { FUJI_REFUSAL: "generic" });
  assert.equal(result.status, 78, result.stderr); assert.equal(JSON.parse(result.stdout).inventory_scope, "unknown");
  assert.equal(atomicCalls(f).length, 1);
}));

test("a saturated observation or oversized diagnostic is unknown instead of a truncated zero", async () => withFixture(async f => {
  const context = operatorLandingContext("fixture/repo", f.dependencies);
  function* repeated() { for (let i = 0; i < 100_001; i++) yield f.data.pushes[0]; }
  assert.throws(() => landingCandidates(context, { runs: repeated(), inventory: { entries: [{ record: { revision: f.control } }] } }), /observation cap/);
  const runs = Array.from({ length: 70_000 }, (_, i) => ({ ...f.data.pushes[0], id: i + 1,
    run_number: i + 1, head_sha: (i + 1).toString(16).padStart(40, "0") }));
  assert.throws(() => auditLandingBacklog(context, { cwd: f.repo, remote: f.remote, runs,
    readArtifact: (_repository, run) => { const record = originalPushRecord({ after: run.head_sha,
      ref: "refs/heads/develop", forced: false, deleted: false }, run, context.repositoryId);
      return { record, bytes: Buffer.from(JSON.stringify(record)) }; } }), /output exceeds bound/);
}));
