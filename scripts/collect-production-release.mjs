#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFrozenBuildIdentity } from "./build-identity.mjs";
import {
  completeReleaseAttempt,
  startReleaseAttempt,
  validateProductionReceipt,
} from "./production-release-record.mjs";
import { readJournal } from "../server/deploy/kaoiro-deploy-journal.mjs";
import { readManifest } from "../server/deploy/kaoiro-deploy-manifest.mjs";
import {
  PHASE,
  validateJournalAgainstStateMachine,
} from "../server/deploy/kaoiro-deploy-phase.mjs";
import { runDocker } from "../server/deploy/kaoiro-deploy-docker.mjs";
import {
  FLEET_RPC,
  FLEET_RPC_TIMEOUT_MS,
  validateFleet,
} from "../server/deploy/kaoiro-build-compatibility.mjs";
import { acceptedForwardTransaction } from "../runner/deploy/kaoiro-runner-codex-state.mjs";
import { attests } from "../runner/deploy/attest-build-info.mjs";
import { readPublishedProductionRelease } from "./production-release-tags.mjs";
import { receiptDigest } from "./production-release-record.mjs";
import {
  unitSnapshot,
  unitCommandSnapshot,
  verifyRetainedUnitCommand,
} from "./production-release-unit.mjs";
import { verifyReleaseToolClosure } from "./production-release-tools.mjs";
import {
  attemptDirectory,
  readPrivateBytes,
  readPrivateJson,
  releaseBytesDigest,
  writePrivateRecord,
} from "./production-release-files.mjs";
import {
  importRunnerReleaseFact,
  installRunnerReleasePlan,
  runnerReleaseFact,
  validateRunnerReleaseContext,
} from "./production-release-runner-facts.mjs";
import { readReleaseAuthority } from "./production-release-authority.mjs";
import {
  validateEnrollmentInventory,
  enrolledHealthUrl,
  validateReleasePlan,
} from "./production-release-plan.mjs";
import {
  RELEASE_UUID,
  parseReleaseOptions,
} from "./production-release-state.mjs";
export { unitSnapshot } from "./production-release-unit.mjs";
const sha256 = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const read = (file) => {
  const raw = readFileSync(file);
  if (raw.length > 524_288) throw new Error("input exceeds bound");
  return JSON.parse(raw);
};
const must = (condition, message) => {
  if (!condition) throw new Error(`release completion pending: ${message}`);
};
const equal = (info, target) =>
  info.revision === target.revision &&
  info.version === target.version &&
  info.branch === target.branch &&
  info.dirty === false;
const wire = (info) => ({
  revision: info.build_revision,
  version: info.build_version,
  branch: info.build_branch,
  dirty: info.build_dirty,
});
const timestamp = (value) => {
  const date = new Date(value);
  must(Number.isFinite(date.getTime()), "unreadable service timestamp");
  return date.toISOString();
};
export function collectRunnerBaseline(
  plan,
  hostId,
  service,
  runnerRoot,
  bin = "systemctl",
  updaterUnit,
  capture,
) {
  must(plan.host_ids.includes(hostId), "host absent from execution card");
  must(
    plan.authority &&
      capture?.context &&
      capture.context.plan.attempt_uuid === plan.attempt_uuid,
    "enrolled runner working plan and executed admission audit required",
  );
  const updater =
    updaterUnit ?? `${service.replace(/\.service$/, "")}-update.service`;
  const state = unitSnapshot(updater, bin);
  must(
    !["active", "activating", "deactivating"].includes(state.ActiveState),
    "previous updater is still running",
  );
  const updaterTool = realpathSync(
    join(runnerRoot, "current/deploy/kaoiro-runner-update.sh"),
  );
  const toolRoot = join(dirname(updaterTool), "release-tools");
  verifyReleaseToolClosure(
    toolRoot,
    capture.context.authority.descriptor.tool_sha256,
    { actualRunnerDeploy: dirname(updaterTool) },
  );
  const source = readlinkRevision(runnerRoot);
  const launcher = join(toolRoot, "scripts/production-release-launcher.mjs");
  return runnerReleaseFact(capture.context, {
    service,
    updater,
    updater_tool: updaterTool,
    source_revision: source,
    target_revision: plan.identity.revision,
    config_host_verified: true,
    launcher,
    launcher_sha256: sha256(launcher),
    updater_sha256: sha256(updaterTool),
    tool_root: toolRoot,
    node_path: process.execPath,
    update_args: capture.updateArgs,
    executed_audit: capture.audit,
    previous_invocation: state.InvocationID,
    created_at: new Date().toISOString(),
    delay_seconds: capture.delaySeconds,
    simulation: bin !== "systemctl",
  });
}
const readlinkRevision = (root) => {
  const path = realpathSync(join(root, "current"));
  const revision = path.split("/").at(-1);
  must(
    /^[0-9a-f]{40}$/.test(revision ?? "") &&
      path === join(realpathSync(root), "releases", revision),
    "physical source release required",
  );
  return revision;
};

export function collectExecutedRunnerAudit(
  plan,
  baseline,
  runnerRoot,
  invocationId,
) {
  const root = join(realpathSync(runnerRoot), "release-audits");
  const names = readdirSync(root);
  must(
    names.length <= 1000 && names.every((name) => RELEASE_UUID.test(name)),
    "bounded private audit inventory required",
  );
  const matches = [];
  for (const name of names) {
    const dir = join(root, name),
      owner = readPrivateJson(join(dir, "release-owner.json"));
    if (owner.systemd_invocation_id !== invocationId) continue;
    const audit = readPrivateJson(join(dir, "release-audit.json")),
      proof = readPrivateJson(join(dir, "release-switch-proof.json"));
    must(
      owner.invocation_uuid === name &&
        owner.mode === "worker" &&
        owner.root === realpathSync(runnerRoot) &&
        owner.source_revision === baseline.source_revision &&
        owner.expected_target === plan.identity.revision &&
        owner.authority_sha256 === baseline.authority_sha256 &&
        owner.tool_sha256 === baseline.tool_sha256 &&
        owner.updater === baseline.updater_tool &&
        owner.updater_sha256 === baseline.updater_sha256 &&
        owner.release_context?.attempt_uuid === plan.attempt_uuid &&
        owner.release_context.plan_sha256 === baseline.plan_sha256 &&
        audit.pass === true &&
        audit.authority_sha256 === owner.authority_sha256 &&
        audit.tool_sha256 === owner.tool_sha256 &&
        JSON.stringify(audit.release_context) ===
          JSON.stringify(owner.release_context) &&
        proof.invocation_uuid === name &&
        proof.target_revision === plan.identity.revision &&
        proof.owner_sha256 === sha256(join(dir, "release-owner.json")) &&
        proof.audit_sha256 === sha256(join(dir, "release-audit.json")),
      "executed worker audit/proof differs from captured baseline",
    );
    matches.push(audit);
  }
  must(matches.length === 1, "one actual executed worker proof required");
  return matches[0];
}
export function collectRunnerCompletion(
  plan,
  baseline,
  { runnerRoot, configPath, codexTransaction, systemctlBin = "systemctl" },
) {
  must(
    baseline.attempt_uuid === plan.attempt_uuid &&
      plan.host_ids.includes(baseline.alias ?? baseline.host_id),
    "baseline attempt binding",
  );
  must(
    !baseline.simulation && systemctlBin === "systemctl",
    "fake service manager cannot complete production",
  );
  const hostId = baseline.alias;
  const expected = plan.authority?.runners.find(
    (owner) => owner.alias === hostId,
  );
  must(
    expected &&
      expected.root === realpathSync(runnerRoot) &&
      expected.sha256 === baseline.authority_sha256 &&
      baseline.config_host_verified === true &&
      baseline.target_revision === plan.identity.revision,
    "baseline lacks the frozen production authority/target binding",
  );
  const updater = unitSnapshot(baseline.updater, systemctlBin);
  const service = unitSnapshot(baseline.service, systemctlBin);
  must(
    updater.InvocationID !== baseline.previous_invocation &&
      /^[0-9a-f]{32}$/.test(updater.InvocationID) &&
      updater.ActiveState === "active" &&
      updater.SubState === "exited" &&
      updater.Result === "success" &&
      updater.ExecMainCode === "1" &&
      updater.ExecMainStatus === "0",
    "actual retained updater invocation did not finish successfully",
  );
  verifyRetainedUnitCommand(
    unitCommandSnapshot(baseline.updater),
    baseline.node_path,
    [
      baseline.node_path,
      baseline.launcher,
      "worker",
      baseline.tool_sha256,
      dirname(baseline.updater_tool),
      ...baseline.update_args,
    ],
  );
  verifyReleaseToolClosure(baseline.tool_root, baseline.tool_sha256, {
    actualRunnerDeploy: dirname(baseline.updater_tool),
  });
  must(
    sha256(baseline.launcher) === baseline.launcher_sha256 &&
      sha256(baseline.updater_tool) === baseline.updater_sha256,
    "captured launcher or updater bytes changed",
  );
  const started = timestamp(updater.ExecMainStartTimestamp),
    finished = timestamp(updater.ExecMainExitTimestamp);
  must(
    Date.parse(started) >= Date.parse(baseline.created_at) &&
      Date.parse(finished) >= Date.parse(started),
    "worker predates this attempt",
  );
  must(
    service.ActiveState === "active" &&
      Number.isSafeInteger(Number(service.MainPID)) &&
      Number(service.MainPID) > 1,
    "runner service is not active",
  );
  const config = read(configPath);
  must(
    plan.runtime_hosts?.find((pair) => pair.alias === hostId)
      ?.runtime_host_id === config.host_id,
    "runner config does not identify the private required host",
  );
  const file = join(resolve(runnerRoot), "current/dist/build-info.json");
  const info = read(file);
  must(
    readlinkRevision(runnerRoot) === plan.identity.revision &&
      attests(info, plan.identity.revision) &&
      equal(info, plan.identity),
    "activated runner artifact differs from pinned target",
  );
  collectExecutedRunnerAudit(plan, baseline, runnerRoot, updater.InvocationID);
  const codex = plan.codex_host_ids.includes(hostId)
    ? acceptedForwardTransaction(
        resolve(runnerRoot),
        codexTransaction,
        plan.identity.revision,
      )
    : null;
  return {
    host_id: hostId,
    revision: info.revision,
    version: info.version,
    branch: info.branch,
    dirty: info.dirty,
    unit: baseline.service,
    update_invocation_id: updater.InvocationID,
    service_active: true,
    worker_exit: 0,
    worker_started_at: started,
    worker_finished_at: finished,
    artifact_sha256: sha256(file),
    codex,
  };
}
export async function collectServerCompletion(
  plan,
  { transactionDir, healthUrl, inventory, dockerBin = "docker" },
) {
  must(dockerBin === "docker", "fake Docker cannot complete production");
  const fixedHealthUrl = enrolledHealthUrl(inventory, healthUrl);
  const manifest = readManifest(transactionDir),
    journal = readJournal(transactionDir);
  validateJournalAgainstStateMachine(journal);
  must(
    journal.phase === PHASE.DONE &&
      manifest.target_sha === plan.identity.revision,
    "server transaction has not completed this target",
  );
  must(
    journal.release_context?.attempt_uuid === plan.attempt_uuid &&
      journal.release_context.plan_sha256 === receiptDigest(plan),
    "server transaction lacks the enrolled attempt binding",
  );
  const up = [...journal.history]
    .reverse()
    .find((entry) => entry.phase === PHASE.UP)?.observation;
  must(up?.container_id, "server DONE lacks its activated container");
  const args = ["inspect", up.container_id, "--format", "{{json .}}"];
  const observed = JSON.parse(
    runDocker(dockerBin, args, { timeout: 5_000, maxBuffer: 524_288 }),
  );
  must(
    observed.Image === manifest.image_id &&
      observed.State?.Status === "running",
    "live server differs from completed transaction",
  );
  const url = new URL(fixedHealthUrl);
  must(["http:", "https:"].includes(url.protocol), "health URL");
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  must(response.ok, "target health unavailable");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    must(size <= 65_536, "health bound");
    chunks.push(chunk);
  }
  const health = JSON.parse(Buffer.concat(chunks));
  must(
    equal(wire(health), plan.identity),
    "final health differs from full target identity",
  );
  const raw = runDocker(
    dockerBin,
    ["exec", up.container_id, "/app/bin/kaoiro_server", "rpc", FLEET_RPC],
    {
      timeout: FLEET_RPC_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 524_288,
    },
  );
  const fleet = validateFleet(JSON.parse(raw), [
    "legacy-calver",
    "landing-calver-v1",
  ]);
  for (const hostId of plan.host_ids) {
    const runtimeId = plan.runtime_hosts?.find(
      (pair) => pair.alias === hostId,
    )?.runtime_host_id;
    must(
      runtimeId &&
        fleet.hosts.some(
          (info) => info.id === runtimeId && equal(wire(info), plan.identity),
        ),
      `required runner alias ${hostId} has not registered the target`,
    );
  }
  return {
    transaction_id: journal.transaction_id,
    image_id: manifest.image_id,
    container_id: up.container_id,
    health_revision: health.build_revision,
    health_dirty: health.build_dirty,
    stability_passed: true,
    journal_sha256: sha256(join(transactionDir, "journal.json")),
    manifest_sha256: sha256(join(transactionDir, "manifest.json")),
  };
}

export function acknowledgeReleaseAttempt(dir, { cwd, remote = "origin" }) {
  const plan = readPrivateJson(join(dir, "attempt.json")),
    receipt = readPrivateJson(join(dir, "completion.json"));
  must(
    receipt.attempt_uuid === plan.attempt_uuid &&
      equal({ ...receipt, dirty: false }, plan.identity),
    "acknowledgment attempt binding",
  );
  const pair = readPublishedProductionRelease({
    cwd,
    receipt,
    remote,
    repositoryId: receipt.repository_id,
    allowedHosts: plan.host_ids,
  });
  const result = {
    schema: 1,
    attempt_uuid: receipt.attempt_uuid,
    revision: receipt.revision,
    version: receipt.version,
    branch: receipt.branch,
    publication_mode: receipt.publication_mode,
    tag: pair.tag,
    claim: pair.claim,
    object: pair.object,
    receipt_sha256: receiptDigest(receipt),
    first_attempt_uuid: pair.record.first_attempt_uuid,
    reused: pair.record.first_attempt_uuid !== receipt.attempt_uuid,
  };
  const file = join(dir, "tag-ack.json");
  try {
    const previous = read(file);
    must(
      JSON.stringify(previous) === JSON.stringify(result),
      "tag acknowledgment changed",
    );
    return previous;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  writePrivateRecord(dir, "tag-ack.json", result);
  return result;
}

export function enrolledCollectionContext(serverRoot, dir) {
  const authority = readReleaseAuthority(serverRoot, { role: "server" });
  must(
    authority.status === "enrolled" &&
      authority.descriptor.transport === "local",
    "canonical recording-server enrollment required",
  );
  const root = realpathSync(authority.descriptor.root);
  const inventory = validateEnrollmentInventory(
    readPrivateJson(`${root}-inventory.json`, { privateParent: false }),
  );
  must(
    inventory.authority.server.root === authority.root &&
      inventory.authority.server.sha256 === authority.sha256,
    "fixed enrollment inventory differs from current server authority",
  );
  if (dir)
    must(
      resolve(dir) === attemptDirectory(root, basename(dir)),
      "canonical attempt path required",
    );
  return { authority, root, inventory };
}

export async function runCollectionCli(argv) {
  const [command, ...args] = argv;
  const flags = parseReleaseOptions(args, [
    "root",
    "server-dir",
    "identity",
    "hosts",
    "codex-hosts",
    "attempt",
    "repo",
    "runner-root",
    "host",
    "config",
    "plan",
    "codex-transaction",
    "server-transaction",
    "health-url",
    "canary",
  ]);
  if (command === "install-plan") {
    const context = installRunnerReleasePlan({
      root: flags["runner-root"],
      raw: readPrivateBytes(flags.plan, { privateParent: false }),
      alias: flags.host,
      configPath: flags.config,
    });
    return {
      installed: true,
      dir: context.dir,
      attempt_uuid: context.plan.attempt_uuid,
      plan_sha256: context.plan_sha256,
    };
  }
  if (command === "runner-after") {
    const context = validateRunnerReleaseContext({
      root: flags["runner-root"],
      dir: flags.attempt,
      alias: flags.host,
      configPath: flags.config,
    });
    const baseline = readPrivateJson(
      join(context.dir, `runner-baseline-${context.alias}.json`),
    );
    const runner = collectRunnerCompletion(context.plan, baseline, {
      runnerRoot: context.root,
      configPath: flags.config,
      codexTransaction: flags["codex-transaction"],
    });
    const executedAudit = collectExecutedRunnerAudit(
      context.plan,
      baseline,
      context.root,
      runner.update_invocation_id,
    );
    const fact = runnerReleaseFact(context, {
      runner,
      executed_audit: executedAudit,
      config_host_verified: true,
    });
    const imported = importRunnerReleaseFact(context, "after", fact);
    writePrivateRecord(
      context.dir,
      `runner-after-${context.alias}.json`,
      fact,
      { kind: "runner-fact" },
    );
    return {
      imported: true,
      attempt_uuid: context.plan.attempt_uuid,
      alias: context.alias,
      sha256: imported.sha256,
    };
  }
  const enrolled = enrolledCollectionContext(
    flags["server-dir"],
    flags.attempt,
  );
  must(
    !flags.root || realpathSync(flags.root) === enrolled.root,
    "--root cannot substitute canonical history",
  );
  if (command === "start") {
    const hosts = enrolled.inventory.runtime_hosts
      .map((pair) => pair.alias)
      .sort();
    must(
      !flags.hosts ||
        JSON.stringify([...JSON.parse(flags.hosts)].sort()) ===
          JSON.stringify(hosts),
      "start cannot narrow the fixed inventory",
    );
    return startReleaseAttempt(
      enrolled.root,
      readFrozenBuildIdentity(flags.identity),
      hosts,
      flags["codex-hosts"] === undefined
        ? hosts
        : JSON.parse(flags["codex-hosts"]),
      enrolled.inventory,
    );
  }
  const plan = validateReleasePlan(
    readPrivateJson(join(flags.attempt, "attempt.json")),
    flags.attempt.split("/").at(-1),
  );
  must(
    plan.authority?.server.sha256 === enrolled.authority.sha256 &&
      plan.authority.server.root === enrolled.authority.root,
    "attempt server authority differs from current enrollment",
  );
  if (command === "ack")
    return acknowledgeReleaseAttempt(flags.attempt, { cwd: flags.repo });
  if (command === "complete") {
    const audit = readPrivateJson(join(flags.attempt, "server-audit.json"));
    must(
      !flags["server-transaction"] ||
        realpathSync(flags["server-transaction"]) ===
          realpathSync(audit.transaction_dir),
      "completion cannot select another server transaction",
    );
    const server = await collectServerCompletion(plan, {
      transactionDir: audit.transaction_dir,
      healthUrl: flags["health-url"],
      inventory: enrolled.inventory,
    });
    const runners = plan.host_ids.map(
      (alias) =>
        readPrivateJson(join(flags.attempt, `runner-after-${alias}.json`))
          .runner,
    );
    const canary = readPrivateJson(flags.canary, { privateParent: false });
    const receipt = {
      schema: 1,
      kind: "production_completion",
      environment: "production",
      publication_mode: "by_landing",
      repository_id: plan.identity.landing.repository_id,
      attempt_uuid: plan.attempt_uuid,
      revision: plan.identity.revision,
      version: plan.identity.version,
      branch: plan.identity.branch,
      completed_at: new Date().toISOString(),
      host_ids: plan.host_ids,
      codex_host_ids: plan.codex_host_ids,
      server,
      runners,
      canary,
    };
    validateProductionReceipt(receipt, { allowedHosts: plan.host_ids });
    writePrivateRecord(flags.attempt, "canary.json", canary);
    return completeReleaseAttempt(flags.attempt, receipt, {
      allowedHosts: plan.host_ids,
    });
  }
  throw new Error("unknown completion command");
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(JSON.stringify(await runCollectionCli(process.argv.slice(2))));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 78;
  }
}
