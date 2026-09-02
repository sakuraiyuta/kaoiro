#!/usr/bin/env node
// Generates dist/build-info.json (issue #228, build identity) as the LAST
// step of `pnpm -C runner build`, right after tsc emits dist/. This is the
// ONLY place build_revision/build_dirty are computed on the runner side —
// cli.ts reads this file, never git directly at runtime (see its own doc
// comment for why: a git-free tarball deploy, plus a repo-direct checkout
// whose dist/ predates HEAD, both make a live `git rev-parse` at startup
// report a commit the running artifact was NOT actually built from — the
// same "mtime lies about provenance" failure mode issue #227's runbook
// documents, just for git state instead of a file timestamp; director's
// explicit steer, issue #228 query round 1).
//
// The actual git computation (and the round-2 degrade rule: a failed `git
// status --porcelain` after a successful rev-parse degrades the WHOLE
// identity to unknown, not just dirty — ふじ MF-2) lives in the repo-level
// ../../scripts/build-identity.mjs, shared with the server build's
// KAOIRO_BUILD_REVISION/KAOIRO_BUILD_DIRTY computation (docs/specs/
// deployment.md 4.3) so the two paths cannot silently diverge on what
// "dirty" means. Safe to import here: this script only ever runs from
// within a full monorepo checkout (`pnpm -C runner build`), never inside a
// pnpm-deploy-pruned tarball tree.
//
// scripts/build-runner-tarball.sh's own VERSION file (issue #70) is a
// separate, human-facing artifact. It does NOT duplicate this script's git
// calls — it reads the dist/build-info.json this script writes (single
// source of truth for revision/dirty, issue #228 query round 2) and
// formats its own version string via the SAME repo-level
// build-identity.mjs (`--format` mode, issue #228 round 2 MF-5).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeBuildIdentity } from "../../scripts/build-identity.mjs";

// This script's own dir -> runner/scripts -> repo root is two levels up.
// Git state is checked from the REPO ROOT, not runner/'s own directory,
// matching build-runner-tarball.sh's own `cd "$root"` before its git
// calls — a dirty state ANYWHERE in this monorepo (e.g. shared
// wrapper/protocol code the runner build also compiles from) can taint
// the built artifact, not just changes under runner/.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const runnerDir = resolve(scriptDir, "..");
const repoRoot = resolve(runnerDir, "..");

const identity = computeBuildIdentity(repoRoot);
if (identity.degraded) {
  process.stderr.write(
    `generate-build-info: degraded to unknown (${identity.degradeReason})\n`,
  );
}

// `built_at` is diagnostic ONLY (issue #228, decided) -- never compared
// for equality, never part of identity. It answers "how stale is this
// artifact", not "what commit is it". Runner-only: the server side does
// not carry it (issue #228 round 2 advisory 2 — see ADR-0053).
const buildInfo = {
  revision: identity.revision,
  dirty: identity.dirty,
  built_at: new Date().toISOString(),
  version: identity.version,
  channel: identity.channel,
};

const distDir = join(runnerDir, "dist");
mkdirSync(distDir, { recursive: true });
writeFileSync(join(distDir, "build-info.json"), `${JSON.stringify(buildInfo, null, 2)}\n`);
