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
  VOLUME_LISTING_SCRIPT,
} from "../kaoiro-server-deploy.mjs";

// A single fake docker covering every branch runBuild/runStart/runUpdate
// exercise: `compose build` / `compose stop` / `compose up -d --build` /
// `tag` / `pull` / `start` all succeed silently; `inspect ... --format
// {{.Id}}` and `{{.Image}}` return fixed fake ids; `compose ps -a` /
// `inspect ... --format {{.State.Status}}` / clean-stop fields / the
// mount lookup are driven by FAKE_DOCKER_SCENARIO the same way
// test/branch.test.mjs's fake does. FAKE_DOCKER_SCENARIO
// "running-clean-stop" additionally reports a clean stop (exit 0, not
// OOM-killed) and a resolvable mount, for the tests that exercise
// runUpdate all the way through ARCHIVED.
//
// OLD_IMAGE_ID must be IMAGE_ID_RE-valid (クロエ round 1 review SF-1) —
// all-hex, unlike the old "sha256:oldimageid" fixture.
const OLD_IMAGE_ID = `sha256:${"0".repeat(64)}`;
const FAKE_DOCKER = `#!/bin/sh
if [ -n "$KAOIRO_TEST_CALL_LOG" ]; then printf '%s\\n' "$*" >> "$KAOIRO_TEST_CALL_LOG"; fi
case "$1" in
  compose)
    case "$2" in
      ps)
        case "$FAKE_DOCKER_SCENARIO" in
          stopped|running|running-clean-stop|running-dirty-stop|running-no-mount|running-empty-vol|running-broken-archive|alpine-missing|running-tag-drift|running-archive-drifts-empty)
            printf 'kaoiro-c1\\n' ;;
        esac
        ;;
      build|up|stop) exit 0 ;;
    esac
    ;;
  tag) exit 0 ;;
  pull) exit 0 ;;
  inspect)
    case "$2" in
      # Preflight image check (N-5): the missing-alpine scenario is the
      # ONLY one where this fails, forcing ensureAlpineImage's pull.
      alpine:3)
        case "$FAKE_DOCKER_SCENARIO" in
          alpine-missing) exit 1 ;;
          *) printf 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n' ;;
        esac
        ;;
      # Rollback-tag verify-by-inspect (MF-2): echoes back the SAME id
      # \`{{.Image}}\` reports below, so every scenario that reaches the
      # tag step passes its own read-back check — except
      # running-tag-drift, which deliberately answers with a DIFFERENT
      # id, simulating \`docker tag\` having silently pointed the tag
      # somewhere other than what was asked (or \`latest\` having moved
      # under it between the tag and the verify).
      kaoiro-server:rollback-*)
        case "$FAKE_DOCKER_SCENARIO" in
          running-tag-drift) printf 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n' ;;
          *) printf '${OLD_IMAGE_ID}\\n' ;;
        esac
        ;;
      *)
        case "$4" in
          '{{.State.Status}}')
            case "$FAKE_DOCKER_SCENARIO" in
              stopped) printf 'exited\\n' ;;
              running|running-clean-stop|running-dirty-stop|running-no-mount|running-empty-vol|running-broken-archive|alpine-missing|running-tag-drift|running-archive-drifts-empty)
                printf 'running\\n' ;;
            esac
            ;;
          '{{.State.ExitCode}}')
            case "$FAKE_DOCKER_SCENARIO" in
              running-clean-stop|running-no-mount|running-empty-vol|running-broken-archive|alpine-missing|running-archive-drifts-empty) printf '0\\n' ;;
              running-dirty-stop) printf '137\\n' ;;
              *) printf 'unknown\\n' ;;
            esac
            ;;
          '{{.State.OOMKilled}}')
            case "$FAKE_DOCKER_SCENARIO" in
              running-clean-stop|running-no-mount|running-empty-vol|running-broken-archive|alpine-missing|running-archive-drifts-empty) printf 'false\\n' ;;
              running-dirty-stop) printf 'true\\n' ;;
              *) printf 'unknown\\n' ;;
            esac
            ;;
          '{{range .Mounts}}{{if eq .Destination "/var/lib/kaoiro"}}{{.Name}}{{end}}{{end}}')
            case "$FAKE_DOCKER_SCENARIO" in
              running-clean-stop|running-dirty-stop|running-empty-vol|running-broken-archive|alpine-missing|running-archive-drifts-empty) printf 'kaoiro_kaoiro-state\\n' ;;
              running-no-mount) ;;
            esac
            ;;
          '{{.Image}}') printf '${OLD_IMAGE_ID}\\n' ;;
          *) printf 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\\n' ;;
        esac
        ;;
    esac
    ;;
  run)
    case "$*" in
      *"tar czf"*)
        # Real archive step: write an actual tar.gz (with the same
        # owner/mode metadata a real \`stat\` would report, via GNU tar's
        # --owner/--group/--mode overrides — no root needed) at the host
        # path the -v ...:/backup mapping names, so the CLI's own
        # host-side \`tar tvzf\` verification has something real to
        # parse — a fake stdout string would not survive that.
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
            # SF-5's post-archive empty check pin: the PRE-archive guard
            # (below) reports non-empty, but the archive that actually
            # gets written is empty — the one disagreement a stale/wrong
            # pre-scan (not merely a hypothetical) would produce.
            running-archive-drifts-empty)
              mkdir -p "$hostdir/.fakesrc-empty"
              tar --owner=0 --group=0 -czf "$hostdir/archive.tar.gz" -C "$hostdir/.fakesrc-empty" .
              ;;
            *)
              mkdir -p "$hostdir/.fakesrc"
              printf 'x' > "$hostdir/.fakesrc/users.dets"
              tar --owner=1000 --group=1000 --mode=600 -czf "$hostdir/archive.tar.gz" -C "$hostdir/.fakesrc" .
              ;;
          esac
        fi
        exit 0
        ;;
      *)
        # Pre-archive empty-volume guard (find -mindepth 1 -maxdepth 1
        # -exec stat -c '%n %u:%g %04a' {} \\;) — only whether anything is
        # there, not what gets recorded (that comes from tar tvzf now).
        case "$FAKE_DOCKER_SCENARIO" in
          running-clean-stop|running-dirty-stop|running-broken-archive|alpine-missing|running-archive-drifts-empty) printf '/data/users.dets 1000:1000 0600\\n' ;;
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

// Captures every argv the fake docker was invoked with, one line each,
// for tests that need to assert on WHICH calls did (or did not) happen —
// MF-1's "records zero mutating calls" and N-5's "pulls alpine:3". `fn`
// may throw (a caller inspecting only the call log, not the outcome,
// e.g. N-5's pull check where runUpdate legitimately fails LATER for an
// unrelated reason); the exception is swallowed here on purpose.
function withCallLog(scenario, fn) {
  const logPath = join(root, "docker-calls.log");
  const prior = process.env.KAOIRO_TEST_CALL_LOG;
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  try {
    withScenario(scenario, fn);
  } catch {
    // Intentionally ignored — see doc comment.
  } finally {
    if (prior === undefined) delete process.env.KAOIRO_TEST_CALL_LOG;
    else process.env.KAOIRO_TEST_CALL_LOG = prior;
  }
  return existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
}

// クロエ round 1 review MF-4 pin (a): runs the REAL script text (imported,
// not hand-copied — see VOLUME_LISTING_SCRIPT's own doc comment) through
// a real `sh -c`, no docker involved, against a real empty directory and
// a real 1-file directory. `/data` is substituted for the test's own tmp
// dir — the same "faithful against a real path" approach クロエ's own
// repro-b.mjs used, since a bind mount to literally `/data` needs a
// container this test does not have.
test("the volume-listing script exits 0 with empty output on an empty dir, and one line on a populated one", () => {
  const dir = mkdtempSync(join(tmpdir(), "kaoiro-306-volume-listing-"));
  try {
    const script = VOLUME_LISTING_SCRIPT.replace("/data", dir);
    const empty = execFileSync("sh", ["-c", script], { encoding: "utf8" });
    assert.equal(empty, "");

    writeFileSync(join(dir, "users.dets"), "x");
    const populated = execFileSync("sh", ["-c", script], { encoding: "utf8" });
    const lines = populated.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith(`${dir}/users.dets `));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

// クロエ round 1 review SF-6: defense in depth alongside the config
// VALIDATORS check — a config object built programmatically (as this
// test does, and as any caller not going through loadConfig would) never
// passes through that validator at all.
test("runStart refuses a relative backup_root even when the config was not loaded from a file", () => {
  const config = { ...configWithOverride(), backup_root: "relative/backup/dir" };
  assert.throws(() => withOverrideEnv(() => runStart({ repo: workDir, initialize: true }, config)), DeployError);
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

// クロエ round 1 review MF-1: `update` silently ignored --dry-run and
// performed the real stop/build/archive/transaction-dir-creation
// sequence — reproduced live (repro.mjs) before this fix existed.
test("runUpdate --dry-run performs no mutating docker call and creates no transaction dir", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  const log = withCallLog("running", () =>
    runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true, dryRun: true }, configWithOverride()),
  );
  const lines = log.trim().split("\n");
  assert.ok(
    lines.some((line) => line.startsWith("compose ps")),
    "a read-only compose ps call should still happen",
  );
  for (const mutating of ["compose build", "compose stop", "compose up", "tag", "pull"]) {
    assert.ok(
      !lines.some((line) => line.startsWith(mutating)),
      `dry-run must not call: ${mutating}`,
    );
  }
  assert.ok(!log.includes("tar czf"), "dry-run must not archive");
  assert.equal(existsSync(backupRoot), false, "dry-run must not create backup_root or any transaction dir");
});

test("runUpdate --dry-run reports the plan", () => {
  const result = withScenario("running", () =>
    runUpdate({ repo: workDir, target: headSha, dryRun: true }, configWithOverride()),
  );
  assert.equal(result.dryRun, true);
  assert.equal(result.container, "kaoiro-c1");
  assert.equal(result.unfinishedTransactionId, null);
  assert.ok(result.wouldRun.some((line) => line.includes("compose stop")));
});

test("runUpdate --dry-run refuses --transaction", () => {
  assert.throws(
    () =>
      withScenario("running", () =>
        runUpdate({ repo: workDir, target: headSha, dryRun: true, transaction: "20260906T000000Z" }, configWithOverride()),
      ),
    DeployError,
  );
});

// クロエ round 1 review N-5: alpine is pulled, pinned to alpine:3, during
// preflight — before the stop window, not implicitly by the archive
// step's first `docker run` after the server is already down.
test("runUpdate pulls alpine:3 during preflight when it is not already present", () => {
  const log = withCallLog("alpine-missing", () =>
    runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithOverride()),
  );
  const stopIndex = log.indexOf("compose stop");
  const pullIndex = log.indexOf("pull alpine:3");
  assert.ok(pullIndex !== -1, "expected a pull of alpine:3");
  assert.ok(stopIndex !== -1, "expected the run to reach compose stop");
  assert.ok(pullIndex < stopIndex, "the pull must happen BEFORE compose stop, not after");
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
  assert.equal(result.oldImageId, OLD_IMAGE_ID);
  assert.equal(result.rollbackTag, `kaoiro-server:rollback-${result.oldSha}`);
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
  const oldImageEntry = journal.history.find((e) => e.phase === "old_image_saved");
  assert.equal(oldImageEntry.observation.rollback_tag, result.rollbackTag);
  const manifest = readManifest(join(backupRoot, result.transactionId));
  assert.equal(manifest.volume_id, "kaoiro_kaoiro-state");
  assert.equal(manifest.image_id, result.build.imageId);
  assert.equal(manifest.source_sha, headSha);
  assert.deepEqual(manifest.required_entries, result.requiredEntries);
});

test("runUpdate refuses to proceed past a dirty stop even with a measured expectation", () => {
  // クロエ round 1 review SF-3: the clean-stop test above only ever
  // exercises "expected present, observation absent (unknown)" via the
  // OTHER unmeasured-expectation test below — this is the missing case,
  // "expected present, observation present and DIFFERENT" (a real crash:
  // exit 137, OOM-killed).
  assert.throws(
    () =>
      withScenario("running-dirty-stop", () =>
        runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
      ),
    DeployError,
  );
});

// クロエ round 1 review MF-2: the rollback tag is verified by reading it
// BACK via `docker inspect`, not merely trusted because `docker tag`
// exited 0 — a tag pointing somewhere other than the old image (a
// `latest` race, an unexpected docker behavior) must stop the run before
// `compose build` ever runs, not silently record an unusable rollback
// target.
test("runUpdate refuses when the rollback tag verification disagrees with the old image id", () => {
  assert.throws(
    () =>
      withScenario("running-tag-drift", () => runUpdate({ repo: workDir, target: headSha }, configWithOverride())),
    DeployError,
  );
  const backupRoot = join(root, "kaoiro-deploy");
  const [transactionDir] = readdirSyncNonHidden(backupRoot);
  const journal = readJournal(join(backupRoot, transactionDir));
  // Stopped BEFORE the checkpoint that would have recorded the
  // (unverifiable) rollback tag.
  assert.equal(journal.phase, "preflight");
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

// クロエ round 1 review SF-5's own note (MF-4): isValidRequiredEntries([])
// is true, so a check that the ARCHIVE itself is non-empty is the only
// thing that stops an empty archive being recorded as restorable — the
// pre-archive volume-listing guard is a different scan and could
// disagree (this scenario's archive ends up empty despite the pre-scan
// reporting one file).
test("runUpdate refuses when the archive itself ends up empty despite a non-empty pre-scan", () => {
  assert.throws(
    () =>
      withScenario("running-archive-drifts-empty", () =>
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
  let caught;
  try {
    withScenario("running", () => runUpdate({ repo: workDir, target: headSha }, configWithOverride()));
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  // クロエ round 1 review MF-3: the reached phase is ARCHIVED — the
  // commit half has already stopped the container, so `--transaction`'s
  // own requireRunningContainer re-check could never succeed. The
  // message must say so rather than send the operator into a guaranteed
  // second failure.
  assert.ok(!caught.message.includes("resume it with --transaction"));
  assert.ok(caught.message.includes("no resume support yet"));
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

test("runUpdate's unfinished-transaction guidance still offers --transaction before the maintenance gate", () => {
  // The COUNTERPART of the test above: a transaction that has NOT yet
  // stopped the container is genuinely resumable, and must keep saying
  // so — this is what MF-3's fix is phase-DEPENDENT, not a blanket
  // rewording.
  withScenario("running", () => {
    try {
      runUpdate({ repo: workDir, target: headSha }, configWithOverride());
    } catch (err) {
      assert.ok(err instanceof DeployError);
    }
  });
  let caught;
  try {
    withScenario("running", () => runUpdate({ repo: workDir, target: headSha }, configWithOverride()));
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("resume it with --transaction"));
  assert.ok(!caught.message.includes("no resume support yet"));
});

function readdirSyncNonHidden(dir) {
  return readdirSync(dir).filter((name) => !name.startsWith("."));
}
