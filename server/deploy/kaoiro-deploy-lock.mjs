#!/usr/bin/env node
// Exclusive lock for a deploy transaction directory (issue #306). `mkdir`
// is atomic, so it doubles as the lock — the same mechanism
// kaoiro-runner-common.sh's kaoiro_lock_acquire uses. A run that died
// without releasing it (SIGKILL) leaves the lock dir behind; the next
// run reports that rather than silently proceeding, so a stale lock is
// an operator decision, not something this file guesses about.
//
// issue #322 M1: the lock's NAME is a caller-supplied key, not a fixed
// "update" literal — every mutator (start/update/rollback) must land on
// the SAME lock for the SAME deployment, keyed by something that
// identifies the deployment itself (kaoiro-server-deploy.mjs derives it
// from the compose checkout's realpath, director ruling 2026-09-07
// option B: kept under backup_root rather than moving the lock file into
// the git checkout, which would break deployment.md 4.2's `git status
// --porcelain` clean-tree precondition). This module stays a generic
// mkdir-lock primitive; it does not know what a "deployment" is.
import { closeSync, fsyncSync, mkdirSync, openSync, rmdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { fsyncExistingPath } from "./kaoiro-deploy-atomic-write.mjs";

export class LockError extends Error {}

/** Acquires `<backupRoot>/.lock.<lockKey>`, creating `backupRoot` itself
 *  (recursively) first if this is the very first transaction. Throws
 *  LockError, naming the lock path, when another run already holds it. */
export function acquireLock(
  backupRoot,
  lockKey,
  fsImpl = { closeSync, fsyncSync, mkdirSync, openSync, rmdirSync },
) {
  const firstCreated = fsImpl.mkdirSync(backupRoot, { recursive: true });
  if (firstCreated !== undefined) {
    fsyncExistingPath(dirname(firstCreated), fsImpl);
    let created = firstCreated;
    for (const component of relative(firstCreated, backupRoot).split(sep).filter(Boolean)) {
      fsyncExistingPath(created, fsImpl);
      created = join(created, component);
    }
    fsyncExistingPath(backupRoot, fsImpl);
  }
  const lockPath = join(backupRoot, `.lock.${lockKey}`);
  try {
    fsImpl.mkdirSync(lockPath, { recursive: false });
  } catch (err) {
    if (err.code === "EEXIST") {
      throw new LockError(
        `another run holds ${lockPath} — wait for it, or remove a stale lock dir left by a killed run`,
      );
    }
    throw err;
  }
  return lockPath;
}

export function releaseLock(lockPath, fsImpl = { closeSync, fsyncSync, mkdirSync, openSync, rmdirSync }) {
  try {
    fsImpl.rmdirSync(lockPath);
  } catch {
    // Best-effort, matching kaoiro_lock_release: a lock dir that is
    // already gone or non-empty is not this call's problem to fix.
  }
}
