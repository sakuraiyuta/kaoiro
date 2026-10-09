#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { api, actorLogin, repositoryName, originalArtifact, validateOriginalRecord, digest,
  validateLandingContext, auditLandingBacklog, shellQuote } from "./landing-backlog.mjs";
import { allocateLanding, readLandingInventory } from "./landing-tags.mjs";
import { parseReleaseOptions } from "./production-release-state.mjs";
import { operatorSshSnapshot } from "./landing-repair-ssh.mjs";
import { checkedLocalGit, localGit, repairRefs, readLocalRepairRecord, writeLocalRepairRecord,
  validateRepairIntent, validateRepairReceipt } from "./landing-repair-records.mjs";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const must = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function repositoryVariables(repository, readApi = api) {
  const rows = [], first = readApi(`repos/${repository}/actions/variables?per_page=100&page=1`);
  must(Number.isInteger(first.total_count) && first.total_count >= 0 && first.total_count <= 2000 &&
    Array.isArray(first.variables), "repository variables unavailable/bounded");
  rows.push(...first.variables);
  for (let page = 2; page <= Math.ceil(first.total_count / 100); page++) {
    const next = readApi(`repos/${repository}/actions/variables?per_page=100&page=${page}`);
    must(next.total_count === first.total_count && Array.isArray(next.variables), "repository variables changed");
    rows.push(...next.variables);
  }
  must(rows.length === first.total_count && new Set(rows.map(row => row.name)).size === rows.length &&
    rows.every(row => typeof row.name === "string" && typeof row.value === "string" &&
      Buffer.byteLength(row.value) <= 16_384), "repository variables inventory rejected");
  return Object.fromEntries(rows.map(row => [row.name, row.value]));
}

export function operatorLandingContext(repository, { cwd = root, readApi = api } = {}) {
  must(repositoryName(repository), "repository required");
  const metadata = readApi(`repos/${repository}`), variables = repositoryVariables(repository, readApi);
  must(metadata.full_name === repository && Number.isSafeInteger(metadata.id) && metadata.id > 0,
    "repository API identity differs");
  const head = checkedLocalGit(cwd, ["rev-parse", "HEAD"]);
  must(checkedLocalGit(cwd, ["status", "--porcelain"]) === "", "reviewed repair checkout must be clean");
  const workflow = readApi(`repos/${repository}/actions/workflows/develop-landing.yml`);
  must(workflow.path === ".github/workflows/develop-landing.yml", "landing workflow path differs");
  must(/^[1-9][0-9]{0,15}$/.test(variables.KAOIRO_LANDING_FIRST_RUN_ID ?? ""), "activation run unavailable");
  const boundary = readApi(`repos/${repository}/actions/runs/${variables.KAOIRO_LANDING_FIRST_RUN_ID}`);
  const context = validateLandingContext({ repository, repositoryId: metadata.id, workflowId: workflow.id,
    boundary, env: variables, head });
  return { ...context, metadata, variables };
}

export class AlreadyRepaired extends Error {
  constructor(pair, original) { super("already_repaired"); this.exitCode = 73; this.pair = exactPair(pair, original); }
}
export class ReceiptRecoveryRequired extends Error {
  constructor(result) { super("remote pair exists; receipt recording requires record-existing"); this.result = result; }
}
function exactPair(pair, original) {
  must(pair.record.revision === original.target && pair.record.original_run_id === original.originalRunId &&
    pair.record.created_at === original.createdAt, "published landing differs from exact original event");
  return pair;
}
function sameIntent(value, expected) {
  validateRepairIntent(value);
  for (const field of ["repository", "repository_id", "workflow_id", "boundary_run_id", "target",
    "original_run_id", "created_at", "artifact_sha256", "operator", "control_sha"])
    must(value[field] === expected[field], "retained repair intent original evidence differs");
}

export async function runLandingRepair(command, args, {
  cwd = root, readApi = api, readArtifact = originalArtifact, sshSnapshot = operatorSshSnapshot,
  allocate = allocateLanding,
} = {}) {
  must(["audit", "repair", "resume", "record-existing"].includes(command), "unknown landing repair command");
  const flags = parseReleaseOptions(args, ["repository", "original-run", "expected-target", "git-transport"]);
  if (command === "audit") must(Object.keys(flags).every(key => key === "repository"), "audit accepts repository only");
  else must(flags["git-transport"] === "ssh", "manual repair requires --git-transport ssh");
  const context = operatorLandingContext(flags.repository, { cwd, readApi });
  const remote = `git@github.com:${context.repository}.git`;
  if (command === "audit") {
    const result = auditLandingBacklog(context, { cwd, remote, readApi, readArtifact }).report;
    return { ...result, exit_code: result.pending_count === 0 ? 0 : 78 };
  }
  must(/^[1-9][0-9]{0,15}$/.test(flags["original-run"] ?? "") &&
    /^[0-9a-f]{40}$/.test(flags["expected-target"] ?? ""), "exact original run/target required");
  const actor = readApi("user"), allowed = JSON.parse(context.variables.KAOIRO_RELEASE_ACTORS ?? "null");
  must(actor.type === "User" && actorLogin(actor.login) && Array.isArray(allowed) && allowed.length > 0 &&
    allowed.length <= 100 && allowed.every(actorLogin) && new Set(allowed).size === allowed.length &&
    allowed.includes(actor.login) && context.metadata.permissions?.push === true,
  "authenticated operator allow-list/push authority rejected");
  const ssh = sshSnapshot(actor.login);
  const rewrites = localGit(cwd, ["config", "--local", "--get-regexp", "^url\\..*\\.(insteadof|pushinsteadof)$"]);
  must(rewrites.status === 1 && rewrites.stdout === "", "local Git URL rewrites are not allowed for repair");
  const run = readApi(`repos/${context.repository}/actions/runs/${flags["original-run"]}`);
  must(run.id === Number(flags["original-run"]) && run.workflow_id === context.workflowId &&
    Number.isSafeInteger(run.run_number) && run.run_number >= context.boundary.run_number,
    "original run predates/differs from activation authority");
  const artifact = readArtifact(context.repository, run), original = validateOriginalRecord(artifact.record, run, context.repositoryId);
  must(original.target === flags["expected-target"], "expected target differs from original artifact/run");
  const intentValue = validateRepairIntent({ schema: 1, kind: "landing_repair_intent", repository: context.repository,
    repository_id: context.repositoryId, workflow_id: context.workflowId, boundary_run_id: context.boundary.id,
    target: original.target, original_run_id: original.originalRunId, created_at: original.createdAt,
    artifact_sha256: digest(artifact.bytes), control_sha: context.control, operator: actor.login,
    observation_sha256: digest(JSON.stringify({ run, boundary: context.boundary })),
    ssh_configuration_sha256: ssh.configurationSha256 });
  const refs = repairRefs(context.repositoryId, original.originalRunId), prior = readLocalRepairRecord(cwd, refs.intent),
    recorded = readLocalRepairRecord(cwd, refs.receipt);
  if (prior) sameIntent(prior.value, intentValue);
  must(!recorded || prior, "receipt exists without local repair intent");
  if (recorded) validateRepairReceipt(recorded.value, prior.value, prior.object);
  let inventory = readLandingInventory({ cwd, remote, repositoryId: context.repositoryId, gitEnv: ssh.gitEnv });
  let pair = inventory.entries.find(value => value.record.revision === original.target);
  if (pair) exactPair(pair, original);
  if (recorded) {
    must(pair && equal(recorded.value.identity, pair.record) && recorded.value.pair_object === pair.object,
      "retained receipt differs from authoritative remote pair");
    throw new AlreadyRepaired(pair, original);
  }
  if (command === "repair") {
    if (pair) throw new AlreadyRepaired(pair, original);
    must(!prior, "repair intent exists; use explicit resume");
  } else {
    must(prior, "recovery requires an existing local repair intent");
    if (command === "resume") must(!pair, "remote pair exists; use record-existing without a push");
    else must(pair, "record-existing requires the exact remote pair");
  }
  const intentObject = prior?.object ?? writeLocalRepairRecord(cwd, refs.intent, intentValue);
  if (command !== "record-existing") {
    pair = await allocate({ cwd, remote, repositoryId: context.repositoryId, target: original.target,
      originalRunId: original.originalRunId, createdAt: original.createdAt, gitEnv: ssh.gitEnv });
    exactPair(pair, original);
    inventory = readLandingInventory({ cwd, remote, repositoryId: context.repositoryId, gitEnv: ssh.gitEnv });
    const fresh = inventory.entries.find(value => value.record.revision === original.target);
    must(fresh && fresh.object === pair.object && equal(fresh.record, pair.record), "repair pair read-back differs");
  }
  const receipt = validateRepairReceipt({ schema: 1, kind: "landing_repair_receipt", intent_object: intentObject,
    identity: pair.record, pair_object: pair.object, control_sha: context.control, operator: actor.login,
    remote_observation_sha256: digest(inventory.signature), ssh_configuration_sha256: ssh.configurationSha256 },
    prior?.value ?? intentValue, intentObject);
  let receiptObject;
  try { receiptObject = writeLocalRepairRecord(cwd, refs.receipt, receipt); }
  catch {
    throw new ReceiptRecoveryRequired({ schema: 1, status: "receipt_record_required", exit_code: 78,
      identity: pair.record, pair_object: pair.object, intent_ref: refs.intent, intent_object: intentObject,
      recovery_command: ["node", join(cwd, "scripts/landing-repair.mjs"), "record-existing", "--git-transport", "ssh",
        "--repository", context.repository, "--original-run", original.originalRunId,
        "--expected-target", original.target].map(shellQuote).join(" ") });
  }
  return { schema: 1, status: pair.created === false && command !== "record-existing" ? "already_repaired" : "repaired",
    exit_code: pair.created === false && command !== "record-existing" ? 73 : 0, identity: pair.record, pair_object: pair.object,
    intent_ref: refs.intent, intent_object: intentObject, receipt_ref: refs.receipt, receipt_object: receiptObject,
    control_sha: context.control, operator: actor.login, evidence_scope: "this_control_checkout" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runLandingRepair(process.argv[2], process.argv.slice(3));
    console.log(JSON.stringify(result)); process.exitCode = result.exit_code;
  } catch (error) {
    if (error instanceof ReceiptRecoveryRequired) {
      console.log(JSON.stringify(error.result)); process.exitCode = 78;
    } else if (error instanceof AlreadyRepaired) {
      console.log(JSON.stringify({ schema: 1, status: "already_repaired", identity: error.pair.record }));
      process.exitCode = 73;
    } else { process.stderr.write(`landing repair refused: ${error.message}\n`); process.exitCode = 78; }
  }
}
