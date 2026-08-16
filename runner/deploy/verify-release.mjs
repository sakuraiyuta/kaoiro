#!/usr/bin/env node
// Release verification (issue #229 round 2, ふじ 差し戻し must-fix 1/2/3).
//
//   verify-release.mjs <release-root> [--require-manifest] [--hash]
//
// Exits 0 when the tree may be installed / activated / started, and non-zero
// with a specific reason on stderr otherwise. Callers map any non-zero exit
// to their own error code — kaoiro-runner-launch.sh maps it to 78, which is
// what makes systemd's RestartPreventExitStatus=78 apply instead of a
// restart loop.
//
// WHY THIS EXISTS AS ONE FILE. Three separate defects all came from the same
// place: the checks were a hand-written list of four sentinel paths spread
// across shell scripts, and a list only ever covers what someone thought of.
//   * A tarball whose single top-level entry was an absolute symlink to
//     somewhere else installed cleanly, because `[ -d ]` and `-f` follow
//     symlinks — releases/<id> itself became a link out of the install root.
//   * A tarball whose VERSION and dist/build-info.json disagreed installed
//     and activated cleanly, because nothing ever compared them.
//   * Deleting ONE module from a real dist (dist/args.js) passed all four
//     sentinels and then failed at import time with exit 1 — not 78 — so the
//     unit restart-looped.
// Collapsing the checks into one place is what closes the class; adding a
// fifth sentinel would not have.
//
// WHY PLAIN .mjs IN deploy/, NOT TypeScript IN src/. It ships verbatim in
// the release (package.json `files` includes `deploy`) and can be copied
// byte-for-byte into a test fixture, exactly like the .sh scripts beside it.
// Compiling it into dist/ would make the tests that exercise a fixture tree
// depend on a prior `pnpm -C runner build`, which this suite deliberately
// does not.
//
// The identity rules below are an independently authored duplicate of
// runner/src/build_info.ts and scripts/build-identity.mjs. That is the
// arrangement ADR-0053 already sanctions for this exact cross-package
// boundary; the three are pinned equal by tests rather than by a shared
// import.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Artifacts a release must carry even when it has no MANIFEST.json — a
 *  repo-direct dev checkout, which the builder never touched. In a real
 *  release the manifest supersedes this list. */
const SENTINELS = [
  "dist/cli.js",
  "dist/build-info.json",
  "node_modules/@kaoiro/claude-code/dist/cli.js",
  "node_modules/@kaoiro/codex/dist/cli.js",
];

const REVISION_RE = /^[0-9a-f]{40}$/;

class VerifyError extends Error {}

function fail(message) {
  throw new VerifyError(message);
}

function isValidBuiltAt(value) {
  if (value === "unknown") return true;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isBuildInfoShape(value) {
  if (typeof value !== "object" || value === null) return false;
  return (
    typeof value.revision === "string" &&
    (value.revision === "unknown" || REVISION_RE.test(value.revision)) &&
    typeof value.dirty === "boolean" &&
    typeof value.built_at === "string" &&
    isValidBuiltAt(value.built_at)
  );
}

/** Canonical `<revision>[-dirty]` form. Formula-identical to
 *  build_info.ts's formatBuildRevision and build-identity.mjs's
 *  formatIdentityString. */
export function formatIdentity(info) {
  return info.dirty ? `${info.revision}-dirty` : info.revision;
}

/** STRICT, unlike build_info.ts's loadBuildInfo, which degrades a missing or
 *  malformed file to `unknown` so a runner still starts. That degrade is
 *  correct for reporting identity and wrong for deciding whether a tree may
 *  be installed: `unknown` would then mean "this release is fine and simply
 *  cannot name itself", which is how a build-info.json holding the literal
 *  text `not json at all` passed start-up verification. */
function readBuildInfoStrict(root) {
  const path = join(root, "dist", "build-info.json");
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    fail(`dist/build-info.json is unreadable: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`dist/build-info.json is not valid JSON: ${err.message}`);
  }
  if (!isBuildInfoShape(parsed)) {
    fail("dist/build-info.json does not match the build-identity shape");
  }
  return parsed;
}

/** Resolves `rel` inside `root` and rejects anything whose REAL path leaves
 *  the tree. `-f` in shell follows symlinks, so an artifact check alone
 *  cannot tell a file in the release from a link pointing at one somewhere
 *  else entirely. pnpm's own links (node_modules/@kaoiro/<pkg> ->
 *  ../.pnpm/...) stay inside and pass. */
function containedRealPath(root, realRoot, rel) {
  const target = join(root, rel);
  let real;
  try {
    real = realpathSync(target);
  } catch (err) {
    fail(`${rel} is missing or unresolvable: ${err.message}`);
  }
  const within = relative(realRoot, real);
  if (within === "" || within.startsWith("..") || isAbsolute(within)) {
    fail(`${rel} resolves outside the release: ${real}`);
  }
  return real;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readManifest(root) {
  let raw;
  try {
    raw = readFileSync(join(root, "MANIFEST.json"), "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`MANIFEST.json is not valid JSON: ${err.message}`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof parsed.files !== "object" ||
    parsed.files === null ||
    Array.isArray(parsed.files)
  ) {
    fail("MANIFEST.json does not match the expected { files: {...} } shape");
  }
  const entries = Object.entries(parsed.files);
  if (entries.length === 0) fail("MANIFEST.json lists no files");
  for (const [rel, digest] of entries) {
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
      fail(`MANIFEST.json has a malformed sha256 for ${rel}`);
    }
  }
  return entries;
}

/**
 * @param root  release root (the directory holding dist/ and deploy/)
 * @param opts  requireManifest — reject a release with no MANIFEST.json
 *              (install / switch: a real release always has one).
 *              hash — also compare each manifest entry's sha256. Left off at
 *              service start, where the cost would be paid on every boot.
 */
export function verifyRelease(root, opts = {}) {
  // lstat, not stat: `[ -d ]` in shell follows symlinks, which is how an
  // archive whose only top-level entry was a link to another directory
  // became releases/<id> itself.
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch (err) {
    fail(`release root is unreadable: ${err.message}`);
  }
  if (rootStat.isSymbolicLink()) {
    fail("release root is a symlink, not a directory");
  }
  if (!rootStat.isDirectory()) fail("release root is not a directory");
  const realRoot = realpathSync(root);

  const info = readBuildInfoStrict(root);
  const identity = formatIdentity(info);

  // VERSION is the operator-facing copy of the identity. A tree where the two
  // disagree is not merely untidy: the directory is NAMED after VERSION, so a
  // mismatch means `current -> releases/<id>` points at something whose own
  // build-info says it is a different build.
  let version = null;
  try {
    version = readFileSync(join(root, "VERSION"), "utf8").trim();
  } catch {
    // Absent only in a repo-direct dev checkout — the builder always writes
    // one. Nothing to cross-check there.
  }
  if (version !== null && version !== identity) {
    fail(
      `VERSION (${version}) disagrees with dist/build-info.json (${identity})`,
    );
  }

  const manifest = readManifest(root);
  if (manifest === null) {
    if (opts.requireManifest === true) {
      fail("MANIFEST.json is missing (not a release built by the builder)");
    }
    for (const rel of SENTINELS) containedRealPath(root, realRoot, rel);
    return { identity, checked: SENTINELS.length, manifest: false };
  }

  for (const [rel, digest] of manifest) {
    const real = containedRealPath(root, realRoot, rel);
    if (opts.hash === true && sha256(real) !== digest) {
      fail(`${rel} does not match its MANIFEST.json sha256`);
    }
  }
  return { identity, checked: manifest.length, manifest: true };
}

function main(argv) {
  let root = null;
  const opts = {};
  for (const arg of argv) {
    if (arg === "--require-manifest") opts.requireManifest = true;
    else if (arg === "--hash") opts.hash = true;
    else if (arg.startsWith("-")) {
      process.stderr.write(`verify-release: unknown option: ${arg}\n`);
      process.exit(64); // EX_USAGE
    } else if (root === null) root = arg;
    else {
      process.stderr.write("verify-release: more than one release root\n");
      process.exit(64);
    }
  }
  if (root === null) {
    process.stderr.write(
      "usage: verify-release.mjs <release-root> [--require-manifest] [--hash]\n",
    );
    process.exit(64);
  }
  try {
    const result = verifyRelease(resolve(root), opts);
    process.stdout.write(`${result.identity}\n`);
  } catch (err) {
    if (err instanceof VerifyError) {
      process.stderr.write(`verify-release: ${root}: ${err.message}\n`);
      process.exit(70); // EX_SOFTWARE
    }
    throw err;
  }
}

/** Was this file run as the entry point, rather than imported by a test?
 *
 * BOTH SIDES ARE REALPATH'D, AND THAT IS THE WHOLE POINT. Node resolves an
 * ESM module's own URL through realpath while leaving process.argv[1] exactly
 * as typed, so the obvious `import.meta.url === \`file://${process.argv[1]}\``
 * is false for every invocation that reached this file through a symlink —
 * which is precisely how PRODUCTION reaches it, since the launch shim runs
 * <install-root>/current/deploy/verify-release.mjs. main() then never ran and
 * the process exited 0, so the whole start-time check was a silent no-op: a
 * release with dist/args.js removed started anyway and died at import with
 * node's exit 1, restart-looping on the exact fault exit 78 exists to stop.
 * Measured on a real tarball install, 2026-08-16 (the fixtures missed it
 * because they invoke the shim by its physical path). The comparison also
 * stops depending on `file://` + a raw path being a well-formed URL, which it
 * is not once a path contains a space.
 *
 * NOTHING HERE CATCHES. A `catch { return false }` would read as defensive
 * and mean "not the entry point", so main() would be skipped and the process
 * would exit 0 having verified nothing — the launch shim only reacts to a
 * NON-zero exit, so that silent pass is indistinguishable from a good
 * release. It is the same fail-open this function was just rewritten to
 * remove. An exception instead propagates, node exits non-zero, and the shim
 * maps it to 78 like every other verification failure. */
function isEntryPoint() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return realpathSync(entry) === realpathSync(import.meta.filename);
}

if (isEntryPoint()) {
  main(process.argv.slice(2));
}
