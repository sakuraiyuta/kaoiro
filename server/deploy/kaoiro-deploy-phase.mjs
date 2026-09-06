#!/usr/bin/env node
// Canonical phase list and transition table for `update` (issue #306,
// yuta ruling 2026-09-06, S1 items iii/iv). The generic journal schema
// (kaoiro-deploy-journal.mjs) deliberately keeps `phase` a free-form
// string — the phase LIST is a state-machine concern, not a storage-
// format one, and belongs here instead.
//
// PHASES ARE ADDED HERE AS COMMITS LAND, NOT ALL AT ONCE. `update`
// currently reaches DONE — rollback (a separate command, its own
// rolled-back/failed phases) arrives with a later commit. Extending
// PHASE/TRANSITIONS/OBSERVATION_SCHEMAS then is expected, not a design
// smell; what this file exists to prevent is an UNLISTED phase or an
// UNLISTED transition passing silently, not the list staying short
// until the work that defines the rest lands.
import {
  IMAGE_ID_RE,
  isPathSha,
  isValidEnvConsistency,
  isValidRequiredEntries,
  ROLLBACK_TAG_RE,
  SHA_RE,
} from "./kaoiro-deploy-manifest.mjs";

export class PhaseError extends Error {}

export const PHASE = Object.freeze({
  PREFLIGHT: "preflight",
  OLD_IMAGE_SAVED: "old_image_saved",
  BUILD_PREPARED: "build_prepared",
  // issue #220 absorption (director ruling 2026-09-06): checked right
  // after the target image is built (so its own `eval` can be queried)
  // and before the maintenance gate — still no-downtime, and a
  // fail-closed refusal here has broken nothing but the `latest` retag
  // `compose build` just did.
  ENV_CONSISTENCY_CHECKED: "env_consistency_checked",
  MAINTENANCE_GATE_PASSED: "maintenance_gate_passed",
  STOPPING: "stopping",
  STOPPED: "stopped",
  MOUNT_RESOLVED: "mount_resolved",
  ARCHIVED: "archived",
  STARTING: "starting",
  UP: "up",
  HEALTHY: "healthy",
  // Literally "done" — kaoiro-deploy-transaction.mjs's own TERMINAL_PHASES
  // set (a plain string set, decoupled from this file on purpose — see
  // its own comment) checks for this exact value to let a completed
  // transaction stop blocking a new `update`.
  DONE: "done",
  // `rollback`'s own destructive-path checkpoints (director ruling
  // 2026-09-06, B-5) — only reachable from STARTING/UP/HEALTHY/DONE
  // (TRANSITIONS below), where the volume may already hold data written
  // by the NEW code and a restore is destructive. The non-destructive
  // path (OLD_IMAGE_SAVED..ARCHIVED, where the old container was never
  // recreated) jumps straight to ROLLED_BACK — retag + `docker start`
  // are each already a single atomic-ish call, with nothing between them
  // worth a separate checkpoint.
  ROLLBACK_STOPPED: "rollback_stopped",
  ROLLBACK_FORENSIC_ARCHIVED: "rollback_forensic_archived",
  // クロエ round 5 review SF-9: a checkpoint immediately before the
  // destructive wipe (`find ... -exec rm -rf` + `tar xzf`) runs — without
  // it, a crash mid-wipe leaves the journal at ROLLBACK_FORENSIC_ARCHIVED,
  // indistinguishable from "the wipe was never attempted", even though an
  // operator investigating needs exactly that distinction (the volume may
  // now be empty, half-restored, or still intact). Mirrors STOPPING/
  // STARTING's own "checkpoint right before the risky step" pattern.
  ROLLBACK_RESTORING: "rollback_restoring",
  ROLLBACK_RESTORED: "rollback_restored",
  // Literally "rolled_back" — kaoiro-deploy-transaction.mjs's
  // TERMINAL_PHASES already anticipated this exact value.
  ROLLED_BACK: "rolled_back",
});

/** Each key's value is the set of phases that may follow it directly.
 *  An entry reached by any other route is a history CONTRADICTION
 *  (S1 iv), not merely an unexpected phase. */
// Exported (クロエ round 3 review MF-2) so a caller that needs "every
// phase reachable from X" (kaoiro-server-deploy.mjs's UNRESUMABLE_PHASES)
// can derive it from the SAME graph this file's own validator walks,
// rather than hand-enumerating a second copy that a new phase can be
// forgotten from.
export const TRANSITIONS = {
  [PHASE.PREFLIGHT]: [PHASE.OLD_IMAGE_SAVED],
  // director ruling 2026-09-06, B-4: rollback accepts any transaction at
  // OLD_IMAGE_SAVED or later (B-1) — every phase from here through
  // ARCHIVED can ALSO go straight to ROLLED_BACK (the non-destructive
  // path: the old container was never recreated, so there is nothing to
  // restore, only latest to retag back and the old container to
  // (re)start).
  [PHASE.OLD_IMAGE_SAVED]: [PHASE.BUILD_PREPARED, PHASE.ROLLED_BACK],
  [PHASE.BUILD_PREPARED]: [PHASE.ENV_CONSISTENCY_CHECKED, PHASE.ROLLED_BACK],
  [PHASE.ENV_CONSISTENCY_CHECKED]: [PHASE.MAINTENANCE_GATE_PASSED, PHASE.ROLLED_BACK],
  [PHASE.MAINTENANCE_GATE_PASSED]: [PHASE.STOPPING, PHASE.ROLLED_BACK],
  [PHASE.STOPPING]: [PHASE.STOPPED, PHASE.ROLLED_BACK],
  [PHASE.STOPPED]: [PHASE.MOUNT_RESOLVED, PHASE.ROLLED_BACK],
  [PHASE.MOUNT_RESOLVED]: [PHASE.ARCHIVED, PHASE.ROLLED_BACK],
  [PHASE.ARCHIVED]: [PHASE.STARTING, PHASE.ROLLED_BACK],
  // STARTING onward: the new image may already have been started (or
  // that is unknown — the same "provably never started" vs. "assume
  // opened" ambiguity STARTING's own comment below describes), so
  // rollback here is the DESTRUCTIVE path — ROLLBACK_STOPPED begins its
  // own linear chain rather than jumping straight to ROLLED_BACK.
  [PHASE.STARTING]: [PHASE.UP, PHASE.ROLLBACK_STOPPED],
  [PHASE.UP]: [PHASE.HEALTHY, PHASE.ROLLBACK_STOPPED],
  [PHASE.HEALTHY]: [PHASE.DONE, PHASE.ROLLBACK_STOPPED],
  // A fully DONE transaction can still be rolled back later (an operator
  // decision made after the fact, not a failure of this transaction
  // itself) — director ruling 2026-09-06, B-4.
  [PHASE.DONE]: [PHASE.ROLLBACK_STOPPED],
  [PHASE.ROLLBACK_STOPPED]: [PHASE.ROLLBACK_FORENSIC_ARCHIVED],
  [PHASE.ROLLBACK_FORENSIC_ARCHIVED]: [PHASE.ROLLBACK_RESTORING],
  [PHASE.ROLLBACK_RESTORING]: [PHASE.ROLLBACK_RESTORED],
  [PHASE.ROLLBACK_RESTORED]: [PHASE.ROLLED_BACK],
  [PHASE.ROLLED_BACK]: [],
};

/** Per-phase observation shape (S1 item i) — what advancePhase() must
 *  have recorded for THIS journal to be trustworthy at that point.
 *  `compose_artifact` at OLD_IMAGE_SAVED is what lets rollback name the
 *  compose file the OLD image was started with, not just the image id;
 *  BUILD_PREPARED's `target_sha` is the value resume's target-mismatch
 *  guard already compares `--target` against (kaoiro-server-deploy.mjs).
 *  STOPPED's exit-code fields are `null` until the dev-host measurement
 *  (commit e) fixes an expected value — see kaoiro-server-deploy.mjs's
 *  own EXPECTED_CLEAN_STOP_EXIT_CODE comment for why `null` there means
 *  "treat every stop as abnormal", not "anything goes" here: this schema
 *  only checks the RECORDED shape (number-or-null, boolean-or-null), the
 *  abnormal/normal judgment itself lives in the caller that decides
 *  whether to advance past STOPPED at all. */
const OBSERVATION_SCHEMAS = {
  [PHASE.PREFLIGHT]: (obs) => typeof obs.container === "string" && obs.container !== "",
  // クロエ round 1 review MF-2: the rollback tag must name the OLD sha it
  // was cut from, not just look like a tag — a value that merely looks
  // like a docker tag string but drifted from old_sha would be a silent
  // footgun the whole point of recording it is meant to prevent.
  [PHASE.OLD_IMAGE_SAVED]: (obs) =>
    typeof obs.old_image_id === "string" &&
    IMAGE_ID_RE.test(obs.old_image_id) &&
    typeof obs.old_sha === "string" &&
    SHA_RE.test(obs.old_sha) &&
    isPathSha(obs.compose_artifact) &&
    typeof obs.rollback_tag === "string" &&
    ROLLBACK_TAG_RE.test(obs.rollback_tag) &&
    obs.rollback_tag === `kaoiro-server:rollback-${obs.old_sha}`,
  [PHASE.BUILD_PREPARED]: (obs) =>
    typeof obs.image_id === "string" &&
    IMAGE_ID_RE.test(obs.image_id) &&
    typeof obs.image_tag === "string" &&
    obs.image_tag !== "" &&
    typeof obs.target_sha === "string" &&
    SHA_RE.test(obs.target_sha),
  // issue #220 absorption: the observation IS the manifest's own
  // env_consistency shape (isValidEnvConsistency, imported rather than
  // redefined — see that function's own doc comment).
  [PHASE.ENV_CONSISTENCY_CHECKED]: (obs) => isValidEnvConsistency(obs),
  [PHASE.MAINTENANCE_GATE_PASSED]: () => true,
  // クロエ round 1 review SF-2: a checkpoint written immediately before
  // `compose stop` runs, so a crash between the stop command and the
  // STOPPED checkpoint leaves the journal AT this phase — distinguishable
  // from "the gate passed but stop was never attempted" (a crash before
  // this checkpoint would still show MAINTENANCE_GATE_PASSED).
  [PHASE.STOPPING]: () => true,
  [PHASE.STOPPED]: (obs) =>
    (obs.stop_exit_code === null || Number.isInteger(obs.stop_exit_code)) &&
    (obs.stop_oom_killed === null || typeof obs.stop_oom_killed === "boolean"),
  [PHASE.MOUNT_RESOLVED]: (obs) => typeof obs.volume_id === "string" && obs.volume_id !== "",
  [PHASE.ARCHIVED]: (obs) => isPathSha(obs.archive) && isValidRequiredEntries(obs.required_entries),
  // クロエ design review F1 (state machine vs runbook 4.4): a checkpoint
  // immediately before `compose up -d` runs, mirroring STOPPING's own
  // reasoning — a crash between the up command and the UP checkpoint
  // otherwise leaves the journal at ARCHIVED, indistinguishable from "up
  // was never attempted" even though 4.4 (3)'s recovery branches
  // ("provably never started" vs. "started or unknown, assume DETS was
  // opened") need exactly that distinction.
  [PHASE.STARTING]: () => true,
  // クロエ design review F2: the new container's own identity, not the
  // PREFLIGHT-recorded compose SERVICE name — 4.4 (3) recovery starts by
  // stopping the new container, and after `compose up -d` recreates one
  // (a new image means compose does not just restart the old object),
  // its id is not otherwise anywhere in the journal.
  [PHASE.UP]: (obs) =>
    typeof obs.container_id === "string" &&
    obs.container_id !== "" &&
    typeof obs.started_at === "string" &&
    obs.started_at !== "",
  // (c3) health poll: `HEALTHY` records what deployment.md 4.5's
  // provenance check actually observed (GET /api/health's build_revision/
  // build_dirty), not merely "it matched" — the value itself is worth
  // keeping for a later audit even though the caller already enforced
  // `health_revision === target_sha` before advancing here.
  [PHASE.HEALTHY]: (obs) =>
    typeof obs.health_revision === "string" &&
    SHA_RE.test(obs.health_revision) &&
    typeof obs.health_dirty === "boolean",
  [PHASE.DONE]: () => true,
  // director ruling 2026-09-06, B-5: the destructive rollback path's own
  // checkpoints, mirroring the granularity `update` already applies to
  // its own risky steps.
  //
  // `stopped_container` is nullable: a transaction parked at STARTING
  // may never have actually started a container at all (the same
  // ambiguity STARTING's own schema comment above describes) — finding
  // nothing to stop is a legitimate, recorded outcome, not a failure.
  [PHASE.ROLLBACK_STOPPED]: (obs) =>
    obs.stopped_container === null ||
    (typeof obs.stopped_container === "string" && obs.stopped_container !== ""),
  [PHASE.ROLLBACK_FORENSIC_ARCHIVED]: (obs) => isPathSha(obs.archive),
  // SF-9: self-contained like every other phase's observation (not just
  // "trust the prior entry") — the forensic archive already recorded at
  // ROLLBACK_FORENSIC_ARCHIVED, plus the pre-deploy archive about to be
  // extracted over the volume (re-verified against manifest.archive's own
  // sha256 right before this checkpoint is written).
  [PHASE.ROLLBACK_RESTORING]: (obs) => isPathSha(obs.forensic_archive) && isPathSha(obs.restore_from),
  [PHASE.ROLLBACK_RESTORED]: (obs) => isValidRequiredEntries(obs.required_entries),
  [PHASE.ROLLED_BACK]: () => true,
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
