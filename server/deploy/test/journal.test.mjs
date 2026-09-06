import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
  advancePhase,
  isValidJournalShape,
  JournalError,
  readJournal,
  writeJournal,
} from "../kaoiro-deploy-journal.mjs";

function validJournal() {
  return {
    schema_version: 1,
    transaction_id: "20260906T101500Z",
    phase: "prepare",
    history: [{ phase: "prepare", at: "2026-09-06T10:15:00.000Z", observation: {} }],
  };
}

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kaoiro-deploy-journal-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("isValidJournalShape accepts a well-formed journal", () => {
  assert.equal(isValidJournalShape(validJournal()), true);
});

test("isValidJournalShape rejects an empty phase", () => {
  const bad = validJournal();
  bad.phase = "";
  assert.equal(isValidJournalShape(bad), false);
});

test("isValidJournalShape rejects a history entry missing `at`", () => {
  const bad = validJournal();
  bad.history = [{ phase: "prepare" }];
  assert.equal(isValidJournalShape(bad), false);
});

test("isValidJournalShape rejects a non-array history", () => {
  const bad = validJournal();
  bad.history = "prepare";
  assert.equal(isValidJournalShape(bad), false);
});

test("writeJournal then readJournal round-trips", () => {
  const journal = validJournal();
  writeJournal(dir, journal);
  assert.deepEqual(readJournal(dir), journal);
});

test("writeJournal refuses a malformed journal", () => {
  const bad = validJournal();
  bad.transaction_id = "";
  assert.throws(() => writeJournal(dir, bad), JournalError);
});

test("readJournal throws when journal.json is absent", () => {
  assert.throws(() => readJournal(dir), JournalError);
});

test("readJournal throws on invalid JSON", () => {
  writeJournal(dir, validJournal());
  writeFileSync(join(dir, "journal.json"), "not json at all");
  assert.throws(() => readJournal(dir), JournalError);
});

test("advancePhase appends to history and moves the current phase", () => {
  const journal = validJournal();
  writeJournal(dir, journal);
  const next = advancePhase(dir, journal, "stopping", { stop_exit_code: null });
  assert.equal(next.phase, "stopping");
  assert.equal(next.history.length, 2);
  assert.equal(next.history[1].phase, "stopping");
  assert.equal(next.history[1].observation.stop_exit_code, null);
  assert.deepEqual(readJournal(dir), next);
  // The original object handed in must not be mutated in place — a
  // caller that still holds `journal` after calling advancePhase must
  // keep seeing the state it passed in, not the new one.
  assert.equal(journal.phase, "prepare");
  assert.equal(journal.history.length, 1);
});

test("writeJournal runs the validate callback and refuses to write when it throws", () => {
  const journal = validJournal();
  const boom = () => {
    throw new Error("boom");
  };
  assert.throws(() => writeJournal(dir, journal, boom), /boom/);
  assert.throws(() => readJournal(dir), JournalError);
});

test("advancePhase runs the validate callback and refuses to write the new phase when it throws", () => {
  const journal = validJournal();
  writeJournal(dir, journal);
  const boom = () => {
    throw new Error("boom");
  };
  assert.throws(() => advancePhase(dir, journal, "stopping", {}, boom), /boom/);
  // The file on disk must still reflect the last successful write, not
  // the rejected transition — a validate() failure must not leave a
  // half-applied phase change checkpointed.
  assert.deepEqual(readJournal(dir), journal);
});
