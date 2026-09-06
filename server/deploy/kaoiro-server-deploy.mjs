#!/usr/bin/env node
// Server deploy CLI (issue #306, design per #303 comments 2026-09-06):
// one entry point for build / start / update / rollback / status, backed
// by the manifest+journal from commit (a). This commit adds the PREPARE
// half of `update` (lock, preflight, old-image save, build, maintenance
// gate) — the no-downtime steps, ending right before the stop window.
// The COMMIT half (stop/archive/up/health-poll/retention) and
// `rollback`/`status` land in later commits (commit split agreed with
// yuta 2026-09-06).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { computeBuildIdentity } from "../../scripts/build-identity.mjs";
import { BRANCH, classify, requireRunningContainer } from "./kaoiro-deploy-branch.mjs";
import { loadConfig } from "./kaoiro-deploy-config.mjs";
import { dockerInspect, resolveDockerBin, runDocker } from "./kaoiro-deploy-docker.mjs";
import { advancePhase, readJournal, writeJournal } from "./kaoiro-deploy-journal.mjs";
import { writeManifest } from "./kaoiro-deploy-manifest.mjs";
import { PHASE, validateJournalAgainstStateMachine } from "./kaoiro-deploy-phase.mjs";
import { acquireLock, releaseLock } from "./kaoiro-deploy-lock.mjs";
import { findUnfinishedTransaction, newTransactionId } from "./kaoiro-deploy-transaction.mjs";

// The compose service name in server/docker-compose.yaml. Resolved through
// `docker compose ps`, never guessed as `<dir>-<service>-1`, so this is the
// only place the service name itself needs to be named.
const SERVICE = "kaoiro";
const SHA_RE = /^[0-9a-f]{40}$/;

// クロエ round 1 review N-5: pinned (not bare `alpine`, which floats) and
// pulled once, up front, during preflight — before the stop window opens,
// not implicitly by the first `docker run alpine ...` the archive step
// happens to make after the server is already down.
const ALPINE_IMAGE = "alpine:3";

export class DeployError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function fail(message, exitCode = 1) {
  throw new DeployError(message, exitCode);
}

function gitOutput(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  } catch (err) {
    fail(`git ${args.join(" ")} failed in ${cwd}: ${err.message}`);
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Parses a docker inspect `{{.State.ExitCode}}`-shaped field. Returns
 *  `null` on anything that is not a plain integer string — "取得不能"
 *  (unreadable) is a real outcome (a crashed/unsupported docker, a
 *  fake binary in a test), and must stay indistinguishable from "not
 *  measured yet" rather than silently becoming 0. */
function parseDockerIntField(raw) {
  return /^-?\d+$/.test(raw) ? Number(raw) : null;
}

/** Parses a docker inspect boolean-shaped field (`{{.State.OOMKilled}}`
 *  prints the literal strings "true"/"false"). Anything else is `null`,
 *  same reasoning as parseDockerIntField. */
function parseDockerBoolField(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

/** Ensures ALPINE_IMAGE is present locally, pulling it if not — BEFORE
 *  the stop window opens (クロエ round 1 review N-5). `dockerInspect`
 *  throws on a missing image; that failure IS the signal to pull, not an
 *  error to propagate. A pull failure here fails the whole update before
 *  anything is stopped, rather than surfacing mid-archive with the
 *  server already down for no useful reason. */
function ensureAlpineImage(bin) {
  try {
    dockerInspect(bin, ALPINE_IMAGE, "{{.Id}}");
    return;
  } catch {
    // Falls through to the pull below.
  }
  runDocker(bin, ["pull", ALPINE_IMAGE], { stdio: "inherit" });
}

/** True blocking sleep in the main thread (no worker, no subprocess) —
 *  Node has no synchronous timer, but `Atomics.wait` on a throwaway
 *  SharedArrayBuffer blocks the calling thread for exactly `ms`, which is
 *  what a synchronous CLI polling loop needs (this whole module is
 *  execFileSync-based throughout; making runUpdate async to use a real
 *  timer would ripple through every existing call site and test). */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** `curl` is a SEPARATE override seam from KAOIRO_DEPLOY_DOCKER_BIN's
 *  gated one — a health GET is read-only (no docker mutation the gate's
 *  own threat model cares about), so this needs no --config permission
 *  bit, just a way for tests to point it at a fake without touching the
 *  real network. */
function resolveCurlBin(env = process.env) {
  return env.KAOIRO_DEPLOY_CURL_BIN || "curl";
}

/** `GET url`, parsed as JSON. Never throws: a curl failure (connection
 *  refused, timeout, non-2xx) or a non-JSON body are both just "this
 *  attempt did not succeed" for pollHealth's retry loop, not a reason to
 *  abort the whole poll on the first flaky response. */
function fetchHealth(curlBin, url) {
  let raw;
  try {
    raw = execFileSync(curlBin, ["-sS", "--max-time", "5", url], { encoding: "utf8" });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: `GET ${url} did not return valid JSON: ${err.message}` };
  }
}

/** Polls `url` every `intervalMs` until its `build_revision` equals
 *  `targetSha` or `timeoutMs` elapses — deployment.md 4.5's provenance
 *  check ("the running JS/image derives from the target commit") via
 *  `GET /api/health` (server/lib/kaoiro_server_web/controllers/
 *  health_controller.ex). Returns the matching health body; throws
 *  DeployError naming the LAST observed attempt otherwise, so a
 *  diagnosis does not have to re-run curl by hand first. */
function pollHealth(curlBin, url, targetSha, intervalMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const result = fetchHealth(curlBin, url);
    if (result.ok && result.body.build_revision === targetSha) {
      return result.body;
    }
    last = result;
    sleepMs(intervalMs);
  }
  const detail =
    last === null
      ? "no attempt completed"
      : last.ok
        ? `last observed build_revision=${JSON.stringify(last.body.build_revision)}`
        : `last error: ${last.error}`;
  fail(
    `health check at ${url} did not report build_revision=${targetSha} within ${timeoutMs}ms (${detail})`,
  );
}

/** `docker inspect --format {{.RestartCount}}`, parsed the same
 *  never-silently-0 way as parseDockerIntField's other callers — an
 *  unreadable count must not read as "definitely zero restarts". */
function restartCount(bin, container) {
  return parseDockerIntField(dockerInspect(bin, container, "{{.RestartCount}}"));
}

// newTransactionId()'s own format: YYYYMMDDTHHMMSSZ (its ISO timestamp
// with `-`/`:` stripped and sub-second precision dropped).
const TRANSACTION_ID_TIMESTAMP_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

function transactionIdToDate(transactionId) {
  const m = TRANSACTION_ID_TIMESTAMP_RE.exec(transactionId);
  if (m === null) return null;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Deletes DONE transaction directories beyond `config.keep_generations`
 *  most-recent ones, but ONLY those also older than `config.retention_days`
 *  — issue #306 (c3). Requiring BOTH bounds (not either alone) is a
 *  deliberate conservative choice for a directory whose only job is to
 *  make rollback possible: a count-based prune alone could discard a
 *  same-day backup during a burst of deploys, and a pure age-based prune
 *  alone could discard the only remaining backup during a long quiet
 *  spell. Never touches a transaction that is not phase DONE (unfinished
 *  or failed transactions are a manual-investigation matter, never
 *  auto-deleted), and never touches a directory whose name does not match
 *  its own journal.transaction_id (the same distrust
 *  findUnfinishedTransaction already applies) or whose id does not parse
 *  as a timestamp. Returns the names actually removed. */
export function pruneOldTransactions(backupRoot, config) {
  let names;
  try {
    names = readdirSync(backupRoot).filter((name) => !name.startsWith("."));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }

  const doneIds = [];
  for (const name of names) {
    let journal;
    try {
      journal = readJournal(join(backupRoot, name));
    } catch {
      continue;
    }
    if (journal.transaction_id !== name || journal.phase !== PHASE.DONE) continue;
    if (transactionIdToDate(name) === null) continue;
    doneIds.push(name);
  }
  // transaction_id is a sortable UTC timestamp string (newTransactionId's
  // own format), so lexicographic order IS chronological order.
  doneIds.sort();
  doneIds.reverse();

  const retentionMs = config.retention_days * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const removed = [];
  for (const name of doneIds.slice(config.keep_generations)) {
    const age = now - transactionIdToDate(name).getTime();
    if (age < retentionMs) continue;
    rmSync(join(backupRoot, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

const VALUE_FLAGS = new Set(["--config", "--repo", "--target", "--transaction"]);
const BOOL_FLAGS = new Map([
  ["--dry-run", "dryRun"],
  ["--maintenance-approved", "maintenanceApproved"],
  ["--confirm-restore", "confirmRestore"],
  ["--initialize", "initialize"],
]);

/** Parses `<command> [flags...]`. A value flag whose value itself starts
 *  with `-` is rejected — the same reasoning as
 *  kaoiro-runner-common.sh's kaoiro_reject_option_like: a missing value
 *  must never silently consume the next flag as its own argument. */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command) fail("usage: kaoiro-server-deploy <command> [flags...]", 64);
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (VALUE_FLAGS.has(arg)) {
      const value = rest[++i];
      if (value === undefined || value.startsWith("-")) {
        fail(`${arg} needs a value`, 64);
      }
      flags[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      continue;
    }
    if (BOOL_FLAGS.has(arg)) {
      flags[BOOL_FLAGS.get(arg)] = true;
      continue;
    }
    fail(`unknown argument: ${arg}`, 64);
  }
  return { command, flags };
}

/** Whether this repo's target/build has been through this CLI before —
 *  a coarse stand-in for "does prior deploy state exist", checked by
 *  listing prior transaction directories under `backupRoot`. This is
 *  deliberately NOT a volume inspection: resolving the compose project's
 *  actual volume name belongs with the archive/migration work in the
 *  update commit, which already has to resolve it from the container
 *  mount (deployment.md 4.3 step 5-a) — duplicating that resolution here
 *  ahead of time would just be a second, unsynchronised way to compute
 *  the same fact. This narrower question is enough to keep `start`
 *  from overwriting existing CLI-managed state. */
export function hasPriorTransactions(backupRoot) {
  try {
    return readdirSync(backupRoot).length > 0;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

function resolveBackupRoot(config) {
  if (config.backup_root !== null) {
    // Defense in depth alongside kaoiro-deploy-config.mjs's own VALIDATORS
    // check (クロエ round 1 review SF-6): a config object built
    // programmatically (not through loadConfig) never passes through that
    // validator at all, so this must not be the only place that rejects a
    // relative path before anything mutates.
    if (!isAbsolute(config.backup_root)) {
      fail(`backup_root must be an absolute path, got: ${config.backup_root}`);
    }
    return config.backup_root;
  }
  if (!process.env.HOME) fail("HOME is unset; pass backup_root explicitly via --config");
  return join(process.env.HOME, "kaoiro-deploy");
}

/** `build`: prepares a versioned server image with no downtime — the
 *  no-downtime half of deployment.md 4.3 (1)/(2). Advances the repo
 *  checkout at `--repo` to `--target` (fast-forward only), computes
 *  build identity from the result, and passes the four KAOIRO_BUILD_*
 *  values into `docker compose build`'s child environment directly
 *  (no shell `set -a && eval` — issue #306's own requirement, and the
 *  exact footgun deployment.md 4.3 (2) documents under "Do not forget
 *  set -a"). Returns the plan/result object; does not touch the running
 *  container or write any manifest — the transaction record is the
 *  update command's job (later commit), since `build` alone has no
 *  transaction to record one against. */
export function runBuild(flags, config) {
  const repo = flags.repo ?? process.cwd();
  if (!flags.target || !SHA_RE.test(flags.target)) {
    fail("--target <full 40-hex SHA> is required for build", 64);
  }
  const target = flags.target;
  const dryRun = flags.dryRun === true;
  const { bin, overridden } = resolveDockerBin(config);
  const serverDir = join(repo, "server");

  const status = gitOutput(["status", "--porcelain"], repo);
  if (status !== "") {
    fail(`repo at ${repo} is dirty; refuse to build a moving target from a dirty tree`);
  }

  if (dryRun) {
    return {
      command: "build",
      dryRun: true,
      docker: overridden ? "fake" : "docker",
      repo,
      target,
      wouldRun: [`git fetch origin`, `git merge --ff-only ${target}`, `docker compose build`],
    };
  }

  gitOutput(["fetch", "origin"], repo);
  gitOutput(["merge", "--ff-only", target], repo);

  const identity = computeBuildIdentity(repo);
  if (identity.revision !== target) {
    fail(
      `build identity revision ${identity.revision} does not match target ${target} after merge --ff-only`,
    );
  }
  if (identity.dirty) {
    fail(`repo at ${repo} is dirty at ${identity.revision} after merge --ff-only; refusing to build`);
  }

  runDocker(bin, ["compose", "build"], {
    cwd: serverDir,
    env: {
      ...process.env,
      KAOIRO_BUILD_REVISION: identity.revision,
      KAOIRO_BUILD_DIRTY: String(identity.dirty),
      KAOIRO_BUILD_VERSION: identity.version,
      KAOIRO_BUILD_CHANNEL: identity.channel,
    },
    stdio: "inherit",
  });

  const versionedTag = `kaoiro-server:${target}`;
  runDocker(bin, ["tag", "kaoiro-server:latest", versionedTag], { cwd: serverDir });
  const imageId = dockerInspect(bin, versionedTag, "{{.Id}}");

  return {
    command: "build",
    dryRun: false,
    docker: overridden ? "fake" : "docker",
    repo,
    target,
    identity,
    imageId,
    imageTag: versionedTag,
  };
}

/** `start`: the ONLY way to bring the compose service up when it is not
 *  already running, classified through the #303/#306 branch table before
 *  touching anything.
 *
 *  Branch A (one stopped container): starts it directly — a plain
 *  `docker start`, not `compose up`, because `up` can pick up a `latest`
 *  tag that has moved since this container was created (the exact trap
 *  deployment.md's troubleshooting section warns about).
 *  Branch B (no container, but this CLI has prior transaction state):
 *  refuses — recovering from existing state is `update`/`rollback`'s
 *  job, not a fresh bootstrap.
 *  Branch C (nothing at all): only proceeds with the explicit
 *  `--initialize` flag, matching issue #306's "bootstrap only via
 *  explicit start --initialize".
 *  Branch D (anything else — multiple containers, wrong status):
 *  refuses and reports the reason; a human decides. */
export function runStart(flags, config) {
  const repo = flags.repo ?? process.cwd();
  const serverDir = join(repo, "server");
  const { bin, overridden } = resolveDockerBin(config);
  const dryRun = flags.dryRun === true;
  const backupRoot = resolveBackupRoot(config);
  const hasState = hasPriorTransactions(backupRoot);

  const result = classify(bin, serverDir, SERVICE, hasState);

  if (result.branch === BRANCH.STOPPED_CONTAINER) {
    if (dryRun) {
      return { command: "start", dryRun: true, docker: overridden ? "fake" : "docker", ...result };
    }
    runDocker(bin, ["start", result.container], { stdio: "inherit" });
    return { command: "start", dryRun: false, docker: overridden ? "fake" : "docker", ...result };
  }

  if (result.branch === BRANCH.STATE_WITHOUT_CONTAINER) {
    fail(
      `${result.reason}; use update/rollback to recover from existing state, not start`,
    );
  }

  if (result.branch === BRANCH.DIAGNOSE) {
    fail(`start refuses: ${result.reason}`);
  }

  // BRANCH.FRESH from here on.
  if (flags.initialize !== true) {
    fail("start --initialize is required to bootstrap a fresh deployment (no prior state found)", 64);
  }

  if (dryRun) {
    return {
      command: "start",
      dryRun: true,
      docker: overridden ? "fake" : "docker",
      ...result,
      wouldRun: ["docker compose up -d --build"],
    };
  }

  const identity = computeBuildIdentity(repo);
  runDocker(bin, ["compose", "up", "-d", "--build"], {
    cwd: serverDir,
    env: {
      ...process.env,
      KAOIRO_BUILD_REVISION: identity.revision,
      KAOIRO_BUILD_DIRTY: String(identity.dirty),
      KAOIRO_BUILD_VERSION: identity.version,
      KAOIRO_BUILD_CHANNEL: identity.channel,
    },
    stdio: "inherit",
  });

  return { command: "start", dryRun: false, docker: overridden ? "fake" : "docker", ...result, identity };
}

// クロエ round 1 review MF-3: `--transaction` resume re-verifies the
// container is RUNNING (requireRunningContainer) before doing anything
// else, then unconditionally re-advances to MAINTENANCE_GATE_PASSED — a
// transaction that reached STOPPING or later can never satisfy the
// running-container check, and even UP/HEALTHY (where a container IS
// running again) would hit that same re-advance, which is not a listed
// transition from any of these phases and raises a raw PhaseError
// instead of a diagnosable DeployError. None of the commit half has
// resume support yet ((c3) does not add any); telling the operator to
// "resume it with --transaction" for one of these phases sends them into
// a guaranteed second failure instead of the manual runbook that
// actually recovers. DONE is already filtered out by
// findUnfinishedTransaction's own TERMINAL_PHASES check before this is
// ever consulted — included anyway so this set stays complete on its own
// if that ever changes.
const UNRESUMABLE_PHASES = new Set([
  PHASE.STOPPING,
  PHASE.STOPPED,
  PHASE.MOUNT_RESOLVED,
  PHASE.ARCHIVED,
  PHASE.UP,
  PHASE.HEALTHY,
  PHASE.DONE,
]);

/** `update`: lock, preflight, save the old image, build the versioned
 *  target, the human maintenance gate, then the stop/archive commit
 *  itself. Everything up to the gate touches nothing but the checkout
 *  and a versioned image tag — the running container is never stopped —
 *  matching deployment.md 4.3's "separate prepare (no downtime) from
 *  commit (the stop window)". `up --no-build`/health-poll/retention are
 *  a later commit; this function currently ends at ARCHIVED.
 *
 *  `--dry-run` (クロエ round 1 review MF-1) performs only reads — the
 *  same `compose ps`/`inspect` requireRunningContainer already needs,
 *  plus `git fetch origin` to report whether the target is even
 *  reachable — and returns a plan. It never acquires the deploy lock,
 *  creates a transaction directory, or resumes one via `--transaction`
 *  (an unrelated feature this commit does not attempt to give a
 *  meaningful non-mutating definition to).
 *
 *  `--transaction <id>` resumes a transaction that reached the
 *  maintenance gate but has not been approved yet: it re-verifies the
 *  container is still running, refuses if `--target` no longer matches
 *  what was already built, and re-checks the gate — it does NOT redo
 *  the old-image-save or build steps, both of which already happened
 *  and are read back from the journal's history instead.
 *
 *  CHECKPOINT-BEFORE-MUTATION (S1 item ii, yuta ruling 2026-09-06):
 *  every fact this function learns is written durably via advancePhase()
 *  — which itself calls writeJournal()'s writeFileDurably() (M3) —
 *  BEFORE the next step runs, so the COMMIT half's real Docker mutations
 *  always find every fact they need already checkpointed, never an
 *  in-memory variable that skipped the journal. */
export function runUpdate(flags, config) {
  const repo = flags.repo ?? process.cwd();
  if (!flags.target || !SHA_RE.test(flags.target)) {
    fail("--target <full 40-hex SHA> is required for update", 64);
  }
  const target = flags.target;
  const serverDir = join(repo, "server");
  const { bin, overridden } = resolveDockerBin(config);
  const backupRoot = resolveBackupRoot(config);
  const dryRun = flags.dryRun === true;

  if (dryRun) {
    if (flags.transaction !== undefined) {
      fail("--dry-run does not support --transaction", 64);
    }
    const container = requireRunningContainer(bin, serverDir, SERVICE);
    const unfinished = findUnfinishedTransaction(backupRoot);
    gitOutput(["fetch", "origin"], repo);
    return {
      command: "update",
      dryRun: true,
      docker: overridden ? "fake" : "docker",
      container,
      target,
      unfinishedTransactionId: unfinished === null ? null : unfinished.id,
      wouldRun:
        unfinished !== null
          ? [`resume transaction ${unfinished.id} (phase: ${unfinished.journal.phase})`]
          : [
              `git merge --ff-only ${target}`,
              "docker compose build",
              "docker tag <old_image_id> kaoiro-server:rollback-<old-sha>",
              "wait for --maintenance-approved",
              "docker compose stop -t 30",
              "archive /var/lib/kaoiro",
            ],
    };
  }

  const lockPath = acquireLock(backupRoot);
  try {
    const unfinished = findUnfinishedTransaction(backupRoot);
    let transactionId;
    let dir;
    let journal;
    let oldImageId;
    let oldSha;
    let rollbackTag;
    let buildResult;
    let container;
    let composeArtifact;

    if (flags.transaction !== undefined) {
      if (unfinished === null || unfinished.id !== flags.transaction) {
        fail(
          `--transaction ${flags.transaction} is not an in-progress transaction; run 'status' to see what exists`,
        );
      }
      ({ id: transactionId, dir, journal } = unfinished);
      const oldEntry = journal.history.find((e) => e.phase === PHASE.OLD_IMAGE_SAVED);
      const buildEntry = journal.history.find((e) => e.phase === PHASE.BUILD_PREPARED);
      if (oldEntry === undefined || buildEntry === undefined) {
        fail(
          `transaction ${transactionId} has not completed prepare (phase: ${journal.phase}); rerun update with --transaction ${transactionId} and no --maintenance-approved to retry prepare`,
        );
      }
      if (buildEntry.observation.target_sha !== target) {
        fail(
          `--target ${target} does not match transaction ${transactionId}'s prepared target ${buildEntry.observation.target_sha}`,
        );
      }
      oldImageId = oldEntry.observation.old_image_id;
      oldSha = oldEntry.observation.old_sha;
      rollbackTag = oldEntry.observation.rollback_tag;
      composeArtifact = oldEntry.observation.compose_artifact;
      buildResult = {
        imageId: buildEntry.observation.image_id,
        imageTag: buildEntry.observation.image_tag,
        target,
      };
      // Re-verify: prepare ran against a running container, and resume
      // may happen an arbitrary time later — nothing here should trust
      // that it still is.
      container = requireRunningContainer(bin, serverDir, SERVICE);
    } else {
      if (unfinished !== null) {
        fail(
          UNRESUMABLE_PHASES.has(unfinished.journal.phase)
            ? `transaction ${unfinished.id} is unfinished (phase: ${unfinished.journal.phase}); the commit half has no resume support yet ((c3)) — follow docs/specs/deployment.md 4.4 to recover manually, or investigate ${unfinished.dir}`
            : `transaction ${unfinished.id} is unfinished (phase: ${unfinished.journal.phase}); resume it with --transaction ${unfinished.id}, or investigate ${unfinished.dir} before starting a new one`,
        );
      }

      container = requireRunningContainer(bin, serverDir, SERVICE);

      transactionId = newTransactionId();
      dir = join(backupRoot, transactionId);
      // クロエ round 1 review N-2: backupRoot itself may not exist yet on
      // a first-ever transaction (recursive create is fine — there is
      // nothing under it to collide with), but the transaction's OWN
      // leaf directory must fail loudly on a same-second collision
      // rather than silently reusing whatever is already there.
      mkdirSync(backupRoot, { recursive: true });
      mkdirSync(dir, { recursive: false });
      journal = {
        schema_version: 1,
        transaction_id: transactionId,
        phase: PHASE.PREFLIGHT,
        history: [{ phase: PHASE.PREFLIGHT, at: new Date().toISOString(), observation: { container } }],
      };
      writeJournal(dir, journal, validateJournalAgainstStateMachine);

      oldImageId = dockerInspect(bin, container, "{{.Image}}");
      oldSha = gitOutput(["rev-parse", "HEAD"], repo);
      const composeArtifactPath = join(serverDir, "docker-compose.yaml");
      composeArtifact = { path: composeArtifactPath, sha256: sha256File(composeArtifactPath) };

      // クロエ round 1 review MF-2: retagged from the RUNNING container's
      // own image id, never from `latest` — `compose build` below is
      // about to repoint `latest` at the new image, so retagging from
      // `latest` after that point would make the rollback tag point at
      // the very image it is supposed to be an escape hatch FROM
      // (deployment.md 4.3 (1)). Verified via a real `docker inspect`
      // read-back, not merely assumed from the `docker tag` exit code.
      rollbackTag = `kaoiro-server:rollback-${oldSha}`;
      runDocker(bin, ["tag", oldImageId, rollbackTag]);
      const rollbackTagId = dockerInspect(bin, rollbackTag, "{{.Id}}");
      if (rollbackTagId !== oldImageId) {
        fail(
          `rollback tag ${rollbackTag} points at ${rollbackTagId}, not the old image ${oldImageId} — refusing to proceed with an unverifiable rollback target`,
        );
      }

      journal = advancePhase(
        dir,
        journal,
        PHASE.OLD_IMAGE_SAVED,
        { old_image_id: oldImageId, old_sha: oldSha, compose_artifact: composeArtifact, rollback_tag: rollbackTag },
        validateJournalAgainstStateMachine,
      );

      buildResult = runBuild({ repo, target }, config);
      journal = advancePhase(
        dir,
        journal,
        PHASE.BUILD_PREPARED,
        {
          image_id: buildResult.imageId,
          image_tag: buildResult.imageTag,
          target_sha: target,
        },
        validateJournalAgainstStateMachine,
      );
    }

    if (flags.maintenanceApproved !== true) {
      fail(
        `update requires --maintenance-approved before the stop window opens (no-downtime steps are complete); resume with --transaction ${transactionId} --target ${target} --maintenance-approved once the operator has approved the maintenance window`,
        64,
      );
    }
    journal = advancePhase(dir, journal, PHASE.MAINTENANCE_GATE_PASSED, {}, validateJournalAgainstStateMachine);

    // クロエ round 1 review N-5: pulled here, before the stop window
    // opens — not implicitly by the first `docker run alpine ...` the
    // archive step happens to make after the server is already down,
    // which would both extend the outage by however long the pull takes
    // and risk a SECOND pull mid-archive if the first `docker run`
    // somehow did not warm the local cache.
    ensureAlpineImage(bin);

    // クロエ round 1 review SF-2: a checkpoint written immediately
    // before `compose stop` runs, so a crash between this line and the
    // STOPPED checkpoint below leaves the journal AT this phase —
    // distinguishable from "the gate passed but stop was never
    // attempted" (a crash before this line would still show
    // MAINTENANCE_GATE_PASSED).
    journal = advancePhase(dir, journal, PHASE.STOPPING, {}, validateJournalAgainstStateMachine);

    // --- commit: from here on the service is stopped. Everything above
    // this line is documented as no-downtime in runUpdate's own doc
    // comment; nothing below it may run before the checkpoint above it
    // completed (S1 item ii).
    runDocker(bin, ["compose", "stop", "-t", "30"], { cwd: serverDir, stdio: "inherit" });

    const stopExitCode = parseDockerIntField(dockerInspect(bin, container, "{{.State.ExitCode}}"));
    const stopOomKilled = parseDockerBoolField(dockerInspect(bin, container, "{{.State.OOMKilled}}"));
    journal = advancePhase(
      dir,
      journal,
      PHASE.STOPPED,
      { stop_exit_code: stopExitCode, stop_oom_killed: stopOomKilled },
      validateJournalAgainstStateMachine,
    );

    // "measured, not assumed" (deployment.md 4.3 step 5) — an unset
    // expectation, a mismatch, or an unparsed docker field are ALL
    // abnormal. `null` from either side never matches `null` on the
    // other by design: an unmeasured expectation must never coincide
    // with an unreadable observation and be treated as agreement.
    const cleanStop =
      config.expected_clean_stop_exit_code !== null &&
      config.expected_clean_stop_oom_killed !== null &&
      stopExitCode === config.expected_clean_stop_exit_code &&
      stopOomKilled === config.expected_clean_stop_oom_killed;
    if (!cleanStop) {
      // クロエ round 1 review N-1: names the exact runbook essentials
      // (deployment.md 4.3 step 5) an operator investigating an abnormal
      // stop needs immediately — recover the container with `docker
      // start`, never `docker compose up`, while `latest` still points
      // at the new (not-yet-live) image built earlier in this run.
      fail(
        `stop was not clean (exit=${stopExitCode}, oom=${stopOomKilled}; expected exit=${config.expected_clean_stop_exit_code}, expected oom=${config.expected_clean_stop_oom_killed}) — the server is stopped but archiving/restarting requires manual recovery (deployment.md 4.3 step 5): use 'docker start ${container}' to recover the OLD container, never 'docker compose up' while latest points at the new image; investigate before retrying`,
      );
    }

    // Re-resolve the mount from the NOW-STOPPED container — the same
    // container prepare already verified was running, not a fresh
    // lookup that could pick up a different one.
    const volumeId = dockerInspect(
      bin,
      container,
      '{{range .Mounts}}{{if eq .Destination "/var/lib/kaoiro"}}{{.Name}}{{end}}{{end}}',
    );
    // Measured redundant with the MOUNT_RESOLVED observation schema
    // below (advancePhase() now runs validateJournalAgainstStateMachine
    // too) — removing this check still stops the run, via a PhaseError
    // instead of this DeployError. Kept anyway for the diagnostic: "the
    // mount layout changed" names the actual docker-side cause, where
    // the schema error only says an observation looked wrong.
    if (volumeId === "") {
      fail(
        `could not resolve the /var/lib/kaoiro mount for container ${container} — empty output means the mount layout changed; archiving the wrong (or no) volume would be worse than stopping here`,
      );
    }
    journal = advancePhase(
      dir,
      journal,
      PHASE.MOUNT_RESOLVED,
      { volume_id: volumeId },
      validateJournalAgainstStateMachine,
    );

    // --- archive: full traversal + checksum + required entries +
    // ownership, all from the SAME resolved volume, before this
    // transaction may call itself rollback-capable. listVolumeEntries is
    // a PRE-archive guard only (fail before spending time archiving
    // nothing) — the required_entries actually RECORDED come from the
    // archive's own verification listing below (SF-5), so nothing can
    // claim a required entry the archive does not actually contain.
    if (listVolumeEntries(bin, volumeId).length === 0) {
      fail(
        `resolved volume ${volumeId} contains no files — archiving an empty volume would not be a usable backup`,
      );
    }

    const archivePath = join(dir, "archive.tar.gz");
    runDocker(bin, [
      "run",
      "--rm",
      "-v",
      `${volumeId}:/data:ro`,
      "-v",
      `${dir}:/backup`,
      ALPINE_IMAGE,
      "tar",
      "czf",
      "/backup/archive.tar.gz",
      "-C",
      "/data",
      ".",
    ]);
    // クロエ round 1 review SF-5: `tar tvzf` (verbose), not `tar tzf`
    // (names only) — the full traversal this already needed (not `| head`,
    // whose exit status would come from the tail command and mask a
    // corrupt archive — deployment.md 4.3 step 5-c) now ALSO produces
    // the required_entries this transaction records, so the recorded set
    // is provably what the archive contains, not a separately-scanned
    // guess that could disagree with it.
    let requiredEntries;
    try {
      requiredEntries = parseTarTvzfEntries(archivePath);
    } catch (err) {
      fail(`archive verification failed (tar tvzf ${archivePath}): ${err.message}`);
    }
    if (requiredEntries.length === 0) {
      fail(
        `archive at ${archivePath} contains no entries — archiving an empty volume would not be a usable backup`,
      );
    }
    const archive = { path: archivePath, sha256: sha256File(archivePath) };

    journal = advancePhase(
      dir,
      journal,
      PHASE.ARCHIVED,
      { archive, required_entries: requiredEntries },
      validateJournalAgainstStateMachine,
    );

    // Written exactly once, here — the first point every fact it needs
    // (S1's contract) is fully determined. Earlier phases hold the same
    // facts in the journal's history in the meantime (S1 item i).
    writeManifest(dir, {
      schema_version: 1,
      transaction_id: transactionId,
      compose_artifact: composeArtifact,
      // Key set + values are #220 absorption's job (a later commit) —
      // see the #306 check-in on why no runtime-queryable source exists
      // yet for the comparison this is meant to record.
      env_consistency: {},
      image_id: buildResult.imageId,
      source_sha: oldSha,
      target_sha: target,
      volume_id: volumeId,
      archive,
      required_entries: requiredEntries,
    });

    // (c3): bring the prepared image up, verify it is actually the target
    // (not merely "a container exists"), and confirm it survives long
    // enough to call this update done — deployment.md 4.3 step 6 / 4.5's
    // own "operational success" + "provenance" checks.
    runDocker(bin, ["compose", "up", "-d", "--no-build"], { cwd: serverDir, stdio: "inherit" });
    journal = advancePhase(dir, journal, PHASE.UP, {}, validateJournalAgainstStateMachine);

    const curlBin = resolveCurlBin();
    const health = pollHealth(
      curlBin,
      config.health_url,
      target,
      config.health_poll_interval_ms,
      config.health_poll_timeout_ms,
    );
    journal = advancePhase(
      dir,
      journal,
      PHASE.HEALTHY,
      { health_revision: health.build_revision, health_dirty: health.build_dirty },
      validateJournalAgainstStateMachine,
    );

    // "Container is stable" (deployment.md 4.5): no crash-restart over the
    // stability window, still `running` at the end of it. RestartCount is
    // docker's own counter for restart_policy-triggered restarts (server/
    // docker-compose.yaml: `restart: unless-stopped`) — a container stuck
    // crash-looping could transiently read "running" at the exact instant
    // checked, so the restart count (not just the final status) is what
    // actually rules that out.
    const restartsAtHealthy = restartCount(bin, container);
    sleepMs(config.stability_window_ms);
    const statusAfterWindow = dockerInspect(bin, container, "{{.State.Status}}");
    const restartsAfterWindow = restartCount(bin, container);
    if (statusAfterWindow !== "running" || restartsAfterWindow !== restartsAtHealthy) {
      fail(
        `container ${container} was not stable for ${config.stability_window_ms}ms after becoming healthy (status=${statusAfterWindow}, restarts ${restartsAtHealthy} -> ${restartsAfterWindow}) — the update reached HEALTHY but did not survive to be called done; investigate before retrying`,
      );
    }
    journal = advancePhase(dir, journal, PHASE.DONE, {}, validateJournalAgainstStateMachine);

    // Retention (issue #306 (c3), config.keep_generations/retention_days):
    // best-effort, never fails an otherwise-successful update — a stale
    // backup nobody could delete is a cleanup problem to report, not a
    // reason to call a deploy that just reached DONE a failure.
    let prunedTransactions = [];
    let pruneError = null;
    try {
      prunedTransactions = pruneOldTransactions(backupRoot, config);
    } catch (err) {
      pruneError = err.message;
    }

    return {
      command: "update",
      phase: "done",
      transactionId,
      docker: overridden ? "fake" : "docker",
      oldImageId,
      oldSha,
      rollbackTag,
      build: buildResult,
      container,
      stopExitCode,
      stopOomKilled,
      volumeId,
      archive,
      requiredEntries,
      health,
      prunedTransactions,
      pruneError,
    };
  } finally {
    releaseLock(lockPath);
  }
}

/** PRE-archive guard only (see the call site's comment): whether a
 *  volume has anything in it at all, via a throwaway alpine container.
 *  What gets RECORDED as required_entries comes from parseTarTvzfEntries
 *  instead (SF-5) — this function only answers "would archiving this be
 *  pointless".
 *
 *  クロエ round 1 review MF-4: `find -mindepth 1 -maxdepth 1`, not a bare
 *  `/data/*` glob. An empty directory leaves an unquoted glob unexpanded
 *  (`sh` passes the literal string `/data/*` through), so `[ -e "$f" ]`
 *  is false and — being the LAST command the loop ever runs — the whole
 *  script's own exit status is 1, not 0: `execFileSync` throws before
 *  `.length === 0` is ever reached, making the empty-volume guard
 *  unreachable in production regardless of what it checks. Measured live
 *  (`sh -c` against a real empty dir: exit 1) and against the real
 *  `alpine` image (`find`/`stat -c %04a` both present via busybox,
 *  exit 0 empty output on an empty dir). */
// Exported so the mutation-check test can run the EXACT same script text
// through a real `sh -c` against a real directory (MF-4 pin (a)) instead
// of a hand-copied duplicate that could silently drift from what
// production actually runs.
export const VOLUME_LISTING_SCRIPT =
  "find /data -mindepth 1 -maxdepth 1 -exec stat -c '%n %u:%g %04a' {} \\;";

function listVolumeEntries(bin, volumeId) {
  const output = runDocker(bin, [
    "run",
    "--rm",
    "-v",
    `${volumeId}:/data:ro`,
    ALPINE_IMAGE,
    "sh",
    "-c",
    VOLUME_LISTING_SCRIPT,
  ]);
  if (output === "") return [];
  return output.split("\n").map((line) => {
    const [rawPath, owner, mode] = line.split(" ");
    return { path: rawPath.replace(/^\/data\//, ""), owner, mode };
  });
}

/** Converts a `tar tv*` permission string (`drwxr-sr-x`, `-rw-------`,
 *  `-rwSr--r--`, …) to the 4-digit octal mode manifest entries use.
 *  Special bits overlay the execute position (lower-case with execute
 *  ALSO set, upper-case without) — measured against real GNU tar output
 *  for setuid/setgid/sticky combined with and without execute, not
 *  assumed from the format's name alone. */
function modeFromTarPermString(perm) {
  const bits = perm.slice(1);
  const [ur, uw, ux] = bits.slice(0, 3);
  const [gr, gw, gx] = bits.slice(3, 6);
  const [pr, pw, px] = bits.slice(6, 9);
  const owner = (ur === "r" ? 4 : 0) + (uw === "w" ? 2 : 0) + (ux === "x" || ux === "s" ? 1 : 0);
  const group = (gr === "r" ? 4 : 0) + (gw === "w" ? 2 : 0) + (gx === "x" || gx === "s" ? 1 : 0);
  const other = (pr === "r" ? 4 : 0) + (pw === "w" ? 2 : 0) + (px === "x" || px === "t" ? 1 : 0);
  const special =
    (ux === "s" || ux === "S" ? 4 : 0) +
    (gx === "s" || gx === "S" ? 2 : 0) +
    (px === "t" || px === "T" ? 1 : 0);
  return `${special}${owner}${group}${other}`;
}

// One line of `tar tv*f ... --numeric-owner`: permission string, then
// numeric uid/gid (guaranteed numeric only by --numeric-owner — without
// it, a uid tar's own metadata happens to recognise, uid 0 above all,
// prints as a name like "root" instead), size, date, time, and the rest
// of the line verbatim as the entry name (names may contain spaces —
// only ONE separating space is consumed before it, measured against a
// real archive containing a space-bearing filename).
const TAR_TVZF_LINE_RE = /^(\S+)\s+(\d+)\/(\d+)\s+\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s(.*)$/;

/** Derives required_entries from the archive's OWN verification listing
 *  (クロエ round 1 review SF-5) rather than a separately-scanned volume
 *  listing that could disagree with what actually got archived. Recurses
 *  into the whole archive (unlike the old top-level-only volume scan),
 *  which also closes that scan's dotfile gap for free — `tar -C /data .`
 *  always included them; the pre-archive scan just never reported them.
 *  The archive root entry itself (`./`) is not a required entry. */
function parseTarTvzfEntries(archivePath) {
  const output = execFileSync("tar", ["tvzf", archivePath, "--numeric-owner"], {
    encoding: "utf8",
  }).trim();
  if (output === "") return [];
  const entries = [];
  for (const line of output.split("\n")) {
    const match = TAR_TVZF_LINE_RE.exec(line);
    if (match === null) {
      fail(`could not parse tar tvzf output line: ${line}`);
    }
    const [, perm, uid, gid, rawName] = match;
    const name = rawName.replace(/^\.\//, "").replace(/\/$/, "");
    if (name === "") continue;
    entries.push({ path: name, owner: `${uid}:${gid}`, mode: modeFromTarPermString(perm) });
  }
  return entries;
}

async function main(argv) {
  const { command, flags } = parseArgs(argv);
  const config = loadConfig(flags.config);
  switch (command) {
    case "build":
      return runBuild(flags, config);
    case "start":
      return runStart(flags, config);
    case "update":
      return runUpdate(flags, config);
    default:
      fail(`unknown command: ${command} (build/start/update implemented so far; rollback/status land in later commits)`, 64);
  }
}

function isEntryPoint() {
  return process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
}

if (isEntryPoint()) {
  main(process.argv.slice(2))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((err) => {
      process.stderr.write(`kaoiro-server-deploy: ${err.message}\n`);
      process.exit(err instanceof DeployError ? err.exitCode : 1);
    });
}
