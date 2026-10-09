import assert from "node:assert/strict";
import { test } from "node:test";
import { listLandingPushRuns } from "../landing-workflow.mjs";

test("UTC windows recover more than 100 lifetime pages without exceeding GitHub's per-search cap", () => {
  const epoch = Date.parse("2026-10-09T00:00:00Z");
  const runs = Array.from({ length: 12_001 }, (_, index) => ({ id: index + 1, event: "push", head_branch: "develop",
    created_at: new Date(epoch + Math.floor(index / 200) * 1000).toISOString() }));
  const calls = [];
  const readApi = path => {
    const query = new URL(`https://example.invalid/${path}`).searchParams;
    assert.equal(query.get("event"), "push");assert.equal(query.get("branch"), "develop");
    const [from, through] = query.get("created").split("..").map(Date.parse);
    const selected = runs.filter(run => Date.parse(run.created_at) >= from && Date.parse(run.created_at) <= through).reverse();
    const page = Number(query.get("page"));calls.push({ from, through, page });
    return { total_count: selected.length, workflow_runs: selected.slice(0, 1000).slice((page - 1) * 100, page * 100) };
  };
  const result = [...listLandingPushRuns({ repository: "fixture/repo", workflowId: 1,
    from: new Date(epoch).toISOString(), through: new Date(epoch + 60_000).toISOString(), readApi })];
  assert.deepEqual(result.map(run => run.id), runs.map(run => run.id));
  assert.ok(calls.length > 100);
  assert.ok(calls.every(call => call.page <= 10));
});

test("a dense second, missing pages, duplicate IDs and out-of-range data refuse instead of hiding a landing", () => {
  const options = { repository: "fixture/repo", workflowId: 1, from: "2026-10-09T00:00:00Z", through: "2026-10-09T00:00:00Z" };
  assert.throws(() => [...listLandingPushRuns({ ...options, readApi: () => ({ total_count: 1000, workflow_runs: [] }) })], /1000-result cap/);
  assert.throws(() => [...listLandingPushRuns({ ...options, readApi: () => ({ total_count: 1, workflow_runs: [] }) })], /truncated/);
  const row = { id: 1, event: "push", head_branch: "develop", created_at: options.from };
  assert.throws(() => [...listLandingPushRuns({ ...options, readApi: () => ({ total_count: 2, workflow_runs: [row, row] }) })], /duplicate/);
  assert.throws(() => [...listLandingPushRuns({ ...options, readApi: () => ({ total_count: 1, workflow_runs: [{ ...row, event: "schedule" }] }) })], /untrusted/);
});
