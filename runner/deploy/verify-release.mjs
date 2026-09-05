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
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import vm from "node:vm";

/** Artifacts a repo-direct checkout must carry even when it has no
 * MANIFEST.json. A real release's manifest covers these first-party files. */
const SENTINELS = [
  "dist/cli.js",
  "dist/build-info.json",
  "node_modules/@kaoiro/claude-code/dist/cli.js",
  "node_modules/@kaoiro/codex/dist/cli.js",
  "node_modules/@kaoiro/antigravity/dist/cli.js",
];

const REVISION_RE = /^[0-9a-f]{40}$/;
const VERSION_RE = /^\d{4}\.(?:[1-9]|1[0-2])\.\d+$/;
const EXACT_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

class VerifyError extends Error {}

/** A VerifyError whose cause is specifically a missing BUILD OUTPUT — a
 *  compiled file this release's own `pnpm build` step produces, absent
 *  from an otherwise-intact tree. Callers that need to tell the operator
 *  whether "run the build" is a plausible remedy (issue #259) branch on
 *  this. */
class MissingArtifactError extends VerifyError {}

/** A VerifyError whose cause is specifically a missing pnpm WORKSPACE LINK
 *  — the `node_modules/@kaoiro/<pkg>` dependency-linking topology `pnpm
 *  install` creates, never touched by `pnpm build`. Distinguished from
 *  `MissingArtifactError` because the two need DIFFERENT remedies and a
 *  build does not fix this one (ふじ review round 3, issue #259: measured
 *  directly — running the suggested build against a checkout missing this
 *  link fails with tsc's own TS2307 "cannot find module", and does not
 *  recreate the link). */
class MissingWorkspaceLinkError extends VerifyError {}

function fail(message) {
  throw new VerifyError(message);
}

function failMissingArtifact(message) {
  throw new MissingArtifactError(message);
}

function failMissingWorkspaceLink(message) {
  throw new MissingWorkspaceLinkError(message);
}

/** lstat's `path` (never following the final component — a symlink
 *  standing in for something is a DIFFERENT case from that something
 *  existing outright), returning `"missing"` | `"symlink"` | `"dir"` |
 *  `"file"`. Rethrows any non-ENOENT lstat failure: an unusual errno here
 *  (EACCES, ELOOP on an ancestor, ...) is not something the remedy logic
 *  below has an opinion about — the caller's own `fail()` reports it via
 *  whatever operation actually hits it next. */
function lstatType(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if (err.code === "ENOENT") return "missing";
    throw err;
  }
  if (st.isSymbolicLink()) return "symlink";
  if (st.isDirectory()) return "dir";
  return "file";
}

function isValidBuiltAt(value) {
  if (value === "unknown") return true;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isValidBuildVersion(value) {
  return value === "unknown" || (typeof value === "string" && VERSION_RE.test(value));
}

function isValidBuildChannel(value) {
  return value === "dev" || value === "release";
}

function isBuildIdentityConsistent(value) {
  return (
    value.channel !== "release" ||
    (value.dirty === false &&
      value.revision !== "unknown" &&
      value.version !== "unknown")
  );
}

function isBuildInfoShape(value) {
  if (typeof value !== "object" || value === null) return false;
  const hasVersion = Object.hasOwn(value, "version");
  const hasChannel = Object.hasOwn(value, "channel");
  return (
    typeof value.revision === "string" &&
    (value.revision === "unknown" || REVISION_RE.test(value.revision)) &&
    typeof value.dirty === "boolean" &&
    typeof value.built_at === "string" &&
    isValidBuiltAt(value.built_at) &&
    hasVersion === hasChannel &&
    (!hasVersion ||
      (isValidBuildVersion(value.version) &&
        isValidBuildChannel(value.channel) &&
        isBuildIdentityConsistent(value)))
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
function readBuildInfoStrict(root, realRoot) {
  const real = checkBuildOutputLeaf(
    root,
    realRoot,
    "dist/build-info.json",
    "dist/build-info.json",
  );
  let raw;
  try {
    raw = readFileSync(real, "utf8");
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

/** Walks every ancestor segment of `relParts` (all but the last) under
 *  `base`, each via its own guarded `lstatType` call, via `onAnomaly(message)`
 *  for anything not an ordinary directory. Stops and returns `false` as
 *  soon as a genuinely MISSING ancestor is found — nothing below an absent
 *  ancestor can exist either, so a deeper check buys nothing once the
 *  shallowest missing segment is found, and stopping there also cannot
 *  misreport a symlink further down as merely "missing". Returns `true`
 *  when every ancestor is confirmed sound (including when there are none
 *  to check).
 *
 *  `onAnomaly` is expected to throw (`fail()` or a subclass); this
 *  function never returns normally after calling it.
 *
 *  A PLAIN FILE ancestor is always anomalous — nothing in this file's
 *  topologies puts a file where a directory belongs. A SYMLINK ancestor's
 *  treatment is NOT the same everywhere, and is the caller's choice via
 *  `resolveSymlinks`:
 *
 *  - `false` — rejected UNCONDITIONALLY, regardless of where it points.
 *    This is `checkBuildOutputLeaf`'s own container invariant: `dist/`
 *    (and any intermediate ancestor of a nested leaf beneath it) is never
 *    a link in any topology this file supports, so a symlink there is
 *    anomalous on sight — confirmed by ふじ's production-path matrix
 *    (issue #259 round 5): "runner container / healthy in-bound symlink"
 *    and "linked package container / healthy in-bound symlink" both
 *    expect `anomaly`, not `ok`.
 *  - `true` — RESOLVED via `realpathSync` and accepted when it stays
 *    inside `realRoot` and resolves to a directory, exactly like the
 *    final workspace link component (`checkWorkspaceLinkedSentinel`)
 *    already treats itself. This is `checkWorkspaceLinkedSentinel`'s own
 *    ancestor invariant: `node_modules` and `node_modules/@kaoiro` CAN
 *    legitimately be a healthy symlink (unlike a build-output container).
 *    A dangling, out-of-bounds, or non-directory resolution is still
 *    rejected.
 *
 *  Discovered via ふじ's own matrix (issue #259 round 5): an earlier
 *  version of this walk rejected ANY symlink ancestor unconditionally —
 *  correct for the build-output container, but it also regressed
 *  "workspace ancestor @kaoiro / healthy in-bound symlink" (expected
 *  `ok`) to exit 78. The two ancestor kinds are not the same invariant,
 *  so a single unconditional policy could not serve both; caught by
 *  running ふじ's own data-driven matrix against this file post-fix,
 *  before re-requesting review (round 5).
 *
 *  WHY THIS IS STILL ONE SHARED WALK, NOT TWO BESPOKE LOOPS. The
 *  identical ancestor-collapse bug (an intermediate component silently
 *  absorbed into a single aggregate `lstat`/ENOENT) surfaced at two
 *  different path depths across two review rounds — `dist/sub` in a
 *  build-output leaf's own path (internal review), and `node_modules` /
 *  `node_modules/@kaoiro` in a workspace link's path (ふじ round 4).
 *  Enumerating a third bespoke loop the next time this shape recurs is
 *  exactly what my-carefully-coding calls "enumerating a class instead of
 *  closing it" — one walk, parameterized by the one policy question that
 *  actually differs between the two call sites. */
function walkAncestors(base, realRoot, relParts, label, onAnomaly, resolveSymlinks) {
  let ancestorPath = base;
  for (let i = 0; i < relParts.length - 1; i++) {
    ancestorPath = join(ancestorPath, relParts[i]);
    let ancestorType;
    try {
      ancestorType = lstatType(ancestorPath);
    } catch (err) {
      onAnomaly(`${label} is unreachable: ${err.message}`);
    }
    if (ancestorType === "file") {
      onAnomaly(
        `${label} is unreachable: its containing directory exists but is not an ordinary directory`,
      );
    }
    if (ancestorType === "symlink") {
      if (!resolveSymlinks) {
        onAnomaly(
          `${label} is unreachable: its containing directory exists but is not an ordinary directory`,
        );
      }
      let ancestorReal;
      try {
        ancestorReal = realpathSync(ancestorPath);
      } catch (err) {
        onAnomaly(`${label} is unreachable: ${err.message}`);
      }
      const ancestorWithin = relative(realRoot, ancestorReal);
      if (
        ancestorWithin === "" ||
        ancestorWithin.startsWith("..") ||
        isAbsolute(ancestorWithin)
      ) {
        onAnomaly(
          `${label} is unreachable: its containing directory resolves outside the release`,
        );
      }
      let ancestorStat;
      try {
        ancestorStat = statSync(ancestorReal);
      } catch (err) {
        onAnomaly(`${label} is unreachable: ${err.message}`);
      }
      if (!ancestorStat.isDirectory()) {
        onAnomaly(
          `${label} is unreachable: its containing directory exists but is not an ordinary directory`,
        );
      }
      continue;
    }
    if (ancestorType === "missing") return false;
  }
  return true;
}

/** Resolves `pkgRoot/leafRel` (a build-output path such as `dist/cli.js` or
 *  `dist/build-info.json`) and rejects anything whose REAL path leaves the
 *  tree — `pkgRoot` is already confirmed to sit inside `realRoot` (the
 *  release root itself, or an already-resolved workspace-link target from
 *  `checkWorkspaceLinkedSentinel`).
 *
 *  A missing leaf is classified as a genuine BUILD SHORTAGE (issue #259)
 *  ONLY when BOTH `leafRel`'s own containing directory (its first path
 *  segment — `dist`) AND the leaf itself are genuinely ABSENT (an ordinary
 *  `pnpm build` creates a missing `dist/` and fills in a missing file,
 *  both from scratch). A symlink (healthy or dangling) or a plain file
 *  standing in for the CONTAINER is rejected outright, unconditionally —
 *  `dist/` is never a link in any topology this file supports, so any
 *  symlink there is anomalous regardless of where it points. A LEAF that
 *  is an EXISTING symlink is treated differently: if it resolves
 *  successfully it falls through to the ordinary containment check below
 *  like any other resolved path (unchanged — a built release CAN
 *  legitimately carry a manifest entry whose containment must be checked
 *  by resolution, not rejected on sight; releaseInstall.test.ts's
 *  pre-existing "outside-the-release symlink" negative control, issue
 *  #229, depends on reaching that exact check). Only a leaf symlink that
 *  does NOT resolve (dangling) is excluded from the build-fixable bucket —
 *  that shape is a broken reference, not "never built", and a build does
 *  not repair it. Measured directly, twice, across two review rounds:
 *  (round 3, the CONTAINER) running the suggested build against a `dist ->
 *  missing-dist` dangling symlink fails with tsc's own ENOENT writing
 *  through it, and does not remove the dangling link; (round 4, the LEAF
 *  itself) running the suggested build against a `dist/cli.js` symlink
 *  pointing OUTSIDE the release (dangling at check time) SUCCEEDS — tsc
 *  writes a new file at the symlink's external target — but the symlink
 *  itself is untouched, so a subsequent verify hits a containment
 *  violation instead of passing. The suggested remedy did not fix the
 *  tree in either case; it just moved the failure (round 4) or repeated
 *  it (round 3).
 *
 *  This is checked with EXPLICIT `lstat` calls on named path segments
 *  (`lstatType`), not by inspecting `realpathSync`'s internal
 *  `err.syscall` — `error.code` is Node's only documented-stable error
 *  identifier; `error.syscall` carries no such contract (Node docs:
 *  https://nodejs.org/api/errors.html#errorcode — "error.code is the most
 *  stable way to identify an error"; `error.syscall` is described only as
 *  "a string describing the syscall that failed", no stability claim). A
 *  syscall-shape guard here missed sibling shapes across THREE review
 *  rounds (a whole ancestor missing, dist-as-symlink, and a dangling leaf
 *  symlink) before being replaced by this explicit, named-component walk.
 *
 *  EVERY named ancestor segment gets its own `lstatType` check, not just
 *  the immediate container (`leafRel`'s first segment) — internal review
 *  found that checking only the first segment missed a dangling symlink at
 *  a DEEPER intermediate component (e.g. `dist/sub` in a hypothetical
 *  `dist/sub/foo.js`, once a package's output ever gains a subdirectory):
 *  `lstat` on the full leaf path FOLLOWS every intermediate component (only
 *  the FINAL one is left unresolved), so a dangling intermediate symlink
 *  makes even a plain `lstatSync` on the leaf fail ENOENT — reporting
 *  "missing", indistinguishable from a genuinely absent path, unless each
 *  ancestor segment is checked in isolation on its OWN terms first. Every
 *  `lstatType` call here is wrapped so an unexpected errno (EACCES on an
 *  ancestor, say) becomes a classified `fail()` rather than an uncaught
 *  exception (internal review, issue #259: `checkWorkspaceLinkedSentinel`
 *  already guarded its own `statSync` for the same reason; the two bare
 *  `lstatType` calls here had been missed).
 *
 *  THE RESOLVED LEAF MUST ALSO BE AN ORDINARY FILE, CHECKED EXPLICITLY
 *  (issue #259, ふじ review round 4). Everything above only proves `real`
 *  resolves and stays inside the tree — a DIRECTORY standing in for
 *  `dist/cli.js` resolves and stays inside just as cleanly, so it passed
 *  silently and the launch shim then spawned `node` on it. Measured
 *  directly: the runner's OWN `dist/cli.js` as a directory passes
 *  verification and crashes at `node`'s own module resolution with a raw,
 *  uncaught `MODULE_NOT_FOUND` stack trace (exit 1, not the classified
 *  exit 78 this file exists to guarantee); a WRAPPER leaf
 *  (`node_modules/@kaoiro/<pkg>/dist/cli.js`) as a directory, or a
 *  symlink to one, passes verification too, and since the wrapper's own
 *  cli.js is only ever spawned later at session time, the launch itself
 *  reports success (exit 0) on a runner that cannot actually start that
 *  engine. A directory is reported with a generic `fail()`, not
 *  `failMissingArtifact` — a directory already occupying the leaf's path
 *  is not "never built"; the same isFile idiom is already used by
 *  `declaredRuntimeAssets` a few functions below, for the identical
 *  reason. */
function checkBuildOutputLeaf(pkgRoot, realRoot, leafRel, label) {
  const segments = leafRel.split("/");
  // resolveSymlinks=false: a build-output container (`dist`, or any
  // intermediate ancestor of a nested leaf beneath it) is never
  // legitimately a symlink in any topology this file supports (see
  // walkAncestors's own doc comment).
  walkAncestors(pkgRoot, realRoot, segments, label, (message) => fail(message), false);
  const target = join(pkgRoot, leafRel);
  // Captured BEFORE resolving: distinguishes "the leaf itself is simply
  // absent" (build-fixable) from "the leaf is an EXISTING symlink whose
  // resolution failed" (a dangling reference, not build-fixable) at the
  // one point that still needs it. A symlink leaf that DOES resolve is NOT
  // rejected here regardless of health — it falls through to the ordinary
  // containment check below like any other resolved path, unchanged from
  // before this guard existed. That matters: releaseInstall.test.ts's own
  // pre-existing containment negative control (issue #229, もも review)
  // stages an in-MANIFEST file replaced by a symlink to an
  // identical-content file OUTSIDE the release specifically to prove the
  // CONTAINMENT check (not a digest mismatch) is what catches it — a leaf
  // symlink is only special-cased here for the one shape that check cannot
  // reach: one whose target does not exist at all.
  let targetType;
  try {
    targetType = lstatType(target);
  } catch (err) {
    fail(`${label} is unreachable: ${err.message}`);
  }
  let real;
  try {
    real = realpathSync(target);
  } catch (err) {
    if (err.code === "ENOENT" && targetType === "missing") {
      failMissingArtifact(`${label} is missing or unresolvable: ${err.message}`);
    }
    fail(`${label} is missing or unresolvable: ${err.message}`);
  }
  const within = relative(realRoot, real);
  if (within === "" || within.startsWith("..") || isAbsolute(within)) {
    fail(`${label} resolves outside the release: ${real}`);
  }
  // See the doc comment above: a directory (or anything else that is not
  // an ordinary file) resolving cleanly inside the tree must still be
  // rejected — containment alone does not prove this is executable
  // build output.
  let realStat;
  try {
    realStat = statSync(real);
  } catch (err) {
    fail(`${label} is unreachable: ${err.message}`);
  }
  if (!realStat.isFile()) {
    fail(`${label} is not an ordinary file: ${real}`);
  }
  return real;
}

/** Resolves a workspace-link-mediated sentinel
 *  (`node_modules/@kaoiro/<pkg>/...`) by checking the LINK component and
 *  the build-output leaf reached through it as two SEPARATE, explicitly
 *  typed questions — rather than inferring both from one opaque
 *  `realpathSync` failure (the class `checkBuildOutputLeaf`'s doc comment
 *  describes).
 *
 *  A MISSING link (`node_modules/@kaoiro/<pkg>` does not exist in any
 *  form) is a pnpm INSTALL shortage — the workspace dependency topology
 *  was never materialized — never a build shortage: `pnpm build` compiles
 *  source reached THROUGH node_modules, it does not create node_modules
 *  itself. Measured directly (ふじ review round 3, issue #259): running the
 *  suggested build against a checkout missing this link fails with tsc's
 *  own TS2307 "cannot find module ...", and node_modules/@kaoiro remains
 *  absent afterward.
 *
 *  A DANGLING link (exists, resolves nowhere) is neither install- nor
 *  build-fixable by a simple command — that class was already closed in
 *  round 2 and is unchanged here.
 *
 *  ANCESTORS OF THE LINK ITSELF GET THE SAME ATTENTION, NOT THE SAME
 *  VERDICT (issue #259, ふじ review round 4 then round 5). `node_modules`
 *  or `node_modules/@kaoiro` can itself be a dangling symlink — not
 *  merely absent — and the ONE `lstat` this function used to run on the
 *  full 3-segment `linkRel` follows every intermediate component, so that
 *  shape collapsed to a bare ENOENT indistinguishable from "install has
 *  not run", and was misclassified as the SAME install shortage an
 *  ordinary missing ancestor is. Measured directly (ふじ round 4): running
 *  the suggested `pnpm install` against that dangling ancestor exits 254
 *  and leaves the symlink untouched, so a subsequent launch hits the
 *  identical exit-78 fault — the remedy did not fix the tree, the same
 *  "moved, not fixed" shape as the leaf findings above. `walkAncestors`
 *  (shared with `checkBuildOutputLeaf`) checks `node_modules` and
 *  `node_modules/@kaoiro` each on their own terms first, called here with
 *  `resolveSymlinks=true` (its OWN policy, NOT `checkBuildOutputLeaf`'s
 *  container one — see `walkAncestors`'s doc comment): a symlink ancestor
 *  is RESOLVED and accepted when it stays inside the release and points
 *  at an ordinary directory — unlike a build-output container such as
 *  `dist`, `node_modules`/`node_modules/@kaoiro` CAN legitimately be a
 *  healthy symlink, and an earlier version of this ancestor check
 *  rejected ANY symlink unconditionally (mirroring the container's own
 *  policy), which regressed exactly that legitimate shape — caught by
 *  ふじ's production-path matrix (round 5). A DANGLING, out-of-bounds, or
 *  non-directory ancestor resolution is still reported generically (no
 *  remedy suggested — installing will not repair it), while a genuinely
 *  ABSENT ancestor still means the ordinary "install has not run" case
 *  and keeps suggesting `pnpm install`, unchanged.
 *
 *  Only once the link itself resolves cleanly and stays inside the
 *  boundary does a missing leaf beneath it become a genuine build
 *  shortage (delegated to `checkBuildOutputLeaf`). This gracefully covers
 *  the BUILT-RELEASE profile too, where `node_modules/@kaoiro/<pkg>` is a
 *  real vendored directory rather than a link: `lstatType` reports
 *  `"dir"`, not `"missing"`, so the install-shortage branch never fires
 *  there, and `realpathSync` on an ordinary directory trivially succeeds. */
function checkWorkspaceLinkedSentinel(root, realRoot, rel) {
  const parts = rel.split("/"); // ["node_modules", "@kaoiro", pkg, ...rest]
  const linkParts = parts.slice(0, 3); // ["node_modules", "@kaoiro", pkg]
  const linkRel = linkParts.join("/");
  const leafRel = parts.slice(3).join("/");
  const linkPath = join(root, linkRel);
  // resolveSymlinks=true: unlike a build-output container, node_modules
  // and node_modules/@kaoiro CAN legitimately be a healthy symlink (see
  // walkAncestors's own doc comment — ふじ's matrix, issue #259 round 5).
  const ancestorsPresent = walkAncestors(
    root,
    realRoot,
    linkParts,
    linkRel,
    (message) => fail(message),
    true,
  );
  if (!ancestorsPresent) {
    failMissingWorkspaceLink(
      `${linkRel} is missing — the workspace dependency link was never created (pnpm install has not run)`,
    );
  }
  // Guarded like every other lstatType call in this file (internal review,
  // issue #259): an unexpected errno here (EACCES, say) must become a
  // classified fail(), not an uncaught exception.
  let linkPathType;
  try {
    linkPathType = lstatType(linkPath);
  } catch (err) {
    fail(`${linkRel} is unreachable: ${err.message}`);
  }
  if (linkPathType === "missing") {
    failMissingWorkspaceLink(
      `${linkRel} is missing — the workspace dependency link was never created (pnpm install has not run)`,
    );
  }
  let linkReal;
  try {
    linkReal = realpathSync(linkPath);
  } catch (err) {
    fail(`${linkRel} is a broken symlink: ${err.message}`);
  }
  const linkWithin = relative(realRoot, linkReal);
  if (linkWithin === "" || linkWithin.startsWith("..") || isAbsolute(linkWithin)) {
    fail(`${linkRel} resolves outside the release: ${linkReal}`);
  }
  // The link must resolve to a DIRECTORY (a package), or checkBuildOutputLeaf
  // below would itself throw an uncaught ENOTDIR trying to lstat a path
  // INSIDE what turns out to be a file (internal review round, issue #259:
  // measured live — a plain-file `node_modules/@kaoiro/<pkg>` crashed the
  // process with a raw Node stack trace instead of a classified VerifyError).
  // Checked on `linkReal`, the already-resolved REAL path, so this also
  // catches a symlink pointing AT a plain file, not only a direct one.
  //
  // try/catch here too (advisory, internal review round 2): every OTHER fs
  // call in this function already fails() rather than throwing raw, and
  // leaving this one bare would reopen the exact uncaught-exception class
  // the guard above exists to close — linkReal could vanish or become
  // unreadable between the realpathSync() above and this statSync() (an
  // install/switch racing a launch, say).
  let linkStat;
  try {
    linkStat = statSync(linkReal);
  } catch (err) {
    fail(`${linkRel} is unreadable: ${err.message}`);
  }
  if (!linkStat.isDirectory()) {
    fail(`${linkRel} is not a directory: ${linkReal}`);
  }
  return checkBuildOutputLeaf(linkReal, realRoot, leafRel, rel);
}

/** Resolves `rel` inside `root` and rejects anything whose REAL path leaves
 *  the tree. `-f` in shell follows symlinks, so an artifact check alone
 *  cannot tell a file in the release from a link pointing at one somewhere
 *  else entirely. pnpm's own links (node_modules/@kaoiro/<pkg> ->
 *  ../.pnpm/...) stay inside and pass.
 *
 *  Dispatches to `checkWorkspaceLinkedSentinel` for a path reached through
 *  a workspace link, or `checkBuildOutputLeaf` for the runner's own
 *  output — the two need different remedy classification (see their own
 *  doc comments). An arbitrary MANIFEST.json entry that happens to start
 *  with `node_modules/@kaoiro/` (a built release vendors these as real
 *  directories, never links) still dispatches to
 *  `checkWorkspaceLinkedSentinel` safely: it degrades to an ordinary
 *  containment + build-output check, as that function's own doc comment
 *  states. */
function containedRealPath(root, realRoot, rel) {
  if (rel.startsWith("node_modules/@kaoiro/")) {
    return checkWorkspaceLinkedSentinel(root, realRoot, rel);
  }
  return checkBuildOutputLeaf(root, realRoot, rel, rel);
}

function containedRuntimePath(realRoot, path, label) {
  let real;
  try {
    real = realpathSync(path);
  } catch (err) {
    fail(`${label} is not resolvable: ${err.message}`);
  }
  const within = relative(realRoot, real);
  if (within === "" || within.startsWith("..") || isAbsolute(within)) {
    fail(`${label} resolves outside the release: ${real}`);
  }
  let stats;
  try {
    stats = statSync(real);
  } catch (err) {
    fail(`${label} is unreadable: ${err.message}`);
  }
  if (!stats.isFile()) fail(`${label} is not an ordinary file: ${real}`);
  return real;
}

function packageManifestFromRuntime(runtimeRequire, name) {
  const paths = runtimeRequire.resolve.paths(name) ?? [];
  for (const dir of paths) {
    const candidate = join(dir, name, "package.json");
    try {
      if (statSync(candidate).isFile()) return candidate;
      fail(`${name}'s package.json is not an ordinary file: ${candidate}`);
    } catch (err) {
      if (err.code === "ENOENT") continue;
      fail(`${name}'s package.json is unreadable: ${err.message}`);
    }
  }
  fail(`${name} is not resolvable from @kaoiro/codex`);
}

function esmImportEntry(manifestPath, name) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    fail(`${name}'s package.json is unreadable or malformed: ${err.message}`);
  }
  const entry = pkg.exports?.["."]?.import;
  if (typeof entry !== "string" || !entry.startsWith("./")) {
    fail(`${name} has no relative ESM import entry`);
  }
  return join(dirname(manifestPath), entry);
}

function codexRuntimeFiles(root, realRoot) {
  const wrapperCli = containedRealPath(
    root,
    realRoot,
    "node_modules/@kaoiro/codex/dist/cli.js",
  );
  const runtimeRequire = createRequire(wrapperCli);
  const wrapperPackagePath = join(dirname(dirname(wrapperCli)), "package.json");
  let wrapperPackage;
  try {
    wrapperPackage = JSON.parse(readFileSync(wrapperPackagePath, "utf8"));
  } catch (err) {
    fail(`@kaoiro/codex package.json is unreadable or malformed: ${err.message}`);
  }
  const expectedVersion = wrapperPackage.dependencies?.["@openai/codex"];
  if (typeof expectedVersion !== "string" || !EXACT_SEMVER_RE.test(expectedVersion)) {
    fail("@kaoiro/codex must declare an exact @openai/codex version");
  }
  let codexPackagePath;
  try {
    codexPackagePath = runtimeRequire.resolve("@openai/codex/package.json");
  } catch (err) {
    fail(`@openai/codex is not resolvable from @kaoiro/codex: ${err.message}`);
  }
  const codexPackage = containedRuntimePath(
    realRoot,
    codexPackagePath,
    "@openai/codex/package.json",
  );
  let installedCodex;
  try {
    installedCodex = JSON.parse(readFileSync(codexPackage, "utf8"));
  } catch (err) {
    fail(`@openai/codex package.json is unreadable or malformed: ${err.message}`);
  }
  if (installedCodex.version !== expectedVersion) {
    fail(
      `@openai/codex version ${String(installedCodex.version)} does not match @kaoiro/codex exact dependency ${expectedVersion}`,
    );
  }
  const sdkPackage = packageManifestFromRuntime(runtimeRequire, "@openai/codex-sdk");
  const sdkEntry = containedRuntimePath(
    realRoot,
    esmImportEntry(sdkPackage, "@openai/codex-sdk"),
    "@openai/codex-sdk import entry",
  );
  return [codexPackage, sdkEntry];
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
const ENTRY_PACKAGES = [
  "@kaoiro/claude-code",
  "@kaoiro/codex",
  "@kaoiro/antigravity",
];

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

  const info = readBuildInfoStrict(root, realRoot);
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
    const runtimeFiles = codexRuntimeFiles(root, boundary);
    return {
      identity,
      checked: SENTINELS.length + runtimeFiles.length,
      manifest: false,
    };
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

  for (const runtimeFile of codexRuntimeFiles(root, realRoot)) {
    if (!listed.has(runtimeFile)) {
      fail(
        `MANIFEST.json omits ${relative(realRoot, runtimeFile)}, which @kaoiro/codex resolves at runtime`,
      );
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
      // issue #259: exit 71/72 mark the two remediable shortages
      // specifically so a caller (kaoiro-runner-launch.sh) can tell them
      // apart from every other verification failure and from EACH OTHER —
      // "run the build" and "run pnpm install" are different commands, and
      // suggesting the wrong one is the same mistake this mechanism exists
      // to prevent. Every other caller (install / switch,
      // kaoiro-runner-common.sh's kaoiro_verify_release_tree) only ever
      // checked zero-vs-nonzero, so this is additive, not a breaking change
      // to the exit-code contract.
      // 70 = EX_SOFTWARE (generic verification failure, no specific remedy
      // suggested); 71 = build shortage (MissingArtifactError); 72 =
      // workspace-install shortage (MissingWorkspaceLinkError).
      process.exit(
        err instanceof MissingArtifactError
          ? 71
          : err instanceof MissingWorkspaceLinkError
            ? 72
            : 70,
      );
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
