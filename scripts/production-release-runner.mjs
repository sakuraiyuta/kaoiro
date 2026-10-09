import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readlinkSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { readReleaseAuthority } from "./production-release-authority.mjs";
import { reconcileProductionReleases } from "./production-release-reconciliation.mjs";
import { createPrivateDirectory, namedProcessIdentity, readPrivateBytes, readPrivateJson, releaseBytesDigest,
  writePrivateRecord } from "./production-release-files.mjs";
import { validateRuntimeHosts } from "./production-release-plan.mjs";
import { parseReleaseOptions, RELEASE_SHA, RELEASE_UUID } from "./production-release-state.mjs";
import { verifyReleaseToolClosure } from "./production-release-tools.mjs";
import { recordExecutedRunnerRelease, validateNativeRunnerInvocation, validateRunnerReleaseContext } from "./production-release-runner-facts.mjs";
import { validatedRecoverySwitch, validateRestoreAdmission } from "../runner/deploy/kaoiro-runner-codex-state.mjs";

const must = (value, message) => { if (!value) throw new Error(`runner release gate refused: ${message}`); };
const LOCK_FILES = ["release-owner.json", "release-audit.json", "release-switch-proof.json"];
const boot = () => readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const uptime = () => Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
const currentRevision = root => {
  const link = readlinkSync(join(root, "current"));
  must(/^releases\/[0-9a-f]{40}$/.test(link) && realpathSync(join(root, "current")) === join(root, link), "clean physical source release required");
  return link.slice(9);
};
const lockPath = root => join(realpathSync(root), ".lock.update");
const lockRead = (root, name) => readPrivateJson(join(lockPath(root), name));
const lockWrite = (root, name, value) => writePrivateRecord(lockPath(root), name, value,
  { scope: "update-lock", kind: "owner" });

export function resolveRunnerReleaseAlias(root, configPath) {
  const pairs = validateRuntimeHosts(readPrivateJson(join(realpathSync(root), "release-host-aliases.json"), { privateParent: false }));
  const config = readPrivateJson(configPath, { legacyMode: true, privateParent: false });
  const pair = pairs.find(pair => pair.runtime_host_id === config.host_id);
  must(pair, "live runner config is absent from the fixed private alias map");
  return pair.alias;
}

function assertShellCaller(pid) {
  must(Number.isSafeInteger(pid) && pid > 1, "positive invoking shell PID required");
  const gateway = namedProcessIdentity(process.ppid);
  must(gateway.ppid === pid, "caller is not the fixed gateway's direct invoking shell");
  return namedProcessIdentity(pid);
}

export async function auditRunnerRelease(options, { toolRoot, toolDigest, updater } = {}) {
  const root = realpathSync(options.installRoot);
  const authority = readReleaseAuthority(root, { assertionPath: options.assertionPath, expectedDigest: options.expectedAuthorityDigest });
  if (authority.status === "enrolled") {
    must(toolDigest === authority.descriptor.tool_sha256, "executing closure differs from the enrolled authority");
    verifyReleaseToolClosure(toolRoot, toolDigest, { actualRunnerDeploy: dirname(updater) });
  }
  const alias = authority.status === "enrolled" ? resolveRunnerReleaseAlias(root, options.configPath) : undefined;
  must(!options.alias || alias === options.alias, "requested alias differs from the live registered host");
  const audit = await reconcileProductionReleases({ ...options, installRoot: root, alias });
  let context;
  if (audit.release_context) {
    context = validateRunnerReleaseContext({ root, dir: join(root, "production-attempts", audit.release_context.attempt_uuid),
      alias, configPath: options.configPath });
    must(context.plan_sha256 === audit.release_context.plan_sha256, "working copy differs from the canonical own attempt");
  }
  if (audit.status === "generic" || !options.ownerPid) return audit;
  const owner = assertShellCaller(options.ownerPid);
  must(["worker", "manual"].includes(options.mode), "lock-owner mode required");
  verifyReleaseToolClosure(toolRoot, toolDigest, { actualRunnerDeploy: dirname(updater) });
  const descriptor = { schema: 1, invocation_uuid: randomUUID(), ...owner, mode: options.mode,
    root, source_revision: currentRevision(root), expected_target: options.targetRevision ?? null,
    updater: realpathSync(updater), updater_sha256: releaseBytesDigest(readFileSync(updater)),
    authority_sha256: authority.sha256, tool_root: realpathSync(toolRoot), tool_sha256: toolDigest,
    release_context: audit.release_context, alias, systemd_invocation_id: null,
    boot_id: boot(), created_at: new Date().toISOString() };
  if (context && process.env.KAOIRO_RELEASE_RETAINED_UNIT) {
    descriptor.systemd_invocation_id = validateNativeRunnerInvocation(context, descriptor, process.env.KAOIRO_RELEASE_RETAINED_UNIT);
  }
  lockWrite(root, "release-owner.json", descriptor);
  lockWrite(root, "release-audit.json", audit);
  if (context && descriptor.systemd_invocation_id) recordExecutedRunnerRelease(context, descriptor, audit);
  return { ...audit, invocation_uuid: descriptor.invocation_uuid };
}

export function sealRunnerSwitch(root, target, ownerPid) {
  must(RELEASE_SHA.test(target ?? ""), "full target revision required before sealing");
  const owner = lockRead(root, "release-owner.json");
  const currentOwner = assertShellCaller(ownerPid);
  must(owner.pid === currentOwner.pid && owner.start_ticks === currentOwner.start_ticks && owner.boot_id === boot() &&
    owner.root === realpathSync(root) && owner.source_revision === currentRevision(root) &&
    (!owner.expected_target || owner.expected_target === target), "current lock owner/source/target differs");
  const audit = lockRead(root, "release-audit.json");
  must(audit.pass === true && audit.authority_sha256 === owner.authority_sha256 &&
    JSON.stringify(audit.release_context) === JSON.stringify(owner.release_context), "executed audit differs from lock context");
  const proof = { schema: 1, invocation_uuid: owner.invocation_uuid,
    owner_sha256: releaseBytesDigest(readPrivateBytes(join(lockPath(root), "release-owner.json"))),
    audit_sha256: releaseBytesDigest(readPrivateBytes(join(lockPath(root), "release-audit.json"))),
    root: owner.root, source_revision: owner.source_revision, target_revision: target,
    authority_sha256: owner.authority_sha256, tool_sha256: owner.tool_sha256,
    release_context: owner.release_context, boot_id: owner.boot_id, sealed_monotonic_seconds: uptime() };
  lockWrite(root, "release-switch-proof.json", proof);
  return { invocation_uuid: proof.invocation_uuid,
    proof_sha256: releaseBytesDigest(readPrivateBytes(join(lockPath(root), "release-switch-proof.json"))) };
}

export function verifyRunnerSwitch({ root, target, invocationUuid, proofDigest, callerPid,
  readProcess = namedProcessIdentity, currentBoot = boot, monotonic = uptime } = {}) {
  root = realpathSync(root);
  must(RELEASE_UUID.test(invocationUuid ?? "") && RELEASE_SHA.test(target ?? ""), "local proof assertion required");
  const proofRaw = readPrivateBytes(join(lockPath(root), "release-switch-proof.json"));
  must(releaseBytesDigest(proofRaw) === proofDigest, "local proof bytes changed");
  const proof = JSON.parse(proofRaw);
  const ownerRaw = readPrivateBytes(join(lockPath(root), "release-owner.json"));
  const owner = JSON.parse(ownerRaw);
  const auditRaw = readPrivateBytes(join(lockPath(root), "release-audit.json"));
  const audit = JSON.parse(auditRaw);
  const live = readProcess(owner.pid);
  const caller = readProcess(callerPid);
  must(owner.invocation_uuid === invocationUuid && proof.invocation_uuid === invocationUuid &&
    owner.pid === live.pid && owner.start_ticks === live.start_ticks &&
    (owner.mode === "manual" ? caller.pid === owner.pid : owner.mode === "worker" && caller.ppid === owner.pid),
  "foreign invocation or switch is not the current owner's direct child");
  const age = monotonic() - proof.sealed_monotonic_seconds;
  must(proof.schema === 1 && owner.schema === 1 && owner.boot_id === currentBoot() && proof.boot_id === owner.boot_id &&
    Number.isFinite(age) && age >= 0 && age <= 900, "proof is stale, future-dated or from another boot");
  must(proof.owner_sha256 === releaseBytesDigest(ownerRaw) && proof.audit_sha256 === releaseBytesDigest(auditRaw) &&
    proof.root === root && owner.root === root && proof.target_revision === target &&
    proof.source_revision === owner.source_revision && currentRevision(root) === owner.source_revision &&
    (!owner.expected_target || target === owner.expected_target) && audit.pass === true &&
    proof.authority_sha256 === owner.authority_sha256 && audit.authority_sha256 === owner.authority_sha256 &&
    proof.tool_sha256 === owner.tool_sha256 && JSON.stringify(proof.release_context) === JSON.stringify(owner.release_context) &&
    JSON.stringify(audit.release_context) === JSON.stringify(owner.release_context), "root/target/source/context/audit proof differs");
  readReleaseAuthority(root, { expectedDigest: owner.authority_sha256 });
  verifyReleaseToolClosure(owner.tool_root, owner.tool_sha256, { actualRunnerDeploy: dirname(owner.updater) });
  must(releaseBytesDigest(readFileSync(owner.updater)) === owner.updater_sha256, "executing updater changed");
  return { pass: true, invocation_uuid: invocationUuid, release_context: owner.release_context };
}

export function cleanupRunnerRelease(root, ownerPid) {
  if (!existsSync(join(lockPath(root), "release-owner.json"))) return;
  const owner = lockRead(root, "release-owner.json");
  const live = assertShellCaller(ownerPid);
  must(owner.pid === live.pid && owner.start_ticks === live.start_ticks, "cleanup cannot release another lock owner");
  const evidenceRoot = createPrivateDirectory(join(realpathSync(root), "release-audits"));
  const evidence = createPrivateDirectory(join(evidenceRoot, owner.invocation_uuid));
  for (const name of LOCK_FILES) {
    const path = join(lockPath(root), name);
    if (!existsSync(path)) continue;
    writePrivateRecord(evidence, name, readPrivateBytes(path), { scope: "update-lock", kind: "owner" });
    unlinkSync(path);
  }
}

export async function runRunnerReleaseGate(operation, args, { toolRoot, toolDigest, actualDeploy } = {}) {
  const flags = parseReleaseOptions(args, ["install-root", "repo", "target-sha", "alias", "config", "owner-pid", "mode",
    "updater", "release-authority", "expected-authority-sha256", "release-attempt", "release-plan-sha256",
    "skip-release-reconciliation", "skip-reason", "invocation-uuid", "proof-sha256", "snapshot", "home", "service", "codex-transaction", "dry-run"]);
  const root = flags["install-root"];
  const ownerPid = Number(flags["owner-pid"]);
  if (operation === "runner-restore-admission") return validateRestoreAdmission(realpathSync(root), flags.snapshot, flags.home, flags.service);
  if (operation === "runner-recovery-switch") {
    must(await validatedRecoverySwitch(realpathSync(root), flags["target-sha"], flags["codex-transaction"]),
      "forward state transaction requires the current release switch proof");
    return { recovery: true, pass: true };
  }
  if (operation === "runner-audit") return auditRunnerRelease({ installRoot: root, repository: flags.repo,
    targetRevision: flags["target-sha"], alias: flags.alias, configPath: flags.config,
    ownerPid: flags["owner-pid"] ? ownerPid : undefined, mode: flags.mode, assertionPath: flags["release-authority"],
    expectedAuthorityDigest: flags["expected-authority-sha256"], attemptUuid: flags["release-attempt"],
    planDigest: flags["release-plan-sha256"], skipCsv: flags["skip-release-reconciliation"], skipReason: flags["skip-reason"],
    dryRun: flags["dry-run"] === "true" },
  { toolRoot, toolDigest, updater: flags.updater ?? join(actualDeploy, "kaoiro-runner-update.sh") });
  if (operation === "runner-seal") return sealRunnerSwitch(root, flags["target-sha"], ownerPid);
  if (operation === "runner-switch") {
    assertShellCaller(ownerPid);
    return verifyRunnerSwitch({ root, target: flags["target-sha"], invocationUuid: flags["invocation-uuid"],
      proofDigest: flags["proof-sha256"], callerPid: ownerPid });
  }
  if (operation === "runner-cleanup") return cleanupRunnerRelease(root, ownerPid) ?? { cleaned: true };
  throw new Error("unknown fixed runner release operation");
}
