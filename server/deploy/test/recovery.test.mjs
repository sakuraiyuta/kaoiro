import "../../../scripts/test/fixtures/test-isolation.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { PHASE, PhaseError, TRANSITIONS, validateJournalAgainstStateMachine } from "../kaoiro-deploy-phase.mjs";
import { isValidJournalShape } from "../kaoiro-deploy-journal.mjs";
import {
  CONDITION,
  entryActs,
  formatRecovery,
  OPERATION,
  RECOVERY_TABLE,
  recoveryFacts,
  recoveryTableMarkdown,
  renderRecovery,
  selectEntry,
} from "../kaoiro-deploy-recovery.mjs";
import { ROLLBACK_ELIGIBLE_PHASES, UNRESUMABLE_PHASES } from "../kaoiro-server-deploy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SHA = "a".repeat(40);
const OLD = "b".repeat(40);
const TX = "20261020T000000Z";

const factCombos = [true, false].flatMap((hasTarget) => [true, false].map((hasId) => ({
  [CONDITION.JOURNAL_HAS_TARGET]: hasTarget,
  [CONDITION.JOURNAL_LACKS_TARGET]: !hasTarget,
  [CONDITION.CONTAINER_ID_RECORDED]: hasId,
  [CONDITION.LEGACY_NO_CONTAINER_ID]: !hasId,
})));

function journalAt(phase, { target = SHA, invocation = { repo: "/srv/kaoiro", config: "/etc/kaoiro/deploy.json", release_authority: null }, containerId = "c".repeat(64), releaseContext = null } = {}) {
  const old = { old_image_id: `sha256:${"0".repeat(64)}`, old_sha: OLD, rollback_tag: `kaoiro-server:rollback-${OLD}` };
  if (containerId !== null) old.old_container_id = containerId;
  if (target !== null) old.target_sha = target;
  return {
    schema_version: 1,
    transaction_id: TX,
    phase,
    release_context: releaseContext,
    ...(invocation === null ? {} : { invocation }),
    history: [
      { phase: PHASE.PREFLIGHT, at: "t", observation: {} },
      { phase: PHASE.OLD_IMAGE_SAVED, at: "t", observation: old },
    ],
  };
}

test("the table has exactly one row per phase", () => {
  assert.deepEqual(Object.keys(RECOVERY_TABLE).sort(), Object.values(PHASE).sort());
});

test("every (phase, command) dispatches to exactly one entry under every combination of facts", () => {
  for (const phase of Object.values(PHASE)) {
    for (const command of ["update", "rollback"]) {
      for (const facts of factCombos) {
        assert.doesNotThrow(() => selectEntry(phase, command, facts), `${phase}/${command}/${JSON.stringify(facts)}`);
      }
    }
  }
});

test("done refuses update and allows a destructive rollback", () => {
  const facts = factCombos[0];
  assert.equal(selectEntry(PHASE.DONE, "update", facts).operation, OPERATION.REFUSE);
  assert.equal(selectEntry(PHASE.DONE, "rollback", facts).operation, OPERATION.DESTRUCTIVE);
});

test("update resumes only before the stop window and never from a phase the graph marks unresumable", () => {
  const resumable = new Set();
  for (const phase of Object.values(PHASE)) {
    if (factCombos.some((facts) => entryActs(selectEntry(phase, "update", facts)))) resumable.add(phase);
  }
  assert.deepEqual([...resumable].sort(), [
    PHASE.BUILD_PREPARED, PHASE.ENV_CONSISTENCY_CHECKED, PHASE.MAINTENANCE_GATE_PASSED, PHASE.OLD_IMAGE_SAVED,
  ].sort());
  for (const phase of resumable) assert.equal(UNRESUMABLE_PHASES.has(phase), false, phase);
  const facts = { ...factCombos[0], [CONDITION.JOURNAL_HAS_TARGET]: false, [CONDITION.JOURNAL_LACKS_TARGET]: true };
  assert.equal(entryActs(selectEntry(PHASE.OLD_IMAGE_SAVED, "update", facts)), false);
});

test("rollback operations agree with the transition graph where both decide", () => {
  for (const phase of Object.values(PHASE)) {
    const op = selectEntry(phase, "rollback", factCombos[0]).operation;
    if (ROLLBACK_ELIGIBLE_PHASES.has(phase)) {
      const destructive = TRANSITIONS[phase].includes(PHASE.ROLLBACK_STOPPED);
      assert.equal(op, destructive ? OPERATION.DESTRUCTIVE : OPERATION.NON_DESTRUCTIVE, phase);
    } else if (phase === PHASE.PREFLIGHT) {
      assert.equal(op, OPERATION.RECORD_CLOSE);
      assert.ok(TRANSITIONS[PHASE.PREFLIGHT].includes(PHASE.ROLLED_BACK));
    } else {
      assert.equal(entryActs(selectEntry(phase, "rollback", factCombos[0])), false, phase);
    }
  }
});

test("facts come from the journal: target needs both the recorded target and the invocation", () => {
  assert.equal(recoveryFacts(journalAt(PHASE.OLD_IMAGE_SAVED))[CONDITION.JOURNAL_HAS_TARGET], true);
  assert.equal(recoveryFacts(journalAt(PHASE.OLD_IMAGE_SAVED, { target: null }))[CONDITION.JOURNAL_HAS_TARGET], false);
  assert.equal(recoveryFacts(journalAt(PHASE.OLD_IMAGE_SAVED, { invocation: null }))[CONDITION.JOURNAL_HAS_TARGET], false);
  assert.equal(recoveryFacts(journalAt(PHASE.OLD_IMAGE_SAVED, { containerId: null }))[CONDITION.LEGACY_NO_CONTAINER_ID], true);
});

test("rendered commands carry the recorded repo and config while ignoring retired release metadata", () => {
  const ctx = { attempt_uuid: "11111111-2222-4333-8444-555555555555", plan_sha256: "f".repeat(64) };
  const lines = renderRecovery(TX, journalAt(PHASE.OLD_IMAGE_SAVED, {
    invocation: { repo: "/srv/kaoiro", config: "/etc/kaoiro/deploy.json", release_authority: "/srv/kaoiro/server/.kaoiro-release-authority.json" },
    releaseContext: ctx,
  }));
  const update = lines.find((l) => l.command === "update");
  assert.deepEqual(update.argv, [
    "node", "/srv/kaoiro/server/deploy/kaoiro-server-deploy.mjs", "update", "--repo", "/srv/kaoiro",
    "--config", "/etc/kaoiro/deploy.json", "--transaction", TX, "--target", SHA,
  ]);
  assert.deepEqual(update.placeholders, []);
  const rollback = lines.find((l) => l.command === "rollback");
  assert.deepEqual(rollback.argv.slice(-3), ["--transaction", TX, "--confirm-restore"]);
  assert.match(formatRecovery(lines), /^next: node \/srv\/kaoiro\/server\/deploy\/kaoiro-server-deploy\.mjs update /m);
});

test("a journal without invocation renders named placeholders, never a guess", () => {
  const lines = renderRecovery(TX, journalAt(PHASE.STOPPED, { invocation: null }));
  const rollback = lines.find((l) => l.command === "rollback");
  assert.ok(rollback.argv.includes("<repo>"));
  assert.deepEqual(rollback.placeholders.map((p) => p.name), ["<repo>", "--config <path>"]);
});

test("build-prepared guidance is conditional and preserves legacy rollback rendering", () => {
  const lines = renderRecovery(TX, journalAt(PHASE.BUILD_PREPARED, { invocation: null, containerId: null, target: null }));
  const update = lines.find((line) => line.command === "update");
  const rollback = lines.find((line) => line.command === "rollback");
  assert.equal(update.note, "If an existing-store path mismatch caused the refusal, this CLI has no forward migration path for a store outside the state volume. Copying alone cannot unblock this transaction or a new update. Use the non-destructive rollback and see docs/operations/server-update-and-rollback.md 4.3 (5-b).");
  assert.ok(update.argv.includes("<target>"));
  assert.ok(rollback.argv.includes("<repo>"));
  assert.equal(rollback.operation, "non-destructive");
  const text = formatRecovery(lines);
  assert.ok(text.includes(`note: update: ${update.note}`));
  assert.ok(!text.includes("legacy journal:"));
  for (const phase of [PHASE.OLD_IMAGE_SAVED, PHASE.ENV_CONSISTENCY_CHECKED, PHASE.MAINTENANCE_GATE_PASSED, PHASE.STOPPED]) {
    assert.ok(!formatRecovery(renderRecovery(TX, journalAt(phase, { containerId: null }))).includes("legacy journal:"));
  }
});

test("5-b runbook does not prescribe live copy or an outside-volume match", () => {
  const runbook = readFileSync(join(here, "../../../docs/operations/server-update-and-rollback.md"), "utf8");
  const section = runbook.split("**(5-b) Existing or uncertain persistence store: refusal and recovery**")[1]?.split("**(5-c)")[0];
  assert.ok(section);
  assert.ok(!section.includes("docker cp <container>:/tmp/kaoiro_users.dets"));
  assert.ok(section.includes("Copying a live DETS file to the target volume does not unblock either"));
  assert.ok(section.includes("Do not point compose or an override outside"));
  assert.ok(section.includes("The operator must also establish the old image's"));
  assert.ok(section.includes("if that cannot be established,"));
});

test("refusals and deferred rows render a note and no command", () => {
  const lines = renderRecovery(TX, journalAt(PHASE.ROLLBACK_RESTORING));
  assert.deepEqual(lines.map((l) => [l.command, l.argv]), [["update", null], ["rollback", null]]);
  assert.match(formatRecovery(lines), /4\.4 \(3a\)/);
  assert.doesNotMatch(formatRecovery(lines), /^next:/m);
});

test("a destructive rollback names --fleet-stopped only as an optional operator attestation", () => {
  const rollback = renderRecovery(TX, journalAt(PHASE.UP)).find((l) => l.command === "rollback");
  assert.equal(rollback.argv.includes("--fleet-stopped"), false);
  assert.deepEqual(rollback.optional.map((o) => o.flag), ["--fleet-stopped"]);
});

test("the runbook table equals the generated table", () => {
  const runbook = readFileSync(join(here, "../../../docs/operations/server-update-and-rollback.md"), "utf8");
  const match = /<!-- recovery-table:begin -->\n([\s\S]*?)\n<!-- recovery-table:end -->/.exec(runbook);
  assert.ok(match, "runbook markers missing");
  assert.equal(match[1], recoveryTableMarkdown());
});

test("a malformed recorded target or invocation is refused, never tolerated as an extra field", () => {
  const old = {
    old_image_id: `sha256:${"0".repeat(64)}`, old_sha: OLD, old_container_id: "c".repeat(64),
    compose_artifact: { path: "/x/docker-compose.yaml", sha256: "e".repeat(64) },
    rollback_tag: `kaoiro-server:rollback-${OLD}`,
  };
  const pre = { container: "kaoiro-c1", free_bytes: 1, volume_bytes: 1, threshold_bytes: 1 };
  const journal = (target) => ({ schema_version: 1, transaction_id: TX, phase: PHASE.OLD_IMAGE_SAVED,
    history: [{ phase: PHASE.PREFLIGHT, at: "t", observation: pre },
      { phase: PHASE.OLD_IMAGE_SAVED, at: "t", observation: { ...old, ...target } }] });
  assert.doesNotThrow(() => validateJournalAgainstStateMachine(journal({})));
  assert.doesNotThrow(() => validateJournalAgainstStateMachine(journal({ target_sha: SHA })));
  assert.throws(() => validateJournalAgainstStateMachine(journal({ target_sha: "main" })), PhaseError);
  const base = { schema_version: 1, transaction_id: TX, phase: PHASE.PREFLIGHT, history: [] };
  assert.equal(isValidJournalShape({ ...base, invocation: { repo: "/srv/kaoiro", config: null, release_authority: null } }), true);
  assert.equal(isValidJournalShape({ ...base, invocation: { repo: "relative", config: null, release_authority: null } }), false);
  assert.equal(isValidJournalShape({ ...base, invocation: { repo: "/srv/kaoiro", config: "deploy.json", release_authority: null } }), false);
  assert.equal(isValidJournalShape({ ...base, invocation: { repo: "/srv/kaoiro", config: null, release_authority: "authority.json" } }), true);
});
