import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  artifactBuildIdentity,
  BUILD_REPOSITORY_ID,
} from "../build-identity.mjs";
import { runCollectionCli } from "../collect-production-release.mjs";
import { readReleaseAuthority } from "../production-release-authority.mjs";
import {
  readPrivateJson,
  releaseJsonBytes,
  writePrivateRecord,
} from "../production-release-files.mjs";
import { startReleaseAttempt } from "../production-release-record.mjs";
import { installRunnerReleasePlan } from "../production-release-runner-facts.mjs";
import { stageReleaseTools } from "../production-release-tools.mjs";
import { unitSnapshot } from "../production-release-unit.mjs";
import {
  cleanupProductionRunner,
  queueProductionRunner,
  runnerWorkerUnit,
} from "../production-runner-worker.mjs";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const run = (bin, args) =>
  execFileSync(bin, args, {
    encoding: "utf8",
    timeout: 15000,
    stdio: ["ignore", "pipe", "pipe"],
  });

test(
  "an owned real retained worker connects native invocation, updater proof, imported completion and exact cleanup",
  { skip: process.env.KAOIRO_RELEASE_UNIT_PROBE !== "1", timeout: 45000 },
  async () => {
    const { writeReleaseTree, revisionOf } = await import(
      "../../runner/test/releaseFixture.ts"
    );
    const base = mkdtempSync(join(tmpdir(), "kaoiro-fuji571-native-worker-"));
    const root = join(base, "runner"),
      history = join(base, "history"),
      configDir = join(base, "config"),
      bin = join(base, "bin");
    for (const path of [root, history, configDir, bin])
      mkdirSync(path, { mode: 0o700 });
    const old = revisionOf("owned-native-source"),
      target = revisionOf("owned-native-target");
    const tree = writeReleaseTree(join(root, "releases", old), old, {
      manifest: false,
    });
    const tools = join(tree, "deploy/release-tools"),
      manifest = stageReleaseTools(source, tools);
    run(process.execPath, [
      join(source, "scripts/build-release-manifest.mjs"),
      tree,
    ]);
    symlinkSync(`releases/${old}`, join(root, "current"));
    const candidate = writeReleaseTree(join(base, "candidate"), target, {
      manifest: false,
      buildVersion: "2026.10.09.1",
      buildBranch: "develop",
    });
    stageReleaseTools(source, join(candidate, "deploy/release-tools"));
    run(process.execPath, [
      join(source, "scripts/build-release-manifest.mjs"),
      candidate,
    ]);
    const tarball = join(base, "target.tar.gz");
    run("tar", ["czf", tarball, "-C", base, "candidate"]);
    const descriptor = {
      schema: 1,
      install_root: root,
      transport: "local",
      recording_hostname: hostname(),
      root: history,
      tool_sha256: manifest.sha256,
      exporter_path: join(tools, "scripts/production-release-launcher.mjs"),
      node_major: Number(process.versions.node.split(".")[0]),
      node_path: process.execPath,
    };
    writeFileSync(
      join(root, "release-authority.json"),
      releaseJsonBytes(descriptor),
      { mode: 0o600 },
    );
    const authority = readReleaseAuthority(root),
      pairs = [
        { alias: "worker-a", runtime_host_id: "private-native-fixture" },
      ];
    writeFileSync(
      join(root, "release-host-aliases.json"),
      releaseJsonBytes(pairs),
      { mode: 0o600 },
    );
    const identity = artifactBuildIdentity({
      revision: target,
      dirty: false,
      version: "2026.10.09.1",
      branch: "develop",
      channel: "dev",
      landing: {
        schema: 1,
        kind: "landing",
        repository_id: BUILD_REPOSITORY_ID,
        revision: target,
        branch: "develop",
        version: "2026.10.09.1",
        original_run_id: 1,
        created_at: "2026-10-09T00:00:00Z",
      },
    });
    const attempt = startReleaseAttempt(history, identity, ["worker-a"], [], {
      runtime_hosts: pairs,
      authority: {
        server: { root: join(base, "server"), sha256: "c".repeat(64) },
        runners: [{ alias: "worker-a", root, sha256: authority.sha256 }],
      },
    });
    const unit = runnerWorkerUnit(attempt.plan.attempt_uuid, "worker-a"),
      service = `kaoiro-fixture-runner-${attempt.plan.attempt_uuid}`;
    const calls = join(base, "fixture-service-calls"),
      configPath = join(configDir, "runner.config.json");
    // Only this fixture service is simulated; the retained service/timer and typed D-Bus reads are native.
    writeFileSync(
      join(bin, "systemctl"),
      `#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');const a=process.argv.slice(2);if(a.at(-1)!==${JSON.stringify(service)}){try{cp.execFileSync('/usr/bin/systemctl',a,{stdio:'inherit'});}catch(e){process.exit(e.status??1);}process.exit(0);}fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');if(a[1]==='show'){if(a.some(x=>x.includes('LoadState,')))console.log('LoadState=loaded\\nActiveState=active\\nSubState=running\\nMainPID=123');else console.log('{ path=${root}/current/deploy/kaoiro-runner-launch.sh ; argv[]=${root}/current/deploy/kaoiro-runner-launch.sh ; }');}\n`,
      { mode: 0o755 },
    );
    const health = createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          status: "ok",
          build_identity_formats: ["legacy-calver", "landing-calver-v1"],
        }),
      );
    });
    await new Promise((resolve) => health.listen(0, "127.0.0.1", resolve));
    writeFileSync(
      configPath,
      releaseJsonBytes({
        host_id: pairs[0].runtime_host_id,
        server_url: `ws://127.0.0.1:${health.address().port}/socket`,
      }),
      { mode: 0o600 },
    );
    const saved = {
      PATH: process.env.PATH,
      KAOIRO_NODE: process.env.KAOIRO_NODE,
    };
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.KAOIRO_NODE = process.execPath;
    try {
      const context = installRunnerReleasePlan({
        root,
        raw: readFileSync(join(attempt.dir, "attempt.json")),
        alias: "worker-a",
        configPath,
      });
      await queueProductionRunner({
        dir: context.dir,
        host: "worker-a",
        runnerRoot: root,
        configPath,
        service,
        delaySeconds: 1,
        updateArgs: ["--tarball", tarball],
      });
      let state;
      for (let i = 0; i < 150; i++) {
        state = unitSnapshot(unit);
        if (state.SubState === "exited" || state.ActiveState === "failed")
          break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (state.ActiveState === "failed") {
        const logs = run("journalctl", [
          "--user",
          `--unit=${unit}`,
          "--no-pager",
          "--lines=50",
        ]);
        assert.fail(`${JSON.stringify(state)}\n${logs}`);
      }
      assert.equal(state.SubState, "exited");
      assert.equal(state.ExecMainStatus, "0");
      assert.equal(readlinkSync(join(root, "current")), `releases/${target}`);
      const imported = await runCollectionCli([
        "runner-after",
        "--runner-root",
        root,
        "--attempt",
        context.dir,
        "--host",
        "worker-a",
        "--config",
        configPath,
      ]);
      assert.equal(imported.imported, true);
      const fact = readPrivateJson(
        join(attempt.dir, "runner-after-worker-a.json"),
      );
      assert.equal(fact.runner.update_invocation_id, state.InvocationID);
      assert.equal(
        fact.executed_audit.release_context.attempt_uuid,
        attempt.plan.attempt_uuid,
      );
      const time = new Date(Date.now() + 5).toISOString();
      // A synthetic server/canary receipt permits testing cleanup; no native server completion is claimed here.
      const receipt = {
        schema: 1,
        kind: "production_completion",
        environment: "production",
        publication_mode: "by_landing",
        repository_id: BUILD_REPOSITORY_ID,
        attempt_uuid: attempt.plan.attempt_uuid,
        revision: target,
        version: identity.version,
        branch: "develop",
        completed_at: time,
        host_ids: ["worker-a"],
        codex_host_ids: [],
        server: {
          transaction_id: "20261009T000000Z",
          image_id: `sha256:${"a".repeat(64)}`,
          container_id: "synthetic-server",
          health_revision: target,
          health_dirty: false,
          stability_passed: true,
          journal_sha256: "b".repeat(64),
          manifest_sha256: "c".repeat(64),
        },
        runners: [fact.runner],
        canary: {
          passed: true,
          operator: "fixture",
          revision: target,
          completed_at: time,
          evidence_sha256: "d".repeat(64),
        },
      };
      writePrivateRecord(attempt.dir, "completion.json", receipt);
      assert.equal(
        cleanupProductionRunner({
          dir: context.dir,
          host: "worker-a",
          runnerRoot: root,
          configPath,
        }).cleaned,
        true,
      );
      assert.equal(unitSnapshot(unit).LoadState, "not-found");
      assert.equal(
        unitSnapshot(unit.replace(/\.service$/, ".timer")).LoadState,
        "not-found",
      );
      assert.ok(readFileSync(calls, "utf8").includes('"stop"'));
    } finally {
      try {
        run("/usr/bin/systemctl", [
          "--user",
          "stop",
          "--",
          unit,
          unit.replace(/\.service$/, ".timer"),
        ]);
      } catch {}
      try {
        run("/usr/bin/systemctl", [
          "--user",
          "reset-failed",
          "--",
          unit,
          unit.replace(/\.service$/, ".timer"),
        ]);
      } catch {}
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await new Promise((resolve) => health.close(resolve));
      rmSync(base, { recursive: true, force: true });
    }
  },
);
