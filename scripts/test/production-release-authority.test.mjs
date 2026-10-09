import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { runUpdate } from "../../server/deploy/kaoiro-server-deploy.mjs";
import { DEFAULT_CONFIG } from "../../server/deploy/kaoiro-deploy-config.mjs";
import { artifactBuildIdentity, BUILD_REPOSITORY_ID } from "../build-identity.mjs";
import { startReleaseAttempt } from "../production-release-record.mjs";
import { releaseBytesDigest, releaseJsonBytes } from "../production-release-files.mjs";
import { projectReleaseHistory, readReleaseHistory } from "../production-release-history.mjs";
import { readReleaseAuthority, releaseAuthorityRequest, releaseSshArguments } from "../production-release-authority.mjs";
import { releaseRequest } from "../production-release-endpoint.mjs";
import { collectReleaseToolClosure, stageReleaseTools, verifyReleaseToolClosure } from "../production-release-tools.mjs";
import { assertReleaseUnresolved, reconcileProductionReleases, validateReleaseSnapshot } from "../production-release-reconciliation.mjs";
import { verifyRunnerSwitch } from "../production-release-runner.mjs";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scratch = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture(role = "runner") {
  const base = mkdtempSync(join(tmpdir(), "kaoiro-release-authority-test-"));
  scratch.push(base);
  const repo = join(base, "repo");
  mkdirSync(repo, { mode: 0o700 });
  const installRoot = role === "server" ? join(repo, "server") : join(base, "install");
  const root = join(base, "history");
  mkdirSync(installRoot, { mode: 0o700 });
  mkdirSync(root, { mode: 0o700 });
  const toolRoot = join(base, "tools");
  const manifest = stageReleaseTools(source, toolRoot);
  const descriptor = { schema: 1, install_root: installRoot, transport: "local", recording_hostname: hostname(), root,
    tool_sha256: manifest.sha256, exporter_path: join(toolRoot, "scripts/production-release-launcher.mjs"),
    node_major: Number(process.versions.node.split(".")[0]), node_path: process.execPath };
  const path = join(installRoot, role === "server" ? ".kaoiro-release-authority.json" : "release-authority.json");
  writeFileSync(path, releaseJsonBytes(descriptor), { mode: 0o600 });
  const authority = readReleaseAuthority(installRoot, { role });
  const revision = "a".repeat(40);
  const identity = artifactBuildIdentity({ revision, dirty: false, version: "2026.10.09.1", branch: "develop", channel: "dev",
    landing: { schema: 1, kind: "landing", repository_id: BUILD_REPOSITORY_ID, revision, branch: "develop",
      version: "2026.10.09.1", original_run_id: 1, created_at: "2026-10-09T00:00:00Z" } });
  const start = () => startReleaseAttempt(root, identity, ["worker-a"], [], {
    runtime_hosts: [{ alias: "worker-a", runtime_host_id: "private-machine-marker" }],
    authority: { server: { root: installRoot, sha256: authority.sha256 },
      runners: [{ alias: "worker-a", root: installRoot, sha256: authority.sha256 }] },
  });
  return { base, repo, root, toolRoot, installRoot, descriptor, path, authority, manifest, identity, start };
}

test("default authority constructor reaches the real verified endpoint and first history snapshot", async () => {
  const f = fixture();
  const response = releaseAuthorityRequest(f.authority, releaseRequest(f.descriptor));
  validateReleaseSnapshot(response);
  assert.deepEqual(response.rows, []);
  const accepted = await reconcileProductionReleases({ installRoot: f.installRoot });
  assert.equal(accepted.pass, true);
  assert.equal(accepted.canonical_root, f.root);
  const attempt = f.start();
  await assert.rejects(reconcileProductionReleases({ installRoot: f.installRoot }), /unresolved attempts/);
  const own = await reconcileProductionReleases({ installRoot: f.installRoot, attemptUuid: attempt.plan.attempt_uuid,
    planDigest: releaseBytesDigest(releaseJsonBytes(attempt.plan)), targetRevision: f.identity.revision, alias: "worker-a" });
  assert.equal(own.pass, true);
  f.start();
  await assert.rejects(reconcileProductionReleases({ installRoot: f.installRoot, attemptUuid: attempt.plan.attempt_uuid,
    planDigest: releaseBytesDigest(releaseJsonBytes(attempt.plan)), targetRevision: f.identity.revision, alias: "worker-a" }), /unresolved attempts/);
});

test("missing descriptor is generic, but enrolled missing authority and another root cannot silently pass", async () => {
  const f = fixture();
  rmSync(f.path);
  assert.equal((await reconcileProductionReleases({ installRoot: f.installRoot })).status, "generic");
  await assert.rejects(reconcileProductionReleases({ installRoot: f.installRoot, expectedAuthorityDigest: f.authority.sha256 }), /absent/);
  writeFileSync(f.path, releaseJsonBytes({ ...f.descriptor, root: join(f.base, "missing-history") }), { mode: 0o600 });
  await assert.rejects(reconcileProductionReleases({ installRoot: f.installRoot }), /ENOENT/);
  writeFileSync(f.path, releaseJsonBytes(f.descriptor));
  chmodSync(f.path, 0o644);
  assert.throws(() => readReleaseAuthority(f.installRoot), /unsafe/);
  chmodSync(f.path, 0o600);
  assert.throws(() => readReleaseAuthority(f.installRoot, { assertionPath: join(f.base, "other.json") }), /different descriptor/);
});

test("SSH argv fixes the identity and host key options without agent or expansion fallbacks", () => {
  const f = fixture();
  const args = releaseSshArguments({ ...f.descriptor, ssh_target: "recording", ssh_hostname: "recording.example",
    ssh_user: "operator", ssh_port: 22, identity_file: "/private/key", known_hosts_file: "/private/hosts",
    remote_node: process.execPath }, "export");
  for (const option of ["IdentityAgent=none", "IdentitiesOnly=yes", "UpdateHostKeys=no", "StrictHostKeyChecking=yes",
    "ControlMaster=no", "ControlPath=none", "ControlPersist=no", "ForwardAgent=no", "ProxyCommand=none", "ProxyJump=none"]) assert.ok(args.includes(option));
  assert.deepEqual(args.slice(-3, -1), ["--", "recording"]);
  assert.match(args.at(-1), /^\/usr\/bin\/env -i PATH=\/usr\/bin:\/bin LC_ALL=C /);
  assert.throws(() => releaseSshArguments(f.descriptor, "arbitrary-command"), /fixed SSH operation/);
});

test("closure is derived from actual first-party sources; linked or changed modules fail before endpoint import", () => {
  const f = fixture();
  assert.ok(collectReleaseToolClosure(source).files.some(item => item.path === "scripts/production-release-reconciliation.mjs"));
  const file = join(f.toolRoot, "scripts/production-release-history.mjs");
  writeFileSync(file, "throw new Error('untrusted import marker');\n");
  const run = spawnSync(process.execPath, [f.descriptor.exporter_path, "export", f.manifest.sha256], {
    input: releaseJsonBytes(releaseRequest(f.descriptor)), encoding: "utf8", timeout: 5000,
  });
  assert.equal(run.status, 78);
  assert.match(run.stderr, /captured module changed/);
  assert.doesNotMatch(run.stderr, /untrusted import marker/);
  rmSync(file);
  symlinkSync(join(source, "scripts/production-release-history.mjs"), file);
  assert.throws(() => verifyReleaseToolClosure(f.toolRoot, f.manifest.sha256), /linked/);
});

test("fixed importer keeps an identical retry idempotent while refusing changed bytes and stale new writes", () => {
  const f = fixture();
  const { plan } = f.start();
  const snapshot = releaseAuthorityRequest(f.authority, releaseRequest(f.descriptor));
  const row = snapshot.rows[0];
  const fact = { schema: 1, attempt_uuid: plan.attempt_uuid, alias: "worker-a", root: f.installRoot,
    authority_sha256: f.authority.sha256, tool_sha256: f.manifest.sha256, plan_sha256: row.plan_sha256, simulation: false,
    runner: { host_id: "worker-a" }, executed_audit: { pass: true }, config_host_verified: true };
  const request = releaseRequest(f.descriptor, { attempt_uuid: plan.attempt_uuid, alias: "worker-a", kind: "after",
    plan_sha256: row.plan_sha256, row_sha256: row.row_sha256 });
  const first = releaseAuthorityRequest(f.authority, request, { operation: "import", fact });
  assert.equal(first.reused, false);
  assert.equal(releaseAuthorityRequest(f.authority, request, { operation: "import", fact }).reused, true);
  assert.throws(() => releaseAuthorityRequest(f.authority, request, { operation: "import", fact: { ...fact, config_host_verified: false } }), /immutable/);
  assert.throws(() => releaseAuthorityRequest(f.authority, { ...request, kind: "before" }, {
    operation: "import", fact: { ...fact, runner: undefined },
  }), /canonical row changed|schema/);
});

test("the shared skip guard preserves an exact UUID set rather than a global waiver", async () => {
  const f = fixture();
  const first = f.start();
  await reconcileProductionReleases({ installRoot: f.installRoot,
    skipCsv: first.plan.attempt_uuid, skipReason: "operator deferred this attempt" });
  const second = f.start();
  await assert.rejects(reconcileProductionReleases({ installRoot: f.installRoot,
    skipCsv: first.plan.attempt_uuid, skipReason: "operator deferred only the first attempt" }), /unresolved attempts/);
  assertReleaseUnresolved([first.plan.attempt_uuid, second.plan.attempt_uuid], [first.plan.attempt_uuid, second.plan.attempt_uuid]);
});

test("server prepare refuses its enrolled history before Docker or transaction creation, including dry-run", () => {
  const f = fixture("server");
  const first = f.start();
  const backup = join(f.base, "backup");
  const fakeDocker = join(f.base, "docker");
  writeFileSync(fakeDocker, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const previousDocker = process.env.KAOIRO_DEPLOY_DOCKER_BIN;
  process.env.KAOIRO_DEPLOY_DOCKER_BIN = fakeDocker;
  const config = { ...DEFAULT_CONFIG, backup_root: backup, allow_docker_override: true };
  try {
  for (const dryRun of [false, true]) {
    assert.throws(() => runUpdate({ repo: f.repo, target: f.identity.revision, dryRun }, config), /unresolved attempts/);
    assert.equal(existsSync(backup), false);
  }
  f.start();
  assert.throws(() => runUpdate({ repo: f.repo, target: f.identity.revision,
    skipReleaseReconciliation: first.plan.attempt_uuid, skipReason: "operator deferred the first attempt" }, config), /unresolved attempts/);
  assert.equal(existsSync(backup), false);
  } finally {
    if (previousDocker === undefined) delete process.env.KAOIRO_DEPLOY_DOCKER_BIN;
    else process.env.KAOIRO_DEPLOY_DOCKER_BIN = previousDocker;
  }
});

test("server repeats its audit under the deployment lock before prepare observes Docker", () => {
  const f = fixture("server");
  const first = f.start();
  const backup = join(f.base, "backup");
  const fakeDocker = join(f.base, "docker");
  writeFileSync(fakeDocker, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const previousDocker = process.env.KAOIRO_DEPLOY_DOCKER_BIN;
  process.env.KAOIRO_DEPLOY_DOCKER_BIN = fakeDocker;
  const original = fs.mkdirSync;
  let changed = false;
  fs.mkdirSync = (path, ...args) => {
    const result = original(path, ...args);
    if (String(path).startsWith(`${backup}/.lock.`)) { f.start(); changed = true; }
    return result;
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => runUpdate({ repo: f.repo, target: f.identity.revision,
      releaseAttempt: first.plan.attempt_uuid, releasePlanSha256: releaseBytesDigest(releaseJsonBytes(first.plan)) },
    { ...DEFAULT_CONFIG, backup_root: backup, allow_docker_override: true }), /unresolved attempts/);
    assert.equal(changed, true);
  } finally {
    fs.mkdirSync = original; syncBuiltinESMExports();
    if (previousDocker === undefined) delete process.env.KAOIRO_DEPLOY_DOCKER_BIN;
    else process.env.KAOIRO_DEPLOY_DOCKER_BIN = previousDocker;
  }
  assert.deepEqual(fs.readdirSync(backup), []);
});

test("only snapshot_changed retries; malformed projections, missing authoritative root and expiry refuse", async () => {
  const f = fixture();
  const snapshot = { ...projectReleaseHistory(readReleaseHistory(f.root)), nonce: "a".repeat(32),
    tool_sha256: f.manifest.sha256, node_major: Number(process.versions.node.split(".")[0]) };
  let calls = 0;
  const request = () => { if (++calls <= 2) throw new Error("snapshot_changed"); return snapshot; };
  assert.equal((await reconcileProductionReleases({ installRoot: f.installRoot, authorityRequest: request })).pass, true);
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(reconcileProductionReleases({ installRoot: f.installRoot,
    authorityRequest: () => { calls++; throw new Error("unavailable root"); } }), /unavailable/);
  assert.equal(calls, 1);
  await assert.rejects(reconcileProductionReleases({ installRoot: f.installRoot,
    authorityRequest: () => ({ ...snapshot, private_runtime_hosts: [] }) }), /schema/);
  await assert.rejects(reconcileProductionReleases({ installRoot: f.installRoot, timeoutMs: 1,
    authorityRequest: () => { const until = performance.now() + 5; while (performance.now() < until) {} return snapshot; } }), /deadline/);
});

test("real owned shell lineage seals and consumes the local switch proof without calling its unavailable exporter", () => {
  const f = fixture();
  const revision = "a".repeat(40);
  const target = "b".repeat(40);
  const release = join(f.installRoot, "releases", revision);
  const deploy = join(release, "deploy");
  mkdirSync(deploy, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(join(source, "runner/deploy"))) {
    if (fs.statSync(join(source, "runner/deploy", name)).isFile()) {
      const file = join(deploy, name);
      copyFileSync(join(source, "runner/deploy", name), file);
      chmodSync(file, name.endsWith(".sh") ? 0o755 : 0o644);
    }
  }
  stageReleaseTools(source, join(deploy, "release-tools"));
  symlinkSync(`releases/${revision}`, join(f.installRoot, "current"));
  const config = join(f.base, "runner.config.json");
  writeFileSync(config, releaseJsonBytes({ host_id: "private-machine-marker" }), { mode: 0o600 });
  writeFileSync(join(f.installRoot, "release-host-aliases.json"), releaseJsonBytes([
    { alias: "worker-a", runtime_host_id: "private-machine-marker" },
  ]), { mode: 0o600 });
  const owner = join(f.base, "owner.sh");
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const gate = `${quote(process.execPath)} ${quote(join(deploy, "release-gate.mjs"))}`;
  writeFileSync(owner, `#!/bin/sh
set -eu
mkdir -m 700 ${quote(join(f.installRoot, ".lock.update"))}
${gate} runner-audit ${quote(f.installRoot)} --config ${quote(config)} --target-sha ${target} --owner-pid "$$" --mode worker --updater ${quote(join(deploy, "kaoiro-runner-update.sh"))} >/dev/null
sealed=$(${gate} runner-seal ${quote(f.installRoot)} --owner-pid "$$" --target-sha ${target})
invocation=$(${quote(process.execPath)} -e 'console.log(JSON.parse(process.argv[1]).invocation_uuid)' "$sealed")
digest=$(${quote(process.execPath)} -e 'console.log(JSON.parse(process.argv[1]).proof_sha256)' "$sealed")
mv ${quote(f.descriptor.exporter_path)} ${quote(`${f.descriptor.exporter_path}.offline`)}
sh -c '${gate} runner-switch ${quote(f.installRoot)} --target-sha ${target} --owner-pid "$$" --invocation-uuid "$1" --proof-sha256 "$2" >/dev/null' owned-switch "$invocation" "$digest"
${gate} runner-cleanup ${quote(f.installRoot)} --owner-pid "$$" >/dev/null
rmdir ${quote(join(f.installRoot, ".lock.update"))}
`, { mode: 0o700 });
  // Use a separate script for the child so path quoting stays literal at both shell layers.
  const child = join(f.base, "switch-child.sh");
  writeFileSync(child, `#!/bin/sh\nset -eu\n${gate} runner-switch ${quote(f.installRoot)} --target-sha ${target} --owner-pid "$$" --invocation-uuid "$1" --proof-sha256 "$2" >/dev/null\n`, { mode: 0o700 });
  const script = readFileSync(owner, "utf8").replace(/^sh -c .*owned-switch.*$/m, `${quote(child)} "$invocation" "$digest"`);
  writeFileSync(owner, script);
  const result = spawnSync(owner, [], { encoding: "utf8", timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(f.installRoot, ".lock.update")), false);
  assert.deepEqual(readReleaseHistory(f.root).rows, []);
  const evidence = join(f.installRoot, "release-audits", readdirSync(join(f.installRoot, "release-audits"))[0]);
  assert.deepEqual(readdirSync(evidence).sort(), ["release-audit.json", "release-owner.json", "release-switch-proof.json"]);

  const lock = join(f.installRoot, ".lock.update");
  mkdirSync(lock, { mode: 0o700 });
  for (const name of readdirSync(evidence)) copyFileSync(join(evidence, name), join(lock, name));
  const record = JSON.parse(readFileSync(join(lock, "release-owner.json")));
  const proof = JSON.parse(readFileSync(join(lock, "release-switch-proof.json")));
  const proofPath = join(lock, "release-switch-proof.json");
  const readProcess = pid => ({ pid, ppid: pid === record.pid ? 1 : record.pid, start_ticks: record.start_ticks });
  const verify = changes => verifyRunnerSwitch({ root: f.installRoot, target,
    invocationUuid: record.invocation_uuid, proofDigest: releaseBytesDigest(readFileSync(proofPath)), callerPid: record.pid + 100,
    readProcess, monotonic: () => proof.sealed_monotonic_seconds + 1, currentBoot: () => record.boot_id, ...changes });
  assert.equal(verify().pass, true);
  for (const mutate of [p => p.root = f.base, p => p.target_revision = revision, p => p.source_revision = target,
    p => p.owner_sha256 = "0".repeat(64), p => p.audit_sha256 = "0".repeat(64),
    p => p.authority_sha256 = "0".repeat(64), p => p.tool_sha256 = "0".repeat(64),
    p => p.release_context = { attempt_uuid: randomUUID(), plan_sha256: "0".repeat(64) }]) {
    const changed = structuredClone(proof); mutate(changed); writeFileSync(proofPath, releaseJsonBytes(changed));
    assert.throws(() => verify(), /differs|changed|proof/);
  }
  writeFileSync(proofPath, releaseJsonBytes(proof));
  assert.throws(() => verify({ monotonic: () => proof.sealed_monotonic_seconds + 901 }), /stale/);
  assert.throws(() => verify({ monotonic: () => proof.sealed_monotonic_seconds - 1 }), /future/);
  assert.throws(() => verify({ currentBoot: () => randomUUID() }), /boot/);
  assert.throws(() => verify({ readProcess: pid => ({ pid, ppid: 1, start_ticks: record.start_ticks }) }), /direct child/);
  assert.throws(() => verify({ readProcess: pid => ({ ...readProcess(pid), start_ticks: "1" }) }), /foreign invocation/);
});
