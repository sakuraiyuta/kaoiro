import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, lstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAutomationGate } from "./release-automation-gate.mjs";
import { readLandingInventory } from "./landing-tags.mjs";
const require = (condition, message) => { if (!condition) throw new Error(message); };
const sha = value => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
export const repositoryName = value => typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
export const actorLogin = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value);
export const digest = bytes => createHash("sha256").update(bytes).digest("hex");
export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export function api(path) {
  let raw;
  try { raw = execFileSync("gh", ["api", path], { encoding: "utf8", timeout: 15_000, maxBuffer: 8_388_608 }); }
  catch { throw new Error("landing GitHub API read failed"); }
  return JSON.parse(raw);
}

export function originalPushRecord(event, run, repositoryId) {
  require(run.event === "push" &&
    run.head_branch === "develop" &&
    run.repository.id === repositoryId &&
    run.head_repository.id === repositoryId &&
    sha(event.after) &&
    event.after === run.head_sha &&
    event.ref === "refs/heads/develop" &&
    typeof event.forced === "boolean" &&
    typeof event.deleted === "boolean", "push/run authority differs");
  require(Number.isSafeInteger(run.id) &&
    run.id > 0 &&
    typeof run.created_at === "string" &&
    Number.isFinite(
      Date.parse(run.created_at),
    ), "original run clock is unavailable");
  return {
    schema: 1,
    repositoryId,
    target: event.after,
    originalRunId: run.id,
    createdAt: run.created_at,
    branch: "develop",
    forced: event.forced,
    deleted: event.deleted,
  };
}
export function validateOriginalObservation(record, run, repositoryId) {
  require(record?.schema === 1 &&
    record.repositoryId === repositoryId &&
    record.originalRunId === run.id &&
    record.target === run.head_sha &&
    record.createdAt === run.created_at &&
    record.branch === "develop" &&
    typeof record.forced === "boolean" &&
    typeof record.deleted === "boolean" &&
    run.event === "push" &&
    run.head_branch === "develop" &&
    run.repository.id === repositoryId &&
    run.head_repository.id === repositoryId, "original push record rejected");
  return record;
}
export function validateOriginalRecord(record, run, repositoryId) {
  validateOriginalObservation(record, run, repositoryId);
  require(record.forced === false &&
    record.deleted === false, "forced/deleted push is not a landing");
  return record;
}
export function* listLandingPushRuns({
  repository,
  workflowId,
  from,
  through,
  readApi = api,
}) {
  const lower = Math.floor(Date.parse(from) / 1000),
    upper = Math.floor(Date.parse(through) / 1000);
  require(Number.isSafeInteger(lower) &&
    Number.isSafeInteger(upper) &&
    lower <= upper, "bounded reconciliation UTC range required");
  const windows = [[lower, upper]];
  while (windows.length) {
    const [start, end] = windows.pop();
    const range = `${new Date(start * 1000).toISOString()}..${new Date(end * 1000).toISOString()}`;
    const prefix = `repos/${repository}/actions/workflows/${workflowId}/runs?event=push&branch=develop&created=${encodeURIComponent(range)}&per_page=100`;
    const first = readApi(`${prefix}&page=1`);
    require(Number.isInteger(first.total_count) &&
      first.total_count >= 0 &&
      Array.isArray(first.workflow_runs), "workflow window schema");
    if (first.total_count >= 1000) {
      require(start <
        end, "one-second workflow window reaches GitHub's 1000-result cap; explicit operator repair required");
      const middle = Math.floor((start + end) / 2);
      windows.push([middle + 1, end], [start, middle]);
      continue;
    }
    const rows = [...first.workflow_runs];
    for (let page = 2; page <= Math.ceil(first.total_count / 100); page++) {
      const next = readApi(`${prefix}&page=${page}`);
      require(next.total_count === first.total_count &&
        Array.isArray(
          next.workflow_runs,
        ), "workflow window changed during pagination");
      rows.push(...next.workflow_runs);
    }
    require(rows.length === first.total_count &&
      new Set(rows.map((row) => row.id)).size ===
        rows.length, "workflow window was truncated or contains duplicate run IDs");
    for (const row of rows) {
      const created = Date.parse(row.created_at);
      require(Number.isSafeInteger(row.id) &&
        row.id > 0 &&
        row.event === "push" &&
        row.head_branch === "develop" &&
        Number.isFinite(created) &&
        created % 1000 === 0 &&
        created >= start * 1000 &&
        created <=
          end *
            1000, "workflow window returned an out-of-range or untrusted run");
    }
    yield* rows.sort(
      (left, right) =>
        Date.parse(left.created_at) - Date.parse(right.created_at) ||
        left.id - right.id,
    );
  }
}

export function originalArtifact(repository, run) {
  const scratch = mkdtempSync(join(tmpdir(), "kaoiro-original-event-"));
  try {
    try { execFileSync("gh", ["run", "download", String(run.id), "--repo", repository,
      "--name", "landing-event-v1", "--dir", scratch], { stdio: "pipe", timeout: 30_000 }); }
    catch { throw new Error("original landing artifact is unavailable"); }
    const path = join(scratch, "original-event.json"), stat = lstatSync(path);
    require(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65_536, "original landing artifact bound/type");
    const bytes = readFileSync(path);
    require(bytes.length <= 65_536, "original landing artifact bound");
    return { bytes, record: JSON.parse(bytes) };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

export function validateLandingContext({ repository, repositoryId, workflowId, boundary, env, head }) {
  require(repositoryName(repository) && Number.isSafeInteger(repositoryId) && repositoryId > 0 &&
    Number.isSafeInteger(workflowId) && workflowId > 0, "landing repository/workflow context");
  validateAutomationGate(env, head, "landing");
  require(boundary.id === Number(env.KAOIRO_LANDING_FIRST_RUN_ID) && boundary.event === "push" &&
    boundary.head_branch === "develop" && boundary.workflow_id === workflowId &&
    boundary.repository?.id === repositoryId && boundary.head_repository?.id === repositoryId &&
    Number.isSafeInteger(boundary.run_number) && boundary.run_number > 0 &&
    Number.isFinite(Date.parse(boundary.created_at)), "activation boundary differs");
  return { repository, repositoryId, workflowId, boundary, control: head };
}

export function landingCandidates(context, { runs, inventory, readArtifact = originalArtifact }) {
  const seen = new Set(), rows = [], paired = new Map(inventory.entries.map(entry => [entry.record.revision, entry]));
  let observed = 0;
  for (const run of runs) {
    require(++observed <= 100_000, "landing run observation cap; inventory unknown");
    require(run.repository?.id === context.repositoryId && run.head_repository?.id === context.repositoryId &&
      run.workflow_id === context.workflowId && Number.isSafeInteger(run.run_number) &&
      sha(run.head_sha), "original landing run authority differs");
    if (run.run_number < context.boundary.run_number) continue;
    if (seen.has(run.head_sha)) continue;
    const established = paired.get(run.head_sha);
    if (established) {
      seen.add(run.head_sha);
      rows.push({ target: run.head_sha, status: "resolved", pair: established });
      continue;
    }
    const artifact = readArtifact(context.repository, run);
    const observation = validateOriginalObservation(artifact.record, run, context.repositoryId);
    if (observation.forced || observation.deleted) continue;
    const record = validateOriginalRecord(observation, run, context.repositoryId);
    seen.add(run.head_sha);
    rows.push({ target: record.target, status: "pending", original: record,
      artifact_sha256: digest(artifact.bytes), run_number: run.run_number });
    require(rows.length <= 100_000, "landing backlog exceeds bound; inventory unknown");
  }
  return rows;
}

export function auditLandingBacklog(context, { through = new Date().toISOString(), runs,
  readApi = api, readArtifact = originalArtifact, cwd = process.cwd(), remote = "origin", gitEnv } = {}) {
  const inventory = readLandingInventory({ cwd, remote, repositoryId: context.repositoryId, gitEnv });
  const selected = runs ?? listLandingPushRuns({ repository: context.repository, workflowId: context.workflowId,
    from: context.boundary.created_at, through, readApi });
  const rows = landingCandidates(context, { runs: selected, inventory, readArtifact });
  const pending = rows.filter(row => row.status !== "resolved");
  const report = { schema: 1, kind: "landing_backlog", repository: context.repository,
    repository_id: context.repositoryId, control_sha: context.control,
    inventory_scope: { kind: runs ? "current_event" : "all_post_activation", from: context.boundary.created_at, through },
    pending_count: pending.length, identities: pending.map(row => ({ target: row.target,
      original_run_id: row.original.originalRunId, created_at: row.original.createdAt, status: row.status })) };
  require(Buffer.byteLength(JSON.stringify(report)) <= 8_388_608, "landing backlog output exceeds bound; inventory unknown");
  return { report, rows, inventory };
}
