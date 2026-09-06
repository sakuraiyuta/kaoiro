import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isKnownPhase,
  PHASE,
  PhaseError,
  validateJournalAgainstStateMachine,
} from "../kaoiro-deploy-phase.mjs";

function entry(phase, observation) {
  return { phase, at: "2026-09-06T10:15:00.000Z", observation };
}

const PREFLIGHT_OBS = { container: "kaoiro-c1" };
const OLD_IMAGE_OBS = {
  old_image_id: "sha256:oldimageid",
  old_sha: "c".repeat(40),
  compose_artifact: { path: "/server/docker-compose.yaml", sha256: "a".repeat(64) },
};
const BUILD_OBS = {
  image_id: `sha256:${"b".repeat(64)}`,
  image_tag: "kaoiro-server:x",
  target_sha: "d".repeat(40),
};

function fullJournal(phase = PHASE.MAINTENANCE_GATE_PASSED) {
  return {
    schema_version: 1,
    transaction_id: "t",
    phase,
    history: [
      entry(PHASE.PREFLIGHT, PREFLIGHT_OBS),
      entry(PHASE.OLD_IMAGE_SAVED, OLD_IMAGE_OBS),
      entry(PHASE.BUILD_PREPARED, BUILD_OBS),
      entry(PHASE.MAINTENANCE_GATE_PASSED, {}),
    ],
  };
}

test("isKnownPhase accepts every PHASE value and rejects an arbitrary string", () => {
  for (const phase of Object.values(PHASE)) {
    assert.equal(isKnownPhase(phase), true);
  }
  assert.equal(isKnownPhase("not-a-real-phase"), false);
});

test("validateJournalAgainstStateMachine accepts a full, correctly-ordered journal", () => {
  assert.doesNotThrow(() => validateJournalAgainstStateMachine(fullJournal()));
});

test("validateJournalAgainstStateMachine accepts an empty history only at PREFLIGHT", () => {
  assert.doesNotThrow(() =>
    validateJournalAgainstStateMachine({
      schema_version: 1,
      transaction_id: "t",
      phase: PHASE.PREFLIGHT,
      history: [],
    }),
  );
});

test("validateJournalAgainstStateMachine rejects an empty history at a later phase", () => {
  assert.throws(
    () =>
      validateJournalAgainstStateMachine({
        schema_version: 1,
        transaction_id: "t",
        phase: PHASE.BUILD_PREPARED,
        history: [],
      }),
    PhaseError,
  );
});

test("validateJournalAgainstStateMachine rejects an unknown current phase", () => {
  const journal = fullJournal();
  journal.phase = "not-a-real-phase";
  assert.throws(() => validateJournalAgainstStateMachine(journal), PhaseError);
});

test("validateJournalAgainstStateMachine rejects an unknown phase in history", () => {
  const journal = fullJournal();
  journal.history.push(entry("not-a-real-phase", {}));
  assert.throws(() => validateJournalAgainstStateMachine(journal), PhaseError);
});

test("validateJournalAgainstStateMachine rejects a skipped transition", () => {
  const journal = {
    schema_version: 1,
    transaction_id: "t",
    phase: PHASE.BUILD_PREPARED,
    // Skips OLD_IMAGE_SAVED entirely.
    history: [entry(PHASE.PREFLIGHT, PREFLIGHT_OBS), entry(PHASE.BUILD_PREPARED, BUILD_OBS)],
  };
  assert.throws(() => validateJournalAgainstStateMachine(journal), PhaseError);
});

test("validateJournalAgainstStateMachine rejects a backward transition", () => {
  const journal = {
    schema_version: 1,
    transaction_id: "t",
    phase: PHASE.PREFLIGHT,
    history: [
      entry(PHASE.PREFLIGHT, PREFLIGHT_OBS),
      entry(PHASE.OLD_IMAGE_SAVED, OLD_IMAGE_OBS),
      entry(PHASE.PREFLIGHT, PREFLIGHT_OBS),
    ],
  };
  assert.throws(() => validateJournalAgainstStateMachine(journal), PhaseError);
});

test("validateJournalAgainstStateMachine rejects journal.phase disagreeing with the last history entry", () => {
  const journal = fullJournal(PHASE.BUILD_PREPARED);
  // history's last entry is MAINTENANCE_GATE_PASSED, but journal.phase
  // claims BUILD_PREPARED.
  assert.throws(() => validateJournalAgainstStateMachine(journal), PhaseError);
});

test("validateJournalAgainstStateMachine rejects a PREFLIGHT observation missing container", () => {
  const journal = fullJournal();
  journal.history[0] = entry(PHASE.PREFLIGHT, {});
  assert.throws(() => validateJournalAgainstStateMachine(journal), PhaseError);
});

test("validateJournalAgainstStateMachine rejects an OLD_IMAGE_SAVED observation missing compose_artifact", () => {
  const journal = fullJournal();
  const { compose_artifact: _drop, ...rest } = OLD_IMAGE_OBS;
  journal.history[1] = entry(PHASE.OLD_IMAGE_SAVED, rest);
  assert.throws(() => validateJournalAgainstStateMachine(journal), PhaseError);
});

test("validateJournalAgainstStateMachine rejects a BUILD_PREPARED observation with a malformed image_id", () => {
  const journal = fullJournal();
  journal.history[2] = entry(PHASE.BUILD_PREPARED, { ...BUILD_OBS, image_id: "not-an-image" });
  assert.throws(() => validateJournalAgainstStateMachine(journal), PhaseError);
});
