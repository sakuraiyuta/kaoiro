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
  parseTarEntries,
  pruneOldTransactions,
  resolveHealthUrl,
  runBuild,
  requiredEntriesMatch,
  ROLLBACK_ELIGIBLE_PHASES,
  runRollback,
  runStart,
  runStatus,
  runUpdate,
  UNRESUMABLE_PHASES,
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
          stopped|running|retag-drift|running-clean-stop|running-clean-stop-restarts|running-clean-stop-restartcount-unreadable|running-clean-stop-torture|running-dirty-stop|running-no-mount|running-empty-vol|running-broken-archive|alpine-missing|running-tag-drift|running-archive-drifts-empty)
            printf 'kaoiro-c1\\n' ;;
          # round 4 review B-1 (expanded): rollback's own "2+ containers,
          # refuse" guard, distinct from requireRunningContainer's own
          # (unrelated) "!= 1" check.
          multiple-containers) printf 'kaoiro-c1\\nkaoiro-c2\\n' ;;
        esac
        ;;
      build|up|stop) exit 0 ;;
      # director ruling 2026-09-06 (#306 (c3) review): resolveHealthUrl's
      # own source of truth when config.health_url is not overridden.
      # Unhandled scenarios fall through with empty output (no explicit
      # case, sh's own default) — that IS the "no output" failure case
      # resolveHealthUrl's own test relies on, not a gap to fill in.
      port)
        case "$FAKE_DOCKER_SCENARIO" in
          health-url-derivable) printf '127.0.0.1:9999\\n' ;;
          health-url-port-fails) exit 1 ;;
          # クロエ round 3 review N-1: real \`docker compose port\` reports
          # an IPv6 wildcard binding unbracketed.
          health-url-ipv6) printf ':::4000\\n' ;;
        esac
        ;;
      # issue #220 absorption: compose's own RESOLVED declaration for the
      # service, keyed by env var name — measured live to be a plain
      # object map under \`--format json\` (Compose v5.3.1). Overridable
      # per-test via KAOIRO_TEST_COMPOSE_ENV_JSON; an empty environment
      # map by default so scenarios that do not care about env
      # consistency see zero disagreement (no canonical keys to compare
      # either, since the default eval output below is also \`[]\`).
      #
      # The volumes shape (round 4 review N-3) is also measured live
      # (Compose v5.3.1): services.<name>.volumes[] names the mount
      # (type/source/target), and the top-level volumes.<source>.name
      # gives the FULLY-RESOLVED docker volume name — "kaoiro_kaoiro-state"
      # here, matching this fixture's own service name.
      config)
        if [ -n "$KAOIRO_TEST_COMPOSE_ENV_JSON" ]; then
          env_json="$KAOIRO_TEST_COMPOSE_ENV_JSON"
        else
          env_json='{}'
        fi
        printf '{"services":{"kaoiro":{"environment":%s,"volumes":[{"type":"volume","source":"kaoiro-state","target":"/var/lib/kaoiro","volume":{}}]}},"volumes":{"kaoiro-state":{"name":"kaoiro_kaoiro-state"}}}\\n' "$env_json"
        ;;
    esac
    ;;
  # クロエ round 4 review N-3: hasPriorTransactions' own docker-
  # reachability probe (\`docker version --format {{.Server.Version}}\`,
  # measured live to fail when the daemon is unreachable). Always
  # succeeds except for the one scenario that specifically wants to
  # exercise classify()'s own unknown-hasState branch END TO END (\`compose
  # ps\` still answers normally — this simulates JUST the volume-existence
  # check being unreachable, not total docker failure, which a SEPARATE
  # dedicated broken-docker fixture already covers for requireRunningContainer
  # itself).
  version)
    case "$FAKE_DOCKER_SCENARIO" in
      docker-unreachable-for-state-check) exit 1 ;;
      *) exit 0 ;;
    esac
    ;;
  # クロエ round 4 review N-3: existence-only, matching \`docker volume
  # inspect\` (measured live: exit 0 for an existing volume, 1 for a
  # missing one). Defaults to "does not exist" — most branch-C/FRESH
  # fixtures in this file assume a genuinely empty deployment; the one
  # scenario that needs the OPPOSITE (a volume surviving after its
  # container disappeared) opts in explicitly.
  volume)
    case "$2" in
      inspect)
        case "$FAKE_DOCKER_SCENARIO" in
          volume-exists-no-container) exit 0 ;;
          *) exit 1 ;;
        esac
        ;;
    esac
    ;;
  tag) exit 0 ;;
  pull) exit 0 ;;
  rmi) exit 0 ;;
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
      # issue #220 absorption: the abort-cleanup retag-back read-back
      # (env_consistency mismatch) — echoes OLD_IMAGE_ID, matching the
      # \`tag\` command's own always-succeeds fake so the read-back check
      # passes. round 4 review B-1 (expanded): rollback's OWN retag
      # read-back needs the SAME pin on a genuine drift (\`docker tag\`
      # having silently pointed \`latest\` somewhere other than what was
      # asked, or \`latest\` moving under it between the tag and the
      # verify) — the same class MF-2/rollback-tag-drift already covers
      # for update's own rollback tag.
      kaoiro-server:latest)
        case "$FAKE_DOCKER_SCENARIO" in
          retag-drift) printf 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\\n' ;;
          *) printf '${OLD_IMAGE_ID}\\n' ;;
        esac
        ;;
      *)
        case "$4" in
          '{{.State.Status}}')
            case "$FAKE_DOCKER_SCENARIO" in
              stopped) printf 'exited\\n' ;;
              running|retag-drift|running-clean-stop|running-clean-stop-restarts|running-clean-stop-restartcount-unreadable|running-clean-stop-torture|running-dirty-stop|running-no-mount|running-empty-vol|running-broken-archive|alpine-missing|running-tag-drift|running-archive-drifts-empty)
                printf 'running\\n' ;;
            esac
            ;;
          '{{.State.ExitCode}}')
            case "$FAKE_DOCKER_SCENARIO" in
              running-clean-stop|running-clean-stop-restarts|running-clean-stop-restartcount-unreadable|running-clean-stop-torture|running-no-mount|running-empty-vol|running-broken-archive|alpine-missing|running-archive-drifts-empty) printf '0\\n' ;;
              running-dirty-stop) printf '137\\n' ;;
              *) printf 'unknown\\n' ;;
            esac
            ;;
          '{{.State.OOMKilled}}')
            case "$FAKE_DOCKER_SCENARIO" in
              running-clean-stop|running-clean-stop-restarts|running-clean-stop-restartcount-unreadable|running-clean-stop-torture|running-no-mount|running-empty-vol|running-broken-archive|alpine-missing|running-archive-drifts-empty) printf 'false\\n' ;;
              running-dirty-stop) printf 'true\\n' ;;
              *) printf 'unknown\\n' ;;
            esac
            ;;
          '{{range .Mounts}}{{if eq .Destination "/var/lib/kaoiro"}}{{.Name}}{{end}}{{end}}')
            case "$FAKE_DOCKER_SCENARIO" in
              running-clean-stop|running-clean-stop-restarts|running-clean-stop-restartcount-unreadable|running-clean-stop-torture|running-dirty-stop|running-empty-vol|running-broken-archive|alpine-missing|running-archive-drifts-empty) printf 'kaoiro_kaoiro-state\\n' ;;
              running-no-mount) ;;
            esac
            ;;
          '{{.RestartCount}}')
            case "$FAKE_DOCKER_SCENARIO" in
              # Increments on every read: 0 the first time (right after
              # HEALTHY), 1 the second (after the stability window) —
              # pins the "restarted during the stability window" failure.
              running-clean-stop-restarts)
                count=0
                [ -f "$KAOIRO_TEST_RESTART_COUNTER" ] && count=$(cat "$KAOIRO_TEST_RESTART_COUNTER")
                echo $((count + 1)) > "$KAOIRO_TEST_RESTART_COUNTER"
                printf '%s\\n' "$count"
                ;;
              # クロエ round 3 review MF-3 pin: real \`docker inspect\`
              # prints the literal string "<no value>" for a template
              # field it cannot resolve — parseDockerIntField reads this
              # as null (unreadable), never 0.
              running-clean-stop-restartcount-unreadable) printf '<no value>\\n' ;;
              *) printf '0\\n' ;;
            esac
            ;;
          '{{.Image}}') printf '${OLD_IMAGE_ID}\\n' ;;
          # issue #220 absorption: the OLD (currently running) container's
          # actual effective env, Docker's own \`"KEY=VALUE"\` array shape.
          # Overridable via KAOIRO_TEST_CONTAINER_ENV_JSON; empty by
          # default (see the \`compose config\` fake's own comment).
          '{{json .Config.Env}}')
            if [ -n "$KAOIRO_TEST_CONTAINER_ENV_JSON" ]; then
              printf '%s\\n' "$KAOIRO_TEST_CONTAINER_ENV_JSON"
            else
              printf '[]\\n'
            fi
            ;;
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
        #
        # outfile is read from the actual \`/backup/<name>\` argument
        # (issue #306 (d)-B: rollback's own forensic/restore-verify
        # archives use different names than update's \`archive.tar.gz\`
        # within the SAME transaction dir, so a hardcoded name here would
        # make one call silently overwrite another's output).
        prev=""
        hostdir=""
        outfile="archive.tar.gz"
        for arg in "$@"; do
          case "$prev" in
            -v)
              case "$arg" in
                *:/backup) hostdir=\${arg%:/backup} ;;
              esac
              ;;
          esac
          case "$arg" in
            /backup/*) outfile=\${arg#/backup/} ;;
          esac
          prev=$arg
        done
        if [ -n "$hostdir" ]; then
          case "$FAKE_DOCKER_SCENARIO" in
            running-broken-archive) printf 'not a real gzip stream' > "$hostdir/$outfile" ;;
            # round 4 review B-1 (expanded): rollback's OWN forensic-
            # archive verification guard, pinned by making JUST that
            # archive corrupt — the pre-deploy archive.tar.gz created
            # during an EARLIER runUpdate call (a different scenario,
            # a different outfile name) is unaffected.
            rollback-forensic-corrupt)
              if [ "$outfile" = "rollback-forensic.tar.gz" ]; then
                printf 'not a real gzip stream' > "$hostdir/$outfile"
              else
                mkdir -p "$hostdir/.fakesrc"
                printf 'x' > "$hostdir/.fakesrc/users.dets"
                tar --owner=1000 --group=1000 --mode=600 -czf "$hostdir/$outfile" -C "$hostdir/.fakesrc" .
              fi
              ;;
            # round 4 review B-1 (expanded): rollback's OWN restored-
            # volume-vs-required_entries guard, exercised end to end (not
            # just requiredEntriesMatch's own unit tests) by making the
            # restore-verify re-tar contain a DIFFERENT file than the
            # pre-deploy archive's own (unaffected) content.
            rollback-restore-drifts)
              if [ "$outfile" = "rollback-restore-verify.tar.gz" ]; then
                mkdir -p "$hostdir/.fakesrc-drift"
                printf 'x' > "$hostdir/.fakesrc-drift/unexpected.dets"
                tar --owner=1000 --group=1000 --mode=600 -czf "$hostdir/$outfile" -C "$hostdir/.fakesrc-drift" .
              else
                mkdir -p "$hostdir/.fakesrc"
                printf 'x' > "$hostdir/.fakesrc/users.dets"
                tar --owner=1000 --group=1000 --mode=600 -czf "$hostdir/$outfile" -C "$hostdir/.fakesrc" .
              fi
              ;;
            # SF-5's post-archive empty check pin: the PRE-archive guard
            # (below) reports non-empty, but the archive that actually
            # gets written is empty — the one disagreement a stale/wrong
            # pre-scan (not merely a hypothetical) would produce.
            running-archive-drifts-empty)
              mkdir -p "$hostdir/.fakesrc-empty"
              tar --owner=0 --group=0 -czf "$hostdir/$outfile" -C "$hostdir/.fakesrc-empty" .
              ;;
            # クロエ round 2 review SF-8 pin: a real archive containing a
            # symlink and a hardlink alongside a plain file, so
            # parseTarEntries sees actual "-> target" / "link to target"
            # suffixed lines, not a hand-written fixture standing in for
            # tar's own output shape.
            running-clean-stop-torture)
              mkdir -p "$hostdir/.fakesrc-torture"
              printf x > "$hostdir/.fakesrc-torture/real.txt"
              # Mode pinned explicitly (not left to the shell's umask):
              # \`printf > file\` mode depends on the process umask, which
              # differs between a dev host (often 0002 -> 0664) and CI's
              # node:22 container (0022 -> 0644) — PR #312 round-3 run,
              # 2026-09-06. The hardlink below shares this inode, so both
              # real.txt and hard.txt land on the 0664 the test asserts.
              chmod 664 "$hostdir/.fakesrc-torture/real.txt"
              ln -s real.txt "$hostdir/.fakesrc-torture/sym.txt"
              ln "$hostdir/.fakesrc-torture/real.txt" "$hostdir/.fakesrc-torture/hard.txt"
              tar --owner=1000 --group=1000 -czf "$hostdir/$outfile" -C "$hostdir/.fakesrc-torture" .
              ;;
            *)
              mkdir -p "$hostdir/.fakesrc"
              printf 'x' > "$hostdir/.fakesrc/users.dets"
              tar --owner=1000 --group=1000 --mode=600 -czf "$hostdir/$outfile" -C "$hostdir/.fakesrc" .
              ;;
          esac
        fi
        exit 0
        ;;
      # issue #220 absorption: the target image's own persistence-path
      # eval — matched on the entrypoint string alone (unique to this
      # call in the whole fixture), regardless of image id or the exact
      # eval expression content. KAOIRO_TEST_EVAL_EXIT=1 simulates the
      # querying module not having landed on this image (a pre-#310
      # image, or an old image rollback targets) — the fake's own
      # "eval process itself failed" outcome, distinct from a malformed
      # 0-exit output (KAOIRO_TEST_EVAL_OUTPUT set to something that is
      # not a valid JSON array). Defaults to \`[]\` (nothing to check),
      # so scenarios that do not care about env consistency never trip it.
      *"/app/bin/kaoiro_server"*)
        if [ "$KAOIRO_TEST_EVAL_EXIT" = "1" ]; then
          exit 1
        fi
        if [ -n "$KAOIRO_TEST_EVAL_OUTPUT" ]; then
          printf '%s\\n' "$KAOIRO_TEST_EVAL_OUTPUT"
        else
          printf '[]\\n'
        fi
        ;;
      *)
        # Pre-archive empty-volume guard (find -mindepth 1 -maxdepth 1
        # -exec stat -c '%n %u:%g %04a' {} \\;) — only whether anything is
        # there, not what gets recorded (that comes from tar tvzf now).
        case "$FAKE_DOCKER_SCENARIO" in
          running-clean-stop|running-clean-stop-restarts|running-clean-stop-restartcount-unreadable|running-clean-stop-torture|running-dirty-stop|running-broken-archive|alpine-missing|running-archive-drifts-empty) printf '/data/users.dets 1000:1000 0600\\n' ;;
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
  // Matches the real repo's own root .gitignore (`.env` is listed there).
  // Without this, a test writing server/.env (issue #220 absorption)
  // relies on the HOST's global git excludesFile to stay clean — true on
  // a dev host that already has one, false on a bare CI container, where
  // `git status --porcelain` then reports it and runBuild's dirty-tree
  // guard fires for the wrong reason (measured: PR #312 round-3 style
  // node:22 repro, 2026-09-06).
  writeFileSync(join(dir, ".gitignore"), ".env\n");
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

// Simulates `curl -sS --fail --max-time N <url>` for pollHealth: ignores
// its own args entirely and replies with the env-var-controlled
// build_revision/build_dirty, so each test decides what "the running
// server" reports without a real HTTP server. KAOIRO_TEST_HEALTH_REVISION
// unset (the "no server up yet" case) reports a value that can never
// match a real 40-hex target. KAOIRO_TEST_HEALTH_DIRTY defaults to
// "false" (director ruling 2026-09-06: healthy requires build_dirty ===
// false too, not just a matching revision).
const FAKE_CURL = `#!/bin/sh
printf '{"build_revision":"%s","build_dirty":%s}' \\
  "\${KAOIRO_TEST_HEALTH_REVISION:-no-server-yet}" "\${KAOIRO_TEST_HEALTH_DIRTY:-false}"
`;

let curlBin;

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

  curlBin = join(root, "fake-curl.sh");
  writeFileSync(curlBin, FAKE_CURL);
  chmodSync(curlBin, 0o700);
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
// path need a config claiming a measurement exists. Also carries FAST
// health-poll/stability settings (real defaults would make every test
// that reaches UP take up to health_poll_timeout_ms + stability_window_ms
// — up to 90 real seconds) and a health_url that is never actually
// dialed (KAOIRO_DEPLOY_CURL_BIN redirects curl itself).
function configWithCleanStopMeasured() {
  return {
    ...configWithOverride(),
    expected_clean_stop_exit_code: 0,
    expected_clean_stop_oom_killed: false,
    health_url: "http://fake-server.invalid/api/health",
    health_poll_interval_ms: 1,
    health_poll_timeout_ms: 200,
    stability_window_ms: 1,
  };
}

function withOverrideEnv(fn) {
  const priorDocker = process.env.KAOIRO_DEPLOY_DOCKER_BIN;
  const priorCurl = process.env.KAOIRO_DEPLOY_CURL_BIN;
  const priorHealthRevision = process.env.KAOIRO_TEST_HEALTH_REVISION;
  process.env.KAOIRO_DEPLOY_DOCKER_BIN = bin;
  process.env.KAOIRO_DEPLOY_CURL_BIN = curlBin;
  // Default: "the server is already running the target" — the common
  // case every test not specifically exercising a health mismatch wants.
  // Set before the call, never mutated by this helper afterward, so a
  // caller can override it (e.g. to a value that never matches) beforehand.
  if (process.env.KAOIRO_TEST_HEALTH_REVISION === undefined) {
    process.env.KAOIRO_TEST_HEALTH_REVISION = headSha;
  }
  try {
    return fn();
  } finally {
    if (priorDocker === undefined) delete process.env.KAOIRO_DEPLOY_DOCKER_BIN;
    else process.env.KAOIRO_DEPLOY_DOCKER_BIN = priorDocker;
    if (priorCurl === undefined) delete process.env.KAOIRO_DEPLOY_CURL_BIN;
    else process.env.KAOIRO_DEPLOY_CURL_BIN = priorCurl;
    if (priorHealthRevision === undefined) delete process.env.KAOIRO_TEST_HEALTH_REVISION;
    else process.env.KAOIRO_TEST_HEALTH_REVISION = priorHealthRevision;
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

// issue #220 absorption: sets/restores the four env vars FAKE_DOCKER's
// own eval/compose-config/inspect-Config.Env cases read, so a test can
// control the target image's canonical set, compose's declaration, and
// the running container's effective env independently. Undefined values
// are deleted rather than set, so a test only overriding one of the four
// leaves the others at FAKE_DOCKER's own defaults (empty/`[]`).
function withEnvConsistencyFixture({ evalExit, evalOutput, composeEnvJson, containerEnvJson } = {}, fn) {
  const vars = {
    KAOIRO_TEST_EVAL_EXIT: evalExit,
    KAOIRO_TEST_EVAL_OUTPUT: evalOutput,
    KAOIRO_TEST_COMPOSE_ENV_JSON: composeEnvJson,
    KAOIRO_TEST_CONTAINER_ENV_JSON: containerEnvJson,
  };
  const prior = {};
  for (const [key, value] of Object.entries(vars)) {
    prior[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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

test("hasPriorTransactions is true once a transaction directory exists, without ever touching docker", () => {
  // Short-circuits on the backup_root check alone — bin is never used,
  // matching the doc comment's own ordering (prior transactions first).
  const backupRoot = join(root, "kaoiro-deploy");
  mkdirSync(join(backupRoot, "20260906T000000Z"), { recursive: true });
  assert.equal(hasPriorTransactions("/does-not-exist-bin", join(workDir, "server"), backupRoot), true);
});

test("hasPriorTransactions is false when the backup root is empty and the named volume does not exist", () => {
  const backupRoot = join(root, "does-not-exist");
  const result = withOverrideEnv(() => hasPriorTransactions(bin, join(workDir, "server"), backupRoot));
  assert.equal(result, false);
});

// クロエ round 4 review N-3: the exact danger this ruling exists to
// close — `start --initialize` once, no `update` since (empty
// backup_root), and the container has since disappeared. The volume
// itself still holds live state and must NOT read as "no prior state".
test("hasPriorTransactions is true when the backup root is empty but the named volume still exists", () => {
  const backupRoot = join(root, "does-not-exist");
  const result = withScenario("volume-exists-no-container", () =>
    hasPriorTransactions(bin, join(workDir, "server"), backupRoot),
  );
  assert.equal(result, true);
});

// クロエ round 4 review N-3: docker unreachable must resolve to `null`
// (unknown), never `false` — a `false` here is exactly what would let
// `start --initialize` re-run over state this function simply could not
// check.
test("hasPriorTransactions is null (unknown) when docker itself is unreachable, never false", () => {
  const backupRoot = join(root, "does-not-exist");
  const brokenBin = join(root, "broken-docker.sh");
  writeFileSync(brokenBin, "#!/bin/sh\necho 'Cannot connect to the Docker daemon.' >&2\nexit 1\n");
  chmodSync(brokenBin, 0o700);
  const result = hasPriorTransactions(brokenBin, join(workDir, "server"), backupRoot);
  assert.equal(result, null);
});

// クロエ round 4 review SF-5: hasPriorTransactions alone had not
// excluded dotfiles the way every other reader of backup_root already
// does — a leftover `.lock.update` from a crashed run must not read as
// "prior transaction state exists".
test("hasPriorTransactions ignores a leftover .lock.update, unlike a real transaction directory", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  mkdirSync(join(backupRoot, ".lock.update"), { recursive: true });
  const result = withOverrideEnv(() => hasPriorTransactions(bin, join(workDir, "server"), backupRoot));
  assert.equal(result, false);
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
  // workDir is a `git clone` of bareDir — clone never copies the SOURCE
  // repo's local user.email/user.name (identity is deliberately excluded
  // from clone), so this commit has no identity to fall back to unless
  // the host happens to have a global one set. CI's node:22 container has
  // none (PR #312 round-3 run, 2026-09-06) — pin identity explicitly here
  // instead of relying on global config.
  execFileSync("git", [
    "-C", workDir,
    "-c", "user.email=test@example.com",
    "-c", "user.name=Test",
    "commit", "-q", "-m", "second",
  ]);
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
  // issue #220 absorption: env_consistency is now checked BEFORE the
  // approval gate too (still no-downtime) — "prepare progress" now
  // extends one phase further than build alone.
  assert.equal(journal.phase, "env_consistency_checked");
});

// --- issue #220 absorption -----------------------------------------------

test("runUpdate records env_consistency as skipped when the target image's own eval process fails", () => {
  const result = withScenario("running-clean-stop", () =>
    withEnvConsistencyFixture({ evalExit: "1" }, () =>
      runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
    ),
  );
  assert.equal(result.phase, "done");
  const backupRoot = join(root, "kaoiro-deploy");
  const manifest = readManifest(join(backupRoot, result.transactionId));
  assert.equal(manifest.env_consistency.skipped, true);
  assert.ok(manifest.env_consistency.reason.includes("persistence-path eval failed"));
});

test("runUpdate throws when the target image's eval exits 0 but does not print valid JSON", () => {
  assert.throws(
    () =>
      withScenario("running-clean-stop", () =>
        withEnvConsistencyFixture({ evalOutput: "not json" }, () =>
          runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
        ),
      ),
    DeployError,
  );
});

test("runUpdate throws when the target image's eval prints valid JSON that is not the expected shape", () => {
  assert.throws(
    () =>
      withScenario("running-clean-stop", () =>
        withEnvConsistencyFixture({ evalOutput: '{"not":"an array"}' }, () =>
          runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
        ),
      ),
    DeployError,
  );
});

// クロエ round 4 review A-SF-1: `entry.env` is embedded into a RegExp
// (readEnvFileValue) unescaped — a malformed eval response must be
// treated as a shape violation (DeployError, not skipped), not run
// through to the RegExp construction at all.
test("runUpdate throws (not skipped) when eval reports an env name that is not a valid identifier", () => {
  writeFileSync(join(workDir, "server", ".env"), "SECRET_KEY_BASE=super-secret-value-must-never-leak\n");
  const evalOutput = JSON.stringify([{ store: "Users", env: ".*", default_file: "users.dets" }]);
  let caught;
  try {
    withScenario("running-clean-stop", () =>
      withEnvConsistencyFixture({ evalOutput }, () =>
        runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
      ),
    );
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(!caught.message.includes("super-secret-value-must-never-leak"));
});

test("runUpdate throws (not a SyntaxError) when eval reports an env name that is not a valid RegExp fragment", () => {
  // A real .env file must exist — otherwise readEnvFileValue's own
  // ENOENT short-circuit returns null before ever reaching `new
  // RegExp(...)`, masking whether the guard (not that short-circuit) is
  // what actually prevents the SyntaxError.
  writeFileSync(join(workDir, "server", ".env"), "KAOIRO_USERS_PATH=/var/lib/kaoiro/users.dets\n");
  const evalOutput = JSON.stringify([{ store: "Users", env: "(", default_file: "users.dets" }]);
  assert.throws(
    () =>
      withScenario("running-clean-stop", () =>
        withEnvConsistencyFixture({ evalOutput }, () =>
          runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
        ),
      ),
    DeployError,
  );
});

test("runUpdate fails closed and restores kaoiro-server:latest to the old image when env_consistency finds a mismatch", () => {
  writeFileSync(join(workDir, "server", ".env"), "KAOIRO_USERS_PATH=/var/lib/kaoiro/users.dets\n");
  const evalOutput = JSON.stringify([{ store: "Users", env: "KAOIRO_USERS_PATH", default_file: "users.dets" }]);
  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let caught;
  try {
    withScenario("running-clean-stop", () =>
      withEnvConsistencyFixture(
        {
          evalOutput,
          composeEnvJson: '{"KAOIRO_USERS_PATH":"/var/lib/kaoiro/users.dets"}',
          // Deliberately DIFFERENT from .env/compose — the running
          // (old) container predates this compose value.
          containerEnvJson: '["KAOIRO_USERS_PATH=/tmp/kaoiro-dets/users.dets"]',
        },
        () => runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
      ),
    );
  } catch (err) {
    caught = err;
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("env_consistency check found a mismatch"));
  const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  assert.ok(
    log.trim().split("\n").includes(`tag ${OLD_IMAGE_ID} kaoiro-server:latest`),
    "expected kaoiro-server:latest to be retagged back to the old image on failure",
  );
});

// クロエ round 4 review B-1 (expanded further, WORKLOG 2026-09-07 00:14:
// B-1 spans 3 retag read-back call sites, not 2 — runUpdate's own
// abort-cleanup retag (env_consistency mismatch), separate from
// runRollback's destructive/non-destructive ones already pinned above).
// Uses "retag-drift" as the WHOLE scenario (added to the ps/State.Status
// lists alongside "running") since the mismatch is reached well before
// the stop window — no clean-stop scenario is needed here at all.
test("runUpdate reports both failures when env_consistency mismatches AND the abort-cleanup retag read-back also disagrees", () => {
  const evalOutput = JSON.stringify([{ store: "Users", env: "KAOIRO_USERS_PATH", default_file: "users.dets" }]);
  let caught;
  try {
    withScenario("retag-drift", () =>
      withEnvConsistencyFixture(
        {
          evalOutput,
          composeEnvJson: '{"KAOIRO_USERS_PATH":"/var/lib/kaoiro/users.dets"}',
          containerEnvJson: '["KAOIRO_USERS_PATH=/tmp/kaoiro-dets/users.dets"]',
        },
        () => runUpdate({ repo: workDir, target: headSha }, configWithOverride()),
      ),
    );
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("env_consistency check failed AND could not restore kaoiro-server:latest"));
});

test("runUpdate proceeds through DONE when compose and container agree", () => {
  writeFileSync(join(workDir, "server", ".env"), "KAOIRO_USERS_PATH=/var/lib/kaoiro/users.dets\n");
  const evalOutput = JSON.stringify([{ store: "Users", env: "KAOIRO_USERS_PATH", default_file: "users.dets" }]);
  const result = withScenario("running-clean-stop", () =>
    withEnvConsistencyFixture(
      {
        evalOutput,
        composeEnvJson: '{"KAOIRO_USERS_PATH":"/var/lib/kaoiro/users.dets"}',
        containerEnvJson: '["KAOIRO_USERS_PATH=/var/lib/kaoiro/users.dets"]',
      },
      () => runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
    ),
  );
  assert.equal(result.phase, "done");
  const backupRoot = join(root, "kaoiro-deploy");
  const manifest = readManifest(join(backupRoot, result.transactionId));
  assert.equal(manifest.env_consistency.skipped, false);
  const entry = manifest.env_consistency.entries.KAOIRO_USERS_PATH;
  assert.equal(entry.match, true);
  assert.equal(entry.declared, "/var/lib/kaoiro/users.dets");
});

// director ruling 2026-09-06, A-MF-1: the exact bug the 3-way design had
// — the bundled docker-compose.yaml sets every canonical persistence-
// path var as a LITERAL `environment:` entry (never `.env` interpolation),
// so `.env` legitimately has NO line for it on every correctly-configured
// production host. A 3-way check would have read this as a permanent
// mismatch from the moment #310 lands; the 2-way check (compose vs.
// container only) must pass here regardless.
test("runUpdate proceeds through DONE when compose and container agree, even with no .env line at all", () => {
  // No .env file written at all — readEnvFileValue's own ENOENT path.
  const evalOutput = JSON.stringify([{ store: "Users", env: "KAOIRO_USERS_PATH", default_file: "users.dets" }]);
  const result = withScenario("running-clean-stop", () =>
    withEnvConsistencyFixture(
      {
        evalOutput,
        composeEnvJson: '{"KAOIRO_USERS_PATH":"/var/lib/kaoiro/users.dets"}',
        containerEnvJson: '["KAOIRO_USERS_PATH=/var/lib/kaoiro/users.dets"]',
      },
      () => runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
    ),
  );
  assert.equal(result.phase, "done");
  const backupRoot = join(root, "kaoiro-deploy");
  const manifest = readManifest(join(backupRoot, result.transactionId));
  const entry = manifest.env_consistency.entries.KAOIRO_USERS_PATH;
  assert.equal(entry.match, true);
  assert.equal(entry.declared, null);
});

test("runUpdate completes through DONE with --maintenance-approved and a clean stop", () => {
  const result = withScenario("running-clean-stop", () =>
    runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
  );
  assert.equal(result.phase, "done");
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
  // (c3): health/stability.
  assert.equal(result.health.build_revision, headSha);
  assert.deepEqual(result.prunedTransactions, []);
  assert.equal(result.pruneError, null);
  const backupRoot = join(root, "kaoiro-deploy");
  const journal = readJournal(join(backupRoot, result.transactionId));
  assert.equal(journal.phase, "done");
  const oldImageEntry = journal.history.find((e) => e.phase === "old_image_saved");
  assert.equal(oldImageEntry.observation.rollback_tag, result.rollbackTag);
  const healthyEntry = journal.history.find((e) => e.phase === "healthy");
  assert.equal(healthyEntry.observation.health_revision, headSha);
  const manifest = readManifest(join(backupRoot, result.transactionId));
  assert.equal(manifest.volume_id, "kaoiro_kaoiro-state");
  assert.equal(manifest.image_id, result.build.imageId);
  assert.equal(manifest.source_sha, headSha);
  assert.deepEqual(manifest.required_entries, result.requiredEntries);
});

// director ruling 2026-09-06 (#306 (c3) review): a hardcoded health_url
// default would miss in production (KAOIRO_PUBLISH_IP publishes on a
// different host than the dev-default loopback) — resolveHealthUrl
// derives it from `docker compose port` instead, tested here directly
// rather than by threading 3 more scenarios through the whole runUpdate
// flow.
test("resolveHealthUrl returns config.health_url unchanged without calling docker", () => {
  const url = withOverrideEnv(() =>
    resolveHealthUrl(bin, join(workDir, "server"), { health_url: "http://explicit/api/health" }),
  );
  assert.equal(url, "http://explicit/api/health");
});

test("resolveHealthUrl derives the URL from `docker compose port` when health_url is null", () => {
  const url = withScenario("health-url-derivable", () =>
    resolveHealthUrl(bin, join(workDir, "server"), { health_url: null }),
  );
  assert.equal(url, "http://127.0.0.1:9999/api/health");
});

// クロエ round 3 review N-1: `http://:::4000/...` is not a valid URL — an
// IPv6 host must be bracketed once it contains a colon of its own.
test("resolveHealthUrl brackets an IPv6 host reported unbracketed by `docker compose port`", () => {
  const url = withScenario("health-url-ipv6", () =>
    resolveHealthUrl(bin, join(workDir, "server"), { health_url: null }),
  );
  assert.equal(url, "http://[::]:4000/api/health");
  assert.doesNotThrow(() => new URL(url));
});

test("resolveHealthUrl fails when `docker compose port` itself fails", () => {
  assert.throws(
    () => withScenario("health-url-port-fails", () => resolveHealthUrl(bin, join(workDir, "server"), { health_url: null })),
    DeployError,
  );
});

test("resolveHealthUrl fails when `docker compose port` returns no output", () => {
  assert.throws(
    () => withScenario("health-url-port-empty", () => resolveHealthUrl(bin, join(workDir, "server"), { health_url: null })),
    DeployError,
  );
});

// クロエ round 2 review SF-8: a symlink's `-> target` and a hardlink's
// `link to target` suffix must not leak into the recorded path — both
// exercised against a REAL archive (FAKE_DOCKER's running-clean-stop-torture
// branch), not a hand-written tar-tvzf-shaped string.
test("runUpdate's required_entries strip a symlink's and a hardlink's target suffix from the name", () => {
  const result = withScenario("running-clean-stop-torture", () =>
    runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
  );
  assert.equal(result.phase, "done");
  const byPath = Object.fromEntries(result.requiredEntries.map((e) => [e.path, e]));
  assert.deepEqual(Object.keys(byPath).sort(), ["hard.txt", "real.txt", "sym.txt"]);
  assert.deepEqual(byPath["sym.txt"], { path: "sym.txt", owner: "1000:1000", mode: "0777" });
  assert.deepEqual(byPath["hard.txt"], { path: "hard.txt", owner: "1000:1000", mode: "0664" });
  assert.deepEqual(byPath["real.txt"], { path: "real.txt", owner: "1000:1000", mode: "0664" });
});

test("parseTarEntries refuses a listing line with an unsupported entry type", () => {
  let caught;
  try {
    parseTarEntries("p--------- 0/0               0 2026-09-06 00:00 ./fifo");
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  // クロエ round 2 review N-7: a PARSE failure (this) must read
  // distinctly from an ARCHIVE-integrity failure (the broken-archive
  // test above) — runUpdate's own call site no longer wraps this one in
  // "archive verification failed".
  assert.ok(!caught.message.includes("archive verification failed"));
});

// クロエ round 2 review SF-8 supplement: a FIFO needs no root (`mkfifo`
// — measured; the earlier assumption that device/fifo/socket entries
// need it was wrong), so this feeds parseTarEntries a REAL archive
// containing a symlink, a hardlink, a space-bearing name, AND a FIFO all
// together — the exact combination the round asked for as a round-3
// acceptance check — rather than the hand-typed single-line fixture
// above.
test("parseTarEntries rejects a real archive containing a FIFO, even alongside otherwise-valid entries", () => {
  const src = mkdtempSync(join(tmpdir(), "kaoiro-306-tar-torture-"));
  const archiveDir = mkdtempSync(join(tmpdir(), "kaoiro-306-tar-torture-out-"));
  try {
    writeFileSync(join(src, "real.txt"), "x");
    writeFileSync(join(src, "name with space.txt"), "x");
    execFileSync("ln", ["-s", "real.txt", join(src, "sym.txt")]);
    execFileSync("ln", [join(src, "real.txt"), join(src, "hard.txt")]);
    execFileSync("mkfifo", [join(src, "a.fifo")]);
    const archivePath = join(archiveDir, "archive.tar.gz");
    execFileSync("tar", ["--owner=1000", "--group=1000", "-czf", archivePath, "-C", src, "."]);
    const listing = execFileSync("tar", ["tvzf", archivePath, "--numeric-owner"], { encoding: "utf8" });
    assert.ok(listing.includes("a.fifo"), "sanity: the fixture actually contains the FIFO entry");
    assert.throws(() => parseTarEntries(listing), DeployError);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(archiveDir, { recursive: true, force: true });
  }
});

// director ruling 2026-09-06 (round 5, closing the required_entries
// mismatch pin gap left open in the rollback commit): the restored-
// volume-vs-manifest comparison rollback's own destructive path relies
// on, pinned directly as a pure function.
test("requiredEntriesMatch is true for the same entries in a different order", () => {
  const a = [
    { path: "users.dets", owner: "1000:1000", mode: "0600" },
    { path: "agent_directory.dets", owner: "1000:1000", mode: "0600" },
  ];
  const b = [...a].reverse();
  assert.equal(requiredEntriesMatch(a, b), true);
});

test("requiredEntriesMatch is false when an entry is missing", () => {
  const expected = [
    { path: "users.dets", owner: "1000:1000", mode: "0600" },
    { path: "agent_directory.dets", owner: "1000:1000", mode: "0600" },
  ];
  const actual = [expected[0]];
  assert.equal(requiredEntriesMatch(actual, expected), false);
});

test("requiredEntriesMatch is false when an entry is extra", () => {
  const expected = [{ path: "users.dets", owner: "1000:1000", mode: "0600" }];
  const actual = [...expected, { path: "unexpected.dets", owner: "1000:1000", mode: "0600" }];
  assert.equal(requiredEntriesMatch(actual, expected), false);
});

test("requiredEntriesMatch is false when an entry's owner disagrees", () => {
  const expected = [{ path: "users.dets", owner: "1000:1000", mode: "0600" }];
  const actual = [{ path: "users.dets", owner: "0:0", mode: "0600" }];
  assert.equal(requiredEntriesMatch(actual, expected), false);
});

test("requiredEntriesMatch is false when an entry's mode disagrees", () => {
  const expected = [{ path: "users.dets", owner: "1000:1000", mode: "0600" }];
  const actual = [{ path: "users.dets", owner: "1000:1000", mode: "0644" }];
  assert.equal(requiredEntriesMatch(actual, expected), false);
});

// クロエ round 1 review S1/(c3): a delayed health response for a
// PREVIOUS target must not let this transaction advance — the health
// poll retries until it actually observes the CURRENT target_sha, not
// merely "a response arrived".
test("runUpdate's health poll times out when the server never reports the target revision", () => {
  process.env.KAOIRO_TEST_HEALTH_REVISION = "f".repeat(40); // never equals headSha
  try {
    assert.throws(
      () =>
        withScenario("running-clean-stop", () =>
          runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
        ),
      DeployError,
    );
  } finally {
    delete process.env.KAOIRO_TEST_HEALTH_REVISION;
  }
  const backupRoot = join(root, "kaoiro-deploy");
  const [transactionDir] = readdirSyncNonHidden(backupRoot);
  const journal = readJournal(join(backupRoot, transactionDir));
  assert.equal(journal.phase, "up");
});

// director ruling 2026-09-06 (#306 (c3) review): a dirty build at the
// right SHA is not a successful deploy — deployment.md 4.5's own
// provenance table treats build_dirty as a SEPARATE success criterion
// from build_revision, not a detail folded into it.
test("runUpdate's health poll times out when the server reports the target revision but a dirty build", () => {
  process.env.KAOIRO_TEST_HEALTH_DIRTY = "true";
  try {
    assert.throws(
      () =>
        withScenario("running-clean-stop", () =>
          runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
        ),
      DeployError,
    );
  } finally {
    delete process.env.KAOIRO_TEST_HEALTH_DIRTY;
  }
});

test("runUpdate refuses to call an update done when the container restarts during the stability window", () => {
  process.env.KAOIRO_TEST_RESTART_COUNTER = join(root, "restart-counter");
  try {
    assert.throws(
      () =>
        withScenario("running-clean-stop-restarts", () =>
          runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
        ),
      DeployError,
    );
  } finally {
    delete process.env.KAOIRO_TEST_RESTART_COUNTER;
  }
  const backupRoot = join(root, "kaoiro-deploy");
  const [transactionDir] = readdirSyncNonHidden(backupRoot);
  const journal = readJournal(join(backupRoot, transactionDir));
  assert.equal(journal.phase, "healthy");
});

test("runUpdate prunes DONE transactions beyond keep_generations that are also older than retention_days", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  mkdirSync(backupRoot, { recursive: true });

  // Three synthetic prior DONE transactions, all well past retention_days
  // and beyond keep_generations:1 — every one of them is prune-eligible.
  const oldIds = ["20200101T000000Z", "20200102T000000Z", "20200103T000000Z"];
  const oldRollbackTag = `kaoiro-server:rollback-${"9".repeat(40)}`;
  for (const id of oldIds) {
    const dir = join(backupRoot, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "journal.json"),
      JSON.stringify({ schema_version: 1, transaction_id: id, phase: "done", history: [] }),
    );
  }
  // クロエ round 3 review SF-2: only the FIRST one carries a manifest —
  // the other two must be SKIPPED (left on disk), not have their
  // directory deleted anyway with the tag cleanup merely skipped (the
  // prior contract this test itself pinned before round 3).
  writeFileSync(
    join(backupRoot, oldIds[0], "manifest.json"),
    JSON.stringify({
      schema_version: 1,
      transaction_id: oldIds[0],
      compose_artifact: { path: "server/docker-compose.yaml", sha256: "a".repeat(64) },
      env_consistency: { skipped: false, entries: {} },
      image_id: `sha256:${"b".repeat(64)}`,
      source_sha: "9".repeat(40),
      target_sha: "d".repeat(40),
      volume_id: "kaoiro_kaoiro-state",
      archive: { path: "/backup/archive.tar.gz", sha256: "e".repeat(64) },
      required_entries: [{ path: "users.dets", owner: "1000:1000", mode: "0600" }],
      rollback_tag: oldRollbackTag,
    }),
  );

  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let result;
  try {
    result = withScenario("running-clean-stop", () =>
      runUpdate(
        { repo: workDir, target: headSha, maintenanceApproved: true },
        { ...configWithCleanStopMeasured(), keep_generations: 1, retention_days: 1 },
      ),
    );
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  const lines = log.trim().split("\n");
  assert.ok(
    lines.some((line) => line === `rmi ${oldRollbackTag}`),
    "expected the pruned transaction's own manifest-recorded rollback_tag to be removed via docker rmi",
  );
  assert.equal(
    lines.filter((line) => line.startsWith("rmi ")).length,
    1,
    "only the ONE pruned transaction that actually has a manifest should trigger a docker rmi call",
  );
  assert.equal(result.phase, "done");
  // The newest kept generation is THIS transaction; all 3 synthetic old
  // ones are beyond keep_generations:1 and older than retention_days:1 —
  // but only oldIds[0] carries a manifest, so it alone is actually
  // removed (SF-2: an unreadable manifest skips deletion, not just the
  // tag cleanup).
  assert.deepEqual(result.prunedTransactions, [oldIds[0]]);
  assert.equal(existsSync(join(backupRoot, oldIds[0])), false);
  assert.deepEqual(
    result.pruneSkipped.map((s) => s.id).sort(),
    [oldIds[1], oldIds[2]],
  );
  for (const id of [oldIds[1], oldIds[2]]) {
    assert.equal(existsSync(join(backupRoot, id)), true);
  }
});

test("runUpdate does not prune a DONE transaction that is beyond keep_generations but still within retention_days", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  mkdirSync(backupRoot, { recursive: true });

  const recentId = new Date(Date.now() - 60 * 60 * 1000) // 1 hour ago
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d\d\dZ$/, "Z");
  const dir = join(backupRoot, recentId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "journal.json"),
    JSON.stringify({ schema_version: 1, transaction_id: recentId, phase: "done", history: [] }),
  );

  const result = withScenario("running-clean-stop", () =>
    runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      { ...configWithCleanStopMeasured(), keep_generations: 1, retention_days: 30 },
    ),
  );
  assert.equal(result.phase, "done");
  assert.deepEqual(result.prunedTransactions, []);
  assert.equal(existsSync(dir), true);
});

// Distinguishes the COUNT bound from the age bound: both synthetic
// transactions here are old enough that retention_days:1 alone would
// prune both. keep_generations:2 (which counts THIS run's own
// transaction as the newest generation) must still protect the
// second-newest of the three from being pruned this round.
test("runUpdate keeps the newest keep_generations DONE transactions even when all are past retention_days", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  mkdirSync(backupRoot, { recursive: true });

  const olderId = "20200101T000000Z";
  const newerId = "20200102T000000Z";
  for (const id of [olderId, newerId]) {
    const dir = join(backupRoot, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "journal.json"),
      JSON.stringify({ schema_version: 1, transaction_id: id, phase: "done", history: [] }),
    );
  }
  // A manifest (SF-2: no manifest means "skip, do not delete" — this test
  // is pinning the COUNT bound, so olderId must actually be eligible for
  // deletion, not merely skipped for an unrelated reason). Its own
  // rollback_tag is unique (not shared with newerId or this run's own
  // transaction), so MF-1's tag-survival protection does not interfere.
  writeFileSync(
    join(backupRoot, olderId, "manifest.json"),
    JSON.stringify({
      schema_version: 1,
      transaction_id: olderId,
      compose_artifact: { path: "server/docker-compose.yaml", sha256: "a".repeat(64) },
      env_consistency: { skipped: false, entries: {} },
      image_id: `sha256:${"b".repeat(64)}`,
      source_sha: "9".repeat(40),
      target_sha: "d".repeat(40),
      volume_id: "kaoiro_kaoiro-state",
      archive: { path: "/backup/archive.tar.gz", sha256: "e".repeat(64) },
      required_entries: [{ path: "users.dets", owner: "1000:1000", mode: "0600" }],
      rollback_tag: `kaoiro-server:rollback-${"9".repeat(40)}`,
    }),
  );

  const result = withScenario("running-clean-stop", () =>
    runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      { ...configWithCleanStopMeasured(), keep_generations: 2, retention_days: 1 },
    ),
  );
  assert.equal(result.phase, "done");
  assert.deepEqual(result.prunedTransactions, [olderId]);
  assert.equal(existsSync(join(backupRoot, olderId)), false);
  assert.equal(existsSync(join(backupRoot, newerId)), true);
  assert.equal(existsSync(join(backupRoot, result.transactionId)), true);
});

// Retention must never touch a transaction that has not reached DONE —
// an in-progress or manually-parked one is a human's investigation, not
// automatic cleanup, no matter how old or how far beyond keep_generations.
// A non-DONE transaction directory can never coexist with a successful
// runUpdate call in practice (findUnfinishedTransaction refuses to start
// a new transaction while ANY non-terminal one exists — this IS the
// property being relied on), so this exercises pruneOldTransactions()
// directly rather than manufacturing an unreachable end-to-end scenario.
test("pruneOldTransactions never removes a transaction that has not reached DONE, however old", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  mkdirSync(backupRoot, { recursive: true });

  const stuckId = "20200101T000000Z";
  const stuckDir = join(backupRoot, stuckId);
  mkdirSync(stuckDir, { recursive: true });
  writeFileSync(
    join(stuckDir, "journal.json"),
    JSON.stringify({
      schema_version: 1,
      transaction_id: stuckId,
      phase: "preflight",
      history: [{ phase: "preflight", at: "2020-01-01T00:00:00.000Z", observation: { container: "kaoiro-c1" } }],
    }),
  );

  const { removed } = pruneOldTransactions(backupRoot, { keep_generations: 0, retention_days: 1 });
  assert.deepEqual(removed, []);
  assert.equal(existsSync(stuckDir), true);
});

// director ruling 2026-09-06 (#306 (c3) review): the current rollback
// pair is protected by IDENTITY, not merely by the keep_generations
// count coincidentally always including the newest — keep_generations:0
// here (bypassing the config validator's own >= 1 floor, exactly as a
// directly-constructed config in production code could) would otherwise
// prune EVERY done transaction, including the protected one.
test("pruneOldTransactions never removes the protected transaction, even with keep_generations:0", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  mkdirSync(backupRoot, { recursive: true });

  const protectedId = "20200101T000000Z";
  const protectedDir = join(backupRoot, protectedId);
  mkdirSync(protectedDir, { recursive: true });
  writeFileSync(
    join(protectedDir, "journal.json"),
    JSON.stringify({ schema_version: 1, transaction_id: protectedId, phase: "done", history: [] }),
  );

  const { removed } = pruneOldTransactions(
    backupRoot,
    { keep_generations: 0, retention_days: 1 },
    protectedId,
  );
  assert.deepEqual(removed, []);
  assert.equal(existsSync(protectedDir), true);
});

// クロエ round 3 review MF-1: writes a synthetic transaction directory
// directly (journal.json always, manifest.json only when `manifest` is
// given) — rollback_tag is `kaoiro-server:rollback-<sourceSha>`
// (schema-enforced), so two transactions built with the SAME sourceSha
// end up with the SAME tag, exactly the collision MF-1 is about.
function writeSyntheticTransaction(backupRoot, id, { phase, sourceSha }) {
  const dir = join(backupRoot, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "journal.json"), JSON.stringify({ schema_version: 1, transaction_id: id, phase, history: [] }));
  if (sourceSha === undefined) return;
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schema_version: 1,
      transaction_id: id,
      compose_artifact: { path: "server/docker-compose.yaml", sha256: "a".repeat(64) },
      env_consistency: { skipped: false, entries: {} },
      image_id: `sha256:${"b".repeat(64)}`,
      source_sha: sourceSha,
      target_sha: "d".repeat(40),
      volume_id: "kaoiro_kaoiro-state",
      archive: { path: "/backup/archive.tar.gz", sha256: "e".repeat(64) },
      required_entries: [{ path: "users.dets", owner: "1000:1000", mode: "0600" }],
      rollback_tag: `kaoiro-server:rollback-${sourceSha}`,
    }),
  );
}

function readCallLog(logPath) {
  return existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").filter((l) => l !== "") : [];
}

test("pruneOldTransactions never rmi's a tag the protected transaction still shares with a pruned older DONE", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  mkdirSync(backupRoot, { recursive: true });
  const sha = "a".repeat(40);
  const olderId = "20200101T000000Z";
  const protectedId = "20200102T000000Z";
  writeSyntheticTransaction(backupRoot, olderId, { phase: "done", sourceSha: sha });
  writeSyntheticTransaction(backupRoot, protectedId, { phase: "done", sourceSha: sha });

  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let removed;
  try {
    ({ removed } = pruneOldTransactions(backupRoot, { keep_generations: 0, retention_days: 1 }, protectedId, bin));
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  // The older, same-sha transaction's DIRECTORY is still reclaimed —
  // only its shared TAG must survive, since the protected transaction
  // still names it.
  assert.deepEqual(removed, [olderId]);
  assert.equal(existsSync(join(backupRoot, protectedId)), true);
  assert.deepEqual(readCallLog(logPath), [], "the shared tag must never be rmi'd while the protected transaction still needs it");
});

test("pruneOldTransactions rmi's a pruned transaction's tag when no surviving transaction shares it", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  mkdirSync(backupRoot, { recursive: true });
  const sharedSha = "a".repeat(40);
  const uniqueSha = "b".repeat(40);
  const olderId = "20200101T000000Z"; // shares sharedSha with protectedId
  const protectedId = "20200102T000000Z";
  const uniqueId = "20200103T000000Z"; // its own tag, shared with nobody
  writeSyntheticTransaction(backupRoot, olderId, { phase: "done", sourceSha: sharedSha });
  writeSyntheticTransaction(backupRoot, protectedId, { phase: "done", sourceSha: sharedSha });
  writeSyntheticTransaction(backupRoot, uniqueId, { phase: "done", sourceSha: uniqueSha });

  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let removed;
  try {
    ({ removed } = pruneOldTransactions(backupRoot, { keep_generations: 0, retention_days: 1 }, protectedId, bin));
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  assert.deepEqual(removed.sort(), [olderId, uniqueId]);
  assert.deepEqual(readCallLog(logPath), [`rmi kaoiro-server:rollback-${uniqueSha}`]);
});

test("pruneOldTransactions never rmi's a tag an unfinished transaction still shares with a pruned old DONE", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  mkdirSync(backupRoot, { recursive: true });
  const sha = "a".repeat(40);
  const oldDoneId = "20200101T000000Z";
  const unfinishedId = "20200102T000000Z";
  writeSyntheticTransaction(backupRoot, oldDoneId, { phase: "done", sourceSha: sha });
  // Parked at old_image_saved — non-DONE, so it never enters doneIds at
  // all, yet it is exactly the transaction that most needs its own tag
  // (it may still resume and roll back through it).
  writeSyntheticTransaction(backupRoot, unfinishedId, { phase: "old_image_saved", sourceSha: sha });

  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let removed;
  try {
    ({ removed } = pruneOldTransactions(backupRoot, { keep_generations: 0, retention_days: 1 }, undefined, bin));
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  assert.deepEqual(removed, [oldDoneId]);
  assert.equal(existsSync(join(backupRoot, unfinishedId)), true);
  assert.deepEqual(readCallLog(logPath), [], "the unfinished transaction's own tag must never be rmi'd");
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
  assert.equal(result.phase, "done");
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
  // running-broken-archive stops at MOUNT_RESOLVED (archive verification
  // fails before ARCHIVED is ever checkpointed) — non-terminal, and
  // untouched by (c3)'s up/health/stability/retention plumbing.
  try {
    withScenario("running-broken-archive", () =>
      runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
    );
  } catch (err) {
    assert.ok(err instanceof DeployError);
  }
  const backupRoot = join(root, "kaoiro-deploy");
  const before = readdirSyncNonHidden(backupRoot).length;
  let caught;
  try {
    withScenario("running", () => runUpdate({ repo: workDir, target: headSha }, configWithOverride()));
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  // クロエ round 1 review MF-3: the reached phase is MOUNT_RESOLVED — the
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

// クロエ round 3 review MF-2: STARTING was missing from the old
// hand-written UNRESUMABLE_PHASES set — a transaction parked there got
// "resume with --transaction", and the resume path then appended
// MAINTENANCE_GATE_PASSED, an illegal transition from STARTING, raising
// a raw PhaseError instead of this diagnosable message. No existing
// FAKE_DOCKER scenario stops a real runUpdate exactly between STARTING
// and UP (every scenario's `compose ps`/`up` succeed together), so this
// writes the parked journal directly — a full, schema-valid history
// through STARTING, the same shape findUnfinishedTransaction's own
// validateJournalAgainstStateMachine call requires before this guidance
// is ever reached.
test("runUpdate's unfinished-transaction guidance for a transaction parked at STARTING is the manual-recovery message", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  const transactionId = "20260906T230000Z";
  const dir = join(backupRoot, transactionId);
  mkdirSync(dir, { recursive: true });
  const oldSha = headSha;
  const targetSha = "d".repeat(40);
  const imageId = `sha256:${"b".repeat(64)}`;
  const composeSha = "c".repeat(64);
  const entry = (phase, observation) => ({ phase, at: "2026-09-06T23:00:00.000Z", observation });
  const history = [
    entry("preflight", { container: "kaoiro-c1" }),
    entry("old_image_saved", {
      old_image_id: imageId,
      old_sha: oldSha,
      compose_artifact: { path: "/x/docker-compose.yaml", sha256: composeSha },
      rollback_tag: `kaoiro-server:rollback-${oldSha}`,
    }),
    entry("build_prepared", { image_id: imageId, image_tag: "kaoiro-server:latest", target_sha: targetSha }),
    entry("env_consistency_checked", { skipped: false, entries: {} }),
    entry("maintenance_gate_passed", {}),
    entry("stopping", {}),
    entry("stopped", { stop_exit_code: 0, stop_oom_killed: false }),
    entry("mount_resolved", { volume_id: "kaoiro_kaoiro-state" }),
    entry("archived", {
      archive: { path: "/b/a.tar.gz", sha256: composeSha },
      required_entries: [{ path: "u.dets", owner: "1000:1000", mode: "0600" }],
    }),
    entry("starting", {}),
  ];
  writeFileSync(
    join(dir, "journal.json"),
    JSON.stringify({ schema_version: 1, transaction_id: transactionId, phase: "starting", history }),
  );

  let caught;
  try {
    withOverrideEnv(() => runUpdate({ repo: workDir, target: targetSha }, configWithOverride()));
  } catch (err) {
    caught = err;
  }
  // instanceof DeployError (not PhaseError) also confirms the fixture
  // above is itself schema-valid — a malformed history would surface as
  // a raw PhaseError from findUnfinishedTransaction's own validation
  // instead of reaching this guidance message at all.
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("no resume support yet"));
  assert.ok(!caught.message.includes("resume it with --transaction"));
});

test("UNRESUMABLE_PHASES is exactly every phase reachable from STOPPING", () => {
  // Grew automatically to include rollback's own phases once B-4 added
  // a ROLLED_BACK edge from STOPPING onward and a ROLLBACK_STOPPED edge
  // from STARTING/UP/HEALTHY/DONE — a transaction parked mid-rollback is
  // exactly as unresumable BY UPDATE as one parked at STOPPED always
  // was, and the derivation (not a hand-written list) picked that up
  // for free.
  assert.deepEqual(
    [...UNRESUMABLE_PHASES].sort(),
    [
      "archived",
      "done",
      "healthy",
      "mount_resolved",
      "rollback_forensic_archived",
      "rollback_restored",
      "rollback_stopped",
      "rolled_back",
      "starting",
      "stopped",
      "stopping",
      "up",
    ].sort(),
  );
});

// クロエ round 4 review B-2: ROLLBACK_ELIGIBLE_PHASES is now the set
// difference reachable(OLD_IMAGE_SAVED) \ reachable(ROLLBACK_STOPPED),
// not a hand-written 4-element delete list — pinned two ways: the exact
// current membership, and (more directly protecting the actual property
// B-2 cares about) that EVERY phase reachable from ROLLBACK_STOPPED is
// excluded, which stays true automatically if a phase is ever inserted
// into that chain.
test("ROLLBACK_ELIGIBLE_PHASES is exactly OLD_IMAGE_SAVED-reachable minus ROLLBACK_STOPPED-reachable", () => {
  assert.deepEqual(
    [...ROLLBACK_ELIGIBLE_PHASES].sort(),
    [
      "archived",
      "build_prepared",
      "done",
      "env_consistency_checked",
      "healthy",
      "maintenance_gate_passed",
      "mount_resolved",
      "old_image_saved",
      "starting",
      "stopped",
      "stopping",
      "up",
    ].sort(),
  );
});

test("ROLLBACK_ELIGIBLE_PHASES never includes a phase reachable from ROLLBACK_STOPPED", () => {
  for (const phase of ["rollback_stopped", "rollback_forensic_archived", "rollback_restored", "rolled_back"]) {
    assert.equal(ROLLBACK_ELIGIBLE_PHASES.has(phase), false, `${phase} must be excluded`);
  }
});

// クロエ round 3 review MF-3 pin.
test("runUpdate fails the stability gate when RestartCount reads as unreadable on both sides", () => {
  assert.throws(
    () =>
      withScenario("running-clean-stop-restartcount-unreadable", () =>
        runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
      ),
    DeployError,
  );
});

function readdirSyncNonHidden(dir) {
  return readdirSync(dir).filter((name) => !name.startsWith("."));
}

// --- status --------------------------------------------------------------
// `status` never mutates: no lock, no transaction directory, no docker
// mutation. Every test below only reads.

test("status reports a running container without falling back to classify()'s branch table", () => {
  const result = withScenario("running", () => runStatus({ repo: workDir }, configWithOverride()));
  assert.equal(result.container.running, true);
  assert.equal(result.container.container, "kaoiro-c1");
  assert.equal(result.unfinishedTransaction, null);
  assert.deepEqual(result.doneTransactions, []);
});

test("status reports branch A when the container is stopped", () => {
  const result = withScenario("stopped", () => runStatus({ repo: workDir }, configWithOverride()));
  assert.equal(result.container.running, false);
  assert.equal(result.container.branch, "A");
  assert.equal(result.container.container, "kaoiro-c1");
});

test("status reports branch C when there is no container and no prior state", () => {
  const result = withOverrideEnv(() => runStatus({ repo: workDir }, configWithOverride()));
  assert.equal(result.container.running, false);
  assert.equal(result.container.branch, "C");
});

// クロエ round 4 review N-3, end to end through classify(): no container
// (requireRunningContainer correctly throws BranchError, reaching
// classify()) and no prior transactions, but hasPriorTransactions
// itself could not determine the volume's existence (docker
// unreachable) — must diagnose, never claim FRESH.
test("status reports branch D (never C) when no container is found and hasPriorTransactions itself could not tell", () => {
  const result = withScenario("docker-unreachable-for-state-check", () =>
    runStatus({ repo: workDir }, configWithOverride()),
  );
  assert.equal(result.container.running, false);
  assert.equal(result.container.branch, "D");
  assert.ok(result.container.reason.includes("could not determine whether prior state exists"));
});

test("status reports branch B when prior transaction state exists but no container is found", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  mkdirSync(join(backupRoot, "20260906T000000Z"), { recursive: true });
  const result = withOverrideEnv(() =>
    runStatus({ repo: workDir }, { ...configWithOverride(), backup_root: backupRoot }),
  );
  assert.equal(result.container.running, false);
  assert.equal(result.container.branch, "B");
});

test("status's health field carries the health body when the container answers", () => {
  const result = withScenario("running", () =>
    runStatus({ repo: workDir }, { ...configWithOverride(), health_url: "http://fake-server.invalid/api/health" }),
  );
  assert.equal(result.health.url, "http://fake-server.invalid/api/health");
  // withOverrideEnv's own default sets KAOIRO_TEST_HEALTH_REVISION to
  // headSha unless a caller already set it — status only surfaces what
  // curl returned, it does not judge whether it matches any target.
  assert.equal(result.health.build_revision, headSha);
});

test("status's health field reports an error (not a crash) when curl itself fails to resolve the URL", () => {
  // "running" is not a case `docker compose port` recognizes in this
  // fixture (only the health-url-* scenarios are), so it falls through
  // to empty output — the same "no output" failure resolveHealthUrl's
  // own direct unit test exercises via "health-url-port-empty". Reusing
  // it here (rather than "health-url-port-fails", which is ALSO absent
  // from the fixture's `compose ps` case list and would report no
  // container at all) keeps container.running true while still failing
  // health_url resolution.
  const result = withScenario("running", () =>
    runStatus({ repo: workDir }, { ...configWithOverride(), health_url: null }),
  );
  assert.equal(result.container.running, true);
  assert.ok(result.health.error, "expected a health.error, not a thrown exception");
});

test("status's health field reports an error (not a crash) when curl itself is unavailable", () => {
  withScenario("running", () => {
    const priorCurl = process.env.KAOIRO_DEPLOY_CURL_BIN;
    process.env.KAOIRO_DEPLOY_CURL_BIN = join(root, "does-not-exist-curl");
    try {
      const result = runStatus(
        { repo: workDir },
        { ...configWithOverride(), health_url: "http://fake-server.invalid/api/health" },
      );
      assert.equal(result.container.running, true);
      assert.ok(result.health.error, "expected a health.error, not a thrown exception");
    } finally {
      if (priorCurl === undefined) delete process.env.KAOIRO_DEPLOY_CURL_BIN;
      else process.env.KAOIRO_DEPLOY_CURL_BIN = priorCurl;
    }
  });
});

test("status does not attempt a health check when no container is running", () => {
  const result = withScenario("stopped", () => runStatus({ repo: workDir }, configWithOverride()));
  assert.equal(result.health, null);
});

// クロエ round 4 review MF-4: every leg of status is independent — a
// transaction directory that fails findUnfinishedTransaction's own
// state-machine trust checks must not blank the rest of the output.
test("status still returns a full object when a transaction directory has a mismatched transaction_id", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  const dirId = "20200101T000000Z";
  mkdirSync(join(backupRoot, dirId), { recursive: true });
  writeFileSync(
    join(backupRoot, dirId, "journal.json"),
    JSON.stringify({ schema_version: 1, transaction_id: "20200102T000000Z", phase: "preflight", history: [] }),
  );
  const result = withScenario("running", () =>
    runStatus({ repo: workDir }, { ...configWithOverride(), backup_root: backupRoot }),
  );
  assert.equal(result.container.running, true);
  assert.deepEqual(result.doneTransactions, []);
  assert.ok(typeof result.scopeNote === "string" && result.scopeNote !== "");
  assert.ok(result.unfinishedTransaction.error.includes("refusing to guess which is authoritative"));
  assert.equal(result.unfinishedTransaction.directory, join(backupRoot, dirId));
});

test("status still returns a full object when a transaction directory fails the state-machine check", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  const dirId = "20200101T000000Z";
  mkdirSync(join(backupRoot, dirId), { recursive: true });
  // Non-empty history is required for PREFLIGHT to be the only phase an
  // empty history is legal at — "archived" with an empty history is a
  // state-machine violation (validateJournalAgainstStateMachine's own
  // "no evidence supports it" branch).
  writeFileSync(
    join(backupRoot, dirId, "journal.json"),
    JSON.stringify({ schema_version: 1, transaction_id: dirId, phase: "archived", history: [] }),
  );
  const result = withScenario("running", () =>
    runStatus({ repo: workDir }, { ...configWithOverride(), backup_root: backupRoot }),
  );
  assert.equal(result.container.running, true);
  assert.ok(result.unfinishedTransaction.error.includes("no evidence supports it"));
  assert.equal(result.unfinishedTransaction.directory, join(backupRoot, dirId));
});

// クロエ round 4 review SF-3: docker itself unreachable must not escape
// as a raw, undiagnosed error — and classify() must not be called a
// second time against the same unreachable daemon.
test("status reports container.error (not a crash) when docker itself is unreachable", () => {
  const brokenBin = join(root, "broken-docker.sh");
  writeFileSync(brokenBin, "#!/bin/sh\necho 'Cannot connect to the Docker daemon.' >&2\nexit 1\n");
  chmodSync(brokenBin, 0o700);
  const priorDocker = process.env.KAOIRO_DEPLOY_DOCKER_BIN;
  process.env.KAOIRO_DEPLOY_DOCKER_BIN = brokenBin;
  let result;
  try {
    result = runStatus({ repo: workDir }, configWithOverride());
  } finally {
    if (priorDocker === undefined) delete process.env.KAOIRO_DEPLOY_DOCKER_BIN;
    else process.env.KAOIRO_DEPLOY_DOCKER_BIN = priorDocker;
  }
  assert.equal(result.container.running, false);
  assert.ok(typeof result.container.error === "string" && result.container.error !== "");
  assert.equal(result.container.branch, undefined, "classify() must not have run a second docker call");
  assert.equal(result.health, null);
});

test("status surfaces an unfinished transaction's id and phase", () => {
  let result;
  withScenario("running-broken-archive", () => {
    try {
      runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured());
    } catch (err) {
      assert.ok(err instanceof DeployError);
    }
    result = runStatus({ repo: workDir }, configWithCleanStopMeasured());
  });
  const backupRoot = configWithCleanStopMeasured().backup_root;
  const [transactionId] = readdirSyncNonHidden(backupRoot);
  assert.equal(result.unfinishedTransaction.id, transactionId);
  assert.equal(result.unfinishedTransaction.phase, "mount_resolved");
  // issue #220 absorption (turn 8 follow-up): MOUNT_RESOLVED is reached
  // only after ENV_CONSISTENCY_CHECKED, so its recorded observation is
  // already available here.
  assert.deepEqual(result.unfinishedTransaction.envConsistency, { skipped: false, entries: {} });
});

// issue #220 absorption (turn 8 follow-up): a transaction that has NOT
// yet reached ENV_CONSISTENCY_CHECKED reports null there — an absence,
// not a false "skipped".
test("status reports envConsistency: null for an unfinished transaction that has not reached that phase yet", () => {
  let result;
  withScenario("running-tag-drift", () => {
    try {
      runUpdate({ repo: workDir, target: headSha }, configWithOverride());
    } catch (err) {
      assert.ok(err instanceof DeployError);
    }
    result = runStatus({ repo: workDir }, configWithOverride());
  });
  assert.equal(result.unfinishedTransaction.phase, "preflight");
  assert.equal(result.unfinishedTransaction.envConsistency, null);
});

test("status lists a completed transaction with its source/target SHA and completion time", () => {
  let result;
  withScenario("running-clean-stop", () => {
    const update = runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      configWithCleanStopMeasured(),
    );
    assert.equal(update.phase, "done");
    result = runStatus({ repo: workDir }, configWithCleanStopMeasured());
  });
  assert.equal(result.unfinishedTransaction, null);
  assert.equal(result.doneTransactions.length, 1);
  const [entry] = result.doneTransactions;
  assert.equal(entry.sourceSha, headSha);
  assert.equal(entry.targetSha, headSha);
  assert.deepEqual(entry.envConsistency, { skipped: false, entries: {} });
  assert.ok(typeof entry.doneAt === "string" && entry.doneAt !== "");
});

test("status still lists a DONE transaction (with null facts) when its manifest.json is missing", () => {
  let result;
  const backupRoot = configWithCleanStopMeasured().backup_root;
  withScenario("running-clean-stop", () => {
    const update = runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      configWithCleanStopMeasured(),
    );
    rmSync(join(backupRoot, update.transactionId, "manifest.json"));
    result = runStatus({ repo: workDir }, configWithCleanStopMeasured());
  });
  assert.equal(result.doneTransactions.length, 1);
  const [entry] = result.doneTransactions;
  assert.equal(entry.sourceSha, null);
  assert.equal(entry.targetSha, null);
  // journal.json is untouched, so completion time is still readable
  // independently of the missing manifest.
  assert.ok(typeof entry.doneAt === "string" && entry.doneAt !== "");
});

// クロエ round 4 review SF-4: reworded to what status actually reads
// (container state / health provenance / unfinished phase / DONE
// history) and does not (runner signals, 5-b's ledger migration, the
// REASON behind a runner-side build failure) — the original overclaimed
// full coverage of deployment.md 4.4's branches (0)/(1)/(3)/(4)/(5).
test("status's scopeNote states what it reads and does not, without overclaiming runbook branch coverage", () => {
  const result = withScenario("running", () => runStatus({ repo: workDir }, configWithOverride()));
  assert.ok(result.scopeNote.includes("container state"));
  assert.ok(result.scopeNote.includes("health provenance"));
  assert.ok(result.scopeNote.includes("does not read runner-side signals"));
  assert.ok(result.scopeNote.includes("5-b"));
});

// --- rollback (director ruling 2026-09-06, B-1..B-5) ----------------------

function journalEntry(phase, observation) {
  return { phase, at: "2026-09-06T23:00:00.000Z", observation };
}

test("runRollback requires --transaction", () => {
  assert.throws(() => runRollback({ repo: workDir }, configWithOverride()), DeployError);
});

test("runRollback refuses an unknown transaction id", () => {
  assert.throws(
    () => runRollback({ repo: workDir, transaction: "20200101T000000Z" }, configWithOverride()),
    DeployError,
  );
});

test("runRollback refuses when the directory's journal claims a different transaction_id", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  const dirId = "20200101T000000Z";
  writeSyntheticTransaction(backupRoot, dirId, { phase: "old_image_saved" });
  // writeSyntheticTransaction's journal.transaction_id matches its own
  // dir name; overwrite it to disagree.
  const journalPath = join(backupRoot, dirId, "journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.transaction_id = "20200102T000000Z";
  writeFileSync(journalPath, JSON.stringify(journal));
  assert.throws(
    () => runRollback({ repo: workDir, transaction: dirId }, configWithOverride()),
    DeployError,
  );
});

test("runRollback refuses a transaction still at PREFLIGHT (not yet eligible)", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  const id = "20200101T000000Z";
  const dir = join(backupRoot, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "journal.json"),
    JSON.stringify({
      schema_version: 1,
      transaction_id: id,
      phase: "preflight",
      history: [journalEntry("preflight", { container: "kaoiro-c1" })],
    }),
  );
  // --confirm-restore: true — see the already-rolled-back test's own
  // comment for why this matters for a clean pin.
  let caught;
  try {
    runRollback({ repo: workDir, transaction: id, confirmRestore: true }, configWithOverride());
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("not eligible for rollback"));
});

test("runRollback refuses an already-rolled-back transaction", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  const id = "20200101T000000Z";
  const dir = join(backupRoot, id);
  mkdirSync(dir, { recursive: true });
  const oldSha = "c".repeat(40);
  const history = [
    journalEntry("preflight", { container: "kaoiro-c1" }),
    journalEntry("old_image_saved", {
      old_image_id: OLD_IMAGE_ID,
      old_sha: oldSha,
      compose_artifact: { path: "/x/docker-compose.yaml", sha256: "a".repeat(64) },
      rollback_tag: `kaoiro-server:rollback-${oldSha}`,
    }),
    journalEntry("rolled_back", {}),
  ];
  writeFileSync(
    join(dir, "journal.json"),
    JSON.stringify({ schema_version: 1, transaction_id: id, phase: "rolled_back", history }),
  );
  // --confirm-restore: true so this actually exercises the eligibility
  // check, not merely the (also-present, but different) confirm gate —
  // without it, both a correct rejection AND a bypassed-eligibility bug
  // that reaches the confirm gate first would equally satisfy a bare
  // "throws DeployError" assertion.
  let caught;
  try {
    runRollback({ repo: workDir, transaction: id, confirmRestore: true }, configWithOverride());
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("not eligible for rollback"));
});

test("runRollback --dry-run previews the non-destructive plan without mutating anything", () => {
  let transactionId;
  withScenario("running", () => {
    try {
      runUpdate({ repo: workDir, target: headSha }, configWithOverride());
    } catch (err) {
      assert.ok(err instanceof DeployError);
    }
  });
  const backupRoot = join(root, "kaoiro-deploy");
  [transactionId] = readdirSyncNonHidden(backupRoot);

  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let result;
  try {
    result = withOverrideEnv(() =>
      runRollback({ repo: workDir, transaction: transactionId, dryRun: true }, configWithOverride()),
    );
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  assert.equal(result.dryRun, true);
  assert.equal(result.destructive, false);
  assert.equal(result.phase, "env_consistency_checked");
  assert.deepEqual(readCallLog(logPath), [], "dry-run must not call docker at all");
  // Unchanged — dry-run never touches the journal.
  const journal = readJournal(join(backupRoot, transactionId));
  assert.equal(journal.phase, "env_consistency_checked");
});

test("runRollback refuses without --confirm-restore, naming the path it would take", () => {
  let transactionId;
  withScenario("running", () => {
    try {
      runUpdate({ repo: workDir, target: headSha }, configWithOverride());
    } catch (err) {
      assert.ok(err instanceof DeployError);
    }
  });
  const backupRoot = join(root, "kaoiro-deploy");
  [transactionId] = readdirSyncNonHidden(backupRoot);

  let caught;
  try {
    withOverrideEnv(() => runRollback({ repo: workDir, transaction: transactionId }, configWithOverride()));
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("--confirm-restore"));
  assert.ok(caught.message.includes("non-destructive"));
});

test("runRollback (non-destructive) retags latest and starts the old container, reaching rolled_back", () => {
  let transactionId;
  withScenario("running", () => {
    try {
      runUpdate({ repo: workDir, target: headSha }, configWithOverride());
    } catch (err) {
      assert.ok(err instanceof DeployError);
    }
  });
  const backupRoot = join(root, "kaoiro-deploy");
  [transactionId] = readdirSyncNonHidden(backupRoot);

  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let result;
  try {
    result = withOverrideEnv(() =>
      runRollback({ repo: workDir, transaction: transactionId, confirmRestore: true }, configWithOverride()),
    );
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  assert.equal(result.destructive, false);
  assert.equal(result.phase, "rolled_back");
  assert.equal(result.restoredImageId, OLD_IMAGE_ID);
  const log = readCallLog(logPath);
  assert.ok(log.includes(`tag ${OLD_IMAGE_ID} kaoiro-server:latest`));
  assert.ok(log.includes(`start ${result.container}`));
  assert.ok(!log.some((l) => l.startsWith("compose up")), "non-destructive rollback must never call compose up");
  const journal = readJournal(join(backupRoot, transactionId));
  assert.equal(journal.phase, "rolled_back");
});

test("runRollback (destructive) runs the full stop/forensic/restore/retag/up/health chain, reaching rolled_back", () => {
  let transactionId;
  const backupRoot = join(root, "kaoiro-deploy");
  withScenario("running-clean-stop", () => {
    const update = runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      configWithCleanStopMeasured(),
    );
    assert.equal(update.phase, "done");
    transactionId = update.transactionId;
  });

  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let result;
  try {
    result = withScenario("running-clean-stop", () =>
      runRollback(
        { repo: workDir, transaction: transactionId, confirmRestore: true },
        configWithCleanStopMeasured(),
      ),
    );
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  assert.equal(result.destructive, true);
  assert.equal(result.phase, "rolled_back");
  assert.equal(result.restoredImageId, OLD_IMAGE_ID);
  assert.ok(result.health, "expected a health poll result for the destructive path");

  const log = readCallLog(logPath);
  assert.ok(log.some((l) => l.startsWith("compose stop")));
  assert.ok(log.includes(`tag ${OLD_IMAGE_ID} kaoiro-server:latest`));
  assert.ok(log.some((l) => l.startsWith("compose up") && l.includes("--force-recreate")));

  const journal = readJournal(join(backupRoot, transactionId));
  assert.equal(journal.phase, "rolled_back");
  for (const phase of ["rollback_stopped", "rollback_forensic_archived", "rollback_restored", "rolled_back"]) {
    assert.ok(journal.history.some((e) => e.phase === phase), `expected a ${phase} checkpoint`);
  }
  assert.ok(existsSync(join(backupRoot, transactionId, "rollback-forensic.tar.gz")));
});

test("runRollback (destructive) refuses when the pre-deploy archive no longer matches its recorded sha256", () => {
  let transactionId;
  const backupRoot = join(root, "kaoiro-deploy");
  withScenario("running-clean-stop", () => {
    const update = runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      configWithCleanStopMeasured(),
    );
    transactionId = update.transactionId;
  });

  const dir = join(backupRoot, transactionId);
  // Tamper with the pre-deploy archive AFTER it was recorded — the exact
  // "changed archive" scenario the mutation pin below exists to catch.
  writeFileSync(join(dir, "archive.tar.gz"), Buffer.concat([readFileSync(join(dir, "archive.tar.gz")), Buffer.from("tampered")]));

  let caught;
  try {
    withScenario("running-clean-stop", () =>
      runRollback(
        { repo: workDir, transaction: transactionId, confirmRestore: true },
        configWithCleanStopMeasured(),
      ),
    );
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("does not match its recorded sha256"));
  // Refused BEFORE the destructive wipe — journal must not have advanced
  // past the forensic checkpoint.
  const journal = readJournal(dir);
  assert.equal(journal.phase, "rollback_forensic_archived");
});

// クロエ round 4 review B-1 (expanded, e3785ba3 measurement): only the
// sha256 comparison had a dedicated pin — the pre-deploy archive's own
// full-traversal check, the forensic archive's own verification, the
// restored-volume comparison's END-TO-END wiring, the 2+-container
// refusal, and BOTH paths' retag read-back were all silently unpinned
// (mutation showed 191/191 unchanged). Each gets its own test below.

test("runRollback (destructive) refuses when the pre-deploy archive fails full-traversal verification, even with a matching sha256", () => {
  let transactionId;
  const backupRoot = join(root, "kaoiro-deploy");
  withScenario("running-clean-stop", () => {
    const update = runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      configWithCleanStopMeasured(),
    );
    transactionId = update.transactionId;
  });

  const dir = join(backupRoot, transactionId);
  const archivePath = join(dir, "archive.tar.gz");
  // Corrupt the archive AND fix up the recorded sha256 to match the
  // corrupt bytes — the sha256 check must PASS (same as production data
  // silently corrupted after being archived), isolating this guard from
  // the sha256-mismatch guard already pinned above.
  const corrupt = Buffer.from("not a real gzip stream");
  writeFileSync(archivePath, corrupt);
  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.archive.sha256 = createHash("sha256").update(corrupt).digest("hex");
  writeFileSync(manifestPath, JSON.stringify(manifest));

  let caught;
  try {
    withScenario("running-clean-stop", () =>
      runRollback(
        { repo: workDir, transaction: transactionId, confirmRestore: true },
        configWithCleanStopMeasured(),
      ),
    );
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("failed full-traversal verification"));
  const journal = readJournal(dir);
  assert.equal(journal.phase, "rollback_forensic_archived");
});

test("runRollback (destructive) refuses when the forensic archive of the current volume state fails verification", () => {
  let transactionId;
  const backupRoot = join(root, "kaoiro-deploy");
  withScenario("running-clean-stop", () => {
    const update = runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      configWithCleanStopMeasured(),
    );
    transactionId = update.transactionId;
  });

  let caught;
  try {
    withScenario("rollback-forensic-corrupt", () =>
      runRollback(
        { repo: workDir, transaction: transactionId, confirmRestore: true },
        configWithCleanStopMeasured(),
      ),
    );
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("forensic archive"));
  // Refused before even the FORENSIC checkpoint — the archive it just
  // wrote failed its own verification before advancing past it.
  const journal = readJournal(join(backupRoot, transactionId));
  assert.equal(journal.phase, "rollback_stopped");
});

test("runRollback (destructive) refuses end to end when the restored volume drifts from the recorded required_entries", () => {
  let transactionId;
  const backupRoot = join(root, "kaoiro-deploy");
  withScenario("running-clean-stop", () => {
    const update = runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      configWithCleanStopMeasured(),
    );
    transactionId = update.transactionId;
  });

  let caught;
  try {
    withScenario("rollback-restore-drifts", () =>
      runRollback(
        { repo: workDir, transaction: transactionId, confirmRestore: true },
        configWithCleanStopMeasured(),
      ),
    );
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("do not match the recorded required_entries"));
  const journal = readJournal(join(backupRoot, transactionId));
  assert.equal(journal.phase, "rollback_forensic_archived");
});

test("runRollback (destructive) refuses when 2 or more containers currently match the service", () => {
  let transactionId;
  const backupRoot = join(root, "kaoiro-deploy");
  withScenario("running-clean-stop", () => {
    const update = runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      configWithCleanStopMeasured(),
    );
    transactionId = update.transactionId;
  });

  let caught;
  try {
    withScenario("multiple-containers", () =>
      runRollback(
        { repo: workDir, transaction: transactionId, confirmRestore: true },
        configWithCleanStopMeasured(),
      ),
    );
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("expected 0 or 1"));
  // Refused before the FIRST rollback checkpoint — still "done".
  const journal = readJournal(join(backupRoot, transactionId));
  assert.equal(journal.phase, "done");
});

test("runRollback (destructive) refuses when the retag read-back disagrees with the old image id", () => {
  let transactionId;
  const backupRoot = join(root, "kaoiro-deploy");
  withScenario("running-clean-stop", () => {
    const update = runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      configWithCleanStopMeasured(),
    );
    transactionId = update.transactionId;
  });

  let caught;
  try {
    withScenario("retag-drift", () =>
      runRollback(
        { repo: workDir, transaction: transactionId, confirmRestore: true },
        configWithCleanStopMeasured(),
      ),
    );
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("could not restore kaoiro-server:latest"));
  // Reached ROLLBACK_RESTORED (the restore itself succeeded) but never
  // advanced to ROLLED_BACK — the retag is the LAST gate.
  const journal = readJournal(join(backupRoot, transactionId));
  assert.equal(journal.phase, "rollback_restored");
});

test("runRollback (non-destructive) refuses when the retag read-back disagrees with the old image id", () => {
  withScenario("running", () => {
    try {
      runUpdate({ repo: workDir, target: headSha }, configWithOverride());
    } catch (err) {
      assert.ok(err instanceof DeployError);
    }
  });
  const backupRoot = join(root, "kaoiro-deploy");
  const [transactionId] = readdirSyncNonHidden(backupRoot);

  let caught;
  try {
    withScenario("retag-drift", () =>
      runRollback({ repo: workDir, transaction: transactionId, confirmRestore: true }, configWithOverride()),
    );
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("could not restore kaoiro-server:latest"));
  // Never advanced to ROLLED_BACK — still wherever it was before rollback.
  const journal = readJournal(join(backupRoot, transactionId));
  assert.equal(journal.phase, "env_consistency_checked");
});
