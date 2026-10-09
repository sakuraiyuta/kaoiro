import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  readReleaseAuthority,
  releaseAuthorityRequest,
} from "./production-release-authority.mjs";
import { releaseRequest } from "./production-release-endpoint.mjs";
import {
  createPrivateDirectory,
  namedProcessIdentity,
  readPrivateBytes,
  readPrivateJson,
  releaseBytesDigest,
  requirePrivateDirectory,
  syncDirectory,
  withReleaseLock,
  writePrivateRecord,
} from "./production-release-files.mjs";
import {
  validateEnrollmentInventory,
  validateReleasePlan,
  validateRuntimeHosts,
} from "./production-release-plan.mjs";
import { validateReleaseSnapshot } from "./production-release-reconciliation.mjs";
import { RELEASE_ALIAS, RELEASE_UUID } from "./production-release-state.mjs";
import {
  unitSnapshot,
  unitCommandSnapshot,
  verifyRetainedUnitCommand,
} from "./production-release-unit.mjs";

const must = (condition, message) => {
  if (!condition) throw new Error(`runner release fact refused: ${message}`);
};

export function validateRunnerReleaseContext({ root, dir, alias, configPath }) {
  root = realpathSync(root);
  must(
    RELEASE_ALIAS.test(alias ?? "") &&
      RELEASE_UUID.test(dir?.split("/").at(-1) ?? "") &&
      resolve(dir) === join(root, "production-attempts", dir.split("/").at(-1)),
    "fixed private runner working-copy path required",
  );
  requirePrivateDirectory(join(root, "production-attempts"));
  requirePrivateDirectory(dir);
  const raw = readPrivateBytes(join(dir, "attempt.json"));
  const plan = validateReleasePlan(JSON.parse(raw), dir.split("/").at(-1));
  must(
    plan.authority && plan.runtime_hosts && plan.host_ids.includes(alias),
    "enrolled plan and private host inventory required",
  );
  const expected = plan.authority.runners.find(
    (owner) => owner.alias === alias,
  );
  must(
    expected?.root === root,
    "plan belongs to a different runner installation",
  );
  const authority = readReleaseAuthority(root, {
    expectedDigest: expected.sha256,
  });
  const pairs = validateRuntimeHosts(
    readPrivateJson(join(root, "release-host-aliases.json"), {
      privateParent: false,
    }),
  );
  const pair = pairs.find((pair) => pair.alias === alias);
  const planned = plan.runtime_hosts.find((pair) => pair.alias === alias);
  const config = readPrivateJson(configPath, {
    legacyMode: true,
    privateParent: false,
  });
  must(
    pair &&
      planned &&
      pair.runtime_host_id === planned.runtime_host_id &&
      pair.runtime_host_id === config.host_id,
    "live config/private alias map differs from the frozen inventory",
  );
  return {
    root,
    dir,
    alias,
    plan,
    plan_sha256: releaseBytesDigest(raw),
    authority,
  };
}

export function canonicalRunnerReleaseRow(context) {
  const snapshot = validateReleaseSnapshot(
    releaseAuthorityRequest(
      context.authority,
      releaseRequest(context.authority.descriptor),
    ),
  );
  const row = snapshot.rows.find(
    (row) => row.attempt_uuid === context.plan.attempt_uuid,
  );
  if (context.lifecycle) {
    const inventory = validateEnrollmentInventory(snapshot.inventory);
    must(
      row &&
        row.status === "invalid_completion" &&
        row.plan_sha256 === context.plan_sha256 &&
        row.lifecycle_row_sha256 === context.lifecycle_row_sha256 &&
        releaseBytesDigest(Buffer.from(`${JSON.stringify(inventory)}\n`)) ===
          context.inventory_sha256,
      "canonical invalid row/enrollment inventory changed",
    );
    return row;
  }
  must(
    row?.plan &&
      row.plan_sha256 === context.plan_sha256 &&
      row.plan.identity.revision === context.plan.identity.revision &&
      row.plan.authority?.runners.some(
        (owner) =>
          owner.alias === context.alias &&
          owner.sha256 === context.authority.sha256,
      ),
    "canonical plan/digest/authority changed",
  );
  return row;
}

export function validateRunnerLifecycleContext({
  root,
  uuid,
  alias,
  configPath,
}) {
  must(
    RELEASE_UUID.test(uuid ?? "") && RELEASE_ALIAS.test(alias ?? ""),
    "lifecycle UUID/alias required",
  );
  root = realpathSync(root);
  const authority = readReleaseAuthority(root);
  const snapshot = validateReleaseSnapshot(
    releaseAuthorityRequest(authority, releaseRequest(authority.descriptor)),
  );
  const row = snapshot.rows.find((row) => row.attempt_uuid === uuid);
  must(
    row &&
      row.disposition === "unresolved" &&
      (!row.completion || row.status === "invalid_completion"),
    "unfinished canonical UUID required",
  );
  if (row.plan && row.status !== "invalid_completion")
    return validateRunnerReleaseContext({
      root,
      dir: join(root, "production-attempts", uuid),
      alias,
      configPath,
    });
  const inventory = validateEnrollmentInventory(snapshot.inventory);
  const expected = inventory.authority.runners.find(
    (owner) => owner.alias === alias,
  );
  must(
    expected?.root === root && expected.sha256 === authority.sha256,
    "fixed lifecycle inventory authority differs",
  );
  const config = readPrivateJson(configPath, {
    legacyMode: true,
    privateParent: false,
  });
  const local = validateRuntimeHosts(
    readPrivateJson(join(root, "release-host-aliases.json"), {
      privateParent: false,
    }),
  );
  const pair = inventory.runtime_hosts.find((pair) => pair.alias === alias);
  must(
    pair &&
      local.some(
        (item) =>
          item.alias === alias && item.runtime_host_id === pair.runtime_host_id,
      ) &&
      config.host_id === pair.runtime_host_id,
    "fixed lifecycle inventory/live config differs",
  );
  return {
    root,
    dir: null,
    alias,
    plan: { attempt_uuid: uuid },
    plan_sha256: row.plan_sha256,
    authority,
    lifecycle: true,
    lifecycle_row_sha256: row.lifecycle_row_sha256,
    inventory_sha256: releaseBytesDigest(
      Buffer.from(`${JSON.stringify(inventory)}\n`),
    ),
  };
}

export function recordExecutedRunnerRelease(context, owner, audit) {
  const baseline = readPrivateJson(
    join(context.dir, `runner-baseline-${context.alias}.json`),
  );
  must(
    baseline.attempt_uuid === owner.release_context?.attempt_uuid &&
      baseline.plan_sha256 === context.plan_sha256 &&
      baseline.authority_sha256 === owner.authority_sha256 &&
      baseline.tool_sha256 === owner.tool_sha256 &&
      baseline.updater_tool === owner.updater &&
      baseline.updater_sha256 === owner.updater_sha256 &&
      baseline.source_revision === owner.source_revision &&
      baseline.target_revision === owner.expected_target,
    "executed worker differs from the frozen baseline",
  );
  const before = { ...baseline, executed_audit: audit };
  importRunnerReleaseFact(context, "before", before);
  writePrivateRecord(
    context.dir,
    `runner-before-${context.alias}.json`,
    before,
    { kind: "runner-fact" },
  );
  recordRunnerReleaseActivity(context, {
    state: "running",
    unit: baseline.updater,
    invocationId: owner.systemd_invocation_id,
    currentRevision: owner.source_revision,
  });
}

export function validateNativeRunnerInvocation(context, owner, unit) {
  const baseline = readPrivateJson(
    join(context.dir, `runner-baseline-${context.alias}.json`),
  );
  must(
    unit === baseline.updater &&
      unit ===
        `kaoiro-release-${context.plan.attempt_uuid}-${context.alias}.service`,
    "retained unit is not the canonical dedicated worker",
  );
  const observed = unitSnapshot(unit);
  must(
    observed.ActiveState === "activating" &&
      observed.SubState === "start" &&
      Number(observed.MainPID) === owner.ppid &&
      /^[0-9a-f]{32}$/.test(observed.InvocationID ?? "") &&
      observed.InvocationID === process.env.INVOCATION_ID &&
      observed.InvocationID !== baseline.previous_invocation,
    "actual retained invocation/parent differs from captured worker",
  );
  verifyRetainedUnitCommand(unitCommandSnapshot(unit), baseline.node_path, [
    baseline.node_path,
    baseline.launcher,
    "worker",
    baseline.tool_sha256,
    dirname(baseline.updater_tool),
    ...baseline.update_args,
  ]);
  return observed.InvocationID;
}

export function runnerReleaseFact(context, fields) {
  return {
    schema: 1,
    attempt_uuid: context.plan.attempt_uuid,
    alias: context.alias,
    root: context.root,
    authority_sha256: context.authority.sha256,
    tool_sha256: context.authority.descriptor.tool_sha256,
    plan_sha256: context.plan_sha256,
    simulation: false,
    ...fields,
  };
}

export function importRunnerReleaseFact(
  context,
  kind,
  fact,
  row = canonicalRunnerReleaseRow(context),
) {
  must(
    row.disposition === "unresolved" &&
      (!row.completion ||
        (context.lifecycle && row.status === "invalid_completion")),
    "canonical terminal attempt cannot accept runner evidence",
  );
  const request = releaseRequest(context.authority.descriptor, {
    attempt_uuid: context.plan.attempt_uuid,
    alias: context.alias,
    kind,
    plan_sha256: context.plan_sha256,
    row_sha256: row.row_sha256,
  });
  return releaseAuthorityRequest(context.authority, request, {
    operation: "import",
    fact,
  });
}

export function recordRunnerReleaseActivity(
  context,
  { state, unit, invocationId = null, currentRevision },
) {
  const row = canonicalRunnerReleaseRow(context);
  const previous = (
    context.lifecycle ? row.lifecycle_activity_heads : row.activity_heads
  ).find((head) => head.alias === context.alias);
  const fact = runnerReleaseFact(context, {
    event_uuid: randomUUID(),
    sequence: (previous?.sequence ?? 0) + 1,
    previous_sha256: previous?.sha256 ?? null,
    state,
    observed_at: new Date().toISOString(),
    current_revision: currentRevision,
    unit,
    invocation_id: invocationId,
    inventory_sha256: context.inventory_sha256 ?? null,
    ...(context.lifecycle
      ? { lifecycle_row_sha256: context.lifecycle_row_sha256 }
      : {}),
  });
  const imported = importRunnerReleaseFact(
    context,
    context.lifecycle ? "lifecycle-activity" : "activity",
    fact,
    row,
  );
  if (context.dir)
    writePrivateRecord(
      context.dir,
      `runner-activity-${context.alias}-${fact.event_uuid}.json`,
      fact,
      { kind: "activity" },
    );
  return { fact, sha256: imported.sha256 };
}

export function installRunnerReleasePlan({ root, raw, alias, configPath }) {
  root = realpathSync(root);
  must(
    Buffer.isBuffer(raw) && raw.length <= 524_288,
    "bounded private plan bytes required",
  );
  const value = JSON.parse(raw);
  const plan = validateReleasePlan(value, value.attempt_uuid);
  must(
    plan.authority && plan.host_ids.includes(alias),
    "enrolled target inventory required",
  );
  const owner = plan.authority.runners.find((owner) => owner.alias === alias);
  must(owner?.root === root, "plan belongs to another install root");
  const authority = readReleaseAuthority(root, {
    expectedDigest: owner.sha256,
  });
  const snapshot = validateReleaseSnapshot(
    releaseAuthorityRequest(authority, releaseRequest(authority.descriptor)),
  );
  const row = snapshot.rows.find(
    (row) => row.attempt_uuid === plan.attempt_uuid,
  );
  must(
    row?.plan_sha256 === releaseBytesDigest(raw) &&
      row.disposition === "unresolved" &&
      !row.completion,
    "copied plan is not the current canonical unfinished plan",
  );
  const parent = createPrivateDirectory(join(root, "production-attempts"));
  const dir = join(parent, plan.attempt_uuid);
  withReleaseLock(
    parent,
    "history",
    () => {
      if (existsSync(dir)) {
        must(
          releaseBytesDigest(readPrivateBytes(join(dir, "attempt.json"))) ===
            releaseBytesDigest(raw),
          "working plan is immutable",
        );
        return;
      }
      const staged = createPrivateDirectory(
        join(parent, `.start-${plan.attempt_uuid}`),
      );
      writePrivateRecord(
        staged,
        "owner.json",
        {
          schema: 1,
          invocation_uuid: plan.attempt_uuid,
          ...namedProcessIdentity(process.pid),
        },
        { kind: "owner", scope: "administrative" },
      );
      writePrivateRecord(staged, "attempt.json", raw, {
        kind: "plan",
        scope: "administrative",
      });
      unlinkSync(join(staged, "owner.json"));
      syncDirectory(staged);
      renameSync(staged, dir);
      syncDirectory(parent);
    },
    "root",
  );
  return validateRunnerReleaseContext({ root, dir, alias, configPath });
}
