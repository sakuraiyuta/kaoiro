import { installChildFixture } from "./fixtures/child-process-fixture.mjs";
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import {
  artifactBuildIdentity,
  BUILD_REPOSITORY_ID,
} from "../build-identity.mjs";
import { startReleaseAttempt } from "../production-release-record.mjs";
import {
  cleanupProductionRunner,
  inspectProductionRunnerActivity,
  listRetainedProductionRunners,
  queueProductionRunner,
  runWorkerCli,
  runnerWorkerUnit,
} from "../production-runner-worker.mjs";
import {
  collectRunnerCompletion,
  runCollectionCli,
} from "../collect-production-release.mjs";
import { readReleaseAuthority } from "../production-release-authority.mjs";
import { stageReleaseTools } from "../production-release-tools.mjs";
import {
  releaseBytesDigest,
  releaseJsonBytes,
} from "../production-release-files.mjs";
import {
  canonicalRunnerReleaseRow,
  installRunnerReleasePlan,
  validateRunnerLifecycleContext,
} from "../production-release-runner-facts.mjs";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureService = "kaoiro-fuji571-worker-fixture";
const restorers = [];
const roots = [],
  saved = new Map();
function env(key, value) {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  process.env[key] = value;
}
afterEach(() => {
  for (const restore of restorers.splice(0).reverse()) restore();
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kaoiro-retained-worker-test-"));
  roots.push(root);
  const bin = join(root, "bin"),
    runner = join(root, "runner"),
    history = join(root, "history"),
    revision = "a".repeat(40),
    old = "b".repeat(40);
  for (const path of [bin, runner, history]) mkdirSync(path, { mode: 0o700 });
  const deploy = join(runner, "releases", old, "deploy");
  mkdirSync(deploy, { recursive: true });
  for (const name of readdirSync(join(source, "runner/deploy")))
    copyFileSync(join(source, "runner/deploy", name), join(deploy, name));
  const tools = join(deploy, "release-tools"),
    manifest = stageReleaseTools(source, tools);
  symlinkSync(`releases/${old}`, join(runner, "current"));
  const descriptor = {
    schema: 1,
    install_root: runner,
    transport: "local",
    recording_hostname: hostname(),
    root: history,
    tool_sha256: manifest.sha256,
    exporter_path: join(tools, "scripts/production-release-launcher.mjs"),
    node_major: Number(process.versions.node.split(".")[0]),
    node_path: process.execPath,
  };
  writeFileSync(
    join(runner, "release-authority.json"),
    releaseJsonBytes(descriptor),
    { mode: 0o600 },
  );
  const authority = readReleaseAuthority(runner);
  const pairs = [
    { alias: "worker-a", runtime_host_id: "private-machine-marker" },
  ];
  writeFileSync(
    join(runner, "release-host-aliases.json"),
    releaseJsonBytes(pairs),
    { mode: 0o600 },
  );
  const configPath = join(root, "runner.config.json");
  writeFileSync(
    configPath,
    releaseJsonBytes({ host_id: pairs[0].runtime_host_id }),
    { mode: 0o600 },
  );
  env("KAOIRO_RUNNER_DIR", root);
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
  const planOptions = {
    runtime_hosts: pairs,
    authority: {
      server: { root: join(root, "server"), sha256: "c".repeat(64) },
      runners: [{ alias: "worker-a", root: runner, sha256: authority.sha256 }],
    },
  };
  const attempt = startReleaseAttempt(
    history,
    identity,
    ["worker-a"],
    [],
    planOptions,
  );
  const parent = join(runner, "production-attempts");
  mkdirSync(parent, { mode: 0o700 });
  const dir = join(parent, attempt.plan.attempt_uuid);
  mkdirSync(dir, { mode: 0o700 });
  copyFileSync(join(attempt.dir, "attempt.json"), join(dir, "attempt.json"));
  const plan = attempt.plan,
    unit = runnerWorkerUnit(plan.attempt_uuid, "worker-a"),
    baselineFile = join(dir, "runner-baseline-worker-a.json");
  const stateFile = join(root, "state.json"),
    callsFile = join(root, "calls.jsonl");
  writeFileSync(stateFile, "{}");
  writeFileSync(callsFile, "");
  const program = `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);const bin=require('node:path').basename(process.argv[1]);fs.appendFileSync(process.env.GATE_CALLS,JSON.stringify({bin,args:a})+'\\n');const states=JSON.parse(fs.readFileSync(process.env.GATE_STATE));if(bin==='busctl'){const b=JSON.parse(fs.readFileSync(process.env.GATE_BASELINE));console.log(JSON.stringify({type:'a(sasasttttuii)',data:[[b.node_path,[b.node_path,b.launcher,'worker',b.tool_sha256,require('node:path').dirname(b.updater_tool),...b.update_args],['no-env-expand'],0,0,0,0,0,0,0]]}));}if(a[1]==='show'){const value=states[a.at(-1)]??{LoadState:'not-found',ActiveState:'inactive',InvocationID:''};console.log(Object.entries(value).map(([k,v])=>k+'='+v).join('\\n'));}if(a[1]==='stop'){for(const unit of a.slice(3))delete states[unit];fs.writeFileSync(process.env.GATE_STATE,JSON.stringify(states));}if(a[1]==='reset-failed')process.exit(1);\n`;
  for (const name of ["systemctl", "systemd-run", "busctl"])
    writeFileSync(join(bin, name), program, { mode: 0o755 });
  env("PATH", `${bin}:${process.env.PATH}`);
  env("GATE_STATE", stateFile);
  env("GATE_CALLS", callsFile);
  env("GATE_BASELINE", baselineFile);
  restorers.push(installChildFixture(bin, { GATE_STATE: stateFile, GATE_CALLS: callsFile, GATE_BASELINE: baselineFile }));
  const queue = (extra) =>
    queueProductionRunner({
      service: fixtureService,
      dir,
      host: "worker-a",
      runnerRoot: runner,
      configPath,
      updateArgs: ["--from-repo", root],
      ...extra,
    });
  const calls = () =>
    readFileSync(callsFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
  const state = (values) => writeFileSync(stateFile, JSON.stringify(values));
  const finished = {
    LoadState: "loaded",
    ActiveState: "active",
    SubState: "exited",
    Result: "success",
    ExecMainCode: "1",
    ExecMainStatus: "0",
    InvocationID: "e".repeat(32),
  };
  return {
    root,
    dir,
    plan,
    unit,
    queue,
    calls,
    state,
    finished,
    bin,
    runner,
    authority,
    identity,
    history,
    planOptions,
    canonical: attempt.dir,
    configPath,
    baselineFile,
  };
}

test("the default queue constructor reaches the real canonical importer before submitting a fake manager command", async () => {
  assert.match(fixtureService, /^kaoiro-fuji571-/);
  const f = fixture(),
    result = await f.queue();
  assert.equal(result.completed, false);
  assert.equal(result.delay_seconds, 180);
  const baseline = JSON.parse(readFileSync(result.baseline_file));
  assert.equal(baseline.service, fixtureService);
  assert.equal(baseline.updater, f.unit);
  assert.equal(baseline.alias, "worker-a");
  const invocation = f.calls().find((call) => call.bin === "systemd-run");
  for (const arg of [
    "--on-active=180s",
    "--property=Type=oneshot",
    "--property=RemainAfterExit=yes",
    "--timer-property=AccuracySec=1s",
    "--timer-property=RandomizedDelaySec=0",
    "--no-block",
    "--expand-environment=no",
  ])
    assert.ok(invocation.args.includes(arg));
  assert.ok(!invocation.args.includes("--detach"));
  assert.ok(
    !invocation.args.some((arg) => arg.includes("KAOIRO_RUNNER_TOKEN=")),
  );
  assert.ok(invocation.args.includes(baseline.launcher));
  assert.ok(invocation.args.includes(f.plan.attempt_uuid));
  assert.ok(!f.unit.includes("private-machine-marker"));
  const activities = readdirSync(f.canonical)
    .filter((name) => name.startsWith("runner-activity-"))
    .map((name) => JSON.parse(readFileSync(join(f.canonical, name))));
  assert.deepEqual(activities.map((row) => row.state).sort(), [
    "intent",
    "queued",
  ]);
  await assert.rejects(f.queue(), /already queued/);
  assert.equal(
    f.calls().filter((call) => call.bin === "systemd-run").length,
    1,
  );
});

test("uncertain submission remains reserved and canonical intent is not silently idle", async () => {
  const f = fixture();
  writeFileSync(join(f.bin, "systemd-run"), "#!/bin/sh\nexit 1\n", {
    mode: 0o755,
  });
  await assert.rejects(f.queue());
  await assert.rejects(f.queue(), /already queued/);
  const states = readdirSync(f.canonical)
    .filter((name) => name.startsWith("runner-activity-"))
    .map((name) => JSON.parse(readFileSync(join(f.canonical, name))).state);
  assert.deepEqual(states, ["intent"]);
});

test("invalid queue arguments and a unit collision refuse before submission", async () => {
  const f = fixture();
  f.state({ [f.unit]: { LoadState: "loaded", ActiveState: "active" } });
  await assert.rejects(f.queue(), /already exists/);
  f.state({});
  for (const delaySeconds of [0, -1, NaN, 86401])
    await assert.rejects(f.queue({ delaySeconds }), /delay/);
  for (const updateArgs of [
    ["--allow-dirty", "yes"],
    ["--tarball", "x", "--from-repo", "y"],
    ["--from-repo", "x", "--codex-home", "h", "--codex-backup-dir", "b"],
    ["--from-repo", "x", "--release-attempt", "f".repeat(36)],
  ])
    await assert.rejects(f.queue({ updateArgs }));
  assert.equal(
    f.calls().filter((call) => call.bin === "systemd-run").length,
    0,
  );
});

test("a queue UUID skip for A does not cover an older in-progress B", async () => {
  const f = fixture();
  const a = startReleaseAttempt(
    f.history,
    f.identity,
    ["worker-a"],
    [],
    f.planOptions,
  );
  startReleaseAttempt(f.history, f.identity, ["worker-a"], [], f.planOptions);
  await assert.rejects(
    f.queue({
      updateArgs: [
        "--from-repo",
        f.root,
        "--skip-release-reconciliation",
        a.plan.attempt_uuid,
        "--skip-reason",
        "deferred only A",
      ],
    }),
    /unresolved attempts/,
  );
  assert.equal(
    f.calls().filter((call) => call.bin === "systemd-run").length,
    0,
  );
});

test("cleanup cannot use a runner-local fabricated completion as authority", async () => {
  const f = fixture();
  await f.queue();
  f.state({ [f.unit]: f.finished });
  writeFileSync(join(f.dir, "completion.json"), "{}", { mode: 0o600 });
  assert.throws(
    () =>
      cleanupProductionRunner({
        dir: f.dir,
        host: "worker-a",
        runnerRoot: f.runner,
        configPath: f.configPath,
      }),
    /canonical completion/,
  );
  assert.equal(f.calls().filter((call) => call.args[1] === "stop").length, 0);
});

test("completion rejects a worker without the independently enrolled baseline", () => {
  assert.throws(
    () =>
      collectRunnerCompletion(
        { attempt_uuid: "x", host_ids: ["worker-a"] },
        { attempt_uuid: "x", host_id: "worker-a", simulation: true },
        { systemctlBin: "fake" },
      ),
    /fake service/,
  );
  const f = fixture();
  assert.throws(
    () =>
      collectRunnerCompletion(
        f.plan,
        {
          attempt_uuid: f.plan.attempt_uuid,
          alias: "worker-a",
          simulation: false,
        },
        { runnerRoot: f.runner, configPath: f.configPath },
      ),
    /baseline lacks/,
  );
});

test("the real plan-transfer constructor commits only bytes that match the canonical private plan", () => {
  const f = fixture(),
    raw = readFileSync(join(f.canonical, "attempt.json"));
  rmSync(f.dir, { recursive: true });
  const installed = installRunnerReleasePlan({
    root: f.runner,
    raw,
    alias: "worker-a",
    configPath: f.configPath,
  });
  assert.equal(installed.plan_sha256, releaseBytesDigest(raw));
  assert.deepEqual(readdirSync(join(f.runner, "production-attempts")), [
    f.plan.attempt_uuid,
  ]);
  assert.equal(
    installRunnerReleasePlan({
      root: f.runner,
      raw,
      alias: "worker-a",
      configPath: f.configPath,
    }).plan_sha256,
    installed.plan_sha256,
  );
  assert.throws(
    () =>
      installRunnerReleasePlan({
        root: f.runner,
        raw: releaseJsonBytes({
          ...f.plan,
          created_at: new Date(0).toISOString(),
        }),
        alias: "worker-a",
        configPath: f.configPath,
      }),
    /canonical/,
  );
  writeFileSync(
    f.configPath,
    releaseJsonBytes({ host_id: "another-private-host" }),
  );
  assert.throws(
    () =>
      installRunnerReleasePlan({
        root: f.runner,
        raw,
        alias: "worker-a",
        configPath: f.configPath,
      }),
    /live config/,
  );
});

test("the collection CLI freezes the fixed enrollment and refuses arbitrary output paths", async () => {
  const f = fixture(),
    server = join(f.root, "server");
  mkdirSync(server, { mode: 0o700 });
  const descriptor = { ...f.authority.descriptor, install_root: server };
  writeFileSync(
    join(server, ".kaoiro-release-authority.json"),
    releaseJsonBytes(descriptor),
    { mode: 0o600 },
  );
  const serverAuthority = readReleaseAuthority(server, { role: "server" });
  const inventory = {
    schema: 1,
    runtime_hosts: f.plan.runtime_hosts,
    authority: {
      ...f.plan.authority,
      server: { root: server, sha256: serverAuthority.sha256 },
    },
  };
  writeFileSync(`${f.history}-inventory.json`, releaseJsonBytes(inventory), {
    mode: 0o600,
  });
  const identityFile = join(f.root, "identity.json");
  writeFileSync(identityFile, releaseJsonBytes(f.identity), { mode: 0o600 });
  const args = [
    "start",
    "--server-dir",
    server,
    "--identity",
    identityFile,
    "--codex-hosts",
    "[]",
  ];
  const result = await runCollectionCli(args);
  assert.deepEqual(result.plan.authority, inventory.authority);
  assert.deepEqual(result.plan.runtime_hosts, inventory.runtime_hosts);
  const saved = JSON.parse(readFileSync(join(result.dir, "attempt.json")));
  assert.deepEqual(saved, result.plan);
  await assert.rejects(
    runCollectionCli([...args, "--hosts", "[]"]),
    /cannot narrow/,
  );
  await assert.rejects(
    runCollectionCli([...args, "--output", join(f.root, "victim")]),
    /invalid or repeated/,
  );
  await assert.rejects(
    runCollectionCli([...args, "--root", f.runner]),
    /cannot substitute/,
  );
  writeFileSync(
    join(server, ".kaoiro-release-authority.json"),
    releaseJsonBytes({
      ...descriptor,
      node_major: descriptor.node_major === 22 ? 24 : 22,
    }),
  );
  await assert.rejects(runCollectionCli(args), /inventory differs/);
});

test("native activity inspection closes uncertain intent only after exact units are idle", async () => {
  const f = fixture();
  await f.queue();
  f.state({
    [f.unit.replace(/\.service$/, ".timer")]: {
      LoadState: "loaded",
      ActiveState: "active",
    },
  });
  await assert.rejects(
    inspectProductionRunnerActivity({
      runnerRoot: f.runner,
      uuid: f.plan.attempt_uuid,
      host: "worker-a",
      configPath: f.configPath,
    }),
    /queued\/running/,
  );
  const idle = await inspectProductionRunnerActivity({
    runnerRoot: f.runner,
    uuid: f.plan.attempt_uuid,
    host: "worker-a",
    configPath: f.configPath,
    cancel: true,
  });
  assert.equal(idle.idle, true);
  const stops = f.calls().filter((call) => call.args[1] === "stop");
  assert.deepEqual(
    stops.map((call) => call.args.slice(3)),
    [[f.unit.replace(/\.service$/, ".timer")]],
  );
  const states = readdirSync(f.canonical)
    .filter((name) => name.startsWith("runner-activity-"))
    .map((name) => JSON.parse(readFileSync(join(f.canonical, name))));
  assert.equal(
    states.sort((a, b) => a.sequence - b.sequence).at(-1).state,
    "idle",
  );
  f.state({
    [f.unit]: {
      LoadState: "loaded",
      ActiveState: "activating",
      SubState: "start",
      MainPID: "123",
      InvocationID: "e".repeat(32),
    },
  });
  await assert.rejects(
    inspectProductionRunnerActivity({
      runnerRoot: f.runner,
      uuid: f.plan.attempt_uuid,
      host: "worker-a",
      configPath: f.configPath,
      cancel: true,
    }),
    /never-started/,
  );
  assert.equal(f.calls().filter((call) => call.args[1] === "stop").length, 1);
});

test("a planless lifecycle event uses the full fixed enrollment instead of a damaged plan", async () => {
  const f = fixture();
  const inventory = { schema: 1, ...f.planOptions };
  writeFileSync(`${f.history}-inventory.json`, releaseJsonBytes(inventory), {
    mode: 0o600,
  });
  writeFileSync(join(f.canonical, "attempt.json"), "broken-plan", {
    mode: 0o600,
  });
  const result = await inspectProductionRunnerActivity({
    runnerRoot: f.runner,
    uuid: f.plan.attempt_uuid,
    host: "worker-a",
    configPath: f.configPath,
  });
  assert.equal(result.idle, true);
  const filename = readdirSync(f.canonical).find((name) =>
    name.startsWith("runner-lifecycle-activity-"),
  );
  const fact = JSON.parse(readFileSync(join(f.canonical, filename)));
  assert.equal(
    fact.inventory_sha256,
    releaseBytesDigest(releaseJsonBytes(inventory)),
  );
  assert.equal(
    fact.plan_sha256,
    releaseBytesDigest(Buffer.from("broken-plan")),
  );
  writeFileSync(
    f.configPath,
    releaseJsonBytes({ host_id: "different-machine" }),
  );
  await assert.rejects(
    inspectProductionRunnerActivity({
      runnerRoot: f.runner,
      uuid: f.plan.attempt_uuid,
      host: "worker-a",
      configPath: f.configPath,
    }),
    /inventory\/live config differs/,
  );
});

test("the default quarantine CLI resolves empty, corrupt-plan and corrupt-terminal records through native inventory evidence", async () => {
  const { createServer } = await import("node:http");
  const { runLifecycleCli } = await import(
    "../production-release-lifecycle.mjs"
  );
  const { readReleaseAttempt } = await import(
    "../production-release-history.mjs"
  );
  const f = fixture(),
    inventory = { schema: 1, ...f.planOptions };
  const health = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ build_revision: "b".repeat(40) }));
  });
  await new Promise((resolve) => health.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${health.address().port}/health`;
    inventory.health_url = url;
    writeFileSync(`${f.history}-inventory.json`, releaseJsonBytes(inventory), { mode: 0o600 });
    for (const damage of [
      "empty",
      "plan",
      "terminal",
      "baseline",
      "activity",
      "canary",
      "server-audit",
      "completion",
    ]) {
      const attempt = startReleaseAttempt(
          f.history,
          f.identity,
          ["worker-a"],
          [],
          f.planOptions,
        ),
        uuid = attempt.plan.attempt_uuid;
      if (damage === "empty") rmSync(join(attempt.dir, "attempt.json"));
      else if (damage === "plan")
        writeFileSync(join(attempt.dir, "attempt.json"), "broken-plan", {
          mode: 0o600,
        });
      else {
        installRunnerReleasePlan({
          root: f.runner,
          raw: readFileSync(join(attempt.dir, "attempt.json")),
          alias: "worker-a",
          configPath: f.configPath,
        });
        const file =
          damage === "terminal"
            ? "quarantine.json"
            : damage === "baseline"
              ? "runner-baseline-worker-a.json"
              : damage === "activity"
                ? `runner-activity-worker-a-${(await import("node:crypto")).randomUUID()}.json`
                : `${damage}.json`;
        writeFileSync(join(attempt.dir, file), "broken-record", {
          mode: 0o600,
        });
      }
      const args = [
        "quarantine",
        "--root",
        f.history,
        "--uuid",
        uuid,
        "--reason",
        "operator preserved corrupt history",
        "--health-url",
        url,
      ];
      await assert.rejects(runLifecycleCli([...args.slice(0, -1), `${url}/staging`]), /differs from fixed enrollment/);
      await assert.rejects(runLifecycleCli(args), /activity/);
      await inspectProductionRunnerActivity({
        runnerRoot: f.runner,
        uuid,
        host: "worker-a",
        configPath: f.configPath,
      });
      if (damage === "baseline") {
        writeFileSync(
          join(attempt.dir, "runner-baseline-worker-a.json"),
          "changed-damaged-record",
          { mode: 0o600 },
        );
        await assert.rejects(
          runLifecycleCli(args),
          /lifecycle evidence differs/,
        );
        await inspectProductionRunnerActivity({
          runnerRoot: f.runner,
          uuid,
          host: "worker-a",
          configPath: f.configPath,
        });
      }
      const result = await runLifecycleCli(args);
      assert.equal(result.kind, "invalid_quarantined");
      assert.equal(
        readReleaseAttempt(attempt.dir).state.id,
        "invalid_quarantined",
      );
    }
  } finally {
    await new Promise((resolve) => health.close(resolve));
  }
});

test("queue rejects Unicode control values before manager submission", async () => {
  const f = fixture();
  for (const character of ["\u0085", "\u202e", "\u2028", "\u2029"]) {
    await assert.rejects(f.queue({ updateArgs: ["--tarball", `/private/${character}artifact`] }), /invalid updater argument/);
  }
  assert.equal(f.calls().some(call => call.bin === "systemd-run"), false);
});

test("the actual queue CLI accepts a JSON envelope larger than 4096 bytes before checking each value", async () => {
  const f = fixture();
  const uuids = Array.from({ length: 100 }, (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`).join(",");
  const args = JSON.stringify(["--tarball", "/private/artifact", "--skip-release-reconciliation", uuids,
    "--skip-reason", "x".repeat(512)]);
  assert.ok(Buffer.byteLength(args) > 4096);
  const result = await runWorkerCli(["queue", "--attempt", f.dir, "--host", "worker-a",
    "--service", fixtureService,
    "--runner-root", f.runner, "--config", f.configPath, "--update-args", args]);
  assert.equal(result.queued, true);
});

test("retained listing checks raw names and keeps corrupt working attempts visible", () => {
  const f = fixture(),
    parent = dirname(f.dir);
  assert.deepEqual(listRetainedProductionRunners(parent), []);
  writeFileSync(join(f.dir, "attempt.json"), "broken-plan", { mode: 0o600 });
  assert.equal(listRetainedProductionRunners(parent)[0].warning, true);
  assert.equal(
    listRetainedProductionRunners(parent)[0].status,
    "invalid_completion",
  );
  mkdirSync(join(parent, ".lock.unregistered"), { mode: 0o700 });
  assert.throws(
    () => listRetainedProductionRunners(parent),
    /unknown release history entry/,
  );
});

test("lifecycle context rejects changed damaged bytes before its native activity can be imported", () => {
  const f = fixture();
  writeFileSync(
    `${f.history}-inventory.json`,
    releaseJsonBytes({ schema: 1, ...f.planOptions }),
    { mode: 0o600 },
  );
  const damaged = join(f.canonical, "runner-baseline-worker-a.json");
  writeFileSync(damaged, "broken-baseline", { mode: 0o600 });
  const context = validateRunnerLifecycleContext({
    root: f.runner,
    uuid: f.plan.attempt_uuid,
    alias: "worker-a",
    configPath: f.configPath,
  });
  assert.equal(canonicalRunnerReleaseRow(context).status, "invalid_completion");
  writeFileSync(damaged, "different-broken-baseline", { mode: 0o600 });
  assert.throws(
    () => canonicalRunnerReleaseRow(context),
    /canonical invalid row\/enrollment inventory changed/,
  );
});
