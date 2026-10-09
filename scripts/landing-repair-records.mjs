import { spawnSync } from "node:child_process";
import { actorLogin, repositoryName } from "./landing-backlog.mjs";
import { formatLandingVersion, validateLandingRecord } from "./build-identity.mjs";
const must = (condition, message) => { if (!condition) throw new Error(message); };
const sha = value => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const hash = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const INTENT = ["schema", "kind", "repository", "repository_id", "workflow_id", "boundary_run_id", "target",
  "original_run_id", "created_at", "artifact_sha256", "control_sha", "operator", "observation_sha256", "ssh_configuration_sha256"];
const RECEIPT = ["schema", "kind", "intent_object", "identity", "pair_object", "control_sha", "operator",
  "remote_observation_sha256", "ssh_configuration_sha256"];
const exact = (value, fields) => value && typeof value === "object" && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...fields].sort());

export function localGit(cwd, args, input) {
  const result = spawnSync("git", args, { cwd, input, encoding: "utf8", timeout: 15_000, maxBuffer: 65_536,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: ["pipe", "pipe", "pipe"] });
  must(!result.error && !result.signal, "local repair Git operation failed");
  return result;
}
export function checkedLocalGit(cwd, args, input) {
  const result = localGit(cwd, args, input);
  must(result.status === 0, `local repair git ${args[0]} refused`);
  return result.stdout.trimEnd();
}
export function repairRefs(repositoryId, runId) {
  must(positive(repositoryId) && positive(runId), "repair ref identity invalid");
  const root = `refs/kaoiro/landing-repairs/${repositoryId}/${runId}`;
  return { intent: `${root}/intent`, receipt: `${root}/receipt` };
}
export function validateRepairIntent(value) {
  must(exact(value, INTENT) && value.schema === 1 && value.kind === "landing_repair_intent" &&
    repositoryName(value.repository) && positive(value.repository_id) && positive(value.workflow_id) &&
    positive(value.boundary_run_id) && positive(value.original_run_id) && sha(value.target) && sha(value.control_sha) &&
    typeof value.created_at === "string" && value.created_at.length <= 24 &&
    actorLogin(value.operator) && hash(value.artifact_sha256) && hash(value.observation_sha256) &&
    hash(value.ssh_configuration_sha256), "repair intent schema rejected");
  validateLandingRecord({ schema: 1, kind: "landing", repository_id: value.repository_id, revision: value.target,
    branch: "develop", version: formatLandingVersion(value.created_at.slice(0, 10), 1),
    original_run_id: value.original_run_id, created_at: value.created_at }, value.repository_id);
  return value;
}
export function validateRepairReceipt(value, intent, object) {
  must(exact(value, RECEIPT) && value.schema === 1 && value.kind === "landing_repair_receipt" &&
    value.intent_object === object && sha(value.pair_object) && sha(value.control_sha) && actorLogin(value.operator) &&
    hash(value.remote_observation_sha256) && hash(value.ssh_configuration_sha256), "repair receipt schema rejected");
  validateLandingRecord(value.identity, intent.repository_id);
  must(value.identity.revision === intent.target && value.identity.original_run_id === intent.original_run_id &&
    value.identity.created_at === intent.created_at, "repair receipt original tuple differs");
  return value;
}
export function readLocalRepairRecord(cwd, ref) {
  const probe = localGit(cwd, ["rev-parse", "--verify", "--quiet", ref]);
  if (probe.status === 1 && !probe.stdout) return null;
  must(probe.status === 0 && sha(probe.stdout.trim()), `repair ref unreadable: ${ref}`);
  const object = probe.stdout.trim();
  must(checkedLocalGit(cwd, ["cat-file", "-t", object]) === "blob", `repair ref is not a blob: ${ref} ${object}`);
  const size = Number(checkedLocalGit(cwd, ["cat-file", "-s", object]));
  must(Number.isInteger(size) && size > 0 && size <= 4096, `repair blob bound: ${ref} ${object}`);
  const bytes = checkedLocalGit(cwd, ["cat-file", "blob", object]);
  let value;
  try { value = JSON.parse(bytes); } catch { throw new Error(`repair blob JSON rejected: ${ref} ${object}`); }
  return { object, value };
}
export function writeLocalRepairRecord(cwd, ref, value) {
  const bytes = `${JSON.stringify(value)}\n`;
  must(Buffer.byteLength(bytes) <= 4096, "repair record exceeds bound");
  const object = checkedLocalGit(cwd, ["hash-object", "-w", "--stdin"], bytes);
  must(sha(object), "repair record object invalid");
  checkedLocalGit(cwd, ["update-ref", ref, object, "0".repeat(40)]);
  must(readLocalRepairRecord(cwd, ref)?.object === object, "repair record create/read-back differs");
  return object;
}
