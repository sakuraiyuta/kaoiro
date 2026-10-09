import assert from "node:assert/strict";
import { test } from "node:test";
import { listLandingPushRuns } from "../landing-workflow.mjs";

test("UTC windows recover more than 100 lifetime pages without exceeding GitHub's per-search cap", () => {
  const epoch = Date.parse("2026-10-09T00:00:00Z");
  const runs = Array.from({ length: 12_001 }, (_, index) => ({
    id: index + 1,
    event: "push",
    head_branch: "develop",
    created_at: new Date(epoch + Math.floor(index / 200) * 1000).toISOString(),
  }));
  const calls = [];
  const readApi = (path) => {
    const query = new URL(`https://example.invalid/${path}`).searchParams;
    assert.equal(query.get("event"), "push");
    assert.equal(query.get("branch"), "develop");
    const [from, through] = query.get("created").split("..").map(Date.parse);
    const selected = runs
      .filter(
        (run) =>
          Date.parse(run.created_at) >= from &&
          Date.parse(run.created_at) <= through,
      )
      .reverse();
    const page = Number(query.get("page"));
    calls.push({ from, through, page });
    return {
      total_count: selected.length,
      workflow_runs: selected
        .slice(0, 1000)
        .slice((page - 1) * 100, page * 100),
    };
  };
  const result = [
    ...listLandingPushRuns({
      repository: "fixture/repo",
      workflowId: 1,
      from: new Date(epoch).toISOString(),
      through: new Date(epoch + 60_000).toISOString(),
      readApi,
    }),
  ];
  assert.deepEqual(
    result.map((run) => run.id),
    runs.map((run) => run.id),
  );
  assert.ok(calls.length > 100);
  assert.ok(calls.every((call) => call.page <= 10));
});

test("a dense second, missing pages, duplicate IDs and out-of-range data refuse instead of hiding a landing", () => {
  const options = {
    repository: "fixture/repo",
    workflowId: 1,
    from: "2026-10-09T00:00:00Z",
    through: "2026-10-09T00:00:00Z",
  };
  assert.throws(
    () => [
      ...listLandingPushRuns({
        ...options,
        readApi: () => ({ total_count: 1000, workflow_runs: [] }),
      }),
    ],
    /1000-result cap/,
  );
  assert.throws(
    () => [
      ...listLandingPushRuns({
        ...options,
        readApi: () => ({ total_count: 1, workflow_runs: [] }),
      }),
    ],
    /truncated/,
  );
  const row = {
    id: 1,
    event: "push",
    head_branch: "develop",
    created_at: options.from,
  };
  assert.throws(
    () => [
      ...listLandingPushRuns({
        ...options,
        readApi: () => ({ total_count: 2, workflow_runs: [row, row] }),
      }),
    ],
    /duplicate/,
  );
  assert.throws(
    () => [
      ...listLandingPushRuns({
        ...options,
        readApi: () => ({
          total_count: 1,
          workflow_runs: [{ ...row, event: "schedule" }],
        }),
      }),
    ],
    /untrusted/,
  );
});

test("the production reconciliation entry fetches once per inventory rather than per already claimed run", async () => {
  const { execFileSync, spawnSync } = await import("node:child_process");
  const fs = await import("node:fs"),
    { tmpdir } = await import("node:os"),
    { dirname, join } = await import("node:path"),
    { fileURLToPath } = await import("node:url");
  const { allocateLanding } = await import("../landing-tags.mjs"),
    { BUILD_REPOSITORY_ID } = await import("../build-identity.mjs");
  const root = fs.mkdtempSync(join(tmpdir(), "kaoiro-workflow-entry-test-")),
    repo = join(root, "repo"),
    remote = join(root, "remote.git"),
    bin = join(root, "bin");
  const git = (cwd, ...args) =>
    execFileSync("/usr/bin/git", args, {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  try {
    fs.mkdirSync(repo);
    fs.mkdirSync(bin);
    git(root, "init", "--bare", "--quiet", remote);
    git(repo, "init", "--quiet");
    git(repo, "config", "user.email", "fixture@example.invalid");
    git(repo, "config", "user.name", "Fixture");
    fs.writeFileSync(join(repo, "content"), "fixture");
    git(repo, "add", "content");
    git(repo, "commit", "--quiet", "-m", "fixture");
    const revision = git(repo, "rev-parse", "HEAD");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "--quiet", "origin", "HEAD:refs/heads/develop");
    await allocateLanding({
      cwd: repo,
      remote: "origin",
      target: revision,
      originalRunId: 1,
      createdAt: "2026-10-09T00:00:00Z",
      repositoryId: BUILD_REPOSITORY_ID,
    });
    const pushes = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      run_number: i + 1,
      event: "push",
      head_branch: "develop",
      head_sha: revision,
      workflow_id: 1,
      created_at: new Date(
        Date.parse("2026-10-09T00:00:00Z") + i * 1000,
      ).toISOString(),
      repository: { id: BUILD_REPOSITORY_ID },
      head_repository: { id: BUILD_REPOSITORY_ID },
    }));
    const current = {
      ...pushes.at(-1),
      id: 999,
      event: "schedule",
      created_at: "2026-10-09T00:03:00Z",
    };
    const data = join(root, "api.json"),
      log = join(root, "git.jsonl");
    fs.writeFileSync(data, JSON.stringify({ pushes, current }));
    fs.writeFileSync(
      join(bin, "gh"),
      `#!${process.execPath}\nconst fs=require('node:fs'),d=JSON.parse(fs.readFileSync(${JSON.stringify(data)})),p=process.argv[3];let v;if(p.includes('/actions/workflows/')){const q=new URL('https://fixture.invalid/'+p).searchParams;const n=Number(q.get('page'));v={total_count:d.pushes.length,workflow_runs:d.pushes.slice((n-1)*100,n*100)};}else if(p.endsWith('/999'))v=d.current;else v=d.pushes[0];console.log(JSON.stringify(v));\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      join(bin, "git"),
      `#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process'),a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');try{cp.execFileSync('/usr/bin/git',a,{stdio:'inherit'});}catch(e){process.exit(e.status??1);}\n`,
      { mode: 0o755 },
    );
    const script = join(
      dirname(fileURLToPath(import.meta.url)),
      "../landing-workflow.mjs",
    );
    const result = spawnSync(process.execPath, [script, "reconcile"], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GH_TOKEN: "inert-fixture-token",
        GITHUB_REPOSITORY: "fixture/repo",
        GITHUB_REPOSITORY_ID: String(BUILD_REPOSITORY_ID),
        GITHUB_RUN_ID: "999",
        KAOIRO_LANDING_FIRST_RUN_ID: "1",
        KAOIRO_LANDING_ENABLED: "true",
        KAOIRO_LANDING_CONTROL_SHA: revision,
        KAOIRO_IDENTITY_GATES_SHA: revision,
        KAOIRO_IDENTITY_V9: "true",
        KAOIRO_IDENTITY_V10: "true",
      },
      timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr);
    const calls = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(calls.filter((args) => args[0] === "fetch").length, 2);
    assert.equal(
      calls.filter(
        (args) =>
          args.includes("--verify") &&
          args.some((x) => x === `refs/tags/identity/landing/${revision}`),
      ).length,
      25,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
