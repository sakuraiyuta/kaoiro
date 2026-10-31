#!/usr/bin/env node
// Recovery table for the server deploy transaction (issue #695, landing
// unit L1). One row per persisted phase; each row holds entries keyed by
// command and a named condition. Eligibility, refusal hints, `status`
// and the runbook table are all derived from this one table.
// See docs/plans/issue-695-transaction-state-table.md, section 5.
import { join } from "node:path";

import { PHASE } from "./kaoiro-deploy-phase.mjs";

export class RecoveryError extends Error {}

export const OPERATION = Object.freeze({
  RESUME: "resume",
  RECORD_CLOSE: "record-close",
  NON_DESTRUCTIVE: "non-destructive",
  DESTRUCTIVE: "destructive",
  DESTRUCTIVE_RESUME: "destructive-resume",
  REFUSE: "refuse",
});

// Named conditions, evaluated from the journal by recoveryFacts() below.
export const CONDITION = Object.freeze({
  JOURNAL_HAS_TARGET: "journal-has-target",
  JOURNAL_LACKS_TARGET: "journal-lacks-target",
  CONTAINER_ID_RECORDED: "container-id-recorded",
  LEGACY_NO_CONTAINER_ID: "legacy-no-container-id",
});

const CLOSED = "closed";
const DEFERRED_L1B = "deferred(L1b)";
const BUILD_PREPARED_GUIDANCE = "If an existing-store path mismatch caused the refusal, this CLI has no forward migration path for a store outside the state volume. Copying alone cannot unblock this transaction or a new update. Use the non-destructive rollback and see docs/operations/server-update-and-rollback.md 4.3 (5-b).";

const entry = (command, operation, { condition = null, closure = CLOSED, note = null } = {}) =>
  Object.freeze({ command, operation, condition, closure, note });

const nonDestructiveRollback = [
  entry("rollback", OPERATION.NON_DESTRUCTIVE, { condition: CONDITION.CONTAINER_ID_RECORDED }),
  entry("rollback", OPERATION.NON_DESTRUCTIVE, {
    condition: CONDITION.LEGACY_NO_CONTAINER_ID,
    note: "legacy journal: starts the recorded container name only if it still runs the old image",
  }),
];
const updateRefused = (note) => entry("update", OPERATION.REFUSE, { note });
const midRollback = [
  updateRefused("a rollback is in progress for this transaction"),
  entry("rollback", OPERATION.DESTRUCTIVE_RESUME, {
    closure: DEFERRED_L1B,
    note: "resuming a rollback that stopped part-way is not supported yet; follow docs/operations/server-update-and-rollback.md 4.4 (3a)",
  }),
];

const ROWS = [
  [PHASE.PREFLIGHT, [
    updateRefused("prepare stopped before the old image was recorded; close the transaction instead"),
    entry("rollback", OPERATION.RECORD_CLOSE),
  ]],
  [PHASE.OLD_IMAGE_SAVED, [
    entry("update", OPERATION.RESUME, { condition: CONDITION.JOURNAL_HAS_TARGET }),
    entry("update", OPERATION.REFUSE, {
      condition: CONDITION.JOURNAL_LACKS_TARGET,
      note: "this journal predates target recording, so the build cannot be retried safely",
    }),
    ...nonDestructiveRollback,
  ]],
  [PHASE.BUILD_PREPARED, [
    entry("update", OPERATION.RESUME, { note: BUILD_PREPARED_GUIDANCE }),
    ...nonDestructiveRollback,
  ]],
  ...[PHASE.ENV_CONSISTENCY_CHECKED, PHASE.MAINTENANCE_GATE_PASSED].map((phase) => [phase, [
    entry("update", OPERATION.RESUME),
    ...nonDestructiveRollback,
  ]]),
  ...[PHASE.STOPPING, PHASE.STOPPED, PHASE.MOUNT_RESOLVED, PHASE.ARCHIVED].map((phase) => [phase, [
    updateRefused("the commit half has no resume; roll back, then start a new update"),
    ...nonDestructiveRollback,
  ]]),
  ...[PHASE.STARTING, PHASE.UP, PHASE.HEALTHY].map((phase) => [phase, [
    updateRefused("a new container may have opened state; roll back to the recorded pair"),
    entry("rollback", OPERATION.DESTRUCTIVE),
  ]]),
  [PHASE.DONE, [
    updateRefused("the transaction is complete"),
    entry("rollback", OPERATION.DESTRUCTIVE),
  ]],
  ...[PHASE.ROLLBACK_STOPPED, PHASE.ROLLBACK_FORENSIC_ARCHIVED, PHASE.ROLLBACK_RESTORING,
    PHASE.ROLLBACK_RESTORED].map((phase) => [phase, midRollback]),
  [PHASE.ROLLED_BACK, [
    updateRefused("the transaction is rolled back"),
    entry("rollback", OPERATION.REFUSE, { note: "the transaction is already rolled back" }),
  ]],
];

export const RECOVERY_TABLE = Object.freeze(
  Object.fromEntries(ROWS.map(([phase, entries]) => [phase, Object.freeze(entries)])),
);

// Inventory: every phase has exactly one row, and no row names an unknown phase.
{
  const phases = Object.values(PHASE).sort();
  const rows = Object.keys(RECOVERY_TABLE).sort();
  if (JSON.stringify(phases) !== JSON.stringify(rows)) {
    throw new RecoveryError(`recovery table rows ${rows.join(",")} differ from phases ${phases.join(",")}`);
  }
}

/** The facts the named conditions read, derived from the journal only. */
export function recoveryFacts(journal) {
  const old = journal.history.find((e) => e.phase === PHASE.OLD_IMAGE_SAVED)?.observation;
  const hasTarget = typeof old?.target_sha === "string" && isInvocation(journal.invocation);
  const hasId = typeof old?.old_container_id === "string" && old.old_container_id !== "";
  return {
    [CONDITION.JOURNAL_HAS_TARGET]: hasTarget,
    [CONDITION.JOURNAL_LACKS_TARGET]: !hasTarget,
    [CONDITION.CONTAINER_ID_RECORDED]: hasId,
    [CONDITION.LEGACY_NO_CONTAINER_ID]: !hasId,
  };
}

/** The single entry for (phase, command) whose condition holds. Two
 *  matching entries are a table defect, so they throw rather than pick. */
export function selectEntry(phase, command, facts) {
  const row = RECOVERY_TABLE[phase];
  if (row === undefined) throw new RecoveryError(`unknown phase ${phase}`);
  const matches = row.filter((e) => e.command === command && (e.condition === null || facts[e.condition] === true));
  if (matches.length !== 1) {
    throw new RecoveryError(`recovery table has ${matches.length} entries for ${phase}/${command}`);
  }
  return matches[0];
}

/** Whether an entry may act now: refusals and deferred entries may not. */
export function entryActs(e) {
  return e.operation !== OPERATION.REFUSE && e.closure === CLOSED;
}

export function isInvocation(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    typeof value.repo === "string" && value.repo.startsWith("/") &&
    (value.config === null || (typeof value.config === "string" && value.config.startsWith("/")));
}

function recordedTarget(journal) {
  for (const phase of [PHASE.BUILD_PREPARED, PHASE.OLD_IMAGE_SAVED]) {
    const target = journal.history.find((e) => e.phase === phase)?.observation?.target_sha;
    if (typeof target === "string") return target;
  }
  return null;
}

/** The argv prefix shared by every rendered command: the CLI path and the
 *  recorded `--repo` / `--config`. A journal that
 *  predates invocation recording gets named placeholders instead. */
function baseArgv(journal, command, placeholders) {
  const inv = isInvocation(journal.invocation) ? journal.invocation : null;
  const repo = inv?.repo ?? "<repo>";
  if (inv === null) placeholders.push({ name: "<repo>", meaning: "the server checkout the transaction was prepared from" });
  const argv = ["node", join(repo, "server/deploy/kaoiro-server-deploy.mjs"), command, "--repo", repo];
  if (inv === null) {
    placeholders.push({ name: "--config <path>", meaning: "the --config file the transaction was prepared with, if any" });
  } else {
    if (inv.config !== null) argv.push("--config", inv.config);
  }
  return argv;
}

/** Rendered next commands for one transaction, from the table only. */
export function renderRecovery(transactionId, journal) {
  const facts = recoveryFacts(journal);
  const row = RECOVERY_TABLE[journal.phase] ?? [];
  const out = [];
  for (const e of row) {
    if (e.condition !== null && facts[e.condition] !== true) continue;
    const placeholders = [];
    const optional = [];
    if (e.operation === OPERATION.REFUSE || e.closure !== CLOSED) {
      out.push({ command: e.command, operation: e.operation, closure: e.closure, argv: null, placeholders, optional, note: e.note });
      continue;
    }
    const argv = baseArgv(journal, e.command, placeholders);
    argv.push("--transaction", transactionId);
    if (e.command === "update") {
      const target = recordedTarget(journal);
      argv.push("--target", target ?? "<target>");
      if (target === null) placeholders.push({ name: "<target>", meaning: "the target SHA this transaction prepared" });
      optional.push({ flag: "--maintenance-approved", when: "the operator has approved the maintenance window (the stop window opens)" });
    } else {
      argv.push("--confirm-restore");
      if (e.operation === OPERATION.DESTRUCTIVE) {
        optional.push({ flag: "--fleet-stopped", when: "no live server answers the fleet RPC and the fleet has been stopped" });
      }
    }
    out.push({ command: e.command, operation: e.operation, closure: e.closure, argv, placeholders, optional, note: e.note });
  }
  return out;
}

function shellQuote(word) {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}

/** Text form of renderRecovery(), appended to refusals: one `next:` line
 *  per acting entry and one `note:` line per refusal or deferred entry. */
export function formatRecovery(lines) {
  const text = [];
  for (const l of lines) {
    if (l.argv === null) {
      if (l.note) text.push(`note: ${l.command}: ${l.note}`);
      continue;
    }
    let line = `next: ${l.argv.map(shellQuote).join(" ")}`;
    if (l.optional.length > 0) {
      line += ` (add ${l.optional.map((o) => `${o.flag} when ${o.when}`).join("; ")})`;
    }
    if (l.placeholders.length > 0) {
      line += ` (replace ${l.placeholders.map((p) => `${p.name} with ${p.meaning}`).join("; ")})`;
    }
    text.push(line);
    if (l.note === BUILD_PREPARED_GUIDANCE) text.push(`note: ${l.command}: ${l.note}`);
  }
  return text.join("\n");
}

/** The runbook table, generated from RECOVERY_TABLE and pinned against
 *  docs/operations/server-update-and-rollback.md by a test. */
export function recoveryTableMarkdown() {
  const lines = ["| Phase | `update` | `rollback` |", "|---|---|---|"];
  const cell = (entries) => entries.map((e) => {
    const parts = [e.operation];
    if (e.condition) parts.push(`if ${e.condition}`);
    if (e.closure !== CLOSED) parts.push(e.closure);
    return parts.join(", ");
  }).join("; ");
  for (const phase of Object.values(PHASE)) {
    const row = RECOVERY_TABLE[phase];
    lines.push(`| ${phase} | ${cell(row.filter((e) => e.command === "update"))} | ${cell(row.filter((e) => e.command === "rollback"))} |`);
  }
  return lines.join("\n");
}
