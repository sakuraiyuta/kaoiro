import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  RELEASE_ALIAS,
  RELEASE_DIGEST,
  RELEASE_SHA,
  RELEASE_UUID,
} from "./production-release-state.mjs";
import {
  readReleaseHistory,
  readReleaseAttempt,
  projectReleaseHistory,
} from "./production-release-history.mjs";
import {
  attemptDirectory,
  readPrivateJson,
  releaseBytesDigest,
  releaseJsonBytes,
  withAsyncReleaseLock,
  writePrivateRecord,
} from "./production-release-files.mjs";
import { validateEnrollmentInventory } from "./production-release-plan.mjs";
import { validateProductionRunner } from "./production-release-record.mjs";

const must = (value, message) => {
  if (!value) throw new Error(`release endpoint refused: ${message}`);
};
const exact = (object, fields) =>
  object &&
  typeof object === "object" &&
  !Array.isArray(object) &&
  Object.keys(object).sort().join() === [...fields].sort().join();
const REQUEST_FIELDS = [
  "schema",
  "nonce",
  "root",
  "recording_hostname",
  "tool_sha256",
];

export function validateReleaseRequest(value, expectedTool, operation) {
  const fields = [
    ...REQUEST_FIELDS,
    ...(operation === "import"
      ? ["attempt_uuid", "alias", "kind", "plan_sha256", "row_sha256"]
      : []),
  ];
  must(
    exact(value, fields) &&
      value.schema === 1 &&
      typeof value.nonce === "string" &&
      /^[0-9a-f]{32}$/.test(value.nonce) &&
      value.tool_sha256 === expectedTool &&
      RELEASE_DIGEST.test(expectedTool),
    "strict request/nonce/closure",
  );
  must(
    typeof value.root === "string" &&
      value.root.startsWith("/") &&
      resolve(value.root) === value.root &&
      value.recording_hostname === hostname(),
    "root or kernel recording-host role",
  );
  if (operation === "import") {
    must(
      RELEASE_UUID.test(value.attempt_uuid ?? "") &&
        RELEASE_ALIAS.test(value.alias ?? "") &&
        [
          "baseline",
          "before",
          "after",
          "activity",
          "lifecycle-activity",
        ].includes(value.kind) &&
        (value.plan_sha256 === null ||
          RELEASE_DIGEST.test(value.plan_sha256 ?? "")) &&
        RELEASE_DIGEST.test(value.row_sha256 ?? ""),
      "import UUID/alias/kind/binding",
    );
  }
  return value;
}

const COMMON_FACT = [
  "schema",
  "attempt_uuid",
  "alias",
  "root",
  "authority_sha256",
  "tool_sha256",
  "plan_sha256",
  "simulation",
];
const FACT_FIELDS = {
  baseline: [
    "source_revision",
    "target_revision",
    "config_host_verified",
    "service",
    "updater",
    "updater_tool",
    "launcher",
    "launcher_sha256",
    "updater_sha256",
    "tool_root",
    "node_path",
    "update_args",
    "previous_invocation",
    "created_at",
    "delay_seconds",
    "executed_audit",
  ],
  before: [
    "source_revision",
    "target_revision",
    "config_host_verified",
    "service",
    "updater",
    "updater_tool",
    "launcher",
    "launcher_sha256",
    "updater_sha256",
    "tool_root",
    "node_path",
    "update_args",
    "previous_invocation",
    "created_at",
    "delay_seconds",
    "executed_audit",
  ],
  after: ["runner", "executed_audit", "config_host_verified"],
  activity: [
    "event_uuid",
    "sequence",
    "previous_sha256",
    "state",
    "observed_at",
    "current_revision",
    "unit",
    "invocation_id",
    "inventory_sha256",
  ],
};
FACT_FIELDS["lifecycle-activity"] = [
  ...FACT_FIELDS.activity,
  "lifecycle_row_sha256",
];

export function validateNativeRunnerFact(fact, kind, plan) {
  must(
    exact(fact, [...COMMON_FACT, ...FACT_FIELDS[kind]]),
    "complete private fact fields required",
  );
  must(
    fact.schema === 1 &&
      RELEASE_UUID.test(fact.attempt_uuid ?? "") &&
      RELEASE_ALIAS.test(fact.alias ?? "") &&
      fact.simulation === false &&
      RELEASE_DIGEST.test(fact.authority_sha256 ?? "") &&
      RELEASE_DIGEST.test(fact.tool_sha256 ?? "") &&
      typeof fact.root === "string" &&
      resolve(fact.root) === fact.root &&
      (kind === "lifecycle-activity"
        ? (fact.plan_sha256 === null ||
            RELEASE_DIGEST.test(fact.plan_sha256 ?? "")) &&
          RELEASE_DIGEST.test(fact.lifecycle_row_sha256 ?? "")
        : RELEASE_DIGEST.test(fact.plan_sha256 ?? "")),
    "private native fact identity/authority/binding",
  );
  const timestamp = (value) =>
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
  if (kind === "activity" || kind === "lifecycle-activity") {
    must(
      RELEASE_UUID.test(fact.event_uuid ?? "") &&
        Number.isInteger(fact.sequence) &&
        fact.sequence >= 1 &&
        fact.sequence <= 64 &&
        (fact.previous_sha256 === null ||
          RELEASE_DIGEST.test(fact.previous_sha256 ?? "")) &&
        ["intent", "queued", "running", "idle", "unknown"].includes(
          fact.state,
        ) &&
        (fact.inventory_sha256 === null ||
          RELEASE_DIGEST.test(fact.inventory_sha256 ?? "")) &&
        timestamp(fact.observed_at) &&
        RELEASE_SHA.test(fact.current_revision ?? "") &&
        fact.unit ===
          `kaoiro-release-${fact.attempt_uuid}-${fact.alias}.service` &&
        (fact.invocation_id === null ||
          /^[0-9a-f]{32}$/.test(fact.invocation_id ?? "")),
      "bound native activity observation required",
    );
    return;
  }
  const audit = fact.executed_audit;
  must(
    fact.config_host_verified === true &&
      audit?.schema === 1 &&
      audit.pass === true &&
      audit.role === "runner" &&
      audit.root === fact.root &&
      audit.authority_sha256 === fact.authority_sha256 &&
      audit.tool_sha256 === fact.tool_sha256 &&
      audit.release_context?.attempt_uuid === fact.attempt_uuid &&
      audit.release_context.plan_sha256 === fact.plan_sha256,
    "executed enrolled audit differs from private fact",
  );
  if (kind === "after") {
    validateProductionRunner(
      fact.runner,
      plan.identity,
      plan.codex_host_ids.includes(fact.alias),
    );
    must(
      fact.runner.host_id === fact.alias &&
        Date.parse(fact.runner.worker_started_at) >=
          Date.parse(plan.created_at),
      "runner fact target/alias/start differs",
    );
    return;
  }
  const deploy = join(
    fact.root,
    "releases",
    fact.source_revision ?? "",
    "deploy",
  );
  must(
    RELEASE_SHA.test(fact.source_revision ?? "") &&
      fact.target_revision === plan.identity.revision &&
      fact.updater_tool === join(deploy, "kaoiro-runner-update.sh") &&
      fact.tool_root === join(deploy, "release-tools") &&
      fact.launcher ===
        join(fact.tool_root, "scripts/production-release-launcher.mjs") &&
      RELEASE_DIGEST.test(fact.launcher_sha256 ?? "") &&
      RELEASE_DIGEST.test(fact.updater_sha256 ?? "") &&
      typeof fact.node_path === "string" &&
      fact.node_path.startsWith("/") &&
      fact.updater ===
        `kaoiro-release-${fact.attempt_uuid}-${fact.alias}.service` &&
      Array.isArray(fact.update_args) &&
      fact.update_args.length >= 2 &&
      fact.update_args.length <= 32 &&
      fact.update_args.every(
        (value) =>
          typeof value === "string" &&
          value.length > 0 &&
          Buffer.byteLength(value) <= 4096 &&
          !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value),
      ) &&
      timestamp(fact.created_at) &&
      Date.parse(fact.created_at) >= Date.parse(plan.created_at) &&
      Number.isInteger(fact.delay_seconds) &&
      fact.delay_seconds >= 1 &&
      fact.delay_seconds <= 86_400,
    "captured native worker command/source/target is incomplete",
  );
}

export async function importReleaseFact(request, fact) {
  const dir = attemptDirectory(request.root, request.attempt_uuid);
  return withAsyncReleaseLock(dir, "record", async () => {
    const row = readReleaseAttempt(dir);
    must(
      row.state.id !== "unknown_identity" &&
        ![
          "published",
          "abandoned",
          "invalid_quarantined",
          "deployed_uncompleted",
        ].includes(row.state.id) &&
        (!row.records["completion.json"] ||
          (request.kind === "lifecycle-activity" &&
            row.state.id === "invalid_completion")),
      "closed or unidentified attempt cannot import facts",
    );
    must(row.plan_sha256 === request.plan_sha256, "canonical plan changed");
    must(
      fact &&
        fact.schema === 1 &&
        typeof fact === "object" &&
        !Array.isArray(fact) &&
        Object.keys(fact).every((name) =>
          [...COMMON_FACT, ...FACT_FIELDS[request.kind]].includes(name),
        ) &&
        fact.attempt_uuid === request.attempt_uuid &&
        fact.alias === request.alias &&
        fact.plan_sha256 === request.plan_sha256 &&
        fact.simulation === false &&
        RELEASE_DIGEST.test(fact.tool_sha256 ?? ""),
      "private fact schema/binding",
    );
    let expected;
    if (row.plan?.authority && request.kind !== "lifecycle-activity") {
      must(
        request.kind !== "lifecycle-activity",
        "valid plans use ordinary activity",
      );
      expected = row.plan.authority.runners.find(
        (owner) => owner.alias === request.alias,
      );
      must(
        expected &&
          fact.root === expected.root &&
          fact.authority_sha256 === expected.sha256,
        "fact does not attest expected enrolled root",
      );
      validateNativeRunnerFact(fact, request.kind, row.plan);
    } else {
      must(
        request.kind === "lifecycle-activity" &&
          row.state.id === "invalid_completion",
        "valid production plan with expected authority required",
      );
      const inventory = validateEnrollmentInventory(
        readPrivateJson(`${request.root}-inventory.json`, {
          privateParent: false,
        }),
      );
      const owner = inventory.authority.runners.find(
        (owner) => owner.alias === request.alias,
      );
      must(
        owner &&
          fact.lifecycle_row_sha256 === row.lifecycle_row_sha256 &&
          fact.root === owner.root &&
          fact.authority_sha256 === owner.sha256 &&
          fact.inventory_sha256 ===
            releaseBytesDigest(releaseJsonBytes(inventory)),
        "planless lifecycle inventory binding",
      );
      validateNativeRunnerFact(fact, request.kind);
    }
    let filename = `runner-${request.kind}-${request.alias}.json`;
    const activityPrefix =
      request.kind === "lifecycle-activity"
        ? "runner-lifecycle-activity"
        : "runner-activity";
    if (request.kind === "activity" || request.kind === "lifecycle-activity") {
      must(
        RELEASE_UUID.test(fact.event_uuid ?? "") &&
          Number.isInteger(fact.sequence) &&
          fact.sequence >= 1 &&
          fact.sequence <= 64 &&
          ["intent", "queued", "running", "idle", "unknown"].includes(
            fact.state,
          ),
        "activity event bounds/state",
      );
      const events = Object.entries(row.records)
        .filter(([name]) =>
          name.startsWith(`${activityPrefix}-${request.alias}-`),
        )
        .sort(([, a], [, b]) => a.value.sequence - b.value.sequence);
      const previous = events.at(-1);
      filename = `${activityPrefix}-${request.alias}-${fact.event_uuid}.json`;
      if (!row.records[filename])
        must(
          fact.sequence === events.length + 1 &&
            fact.previous_sha256 === (previous?.[1].sha256 ?? null),
          "activity sequence/previous digest changed",
        );
    }
    if (!row.records[filename])
      must(row.row_sha256 === request.row_sha256, "canonical row changed");
    const result = writePrivateRecord(dir, filename, fact, {
      kind: request.kind.endsWith("activity") ? "activity" : "runner-fact",
    });
    return {
      imported: true,
      attempt_uuid: request.attempt_uuid,
      alias: request.alias,
      kind: request.kind,
      sha256: result.sha256,
      reused: result.reused,
    };
  });
}

export function releaseRequest(descriptor, additional = {}) {
  return {
    schema: 1,
    nonce: randomBytes(16).toString("hex"),
    root: descriptor.root,
    recording_hostname: descriptor.recording_hostname,
    tool_sha256: descriptor.tool_sha256,
    ...additional,
  };
}

export async function runReleaseEndpoint(operation, expectedTool, expectedRoot) {
  must(typeof expectedRoot === "string" && expectedRoot.startsWith("/") &&
    resolve(expectedRoot) === expectedRoot, "fixed authority root required");
  const timer = setTimeout(
    () =>
      process.stdin.destroy(new Error("release endpoint deadline exceeded")),
    15_000,
  );
  timer.unref();
  try {
    const chunks = [];
    let bytes = 0;
    const limit = operation === "export" ? 4096 : 4096 + 524_288;
    const started = performance.now();
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      must(
        bytes <= limit && performance.now() - started < 15_000,
        "endpoint input bound/deadline",
      );
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    const split = raw.indexOf("\n");
    must(
      split >= 0 && Buffer.byteLength(raw.slice(0, split + 1)) <= 4096,
      "bounded request header line required",
    );
    const request = validateReleaseRequest(
      JSON.parse(raw.slice(0, split)),
      expectedTool,
      operation,
    );
    must(request.root === expectedRoot, "request root differs from fixed authority root");
    let value;
    if (operation === "export") {
      must(raw.slice(split + 1) === "", "export cannot carry write payload");
      value = projectReleaseHistory(
        readReleaseHistory(request.root, {
          recordingHostname: request.recording_hostname,
        }),
      );
    } else {
      const payload = raw.slice(split + 1);
      must(Buffer.byteLength(payload) <= 524_288, "import fact bound");
      value = await importReleaseFact(request, JSON.parse(payload));
    }
    must(performance.now() - started < 15_000, "endpoint total deadline");
    const response = {
      ...value,
      schema: 1,
      nonce: request.nonce,
      root: request.root,
      recording_hostname: hostname(),
      tool_sha256: expectedTool,
      node_major: Number(process.versions.node.split(".")[0]),
    };
    const responseBytes = `${JSON.stringify(response)}\n`;
    must(
      Buffer.byteLength(responseBytes) <=
        (operation === "export" ? 32 * 1024 * 1024 : 65_536),
      "endpoint response bound",
    );
    process.stdout.write(responseBytes);
  } finally {
    clearTimeout(timer);
  }
}
