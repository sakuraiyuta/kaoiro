#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readLandingTag } from "./build-identity.mjs";
import { validateAutomationGate } from "./release-automation-gate.mjs";
const api = (path) =>
  JSON.parse(
    execFileSync("gh", ["api", path], {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 8_388_608,
    }),
  );
const require = (condition, message) => {
  if (!condition) throw new Error(message);
};
const sha = (value) =>
  typeof value === "string" &&
  value.length === 40 &&
  /^[0-9a-f]{40}$/.test(value);
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
function gitAuthentication() {
  require(process.env.GH_TOKEN, "publisher token unavailable");
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
  process.env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${process.env.GH_TOKEN}`).toString("base64")}`;
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
async function main() {
  const repository = process.env.GITHUB_REPOSITORY,
    repositoryId = Number(process.env.GITHUB_REPOSITORY_ID);
  require(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(
    repository,
  ), "repository context");
  const current = api(
    `repos/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  );
  if (process.argv[2] === "record") {
    const event = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"),
    );
    const record = originalPushRecord(event, current, repositoryId);
    writeFileSync(process.argv[3], `${JSON.stringify(record)}\n`, {
      flag: "wx",
    });
    return;
  }
  validateAutomationGate(
    process.env,
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    "landing",
  );
  const boundary = api(
    `repos/${repository}/actions/runs/${process.env.KAOIRO_LANDING_FIRST_RUN_ID}`,
  );
  require(boundary.workflow_id === current.workflow_id &&
    boundary.event === "push" &&
    boundary.head_branch === "develop", "activation boundary differs");
  gitAuthentication();
  const { allocateLanding, auditLandingInventory } = await import(
    "./landing-tags.mjs"
  );
  execFileSync("git", ["fetch", "--tags", "origin"], {
    stdio: "pipe",
    timeout: 15_000,
  });
  auditLandingInventory({ cwd: process.cwd(), remote: "origin", repositoryId });
  const runOne = async (run) => {
    if (
      run.run_number < boundary.run_number ||
      run.event !== "push" ||
      run.head_branch !== "develop"
    )
      return;
    try {
      const claim = execFileSync(
        "git",
        ["rev-parse", "--verify", `refs/tags/identity/landing/${run.head_sha}`],
        { encoding: "utf8", stdio: "pipe" },
      ).trim();
      const annotation = execFileSync("git", ["cat-file", "-p", claim], {
        encoding: "utf8",
        stdio: "pipe",
      });
      const record = JSON.parse(
        annotation.slice(annotation.indexOf("\n\n") + 2),
      );
      readLandingTag(process.cwd(), `v${record.version}`, repositoryId);
      return;
    } catch (error) {
      // A missing claim is recoverable; a present broken claim is not.
      const probe = execFileSync(
        "git",
        ["for-each-ref", "--format=%(refname)", "refs/tags"],
        { encoding: "utf8", stdio: "pipe" },
      );
      if (
        probe.split("\n").includes(`refs/tags/identity/landing/${run.head_sha}`)
      )
        throw error;
    }
    const scratch = mkdtempSync(join(tmpdir(), "kaoiro-original-event-"));
    try {
      execFileSync(
        "gh",
        [
          "run",
          "download",
          String(run.id),
          "--repo",
          repository,
          "--name",
          "landing-event-v1",
          "--dir",
          scratch,
        ],
        { stdio: "pipe", timeout: 30_000 },
      );
      const observation = validateOriginalObservation(
        JSON.parse(readFileSync(join(scratch, "original-event.json"), "utf8")),
        run,
        repositoryId,
      );
      if (observation.forced || observation.deleted) return;
      const record = validateOriginalRecord(observation, run, repositoryId);
      const result = await allocateLanding({
        cwd: process.cwd(),
        remote: "origin",
        target: record.target,
        originalRunId: record.originalRunId,
        createdAt: record.createdAt,
        repositoryId,
      });
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          `${JSON.stringify(result)}\n`,
        );
      else console.log(JSON.stringify(result));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };
  if (current.event === "push") {
    await runOne(current);
    return;
  }
  require(["workflow_dispatch", "schedule"].includes(
    current.event,
  ), "untrusted reconciliation trigger");
  for (const run of listLandingPushRuns({
    repository,
    workflowId: current.workflow_id,
    from: boundary.created_at,
    through: current.created_at,
  }))
    await runOne(run);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`landing workflow: ${error.message}\n`);
    process.exitCode = 78;
  }
}
