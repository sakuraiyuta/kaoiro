import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

test("acquireLock creates the lock dir and creates backupRoot if missing", () => {
  const backupRoot = join(dir, "kaoiro-deploy");
  const lockPath = acquireLock(backupRoot);
  assert.equal(lockPath, join(backupRoot, ".lock.update"));
  assert.equal(existsSync(lockPath), true);
});

test("acquireLock throws LockError when already held", () => {
  const backupRoot = join(dir, "kaoiro-deploy");
  acquireLock(backupRoot);
  assert.throws(() => acquireLock(backupRoot), LockError);
});

test("releaseLock allows a subsequent acquireLock to succeed", () => {
  const backupRoot = join(dir, "kaoiro-deploy");
  const lockPath = acquireLock(backupRoot);
  releaseLock(lockPath);
  assert.doesNotThrow(() => acquireLock(backupRoot));
});
