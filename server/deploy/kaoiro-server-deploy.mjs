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
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { computeBuildIdentity } from "../../scripts/build-identity.mjs";
import { BRANCH, classify, requireRunningContainer } from "./kaoiro-deploy-branch.mjs";
import { loadConfig } from "./kaoiro-deploy-config.mjs";
import { dockerInspect, resolveDockerBin, runDocker } from "./kaoiro-deploy-docker.mjs";
import { advancePhase, writeJournal } from "./kaoiro-deploy-journal.mjs";
import { PHASE } from "./kaoiro-deploy-phase.mjs";
import { acquireLock, releaseLock } from "./kaoiro-deploy-lock.mjs";
import { findUnfinishedTransaction, newTransactionId } from "./kaoiro-deploy-transaction.mjs";

// The compose service name in server/docker-compose.yaml. Resolved through
// `docker compose ps`, never guessed as `<dir>-<service>-1`, so this is the
// only place the service name itself needs to be named.
const SERVICE = "kaoiro";
const SHA_RE = /^[0-9a-f]{40}$/;

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
  if (config.backup_root !== null) return config.backup_root;
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

/** `update` — PREPARE half only (this commit): lock, preflight, save the
 *  old image, build the versioned target, and the human maintenance
 *  gate. Every step up to the gate touches nothing but the checkout and
 *  a versioned image tag — the running container is never stopped —
 *  matching deployment.md 4.3's "separate prepare (no downtime) from
 *  commit (the stop window)". The COMMIT half (graceful stop, archive,
 *  `up --no-build`, health poll, retention) is a later commit; this
 *  function's return value is the interface boundary between the two.
 *
 *  `--transaction <id>` resumes a transaction that reached the
 *  maintenance gate but has not been approved yet: it re-verifies the
 *  container is still running, refuses if `--target` no longer matches
 *  what was already built, and re-checks the gate — it does NOT redo
 *  the old-image-save or build steps, both of which already happened
 *  and are read back from the journal's history instead.
 *
 *  CHECKPOINT-BEFORE-MUTATION (S1 item ii, yuta ruling 2026-09-06):
 *  every fact this function learns (old image id, old sha,
 *  compose_artifact, new image id/tag) is written durably via
 *  advancePhase() — which itself calls writeJournal()'s
 *  writeFileDurably() (M3) — BEFORE the next step runs. This commit's
 *  own steps only read docker state or build a new (not-yet-live) image
 *  tag, so none of them mutate the running deployment; the ordering
 *  still matters because the COMMIT half (a later commit: stop,
 *  archive, `up --no-build`) is exactly where a real Docker mutation
 *  happens, and it must find every fact it needs already checkpointed —
 *  never derive a fact from an in-memory variable that skipped the
 *  journal. */
export function runUpdate(flags, config) {
  const repo = flags.repo ?? process.cwd();
  if (!flags.target || !SHA_RE.test(flags.target)) {
    fail("--target <full 40-hex SHA> is required for update", 64);
  }
  const target = flags.target;
  const serverDir = join(repo, "server");
  const { bin, overridden } = resolveDockerBin(config);
  const backupRoot = resolveBackupRoot(config);

  const lockPath = acquireLock(backupRoot);
  try {
    const unfinished = findUnfinishedTransaction(backupRoot);
    let transactionId;
    let dir;
    let journal;
    let oldImageId;
    let oldSha;
    let buildResult;

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
      buildResult = {
        imageId: buildEntry.observation.image_id,
        imageTag: buildEntry.observation.image_tag,
        target,
      };
      // Re-verify: prepare ran against a running container, and resume
      // may happen an arbitrary time later — nothing here should trust
      // that it still is.
      requireRunningContainer(bin, serverDir, SERVICE);
    } else {
      if (unfinished !== null) {
        fail(
          `transaction ${unfinished.id} is unfinished (phase: ${unfinished.journal.phase}); resume it with --transaction ${unfinished.id}, or investigate ${unfinished.dir} before starting a new one`,
        );
      }

      const container = requireRunningContainer(bin, serverDir, SERVICE);

      transactionId = newTransactionId();
      dir = join(backupRoot, transactionId);
      mkdirSync(dir, { recursive: true });
      journal = {
        schema_version: 1,
        transaction_id: transactionId,
        phase: PHASE.PREFLIGHT,
        history: [{ phase: PHASE.PREFLIGHT, at: new Date().toISOString(), observation: { container } }],
      };
      writeJournal(dir, journal);

      oldImageId = dockerInspect(bin, container, "{{.Image}}");
      oldSha = gitOutput(["rev-parse", "HEAD"], repo);
      const composeArtifactPath = join(serverDir, "docker-compose.yaml");
      journal = advancePhase(dir, journal, PHASE.OLD_IMAGE_SAVED, {
        old_image_id: oldImageId,
        old_sha: oldSha,
        compose_artifact: { path: composeArtifactPath, sha256: sha256File(composeArtifactPath) },
      });

      buildResult = runBuild({ repo, target }, config);
      journal = advancePhase(dir, journal, PHASE.BUILD_PREPARED, {
        image_id: buildResult.imageId,
        image_tag: buildResult.imageTag,
        target_sha: target,
      });
    }

    if (flags.maintenanceApproved !== true) {
      fail(
        `update requires --maintenance-approved before the stop window opens (no-downtime steps are complete); resume with --transaction ${transactionId} --target ${target} --maintenance-approved once the operator has approved the maintenance window`,
        64,
      );
    }
    journal = advancePhase(dir, journal, PHASE.MAINTENANCE_GATE_PASSED);

    return {
      command: "update",
      phase: "prepare_complete",
      transactionId,
      docker: overridden ? "fake" : "docker",
      oldImageId,
      oldSha,
      build: buildResult,
    };
  } finally {
    releaseLock(lockPath);
  }
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
