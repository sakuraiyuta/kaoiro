#!/usr/bin/env node
// Deploy journal: the durable record of WHERE a deploy transaction is
// (issue #306). The manifest (kaoiro-deploy-manifest.mjs) records facts
// about artifacts; this records phase and per-phase observations — e.g.
// the clean-stop exit code actually seen — so `--transaction <id>` resume
// can tell "status/recovery" apart from "start a new transaction".
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileDurably } from "./kaoiro-deploy-atomic-write.mjs";

export class JournalError extends Error {}

function fail(message) {
  throw new JournalError(message);
}

/** `phase` is intentionally a free-form non-empty string here, not a
 *  fixed enum. The phase list belongs to the update/rollback state
 *  machine (a later commit); pinning it in this shape check now would
 *  mean editing this validator every time that machine grows a phase,
 *  the same enumeration-instead-of-boundary trap this file exists to
 *  avoid at the schema level. */
export function isValidJournalShape(value) {
  if (typeof value !== "object" || value === null) return false;
  if (value.schema_version !== 1) return false;
  if (typeof value.transaction_id !== "string" || value.transaction_id === "") {
    return false;
  }
  if (typeof value.phase !== "string" || value.phase === "") return false;
  if (!Array.isArray(value.history)) return false;
  for (const entry of value.history) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.phase !== "string" ||
      entry.phase === "" ||
      typeof entry.at !== "string" ||
      entry.at === "" ||
      // `observation` MUST be its own nested object, never spread onto
      // the entry (ふじ design review M2): a flat entry let a caller's
      // observation key named `phase` or `at` silently overwrite the
      // authoritative transition value advancePhase() just generated —
      // reproduced with `advancePhase(dir, j, "stopping", {phase:
      // "healthy"})` writing `history.at(-1).phase === "healthy"`
      // instead of "stopping". Nesting makes that a type error instead
      // of a silent overwrite, closing the whole key-collision class
      // rather than denylisting `phase`/`at` by name.
      typeof entry.observation !== "object" ||
      entry.observation === null ||
      Array.isArray(entry.observation)
    ) {
      return false;
    }
  }
  return true;
}

export function writeJournal(dir, journal) {
  if (!isValidJournalShape(journal)) {
    fail("refusing to write a journal that does not match the expected shape");
  }
  const target = join(dir, "journal.json");
  writeFileDurably(target, `${JSON.stringify(journal, null, 2)}\n`);
}

export function readJournal(dir) {
  const target = join(dir, "journal.json");
  let raw;
  try {
    raw = readFileSync(target, "utf8");
  } catch (err) {
    fail(`journal.json is unreadable at ${target}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`journal.json is not valid JSON at ${target}: ${err.message}`);
  }
  if (!isValidJournalShape(parsed)) {
    fail(`journal.json at ${target} does not match the expected shape`);
  }
  return parsed;
}

/** Appends one phase transition and writes atomically in the same call —
 *  callers must never hand-build a history entry and pass it to
 *  writeJournal directly, so there is exactly one place `phase`/`at` are
 *  generated. `observation` carries phase-specific measurements (e.g.
 *  `{ stop_exit_code, stop_oom_killed }` for a stop phase) NESTED under
 *  its own key — never spread onto the entry — so nothing an observation
 *  happens to name can collide with `phase` or `at` (see the shape
 *  check's own comment for the reproduced bug this replaced). */
export function advancePhase(dir, journal, phase, observation = {}) {
  const entry = { phase, at: new Date().toISOString(), observation };
  const next = {
    ...journal,
    phase,
    history: [...journal.history, entry],
  };
  writeJournal(dir, next);
  return next;
}
