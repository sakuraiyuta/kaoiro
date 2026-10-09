import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { RELEASE_ALIAS, RELEASE_DIGEST, RELEASE_UUID } from "./production-release-state.mjs";
import { readReleaseHistory, readReleaseAttempt, projectReleaseHistory } from "./production-release-history.mjs";
import { attemptDirectory, readPrivateJson, releaseBytesDigest, releaseJsonBytes, withAsyncReleaseLock,
  writePrivateRecord } from "./production-release-files.mjs";
import { validateRuntimeHosts } from "./production-release-plan.mjs";

const must = (value, message) => { if (!value) throw new Error(`release endpoint refused: ${message}`); };
const exact = (object, fields) => object && typeof object === "object" && !Array.isArray(object) &&
  Object.keys(object).sort().join() === [...fields].sort().join();
const REQUEST_FIELDS = ["schema", "nonce", "root", "recording_hostname", "tool_sha256"];

export function validateReleaseRequest(value, expectedTool, operation) {
  const fields = [...REQUEST_FIELDS, ...(operation === "import" ? ["attempt_uuid", "alias", "kind", "plan_sha256", "row_sha256"] : [])];
  must(exact(value, fields) && value.schema === 1 && typeof value.nonce === "string" && /^[0-9a-f]{32}$/.test(value.nonce) &&
    value.tool_sha256 === expectedTool && RELEASE_DIGEST.test(expectedTool), "strict request/nonce/closure");
  must(typeof value.root === "string" && value.root.startsWith("/") && resolve(value.root) === value.root &&
    value.recording_hostname === hostname(), "root or kernel recording-host role");
  if (operation === "import") {
    must(RELEASE_UUID.test(value.attempt_uuid ?? "") && RELEASE_ALIAS.test(value.alias ?? "") &&
      ["baseline", "before", "after", "activity"].includes(value.kind) &&
      (value.plan_sha256 === null || RELEASE_DIGEST.test(value.plan_sha256 ?? "")) && RELEASE_DIGEST.test(value.row_sha256 ?? ""), "import UUID/alias/kind/binding");
  }
  return value;
}

const COMMON_FACT = ["schema", "attempt_uuid", "alias", "root", "authority_sha256", "tool_sha256", "plan_sha256", "simulation"];
const FACT_FIELDS = {
  baseline: ["source_revision", "target_revision", "config_host_verified", "service", "updater", "updater_tool", "launcher", "launcher_sha256",
    "updater_sha256", "tool_root", "update_args", "previous_invocation", "created_at", "delay_seconds", "executed_audit"],
  before: ["source_revision", "target_revision", "config_host_verified", "service", "updater", "updater_tool", "launcher", "launcher_sha256",
    "updater_sha256", "tool_root", "update_args", "previous_invocation", "created_at", "delay_seconds", "executed_audit"],
  after: ["runner", "executed_audit", "config_host_verified"],
  activity: ["event_uuid", "sequence", "previous_sha256", "state", "observed_at", "current_revision", "unit", "invocation_id", "inventory_sha256"],
};

export async function importReleaseFact(request, fact) {
  const dir = attemptDirectory(request.root, request.attempt_uuid);
  return withAsyncReleaseLock(dir, "record", async () => {
    const row = readReleaseAttempt(dir);
    must(row.state.id !== "unknown_identity" && !["published", "abandoned", "invalid_quarantined", "deployed_uncompleted"].includes(row.state.id) &&
      !row.records["completion.json"], "closed or unidentified attempt cannot import facts");
    must(row.plan_sha256 === request.plan_sha256, "canonical plan changed");
    must(fact && fact.schema === 1 && typeof fact === "object" && !Array.isArray(fact) &&
      Object.keys(fact).every(name => [...COMMON_FACT, ...FACT_FIELDS[request.kind]].includes(name)) &&
      fact.attempt_uuid === request.attempt_uuid && fact.alias === request.alias && fact.plan_sha256 === request.plan_sha256 &&
      fact.simulation === false && RELEASE_DIGEST.test(fact.tool_sha256 ?? ""), "private fact schema/binding");
    let expected;
    if (row.plan?.authority) {
      expected = row.plan.authority.runners.find(owner => owner.alias === request.alias);
      must(expected && fact.root === expected.root && fact.authority_sha256 === expected.sha256, "fact does not attest expected enrolled root");
    } else {
      must(request.kind === "activity" && !row.plan, "valid production plan with expected authority required");
      const inventory = validateRuntimeHosts(readPrivateJson(`${request.root}-inventory.json`, { privateParent: false }));
      must(inventory.some(pair => pair.alias === request.alias) &&
        fact.inventory_sha256 === releaseBytesDigest(releaseJsonBytes(inventory)), "planless lifecycle inventory binding");
    }
    let filename = `runner-${request.kind}-${request.alias}.json`;
    if (request.kind === "activity") {
      must(RELEASE_UUID.test(fact.event_uuid ?? "") && Number.isInteger(fact.sequence) && fact.sequence >= 1 && fact.sequence <= 64 &&
        ["intent", "queued", "running", "idle", "unknown"].includes(fact.state), "activity event bounds/state");
      const events = Object.entries(row.records).filter(([name]) => name.startsWith(`runner-activity-${request.alias}-`))
        .sort(([, a], [, b]) => a.value.sequence - b.value.sequence);
      const previous = events.at(-1);
      filename = `runner-activity-${request.alias}-${fact.event_uuid}.json`;
      if (!row.records[filename]) must(fact.sequence === events.length + 1 && fact.previous_sha256 === (previous?.[1].sha256 ?? null), "activity sequence/previous digest changed");
    }
    if (!row.records[filename]) must(row.row_sha256 === request.row_sha256, "canonical row changed");
    const result = writePrivateRecord(dir, filename, fact, { kind: request.kind === "activity" ? "activity" : "runner-fact" });
    return { imported: true, attempt_uuid: request.attempt_uuid, alias: request.alias, kind: request.kind,
      sha256: result.sha256, reused: result.reused };
  });
}

export function releaseRequest(descriptor, additional = {}) {
  return { schema: 1, nonce: randomBytes(16).toString("hex"), root: descriptor.root,
    recording_hostname: descriptor.recording_hostname, tool_sha256: descriptor.tool_sha256, ...additional };
}

export async function runReleaseEndpoint(operation, expectedTool) {
  const timer = setTimeout(() => process.stdin.destroy(new Error("release endpoint deadline exceeded")), 15_000);
  timer.unref();
  try {
  const chunks = [];
  let bytes = 0;
  const limit = operation === "export" ? 4096 : 4096 + 524_288;
  const started = performance.now();
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    must(bytes <= limit && performance.now() - started < 15_000, "endpoint input bound/deadline");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const split = raw.indexOf("\n");
  must(split >= 0 && Buffer.byteLength(raw.slice(0, split + 1)) <= 4096, "bounded request header line required");
  const request = validateReleaseRequest(JSON.parse(raw.slice(0, split)), expectedTool, operation);
  let value;
  if (operation === "export") {
    must(raw.slice(split + 1) === "", "export cannot carry write payload");
    value = projectReleaseHistory(readReleaseHistory(request.root, { recordingHostname: request.recording_hostname }));
  } else {
    const payload = raw.slice(split + 1);
    must(Buffer.byteLength(payload) <= 524_288, "import fact bound");
    value = await importReleaseFact(request, JSON.parse(payload));
  }
  must(performance.now() - started < 15_000, "endpoint total deadline");
  const response = { ...value, schema: 1, nonce: request.nonce, root: request.root,
    recording_hostname: hostname(), tool_sha256: expectedTool, node_major: Number(process.versions.node.split(".")[0]) };
  const responseBytes = `${JSON.stringify(response)}\n`;
  must(Buffer.byteLength(responseBytes) <= (operation === "export" ? 32 * 1024 * 1024 : 65_536), "endpoint response bound");
  process.stdout.write(responseBytes);
  } finally { clearTimeout(timer); }
}
