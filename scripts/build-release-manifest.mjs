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
// SCOPE IS THE JS THE RUNNER IMPORTS: its own dist/ and the two wrapper
// dist/ trees. Deliberately NOT the engine CLI payloads, which are ~920 MB
// of the archive — they are not resolved through the module graph the launch
// shim protects, and hashing them would make install-time verification cost
// minutes for no added coverage. That residual is stated in
// runner/deploy/verify-release.mjs too, where the checking happens.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const MODULE_ROOTS = [
  "dist",
  "node_modules/@kaoiro/claude-code/dist",
  "node_modules/@kaoiro/codex/dist",
];

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

function main(argv) {
  const root = argv[0];
  if (root === undefined || argv.length > 1) {
    process.stderr.write(
      "usage: build-release-manifest.mjs <release-root>\n",
    );
    process.exit(64); // EX_USAGE
  }
  const files = {};
  for (const rel of MODULE_ROOTS) {
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
