#!/usr/bin/env node
// Finds an in-progress deploy transaction under a backup root (issue
// #306). Shared by `update` and (later) `rollback`/`status`, so a
// transaction is discovered the same way regardless of which subcommand
// asks.
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { JournalError, readJournal } from "./kaoiro-deploy-journal.mjs";
import { validateJournalAgainstStateMachine } from "./kaoiro-deploy-phase.mjs";

export class TransactionError extends Error {}

const TERMINAL_PHASES = new Set(["done", "rolled_back"]);

/** Scans `backupRoot` for a transaction directory whose journal is NOT
 *  in a terminal phase — an update that started but never finished.
 *  A directory that does not read back as a valid journal is skipped
 *  rather than treated as a scan failure: it may be something this CLI
 *  does not own (a rollback backup, `.lock.update` itself), and this
 *  scan's only job is finding an in-progress transaction of THIS CLI's
 *  own making.
 *
 *  TWO things stop the scan outright instead of being skipped (yuta
 *  ruling 2026-09-06, S1 items iii/iv): a directory name disagreeing
 *  with its own journal's `transaction_id`, and a journal that fails
 *  the state-machine check (unknown phase, bad observation shape,
 *  illegal transition). Both mean this CLI's OWN prior write is
 *  internally inconsistent — silently skipping past it (as an unrelated
 *  file is skipped) would let an operator resume the wrong transaction
 *  or start a new one over corrupted state without ever being told. */
export function findUnfinishedTransaction(backupRoot) {
  let entries;
  try {
    entries = readdirSync(backupRoot, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = join(backupRoot, entry.name);
    let journal;
    try {
      journal = readJournal(dir);
    } catch (err) {
      if (err instanceof JournalError) continue;
      throw err;
    }
    if (journal.transaction_id !== entry.name) {
      throw new TransactionError(
        `transaction directory ${entry.name} contains a journal claiming transaction_id ${journal.transaction_id} — refusing to guess which is authoritative`,
      );
    }
    // TERMINAL_PHASES ("done"/"rolled_back") are checked BEFORE the
    // state-machine validation, not after: PHASE (kaoiro-deploy-phase.mjs)
    // only knows the phases THIS commit's prepare half reaches, so a
    // terminal phase from a later commit's rollback/commit half would
    // otherwise be misclassified as "unknown phase" and stop this scan
    // outright. A finished transaction is not this scan's concern
    // either way.
    if (TERMINAL_PHASES.has(journal.phase)) continue;
    validateJournalAgainstStateMachine(journal);
    return { id: entry.name, dir, journal };
  }
  return null;
}

/** A sortable, filesystem-safe transaction id: a UTC timestamp with no
 *  `:`/`-` separators (`20260906T101500Z`), matching the id shape used
 *  in this file's own tests and docs examples. */
export function newTransactionId(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d\d\dZ$/, "Z");
}
