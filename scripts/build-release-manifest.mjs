#!/usr/bin/env node
// Writes MANIFEST.json for a staged release tree (issue #229 round 2, ふじ
// 差し戻し must-fix 3).
//
//   node scripts/build-release-manifest.mjs <release-root>
//
// The manifest is the runtime module closure, so a release missing ONE
// module is rejected before it starts. The hand-written sentinel list it
// replaces could not do that: deleting dist/args.js from a real dist passed
// every sentinel, then failed at import with node's exit 1 — which
// RestartPreventExitStatus=78 does not match, so the unit restart-looped on
// a fault no restart can fix (reproduced 2026-08-16).
//
// SCOPE IS THE FIRST-PARTY JS: the runner's own dist/, plus the dist/ of
// every @kaoiro package reachable from the two wrappers it spawns.
// Deliberately NOT the engine CLI payloads, which are ~920 MB of the archive
// — they are not resolved through the module graph the launch shim protects,
// and hashing them would make install-time verification cost minutes for no
// added coverage. That residual is stated in runner/deploy/verify-release.mjs
// too, where the checking happens.
import { createHash } from "node:crypto";
import {
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";

/** The wrapper packages the runner resolves from disk at spawn time. Their
 *  first-party dependencies are FOLLOWED from here, never listed: the
 *  hand-written list this replaced named three dist directories and missed
 *  @kaoiro/wrapper-core and @kaoiro/agent-common, which both wrappers import
 *  at runtime. Deleting one file from either passed the manifest check and
 *  then failed at import with node's exit 1 — the same restart loop as the
 *  sentinel list before it (measured on a real tarball, 2026-08-16). The
 *  defect this manifest exists to close IS enumeration; a shorter enumeration
 *  is not a fix for it. */
const ENTRY_PACKAGES = ["@kaoiro/claude-code", "@kaoiro/codex"];

const CODE_FILE_RE = /\.(js|mjs|cjs|json)$/;

function collect(root, dir, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    // withFileTypes reports link-ness, not the target's type, so a symlinked
    // subdirectory is skipped rather than followed. A manifest that chased
    // arbitrary links would record paths outside the release it describes —
    // the same confusion between "in the tree" and "reachable from the tree"
    // that let an archive install itself as a link out of the install root.
    if (entry.isDirectory()) collect(root, path, files);
    else if (entry.isFile() && CODE_FILE_RE.test(entry.name)) {
      const rel = relative(root, path).split(sep).join("/");
      files[rel] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  }
}

/** Release-relative dist/ directories of every first-party package reachable
 *  from ENTRY_PACKAGES through @kaoiro/* dependency declarations.
 *
 *  Each package is recorded under the path its DEPENDENT resolves it by, so
 *  the two entry points stay listed as node_modules/@kaoiro/<pkg>/dist —
 *  which is the path the runner's own require.resolve() goes through, and so
 *  the link that has to be intact as well. Dependencies are resolved from a
 *  package's REAL location because node walks up from there, and pnpm keeps a
 *  package's dependencies beside it under .pnpm/ rather than in the
 *  node_modules/@kaoiro/ link farm; going through the link instead reports
 *  MODULE_NOT_FOUND for a package that is present (measured 2026-08-16).
 *  Deduplication is by real path, so the diamond — both wrappers depend on
 *  both shared packages — contributes one copy of each.
 *
 *  A declared @kaoiro dependency that will not resolve THROWS: an incomplete
 *  deploy tree has to fail the build, not silently narrow the manifest. */
function firstPartyDists(root) {
  const dists = [];
  const seen = new Set();
  const visit = (pkgDir) => {
    const real = realpathSync(pkgDir);
    if (seen.has(real)) return;
    seen.add(real);
    dists.push(relative(root, join(pkgDir, "dist")).split(sep).join("/"));
    const manifestPath = join(real, "package.json");
    const pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
    const dependent = createRequire(manifestPath);
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (!dep.startsWith("@kaoiro/")) continue;
      visit(dirname(dependent.resolve(`${dep}/package.json`)));
    }
  };
  for (const name of ENTRY_PACKAGES) visit(join(root, "node_modules", name));
  return dists;
}

function main(argv) {
  const root = argv[0];
  if (root === undefined || argv.length > 1) {
    process.stderr.write(
      "usage: build-release-manifest.mjs <release-root>\n",
    );
    process.exit(64); // EX_USAGE
  }
  const files = {};
  for (const rel of ["dist", ...firstPartyDists(root)]) {
    const dir = join(root, rel);
    // The wrapper roots are pnpm links; statSync follows them on purpose.
    // A missing one is a broken deploy tree, not an empty section.
    if (!statSync(dir).isDirectory()) {
      process.stderr.write(`build-release-manifest: not a directory: ${dir}\n`);
      process.exit(70); // EX_SOFTWARE
    }
    collect(root, dir, files);
  }
  const count = Object.keys(files).length;
  if (count === 0) {
    process.stderr.write("build-release-manifest: manifest would be empty\n");
    process.exit(70);
  }
  writeFileSync(
    join(root, "MANIFEST.json"),
    `${JSON.stringify({ files }, null, 2)}\n`,
  );
  process.stderr.write(`build-release-manifest: ${count} files\n`);
}

main(process.argv.slice(2));
