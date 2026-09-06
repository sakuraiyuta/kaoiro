import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { writeJournal } from "../kaoiro-deploy-journal.mjs";
import { findUnfinishedTransaction, newTransactionId } from "../kaoiro-deploy-transaction.mjs";

function journal(phase) {
  return {
    schema_version: 1,
    transaction_id: "t",
    phase,
    history: [{ phase, at: "2026-09-06T10:15:00.000Z", observation: {} }],
  };
}

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kaoiro-deploy-transaction-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("findUnfinishedTransaction returns null when backupRoot does not exist", () => {
  assert.equal(findUnfinishedTransaction(join(dir, "missing")), null);
});

test("findUnfinishedTransaction returns null when every transaction is terminal", () => {
  const t1 = join(dir, "t1");
  mkdirSync(t1, { recursive: true });
  writeJournal(t1, journal("done"));
  const t2 = join(dir, "t2");
  mkdirSync(t2, { recursive: true });
  writeJournal(t2, journal("rolled_back"));
  assert.equal(findUnfinishedTransaction(dir), null);
});

test("findUnfinishedTransaction finds a non-terminal transaction", () => {
  const t1 = join(dir, "t1");
  mkdirSync(t1, { recursive: true });
  writeJournal(t1, journal("build_prepared"));
  const result = findUnfinishedTransaction(dir);
  assert.equal(result.id, "t1");
  assert.equal(result.journal.phase, "build_prepared");
});

test("findUnfinishedTransaction ignores hidden entries and non-journal directories", () => {
  mkdirSync(join(dir, ".lock.update"), { recursive: true });
  const notATransaction = join(dir, "not-a-transaction");
  mkdirSync(notATransaction, { recursive: true });
  writeFileSync(join(notATransaction, "manifest.json"), "not json");
  assert.equal(findUnfinishedTransaction(dir), null);
});

test("newTransactionId formats a UTC timestamp with no separators", () => {
  const id = newTransactionId(new Date("2026-09-06T10:15:00.123Z"));
  assert.equal(id, "20260906T101500Z");
});
