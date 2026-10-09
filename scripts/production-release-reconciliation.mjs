#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  BUILD_REPOSITORY_ID,
  validateFrozenBuildIdentity,
} from "./build-identity.mjs";
import {
  readReleaseAuthority,
  releaseAuthorityRequest,
} from "./production-release-authority.mjs";
import { releaseRequest } from "./production-release-endpoint.mjs";
import {
  releaseBytesDigest,
  releaseJsonBytes,
} from "./production-release-files.mjs";
import { readPublishedProductionRelease } from "./production-release-tags.mjs";
import { validateProductionReceipt } from "./production-release-record.mjs";
import { validateEnrollmentProjection } from "./production-release-plan.mjs";
import {
  RELEASE_ALIAS,
  RELEASE_DIGEST,
  RELEASE_SHA,
  RELEASE_UUID,
  RELEASE_STATES,
  parseReleaseOptions,
  validateReleaseContext,
  validateReleaseReason,
  validateReleaseSkip,
} from "./production-release-state.mjs";

const must = (value, message) => {
  if (!value) throw new Error(`release reconciliation refused: ${message}`);
};
const exact = (value, fields) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join() === [...fields].sort().join();

export function validateReleaseSnapshot(snapshot) {
  must(
    exact(snapshot, [
      "schema",
      "nonce",
      "root",
      "recording_hostname",
      "tool_sha256",
      "node_major",
      "rows",
      "diagnostics",
      "warning",
      ...(Object.hasOwn(snapshot, "inventory") ? ["inventory"] : []),
      ...(Object.hasOwn(snapshot, "archived_incidents")
        ? ["archived_incidents"]
        : []),
    ]) &&
      snapshot.schema === 1 &&
      Array.isArray(snapshot.rows) &&
      snapshot.rows.length <= 1000 &&
      Array.isArray(snapshot.diagnostics) &&
      snapshot.diagnostics.length <= 4096,
    "snapshot schema/capacity",
  );
  if (snapshot.inventory !== undefined && snapshot.inventory !== null)
    validateEnrollmentProjection(snapshot.inventory);
  if (snapshot.archived_incidents !== undefined) {
    must(
      Array.isArray(snapshot.archived_incidents) &&
        snapshot.archived_incidents.length <= 100_000,
      "archived incident inventory bound",
    );
    const seen = new Set();
    for (const incident of snapshot.archived_incidents) {
      must(
        exact(incident, [
          "attempt_uuid",
          "status",
          "reason",
          "evidence_sha256",
        ]) &&
          RELEASE_UUID.test(incident.attempt_uuid ?? "") &&
          !seen.has(incident.attempt_uuid) &&
          ["invalid_quarantined", "deployed_uncompleted"].includes(
            incident.status,
          ) &&
          RELEASE_DIGEST.test(incident.evidence_sha256 ?? ""),
        "archived incident binding",
      );
      validateReleaseReason(incident.reason);
      seen.add(incident.attempt_uuid);
    }
  }
  const ids = new Set();
  for (const row of snapshot.rows) {
    must(
      exact(row, [
        "attempt_uuid",
        "plan_sha256",
        "row_sha256",
        "plan",
        "status",
        "disposition",
        "completion",
        "activity_heads",
        ...(Object.hasOwn(row, "lifecycle_row_sha256")
          ? ["lifecycle_row_sha256", "lifecycle_activity_heads"]
          : []),
      ]) &&
        RELEASE_UUID.test(row.attempt_uuid ?? "") &&
        !ids.has(row.attempt_uuid) &&
        RELEASE_DIGEST.test(row.row_sha256 ?? "") &&
        (row.plan_sha256 === null ||
          RELEASE_DIGEST.test(row.plan_sha256 ?? "")),
      "snapshot row identity/digest",
    );
    if (Object.hasOwn(row, "lifecycle_row_sha256"))
      must(
        RELEASE_DIGEST.test(row.lifecycle_row_sha256 ?? "") &&
          Array.isArray(row.lifecycle_activity_heads) &&
          row.lifecycle_activity_heads.length <= 16 &&
          row.lifecycle_activity_heads.every(
            (head) =>
              RELEASE_ALIAS.test(head.alias ?? "") &&
              Number.isInteger(head.sequence) &&
              head.sequence > 0 &&
              head.sequence <= 64 &&
              RELEASE_DIGEST.test(head.sha256 ?? "") &&
              ["intent", "queued", "running", "idle", "unknown"].includes(
                head.state,
              ),
          ),
        "lifecycle activity heads/binding",
      );
    ids.add(row.attempt_uuid);
    const state = RELEASE_STATES.find((state) => state.id === row.status);
    must(
      state &&
        state.disposition === row.disposition &&
        state.disposition !== "refuse",
      "snapshot state is unknown or contradictory",
    );
    if (row.plan) {
      must(
        exact(row.plan, [
          "schema",
          "attempt_uuid",
          "identity",
          "host_ids",
          "codex_host_ids",
          "created_at",
          "authority",
        ]) &&
          row.plan.schema === 1 &&
          row.plan.attempt_uuid === row.attempt_uuid &&
          row.plan_sha256,
        "projected plan fields/binding",
      );
      validateFrozenBuildIdentity(row.plan.identity);
      const hosts = row.plan.host_ids;
      must(
        Array.isArray(hosts) &&
          hosts.length >= 1 &&
          hosts.length <= 16 &&
          hosts.every((host) => RELEASE_ALIAS.test(host)) &&
          new Set(hosts).size === hosts.length &&
          Array.isArray(row.plan.codex_host_ids) &&
          row.plan.codex_host_ids.every((host) => hosts.includes(host)) &&
          new Set(row.plan.codex_host_ids).size ===
            row.plan.codex_host_ids.length,
        "projected alias inventory",
      );
      if (row.plan.authority) {
        must(
          exact(row.plan.authority, ["server", "runners"]) &&
            exact(row.plan.authority.server, ["sha256"]) &&
            RELEASE_DIGEST.test(row.plan.authority.server.sha256) &&
            Array.isArray(row.plan.authority.runners) &&
            row.plan.authority.runners.length === hosts.length &&
            new Set(row.plan.authority.runners.map((item) => item.alias))
              .size === hosts.length &&
            row.plan.authority.runners.every(
              (item) =>
                exact(item, ["alias", "sha256"]) &&
                hosts.includes(item.alias) &&
                RELEASE_DIGEST.test(item.sha256),
            ),
          "projected expected enrollment",
        );
      }
    } else
      must(
        row.plan_sha256 === null ||
          ["invalid_completion", "invalid_quarantined"].includes(row.status),
        "missing plan status",
      );
    if (row.completion) {
      must(
        row.plan &&
          row.completion.attempt_uuid === row.attempt_uuid &&
          row.completion.revision === row.plan.identity.revision &&
          row.completion.version === row.plan.identity.version &&
          row.completion.branch === row.plan.identity.branch,
        "completion differs from projected plan",
      );
      validateProductionReceipt(row.completion, {
        repositoryId: BUILD_REPOSITORY_ID,
        allowedHosts: row.plan.host_ids,
      });
    }
    must(
      Array.isArray(row.activity_heads) &&
        row.activity_heads.length <= 16 &&
        row.activity_heads.every(
          (head) =>
            exact(head, ["alias", "sequence", "sha256", "state"]) &&
            RELEASE_ALIAS.test(head.alias) &&
            Number.isInteger(head.sequence) &&
            head.sequence >= 1 &&
            head.sequence <= 64 &&
            RELEASE_DIGEST.test(head.sha256) &&
            ["intent", "queued", "running", "idle", "unknown"].includes(
              head.state,
            ),
        ),
      "activity head projection",
    );
  }
  must(
    snapshot.diagnostics.every(
      (item) =>
        exact(item, ["name", "status", "command"]) &&
        item.status === "administrative" &&
        typeof item.name === "string" &&
        typeof item.command === "string",
    ),
    "administrative diagnostics",
  );
  return snapshot;
}

export function selectOwnReleaseAttempt(
  snapshot,
  context,
  { authority, role, targetRevision, alias } = {},
) {
  if (!context) return null;
  const row = snapshot.rows.find(
    (row) => row.attempt_uuid === context.attempt_uuid,
  );
  must(
    row &&
      row.plan &&
      row.plan_sha256 === context.plan_sha256 &&
      row.plan.identity.revision === targetRevision &&
      row.plan.identity.landing?.repository_id === BUILD_REPOSITORY_ID &&
      row.plan.authority,
    "own attempt plan/digest/target differs from canonical plan",
  );
  must(
    !row.completion &&
      row.disposition === "unresolved" &&
      ["in_progress", "rollout_active", "deployed_incomplete"].includes(
        row.status,
      ),
    "own attempt is invalid or terminal",
  );
  const expected =
    role === "server"
      ? row.plan.authority.server
      : row.plan.authority.runners.find((item) => item.alias === alias);
  must(
    expected?.sha256 === authority.sha256,
    "own attempt expected authority differs",
  );
  return row.attempt_uuid;
}

export function assertReleaseUnresolved(unresolved, skip = []) {
  must(
    unresolved.every((uuid) => skip.includes(uuid)),
    `unresolved attempts: ${unresolved.join(",")}; dispatch/complete, guarded terminal command, or exact UUID skip required`,
  );
}

export async function reconcileProductionReleases({
  installRoot,
  role = "runner",
  repository,
  targetRevision,
  alias,
  assertionPath,
  expectedAuthorityDigest,
  attemptUuid,
  planDigest,
  skipCsv,
  skipReason,
  dryRun = false,
  remote = "origin",
  timeoutMs = 120_000,
  authorityReader = readReleaseAuthority,
  authorityRequest = releaseAuthorityRequest,
  publicationReader = readPublishedProductionRelease,
  gitCommand,
} = {}) {
  const started = performance.now();
  must(
    timeoutMs > 0 &&
      timeoutMs <= 120_000 &&
      ["server", "runner", "card"].includes(role),
    "role/audit deadline",
  );
  const remaining = (cap) => {
    const value = Math.floor(timeoutMs - (performance.now() - started));
    must(value > 0, "whole audit deadline exceeded");
    return Math.min(cap, value);
  };
  const context = validateReleaseContext(attemptUuid, planDigest);
  const skip = validateReleaseSkip(skipCsv, skipReason);
  must(
    role !== "card" || (!context && skip.length === 0),
    "card cannot exempt its own completion or skip",
  );
  if (context)
    must(
      RELEASE_SHA.test(targetRevision ?? "") &&
        (role !== "runner" || RELEASE_ALIAS.test(alias ?? "")),
      "own target/alias required",
    );
  const authority = authorityReader(installRoot, {
    role: role === "card" ? "server" : role,
    assertionPath,
    expectedDigest: expectedAuthorityDigest,
  });
  if (authority.status === "generic") {
    must(
      !context && skip.length === 0,
      "unenrolled installation cannot assert production context/skip",
    );
    return { schema: 1, status: "generic", pass: true, role };
  }
  let snapshot;
  for (let retry = 0; retry <= 2; retry++) {
    try {
      const request = releaseRequest(authority.descriptor);
      snapshot = validateReleaseSnapshot(
        authorityRequest(authority, request, { timeoutMs: remaining(20_000) }),
      );
      break;
    } catch (error) {
      if (error.message !== "snapshot_changed" || retry === 2) throw error;
      remaining(120_000);
      await delay(100);
    }
  }
  const own = selectOwnReleaseAttempt(snapshot, context, {
    authority,
    role,
    targetRevision,
    alias,
  });
  const runGit = (cwd, args) => {
    const timeout = remaining(15_000);
    return gitCommand
      ? gitCommand(cwd, args, timeout)
      : execFileSync("git", args, {
          cwd,
          timeout,
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
  };
  const receipts = snapshot.rows.filter(
    (row) =>
      row.completion &&
      ["publication_unconfirmed", "publication_missing", "published"].includes(
        row.status,
      ),
  );
  let inventory;
  if (receipts.length) {
    must(
      repository,
      "--release-repo data checkout required for completed attempts",
    );
    if (!dryRun) runGit(repository, ["fetch", "--tags", remote]);
    inventory = runGit(repository, [
      "ls-remote",
      "--refs",
      "--tags",
      remote,
    ]).split("\n");
  }
  const unresolved = [];
  const resolved = [];
  const incidents = (snapshot.archived_incidents ?? []).map(
    (incident) => incident.attempt_uuid,
  );
  for (const row of snapshot.rows) {
    remaining(120_000);
    if (row.disposition === "terminal-incident") {
      incidents.push(row.attempt_uuid);
      continue;
    }
    if (row.disposition === "resolved") {
      resolved.push(row.attempt_uuid);
      continue;
    }
    if (row.attempt_uuid === own) continue;
    if (
      row.completion &&
      ["publication_unconfirmed", "publication_missing", "published"].includes(
        row.status,
      )
    ) {
      try {
        publicationReader({
          cwd: repository,
          receipt: row.completion,
          allowedHosts: row.plan.host_ids,
          remote,
          refresh: false,
          remoteInventory: inventory,
          gitReader: runGit,
        });
        resolved.push(row.attempt_uuid);
        continue;
      } catch (error) {
        if (
          error.signal ||
          error.code === "ETIMEDOUT" ||
          error.message.includes("deadline")
        )
          throw error;
      }
    }
    unresolved.push(row.attempt_uuid);
  }
  assertReleaseUnresolved(unresolved, skip);
  remaining(120_000);
  const incidentSummary = {
    incident_count: incidents.length,
    incidents_sha256: releaseBytesDigest(releaseJsonBytes(incidents)),
    incidents: incidents.slice(0, 128),
    archived_incidents:
      role === "card" ? (snapshot.archived_incidents ?? []) : [],
  };
  return {
    schema: 1,
    status: "enrolled",
    pass: true,
    role,
    root: authority.root,
    authority_sha256: authority.sha256,
    canonical_root: snapshot.root,
    recording_hostname: snapshot.recording_hostname,
    tool_sha256: authority.descriptor.tool_sha256,
    release_context: context,
    snapshot_sha256: releaseBytesDigest(releaseJsonBytes(snapshot)),
    unresolved,
    skip,
    skip_reason: skipReason ?? null,
    resolved,
    ...incidentSummary,
    warning: snapshot.warning,
    elapsed_ms: Math.ceil(performance.now() - started),
    audited_at: new Date().toISOString(),
  };
}

export async function runReconciliationCli(args) {
  const flags = parseReleaseOptions(args, [
    "install-root",
    "role",
    "repo",
    "target-sha",
    "alias",
    "release-authority",
    "expected-authority-sha256",
    "release-attempt",
    "release-plan-sha256",
    "skip-release-reconciliation",
    "skip-reason",
    "dry-run",
  ]);
  const result = await reconcileProductionReleases({
    installRoot: flags["install-root"],
    role: flags.role,
    repository: flags.repo,
    targetRevision: flags["target-sha"],
    alias: flags.alias,
    assertionPath: flags["release-authority"],
    expectedAuthorityDigest: flags["expected-authority-sha256"],
    attemptUuid: flags["release-attempt"],
    planDigest: flags["release-plan-sha256"],
    skipCsv: flags["skip-release-reconciliation"],
    skipReason: flags["skip-reason"],
    dryRun: flags["dry-run"] === "true",
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await runReconciliationCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 78;
  }
}
