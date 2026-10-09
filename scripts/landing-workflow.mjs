#!/usr/bin/env node
import { childEnvironment, execChildSync } from "./child-process-environment.mjs";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { api, repositoryName, originalPushRecord, shellQuote, validateLandingContext, auditLandingBacklog } from "./landing-backlog.mjs";
import { allocateLanding, LandingRepairRequired } from "./landing-tags.mjs";
const require = (condition, message) => {
  if (!condition) throw new Error(message);
};
export { originalPushRecord, validateOriginalObservation, validateOriginalRecord, listLandingPushRuns } from "./landing-backlog.mjs";
function gitAuthentication() {
  require(process.env.GH_TOKEN, "publisher token unavailable");
  return childEnvironment("ci-git");
}

export function repairDiagnostic(identity, control) {
  const repairCommand = ["node", "scripts/landing-repair.mjs", "repair", "--git-transport", "ssh",
    "--repository", identity.repository, "--original-run", identity.originalRunId,
    "--expected-target", identity.target].map(shellQuote).join(" ");
  return { schema: 1, status: "landing_operator_repair_required", reason_code: "landing_operator_repair_required",
    repository_id: identity.repositoryId, target: identity.target, original_run_id: identity.originalRunId,
    created_at: identity.createdAt, workflow_path: identity.workflowPath,
    repair_command: repairCommand, repair_control_sha: control, command_cwd: "reviewed_control_checkout" };
}
export function writeLandingResult(result) {
  const bytes = `${JSON.stringify(result)}\n`;
  require(Buffer.byteLength(bytes) <= 8_388_608, "landing diagnostic exceeds bound");
  if (process.env.KAOIRO_LANDING_RESULT_PATH) writeFileSync(process.env.KAOIRO_LANDING_RESULT_PATH, bytes, { flag: "wx" });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, bytes);
  console.log(bytes.trimEnd());
}
async function main() {
  const repository = process.env.GITHUB_REPOSITORY, repositoryId = Number(process.env.GITHUB_REPOSITORY_ID);
  require(repositoryName(repository), "repository context");
  const current = api(`repos/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`);
  if (process.argv[2] === "record") {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    writeFileSync(process.argv[3], `${JSON.stringify(originalPushRecord(event, current, repositoryId))}\n`, { flag: "wx" });
    return;
  }
  require(["allocate", "reconcile"].includes(process.argv[2]), "unknown landing workflow action");
  require(["push", "workflow_dispatch", "schedule"].includes(current.event) &&
    current.repository?.id === repositoryId && current.head_repository?.id === repositoryId,
    "untrusted reconciliation trigger");
  const head = execChildSync("ci-git", "git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const boundary = api(`repos/${repository}/actions/runs/${process.env.KAOIRO_LANDING_FIRST_RUN_ID}`);
  const context = validateLandingContext({ repository, repositoryId, workflowId: current.workflow_id,
    boundary, env: process.env, head });
  const gitEnv = gitAuthentication();
  const scope = current.event === "push" ? { runs: [current] } : {};
  const before = auditLandingBacklog(context, { ...scope, through: current.created_at, gitEnv });
  let denied;
  for (const row of before.rows) {
    if (row.status === "resolved") continue;
    const original = row.original;
    try {
      await allocateLanding({ cwd: process.cwd(), remote: "origin", target: original.target,
        originalRunId: original.originalRunId, createdAt: original.createdAt, repositoryId,
        gitEnv });
    } catch (error) {
      if (!(error instanceof LandingRepairRequired)) throw error;
      denied = repairDiagnostic({ ...error.identity, repository }, head);
      break;
    }
  }
  const after = auditLandingBacklog(context, { ...(denied ? {} : scope), through: current.created_at, gitEnv }).report;
  if (denied) {
    for (const identity of after.identities) if (identity.target === denied.target)
      identity.status = "operator_repair_required";
    return { ...denied, ...after, status: denied.status, exit_code: 77 };
  }
  return { ...after, status: "success", exit_code: 0 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result;
  try { result = await main(); }
  catch (error) {
    result = { schema: 1, status: "refused", inventory_scope: "unknown", exit_code: 78 };
    process.stderr.write(`landing workflow refused: ${error.message}\n`);
  }
  if (result) {
    process.exitCode = result.exit_code;
    try { writeLandingResult(result); }
    catch { process.stderr.write("landing result persistence failed\n"); process.exitCode = 78; }
  }
}
