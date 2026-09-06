import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { writeJournal } from "../kaoiro-deploy-journal.mjs";
import {
  findUnfinishedTransaction,
  newTransactionId,
  TransactionError,
} from "../kaoiro-deploy-transaction.mjs";
import { PhaseError } from "../kaoiro-deploy-phase.mjs";

// `observation` matches the phase state machine's per-phase schema
// (kaoiro-deploy-phase.mjs) only for the phases this file actually
// exercises — findUnfinishedTransaction validates history against that
// machine for any non-terminal phase, so a fixture with an empty
// observation would fail validation before this test ever reaches its
// own assertion.
function journal(phase, transactionId) {
  const observation =
    phase === "build_prepared"
      ? { image_id: `sha256:${"b".repeat(64)}`, image_tag: "kaoiro-server:x", target_sha: "d".repeat(40) }
      : {};
  return {
    schema_version: 1,
    transaction_id: transactionId,
    phase,
    history: [{ phase, at: "2026-09-06T10:15:00.000Z", observation }],
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
  writeJournal(t1, journal("done", "t1"));
  const t2 = join(dir, "t2");
  mkdirSync(t2, { recursive: true });
  writeJournal(t2, journal("rolled_back", "t2"));
  assert.equal(findUnfinishedTransaction(dir), null);
});

test("findUnfinishedTransaction finds a non-terminal transaction", () => {
  const t1 = join(dir, "t1");
  mkdirSync(t1, { recursive: true });
  writeJournal(t1, journal("build_prepared", "t1"));
  const result = findUnfinishedTransaction(dir);
  assert.equal(result.id, "t1");
  assert.equal(result.journal.phase, "build_prepared");
});

test("findUnfinishedTransaction stops when the directory name disagrees with journal.transaction_id", () => {
  const t1 = join(dir, "t1");
  mkdirSync(t1, { recursive: true });
  writeJournal(t1, journal("build_prepared", "not-t1"));
  assert.throws(() => findUnfinishedTransaction(dir), TransactionError);
});

test("findUnfinishedTransaction stops on a state-machine violation (bad observation shape)", () => {
  const t1 = join(dir, "t1");
  mkdirSync(t1, { recursive: true });
  // build_prepared with an empty observation violates its own schema
  // (kaoiro-deploy-phase.mjs) — this journal is internally inconsistent,
  // not merely "not yet finished".
  writeJournal(t1, {
    schema_version: 1,
    transaction_id: "t1",
    phase: "build_prepared",
    history: [{ phase: "build_prepared", at: "2026-09-06T10:15:00.000Z", observation: {} }],
  });
  assert.throws(() => findUnfinishedTransaction(dir), PhaseError);
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
