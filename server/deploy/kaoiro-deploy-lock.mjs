#!/usr/bin/env node
// Exclusive lock for a deploy transaction directory (issue #306). `mkdir`
// is atomic, so it doubles as the lock — the same mechanism
// kaoiro-runner-common.sh's kaoiro_lock_acquire uses. A run that died
// without releasing it (SIGKILL) leaves the lock dir behind; the next
// run reports that rather than silently proceeding, so a stale lock is
// an operator decision, not something this file guesses about.
import { mkdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";

export class LockError extends Error {}

/** Acquires `<backupRoot>/.lock.update`, creating `backupRoot` itself
 *  (recursively) first if this is the very first transaction. Throws
 *  LockError, naming the lock path, when another run already holds it. */
export function acquireLock(backupRoot) {
  mkdirSync(backupRoot, { recursive: true });
  const lockPath = join(backupRoot, ".lock.update");
  try {
    mkdirSync(lockPath, { recursive: false });
  } catch (err) {
    if (err.code === "EEXIST") {
      throw new LockError(
        `another update run holds ${lockPath} — wait for it, or remove a stale lock dir left by a killed run`,
      );
    }
    throw err;
  }
  return lockPath;
}

export function releaseLock(lockPath) {
  try {
    rmdirSync(lockPath);
  } catch {
    // Best-effort, matching kaoiro_lock_release: a lock dir that is
    // already gone or non-empty is not this call's problem to fix.
  }
}
