import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repairFixture } from "./fixtures/landing-repair-fixture.mjs";
import { stageReleaseTools } from "../production-release-tools.mjs";
import { readReleaseAuthority } from "../production-release-authority.mjs";
import { releaseJsonBytes } from "../production-release-files.mjs";
import { afterEach, test } from "node:test";
import {
  BUILD_REPOSITORY_ID,
  artifactBuildIdentity,
} from "../build-identity.mjs";
import {
  completeReleaseAttempt,
  receiptDigest,
  startReleaseAttempt,
  validateProductionReceipt,
} from "../production-release-record.mjs";
import { publishProductionRelease } from "../production-release-tags.mjs";
import {
  originalPushRecord,
  validateOriginalRecord,
} from "../landing-workflow.mjs";
import { validateDispatch } from "../production-release-workflow.mjs";
import { validateAutomationGate } from "../release-automation-gate.mjs";
import {
  acknowledgeReleaseAttempt,
  collectRunnerCompletion,
  collectServerCompletion,
} from "../collect-production-release.mjs";
import {
  productionDispatchCard,
  auditProductionCompletions,
} from "../production-release-card.mjs";
const scratch = [];
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const make = () => {
  const dir = mkdtempSync(join(tmpdir(), "fuji571-receipt-test-"));
  scratch.push(dir);
  return dir;
};
function receipt(
  revision = "a".repeat(40),
  uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  date = Date.now() + 10,
) {
  const time = (offset) => new Date(date + offset).toISOString();
  return {
    schema: 1,
    kind: "production_completion",
    environment: "production",
    publication_mode: "by_landing",
    repository_id: BUILD_REPOSITORY_ID,
    attempt_uuid: uuid,
    revision,
    version: "2026.10.09.1",
    branch: "develop",
    completed_at: time(3),
    host_ids: ["runner-01"],
    codex_host_ids: ["runner-01"],
    server: {
      transaction_id: "20261009T000000Z",
      image_id: `sha256:${"a".repeat(64)}`,
      container_id: "server",
      health_revision: revision,
      health_dirty: false,
      stability_passed: true,
      journal_sha256: "b".repeat(64),
      manifest_sha256: "c".repeat(64),
    },
    runners: [
      {
        host_id: "runner-01",
        revision,
        version: "2026.10.09.1",
        branch: "develop",
        dirty: false,
        unit: "kaoiro-runner",
        update_invocation_id: "d".repeat(32),
        service_active: true,
        worker_exit: 0,
        worker_started_at: time(0),
        worker_finished_at: time(1),
        artifact_sha256: "e".repeat(64),
        codex: {
          transaction_id: uuid,
          evidence_sha256: "f".repeat(64),
          accepted_at: time(2),
        },
      },
    ],
    canary: {
      passed: true,
      operator: "operator",
      revision,
      completed_at: time(2),
      evidence_sha256: "0".repeat(64),
    },
  };
}
const options = { allowedHosts: ["runner-01"] };
test("activation binds both mandatory gates to the actual reviewed control commit", () => {
  const head = "a".repeat(40);
  for (const kind of ["landing", "release"]) {
    const prefix = kind === "landing" ? "KAOIRO_LANDING" : "KAOIRO_RELEASE";
    const env = {
      [`${prefix}_ENABLED`]: "true",
      [`${prefix}_CONTROL_SHA`]: head,
      KAOIRO_IDENTITY_GATES_SHA: head,
      KAOIRO_IDENTITY_V9: "true",
      KAOIRO_IDENTITY_V10: "true",
    };
    validateAutomationGate(env, head, kind);
    for (const field of Object.keys(env))
      assert.throws(() =>
        validateAutomationGate({ ...env, [field]: "false" }, head, kind),
      );
    assert.throws(() => validateAutomationGate(env, "b".repeat(40), kind));
  }
});
test("a bounded completion requires all independently completed legs", () => {
  const r = receipt();
  assert.equal(validateProductionReceipt(r, options), r);
  const mutations = [
    (v) => (v.server.stability_passed = false),
    (v) => (v.server.health_revision = "a".repeat(7) + "b".repeat(33)),
    (v) => (v.runners = []),
    (v) => (v.runners[0].worker_exit = 1),
    (v) => (v.runners[0].service_active = false),
    (v) => (v.runners[0].codex = null),
    (v) => (v.canary.passed = false),
    (v) => (v.host_ids = ["other"]),
    (v) => (v.environment = "test"),
    (v) => (v.runners[0].phase = "queued"),
    (v) => (v.canary.secret = "unbounded"),
    (v) => (v.runners[0].dirty = true),
    (v) => (v.runners[0].branch = "main"),
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(r);
    mutate(bad);
    assert.throws(() => validateProductionReceipt(bad, options));
  }
});
test("stable attempts publish once outside ordinary transaction retention", () => {
  const root = make(),
    revision = "a".repeat(40);
  const identity = artifactBuildIdentity({
    revision,
    dirty: false,
    version: "2026.10.09.1",
    branch: "develop",
    channel: "dev",
    landing: {
      schema: 1,
      kind: "landing",
      repository_id: BUILD_REPOSITORY_ID,
      revision,
      branch: "develop",
      version: "2026.10.09.1",
      original_run_id: 1,
      created_at: "2026-10-09T00:00:00Z",
    },
  });
  const { dir, plan } = startReleaseAttempt(root, identity, ["runner-01"]);
  assert.deepEqual(plan.codex_host_ids, ["runner-01"]);
  const r = receipt(
    revision,
    plan.attempt_uuid,
    Date.parse(plan.created_at) + 10,
  );
  assert.equal(completeReleaseAttempt(dir, r, options).reused, false);
  assert.equal(completeReleaseAttempt(dir, r, options).reused, true);
  const altered = structuredClone(r);
  altered.canary.evidence_sha256 = "1".repeat(64);
  assert.throws(
    () => completeReleaseAttempt(dir, altered, options),
    /immutable/,
  );
  assert.equal(
    receiptDigest(JSON.parse(readFileSync(join(dir, "completion.json")))),
    receiptDigest(r),
  );
  assert.throws(
    () =>
      startReleaseAttempt(root, { ...identity, version: "untagged" }, [
        "runner-01",
      ]),
    /tagged clean/,
  );
  assert.throws(
    () => startReleaseAttempt(root, identity, ["runner-01"], ["other"]),
    /subset/,
  );
  const onlyRunner = startReleaseAttempt(root, identity, ["runner-01"], []);
  const noCodex = receipt(
    revision,
    onlyRunner.plan.attempt_uuid,
    Date.parse(onlyRunner.plan.created_at) + 10,
  );
  noCodex.codex_host_ids = [];
  noCodex.runners[0].codex = null;
  assert.equal(
    completeReleaseAttempt(onlyRunner.dir, noCodex, options).reused,
    false,
  );
  const alteredInventory = structuredClone(r);
  alteredInventory.codex_host_ids = [];
  alteredInventory.runners[0].codex = null;
  assert.throws(
    () => completeReleaseAttempt(dir, alteredInventory, options),
    /attempt binding/,
  );
});
test("the execution card requires Codex acceptance only on its fixed selected hosts", () => {
  const r = receipt();
  r.host_ids.push("worker2");
  r.runners.push({
    ...structuredClone(r.runners[0]),
    host_id: "worker2",
    codex: null,
  });
  const allowedHosts = ["runner-01", "worker2"];
  assert.equal(validateProductionReceipt(r, { allowedHosts }), r);
  const missing = structuredClone(r);
  missing.runners[0].codex = null;
  assert.throws(
    () => validateProductionReceipt(missing, { allowedHosts }),
    /Codex acceptance/,
  );
  const outside = structuredClone(r);
  outside.codex_host_ids.push("outsider");
  assert.throws(
    () => validateProductionReceipt(outside, { allowedHosts }),
    /subset/,
  );
});
function remote() {
  const root = make(),
    source = join(root, "source"),
    bare = join(root, "remote.git");
  mkdirSync(source);
  const git = (cwd, ...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  git(source, "init", "-q", "-b", "develop");
  git(source, "config", "user.name", "Test");
  git(source, "config", "user.email", "test@example.com");
  writeFileSync(join(source, "source"), "x");
  git(source, "add", ".");
  git(source, "commit", "-qm", "fixture");
  const revision = git(source, "rev-parse", "HEAD");
  const landing = {
    schema: 1,
    kind: "landing",
    repository_id: BUILD_REPOSITORY_ID,
    revision,
    branch: "develop",
    version: "2026.10.09.1",
    original_run_id: 1,
    created_at: "2026-10-09T00:00:00Z",
  };
  git(source, "tag", "-a", "v2026.10.09.1", "-m", JSON.stringify(landing));
  git(
    source,
    "update-ref",
    `refs/tags/identity/landing/${revision}`,
    git(source, "rev-parse", "refs/tags/v2026.10.09.1"),
  );
  git(root, "clone", "--bare", "-q", source, bare);
  git(source, "remote", "add", "origin", bare);
  return { root, source, bare, revision, git };
}

test("the workflow audits all tags before returning an existing claim", () => {
  const fixture = remote();
  const bin = join(fixture.root, "bin");
  mkdirSync(bin);
  const run = {
    id: 1,
    run_number: 1,
    workflow_id: 77,
    event: "push",
    head_branch: "develop",
    head_sha: fixture.revision,
    created_at: "2026-10-09T00:00:00Z",
    repository: { id: BUILD_REPOSITORY_ID },
    head_repository: { id: BUILD_REPOSITORY_ID },
  };
  const gh = join(bin, "gh");
  writeFileSync(
    gh,
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(run))});\n`,
  );
  chmodSync(gh, 0o700);
  const invoke = () =>
    spawnSync(
      process.execPath,
      [
        new URL("../landing-workflow.mjs", import.meta.url).pathname,
        "allocate",
      ],
      {
        cwd: fixture.source,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GH_TOKEN: "local-fixture-only",
          GITHUB_REPOSITORY: "sakuraiyuta/kaoiro",
          GITHUB_REPOSITORY_ID: String(BUILD_REPOSITORY_ID),
          GITHUB_RUN_ID: "1",
          KAOIRO_LANDING_FIRST_RUN_ID: "1",
          KAOIRO_LANDING_ENABLED: "true",
          KAOIRO_LANDING_CONTROL_SHA: fixture.revision,
          KAOIRO_IDENTITY_GATES_SHA: fixture.revision,
          KAOIRO_IDENTITY_V9: "true",
          KAOIRO_IDENTITY_V10: "true",
        },
      },
    );
  const refs = () =>
    fixture.git(fixture.source, "ls-remote", "--tags", "origin");
  const initial = refs();
  const accepted = invoke();
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(refs(), initial);
  const orphan = {
    schema: 1,
    kind: "landing",
    repository_id: BUILD_REPOSITORY_ID,
    revision: fixture.revision,
    branch: "develop",
    version: "2026.10.09.2",
    original_run_id: 2,
    created_at: "2026-10-09T00:00:01Z",
  };
  fixture.git(
    fixture.source,
    "tag",
    "-a",
    "v2026.10.09.2",
    "-m",
    JSON.stringify(orphan),
  );
  fixture.git(fixture.source, "push", "origin", "refs/tags/v2026.10.09.2");
  const corrupted = refs();
  const rejected = invoke();
  assert.equal(rejected.status, 78, rejected.stderr);
  assert.match(rejected.stderr, /claim|duplicate|inventory/);
  assert.equal(refs(), corrupted);
});
test("a redeploy with a new UUID reuses the immutable first release tag", () => {
  const { source, revision, git } = remote();
  const first = receipt(revision);
  const result = publishProductionRelease({
    cwd: source,
    receipt: first,
    ...options,
  });
  assert.equal(result.reused, false);
  const second = receipt(revision, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  second.runners[0].artifact_sha256 = "1".repeat(64);
  const repeated = publishProductionRelease({
    cwd: source,
    receipt: second,
    ...options,
  });
  assert.equal(repeated.reused, true);
  assert.equal(repeated.object, result.object);
  assert.equal(repeated.record.first_receipt_sha256, receiptDigest(first));
  assert.equal(
    git(source, "rev-parse", `refs/tags/${result.claim}`),
    git(source, "rev-parse", `refs/tags/${result.tag}`),
  );
});
test("only remote tag and claim read-back acknowledges a durable completed attempt", () => {
  const { root, source, revision } = remote();
  const identity = artifactBuildIdentity({
    revision,
    dirty: false,
    version: "2026.10.09.1",
    branch: "develop",
    channel: "dev",
    landing: {
      schema: 1,
      kind: "landing",
      repository_id: BUILD_REPOSITORY_ID,
      revision,
      branch: "develop",
      version: "2026.10.09.1",
      original_run_id: 1,
      created_at: "2026-10-09T00:00:00Z",
    },
  });
  const { dir, plan } = startReleaseAttempt(join(root, "attempts"), identity, [
    "runner-01",
  ]);
  const r = receipt(
    revision,
    plan.attempt_uuid,
    Date.parse(plan.created_at) + 10,
  );
  completeReleaseAttempt(dir, r, options);
  assert.throws(
    () => acknowledgeReleaseAttempt(dir, { cwd: source }),
    /not been acknowledged/,
  );
  const published = publishProductionRelease({
    cwd: source,
    receipt: r,
    ...options,
  });
  const ack = acknowledgeReleaseAttempt(dir, { cwd: source });
  assert.equal(ack.object, published.object);
  assert.equal(ack.attempt_uuid, plan.attempt_uuid);
  assert.deepEqual(acknowledgeReleaseAttempt(dir, { cwd: source }), ack);
  assert.equal(
    readFileSync(join(dir, "tag-ack.json"), "utf8"),
    `${JSON.stringify(ack)}\n`,
  );
});
test("an atomic release publication cannot leave only its public tag", () => {
  const { source, bare, revision, git } = remote();
  writeFileSync(
    join(bare, "hooks/update"),
    '#!/bin/sh\ncase "$1" in refs/tags/identity/release/*) exit 1;; esac\n',
    { mode: 0o755 },
  );
  assert.throws(() =>
    publishProductionRelease({
      cwd: source,
      receipt: receipt(revision),
      retries: 1,
      ...options,
    }),
  );
  assert.equal(
    git(
      source,
      "ls-remote",
      "--refs",
      "--tags",
      "origin",
      "refs/tags/release/*",
    ),
    "",
  );
});
test("forced/deleted and untrusted origins never become original landing records", () => {
  const run = {
    id: 2,
    created_at: "2026-10-09T23:59:59Z",
    event: "push",
    head_branch: "develop",
    head_sha: "a".repeat(40),
    repository: { id: BUILD_REPOSITORY_ID },
    head_repository: { id: BUILD_REPOSITORY_ID },
  };
  const event = {
    after: run.head_sha,
    ref: "refs/heads/develop",
    forced: false,
    deleted: false,
  };
  const record = originalPushRecord(event, run, BUILD_REPOSITORY_ID);
  assert.equal(
    validateOriginalRecord(record, run, BUILD_REPOSITORY_ID),
    record,
  );
  assert.equal(record.createdAt, "2026-10-09T23:59:59Z");
  for (const field of ["forced", "deleted"])
    assert.throws(() =>
      validateOriginalRecord(
        { ...record, [field]: true },
        run,
        BUILD_REPOSITORY_ID,
      ),
    );
  assert.throws(() =>
    originalPushRecord(
      event,
      { ...run, head_repository: { id: 1 } },
      BUILD_REPOSITORY_ID,
    ),
  );
});
test("receiver authorization covers original and rerun actors", () => {
  const run = {
    event: "workflow_dispatch",
    head_branch: "develop",
    repository: { id: BUILD_REPOSITORY_ID },
    head_repository: { id: BUILD_REPOSITORY_ID },
    actor: { login: "operator" },
    triggering_actor: { login: "operator" },
  };
  const options = {
    repositoryId: BUILD_REPOSITORY_ID,
    allowedActors: ["operator"],
  };
  validateDispatch(run, options);
  for (const bad of [
    { ...run, event: "pull_request" },
    { ...run, head_branch: "main" },
    { ...run, triggering_actor: { login: "other" } },
  ])
    assert.throws(() => validateDispatch(bad, options));
  for (const allowedActors of [
    "operator",
    null,
    {},
    [],
    ["operator", "operator"],
    [1],
  ]) {
    assert.throws(
      () => validateDispatch(run, { ...options, allowedActors }),
      /allow-list/,
    );
  }
});
test("host authority requires an array instead of substring matching a string", () => {
  for (const allowedHosts of [
    "runner-01",
    null,
    {},
    [],
    [1],
    ["runner-01", "runner-01"],
  ]) {
    assert.throws(
      () => validateProductionReceipt(receipt(), { allowedHosts }),
      /allow-list/,
    );
  }
});
test("fake dependencies cannot record a production completion", async () => {
  assert.throws(
    () =>
      collectRunnerCompletion(
        { attempt_uuid: "x", host_ids: ["runner-01"] },
        { attempt_uuid: "x", host_id: "runner-01", simulation: true },
        { systemctlBin: "fake" },
      ),
    /fake service/,
  );
  await assert.rejects(
    collectServerCompletion({}, { dockerBin: "fake" }),
    /fake Docker/,
  );
});

test("the operator card binds the fixed workflow/ref and audit reports omitted publication", () => {
  const { root, source, revision } = remote();
  const identity = artifactBuildIdentity({
    revision,
    dirty: false,
    version: "2026.10.09.1",
    branch: "develop",
    channel: "dev",
    landing: {
      schema: 1,
      kind: "landing",
      repository_id: BUILD_REPOSITORY_ID,
      revision,
      branch: "develop",
      version: "2026.10.09.1",
      original_run_id: 1,
      created_at: "2026-10-09T00:00:00Z",
    },
  });
  const attempts = join(root, "attempts"),
    { dir, plan } = startReleaseAttempt(attempts, identity, ["runner-01"]);
  const r = receipt(
    revision,
    plan.attempt_uuid,
    Date.parse(plan.created_at) + 10,
  );
  completeReleaseAttempt(dir, r, options);
  assert.throws(
    () => productionDispatchCard({ dir, cwd: source }),
    /enrolled authority/,
  );
  const server = join(source, "server"),
    tools = join(root, "tools");
  mkdirSync(server, { mode: 0o700 });
  const manifest = stageReleaseTools(
    resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
    tools,
  );
  const fixedNode = join(root, "pinned-node"), nodeCalls = join(root, "node-calls");
  writeFileSync(fixedNode,
    `#!/bin/sh\nprintf '%s\\n' "$1" >> '${nodeCalls}'\nexec '${process.execPath}' "$@"\n`,
    { mode: 0o755 });
  const descriptor = {
    schema: 1,
    install_root: server,
    transport: "local",
    recording_hostname: hostname(),
    root: attempts,
    tool_sha256: manifest.sha256,
    exporter_path: join(tools, "scripts/production-release-launcher.mjs"),
    node_major: Number(process.versions.node.split(".")[0]),
    node_path: fixedNode,
  };
  writeFileSync(
    join(server, ".kaoiro-release-authority.json"),
    releaseJsonBytes(descriptor),
    { mode: 0o600 },
  );
  const authority = readReleaseAuthority(server, { role: "server" });
  plan.runtime_hosts = [
    { alias: "runner-01", runtime_host_id: "private-host-marker" },
  ];
  plan.authority = {
    server: { root: server, sha256: authority.sha256 },
    runners: [{ alias: "runner-01", root: server, sha256: authority.sha256 }],
  };
  writeFileSync(join(dir, "attempt.json"), releaseJsonBytes(plan), {
    mode: 0o600,
  });
  writeFileSync(
    `${attempts}-inventory.json`,
    releaseJsonBytes({
      schema: 1,
      runtime_hosts: plan.runtime_hosts,
      authority: plan.authority,
    }),
    { mode: 0o600 },
  );
  const card = productionDispatchCard({ dir, cwd: source });
  assert.equal(card.repository, "sakuraiyuta/kaoiro");
  assert.equal(card.workflow, "production-release.yml");
  assert.equal(card.ref, "develop");
  assert.ok(
    card.command.startsWith(card.landing_audit + " && " + card.dispatch),
  );
  assert.ok(card.command.includes(revision));
  assert.equal(card.receipt_sha256, receiptDigest(r));
  assert.ok(
    card.verification.includes(
      " collect '" + manifest.sha256 + "' ack --server-dir",
    ),
  );
  assert.ok(card.command.endsWith(card.verification));
  assert.ok(card.landing_audit.startsWith(`'${fixedNode}' `));
  const landingFixture = repairFixture();
  try {
    const pendingCard = productionDispatchCard({ dir, cwd: landingFixture.repo, repository: "fixture/repo" });
    const pending = spawnSync("sh", ["-c", pendingCard.command], {
      cwd: landingFixture.repo, env: landingFixture.env, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(pending.status, 78, pending.stderr);
    assert.equal(existsSync(landingFixture.marker), false, "pending landing must stop the generated card before dispatch");
    assert.equal(readFileSync(nodeCalls, "utf8").trim(),
      join(landingFixture.repo, "scripts/landing-repair.mjs"));
  } finally { landingFixture.dispose(); }
  const { status } = spawnSync("sh", ["-c", card.verification], {
    encoding: "utf8",
  });
  assert.notEqual(status, 0);
  assert.deepEqual(
    auditProductionCompletions({ root: attempts, cwd: source }).map(
      (row) => row.status,
    ),
    ["publication_missing"],
  );
  publishProductionRelease({ cwd: source, receipt: r, ...options });
  assert.deepEqual(
    auditProductionCompletions({ root: attempts, cwd: source }).map(
      (row) => row.status,
    ),
    ["published"],
  );
  writeFileSync(
    join(dir, "server-audit.json"),
    releaseJsonBytes({
      schema: 1,
      attempt_uuid: plan.attempt_uuid,
      pass: true,
      root: server,
      authority_sha256: authority.sha256,
      release_context: {
        attempt_uuid: plan.attempt_uuid,
        plan_sha256: receiptDigest(plan),
      },
      transaction_dir: join(root, "pruned-native-transaction"),
    }),
    { mode: 0o600 },
  );
  const published = spawnSync("sh", ["-c", card.verification], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(published.status, 0, published.stderr);
  const y = startReleaseAttempt(
    attempts,
    identity,
    ["runner-01"],
    ["runner-01"],
    { runtime_hosts: plan.runtime_hosts, authority: plan.authority },
  );
  const unreported = spawnSync("sh", ["-c", card.verification], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.notEqual(
    unreported.status,
    0,
    "ACK of X must not bypass another unresolved attempt Y",
  );
  assert.match(unreported.stderr, /unresolved attempts/);
  rmSync(y.dir, { recursive: true });

  const anotherTarget = structuredClone(plan);
  anotherTarget.identity.revision = "b".repeat(40);
  anotherTarget.identity.landing.revision = "b".repeat(40);
  writeFileSync(join(dir, "attempt.json"), JSON.stringify(anotherTarget));
  assert.throws(
    () => productionDispatchCard({ dir, cwd: source }),
    /attempt differs/,
  );
  writeFileSync(join(dir, "attempt.json"), JSON.stringify(plan));
  writeFileSync(
    join(dir, "completion.json"),
    JSON.stringify({
      ...r,
      attempt_uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    }),
  );
  assert.throws(
    () => productionDispatchCard({ dir, cwd: source }),
    /attempt differs/,
  );
  assert.equal(
    auditProductionCompletions({ root: attempts, cwd: source })[0].status,
    "invalid_completion",
  );
});
