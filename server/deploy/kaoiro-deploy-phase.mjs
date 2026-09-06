#!/usr/bin/env node
// Canonical phase list and transition table for `update` (issue #306,
// yuta ruling 2026-09-06, S1 items iii/iv). The generic journal schema
// (kaoiro-deploy-journal.mjs) deliberately keeps `phase` a free-form
// string — the phase LIST is a state-machine concern, not a storage-
// format one, and belongs here instead.
//
// PHASES ARE ADDED HERE AS COMMITS LAND, NOT ALL AT ONCE. This commit's
// `update` only reaches MAINTENANCE_GATE_PASSED — stop/archive/up/
// health/stable/done/rolled-back/failed arrive with later commits.
// Extending PHASE/TRANSITIONS/OBSERVATION_SCHEMAS then is expected, not
// a design smell; what this file exists to prevent is an UNLISTED phase
// or an UNLISTED transition passing silently, not the list staying
// short until the work that defines the rest lands.
import { IMAGE_ID_RE, isPathSha, SHA_RE } from "./kaoiro-deploy-manifest.mjs";

export class PhaseError extends Error {}

export const PHASE = Object.freeze({
  PREFLIGHT: "preflight",
  OLD_IMAGE_SAVED: "old_image_saved",
  BUILD_PREPARED: "build_prepared",
  MAINTENANCE_GATE_PASSED: "maintenance_gate_passed",
});

/** Each key's value is the set of phases that may follow it directly.
 *  An entry reached by any other route is a history CONTRADICTION
 *  (S1 iv), not merely an unexpected phase. */
const TRANSITIONS = {
  [PHASE.PREFLIGHT]: [PHASE.OLD_IMAGE_SAVED],
  [PHASE.OLD_IMAGE_SAVED]: [PHASE.BUILD_PREPARED],
  [PHASE.BUILD_PREPARED]: [PHASE.MAINTENANCE_GATE_PASSED],
  [PHASE.MAINTENANCE_GATE_PASSED]: [],
};

/** Per-phase observation shape (S1 item i) — what advancePhase() must
 *  have recorded for THIS journal to be trustworthy at that point.
 *  `compose_artifact` at OLD_IMAGE_SAVED is what lets rollback name the
 *  compose file the OLD image was started with, not just the image id;
 *  BUILD_PREPARED's `target_sha` is the value resume's target-mismatch
 *  guard already compares `--target` against (kaoiro-server-deploy.mjs). */
const OBSERVATION_SCHEMAS = {
  [PHASE.PREFLIGHT]: (obs) => typeof obs.container === "string" && obs.container !== "",
  [PHASE.OLD_IMAGE_SAVED]: (obs) =>
    typeof obs.old_image_id === "string" &&
    obs.old_image_id !== "" &&
    typeof obs.old_sha === "string" &&
    SHA_RE.test(obs.old_sha) &&
    isPathSha(obs.compose_artifact),
  [PHASE.BUILD_PREPARED]: (obs) =>
    typeof obs.image_id === "string" &&
    IMAGE_ID_RE.test(obs.image_id) &&
    typeof obs.image_tag === "string" &&
    obs.image_tag !== "" &&
    typeof obs.target_sha === "string" &&
    SHA_RE.test(obs.target_sha),
  [PHASE.MAINTENANCE_GATE_PASSED]: () => true,
};

export function isKnownPhase(phase) {
  return Object.hasOwn(OBSERVATION_SCHEMAS, phase);
}

/** Validates one journal's CURRENT phase and its FULL history against
 *  this state machine: every phase must be known, every entry's
 *  observation must match its own phase's schema, each consecutive pair
 *  must be a listed transition, and the journal's current `phase` must
 *  agree with the last history entry. Throws PhaseError naming exactly
 *  what disagreed — this is the "diagnose non-zero" S1(iv) requires, a
 *  caller decides how to surface it, not a bare boolean that loses the
 *  reason. An empty history is valid only when `journal.phase` is
 *  itself PREFLIGHT (a wholly bootstrapped-but-unwritten journal is not
 *  a shape this state machine ever produces, but this function should
 *  not silently accept "phase says X, no evidence anywhere"). */
export function validateJournalAgainstStateMachine(journal) {
  // journal.phase itself is NOT checked with isKnownPhase() here — it
  // is redundant with the checks below: an empty history rejects any
  // phase but PREFLIGHT (next branch), and a non-empty history's final
  // agreement check (below the loop) rejects any phase that does not
  // match the last (always-known) history entry, including an unknown
  // one. Measured directly: adding the isKnownPhase(journal.phase)
  // check back and then deleting it again left every test in this
  // file's own suite green either way.
  if (journal.history.length === 0) {
    if (journal.phase !== PHASE.PREFLIGHT) {
      throw new PhaseError(
        `journal.phase is ${journal.phase} but history is empty — no evidence supports it`,
      );
    }
    return;
  }
  let previous = null;
  for (const entry of journal.history) {
    if (!isKnownPhase(entry.phase)) {
      throw new PhaseError(`unknown phase in history: ${entry.phase}`);
    }
    if (!OBSERVATION_SCHEMAS[entry.phase](entry.observation)) {
      throw new PhaseError(`observation for phase ${entry.phase} does not match its schema`);
    }
    if (previous !== null) {
      const allowed = TRANSITIONS[previous] ?? [];
      if (!allowed.includes(entry.phase)) {
        throw new PhaseError(`history transition ${previous} -> ${entry.phase} is not allowed`);
      }
    }
    previous = entry.phase;
  }
  if (previous !== journal.phase) {
    throw new PhaseError(
      `journal.phase (${journal.phase}) does not match the last history entry's phase (${previous})`,
    );
  }
}
