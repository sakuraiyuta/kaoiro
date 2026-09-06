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

// Looks up a fixture's own entry by phase rather than a hardcoded array
// index — a magic index silently drifts every time a phase is inserted
// (exactly what happened to this file's own indices when STARTING landed
// mid-session; ENV_CONSISTENCY_CHECKED below would have repeated it).
function indexOf(journal, phase) {
  const idx = journal.history.findIndex((e) => e.phase === phase);
  if (idx === -1) throw new Error(`fixture has no ${phase} entry`);
  return idx;
}

const PREFLIGHT_OBS = { container: "kaoiro-c1" };
const OLD_SHA = "c".repeat(40);
const OLD_IMAGE_OBS = {
  old_image_id: `sha256:${"0".repeat(64)}`,
  old_sha: OLD_SHA,
  compose_artifact: { path: "/server/docker-compose.yaml", sha256: "a".repeat(64) },
  rollback_tag: `kaoiro-server:rollback-${OLD_SHA}`,
};
const BUILD_OBS = {
  image_id: `sha256:${"b".repeat(64)}`,
  image_tag: "kaoiro-server:x",
  target_sha: "d".repeat(40),
};

const STOPPED_OBS = { stop_exit_code: 0, stop_oom_killed: false };
const MOUNT_RESOLVED_OBS = { volume_id: "kaoiro_kaoiro-state" };
const ARCHIVED_OBS = {
  archive: { path: "/backup/archive.tar.gz", sha256: "f".repeat(64) },
  required_entries: [{ path: "users.dets", owner: "1000:1000", mode: "0600" }],
};
// issue #220 absorption: a "checked, nothing to flag" observation — the
// discriminated-union shape kaoiro-deploy-manifest.mjs's
// isValidEnvConsistency defines, imported into this schema rather than
// redefined.
const ENV_CONSISTENCY_OBS = { skipped: false, entries: {} };

function fullJournal(phase = PHASE.MAINTENANCE_GATE_PASSED) {
  return {
    schema_version: 1,
    transaction_id: "t",
    phase,
    history: [
      entry(PHASE.PREFLIGHT, PREFLIGHT_OBS),
      entry(PHASE.OLD_IMAGE_SAVED, OLD_IMAGE_OBS),
      entry(PHASE.BUILD_PREPARED, BUILD_OBS),
      entry(PHASE.ENV_CONSISTENCY_CHECKED, ENV_CONSISTENCY_OBS),
      entry(PHASE.MAINTENANCE_GATE_PASSED, {}),
    ],
  };
}

function fullJournalThroughArchived(phase = PHASE.ARCHIVED) {
  const base = fullJournal(PHASE.MAINTENANCE_GATE_PASSED);
  return {
    ...base,
    phase,
    history: [
      ...base.history,
      entry(PHASE.STOPPING, {}),
      entry(PHASE.STOPPED, STOPPED_OBS),
      entry(PHASE.MOUNT_RESOLVED, MOUNT_RESOLVED_OBS),
      entry(PHASE.ARCHIVED, ARCHIVED_OBS),
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
  journal.history[indexOf(journal, PHASE.PREFLIGHT)] = entry(PHASE.PREFLIGHT, {});
  assert.throws(() => validateJournalAgainstStateMachine(journal), PhaseError);
});

test("validateJournalAgainstStateMachine rejects an OLD_IMAGE_SAVED observation missing compose_artifact", () => {
  const journal = fullJournal();
  const { compose_artifact: _drop, ...rest } = OLD_IMAGE_OBS;
  journal.history[indexOf(journal, PHASE.OLD_IMAGE_SAVED)] = entry(PHASE.OLD_IMAGE_SAVED, rest);
  assert.throws(() => validateJournalAgainstStateMachine(journal), PhaseError);
});

test("validateJournalAgainstStateMachine rejects a BUILD_PREPARED observation with a malformed image_id", () => {
  const journal = fullJournal();
  journal.history[indexOf(journal, PHASE.BUILD_PREPARED)] = entry(PHASE.BUILD_PREPARED, {
    ...BUILD_OBS,
    image_id: "not-an-image",
  });
  assert.throws(() => validateJournalAgainstStateMachine(journal), PhaseError);
});

// issue #220 absorption.
test("validateJournalAgainstStateMachine accepts an ENV_CONSISTENCY_CHECKED observation reporting skipped", () => {
  const journal = fullJournal();
  journal.history[indexOf(journal, PHASE.ENV_CONSISTENCY_CHECKED)] = entry(PHASE.ENV_CONSISTENCY_CHECKED, {
    skipped: true,
    reason: "eval exited 1: module not landed on this image",
  });
  assert.doesNotThrow(() => validateJournalAgainstStateMachine(journal));
});

test("validateJournalAgainstStateMachine accepts an ENV_CONSISTENCY_CHECKED observation with per-key entries", () => {
  const journal = fullJournal();
  journal.history[indexOf(journal, PHASE.ENV_CONSISTENCY_CHECKED)] = entry(PHASE.ENV_CONSISTENCY_CHECKED, {
    skipped: false,
    entries: {
      KAOIRO_USERS_PATH: {
        env_file: null,
        compose: "/var/lib/kaoiro/users.dets",
        container: "/var/lib/kaoiro/users.dets",
        match: true,
      },
    },
  });
  assert.doesNotThrow(() => validateJournalAgainstStateMachine(journal));
});

test("validateJournalAgainstStateMachine rejects an ENV_CONSISTENCY_CHECKED observation that is neither skipped nor checked", () => {
  const journal = fullJournal();
  journal.history[indexOf(journal, PHASE.ENV_CONSISTENCY_CHECKED)] = entry(PHASE.ENV_CONSISTENCY_CHECKED, {});
  assert.throws(() => validateJournalAgainstStateMachine(journal), PhaseError);
});

test("validateJournalAgainstStateMachine rejects skipping ENV_CONSISTENCY_CHECKED straight from BUILD_PREPARED to MAINTENANCE_GATE_PASSED", () => {
  const journal = fullJournal();
  journal.history.splice(indexOf(journal, PHASE.ENV_CONSISTENCY_CHECKED), 1);
  assert.throws(() => validateJournalAgainstStateMachine(journal), PhaseError);
});

test("validateJournalAgainstStateMachine accepts a full journal through ARCHIVED", () => {
  assert.doesNotThrow(() => validateJournalAgainstStateMachine(fullJournalThroughArchived()));
});

test("validateJournalAgainstStateMachine rejects a STOPPED observation with a non-integer exit code", () => {
  const journal = fullJournalThroughArchived();
  journal.history[indexOf(journal, PHASE.STOPPED)] = entry(PHASE.STOPPED, { ...STOPPED_OBS, stop_exit_code: "0" });
  assert.throws(() => validateJournalAgainstStateMachine(journal), PhaseError);
});

test("validateJournalAgainstStateMachine accepts a STOPPED observation with null exit code/oom (unmeasured)", () => {
  const journal = fullJournalThroughArchived();
  journal.history[indexOf(journal, PHASE.STOPPED)] = entry(PHASE.STOPPED, {
    stop_exit_code: null,
    stop_oom_killed: null,
  });
  assert.doesNotThrow(() => validateJournalAgainstStateMachine(journal));
});

test("validateJournalAgainstStateMachine rejects a MOUNT_RESOLVED observation with an empty volume_id", () => {
  const journal = fullJournalThroughArchived();
  journal.history[indexOf(journal, PHASE.MOUNT_RESOLVED)] = entry(PHASE.MOUNT_RESOLVED, { volume_id: "" });
  assert.throws(() => validateJournalAgainstStateMachine(journal), PhaseError);
});

test("validateJournalAgainstStateMachine rejects an ARCHIVED observation with a malformed archive sha256", () => {
  const journal = fullJournalThroughArchived();
  journal.history[indexOf(journal, PHASE.ARCHIVED)] = entry(PHASE.ARCHIVED, {
    ...ARCHIVED_OBS,
    archive: { path: "/x", sha256: "not-a-sha" },
  });
  assert.throws(() => validateJournalAgainstStateMachine(journal), PhaseError);
});

test("validateJournalAgainstStateMachine rejects an ARCHIVED observation with malformed required_entries", () => {
  const journal = fullJournalThroughArchived();
  journal.history[indexOf(journal, PHASE.ARCHIVED)] = entry(PHASE.ARCHIVED, {
    ...ARCHIVED_OBS,
    required_entries: [{ path: "users.dets", owner: "banana", mode: "0600" }],
  });
  assert.throws(() => validateJournalAgainstStateMachine(journal), PhaseError);
});

// クロエ round 1 review SF-7: a 4-digit mode with a nonzero leading
// (special-bit) digit, like a setgid directory's "2755", must not be
// rejected by the schema that also gates ARCHIVED.
test("validateJournalAgainstStateMachine accepts an ARCHIVED observation with a setgid (4-digit) mode", () => {
  const journal = fullJournalThroughArchived();
  journal.history[indexOf(journal, PHASE.ARCHIVED)] = entry(PHASE.ARCHIVED, {
    ...ARCHIVED_OBS,
    required_entries: [{ path: "some-dir", owner: "1000:1000", mode: "2755" }],
  });
  assert.doesNotThrow(() => validateJournalAgainstStateMachine(journal));
});

test("validateJournalAgainstStateMachine rejects skipping STOPPING straight to STOPPED", () => {
  const journal = fullJournalThroughArchived();
  journal.history.splice(indexOf(journal, PHASE.STOPPING), 1);
  assert.throws(() => validateJournalAgainstStateMachine(journal), PhaseError);
});

test("validateJournalAgainstStateMachine rejects skipping STOPPED straight to ARCHIVED", () => {
  const journal = fullJournalThroughArchived();
  journal.history.splice(indexOf(journal, PHASE.STOPPED), 1);
  assert.throws(() => validateJournalAgainstStateMachine(journal), PhaseError);
});

// クロエ round 1 review SF-1/MF-2: OLD_IMAGE_SAVED now enforces the same
// IMAGE_ID_RE shape BUILD_PREPARED already did, plus a rollback_tag that
// actually names old_sha.
test("validateJournalAgainstStateMachine rejects an OLD_IMAGE_SAVED observation with a malformed old_image_id", () => {
  const journal = fullJournal();
  journal.history[indexOf(journal, PHASE.OLD_IMAGE_SAVED)] = entry(PHASE.OLD_IMAGE_SAVED, { ...OLD_IMAGE_OBS, old_image_id: "sha256:oldimageid" });
  assert.throws(() => validateJournalAgainstStateMachine(journal), PhaseError);
});

test("validateJournalAgainstStateMachine rejects an OLD_IMAGE_SAVED observation whose rollback_tag names a different sha", () => {
  const journal = fullJournal();
  journal.history[indexOf(journal, PHASE.OLD_IMAGE_SAVED)] = entry(PHASE.OLD_IMAGE_SAVED, {
    ...OLD_IMAGE_OBS,
    rollback_tag: `kaoiro-server:rollback-${"9".repeat(40)}`,
  });
  assert.throws(() => validateJournalAgainstStateMachine(journal), PhaseError);
});

// issue #306 (c3): up / health / done.
const HEALTHY_OBS = { health_revision: "d".repeat(40), health_dirty: false };
const UP_OBS = { container_id: "sha256:up-container-id", started_at: "2026-09-06T10:20:00.000Z" };

function fullJournalThroughDone(phase = PHASE.DONE) {
  const base = fullJournalThroughArchived(PHASE.ARCHIVED);
  return {
    ...base,
    phase,
    history: [
      ...base.history,
      entry(PHASE.STARTING, {}),
      entry(PHASE.UP, UP_OBS),
      entry(PHASE.HEALTHY, HEALTHY_OBS),
      entry(PHASE.DONE, {}),
    ],
  };
}

test("validateJournalAgainstStateMachine accepts a full journal through DONE", () => {
  assert.doesNotThrow(() => validateJournalAgainstStateMachine(fullJournalThroughDone()));
});

test("validateJournalAgainstStateMachine rejects a HEALTHY observation whose health_revision does not match SHA_RE", () => {
  const journal = fullJournalThroughDone();
  journal.history[indexOf(journal, PHASE.HEALTHY)] = entry(PHASE.HEALTHY, {
    ...HEALTHY_OBS,
    health_revision: "not-a-sha",
  });
  assert.throws(() => validateJournalAgainstStateMachine(journal), PhaseError);
});

test("validateJournalAgainstStateMachine rejects skipping STARTING straight to UP", () => {
  const journal = fullJournalThroughDone();
  journal.history.splice(indexOf(journal, PHASE.STARTING), 1);
  assert.throws(() => validateJournalAgainstStateMachine(journal), PhaseError);
});

test("validateJournalAgainstStateMachine rejects skipping UP straight to HEALTHY", () => {
  const journal = fullJournalThroughDone();
  journal.history.splice(indexOf(journal, PHASE.UP), 1);
  assert.throws(() => validateJournalAgainstStateMachine(journal), PhaseError);
});

// クロエ design review F2: the new container's own identity is required,
// not merely present — an empty UP observation would silently lose the
// one fact runbook 4.4 (3)'s recovery needs to find that container.
test("validateJournalAgainstStateMachine rejects a UP observation missing container_id", () => {
  const journal = fullJournalThroughDone();
  const { container_id: _drop, ...rest } = UP_OBS;
  journal.history[indexOf(journal, PHASE.UP)] = entry(PHASE.UP, rest);
  assert.throws(() => validateJournalAgainstStateMachine(journal), PhaseError);
});

test("validateJournalAgainstStateMachine rejects a transition out of DONE (terminal)", () => {
  const journal = fullJournalThroughDone();
  journal.history.push(entry(PHASE.UP, UP_OBS));
  journal.phase = PHASE.UP;
  assert.throws(() => validateJournalAgainstStateMachine(journal), PhaseError);
});
