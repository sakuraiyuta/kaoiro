import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { DEFAULT_CONFIG } from "../kaoiro-deploy-config.mjs";
import { readJournal } from "../kaoiro-deploy-journal.mjs";
import { readManifest } from "../kaoiro-deploy-manifest.mjs";
import {
  DeployError,
  hasPriorTransactions,
  parseArgs,
  runBuild,
  runStart,
  runUpdate,
} from "../kaoiro-server-deploy.mjs";

// A single fake docker covering every branch runBuild/runStart/runUpdate
// exercise: `compose build` / `compose stop` / `compose up -d --build` /
// `tag` / `start` all succeed silently; `inspect ... --format {{.Id}}`
// and `{{.Image}}` return fixed fake ids; `compose ps -a` / `inspect ...
// --format {{.State.Status}}` / clean-stop fields / the mount lookup are
// driven by FAKE_DOCKER_SCENARIO the same way test/branch.test.mjs's
// fake does. FAKE_DOCKER_SCENARIO "running-clean-stop" additionally
// reports a clean stop (exit 0, not OOM-killed) and a resolvable mount,
// for the tests that exercise runUpdate all the way through
// MOUNT_RESOLVED.
const FAKE_DOCKER = `#!/bin/sh
case "$1" in
  compose)
    case "$2" in
      ps)
        case "$FAKE_DOCKER_SCENARIO" in
          stopped|running|running-clean-stop|running-no-mount|running-empty-vol|running-broken-archive)
            printf 'kaoiro-c1\\n' ;;
        esac
        ;;
      build|up|stop) exit 0 ;;
    esac
    ;;
  tag) exit 0 ;;
  inspect)
    case "$4" in
      '{{.State.Status}}')
        case "$FAKE_DOCKER_SCENARIO" in
          stopped) printf 'exited\\n' ;;
          running|running-clean-stop|running-no-mount|running-empty-vol|running-broken-archive)
            printf 'running\\n' ;;
        esac
        ;;
      '{{.State.ExitCode}}')
        case "$FAKE_DOCKER_SCENARIO" in
          running-clean-stop|running-no-mount|running-empty-vol|running-broken-archive) printf '0\\n' ;;
          *) printf 'unknown\\n' ;;
        esac
        ;;
      '{{.State.OOMKilled}}')
        case "$FAKE_DOCKER_SCENARIO" in
          running-clean-stop|running-no-mount|running-empty-vol|running-broken-archive) printf 'false\\n' ;;
          *) printf 'unknown\\n' ;;
        esac
        ;;
      '{{range .Mounts}}{{if eq .Destination "/var/lib/kaoiro"}}{{.Name}}{{end}}{{end}}')
        case "$FAKE_DOCKER_SCENARIO" in
          running-clean-stop|running-empty-vol|running-broken-archive) printf 'kaoiro_kaoiro-state\\n' ;;
          running-no-mount) ;;
        esac
        ;;
      '{{.Image}}') printf 'sha256:oldimageid\\n' ;;
      *) printf 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\\n' ;;
    esac
    ;;
  run)
    case "$*" in
      *"tar czf"*)
        # Real archive step: write an actual (empty but valid) tar.gz at
        # the host path the -v ...:/backup mapping names, so the CLI's
        # own host-side \`tar tzf\` verification has something real to
        # check — a fake stdout string would not survive that.
        prev=""
        hostdir=""
        for arg in "$@"; do
          case "$prev" in
            -v)
              case "$arg" in
                *:/backup) hostdir=\${arg%:/backup} ;;
              esac
              ;;
          esac
          prev=$arg
        done
        if [ -n "$hostdir" ]; then
          case "$FAKE_DOCKER_SCENARIO" in
            running-broken-archive) printf 'not a real gzip stream' > "$hostdir/archive.tar.gz" ;;
            *) tar czf "$hostdir/archive.tar.gz" -T /dev/null ;;
          esac
        fi
        exit 0
        ;;
      *)
        # Volume listing (stat -c '%n %u:%g %a' /data/*).
        case "$FAKE_DOCKER_SCENARIO" in
          running-clean-stop|running-broken-archive) printf '/data/users.dets 1000:1000 600\\n' ;;
          running-empty-vol) ;;
        esac
        exit 0
        ;;
    esac
    ;;
  start) exit 0 ;;
esac
`;

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
  mkdirSync(join(dir, "server"), { recursive: true });
  writeFileSync(join(dir, "server", "docker-compose.yaml"), "# fixture\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

let root;
let sourceDir;
let bareDir;
let workDir;
let headSha;
let bin;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kaoiro-deploy-cli-"));
  sourceDir = join(root, "source");
  bareDir = join(root, "bare.git");
  workDir = join(root, "work");
  headSha = initRepo(sourceDir);
  execFileSync("git", ["clone", "--bare", "-q", sourceDir, bareDir]);
  execFileSync("git", ["clone", "-q", bareDir, workDir]);

  bin = join(root, "fake-docker.sh");
  writeFileSync(bin, FAKE_DOCKER);
  chmodSync(bin, 0o700);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// backup_root is pinned under the test's own tmpdir — leaving it null
// would make resolveBackupRoot() fall back to the real $HOME, coupling
// this test's outcome to whatever happens to exist there.
function configWithOverride() {
  return { ...DEFAULT_CONFIG, allow_docker_override: true, backup_root: join(root, "kaoiro-deploy") };
}

// A separate helper, not a default on configWithOverride(): most tests
// deliberately want the default null/null expectation (everything is
// abnormal), and only the tests exercising the STOPPED/MOUNT_RESOLVED
// path need a config claiming a measurement exists.
function configWithCleanStopMeasured() {
  return {
    ...configWithOverride(),
    expected_clean_stop_exit_code: 0,
    expected_clean_stop_oom_killed: false,
  };
}

function withOverrideEnv(fn) {
  const prior = process.env.KAOIRO_DEPLOY_DOCKER_BIN;
  process.env.KAOIRO_DEPLOY_DOCKER_BIN = bin;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.KAOIRO_DEPLOY_DOCKER_BIN;
    else process.env.KAOIRO_DEPLOY_DOCKER_BIN = prior;
  }
}

function withScenario(scenario, fn) {
  const prior = process.env.FAKE_DOCKER_SCENARIO;
  process.env.FAKE_DOCKER_SCENARIO = scenario;
  try {
    return withOverrideEnv(fn);
  } finally {
    if (prior === undefined) delete process.env.FAKE_DOCKER_SCENARIO;
    else process.env.FAKE_DOCKER_SCENARIO = prior;
  }
}

test("parseArgs rejects a missing command", () => {
  assert.throws(() => parseArgs([]), DeployError);
});

test("parseArgs reads value and boolean flags", () => {
  const { command, flags } = parseArgs([
    "build",
    "--repo",
    "/tmp/x",
    "--target",
    "a".repeat(40),
    "--dry-run",
  ]);
  assert.equal(command, "build");
  assert.equal(flags.repo, "/tmp/x");
  assert.equal(flags.target, "a".repeat(40));
  assert.equal(flags.dryRun, true);
});

test("parseArgs rejects a value flag whose value looks like another flag", () => {
  assert.throws(() => parseArgs(["build", "--repo", "--target"]), DeployError);
});

test("hasPriorTransactions is false for a directory that does not exist", () => {
  assert.equal(hasPriorTransactions(join(root, "does-not-exist")), false);
});

test("hasPriorTransactions is true once a transaction directory exists", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  mkdirSync(join(backupRoot, "20260906T000000Z"), { recursive: true });
  assert.equal(hasPriorTransactions(backupRoot), true);
});

test("runBuild requires --target", () => {
  assert.throws(() => runBuild({ repo: workDir }, DEFAULT_CONFIG), DeployError);
});

test("runBuild refuses a dirty repo even in dry-run", () => {
  writeFileSync(join(workDir, "dirty.txt"), "uncommitted\n");
  assert.throws(
    () => runBuild({ repo: workDir, target: headSha, dryRun: true }, DEFAULT_CONFIG),
    DeployError,
  );
});

test("runBuild dry-run reports the plan without touching git or docker", () => {
  const result = runBuild({ repo: workDir, target: headSha, dryRun: true }, DEFAULT_CONFIG);
  assert.equal(result.dryRun, true);
  assert.equal(result.docker, "docker");
  assert.ok(result.wouldRun.some((line) => line.includes("merge --ff-only")));
});

test("runBuild builds, tags and reads back the image id through the gated fake docker", () => {
  const result = withOverrideEnv(() =>
    runBuild({ repo: workDir, target: headSha }, configWithOverride()),
  );
  assert.equal(result.dryRun, false);
  assert.equal(result.docker, "fake");
  assert.equal(result.identity.revision, headSha);
  assert.equal(result.identity.dirty, false);
  assert.equal(result.imageId, `sha256:${"f".repeat(64)}`);
  assert.equal(result.imageTag, `kaoiro-server:${headSha}`);
});

test("runBuild refuses when the post-merge revision does not match --target", () => {
  // Advances workDir's own HEAD past headSha directly — the exact shape
  // this guard exists to catch: `git merge --ff-only <headSha>`, now an
  // ANCESTOR of HEAD, succeeds as a no-op ("Already up to date") while
  // HEAD stays at the newer commit computeBuildIdentity() then reports.
  writeFileSync(join(workDir, "second.txt"), "second\n");
  execFileSync("git", ["-C", workDir, "add", "-A"]);
  execFileSync("git", ["-C", workDir, "commit", "-q", "-m", "second"]);
  assert.throws(
    () => withOverrideEnv(() => runBuild({ repo: workDir, target: headSha }, configWithOverride())),
    DeployError,
  );
});

test("runStart on branch A starts the existing stopped container", () => {
  const result = withOverrideEnv(() => {
    process.env.FAKE_DOCKER_SCENARIO = "stopped";
    try {
      return runStart({ repo: workDir }, configWithOverride());
    } finally {
      delete process.env.FAKE_DOCKER_SCENARIO;
    }
  });
  assert.equal(result.branch, "A");
  assert.equal(result.container, "kaoiro-c1");
});

test("runStart on branch B refuses to bootstrap over existing prior-transaction state", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  mkdirSync(join(backupRoot, "20260906T000000Z"), { recursive: true });
  const config = { ...configWithOverride(), backup_root: backupRoot };
  assert.throws(
    () => withOverrideEnv(() => runStart({ repo: workDir, initialize: true }, config)),
    DeployError,
  );
});

test("runStart on branch C refuses without --initialize", () => {
  assert.throws(
    () => withOverrideEnv(() => runStart({ repo: workDir }, configWithOverride())),
    DeployError,
  );
});

test("runStart on branch C with --initialize and --dry-run reports the plan", () => {
  const result = withOverrideEnv(() =>
    runStart({ repo: workDir, initialize: true, dryRun: true }, configWithOverride()),
  );
  assert.equal(result.branch, "C");
  assert.equal(result.dryRun, true);
  assert.ok(result.wouldRun.some((line) => line.includes("compose up")));
});

test("runUpdate requires --target", () => {
  assert.throws(
    () => withScenario("running", () => runUpdate({ repo: workDir }, configWithOverride())),
    DeployError,
  );
});

test("runUpdate refuses when the container is not running", () => {
  assert.throws(
    () => withScenario("stopped", () => runUpdate({ repo: workDir, target: headSha }, configWithOverride())),
    Error,
  );
});

test("runUpdate stops at the maintenance gate without --maintenance-approved, but records prepare progress", () => {
  let caught;
  try {
    withScenario("running", () => runUpdate({ repo: workDir, target: headSha }, configWithOverride()));
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  const backupRoot = join(root, "kaoiro-deploy");
  const [transactionDir] = readdirSyncNonHidden(backupRoot);
  const journal = readJournal(join(backupRoot, transactionDir));
  assert.equal(journal.phase, "build_prepared");
});

test("runUpdate completes through ARCHIVED with --maintenance-approved and a clean stop", () => {
  const result = withScenario("running-clean-stop", () =>
    runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
  );
  assert.equal(result.phase, "archived");
  assert.equal(result.oldImageId, "sha256:oldimageid");
  assert.equal(result.build.imageTag, `kaoiro-server:${headSha}`);
  assert.equal(result.stopExitCode, 0);
  assert.equal(result.stopOomKilled, false);
  assert.equal(result.volumeId, "kaoiro_kaoiro-state");
  assert.equal(result.requiredEntries.length, 1);
  assert.deepEqual(result.requiredEntries[0], { path: "users.dets", owner: "1000:1000", mode: "0600" });
  assert.equal(existsSync(result.archive.path), true);
  assert.equal(result.archive.sha256, sha256File(result.archive.path));
  const backupRoot = join(root, "kaoiro-deploy");
  const journal = readJournal(join(backupRoot, result.transactionId));
  assert.equal(journal.phase, "archived");
  const manifest = readManifest(join(backupRoot, result.transactionId));
  assert.equal(manifest.volume_id, "kaoiro_kaoiro-state");
  assert.equal(manifest.image_id, result.build.imageId);
  assert.equal(manifest.source_sha, headSha);
  assert.deepEqual(manifest.required_entries, result.requiredEntries);
});

test("runUpdate refuses to archive an empty volume", () => {
  assert.throws(
    () =>
      withScenario("running-empty-vol", () =>
        runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
      ),
    DeployError,
  );
});

test("runUpdate refuses when the archive fails full-traversal verification", () => {
  assert.throws(
    () =>
      withScenario("running-broken-archive", () =>
        runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
      ),
    DeployError,
  );
});

test("runUpdate refuses to proceed when the mount cannot be resolved after stopping", () => {
  assert.throws(
    () =>
      withScenario("running-no-mount", () =>
        runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
      ),
    DeployError,
  );
});

test("runUpdate refuses to proceed past a stop with no measured clean-stop expectation", () => {
  assert.throws(
    () =>
      withScenario("running-clean-stop", () =>
        runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithOverride()),
      ),
    DeployError,
  );
});

test("runUpdate resumes a gated transaction via --transaction without rebuilding", () => {
  let transactionId;
  try {
    withScenario("running", () => runUpdate({ repo: workDir, target: headSha }, configWithOverride()));
  } catch (err) {
    assert.ok(err instanceof DeployError);
  }
  const backupRoot = join(root, "kaoiro-deploy");
  [transactionId] = readdirSyncNonHidden(backupRoot);

  const result = withScenario("running-clean-stop", () =>
    runUpdate(
      { repo: workDir, target: headSha, transaction: transactionId, maintenanceApproved: true },
      configWithCleanStopMeasured(),
    ),
  );
  assert.equal(result.phase, "archived");
  assert.equal(result.transactionId, transactionId);
});

test("runUpdate refuses to resume when --target no longer matches the prepared transaction", () => {
  try {
    withScenario("running", () => runUpdate({ repo: workDir, target: headSha }, configWithOverride()));
  } catch (err) {
    assert.ok(err instanceof DeployError);
  }
  const backupRoot = join(root, "kaoiro-deploy");
  const [transactionId] = readdirSyncNonHidden(backupRoot);
  const otherTarget = "f".repeat(40);
  assert.throws(
    () =>
      withScenario("running", () =>
        runUpdate(
          { repo: workDir, target: otherTarget, transaction: transactionId, maintenanceApproved: true },
          configWithOverride(),
        ),
      ),
    DeployError,
  );
});

test("runUpdate refuses a second transaction while one is unfinished, and creates no new transaction dir", () => {
  // maintenanceApproved:true still leaves the transaction non-terminal
  // (phase "mount_resolved" is not in TERMINAL_PHASES) — the commit
  // half that would reach "done" does not exist yet.
  withScenario("running-clean-stop", () =>
    runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
  );
  const backupRoot = join(root, "kaoiro-deploy");
  const before = readdirSyncNonHidden(backupRoot).length;
  assert.throws(
    () => withScenario("running", () => runUpdate({ repo: workDir, target: headSha }, configWithOverride())),
    DeployError,
  );
  // The count check is what actually pins the guard: without it, a
  // mutated guard that lets a second run through still ends up throwing
  // DeployError at its OWN maintenance gate, so `assert.throws` alone
  // would pass even with the duplicate-transaction check removed.
  assert.equal(
    readdirSyncNonHidden(backupRoot).length,
    before,
    "a second transaction must not be created while one is unfinished",
  );
});

function readdirSyncNonHidden(dir) {
  return readdirSync(dir).filter((name) => !name.startsWith("."));
}
