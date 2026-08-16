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
import vm from "node:vm";

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

/** A VerifyError whose cause is a plain ENOENT on an artifact this release
 *  should carry — i.e. the file was simply never built, distinguished from
 *  every other failure class (containment, malformed content, identity
 *  mismatch) that a rebuild cannot fix. Callers that need to tell the
 *  operator whether "run the build" is even a plausible remedy (issue #259)
 *  branch on this; every other verification failure stays a plain
 *  VerifyError so a rebuild is never suggested for something it cannot fix. */
class MissingArtifactError extends VerifyError {}

function fail(message) {
  throw new VerifyError(message);
}

function failMissingArtifact(message) {
  throw new MissingArtifactError(message);
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
    // ENOENT here means dist/ was simply never built — issue #259: this is
    // the one case where telling the operator to build is actually correct.
    // Any other code (EACCES, EISDIR, ...) means the file IS there and
    // something else is wrong, which a rebuild does not fix.
    //
    // UNLIKE containedRealPath, no dangling-symlink ambiguity applies here:
    // readFileSync's ENOENT always reports syscall "open" regardless of
    // WHICH path component failed (measured directly), so there is no
    // signal here to split on even if one were needed. None is needed in
    // practice — `dist/` is never itself a workspace link in either
    // topology this file supports (only node_modules/@kaoiro/<pkg> is;
    // dist/ is always written as a real directory by writeReleaseTree /
    // the real builder), so an ENOENT reaching this readFileSync can only
    // mean the file itself is absent.
    if (err.code === "ENOENT") {
      failMissingArtifact(`dist/build-info.json is unreadable: ${err.message}`);
    }
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
    // ENOENT alone does not mean "this artifact was never built" (ふじ
    // review, issue #259). realpathSync walks `target` component by
    // component, and Node reports a DIFFERENT syscall depending on which
    // component failed:
    //   - a component SIMPLY DOES NOT EXIST — as a file, directory, or
    //     symlink, in ANY form: `lstat` on that component. Genuinely never
    //     built, whether the missing component is the leaf itself
    //     (`node_modules/@kaoiro/claude-code/dist/cli.js` absent,
    //     `err.path === target`) or an entire ancestor
    //     (`node_modules/@kaoiro/claude-code` never created at all,
    //     `err.path` shorter than `target`) — a rebuild fixes both. An
    //     internal review round caught an earlier version of this guard
    //     that also required `err.path === target`, which wrongly excluded
    //     the whole-ancestor-missing shape (measured: `err.path` is the
    //     first missing component's OWN path there, not the full target,
    //     even though the syscall is still `lstat`) — the reachable
    //     `syscall` values are exactly two, and the split is complete
    //     between them; there is no third `err.path`-based case to gate on.
    //   - a component EXISTS as a symlink whose own resolution target is
    //     missing (a dangling workspace link, or the symlink itself being
    //     `target` with nothing beyond it): `stat`, following the link.
    //     This is an install/checkout topology problem, not a build
    //     shortage — a rebuild does not repair a broken symlink and must
    //     not be suggested for it.
    //   `ELOOP` (a symlink cycle) and `ENOTDIR` (a path component that is a
    //   plain file, not a directory) are different error CODES entirely,
    //   never `ENOENT`, so they never reach this branch at all — probed
    //   directly, alongside both ENOENT shapes above, before writing this.
    if (err.code === "ENOENT" && err.syscall === "lstat") {
      failMissingArtifact(`${rel} is missing or unresolvable: ${err.message}`);
    }
    fail(`${rel} is missing or unresolvable: ${err.message}`);
  }
  const within = relative(realRoot, real);
  if (within === "" || within.startsWith("..") || isAbsolute(within)) {
    fail(`${rel} resolves outside the release: ${real}`);
  }
  return real;
}

/** The pnpm workspace root at or above `dir`, or null when there is none.
 *
 *  A REPO-DIRECT CHECKOUT'S BOUNDARY IS THE WORKSPACE, NOT runner/. pnpm links
 *  a workspace member into its dependents by a relative path that leaves the
 *  dependent — `runner/node_modules/@kaoiro/claude-code ->
 *  ../../../wrapper/claude-code` (measured on the repo checkout, 2026-08-16)
 *  — so EVERY sentinel resolves outside runner/, and the repo-direct profile
 *  this file explicitly supports could not start at all. It did not: the
 *  service failed with exit 78 on the first restart after the check reached
 *  production, on a tree whose builds were current. The fixtures missed it
 *  because they write node_modules/@kaoiro/* as real directories INSIDE the
 *  release root — a shape only a built release has, so the fixture supplied
 *  the very premise the test claimed to measure.
 *
 *  A built release carries its dependencies inside itself, so its boundary
 *  stays the release root and this walk never runs there.
 *
 *  WHAT THE MARKER IS TRUSTED FOR, STATED PLAINLY. It says "a checkout starts
 *  here" and nothing more: this walk does not read the file, does not check
 *  that the tree below is one of the members it lists, and does not stop at an
 *  ownership boundary. A party who can drop an empty pnpm-workspace.yaml into
 *  an ancestor directory can therefore widen the boundary — but only for a
 *  tree carrying NEITHER a VERSION NOR a manifest, never for an installed
 *  release, whose paths stay pinned to the release root. That is the same
 *  trust standing the manifest's own `dependencies` map has (see
 *  verifyRelease): it closes a builder bug and a naive corruption, not
 *  tampering. `lstat`, so a symlink cannot stand in for the marker. */
function workspaceRootOf(dir) {
  for (let cur = dir; ; ) {
    try {
      if (lstatSync(join(cur, "pnpm-workspace.yaml")).isFile()) return cur;
    } catch {
      // keep walking up
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
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

/** Specifiers this verifier follows at all. `node:` builtins and third-party
 *  packages are outside the manifest's own documented scope. */
function isFirstParty(specifier) {
  return specifier.startsWith(".") || specifier.startsWith("@kaoiro/");
}

/** V8's parse of a module body: ES-module goal first, sloppy script goal
 *  second. Returns `{ specifiers }`, or `{ error }` when neither goal accepts
 *  the source.
 *
 *  WHY TWO GOALS. `vm.SourceTextModule` always parses as an ES module, which
 *  is implicitly STRICT, so ordinary CommonJS is a SyntaxError there while
 *  being perfectly loadable JS — `with (x) {}`, an octal literal like `0755`,
 *  a duplicate parameter name (measured on node v24.3.0). Rejecting such a
 *  file would block a deploy over a release that is entirely healthy, the
 *  wrong direction. Sloppy code cannot carry a static `import` at all, so
 *  falling back loses no specifier; and a file BOTH goals refuse really is
 *  broken, which is what the caller's fail() is for. */
function parseSource(source) {
  try {
    const record = new vm.SourceTextModule(source);
    return { specifiers: record.dependencySpecifiers };
  } catch (moduleErr) {
    try {
      new vm.Script(source);
      return { specifiers: [] };
    } catch {
      return { error: moduleErr };
    }
  }
}

/** Files a package loads at RUNTIME through a path it composes itself,
 *  DECLARED BY THE PACKAGE rather than inferred from its source text.
 *
 *  WHY DECLARED, NOT DETECTED. The codex wrapper reaches its bridge script
 *  through `new URL("../dist/bridge.js", import.meta.url)` — a real
 *  first-party edge no `import` statement expresses, and one the closure once
 *  missed entirely (もも review, issue #229). Recognising it by matching the
 *  TEXT of that call was tried and then abandoned: a regex cannot resolve a
 *  BINDING. `foo.require("./x.js")` is a method call on an unrelated object,
 *  and a module that defines its own `class URL {}` is not calling the global
 *  one; both read as real edges to a pattern match, and both REJECT A HEALTHY
 *  RELEASE — three instances of one class, the third found by もも on a module
 *  that `node --check` and a real `--version` run both accept. V8 exposes no
 *  scope information to settle it, and a parser that does would be a
 *  dependency this file is required not to have. Declaring the edge removes
 *  the inference instead of refining it (director 裁定, 2026-08-16).
 *
 *  THE BOUNDARY, STATED PLAINLY: a runtime reference with NO declaration is
 *  invisible to this verifier. Adding such a reference is half the change and
 *  adding its declaration is the other half; runtimeAssetDeclarations.test.ts
 *  is what makes a forgotten one fail in CI instead of in a release. Dynamic
 *  `import()` and `require()` of a computed or non-literal path fall in the
 *  same gap, and always did.
 *
 *  TRUST STANDING is the `dependencies` map's, no better: a party who can
 *  rewrite MANIFEST.json can rewrite this field too. See the trust-boundary
 *  note in verifyRelease — what this closes is a builder bug and a partial
 *  corruption, not tampering. */
function declaredRuntimeAssets(pkgDir, pkg, root, realRoot) {
  const declared = pkg.kaoiro?.runtimeAssets;
  if (declared === undefined) return [];
  const name = typeof pkg.name === "string" ? pkg.name : relative(root, pkgDir);
  if (
    !Array.isArray(declared) ||
    declared.some((rel) => typeof rel !== "string")
  ) {
    fail(`${name} has a malformed kaoiro.runtimeAssets (expected an array of strings)`);
  }
  // A DECLARATION IS AN INPUT, NOT A PROMISE. It travels in the tree under
  // inspection, so it gets the same three questions every other path in this
  // file gets — is it inside the release, does it exist, is it a regular
  // file. Skipping them would let `../../../etc/passwd` pull an out-of-tree
  // file into the closure (the walk then READS it, and a parse error puts
  // part of its content on stderr), and would let a declared FIFO block the
  // first readFileSync forever while install holds the lock.
  return declared.map((rel) => {
    if (isAbsolute(rel)) {
      fail(`${name} declares the runtime asset ${rel} as an absolute path`);
    }
    let real;
    try {
      real = realpathSync(join(pkgDir, rel));
    } catch (err) {
      fail(
        `${name} declares the runtime asset ${rel}, which this release does not contain: ${err.message}`,
      );
    }
    const within = relative(realRoot, real);
    if (within === "" || within.startsWith("..") || isAbsolute(within)) {
      fail(
        `${name} declares the runtime asset ${rel}, which resolves outside the release: ${real}`,
      );
    }
    if (!statSync(real).isFile()) {
      fail(`${name} declares the runtime asset ${rel}, which is not a regular file`);
    }
    return real;
  });
}

/** The first-party specifiers `source` STATES. `label` is the
 *  release-relative path, used in diagnostics and to decide whether an
 *  unparseable file is a defect.
 *
 *  THIS IS V8's ANSWER, NOT A LEXER'S. Four defects in a row came from
 *  reading JS without a parser: a specifier inside a comment, then one
 *  inside a string, then one inside a template, then a REAL specifier LOST
 *  because the `/` of a division opened what the lexer read as a regex
 *  literal and blanked the rest of the line. Each fix enumerated one more
 *  non-code context and the class stayed open; the fourth instance is what
 *  ended the approach (もも division probe, issue #229). `vm.SourceTextModule`
 *  compiles the body with V8 and hands back `dependencySpecifiers`. It never
 *  EVALUATES, so no code from the tree under inspection runs in the verifier.
 *
 *  STATED, NOT COMPOSED. `dependencySpecifiers` holds the static import graph
 *  and nothing else. A path a module builds at runtime is not read out of its
 *  text at all — see declaredRuntimeAssets for why that inference was removed
 *  and what carries those edges now.
 *
 *  A NON-JS DEPENDENCY IS NOT A DEFECT. `import data from "./x.json"`
 *  resolves to a file with no module edges of its own, and feeding it to a JS
 *  parser would reject a release for being exactly what it should be. A `.js`
 *  that NO goal will parse (see parseSource) IS one: its edges cannot be
 *  derived, and passing over it silently is the fail-open this file exists to
 *  remove. */
function specifiersOf(source, label) {
  const parsed = parseSource(source);
  if (parsed.error !== undefined) {
    if (/\.[cm]?js$/.test(label)) {
      fail(`${label} does not parse as JavaScript: ${parsed.error.message}`);
    }
    return new Set();
  }
  return new Set(parsed.specifiers.filter(isFirstParty));
}

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
 *  out of both). Each body goes through V8 (see specifiersOf) so a specifier
 *  is recognised only in specifier position: the asymmetry holds in one
 *  direction only — missing a specifier narrows detection, inventing one
 *  rejects a healthy release.
 *
 *  TWO SOURCES OF EDGES, AND ONLY TWO. The static import graph, from V8; and
 *  each package's own `kaoiro.runtimeAssets` declaration, for the files it
 *  loads through a path it composes itself. Nothing is inferred from the text
 *  of a call any more — see declaredRuntimeAssets for the three healthy
 *  releases that inference rejected.
 *
 *  NEEDS `node --experimental-vm-modules`, AND SAYS SO RATHER THAN COPING.
 *  Without the flag `vm.SourceTextModule` is simply `undefined` (measured on
 *  node v24.3.0; the runner requires node >= 22), so a verifier launched
 *  without it cannot derive this closure at all. Degrading to "then skip the
 *  re-derivation" would restore, in one line, the exact fail-open もも
 *  measured — an undersized manifest accepted at exit 0. Only the strict
 *  callers reach this code, and kaoiro_verify_release_tree in
 *  kaoiro-runner-common.sh is the single place that passes the flag; the
 *  launch shim runs plain `node` without --require-manifest and never gets
 *  here. */
function expectedClosure(root) {
  if (typeof vm.SourceTextModule !== "function") {
    fail(
      "closure re-derivation needs `node --experimental-vm-modules` (vm.SourceTextModule is unavailable) — the verifier was launched without it",
    );
  }
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
  /** Adds `pkgDir`'s declared runtime assets.
   *
   *  AN ABSENT package.json IS A DEFECT HERE, NOT A "not a package" SHRUG.
   *  The builder's manifest covers dist/ only, so no package.json is a
   *  manifest entry — and this code runs only under --require-manifest, on a
   *  tree the builder produced, where every one of these directories is a
   *  package by construction. Returning quietly on ENOENT would mean deleting
   *  one unhashed file silently disables every declaration it carried, which
   *  is the fail-open the declarations exist to close. */
  const runtimeAssets = (pkgDir) => {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    } catch (err) {
      fail(
        `${relative(root, pkgDir) || "."}/package.json is missing, unreadable or malformed: ${err.message}`,
      );
    }
    for (const real of declaredRuntimeAssets(pkgDir, pkg, root, realRoot)) {
      push(real);
    }
  };
  const realRoot = realpathSync(root);
  entry(join(root, "dist", "cli.js"));
  runtimeAssets(root);
  for (const name of ENTRY_PACKAGES) {
    entry(join(root, "node_modules", name, "dist", "cli.js"));
    runtimeAssets(join(root, "node_modules", name));
  }
  while (queue.length > 0) {
    const file = queue.pop();
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch (err) {
      fail(`${file} is unreadable: ${err.message}`);
    }
    const specifiers = specifiersOf(source, relative(root, file));
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
        for (const real of declaredRuntimeAssets(pkgDir, pkg, root, realRoot)) {
          push(real);
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
      // Nothing else can arrive: specifiersOf keeps first-party specifiers
      // only, so node: builtins and third-party packages never get here.
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
    // NO WORKSPACE ABOVE IT MEANS THE TREE IS ITS OWN BOUNDARY, and that
    // fallback is the STRICTER of the two, not a degrade: it is the release
    // root this branch checked before, so a self-contained tree carrying
    // neither VERSION nor a manifest goes on being accepted exactly as it was.
    // The wider boundary is what the workspace marker BUYS, and only there.
    const boundary = workspaceRootOf(realRoot) ?? realRoot;
    for (const rel of SENTINELS) containedRealPath(root, boundary, rel);
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
      // issue #259: exit 71 marks a MissingArtifactError specifically so a
      // caller (kaoiro-runner-launch.sh) can tell "build shortage" apart
      // from every other verification failure and stop recommending a build
      // for a failure a build cannot fix. Every other caller (install /
      // switch, kaoiro-runner-common.sh's kaoiro_verify_release_tree) only
      // ever checked zero-vs-nonzero, so this is additive, not a breaking
      // change to the exit-code contract.
      // 70 = EX_SOFTWARE (generic verification failure); 71 = build shortage
      // specifically (a MissingArtifactError).
      process.exit(err instanceof MissingArtifactError ? 71 : 70);
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
