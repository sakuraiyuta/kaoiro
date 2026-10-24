import "../../../scripts/test/fixtures/test-isolation.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { execChildSync } from "../../../runner/deploy/child-process-environment.mjs";

import { PHASE } from "../kaoiro-deploy-phase.mjs";
import { newTransactionId } from "../kaoiro-deploy-transaction.mjs";

// Property test for the recovery table (issue #695, landing unit L1;
// docs/plans/issue-695-transaction-state-table.md section 7.1). Each recipe
// drives the real CLI, in a subprocess, into one phase plus one durable side
// effect, asserts that residual, then executes the commands the CLI itself
// printed until a terminal phase, and checks the oracle for the operation
// that closed it. The Docker side is a stateful model
// (test-support/stateful-docker.mjs): these are control-flow assertions about the
// CLI, not measurements of Docker. Docker semantics the model relies on:
// `docker start` on a running container exits 0 (kaoiro-server-deploy.mjs,
// non-destructive rollback comment), `compose up` recreates a container whose
// image changed, `compose ps -q` lists running containers only.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const OLD_IMAGE = `sha256:${"0".repeat(63)}1`;
const OLD_CONTAINER = "c".repeat(64);
const PHASES = Object.values(PHASE);
const TERMINAL = new Set([PHASE.DONE, PHASE.ROLLED_BACK]);
const rank = (phase) => PHASES.indexOf(phase);

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

// The record's values only need to satisfy requireTaggedIdentity's shape
// (build-identity.mjs); they name no real repository or release.
function tagLanding(dir, revision, number) {
  const version = `2026.10.20.${number}`;
  const record = { schema: 1, kind: "landing", repository_id: 1343265983, revision,
    branch: "develop", version, original_run_id: number, created_at: "2026-10-20T00:00:00Z" };
  execFileSync("git", ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "tag", "-a",
    `v${version}`, revision, "-m", JSON.stringify(record)]);
  git(dir, "update-ref", `refs/tags/identity/landing/${revision}`, git(dir, "rev-parse", `refs/tags/v${version}`));
}

// The rendered commands name `<repo>/server/deploy/kaoiro-server-deploy.mjs`,
// so the fixture checkout carries the code under test, as a real one does.
function copyCode(dest) {
  for (const [from, to, filter] of [
    ["server/deploy", "server/deploy", (n) => n.endsWith(".mjs") || n === "package.json"],
    ["scripts", "scripts", (n) => n.endsWith(".mjs")],
    ["runner/deploy", "runner/deploy", (n) => n.endsWith(".mjs")],
  ]) {
    mkdirSync(join(dest, to), { recursive: true });
    for (const name of readdirSync(join(repoRoot, from))) {
      if (filter(name)) copyFileSync(join(repoRoot, from, name), join(dest, to, name));
    }
  }
}

function digestDir(dir) {
  const hash = createHash("sha256");
  for (const name of readdirSync(dir).sort()) hash.update(`${name}\0${readFileSync(join(dir, name))}\0`);
  return hash.digest("hex");
}

function makeWorld(t, { fleet = { schema: 1, hosts: [], wrappers: [] }, overrideMount = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kaoiro-recovery-prop-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  mkdirSync(join(source, "server"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", source]);
  git(source, "config", "user.email", "test@example.com");
  git(source, "config", "user.name", "Test");
  writeFileSync(join(source, "server", "docker-compose.yaml"), "# fixture\n");
  // As in the real repository, the release authority descriptor is ignored.
  writeFileSync(join(source, ".gitignore"), readFileSync(join(repoRoot, ".gitignore")));
  copyCode(source);
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "old");
  const oldSha = git(source, "rev-parse", "HEAD");
  tagLanding(source, oldSha, 1);
  const bare = join(root, "bare.git");
  const work = join(root, "work");
  // --no-local: a local-path clone hardlinks or copies objects/ as files and
  // races with a concurrent writer there (git refuses a hardlink whose source
  // changed); the regular transport reads complete objects only.
  execFileSync("git", ["clone", "--bare", "--no-local", "-q", source, bare]);
  execFileSync("git", ["clone", "--no-local", "-q", bare, work]);
  if (overrideMount) writeFileSync(join(work, "server", "docker-compose.override.yaml"), JSON.stringify({
    services: { kaoiro: { volumes: [{ type: "bind", source: "/srv/overlay", target: "/overlay", read_only: true }] } },
  }));
  writeFileSync(join(source, "README"), "target\n");
  git(source, "add", "README");
  git(source, "commit", "-q", "-m", "target");
  const target = git(source, "rev-parse", "HEAD");
  tagLanding(source, target, 2);
  // Fetched into the bare repo rather than pushed, so no push hook runs.
  git(bare, "fetch", "-q", source, "main:main", "refs/tags/*:refs/tags/*");

  const binDir = join(root, "bin");
  mkdirSync(binDir);
  const docker = join(binDir, "docker");
  const curl = join(binDir, "curl");
  // Outside test/: `node --test` would otherwise run the fakes as test files.
  copyFileSync(join(here, "../test-support/stateful-docker.mjs"), docker);
  copyFileSync(join(here, "../test-support/stateful-curl.mjs"), curl);
  chmodSync(docker, 0o755);
  chmodSync(curl, 0o755);

  const volumeDir = join(root, "volume");
  mkdirSync(volumeDir);
  writeFileSync(join(volumeDir, "users.dets"), "ledger\n");
  const statePath = join(root, "docker-state.json");
  writeFileSync(statePath, JSON.stringify({
    images: { [OLD_IMAGE]: { revision: oldSha, formats: ["legacy-calver", "landing-calver-v1"] } },
    tags: { "kaoiro-server:latest": OLD_IMAGE },
    containers: [{ id: OLD_CONTAINER, name: "kaoiro-c1", image: OLD_IMAGE, status: "running", exitCode: 0,
      restartCount: 0, service: "kaoiro" }],
    volume: { name: "kaoiro_kaoiro-state", dir: volumeDir },
    fleet,
    overrideMount,
    targetRevision: target,
    faults: [],
    counters: {},
    nextId: 16,
    calls: [],
  }));
  writeFileSync(curl + ".state", statePath, { mode: 0o600 });
  const backupRoot = join(root, "backup");
  const config = join(root, "deploy.json");
  writeFileSync(config, JSON.stringify({
    allow_docker_override: true,
    backup_root: backupRoot,
    health_url: "http://fake-server.invalid/api/health",
    expected_clean_stop_exit_code: 0,
    expected_clean_stop_oom_killed: false,
    health_poll_interval_ms: 1,
    health_poll_timeout_ms: 300,
    stability_window_ms: 1,
  }), { mode: 0o600 });
  const env = { ...process.env, KAOIRO_DEPLOY_DOCKER_BIN: docker, KAOIRO_DEPLOY_CURL_BIN: curl, FAKE_DOCKER_STATE: statePath };
  const cli = join(work, "server/deploy/kaoiro-server-deploy.mjs");

  const world = {
    root, work, config, oldSha, target, volumeDir, backupRoot, cli,
    state: () => JSON.parse(readFileSync(statePath, "utf8")),
    edit(fn) {
      const s = world.state();
      fn(s);
      writeFileSync(statePath, JSON.stringify(s));
    },
    // Replacing the fault list also resets the per-fault call counters.
    faults: (list) => world.edit((s) => { s.faults = list; s.counters = {}; }),
    exec(argv) {
      const [program, ...rest] = argv;
      const r = spawnSync(program === "node" ? process.execPath : program, rest, { env, encoding: "utf8" });
      return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
    },
    compose: (...args) => spawnSync(process.execPath, [docker, "compose", ...args], { cwd: join(work, "server"), env, encoding: "utf8" }),
    cliRun: (command, ...args) => world.exec(["node", cli, command, "--repo", work, "--config", config, ...args]),
    update: (...args) => world.cliRun("update", "--target", target, ...args),
    txId() {
      const ids = existsSync(backupRoot) ? readdirSync(backupRoot).filter((n) => !n.startsWith(".")) : [];
      assert.equal(ids.length, 1, `expected one transaction, found ${ids.join(",")}`);
      return ids[0];
    },
    journal: () => JSON.parse(readFileSync(join(backupRoot, world.txId(), "journal.json"), "utf8")),
    locks: () => (existsSync(backupRoot) ? readdirSync(backupRoot).filter((n) => n.startsWith(".lock.")) : []),
    calls: () => world.state().calls.length,
    latest: () => world.state().tags["kaoiro-server:latest"],
    serviceContainer: () => world.state().containers.find((c) => c.service === "kaoiro"),
  };
  return world;
}

test("stateful curl reads its sidecar under authority and ignores a conflicting legacy environment", (t) => {
  const world = makeWorld(t), curl = join(world.root, "bin", "curl");
  const readHealth = () => JSON.parse(execChildSync("authority", curl, [], { encoding: "utf8" }));
  assert.equal(readHealth().build_revision, world.oldSha);
  const conflicting = join(world.root, "wrong-state.json");
  writeFileSync(conflicting, JSON.stringify({
    containers: [{ service: "kaoiro", status: "running", image: "wrong" }],
    images: { wrong: { revision: "wrong-revision" } },
  }));
  const env = { ...process.env, FAKE_DOCKER_STATE: conflicting };
  assert.equal(JSON.parse(execFileSync(curl, [], { encoding: "utf8", env })).build_revision, world.oldSha);
  world.edit(state => { state.healthFailRevision = world.oldSha; });
  assert.equal(readHealth().build_revision, "starting");
  world.edit(state => { state.containers = []; });
  assert.throws(readHealth, error => error.status === 7 && /Failed to connect/.test(error.stderr));
  rmSync(curl + ".state");
  assert.throws(() => execFileSync(curl, [], { env, stdio: "pipe" }), error => error.status !== 0);
});

function tokenize(text) {
  const words = [];
  const re = /'((?:[^']|'\\'')*)'|(\S+)/g;
  let m;
  while ((m = re.exec(text)) !== null) words.push(m[1] !== undefined ? m[1].replace(/'\\''/g, "'") : m[2]);
  return words;
}

/** Commands printed on `next:` lines: argv plus the optional flags offered. */
function parseNext(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("next: ")) continue;
    const body = line.slice(6);
    const cut = body.search(/ \(/);
    const argv = tokenize(cut === -1 ? body : body.slice(0, cut));
    const optional = [...body.matchAll(/(?:add |; )(--[a-z-]+) when /g)].map((m) => m[1]);
    out.push({ argv, optional, command: argv[2] });
  }
  return out;
}

function statusRecovery(world) {
  const r = world.cliRun("status");
  assert.equal(r.status, 0, r.stderr);
  const tx = JSON.parse(r.stdout).unfinishedTransaction;
  return tx === null ? [] : tx.recovery.filter((l) => l.argv !== null)
    .map((l) => ({ argv: l.argv, optional: l.optional.map((o) => o.flag), command: l.command }));
}

/** After a killed run: the next invocation must be refused by the lock and
 *  name `status`; the owner check is trivially true here (the run is dead),
 *  so the test removes the lock as the runbook says and reads `status`. */
function recoverFromKill(world, args) {
  const again = world.cliRun(...args);
  assert.notEqual(again.status, 0);
  const held = /^note: deploy lock (\S+) is held: /m.exec(again.stderr);
  assert.ok(held, `lock refusal expected, got: ${again.stderr}`);
  const status = parseNext(again.stderr).find((c) => c.command === "status");
  assert.ok(status, again.stderr);
  rmdirSync(held[1]);
  // The printed status command, run as printed (it must carry --config).
  const r = world.exec(status.argv);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.locks, []);
  return report.unfinishedTransaction.recovery.filter((l) => l.argv !== null)
    .map((l) => ({ argv: l.argv, optional: l.optional.map((o) => o.flag), command: l.command }));
}

/** Executes printed commands, preferring `prefer`, until a terminal phase.
 *  Progress is a strict increase of the phase rank; a run that leaves the
 *  phase unchanged is reported as no progress. `exec` is injectable so the
 *  checker itself can be tested against a CLI that does nothing. */
function followHints(world, candidates, prefer, { exec = world.exec, maxSteps = 4 } = {}) {
  const steps = [];
  let current = candidates;
  for (let step = 0; step < maxSteps; step++) {
    const choice = current.find((c) => c.command === prefer) ?? current[0];
    assert.ok(choice, `no printed command at phase ${world.journal().phase}`);
    const argv = [...choice.argv];
    if (choice.optional.includes("--maintenance-approved")) argv.push("--maintenance-approved");
    const before = world.journal().phase;
    let r = exec(argv);
    // The operator's attestation, offered as an optional flag: with no live
    // server to ask, the fleet is stopped (the model has no other node).
    if (/explicit --fleet-stopped is required/.test(r.stderr) && choice.optional.includes("--fleet-stopped")) {
      argv.push("--fleet-stopped");
      r = exec(argv);
    }
    const after = world.journal().phase;
    steps.push({ argv, before, after, status: r.status });
    if (TERMINAL.has(after)) return { phase: after, steps };
    assert.ok(rank(after) > rank(before), `no progress: ${before} -> ${after} after ${argv.join(" ")}\n${r.stderr}`);
    current = parseNext(r.stderr);
  }
  assert.fail(`no terminal phase within ${maxSteps} steps: ${JSON.stringify(steps)}`);
}

function assertAgrees(world, printed) {
  const fromStatus = statusRecovery(world).map((c) => c.argv.join(" ")).sort();
  assert.deepEqual(printed.map((c) => c.argv.join(" ")).sort(), fromStatus);
}

// Transaction ids have one-second resolution; a fresh update in the same
// second as the closed one would reuse its id, so wait only in that case.
function waitPastId(closed) {
  while (newTransactionId() === closed) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}

function assertNextUpdateAdmitted(world, refusedBy = null) {
  waitPastId(world.txId());
  const r = world.update();
  if (refusedBy !== null) {
    assert.match(r.stderr, refusedBy);
    assert.doesNotMatch(r.stderr, /is unfinished/);
    return;
  }
  assert.equal(r.status, 64, r.stderr);
  assert.match(r.stderr, /requires --maintenance-approved/);
}

function assertNonDestructive(world, volumeBefore) {
  assert.equal(digestDir(world.volumeDir), volumeBefore, "non-destructive rollback must not write the volume");
  assert.equal(world.latest(), OLD_IMAGE);
  const c = world.serviceContainer();
  assert.deepEqual([c.id, c.image, c.status], [OLD_CONTAINER, OLD_IMAGE, "running"]);
}

function assertDestructive(world, preDeploy) {
  assert.equal(digestDir(world.volumeDir), preDeploy, "destructive rollback must restore the pre-deploy contents");
  assert.equal(world.latest(), OLD_IMAGE);
  const c = world.serviceContainer();
  assert.deepEqual([c.image, c.status], [OLD_IMAGE, "running"]);
}

const UPDATE_APPROVED = ["--maintenance-approved"];
// A failure after `compose build` moved `latest`, whose own restore also
// fails: the residue a later rollback or resume must cope with.
const LATEST_LEFT_ON_TARGET = [
  { match: "^tag kaoiro-server:latest kaoiro-server:", kind: "fail" },
  { match: "^tag sha256:\\S+ kaoiro-server:latest", kind: "fail" },
];

// Phase plus durable side effect. `residual` is asserted before any recovery
// runs, so a recipe that does not reach its declared state fails as a recipe.
const RECIPES = [
  { name: "preflight: rollback tag fails", phase: PHASE.PREFLIGHT, args: [],
    faults: [{ match: "^tag \\S+ kaoiro-server:rollback-", kind: "fail" }],
    residual: (w) => assert.equal(w.latest(), OLD_IMAGE), via: ["rollback"], oracle: "record-close" },
  { name: "preflight: killed after the rollback tag", phase: PHASE.PREFLIGHT, args: [],
    faults: [{ match: "^tag \\S+ kaoiro-server:rollback-", kind: "kill-after" }],
    residual: (w) => assert.equal(w.locks().length, 1), via: ["rollback"], oracle: "record-close" },
  // Fails after `compose build` moved `latest`, so only the restore puts it back.
  { name: "old_image_saved: failure after the build moved latest (latest restored)", phase: PHASE.OLD_IMAGE_SAVED, args: [],
    faults: [{ match: "^tag kaoiro-server:latest kaoiro-server:", kind: "fail" }],
    residual: (w, r) => { assert.equal(w.latest(), OLD_IMAGE); assert.match(r.stderr, /confirmed by read-back/); },
    via: ["rollback", "update"], oracle: "non-destructive", clearFaults: true },
  { name: "old_image_saved: killed after the build (latest moved)", phase: PHASE.OLD_IMAGE_SAVED, args: [],
    faults: [{ match: "^compose build", kind: "kill-after" }],
    residual: (w) => assert.notEqual(w.latest(), OLD_IMAGE), via: ["rollback", "update"], oracle: "non-destructive", clearFaults: true },
  { name: "old_image_saved: build failure with a pre-bridge fleet (issue 584)", phase: PHASE.OLD_IMAGE_SAVED, args: [],
    world: { fleet: null }, faults: [{ match: "^compose build", kind: "fail" }],
    residual: (w) => assert.equal(w.latest(), OLD_IMAGE), via: ["rollback"], oracle: "non-destructive" },
  { name: "build_prepared: probe fails, killed right after latest is restored", phase: PHASE.BUILD_PREPARED, args: [],
    faults: [{ match: "PersistencePaths\\.beam", kind: "fail" }, { match: "^tag sha256:\\S+ kaoiro-server:latest", kind: "kill-after" }],
    residual: (w) => { assert.equal(w.latest(), OLD_IMAGE); assert.equal(w.locks().length, 1); },
    via: ["rollback", "update"], oracle: "non-destructive", clearFaults: true },
  { name: "env_consistency_checked: stopped at the maintenance gate", phase: PHASE.ENV_CONSISTENCY_CHECKED, args: [],
    faults: [], residual: () => {}, via: ["rollback", "update"], oracle: "non-destructive" },
  { name: "maintenance_gate_passed: pre-bridge fleet refuses the stop", phase: PHASE.MAINTENANCE_GATE_PASSED, args: UPDATE_APPROVED,
    world: { fleet: null }, faults: [], residual: (w) => assert.equal(w.serviceContainer().status, "running"),
    via: ["rollback"], oracle: "non-destructive" },
  { name: "stopping: killed before compose stop", phase: PHASE.STOPPING, args: UPDATE_APPROVED,
    faults: [{ match: "^compose stop", kind: "kill-before" }],
    residual: (w) => assert.equal(w.serviceContainer().status, "running"), via: ["rollback"], oracle: "non-destructive" },
  { name: "stopping: killed after compose stop", phase: PHASE.STOPPING, args: UPDATE_APPROVED,
    faults: [{ match: "^compose stop", kind: "kill-after" }],
    residual: (w) => assert.equal(w.serviceContainer().status, "exited"), via: ["rollback"], oracle: "non-destructive" },
  { name: "stopped: unclean stop", phase: PHASE.STOPPED, args: UPDATE_APPROVED, stopExitCode: 137, faults: [],
    residual: (w, r) => { assert.equal(w.serviceContainer().status, "exited"); assert.doesNotMatch(r.stderr, /docker start/); },
    via: ["rollback"], oracle: "non-destructive" },
  { name: "mount_resolved: partial archive", phase: PHASE.MOUNT_RESOLVED, args: UPDATE_APPROVED,
    faults: [{ match: "tar czf /backup/archive.tar.gz", kind: "corrupt" }],
    residual: (w) => assert.equal(w.serviceContainer().status, "exited"), via: ["rollback"], oracle: "non-destructive" },
  { name: "archived: latest pin fails", phase: PHASE.ARCHIVED, args: UPDATE_APPROVED,
    faults: [{ match: "^tag sha256:\\S+ kaoiro-server:latest", kind: "fail" }],
    residual: (w) => assert.equal(w.serviceContainer().status, "exited"), via: ["rollback"], oracle: "non-destructive" },
  { name: "archived: killed after the latest pin", phase: PHASE.ARCHIVED, args: UPDATE_APPROVED,
    faults: [{ match: "^tag sha256:\\S+ kaoiro-server:latest", kind: "kill-after" }],
    residual: (w) => { assert.notEqual(w.latest(), OLD_IMAGE); assert.equal(w.serviceContainer().status, "exited"); },
    via: ["rollback"], oracle: "non-destructive" },
  { name: "starting: compose up fails", phase: PHASE.STARTING, args: UPDATE_APPROVED,
    faults: [{ match: "^compose up -d --no-build$", kind: "fail" }],
    residual: (w) => assert.equal(w.serviceContainer().status, "exited"), via: ["rollback"], oracle: "destructive" },
  { name: "starting: killed after compose up (new container running)", phase: PHASE.STARTING, args: UPDATE_APPROVED,
    faults: [{ match: "^compose up -d --no-build$", kind: "kill-after" }],
    residual: (w) => assert.equal(w.serviceContainer().image === OLD_IMAGE, false), via: ["rollback"], oracle: "destructive" },
  { name: "up: the target never reports healthy", phase: PHASE.UP, args: UPDATE_APPROVED, healthFailsForTarget: true,
    faults: [], residual: (w) => assert.equal(w.serviceContainer().status, "running"), via: ["rollback"], oracle: "destructive" },
  { name: "healthy: restarted during the stability window", phase: PHASE.HEALTHY, args: UPDATE_APPROVED, restartBump: true,
    faults: [], residual: () => {}, via: ["rollback"], oracle: "destructive" },
];

function reach(t, recipe) {
  const world = makeWorld(t, recipe.world ?? {});
  world.edit((s) => {
    s.faults = recipe.faults;
    if (recipe.stopExitCode !== undefined) s.stopExitCode = recipe.stopExitCode;
    if (recipe.healthFailsForTarget) s.healthFailRevision = world.target;
    if (recipe.restartBump) s.restartBump = true;
  });
  const preDeploy = digestDir(world.volumeDir);
  const r = world.update(...recipe.args);
  assert.notEqual(r.status, 0, `${recipe.name}: the injected run should not succeed\n${r.stderr}`);
  assert.equal(world.journal().phase, recipe.phase, `${recipe.name}: reached ${world.journal().phase}\n${r.stderr}`);
  recipe.residual(world, r);
  return { world, r, preDeploy };
}

for (const recipe of RECIPES) {
  for (const prefer of recipe.via) {
    test(`recovery property: ${recipe.name}, closed by ${prefer}`, (t) => {
      const { world, r, preDeploy } = reach(t, recipe);
      let candidates;
      if (r.signal === "SIGKILL") {
        candidates = recoverFromKill(world, ["update", "--target", world.target, ...recipe.args]);
      } else {
        candidates = parseNext(r.stderr);
        assertAgrees(world, candidates);
      }
      if (recipe.clearFaults) world.faults([]);
      if (prefer === "update") world.edit((s) => { s.fleet = { schema: 1, hosts: [], wrappers: [] }; s.healthFailRevision = null; });
      // The old server keeps writing while the transaction is open; a
      // non-destructive rollback must keep that write.
      if (recipe.oracle === "non-destructive" && world.serviceContainer().status === "running") {
        writeFileSync(join(world.volumeDir, "written-by-old.txt"), "old\n");
      }
      const volumeBefore = digestDir(world.volumeDir);
      const callsBefore = world.calls();
      const result = followHints(world, candidates, prefer);
      if (prefer === "update") {
        assert.equal(result.phase, PHASE.DONE);
        assert.equal(world.state().images[world.serviceContainer().image].revision, world.target);
        return;
      }
      assert.equal(result.phase, PHASE.ROLLED_BACK);
      if (recipe.oracle === "record-close") assert.equal(world.calls(), callsBefore, "record-close must not call docker");
      if (recipe.oracle === "non-destructive") assertNonDestructive(world, volumeBefore);
      if (recipe.oracle === "destructive") assertDestructive(world, preDeploy);
      assertNextUpdateAdmitted(world, recipe.nextUpdate ?? null);
    });
  }
}

test("recovery property: every non-terminal update phase is reached by at least one recipe or is deferred", () => {
  const reached = new Set(RECIPES.map((r) => r.phase));
  const deferred = new Set([PHASE.ROLLBACK_STOPPED, PHASE.ROLLBACK_FORENSIC_ARCHIVED, PHASE.ROLLBACK_RESTORING,
    PHASE.ROLLBACK_RESTORED]);
  // done is reached by the explicit-rollback test.
  for (const phase of PHASES) {
    if (phase === PHASE.ROLLED_BACK || phase === PHASE.DONE) continue;
    assert.ok(reached.has(phase) || deferred.has(phase), `no recipe reaches ${phase}`);
  }
});

test("recovery property: build_prepared after a persistence-path probe failure resumes to done", (t) => {
  const world = makeWorld(t);
  world.faults([{ match: "PersistencePaths\\.beam", kind: "fail" }]);
  const r = world.update();
  assert.equal(world.journal().phase, PHASE.BUILD_PREPARED, r.stderr);
  assert.equal(world.latest(), OLD_IMAGE);
  const candidates = parseNext(r.stderr);
  assertAgrees(world, candidates);
  world.faults([]);
  assert.equal(followHints(world, candidates, "update").phase, PHASE.DONE);
});

test("recovery property: done is closed by an explicit destructive rollback", (t) => {
  const world = makeWorld(t);
  const preDeploy = digestDir(world.volumeDir);
  const r = world.update(...UPDATE_APPROVED);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(world.volumeDir, "written-by-target.txt")));
  const id = world.txId();
  const done = world.cliRun("rollback", "--transaction", id, "--confirm-restore");
  assert.equal(done.status, 0, done.stderr);
  assert.equal(world.journal().phase, PHASE.ROLLED_BACK);
  assertDestructive(world, preDeploy);
  assertNextUpdateAdmitted(world);
});

for (const change of ["container", "image", "target", "rollback-tag", "recovery-plan"]) {
  test(`recovery property: old_image_saved resume refuses a changed ${change} before any Docker mutation`, (t) => {
    const world = makeWorld(t);
    world.faults(LATEST_LEFT_ON_TARGET);
    world.update();
    assert.equal(world.journal().phase, PHASE.OLD_IMAGE_SAVED);
    assert.notEqual(world.latest(), OLD_IMAGE);
    world.edit((s) => {
      s.faults = [];
      s.counters = {};
      // The recorded container still exists under another name, so only the
      // id comparison can tell that a different container now serves.
      if (change === "container") {
        s.containers.push({ ...s.containers[0], id: "d".repeat(64), status: "running" });
        Object.assign(s.containers[0], { name: "kaoiro-old", status: "exited", service: "detached" });
      }
      if (change === "image") s.containers[0].image = `sha256:${"0".repeat(63)}2`;
      if (change === "rollback-tag") s.tags[`kaoiro-server:rollback-${world.oldSha}`] = `sha256:${"0".repeat(63)}2`;
    });
    if (change === "recovery-plan") {
      const file = join(world.backupRoot, world.txId(), "recovery-compose.yaml");
      writeFileSync(file, `${readFileSync(file, "utf8")}# edited\n`);
    }
    const before = world.state().calls.length;
    const target = change === "target" ? world.oldSha : world.target;
    const r = world.cliRun("update", "--transaction", world.txId(), "--target", target, ...UPDATE_APPROVED);
    assert.notEqual(r.status, 0);
    if (change === "container") assert.match(r.stderr, /not the recorded c{64}/);
    const calls = world.state().calls.slice(before);
    assert.deepEqual(calls.filter((c) => /^(tag|start|stop|compose (build|stop|up))/.test(c)), [], r.stderr);
    assert.equal(world.journal().phase, PHASE.OLD_IMAGE_SAVED);
  });
}

test("recovery property: update --transaction on a commit-half phase is refused before any Docker call or phase change", (t) => {
  const world = makeWorld(t);
  world.faults([{ match: "^compose stop", kind: "kill-before" }]);
  world.update(...UPDATE_APPROVED);
  rmdirSync(join(world.backupRoot, world.locks()[0]));
  const journalBytes = readFileSync(join(world.backupRoot, world.txId(), "journal.json"));
  const before = world.state().calls.length;
  const r = world.cliRun("update", "--transaction", world.txId(), "--target", world.target, ...UPDATE_APPROVED);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /cannot be resumed by update \(phase: stopping\)/);
  assert.deepEqual(world.state().calls.slice(before), []);
  assert.deepEqual(readFileSync(join(world.backupRoot, world.txId(), "journal.json")), journalBytes);
});

test("recovery property: a legacy journal without the container id starts the named container only on the old image", (t) => {
  for (const reused of [false, true]) {
    const world = makeWorld(t);
    world.faults(LATEST_LEFT_ON_TARGET);
    world.update();
    assert.notEqual(world.latest(), OLD_IMAGE);
    world.faults([]);
    const path = join(world.backupRoot, world.txId(), "journal.json");
    const journal = JSON.parse(readFileSync(path, "utf8"));
    delete journal.history.find((e) => e.phase === PHASE.OLD_IMAGE_SAVED).observation.old_container_id;
    writeFileSync(path, JSON.stringify(journal));
    if (reused) world.edit((s) => { s.containers[0].image = `sha256:${"0".repeat(63)}2`; s.containers[0].status = "exited"; });
    const r = world.cliRun("rollback", "--transaction", world.txId(), "--confirm-restore");
    if (reused) {
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /not the recorded old image/);
      assert.equal(world.serviceContainer().status, "exited");
      assert.equal(world.latest(), OLD_IMAGE, "a refused rollback still restores latest");
    } else {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(world.journal().phase, PHASE.ROLLED_BACK);
      assertNextUpdateAdmitted(world);
    }
  }
});

// Rollback-chain rows are deferred to L1b: they must render the runbook note
// and no command, from the failing run and from `status` alike.
const DEFERRED = [
  { name: "forensic archive fails", phase: PHASE.ROLLBACK_STOPPED,
    fault: { match: "tar czf /backup/rollback-forensic.tar.gz", kind: "fail" } },
  { name: "wipe partly done", phase: PHASE.ROLLBACK_RESTORING,
    fault: { match: "find /data -mindepth 1 -maxdepth 1 -exec rm", kind: "partial" } },
  { name: "old image never reports healthy after compose up", phase: PHASE.ROLLBACK_RESTORED, healthFailsForOld: true },
];
for (const recipe of DEFERRED) {
  test(`recovery property: ${recipe.phase} (${recipe.name}) renders the L1b note and no command`, (t) => {
    const world = makeWorld(t);
    assert.equal(world.update(...UPDATE_APPROVED).status, 0);
    world.edit((s) => {
      s.faults = recipe.fault ? [recipe.fault] : [];
      s.counters = {};
      if (recipe.healthFailsForOld) s.healthFailRevision = world.oldSha;
    });
    const id = world.txId();
    const r = world.cliRun("rollback", "--transaction", id, "--confirm-restore");
    assert.notEqual(r.status, 0);
    if (r.signal === "SIGKILL") rmdirSync(join(world.backupRoot, world.locks()[0]));
    assert.equal(world.journal().phase, recipe.phase);
    assert.deepEqual(statusRecovery(world), []);
    const again = world.cliRun("rollback", "--transaction", id, "--confirm-restore");
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /4\.4 \(3a\)/);
    assert.deepEqual(parseNext(again.stderr), []);
  });
}

test("recovery property checker: a printed command that changes nothing is reported as no progress", (t) => {
  const world = makeWorld(t);
  world.faults([{ match: "^compose build", kind: "fail" }]);
  const r = world.update();
  assert.throws(() => followHints(world, parseNext(r.stderr), "rollback", { exec: () => ({ status: 0, stderr: "" }) }),
    /no progress/);
});

test("recovery property: an enrolled server killed mid-rollback leaves both locks, and the printed steps recover it", (t) => {
  const world = makeWorld(t);
  world.faults([{ match: "^compose build", kind: "fail" }]);
  world.update();
  assert.equal(world.journal().phase, PHASE.OLD_IMAGE_SAVED);
  const history = join(world.root, "history");
  mkdirSync(history, { mode: 0o700 });
  const serverDir = realpathSync(join(world.work, "server"));
  // The authority descriptor requires a parent that only its owner can write.
  chmodSync(serverDir, 0o755);
  writeFileSync(join(serverDir, ".kaoiro-release-authority.json"), JSON.stringify({
    schema: 1, install_root: serverDir, transport: "local", recording_hostname: hostname(),
    root: realpathSync(history), tool_sha256: "a".repeat(64), exporter_path: process.execPath,
    node_major: Number(process.versions.node.split(".")[0]), node_path: process.execPath,
  }), { mode: 0o600 });
  world.faults([{ match: "^start ", kind: "kill-after" }]);
  const id = world.txId();
  const rollback = () => world.cliRun("rollback", "--transaction", id, "--confirm-restore");
  const killed = rollback();
  assert.equal(killed.signal, "SIGKILL", killed.stderr);
  assert.equal(world.locks().length, 1);
  assert.ok(existsSync(join(realpathSync(history), ".lock.server")));
  world.faults([]);

  // One refusal names both locks, each with its own step.
  const first = rollback();
  const held = /^note: deploy lock (\S+) is held: /m.exec(first.stderr);
  assert.ok(held, first.stderr);
  assert.match(first.stderr, /^note: release lock \S+\/\.lock\.server is held: /m);
  rmdirSync(held[1]);
  const [inspect, recover, status] = parseNext(first.stderr);
  assert.deepEqual([inspect.argv[2], recover.argv[2], status.argv[2]], ["inspect-residue", "recover-lock", "status"]);
  const inspected = world.exec(inspect.argv);
  assert.equal(inspected.status, 0, inspected.stderr);
  const digest = JSON.parse(inspected.stdout).observed_sha256;
  const recoverArgv = recover.argv.map((w) => (w === "<observed_sha256-from-inspect-residue>" ? digest
    : w === "<reason>" ? "recovery property test" : w));
  const recovered = world.exec(recoverArgv);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(existsSync(join(realpathSync(history), ".lock.server")), false);

  const printedStatus = world.exec(status.argv);
  assert.equal(printedStatus.status, 0, printedStatus.stderr);
  const report = JSON.parse(printedStatus.stdout);
  assert.deepEqual(report.locks, []);
  const candidates = report.unfinishedTransaction.recovery.filter((l) => l.argv !== null)
    .map((l) => ({ argv: l.argv, optional: l.optional.map((o) => o.flag), command: l.command }));
  const result = followHints(world, candidates, "rollback");
  assert.equal(result.phase, PHASE.ROLLED_BACK);
  assert.deepEqual(world.locks(), []);
  assert.equal(world.serviceContainer().status, "running");
});

// Design NC8: an enrolled transaction prepared under a release attempt is
// resumed by the printed `update` line, which carries the release context.
// The exporter is a fake that echoes the context; the refusal of a resume
// without it is the deploy CLI's own (assertServerResumeContext).
test("recovery property: an enrolled update resume runs as printed with its release context, and is refused without it", (t) => {
  const world = makeWorld(t);
  mkdirSync(join(world.root, "history"), { mode: 0o700 });
  const history = realpathSync(join(world.root, "history"));
  const serverDir = realpathSync(join(world.work, "server"));
  chmodSync(serverDir, 0o755);
  const exporter = join(world.root, "bin", "release-exporter.mjs");
  copyFileSync(join(here, "../test-support/fake-release-exporter.mjs"), exporter);
  const descriptor = JSON.stringify({
    schema: 1, install_root: serverDir, transport: "local", recording_hostname: hostname(),
    root: history, tool_sha256: "a".repeat(64), exporter_path: exporter,
    node_major: Number(process.versions.node.split(".")[0]), node_path: process.execPath,
  });
  writeFileSync(join(serverDir, ".kaoiro-release-authority.json"), descriptor, { mode: 0o600 });
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const attempt = "11111111-2222-4333-8444-555555555555";
  const plan = JSON.stringify({ authority: { server: { sha256: sha256(descriptor), root: serverDir } } });
  mkdirSync(join(history, attempt), { mode: 0o700 });
  writeFileSync(join(history, attempt, "attempt.json"), plan, { mode: 0o600 });
  const context = ["--release-attempt", attempt, "--release-plan-sha256", sha256(plan)];

  world.faults([{ match: "^compose build", kind: "fail" }]);
  const failed = world.update(...context);
  assert.notEqual(failed.status, 0);
  assert.equal(world.journal().phase, PHASE.OLD_IMAGE_SAVED);
  assert.deepEqual(world.journal().release_context, { attempt_uuid: attempt, plan_sha256: sha256(plan) });
  world.faults([]);
  const printed = parseNext(failed.stderr).find((c) => c.command === "update");
  assert.ok(printed, failed.stderr);
  assert.deepEqual(printed.argv.slice(printed.argv.indexOf("--release-attempt")), context);
  assertAgrees(world, parseNext(failed.stderr));

  // Control: the printed command without its release context is refused by
  // the audit before any Docker call or phase change.
  const contextFlags = new Set(["--release-attempt", "--release-plan-sha256"]);
  const stripped = printed.argv.filter((w, i, a) => !contextFlags.has(w) && !contextFlags.has(a[i - 1]));
  assert.equal(stripped.length, printed.argv.length - 4);
  const before = world.calls();
  const refused = world.exec([...stripped, ...UPDATE_APPROVED]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /resume cannot change or omit its authoritative release attempt/);
  assert.equal(world.calls(), before);
  assert.equal(world.journal().phase, PHASE.OLD_IMAGE_SAVED);
  assert.deepEqual(world.locks(), []);

  const result = followHints(world, [printed], "update");
  assert.equal(result.phase, PHASE.DONE);
  assert.ok(result.steps[0].argv.includes("--release-attempt"));
  assert.equal(world.serviceContainer().image === OLD_IMAGE, false);
  assert.deepEqual(world.locks(), []);
  assert.equal(existsSync(join(history, ".lock.server")), false);
  const bound = JSON.parse(readFileSync(join(history, attempt, "server-audit.json"), "utf8"));
  assert.equal(bound.transaction_dir, realpathSync(join(world.backupRoot, world.txId())));
});

test("recovery property: a non-destructive rollback refuses when the recorded container was replaced, even under the same name", (t) => {
  const world = makeWorld(t);
  world.faults(LATEST_LEFT_ON_TARGET);
  world.update();
  assert.notEqual(world.latest(), OLD_IMAGE);
  world.faults([]);
  world.edit((s) => { s.containers[0].id = "d".repeat(64); s.containers[0].status = "exited"; });
  const before = world.state().calls.length;
  const r = world.cliRun("rollback", "--transaction", world.txId(), "--confirm-restore");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /cannot read the image of container c{64}/);
  assert.deepEqual(world.state().calls.slice(before).filter((c) => /^start /.test(c)), []);
  assert.equal(world.serviceContainer().status, "exited");
  assert.equal(world.latest(), OLD_IMAGE, "a refused rollback still restores latest");
});

for (const point of ["^tag sha256:\\S+ kaoiro-server:latest", "^start "]) {
  test(`recovery property: a non-destructive rollback killed at ${point} is completed by the rerun status prints`, (t) => {
    const world = makeWorld(t);
    world.faults([{ match: "^tag kaoiro-server:latest kaoiro-server:", kind: "fail" }]);
    world.update();
    assert.equal(world.journal().phase, PHASE.OLD_IMAGE_SAVED);
    world.faults([{ match: point, kind: "kill-after" }]);
    const args = ["rollback", "--transaction", world.txId(), "--confirm-restore"];
    assert.equal(world.cliRun(...args).signal, "SIGKILL");
    assert.equal(world.journal().phase, PHASE.OLD_IMAGE_SAVED);
    world.faults([]);
    const volumeBefore = digestDir(world.volumeDir);
    assert.equal(followHints(world, recoverFromKill(world, args), "rollback").phase, PHASE.ROLLED_BACK);
    assertNonDestructive(world, volumeBefore);
    assertNextUpdateAdmitted(world);
  });
}

for (const overrideMount of [false, true]) {
  test(`recovery property: issue 681 admitted forward, override=${overrideMount}`, t => {
    const world = makeWorld(t, { overrideMount });
    const result = world.update(...UPDATE_APPROVED);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(world.journal().phase, PHASE.DONE);
    assert.equal(world.state().images[world.serviceContainer().image].revision, world.target);
    if (overrideMount) {
      const manifest = JSON.parse(readFileSync(join(world.backupRoot, world.txId(), "manifest.json"), "utf8"));
      for (const plan of [manifest.recovery_plan, manifest.target_plan]) {
        assert.ok(plan.identity.service_mounts.some(mount => mount.type === "bind" && mount.source === "/srv/overlay"));
      }
      rmSync(join(world.work, "server", "docker-compose.override.yaml"));
      const rollback = world.cliRun("rollback", "--transaction", world.txId(), "--confirm-restore");
      assert.equal(rollback.status, 0, rollback.stderr);
      assert.equal(world.journal().phase, PHASE.ROLLED_BACK);
    }
    assertNextUpdateAdmitted(world);
  });
}

for (const mode of ["yml", "both", "directory"]) {
  test(`recovery property: stateful Compose discovery fixture ${mode}`, t => {
    const world = makeWorld(t, { overrideMount: true });
    const path = join(world.work, "server", "docker-compose.override.yml");
    if (mode === "directory") mkdirSync(path);
    else writeFileSync(path, JSON.stringify({ services: { kaoiro: { volumes: [{ type: "bind", source: "/srv/preferred", target: "/overlay" }] } } }));
    if (mode === "yml") rmSync(join(world.work, "server", "docker-compose.override.yaml"));
    const result = world.compose("config", "--format", "json");
    if (mode === "directory") {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /EISDIR/);
    } else {
      assert.equal(result.status, 0, result.stderr);
      const mounts = JSON.parse(result.stdout).services.kaoiro.volumes;
      assert.ok(mounts.some(mount => mount.source === "/srv/preferred"));
      assert.ok(!mounts.some(mount => mount.source === "/srv/overlay"));
    }
  });
}


test("recovery property: ordinary rollback killed after start retains its lock and printed recovery completes", (t) => {
  const world = makeWorld(t);
  world.faults([{ match: "^compose build", kind: "fail" }]);
  world.update();
  assert.equal(world.journal().phase, PHASE.OLD_IMAGE_SAVED);
  world.faults([{ match: "^start ", kind: "kill-after" }]);
  const id = world.txId();
  const rollback = () => world.cliRun("rollback", "--transaction", id, "--confirm-restore");
  assert.equal(rollback().signal, "SIGKILL");
  assert.equal(world.locks().length, 1);
  world.faults([]);
  const refused = rollback();
  const held = /^note: deploy lock (\S+) is held: /m.exec(refused.stderr);
  assert.ok(held, refused.stderr);
  assert.notEqual(refused.status, 0);
  rmdirSync(held[1]);
  const status = parseNext(refused.stderr).find(command => command.command === "status");
  assert.ok(status, refused.stderr);
  const report = world.exec(status.argv);
  assert.equal(report.status, 0, report.stderr);
  const next = JSON.parse(report.stdout).unfinishedTransaction.recovery.filter(line => line.argv !== null)
    .map(line => ({ ...line, optional: line.optional.map(option => option.flag) }));
  const result = followHints(world, next, "rollback");
  assert.equal(result.phase, PHASE.ROLLED_BACK);
  assert.deepEqual(world.locks(), []);
  assert.equal(world.serviceContainer().status, "running");
});

test("recovery property: ordinary resume executes its printed repo config target and transaction", (t) => {
  const world = makeWorld(t);
  world.faults([{ match: "^compose build", kind: "fail" }]);
  const failed = world.update();
  assert.notEqual(failed.status, 0);
  assert.equal(world.journal().phase, PHASE.OLD_IMAGE_SAVED);
  const printed = parseNext(failed.stderr).find(command => command.command === "update");
  assert.ok(printed, failed.stderr);
  for (const [flag, value] of [["--repo", world.work], ["--config", world.config], ["--target", world.target], ["--transaction", world.txId()]]) {
    assert.equal(printed.argv[printed.argv.indexOf(flag) + 1], value);
  }
  assert.equal(printed.argv.some(value => /^--(?:release-|skip-release)/.test(value)), false);
  world.faults([]);
  const result = followHints(world, [printed], "update");
  assert.equal(result.phase, PHASE.DONE);
  assert.notEqual(world.serviceContainer().image, OLD_IMAGE);
  assert.deepEqual(world.locks(), []);
});

test("actual CLI journals remain discoverable by the pinned pre-P3 reader without Git history", async (t) => {
  const fixture = new URL("../test-support/pre-p3-reader/", import.meta.url);
  const provenance = JSON.parse(readFileSync(new URL("provenance.json", fixture), "utf8"));
  assert.equal(provenance.commit, "3dd4551c2b483932e09f47523157fb1749842685");
  assert.equal(provenance.files.length, 8);
  for (const { file, sha256 } of provenance.files) {
    assert.equal(createHash("sha256").update(readFileSync(new URL(file, fixture))).digest("hex"), sha256, file);
  }
  const old = await import(new URL("kaoiro-deploy-journal.mjs", fixture));
  const transaction = await import(new URL("kaoiro-deploy-transaction.mjs", fixture));
  const world = makeWorld(t);
  world.faults([{ match: "^compose build", kind: "fail" }]);
  const failed = world.update();
  assert.notEqual(failed.status, 0);
  const dir = join(world.backupRoot, world.txId()), journal = world.journal();
  assert.equal(journal.invocation.release_authority, null);
  assert.equal(old.isValidJournalShape(journal), true);
  assert.deepEqual(old.readJournal(dir), journal);
  assert.equal(transaction.findUnfinishedTransaction(world.backupRoot).id, world.txId());
});
