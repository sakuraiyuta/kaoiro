import assert from "node:assert/strict";
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { acquireLock, LockError, releaseLock } from "../kaoiro-deploy-lock.mjs";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kaoiro-deploy-lock-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("acquireLock creates the lock dir (named by the caller's key) and creates backupRoot if missing", () => {
  const backupRoot = join(dir, "kaoiro-deploy");
  const lockPath = acquireLock(backupRoot, "abc123");
  assert.equal(lockPath, join(backupRoot, ".lock.abc123"));
  assert.equal(existsSync(lockPath), true);
});

test("acquireLock throws LockError when already held under the same key", () => {
  const backupRoot = join(dir, "kaoiro-deploy");
  acquireLock(backupRoot, "abc123");
  assert.throws(() => acquireLock(backupRoot, "abc123"), LockError);
});

test("acquireLock does not collide across different keys (issue #322 M1: one lock per deployment, not one per backupRoot)", () => {
  const backupRoot = join(dir, "kaoiro-deploy");
  acquireLock(backupRoot, "deployment-a");
  assert.doesNotThrow(() => acquireLock(backupRoot, "deployment-b"));
});

test("releaseLock allows a subsequent acquireLock under the same key to succeed", () => {
  const backupRoot = join(dir, "kaoiro-deploy");
  const lockPath = acquireLock(backupRoot, "abc123");
  releaseLock(lockPath);
  assert.doesNotThrow(() => acquireLock(backupRoot, "abc123"));
});

test("acquireLock durably records a newly-created backup root in its parent", () => {
  const backupRoot = join(dir, "nested", "kaoiro-deploy");
  const synced = [];
  const fsImpl = {
    closeSync,
    fsyncSync,
    mkdirSync,
    openSync(path, flags) {
      synced.push(path);
      return openSync(path, flags);
    },
    rmdirSync,
  };

  const lockPath = acquireLock(backupRoot, "abc123", fsImpl);
  assert.equal(lockPath, join(backupRoot, ".lock.abc123"));
  assert.deepEqual(synced, [dir, join(dir, "nested"), backupRoot]);

  releaseLock(lockPath, fsImpl);
  synced.length = 0;
  acquireLock(backupRoot, "abc123", fsImpl);
  assert.equal(synced.length, 0, "an existing backup root needs no creation-entry fsync");
});
