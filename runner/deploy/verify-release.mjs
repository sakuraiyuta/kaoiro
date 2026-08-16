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
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

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

/** Reads a file that a release MAY legitimately lack, distinguishing absence
 *  from unreadability.
 *
 *  ENOENT is the only code that means "this file is genuinely not here".
 *  EACCES, EISDIR, ELOOP and friends mean it IS here and something is wrong,
 *  which is never a reason to take the more permissive branch. Folding both
 *  into one bare `catch` is precisely how a release whose MANIFEST.json could
 *  not be read degraded to the four-sentinel repo-direct path and started at
 *  exit 0 (もも review, issue #229 — measured on a real tarball). */
function readOptionalFile(root, name) {
  try {
    return readFileSync(join(root, name), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    fail(`${name} is present but unreadable: ${err.message}`);
  }
}

function parseManifest(raw) {
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

/** The wrapper packages the runner resolves from disk at spawn time. Kept
 *  identical to scripts/build-release-manifest.mjs's list on purpose — this
 *  is the ADR-0053 arrangement again: an independently authored duplicate,
 *  pinned equal by a test that feeds the real builder's own output through
 *  this verifier, rather than by a shared import (which would defeat the
 *  point of deriving the set twice). */
const ENTRY_PACKAGES = ["@kaoiro/claude-code", "@kaoiro/codex"];

/** Splits a module body into code text and its string literals, so a
 *  specifier can only be recognised in SPECIFIER POSITION.
 *
 *  A LEXER, NOT A LIST OF CASES. The previous revision blanked comments, and
 *  a string literal holding the same words was then read as a dependency;
 *  a template literal did it again (もも review, issue #229). Enumerating
 *  non-code contexts one defect at a time is the exact failure this issue
 *  keeps reproducing — the third instance of it. Tracking lexical state
 *  covers comments, strings and templates together, including whatever
 *  nobody has hit yet.
 *
 *  Each literal becomes an opaque marker, so `const x = 'import "./y.js"'`
 *  cannot match: the words are inside the marker, not beside `from`.
 *  A literal carrying an escape or a `${}` substitution is recorded as
 *  unusable rather than guessed at — and a regex literal is lexed as a
 *  string, which over-blanks. Both err toward noticing FEWER specifiers,
 *  which is the safe direction: missing one narrows this check, inventing
 *  one rejects a healthy release and blocks every deploy. */
function lexModule(source) {
  const values = [];
  let out = "";
  let i = 0;
  const blank = (text) => text.replace(/[^\n]/g, " ");
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const stop = source.indexOf("\n", i);
      const end = stop === -1 ? source.length : stop;
      out += blank(source.slice(i, end));
      i = end;
    } else if (two === "/*") {
      const stop = source.indexOf("*/", i + 2);
      const end = stop === -1 ? source.length : stop + 2;
      out += blank(source.slice(i, end));
      i = end;
    } else if (source[i] === '"' || source[i] === "'" || source[i] === "`") {
      const quote = source[i];
      let j = i + 1;
      let usable = true;
      while (j < source.length && source[j] !== quote) {
        if (source[j] === "\\") {
          usable = false;
          j += 2;
          continue;
        }
        if (quote === "`" && source.slice(j, j + 2) === "${") usable = false;
        j += 1;
      }
      const raw = source.slice(i + 1, Math.min(j, source.length));
      values.push(usable ? raw : null);
      out += `\u0000${values.length - 1}\u0000`;
      out += blank(raw).replace(/[^\n]/g, "");
      i = Math.min(j + 1, source.length);
    } else {
      out += source[i];
      i += 1;
    }
  }
  return { code: out, values };
}

/** Specifier positions, matched against the lexed code with each string
 *  literal reduced to its marker.
 *
 *  `new URL(..., import.meta.url)` is here because it is how the codex
 *  wrapper locates its own bridge script at runtime — a real first-party
 *  module edge that no `import` statement expresses, so the closure missed
 *  it entirely (もも review, issue #229). THIS ONE IS AN ENUMERATION and is
 *  worth naming as such: any OTHER way of composing a path at runtime stays
 *  invisible to this check. */
const SPECIFIER_RES = [
  /\bfrom\s*\u0000(\d+)\u0000/g,
  /\bimport\s+\u0000(\d+)\u0000/g,
  /\bimport\s*\(\s*\u0000(\d+)\u0000\s*\)/g,
  /\brequire\s*\(\s*\u0000(\d+)\u0000\s*\)/g,
  /\bnew\s+URL\s*\(\s*\u0000(\d+)\u0000\s*,\s*import\.meta\.url\s*\)/g,
];

/** Locates `<name>`'s directory by the ordinary node_modules walk from
 *  `fromFile`. `createRequire(...).resolve()` cannot stand in here: these
 *  packages publish `exports` with only an `import` condition, and CJS
 *  resolution refuses such a subpath outright ("Package subpath './catalog'
 *  is not defined by exports") even though the runtime, which loads them as
 *  ESM, resolves it fine. Measured against the real release, 2026-08-16. */
function packageDirOf(fromFile, name) {
  let dir = dirname(fromFile);
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    try {
      if (lstatSync(join(candidate, "package.json")).isFile()) return candidate;
    } catch {
      // keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Maps a bare `@kaoiro/...` specifier to a file, following the package's own
 *  `exports` under the `import` condition (what the runtime uses), falling
 *  back to `main` and then to the conventional file spellings.
 *
 *  Returns null when the mapping cannot be determined at all — deliberately
 *  NOT a failure. An unmapped specifier only narrows what this check can
 *  detect, whereas guessing wrong would reject a healthy release. */
function bareTarget(pkgDir, pkg, subpath) {
  const entry = pkg.exports?.[subpath];
  const mapped =
    typeof entry === "string"
      ? entry
      : typeof entry === "object" && entry !== null
        ? (entry.import ?? entry.node ?? entry.default)
        : undefined;
  if (typeof mapped === "string") return join(pkgDir, mapped);
  if (subpath === ".") {
    const main = pkg.module ?? pkg.main;
    return typeof main === "string" ? join(pkgDir, main) : null;
  }
  return join(pkgDir, subpath);
}

/** The FILE `base` names, trying the spellings node would: as written, with
 *  `.js` appended, and as a directory index. Null when none is a file.
 *
 *  The `isFile()` test is load-bearing, not defensive: `realpathSync`
 *  succeeds on a DIRECTORY, so without it the bare candidate would win
 *  whenever `base` is a directory — making the `index.js` spelling
 *  unreachable and pushing a directory into the reachable set, where the
 *  next `readFileSync` throws EISDIR and rejects a healthy release. */
function resolveFile(base) {
  for (const candidate of [base, `${base}.js`, join(base, "index.js")]) {
    try {
      const real = realpathSync(candidate);
      if (statSync(real).isFile()) return real;
    } catch {
      // try the next spelling
    }
  }
  return null;
}

/** THE FILES THIS RELEASE MUST CARRY, DERIVED WITHOUT READING THE MANIFEST.
 *
 *  This walks the actual module graph — it opens each reachable file and
 *  follows the specifiers written INSIDE it — rather than listing whatever
 *  happens to be on disk. That distinction is the whole point: a directory
 *  listing cannot notice a deletion, because a deleted file is simply absent
 *  from the listing too. `dist/cli.js` still says `from "./args.js"` after
 *  args.js is removed, so the dangling reference is what makes the removal
 *  detectable (もも review, issue #229: removing the file AND its manifest
 *  entry together passed --require-manifest --hash at exit 0).
 *
 *  SCOPE: first-party only. `@kaoiro/*` bare specifiers are followed across
 *  packages; `node:` builtins and third-party packages are not, matching the
 *  manifest's own documented scope (the ~920 MB of engine CLI payloads stays
 *  out of both). The body is lexed first (see lexModule) so a specifier is
 *  recognised only in specifier position: the asymmetry holds in one
 *  direction only — missing a specifier narrows detection, inventing one
 *  rejects a healthy release. */
function expectedClosure(root) {
  const reachable = new Set();
  const queue = [];
  const push = (file) => {
    if (file !== null && !reachable.has(file)) {
      reachable.add(file);
      queue.push(file);
    }
  };
  const entry = (path) => {
    try {
      push(realpathSync(path));
    } catch (err) {
      fail(`release is missing its entry point ${path}: ${err.message}`);
    }
  };
  entry(join(root, "dist", "cli.js"));
  for (const name of ENTRY_PACKAGES) {
    entry(join(root, "node_modules", name, "dist", "cli.js"));
  }
  while (queue.length > 0) {
    const file = queue.pop();
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch (err) {
      fail(`${file} is unreadable: ${err.message}`);
    }
    const specifiers = new Set();
    const { code, values } = lexModule(source);
    for (const re of SPECIFIER_RES) {
      re.lastIndex = 0;
      for (const match of code.matchAll(re)) {
        const value = values[Number(match[1])];
        if (value !== null && value !== undefined) specifiers.add(value);
      }
    }
    for (const specifier of specifiers) {
      if (specifier.startsWith(".")) {
        const resolved = resolveFile(join(dirname(file), specifier));
        if (resolved === null) {
          fail(
            `${relative(root, file)} imports ${specifier}, which this release does not contain`,
          );
        }
        push(resolved);
      } else if (specifier.startsWith("@kaoiro/")) {
        const parts = specifier.split("/");
        const name = parts.slice(0, 2).join("/");
        const subpath = parts.length > 2 ? `./${parts.slice(2).join("/")}` : ".";
        const pkgDir = packageDirOf(file, name);
        if (pkgDir === null) {
          fail(
            `${relative(root, file)} imports ${specifier}, which this release does not contain`,
          );
        }
        let pkg;
        try {
          pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
        } catch (err) {
          fail(`${name}'s package.json is unreadable or malformed: ${err.message}`);
        }
        const target = bareTarget(pkgDir, pkg, subpath);
        if (target !== null) {
          const resolved = resolveFile(target);
          if (resolved === null) {
            fail(
              `${relative(root, file)} imports ${specifier}, whose target ${relative(root, target)} this release does not contain`,
            );
          }
          push(resolved);
        }
      }
      // node: builtins and third-party packages are deliberately not followed.
    }
  }
  return reachable;
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
  // Absent only in a repo-direct dev checkout — the builder always writes
  // one. An unreadable VERSION is NOT absence; see readOptionalFile.
  const versionRaw = readOptionalFile(root, "VERSION");
  const version = versionRaw === null ? null : versionRaw.trim();
  if (version !== null && version !== identity) {
    fail(
      `VERSION (${version}) disagrees with dist/build-info.json (${identity})`,
    );
  }

  const manifestRaw = readOptionalFile(root, "MANIFEST.json");
  if (manifestRaw === null) {
    if (opts.requireManifest === true) {
      fail("MANIFEST.json is missing (not a release built by the builder)");
    }
    // WHAT MAKES A TREE repo-direct IS THE ABSENCE OF A VERSION FILE, NOT AN
    // ABSENT MANIFEST. Only scripts/build-runner-tarball.sh writes VERSION,
    // and it writes MANIFEST.json in the same run — so a tree WITH a VERSION
    // and WITHOUT a manifest is a release that LOST a file, never a dev
    // checkout. Degrading it to the sentinel list re-opened the very
    // enumeration this file exists to close: a real release with its
    // MANIFEST.json removed passed start-up verification and reached the
    // final exec at exit 0 (もも review, issue #229).
    if (version !== null) {
      fail(
        "MANIFEST.json is missing from a built release (VERSION is present) — reinstall it; only a repo-direct checkout, which has no VERSION either, may start without one",
      );
    }
    for (const rel of SENTINELS) containedRealPath(root, realRoot, rel);
    return { identity, checked: SENTINELS.length, manifest: false };
  }

  const manifest = parseManifest(manifestRaw);
  const listed = new Set();
  for (const [rel, digest] of manifest) {
    const real = containedRealPath(root, realRoot, rel);
    listed.add(real);
    if (opts.hash === true && sha256(real) !== digest) {
      fail(`${rel} does not match its MANIFEST.json sha256`);
    }
  }

  // A manifest cannot be its own witness. Everything above proves the tree
  // matches what the manifest CLAIMS; it cannot notice a claim that was made
  // smaller. Removing dist/args.js together with its entry left a
  // self-consistent, undersized manifest that passed --require-manifest
  // --hash at exit 0 (もも review, issue #229). So the strict callers derive
  // the expected closure a second time, from the package graph, and reject a
  // release that is missing anything it should carry.
  //
  // THE TRUST BOUNDARY, STATED PLAINLY. The re-derivation reads package.json
  // files from the SAME tree, so a party able to rewrite MANIFEST.json can
  // usually rewrite a `dependencies` map too, and both sides would then
  // shrink together. THIS IS NOT TAMPER RESISTANCE. What it closes is a
  // builder bug and a partial or naive post-distribution corruption. A
  // guarantee above that threshold needs a signature or a digest kept
  // outside the tree, which is deliberately a separate decision.
  if (opts.requireManifest === true) {
    for (const real of expectedClosure(root)) {
      if (!listed.has(real)) {
        fail(
          `MANIFEST.json omits ${relative(realRoot, real)}, which the package graph says this release must carry`,
        );
      }
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
