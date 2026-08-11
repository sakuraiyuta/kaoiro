#!/usr/bin/env node
// Generates dist/build-info.json (issue #228, build identity) as the LAST
// step of `pnpm -C runner build`, right after tsc emits dist/. This is the
// ONLY place build_revision is computed — cli.ts reads this file, never
// git directly at runtime (see its own doc comment for why: a git-free
// tarball deploy, plus a repo-direct checkout whose dist/ predates HEAD,
// both make a live `git rev-parse` at startup report a commit the running
// artifact was NOT actually built from — the same "mtime lies about
// provenance" failure mode issue #227's runbook documents, just for git
// state instead of a file timestamp; director's explicit steer, issue #228
// query round 1).
//
// scripts/build-runner-tarball.sh's own VERSION file (issue #70) is a
// separate, human-facing artifact. It does NOT duplicate this script's git
// calls — it reads the dist/build-info.json this script writes (single
// source of truth for revision/dirty, issue #228 query round 2) and
// derives its own version string from that.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This script's own dir -> runner/scripts -> repo root is two levels up.
// Git state is checked from the REPO ROOT, not runner/'s own directory,
// matching build-runner-tarball.sh's own `cd "$root"` before its git
// calls — a dirty state ANYWHERE in this monorepo (e.g. shared
// wrapper/protocol code the runner build also compiles from) can taint
// the built artifact, not just changes under runner/.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const runnerDir = resolve(scriptDir, "..");
const repoRoot = resolve(runnerDir, "..");

/** Runs a git subcommand from the repo root; returns trimmed stdout, or
 *  `null` if git is unavailable or this is not a git checkout (e.g. a
 *  stripped-down CI image, or the tarball's own build ran outside any
 *  checkout). Never throws — a missing git must degrade to "unknown", not
 *  fail the whole build. */
function gitOutput(args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const revision = gitOutput(["rev-parse", "HEAD"]) ?? "unknown";
// dirty definition (issue #228, decided): tracked AND untracked changes
// both count. `git status --porcelain` (unlike `git diff --quiet`, which
// misses untracked files entirely) sees both -- #227's own build slipped
// past the tracked-only check via an untracked file, which is the
// concrete incident that settled this. Single source of truth: this is
// the ONLY place in the repo that computes "dirty" now --
// build-runner-tarball.sh's VERSION file is a separate, unrelated
// artifact (see its own comment).
const statusOutput = revision === "unknown" ? null : gitOutput(["status", "--porcelain"]);
const dirty = statusOutput !== null && statusOutput.length > 0;

// `built_at` is diagnostic ONLY (issue #228, decided) -- never compared
// for equality, never part of identity. It answers "how stale is this
// artifact", not "what commit is it".
const buildInfo = {
  revision,
  dirty,
  built_at: new Date().toISOString(),
};

const distDir = join(runnerDir, "dist");
mkdirSync(distDir, { recursive: true });
writeFileSync(join(distDir, "build-info.json"), `${JSON.stringify(buildInfo, null, 2)}\n`);
