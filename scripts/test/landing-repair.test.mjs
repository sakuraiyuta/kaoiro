import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import childProcess, { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runLandingRepair, operatorLandingContext, AlreadyRepaired, ReceiptRecoveryRequired } from "../landing-repair.mjs";
import { landingCandidates, auditLandingBacklog, originalPushRecord } from "../landing-backlog.mjs";
import { repairRefs, readLocalRepairRecord, writeLocalRepairRecord, validateRepairReceipt } from "../landing-repair-records.mjs";
import { childEnvironment, childEnvironmentProfile } from "../child-process-environment.mjs";
import { allocateLanding, readLandingInventory } from "../landing-tags.mjs";
import { repairDiagnostic } from "../landing-workflow.mjs";
import { sshGreetingActor, operatorSshSnapshot } from "../landing-repair-ssh.mjs";
import { workflowPermissionRefusal } from "../landing-tags.mjs";
import { repairFixture } from "./fixtures/landing-repair-fixture.mjs";
const greeting = actor => `Hi ${actor}! You've successfully authenticated, but GitHub does not provide shell access.\n`;
const config = "hostname github.com\nuser git\nport 22\nidentityfile /fixture/key\nidentityagent /fixture/agent\nidentitiesonly yes\n";
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
  assert.deepEqual(captured.args, ["-T", "-F", "/dev/null", "-oBatchMode=yes", "-oStrictHostKeyChecking=yes", "-oUpdateHostKeys=no",
    "-oConnectTimeout=10", "-oConnectionAttempts=1", "-oPermitLocalCommand=no", "-oLogLevel=QUIET",
    "-oProxyCommand=none", "-oProxyJump=none", "-oHostname=github.com", "-oUser=git", "-p22",
    "-oidentityfile=/fixture/key", "-oidentityagent=/fixture/agent", "-oidentitiesonly=yes", "git@github.com"]);
  assert.match(snapshot.gitEnv.GIT_SSH_COMMAND, /identityfile=\/fixture\/key/);
  assert.equal(snapshot.gitEnv.GIT_ALLOW_PROTOCOL, "ssh");
  assert.equal(snapshot.gitEnv.GIT_CONFIG_COUNT, undefined);
  assert.equal(snapshot.gitEnv.GIT_CONFIG_GLOBAL, "/dev/null");
  for (const suffix of ["proxycommand arbitrary\n", "proxyjump arbitrary\n", "user root\n", "port 443\n", "hostname attacker.invalid\n"])
    assert.throws(() => operatorSshSnapshot("OperatorOne", { readConfig: () => ({ status: 0, stdout: config + suffix }),
      probe: () => ({ status: 1, stderr: greeting("OperatorOne") }) }), /fixed GitHub destination required/);
});

test("snapshot profile reaches inventory and allocation, and unbranded clones refuse", async () => withFixture(async f => {
  const snapshot = operatorSshSnapshot("OperatorOne", {
    env: f.env, readConfig: () => ({ status: 0, stdout: config }),
    probe: () => ({ status: 1, stderr: greeting("OperatorOne") }),
  });
  assert.equal(childEnvironmentProfile(snapshot.gitEnv), "ssh-git");
  assert.throws(() => childEnvironmentProfile({ ...snapshot.gitEnv }), /unprepared/);
  assert.throws(() => readLandingInventory({ cwd: f.repo, remote: f.remote, gitEnv: { ...snapshot.gitEnv } }), /unprepared/);
  readLandingInventory({ cwd: f.repo, remote: f.remote, gitEnv: snapshot.gitEnv });
  allocateLanding({ cwd: f.repo, remote: f.remote, target: f.control, originalRunId: 1,
    createdAt: "2026-10-09T00:00:00Z", gitEnv: snapshot.gitEnv });
  const calls = f.environments().filter(row => ["fetch", "push"].includes(row.args[0]));
  assert.ok(calls.some(row => row.args[0] === "fetch"));
  assert.ok(calls.some(row => row.args[0] === "push"));
  for (const { env } of calls) {
    assert.equal(env.GIT_SSH_COMMAND, snapshot.gitEnv.GIT_SSH_COMMAND);
    assert.equal(env.GIT_ALLOW_PROTOCOL, "ssh");
    assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(env.GIT_CONFIG_SYSTEM, "/dev/null");
    assert.equal(env.GIT_CONFIG_COUNT, undefined);
  }
}));

test("CI workflow gives the same authorization header to allocation and both backlog audits", async () => withFixture(async f => {
  const result = f.cli("landing-workflow.mjs", ["allocate"]);
  assert.equal(result.status, 0, result.stderr);
  const calls = f.environments().filter(row => ["fetch", "push"].includes(row.args[0]));
  assert.ok(calls.filter(row => row.args[0] === "fetch").length >= 3);
  assert.ok(calls.some(row => row.args[0] === "push"));
  for (const { env } of calls) {
    assert.equal(env.GIT_CONFIG_COUNT, "1");
    assert.equal(env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
    assert.equal(env.GIT_CONFIG_VALUE_0, "AUTHORIZATION: basic " + Buffer.from("x-access-token:inert-fixture-token").toString("base64"));
    assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(env.GIT_CONFIG_SYSTEM, "/dev/null");
    assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  }
}));

test("correct greeting with exit 255 or case-only actor mismatch causes no Git push", async () => withFixture(async f => {
  for (const result of [{ status: 255, stderr: greeting("OperatorOne") }, { status: 1, stderr: greeting("operatorone") }]) {
    await assert.rejects(runLandingRepair("repair", f.args(), { ...f.dependencies,
      sshSnapshot: actor => operatorSshSnapshot(actor, { readConfig: () => ({ status: 0, stdout: config }), probe: () => result }) }));
    assert.equal(atomicCalls(f).length, 0);
    assert.equal(readLocalRepairRecord(f.repo, repairRefs(Number(f.env.GITHUB_REPOSITORY_ID), 1).intent), null);
  }
}));

test("local insteadOf and pushInsteadOf rewrites refuse before push", async () => withFixture(async f => {
  for (const name of ["insteadOf", "pushInsteadOf"]) {
    const key = `url.git@github.com:attacker/other.git.${name}`;
    f.git("config", "--local", key, "git@github.com:fixture/repo.git");
    await assert.rejects(runLandingRepair("repair", f.args(), f.dependencies), /local Git URL rewrites/);
    assert.equal(atomicCalls(f).length, 0);
    f.git("config", "--local", "--unset", key);
  }
}));

test("operator shape, allow-list shape, login and push permission fail closed independently", async () => withFixture(async f => {
  const original = f.dependencies.readApi;
  for (const user of [{ type: "Organization", login: "OperatorOne" }, { type: "User", login: "-invalid" }]) {
    f.dependencies.readApi = path => path === "user" ? user : original(path);
    await assert.rejects(runLandingRepair("repair", f.args(), f.dependencies), /allow-list/);
  }
  f.dependencies.readApi = path => path === "repos/fixture/repo" ? { ...original(path), permissions: { push: false } } : original(path);
  await assert.rejects(runLandingRepair("repair", f.args(), f.dependencies), /allow-list/);
  f.dependencies.readApi = original;
  for (const allowed of [null, {}, [], ["OperatorOne", "OperatorOne"], ["OperatorOne", "-invalid"], ["OperatorOne", ...Array.from({ length: 100 }, (_, i) => "Login" + i)]]) {
    f.data.variables.KAOIRO_RELEASE_ACTORS = JSON.stringify(allowed);
    await assert.rejects(runLandingRepair("repair", f.args(), f.dependencies), /allow-list/);
  }
  assert.equal(atomicCalls(f).length, 0);
}));

test("same target with another clock or original run refuses rather than reporting 73", async () => withFixture(async f => {
  const pair = allocateLanding({ cwd: f.repo, remote: f.remote, target: f.control,
    originalRunId: 1, createdAt: "2026-10-09T01:00:00Z" });
  assert.equal(pair.created, true);
  assert.throws(() => new AlreadyRepaired(pair, { target: f.control, originalRunId: 1, createdAt: "2026-10-09T00:00:00Z" }), /exact original event/);
  await assert.rejects(runLandingRepair("repair", f.args(), f.dependencies), error =>
    !(error instanceof AlreadyRepaired) && /exact original event/.test(error.message));
  assert.equal(atomicCalls(f).length, 1);
}));

test("same target with another original run is never an exact duplicate", async () => withFixture(async f => {
  allocateLanding({ cwd: f.repo, remote: f.remote, target: f.control,
    originalRunId: 2, createdAt: "2026-10-09T00:00:00Z" });
  await assert.rejects(runLandingRepair("repair", f.args(), f.dependencies), error =>
    !(error instanceof AlreadyRepaired) && /exact original event/.test(error.message));
}));

test("the repair run must remain bound to the activated workflow", async () => withFixture(async f => {
  const read = f.dependencies.readApi;
  f.dependencies.readApi = path => path.endsWith("/actions/runs/2") ? { ...read(path), workflow_id: 2 } : read(path);
  await assert.rejects(runLandingRepair("repair", f.args(1), f.dependencies), /predates\/differs from activation authority/);
  assert.equal(atomicCalls(f).length, 0);
}));

const replaceBlob = (f, ref, value) => {
  const object = execFileSync("/usr/bin/git", ["hash-object", "-w", "--stdin"], {
    cwd: f.repo, input: JSON.stringify(value), encoding: "utf8" }).trim();
  f.git("update-ref", ref, object);
  return object;
};

test("receipt schema binds the intent object, original tuple, operator and control independently", async () => withFixture(async f => {
  const result = await runLandingRepair("repair", f.args(), f.dependencies);
  const intent = readLocalRepairRecord(f.repo, result.intent_ref);
  const receipt = readLocalRepairRecord(f.repo, result.receipt_ref).value;
  for (const delta of [{ intent_object: "a".repeat(40) }, { operator: "OtherActor" }, { control_sha: f.second }]) {
    assert.throws(() => validateRepairReceipt({ ...receipt, ...delta }, intent.value, intent.object), /receipt schema/);
  }
  for (const delta of [{ revision: f.second }, { original_run_id: 2 }, { created_at: "2026-10-09T01:00:00Z" }]) {
    assert.throws(() => validateRepairReceipt({ ...receipt, identity: { ...receipt.identity, ...delta } }, intent.value, intent.object), /original tuple/);
  }
  replaceBlob(f, result.receipt_ref, { ...receipt, pair_object: "a".repeat(40) });
  await assert.rejects(runLandingRepair("repair", f.args(), f.dependencies), /receipt differs from authoritative remote pair/);
  f.git("update-ref", result.receipt_ref, result.receipt_object);
  f.git("update-ref", "-d", result.intent_ref);
  await assert.rejects(runLandingRepair("repair", f.args(), f.dependencies), /receipt exists without local repair intent/);
}));

test("existing receipt validation remains on the repair flow before exit 73", async () => withFixture(async f => {
  const result = await runLandingRepair("repair", f.args(), f.dependencies);
  const receipt = readLocalRepairRecord(f.repo, result.receipt_ref).value;
  for (const delta of [{ intent_object: "a".repeat(40) }, { operator: "OtherActor" }, { control_sha: f.second }]) {
    replaceBlob(f, result.receipt_ref, { ...receipt, ...delta });
    await assert.rejects(runLandingRepair("repair", f.args(), f.dependencies), /receipt schema rejected/);
  }
  f.git("update-ref", result.receipt_ref, result.receipt_object);
  await assert.rejects(runLandingRepair("repair", f.args(), f.dependencies), error => error instanceof AlreadyRepaired && error.exitCode === 73);
}));

test("record-existing needs a pair and resume binds unchanged artifact, operator and control", async () => withFixture(async f => {
  process.env.FUJI_REFUSAL = "generic";
  await assert.rejects(runLandingRepair("repair", f.args(), f.dependencies));
  delete process.env.FUJI_REFUSAL;
  await assert.rejects(runLandingRepair("record-existing", f.args(), f.dependencies), /requires the exact remote pair/);
  const readArtifact = f.dependencies.readArtifact;
  f.dependencies.readArtifact = (...args) => { const artifact = readArtifact(...args); return { ...artifact, bytes: Buffer.concat([artifact.bytes, Buffer.from("\n")]) }; };
  await assert.rejects(runLandingRepair("resume", f.args(), f.dependencies), /original evidence differs/);
  f.dependencies.readArtifact = readArtifact;
  f.data.variables.KAOIRO_RELEASE_ACTORS = '["OperatorOne","OtherActor"]';
  f.data.actor = "OtherActor";
  await assert.rejects(runLandingRepair("resume", f.args(), f.dependencies), /original evidence differs/);
  f.data.actor = "OperatorOne";
  const refs = repairRefs(Number(f.env.GITHUB_REPOSITORY_ID), 1);
  const intent = readLocalRepairRecord(f.repo, refs.intent);
  replaceBlob(f, refs.intent, { ...intent.value, control_sha: f.second });
  await assert.rejects(runLandingRepair("resume", f.args(), f.dependencies), /original evidence differs/);
  f.git("update-ref", refs.intent, intent.object);
  const pushes = atomicCalls(f).length;
  assert.equal((await runLandingRepair("resume", f.args(), f.dependencies)).exit_code, 0);
  assert.equal(atomicCalls(f).length, pushes + 1);
}));

test("journal rejects non-blob objects, oversized blobs and mismatching create read-back", async () => withFixture(async f => {
  const ref = repairRefs(Number(f.env.GITHUB_REPOSITORY_ID), 1).intent;
  f.git("update-ref", ref, f.control);
  assert.throws(() => readLocalRepairRecord(f.repo, ref), /not a blob/);
  replaceBlob(f, ref, { padding: "x".repeat(4096) });
  assert.throws(() => readLocalRepairRecord(f.repo, ref), /repair blob bound/);
  f.git("update-ref", "-d", ref);
  assert.throws(() => writeLocalRepairRecord(f.repo, ref, { padding: "x".repeat(4096) }), /record exceeds bound/);
  const originalSpawn = childProcess.spawnSync;
  childProcess.spawnSync = (file, args, options) => {
    const result = originalSpawn(file, args, options);
    if (args[0] === "rev-parse" && args.at(-1) === ref && result.status === 0)
      return { ...result, stdout: "a".repeat(40) + "\n" };
    return result;
  };
  syncBuiltinESMExports();
  try { assert.throws(() => writeLocalRepairRecord(f.repo, ref, { schema: 1 }), /create\/read-back differs|operation failed|cat-file refused/); }
  finally { childProcess.spawnSync = originalSpawn; syncBuiltinESMExports(); }
}));

test("a competing allocator's exact pair records evidence but reports 73 instead of claiming creation", async () => withFixture(async f => {
  const result = await runLandingRepair("repair", f.args(), { ...f.dependencies, allocate: input => {
    const pair = allocateLanding({ ...input, remote: f.remote });
    return { ...pair, created: false };
  } });
  assert.equal(result.exit_code, 73);
  assert.equal(result.status, "already_repaired");
  assert.ok(readLocalRepairRecord(f.repo, result.receipt_ref));
}));

test("repair independently rereads the remote pair after allocation before writing receipt", async () => withFixture(async f => {
  await assert.rejects(runLandingRepair("repair", f.args(), { ...f.dependencies, allocate: input => {
    const pair = allocateLanding({ ...input, remote: f.remote });
    return { ...pair, object: "a".repeat(40) };
  } }), /repair pair read-back differs/);
  assert.equal(readLocalRepairRecord(f.repo, repairRefs(Number(f.env.GITHUB_REPOSITORY_ID), 1).receipt), null);
}));

test("public repair command is relative and reviewed checkout must be clean", async () => withFixture(async f => {
  const result = repairDiagnostic({ repository: "fixture/repo", repositoryId: 1, originalRunId: 1,
    target: f.control, createdAt: "2026-10-09T00:00:00Z", workflowPath: ".github/workflows/production-release.yml" }, f.control);
  assert.equal(result.command_cwd, "reviewed_control_checkout");
  assert.equal(result.repair_command, `'node' 'scripts/landing-repair.mjs' 'repair' '--git-transport' 'ssh' '--repository' 'fixture/repo' '--original-run' '1' '--expected-target' '${f.control}'`);
  assert.ok(!JSON.stringify(result).includes(f.repo));
  writeFileSync(join(f.repo, "unreviewed"), "dirty");
  await assert.rejects(runLandingRepair("repair", f.args(), f.dependencies), /checkout must be clean/);
  assert.equal(atomicCalls(f).length, 0);
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
  process.env.FUJI_REFUSAL = "generic";
  await assert.rejects(runLandingRepair("repair", f.args(), f.dependencies));
  const intent = readLocalRepairRecord(f.repo, repairRefs(Number(f.env.GITHUB_REPOSITORY_ID), 1).intent);
  assert.ok(intent);
  await assert.rejects(runLandingRepair("repair", f.args(), f.dependencies), /use explicit resume/);
  delete process.env.FUJI_REFUSAL;
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
  const row = (id, name, text) => ` ! [remote rejected] ${id} -> ${name} (${text})\n`;
  for (const text of [
    row(object, tag, reason) + row(object, `identity/landing/${target}`, reason) + row(object, "extra", reason),
    row("c".repeat(40), tag, reason) + row(object, `identity/landing/${target}`, reason),
    row(object, tag, reason) + row(object, `identity/landing/${target}`, "unknown reason"),
    row(object, tag, reason) + row(object, `identity/landing/${target}`, reason.replace("production-release.yml", "develop-landing.yml")),
    row(object, tag, "atomic push failure") + row(object, `identity/landing/${target}`, "atomic push failure"),
  ]) assert.equal(workflowPermissionRefusal({ status: 1, stderr: text }, { object, target, tag }), null);
});

test("workflow entry stops writes at a classified refusal and preserves full bounded diagnostic artifact and summary", async () => withFixture(async f => {
  const artifact = join(f.root, "result.json"), summary = join(f.root, "summary");
  const result = f.cli("landing-workflow.mjs", ["reconcile"], { FUJI_REFUSAL: "workflow", KAOIRO_LANDING_RESULT_PATH: artifact, GITHUB_STEP_SUMMARY: summary });
  assert.equal(result.status, 77, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "landing_operator_repair_required"); assert.equal(report.pending_count, 2);
  assert.equal(report.inventory_scope.kind, "all_post_activation"); assert.equal(atomicCalls(f).length, 1);
  assert.equal(report.target, f.control); assert.match(report.repair_command, /--git-transport.*ssh/);
  assert.equal(report.command_cwd, "reviewed_control_checkout");
  assert.equal(report.repair_command, `'node' 'scripts/landing-repair.mjs' 'repair' '--git-transport' 'ssh' '--repository' 'fixture/repo' '--original-run' '1' '--expected-target' '${f.control}'`);
  assert.ok(!readFileSync(summary, "utf8").includes(f.repo));
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
