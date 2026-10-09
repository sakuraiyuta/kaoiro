#!/usr/bin/env node
// Version and branch resolution lives here; artifact consumers read one frozen input.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Runs a git subcommand from `cwd`; returns trimmed stdout, or `null` if
 *  git is unavailable, `cwd` is not a checkout, or the command otherwise
 *  fails. Never throws. */
function gitOutput(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

/** Computes `{ revision, dirty, degraded, degradeReason }` from git state at
 *  `cwd` (default: repo root).
 *
 * dirty definition (issue #218, decided round 1): `git status --porcelain`
 * sees BOTH tracked and untracked changes, unlike `git diff --quiet` (misses
 * untracked entirely) — issue #217's own build slipped past the
 * tracked-only check via an untracked file, the concrete incident that
 * settled this.
 *
 * degrade rule (issue #218 round 2, ふじ MF-2 ruling): if `git status
 * --porcelain` cannot be read AFTER a successful `rev-parse HEAD`, the
 * WHOLE identity degrades to `{ revision: "unknown", dirty: false }` —
 * NOT just `dirty: false` with the real revision kept. A revision without a
 * trustworthy dirty read is not usable as a deploy postcondition. Explicitly
 * rejected: tri-stating dirty (unknown/true/false) instead, which would add
 * absent / unknown / dirty-unknown / dirty / clean-mismatch / clean-match
 * states and complicate issue #220's future enforcement design for no
 * benefit here — see docs/adr/0053-build-identity.md.
 */
export const BUILD_REPOSITORY_ID = 1343265983;
export const BUILD_IDENTITY_FORMATS = ["legacy-calver", "landing-calver-v1"];

export function isValidBuildBranch(value) {
  if (typeof value !== "string" || Buffer.byteLength(value) === 0 || Buffer.byteLength(value) > 256 ||
      value === "@" || value.startsWith("-") || value.endsWith(".") ||
      /[\x00-\x20\x7f~^:?*\[\\]/.test(value) || value.includes("..") || value.includes("@{")) return false;
  return value.split("/").every(part => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

export function parseLandingVersion(value) {
  if (typeof value !== "string") return null;
  const match = /^(2[0-9]{3}|[3-9][0-9]{3})\.(0[1-9]|1[0-2])\.(0[1-9]|[12][0-9]|3[01])\.([1-9][0-9]{0,5})$/.exec(value);
  if (!match || match[0] !== value) return null;
  const day = `${match[1]}-${match[2]}-${match[3]}`;
  const date = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) return null;
  return { day, number: Number(match[4]) };
}

export function formatLandingVersion(day, number) {
  const version = `${day.replaceAll("-", ".")}.${number}`;
  if (!Number.isSafeInteger(number) || !parseLandingVersion(version)) throw new Error("invalid landing day or sequence");
  return version;
}

export function validateLandingRecord(record, repositoryId = BUILD_REPOSITORY_ID) {
  if (!record || record.schema !== 1 || record.kind !== "landing" || record.repository_id !== repositoryId ||
      !Number.isSafeInteger(repositoryId) || repositoryId < 1 ||
      typeof record.revision !== "string" || record.revision.length !== 40 || !/^[0-9a-f]{40}$/.test(record.revision) ||
      record.branch !== "develop" || !parseLandingVersion(record.version) ||
      !Number.isSafeInteger(record.original_run_id) || record.original_run_id < 1 ||
      typeof record.created_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.000)?Z$/.test(record.created_at) ||
      !Number.isFinite(Date.parse(record.created_at))) throw new Error("malformed landing annotation");
  const normalized = new Date(record.created_at).toISOString();
  if (normalized !== record.created_at.replace(/Z$/, record.created_at.includes(".") ? "Z" : ".000Z") ||
      normalized.slice(0, 10) !== parseLandingVersion(record.version).day) throw new Error("landing clock and version disagree");
  return record;
}

export function readLandingTag(cwd, tag, repositoryId = BUILD_REPOSITORY_ID) {
  const object = gitOutput(["rev-parse", "--verify", `refs/tags/${tag}`], cwd);
  if (!object || gitOutput(["cat-file", "-t", object], cwd) !== "tag") throw new Error("landing tag must be annotated");
  const raw = gitOutput(["cat-file", "-p", object], cwd);
  const separator = raw?.indexOf("\n\n") ?? -1;
  if (separator < 0 || Buffer.byteLength(raw) > 4_096) throw new Error("invalid landing tag object");
  const header = raw.slice(0, separator).split("\n");
  const record = validateLandingRecord(JSON.parse(raw.slice(separator + 2)), repositoryId);
  const publicName = `v${record.version}`;
  if (header[0] !== `object ${record.revision}` || header[1] !== "type commit" ||
      header[2] !== `tag ${publicName}` ||
      gitOutput(["rev-parse", "--verify", `refs/tags/${publicName}`], cwd) !== object ||
      gitOutput(["rev-parse", "--verify", `refs/tags/identity/landing/${record.revision}`], cwd) !== object) {
    throw new Error("landing public tag, claim and annotation disagree");
  }
  return { record, object, tag: publicName };
}

export function computeBuildIdentity(cwd = repoRoot, options = {}) {
  const unknown = reason => ({ revision: "unknown", dirty: false, version: "unknown", branch: "unknown",
    channel: "dev", degraded: true, degradeReason: reason });
  const revision = gitOutput(["rev-parse", "HEAD"], cwd);
  if (!revision || revision.length !== 40 || !/^[0-9a-f]{40}$/.test(revision)) return unknown("git rev-parse HEAD failed (no git, or not a checkout)");
  const status = gitOutput(["status", "--porcelain"], cwd);
  if (status === null) return unknown("git status --porcelain failed after a successful rev-parse HEAD");
  let branch = gitOutput(["symbolic-ref", "--short", "-q", "HEAD"], cwd);
  if (!branch && options.buildRef && isValidBuildBranch(options.buildRef) &&
      gitOutput(["rev-parse", "--verify", `${options.buildRef}^{commit}`], cwd) === revision) branch = options.buildRef;
  branch = isValidBuildBranch(branch) ? branch : "unknown";
  const identity = { revision, dirty: status.length > 0, version: "untagged", branch,
    channel: "dev", degraded: false, degradeReason: null };
  if (identity.dirty) return identity;
  if (gitOutput(["rev-parse", "--is-shallow-repository"], cwd) !== "false") {
    return { ...identity, degraded: true, degradeReason: "tag inventory is incomplete in a shallow checkout" };
  }
  const rawTags = gitOutput(["tag", "--points-at", revision], cwd);
  if (rawTags === null) return { ...identity, degraded: true, degradeReason: "cannot read exact tag inventory" };
  const tags = rawTags.split("\n").filter(tag => /^v\d{4}\.\d{2}\.\d{2}\./.test(tag));
  const claim = gitOutput(["rev-parse", "--verify", `refs/tags/identity/landing/${revision}`], cwd);
  if (tags.length === 0 && !claim) return identity;
  try {
    if (tags.length !== 1) throw new Error("landing has zero or multiple canonical public tags");
    const landing = readLandingTag(cwd, tags[0], options.repositoryId ?? BUILD_REPOSITORY_ID);
    if (landing.record.revision !== revision) throw new Error("landing tag does not name this source revision");
    return { ...identity, version: landing.record.version, branch: landing.record.branch, landing: landing.record };
  } catch (error) {
    return { ...identity, degraded: true, degradeReason: error.message };
  }
}

export function requireTaggedIdentity(cwd = repoRoot, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  let identity;
  do {
    execFileSync("git", ["fetch", "--tags", "origin"], { cwd, stdio: "pipe", timeout: Math.max(1, deadline - Date.now()) });
    const remote = gitOutput(["ls-remote", "--tags", "--refs", "origin"], cwd);
    const local = gitOutput(["for-each-ref", "--format=%(objectname)\t%(refname)", "refs/tags"], cwd);
    if (remote === null || local === null) throw new Error("cannot prove complete remote tag inventory");
    const rows = value => value.split("\n").filter(Boolean).sort();
    const localRows = new Set(rows(local));
    if (rows(remote).some(row => !localRows.has(row))) throw new Error("local tag inventory is incomplete or differs from origin");
    identity = computeBuildIdentity(cwd, options);
    if (options.target && identity.revision !== options.target) throw new Error("source revision differs from pinned target");
    if (identity.dirty || identity.degraded) throw new Error(`production identity refused: ${identity.degradeReason ?? "dirty source"}`);
    if (parseLandingVersion(identity.version) && identity.landing) return identity;
    if (Date.now() >= deadline) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(250, deadline - Date.now()));
  } while (Date.now() < deadline);
  throw new Error("production requires a completed exact landing tag/claim before building");
}

export function artifactBuildIdentity(identity, builtAt = new Date().toISOString()) {
  return { revision: identity.revision, dirty: identity.dirty, version: identity.version,
    branch: identity.branch, channel: identity.channel, built_at: builtAt,
    build_identity_formats: [...BUILD_IDENTITY_FORMATS],
    ...(identity.landing ? { landing: identity.landing } : {}) };
}

export function validateFrozenBuildIdentity(identity) {
  if (!isValidBuildInfoShape(identity) || !isValidBuildBranch(identity.branch) ||
      !isValidVersion(identity.version) || !["dev", "release"].includes(identity.channel) ||
      (identity.channel === "release" && (identity.dirty || identity.revision === "unknown" ||
        ["unknown", "untagged"].includes(identity.version)))) throw new Error("invalid frozen identity");
  if (parseLandingVersion(identity.version)) {
    const record = validateLandingRecord(identity.landing);
    if (identity.dirty || record.revision !== identity.revision || record.version !== identity.version ||
        record.branch !== identity.branch) throw new Error("frozen landing identity disagrees with its record");
  } else if (!["untagged", "unknown"].includes(identity.version)) throw new Error("new frozen builds cannot invent a legacy version");
  if (!Array.isArray(identity.build_identity_formats) ||
      JSON.stringify(identity.build_identity_formats) !== JSON.stringify(BUILD_IDENTITY_FORMATS)) {
    throw new Error("frozen identity has unsupported reader capabilities");
  }
  return identity;
}

export function readFrozenBuildIdentity(file, expectedDigest) {
  const raw = readFileSync(file);
  if (raw.length > 65_536 || (expectedDigest && createHash("sha256").update(raw).digest("hex") !== expectedDigest)) {
    throw new Error("frozen identity size or digest mismatch");
  }
  return validateFrozenBuildIdentity(JSON.parse(raw.toString("utf8")));
}

function isValidVersion(value) {
  if (["unknown", "untagged"].includes(value) || parseLandingVersion(value)) return true;
  const match = typeof value === "string" && /^(?:2[0-9]{3}|[3-9][0-9]{3})\.(?:[1-9]|1[0-2])\.[0-9]{1,6}$/.exec(value);
  return Boolean(match && match[0] === value);
}

export function explicitBuildIdentity(env) {
  const keys = ["REVISION", "DIRTY", "VERSION", "CHANNEL", "BRANCH"];
  const values = keys.map(key => env[`KAOIRO_BUILD_${key}`]);
  if (values.every(value => value === undefined)) return null;
  const [revision, dirty, version, channel, branch] = values;
  if (!(revision === "unknown" || (typeof revision === "string" && revision.length === 40 && /^[0-9a-f]{40}$/.test(revision))) ||
      !["true", "false"].includes(dirty) || !isValidVersion(version) || !["dev", "release"].includes(channel) ||
      !isValidBuildBranch(branch) || (parseLandingVersion(version) && (dirty !== "false" || revision === "unknown")) ||
      (channel === "release" && (dirty !== "false" || revision === "unknown" || ["untagged", "unknown"].includes(version)))) {
    throw new Error("explicit build identity must contain five valid, consistent fields");
  }
  return { revision, dirty: dirty === "true", version, channel, branch, built_at: "unknown",
    build_identity_formats: [...BUILD_IDENTITY_FORMATS] };
}

export function consumeBuildIdentity(cwd = repoRoot, env = process.env) {
  if (env.KAOIRO_BUILD_IDENTITY_FILE) {
    return readFrozenBuildIdentity(env.KAOIRO_BUILD_IDENTITY_FILE, env.KAOIRO_BUILD_IDENTITY_SHA256);
  }
  if (env.KAOIRO_BUILD_IDENTITY_JSON) {
    if (Buffer.byteLength(env.KAOIRO_BUILD_IDENTITY_JSON) > 65_536) throw new Error("identity JSON exceeds its bound");
    return validateFrozenBuildIdentity(JSON.parse(env.KAOIRO_BUILD_IDENTITY_JSON));
  }
  return explicitBuildIdentity(env) ?? artifactBuildIdentity(computeBuildIdentity(cwd));
}

export function assertSourceIdentity(cwd, identity) {
  if (gitOutput(["rev-parse", "HEAD"], cwd) !== identity.revision ||
      gitOutput(["status", "--porcelain"], cwd) === null ||
      (gitOutput(["status", "--porcelain"], cwd).length > 0) !== identity.dirty) {
    throw new Error("source revision or dirty state changed during the coordinated build");
  }
}

/** The single canonical `<revision>[-dirty]` string form. Formula-identical
 *  to runner/src/build_info.ts's formatBuildRevision — see that function's
 *  doc for why it cannot import this module directly; the two are pinned
 *  equal by tests on both sides instead. */
export function formatIdentityString({ revision, dirty }) {
  return dirty ? `${revision}-dirty` : revision;
}

/** Value domain for `built_at` — identical logic to runner/src/build_info.ts's
 *  `isValidBuiltAt` (issue #218 round 4, ふじ 差し戻し), kept as an
 *  independently-authored duplicate for the same cross-package reason as
 *  `REVISION_RE` below. A shape-only regex matches syntactically
 *  ISO-looking but calendrically impossible strings like
 *  "2026-99-99T99:99:99.999Z" — round-tripping through `Date` (parse,
 *  finiteness check, re-serialize, compare) is what actually pins "this
 *  is the exact string `toISOString()` would produce". */
function isValidBuiltAt(value) {
  if (value === "unknown") return true;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

/** Value domain for a FULL build-info.json-shaped object (revision, dirty,
 *  AND built_at — issue #218 round 4, ふじ 差し戻し: round 3 validated
 *  only revision/dirty, so a file with a valid revision/dirty but a
 *  malformed built_at still passed through here while runner's own
 *  loadBuildInfo() degraded the SAME file to unknown — the two readers
 *  disagreed again, just on a different field than round 3's bug).
 *  `revision` must be the literal "unknown" or a lowercase 40-hex-digit
 *  SHA, `dirty` must be an actual JS boolean — NOT merely truthy. Mirrors
 *  runner/src/build_info.ts's `isBuildInfoShape`. Exported for direct
 *  unit testing. */
const REVISION_RE = /^[0-9a-f]{40}$/;
export function isValidBuildInfoShape(value) {
  if (typeof value !== "object" || value === null) return false;
  return (
    typeof value.revision === "string" &&
    (value.revision === "unknown" || (value.revision.length === 40 && REVISION_RE.test(value.revision))) &&
    typeof value.dirty === "boolean" &&
    typeof value.built_at === "string" &&
    isValidBuiltAt(value.built_at)
  );
}

/** Reads and validates a build-info.json-shaped file, degrading to
 *  `{ revision: "unknown", dirty: false }` (with a reason logged to
 *  stderr) on ANY failure — missing file, unparsable JSON, or a malformed
 *  shape (issue #218 round 4, ふじ 差し戻し). Structurally mirrors
 *  runner/src/build_info.ts's `loadBuildInfo` (same three try/catch
 *  stages, same degrade target) rather than letting a read or parse
 *  failure propagate as an uncaught exception — round 3 only handled the
 *  shape-mismatch case; a missing file or corrupt JSON crashed this CLI
 *  with a raw stack trace while the SAME file handed to loadBuildInfo()
 *  degrades cleanly, another two-readers-disagree gap.
 *
 *  Partial trust is deliberately not offered here (e.g. keeping a valid
 *  revision/dirty pair while only built_at is malformed) — same
 *  reasoning as MF-2's dashboard pair-invariant: a file with ANY invalid
 *  field was plausibly never written by generate-build-info.mjs at all,
 *  so nothing in it is trustworthy over the whole. */
function readBuildInfoFile(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    process.stderr.write(
      `build-identity: --format could not read ${file} (${err.message}), degrading to unknown\n`,
    );
    return { revision: "unknown", dirty: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `build-identity: --format input at ${file} is not valid JSON (${err.message}), degrading to unknown\n`,
    );
    return { revision: "unknown", dirty: false };
  }
  if (!isValidBuildInfoShape(parsed)) {
    process.stderr.write(
      `build-identity: --format input at ${file} is malformed, degrading to unknown\n`,
    );
    return { revision: "unknown", dirty: false };
  }
  return parsed;
}

function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--format") {
    if (!args[1] || args.length !== 2) throw new Error("--format requires one file path");
    process.stdout.write(`${formatIdentityString(readBuildInfoFile(args[1]))}\n`);
    return;
  }
  let cwd = repoRoot;
  let file;
  let json = false;
  let requireTagged = false;
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") json = true;
    else if (arg === "--require-tagged") requireTagged = true;
    else if (["--repo", "--snapshot", "--build-ref"].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error(`${arg} requires a value`);
      if (arg === "--repo") cwd = value;
      else if (arg === "--snapshot") file = value;
      else options.buildRef = value;
    } else throw new Error(`unsupported option: ${arg}`);
  }
  const identity = requireTagged ? requireTaggedIdentity(cwd, options) : computeBuildIdentity(cwd, options);
  if (identity.degraded) process.stderr.write(`build-identity: degraded (${identity.degradeReason})\n`);
  const artifact = artifactBuildIdentity(identity);
  if (file) {
    writeFileSync(file, `${JSON.stringify(artifact)}\n`, { flag: "wx", mode: 0o400 });
  } else if (json) {
    process.stdout.write(`${JSON.stringify(artifact)}\n`);
  } else {
    for (const [name, value] of Object.entries({
      KAOIRO_BUILD_REVISION: identity.revision, KAOIRO_BUILD_DIRTY: identity.dirty,
      KAOIRO_BUILD_VERSION: identity.version, KAOIRO_BUILD_CHANNEL: identity.channel,
      KAOIRO_BUILD_BRANCH: identity.branch,
    })) process.stdout.write(`${name}=${shellQuote(value)}\n`);
  }
}

// Only run the CLI when invoked directly (`node build-identity.mjs`), not
// when imported as a module (generate-build-info.mjs, and this file's own
// tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    process.stderr.write(`build-identity: ${error.message}\n`);
    process.exitCode = 78;
  }
}
