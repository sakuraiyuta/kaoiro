import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { readReleaseAuthority } from "../../scripts/production-release-authority.mjs";
import { attemptDirectory, readPrivateJson, releaseBytesDigest, readPrivateBytes,
  withReleaseLock, writePrivateRecord } from "../../scripts/production-release-files.mjs";
import { validateReleaseContext, validateReleaseSkip } from "../../scripts/production-release-state.mjs";

const must = (value, message) => { if (!value) throw new Error(`server release gate refused: ${message}`); };

export function auditServerRelease(flags, serverDir, repo) {
  const context = validateReleaseContext(flags.releaseAttempt, flags.releasePlanSha256);
  validateReleaseSkip(flags.skipReleaseReconciliation, flags.skipReason);
  const authority = readReleaseAuthority(serverDir, { role: "server", assertionPath: flags.releaseAuthority });
  if (authority.status === "generic") {
    must(!context && !flags.skipReleaseReconciliation, "unenrolled installation cannot assert release context");
    return { schema: 1, status: "generic", pass: true, role: "server" };
  }
  must(authority.descriptor.transport === "local", "server must use its canonical local authority");
  const args = [authority.descriptor.exporter_path, "audit", authority.descriptor.tool_sha256,
    "--install-root", realpathSync(serverDir), "--role", "server", "--repo", realpathSync(repo),
    "--target-sha", flags.target, "--expected-authority-sha256", authority.sha256];
  for (const [key, value] of [["release-attempt", context?.attempt_uuid], ["release-plan-sha256", context?.plan_sha256],
    ["skip-release-reconciliation", flags.skipReleaseReconciliation], ["skip-reason", flags.skipReason],
    ["dry-run", flags.dryRun ? "true" : undefined]]) if (value) args.push(`--${key}`, value);
  const raw = execFileSync(authority.descriptor.node_path, args, { timeout: 125_000, encoding: "utf8", maxBuffer: 524_288,
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const audit = JSON.parse(raw);
  must(audit.pass === true && audit.status === "enrolled" && audit.authority_sha256 === authority.sha256 &&
    audit.root === realpathSync(serverDir) && JSON.stringify(audit.release_context) === JSON.stringify(context),
  "audit response authority/context differs");
  return audit;
}

export function bindServerReleaseAudit(audit, transactionDir) {
  if (!audit.release_context) return;
  const dir = attemptDirectory(audit.canonical_root, audit.release_context.attempt_uuid);
  return withReleaseLock(dir, "record", () => {
    const raw = readPrivateBytes(join(dir, "attempt.json"));
    must(releaseBytesDigest(raw) === audit.release_context.plan_sha256, "canonical plan changed before transaction binding");
    const plan = JSON.parse(raw);
    must(plan.authority?.server.sha256 === audit.authority_sha256 && plan.authority.server.root === audit.root,
      "server installation differs from frozen plan");
    const path = join(dir, "server-audit.json");
    if (existsSync(path)) {
      const previous = readPrivateJson(path);
      must(previous.transaction_dir === realpathSync(transactionDir) &&
        previous.authority_sha256 === audit.authority_sha256 &&
        JSON.stringify(previous.release_context) === JSON.stringify(audit.release_context),
      "attempt is already bound to another server transaction");
      return previous;
    }
    const record = { schema: 1, attempt_uuid: audit.release_context.attempt_uuid,
      transaction_dir: realpathSync(transactionDir), authority_sha256: audit.authority_sha256, root: audit.root,
      release_context: audit.release_context, pass: true, audit };
    writePrivateRecord(dir, "server-audit.json", record);
    return record;
  });
}

export function assertServerResumeContext(journal, audit) {
  must(JSON.stringify(journal.release_context ?? null) === JSON.stringify(audit.release_context ?? null),
    "resume cannot change or omit its authoritative release attempt");
  if (journal.release_reconciliation?.authority_sha256) {
    must(journal.release_reconciliation.authority_sha256 === audit.authority_sha256,
      "server authority changed since prepare");
  }
}
