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
//                                               KAOIRO_BUILD_DIRTY= lines
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
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(import.meta.url));

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
  const rawRevision = gitOutput(["rev-parse", "HEAD"], cwd);
  if (rawRevision === null) {
    return {
      revision: "unknown",
      dirty: false,
      degraded: true,
      degradeReason: "git rev-parse HEAD failed (no git, or not a checkout)",
    };
  }
  const statusOutput = gitOutput(["status", "--porcelain"], cwd);
  if (statusOutput === null) {
    return {
      revision: "unknown",
      dirty: false,
      degraded: true,
      degradeReason:
        "git status --porcelain failed after a successful rev-parse HEAD",
    };
  }
  return {
    revision: rawRevision,
    dirty: statusOutput.length > 0,
    degraded: false,
    degradeReason: null,
  };
}

/** The single canonical `<revision>[-dirty]` string form. Formula-identical
 *  to runner/src/build_info.ts's formatBuildRevision — see that function's
 *  doc for why it cannot import this module directly; the two are pinned
 *  equal by tests on both sides instead. */
export function formatIdentityString({ revision, dirty }) {
  return dirty ? `${revision}-dirty` : revision;
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--format") {
    const file = args[1];
    if (!file) {
      process.stderr.write("build-identity: --format requires a file path\n");
      process.exit(64); // EX_USAGE
    }
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    process.stdout.write(`${formatIdentityString(parsed)}\n`);
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
}

// Only run the CLI when invoked directly (`node build-identity.mjs`), not
// when imported as a module (generate-build-info.mjs, and this file's own
// tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
