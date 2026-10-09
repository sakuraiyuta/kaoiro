import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { BUILD_REPOSITORY_ID, parseLandingVersion, validateFrozenBuildIdentity } from "./build-identity.mjs";
import { acquireLock, releaseLock } from "../server/deploy/kaoiro-deploy-lock.mjs";
import { writeFileDurably } from "../server/deploy/kaoiro-deploy-atomic-write.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const IMAGE = /^sha256:[0-9a-f]{64}$/;
export const receiptDigest = value => createHash("sha256").update(`${JSON.stringify(value)}\n`).digest("hex");
const require = (condition, message) => { if (!condition) throw new Error(`production release refused: ${message}`); };
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const text = value => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const fullSha = value => typeof value === "string" && value.length === 40 && SHA.test(value);
const digest = value => typeof value === "string" && value.length === 64 && HASH.test(value);
const utc = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const sameIdentity = (value, identity) => value.revision === identity.revision && value.version === identity.version && value.branch === identity.branch && value.dirty === false;
export function validateProductionReceipt(value, { repositoryId = BUILD_REPOSITORY_ID, allowedHosts = [] } = {}) {
  require(Buffer.byteLength(JSON.stringify(value)) <= 16_384, "receipt exceeds byte bound");
  require(exact(value, ["schema", "kind", "environment", "publication_mode", "repository_id", "attempt_uuid", "revision", "version", "branch", "completed_at", "host_ids", "codex_host_ids", "server", "runners", "canary"]), "receipt fields");
  require(value.schema === 1 && value.kind === "production_completion" && value.environment === "production" &&
    value.publication_mode === "by_landing" && value.repository_id === repositoryId && UUID.test(value.attempt_uuid), "receipt authority");
  require(fullSha(value.revision) && parseLandingVersion(value.version) && value.branch === "develop" && utc(value.completed_at), "target identity");
  require(Array.isArray(value.host_ids) && value.host_ids.length > 0 && value.host_ids.length <= 16 &&
    new Set(value.host_ids).size === value.host_ids.length && value.host_ids.every(id => text(id) && allowedHosts.includes(id)), "required host inventory");
  require(Array.isArray(value.codex_host_ids) && new Set(value.codex_host_ids).size === value.codex_host_ids.length &&
    value.codex_host_ids.every(id => value.host_ids.includes(id)), "Codex host inventory must be a subset of required hosts");
  const server = value.server;
  require(exact(server, ["transaction_id", "image_id", "container_id", "health_revision", "health_dirty", "stability_passed", "journal_sha256", "manifest_sha256"]), "server fields");
  require(text(server.transaction_id) && IMAGE.test(server.image_id) && text(server.container_id) &&
    server.health_revision === value.revision && server.health_dirty === false && server.stability_passed === true &&
    digest(server.journal_sha256) && digest(server.manifest_sha256), "server DONE/stability leg");
  require(Array.isArray(value.runners) && value.runners.length === value.host_ids.length &&
    new Set(value.runners.map(item => item.host_id)).size === value.host_ids.length, "runner inventory");
  for (const runner of value.runners) {
    require(exact(runner, ["host_id", "revision", "version", "branch", "dirty", "unit", "update_invocation_id", "service_active", "worker_exit", "worker_started_at", "worker_finished_at", "artifact_sha256", "codex"]), "runner fields");
    require(value.host_ids.includes(runner.host_id) && sameIdentity(runner, value) && text(runner.unit) &&
      /^[0-9a-f]{32}$/.test(runner.update_invocation_id) && runner.service_active === true && runner.worker_exit === 0 &&
      utc(runner.worker_started_at) && utc(runner.worker_finished_at) &&
      Date.parse(runner.worker_finished_at) >= Date.parse(runner.worker_started_at) && digest(runner.artifact_sha256), "actual forward worker leg");
    if(value.codex_host_ids.includes(runner.host_id)) {
      require(exact(runner.codex, ["transaction_id", "evidence_sha256", "accepted_at"]) && text(runner.codex.transaction_id) &&
        digest(runner.codex.evidence_sha256) && utc(runner.codex.accepted_at), "Codex acceptance leg");
    } else require(runner.codex === null, "non-Codex host must not carry a fabricated acceptance");
  }
  const canary = value.canary;
  require(exact(canary, ["passed", "operator", "revision", "completed_at", "evidence_sha256"]) && canary.passed === true &&
    text(canary.operator) && canary.revision === value.revision && utc(canary.completed_at) &&
    Date.parse(value.completed_at) >= Date.parse(canary.completed_at) && digest(canary.evidence_sha256), "operator canary leg");
  require(value.runners.every(item => Date.parse(value.completed_at) >= Math.max(Date.parse(item.worker_finished_at), item.codex ? Date.parse(item.codex.accepted_at) : 0)), "completion clock");
  return value;
}

export function startReleaseAttempt(root, identity, hostIds, codexHostIds = hostIds) {
  validateFrozenBuildIdentity(identity);
  require(parseLandingVersion(identity.version) && !identity.dirty && fullSha(identity.revision), "tagged clean artifact required before operations");
  require(Array.isArray(hostIds) && hostIds.length > 0 && hostIds.length <= 16 && new Set(hostIds).size === hostIds.length && hostIds.every(text), "execution-card inventory");
  require(Array.isArray(codexHostIds) && new Set(codexHostIds).size === codexHostIds.length && codexHostIds.every(id => hostIds.includes(id)), "Codex host inventory must be a subset of required hosts");
  const uuid = randomUUID();
  const dir = join(root, uuid);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const plan = { schema: 1, attempt_uuid: uuid, identity, host_ids: [...hostIds].sort(), codex_host_ids: [...codexHostIds].sort(), created_at: new Date().toISOString() };
  writeFileDurably(join(dir, "attempt.json"), `${JSON.stringify(plan)}\n`);
  return { dir, plan };
}

export function completeReleaseAttempt(dir, receipt, options) {
  validateProductionReceipt(receipt, options);
  const plan = JSON.parse(readFileSync(join(dir, "attempt.json"), "utf8"));
  require(basename(dir) === receipt.attempt_uuid && plan.attempt_uuid === receipt.attempt_uuid &&
    sameIdentity({ ...receipt, dirty: false }, plan.identity) &&
    JSON.stringify([...receipt.host_ids].sort()) === JSON.stringify(plan.host_ids) &&
    JSON.stringify([...receipt.codex_host_ids].sort()) === JSON.stringify(plan.codex_host_ids) &&
    receipt.runners.every(item => Date.parse(item.worker_started_at) >= Date.parse(plan.created_at)), "attempt binding");
  const lock = acquireLock(dir, "completion");
  try {
    const target = join(dir, "completion.json");
    if (existsSync(target)) {
      const previous = JSON.parse(readFileSync(target, "utf8"));
      require(receiptDigest(previous) === receiptDigest(receipt), "completed receipt is immutable");
      return { receipt: previous, sha256: receiptDigest(previous), reused: true };
    }
    writeFileDurably(target, `${JSON.stringify(receipt)}\n`);
    return { receipt, sha256: receiptDigest(receipt), reused: false };
  } finally { releaseLock(lock); }
}
