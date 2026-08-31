#!/usr/bin/env node
// Shared build-identity computation (issue #228 round 2, ふじ MF-2/MF-5
// 差し戻し). SINGLE place that computes revision/dirty from git — used by
// BOTH runner/scripts/generate-build-info.mjs (writes dist/build-info.json,
// the runner side) and docs/specs/deployment.md 4.3's server build step
// (computes the KAOIRO_BUILD_REVISION / KAOIRO_BUILD_DIRTY build args) so
// the two paths cannot silently diverge on what "dirty" means. Round-1 had
// the runner side compute this and the server side just take an operator-
// supplied `git rev-parse HEAD` with no dirty check at all — ふじ's MF-2
// finding.
//
// Also reachable in `--format <file>` mode by scripts/build-runner-
// tarball.sh, so its VERSION file's `<revision>[-dirty]` string is produced
// by the SAME formatting call as runner/src/build_info.ts's
// formatBuildRevision() rather than a hand-copied second implementation
// (MF-5 tri-way pin: shim --version / VERSION file / dist/build-info.json
// must never drift into three different formats). That TS function itself
// cannot import this file directly — it ships inside the tarball's dist/
// and must never reach outside its pnpm-deploy-pruned package boundary at
// runtime (see build_info.ts's own doc comment) — so the two stay
// independently authored but are pinned equal by test fixtures on both
// sides rather than sharing a runtime import.
//
// CLI usage:
//   node build-identity.mjs                 -> compute from git (cwd
//                                               defaults to this script's
//                                               own directory, i.e. repo
//                                               root); print
//                                               KAOIRO_BUILD_REVISION= /
//                                               KAOIRO_BUILD_DIRTY= /
//                                               KAOIRO_BUILD_VERSION= /
//                                               KAOIRO_BUILD_CHANNEL= lines
//                                               (shell-sourceable, e.g.
//                                               `eval "$(node
//                                               scripts/build-identity.mjs)"`)
//   node build-identity.mjs --format <file> -> read a
//                                               {revision,dirty}-shaped JSON
//                                               file and print the
//                                               canonical `<rev>[-dirty]`
//                                               string
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Runs a git subcommand from `cwd`; returns trimmed stdout, or `null` if
 *  git is unavailable, `cwd` is not a checkout, or the command otherwise
 *  fails. Never throws. */
function gitOutput(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** Computes `{ revision, dirty, degraded, degradeReason }` from git state at
 *  `cwd` (default: repo root).
 *
 * dirty definition (issue #228, decided round 1): `git status --porcelain`
 * sees BOTH tracked and untracked changes, unlike `git diff --quiet` (misses
 * untracked entirely) — issue #227's own build slipped past the
 * tracked-only check via an untracked file, the concrete incident that
 * settled this.
 *
 * degrade rule (issue #228 round 2, ふじ MF-2 ruling): if `git status
 * --porcelain` cannot be read AFTER a successful `rev-parse HEAD`, the
 * WHOLE identity degrades to `{ revision: "unknown", dirty: false }` —
 * NOT just `dirty: false` with the real revision kept. A revision without a
 * trustworthy dirty read is not usable as a deploy postcondition. Explicitly
 * rejected: tri-stating dirty (unknown/true/false) instead, which would add
 * absent / unknown / dirty-unknown / dirty / clean-mismatch / clean-match
 * states and complicate issue #230's future enforcement design for no
 * benefit here — see docs/adr/0053-build-identity.md.
 */
export function computeBuildIdentity(cwd = repoRoot) {
  const version = readProjectVersion(cwd);
  const rawRevision = gitOutput(["rev-parse", "HEAD"], cwd);
  if (rawRevision === null) {
    return {
      revision: "unknown",
      dirty: false,
      version,
      channel: "dev",
      degraded: true,
      degradeReason: "git rev-parse HEAD failed (no git, or not a checkout)",
    };
  }
  const statusOutput = gitOutput(["status", "--porcelain"], cwd);
  if (statusOutput === null) {
    return {
      revision: "unknown",
      dirty: false,
      version,
      channel: "dev",
      degraded: true,
      degradeReason:
        "git status --porcelain failed after a successful rev-parse HEAD",
    };
  }
  const dirty = statusOutput.length > 0;
  return {
    revision: rawRevision,
    dirty,
    version,
    channel: determineBuildChannel(cwd, rawRevision, dirty, version),
    degraded: false,
    degradeReason: null,
  };
}

const PROJECT_VERSION_RE = /^\d{4}\.(?:[1-9]|1[0-2])\.\d+$/;

/** Reads the one project version file. A malformed or unavailable value is
 *  intentionally visible as `unknown`; it must never become a plausible
 *  release label through a fallback in one component. */
export function readProjectVersion(cwd = repoRoot) {
  try {
    const version = readFileSync(join(cwd, "VERSION"), "utf8").trim();
    return PROJECT_VERSION_RE.test(version) ? version : "unknown";
  } catch {
    return "unknown";
  }
}

/** A release requires a clean tree, a commit reachable from `main`, and the
 *  exact tag for VERSION. Detached CI checkouts remain eligible because
 *  branch containment, rather than the current ref name, proves main. */
function determineBuildChannel(cwd, revision, dirty, version) {
  if (dirty || revision === "unknown" || version === "unknown") return "dev";
  const branches = gitOutput(
    ["branch", "--contains", revision, "--format=%(refname:short)"],
    cwd,
  );
  const tags = gitOutput(["tag", "--points-at", revision], cwd);
  const onMain = branches?.split("\n").some((branch) => branch === "main");
  const hasVersionTag = tags?.split("\n").some((tag) => tag === `v${version}`);
  return onMain && hasVersionTag ? "release" : "dev";
}

/** The single canonical `<revision>[-dirty]` string form. Formula-identical
 *  to runner/src/build_info.ts's formatBuildRevision — see that function's
 *  doc for why it cannot import this module directly; the two are pinned
 *  equal by tests on both sides instead. */
export function formatIdentityString({ revision, dirty }) {
  return dirty ? `${revision}-dirty` : revision;
}

/** Value domain for `built_at` — identical logic to runner/src/build_info.ts's
 *  `isValidBuiltAt` (issue #228 round 4, ふじ 差し戻し), kept as an
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
 *  AND built_at — issue #228 round 4, ふじ 差し戻し: round 3 validated
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
    (value.revision === "unknown" || REVISION_RE.test(value.revision)) &&
    typeof value.dirty === "boolean" &&
    typeof value.built_at === "string" &&
    isValidBuiltAt(value.built_at)
  );
}

/** Reads and validates a build-info.json-shaped file, degrading to
 *  `{ revision: "unknown", dirty: false }` (with a reason logged to
 *  stderr) on ANY failure — missing file, unparsable JSON, or a malformed
 *  shape (issue #228 round 4, ふじ 差し戻し). Structurally mirrors
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

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--format") {
    const file = args[1];
    if (!file) {
      process.stderr.write("build-identity: --format requires a file path\n");
      process.exit(64); // EX_USAGE
    }
    process.stdout.write(`${formatIdentityString(readBuildInfoFile(file))}\n`);
    return;
  }
  const identity = computeBuildIdentity();
  if (identity.degraded) {
    process.stderr.write(
      `build-identity: degraded to unknown (${identity.degradeReason})\n`,
    );
  }
  process.stdout.write(`KAOIRO_BUILD_REVISION=${identity.revision}\n`);
  process.stdout.write(`KAOIRO_BUILD_DIRTY=${identity.dirty}\n`);
  process.stdout.write(`KAOIRO_BUILD_VERSION=${identity.version}\n`);
  process.stdout.write(`KAOIRO_BUILD_CHANNEL=${identity.channel}\n`);
}

// Only run the CLI when invoked directly (`node build-identity.mjs`), not
// when imported as a module (generate-build-info.mjs, and this file's own
// tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
