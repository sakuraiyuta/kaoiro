// Shared fixtures for the release install / switch / update tests (issue
// #229). Not a test file itself — vitest only collects `test/**/*.test.ts`.
//
// Every fixture ships the REAL deploy/*.sh bytes, copied verbatim rather
// than reimplemented, so the tests exercise the scripts an operator runs.
// Only `dist/cli.js` and the two wrapper entry points are stubs: building
// the real ones needs a full `pnpm -C wrapper build && pnpm -C runner
// build`, which this suite does not depend on.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const deploySrc = fileURLToPath(new URL("../deploy", import.meta.url));

/** The scripts a release carries. kaoiro-runner-setup.sh and the service
 *  definitions are irrelevant to these tests and left out deliberately — a
 *  release that lacks them is still startable, so including them would blur
 *  what the artifact checks actually require. */
const DEPLOY_SCRIPTS = [
  "verify-release.mjs",
  "kaoiro-runner-common.sh",
  "kaoiro-runner-launch.sh",
  "kaoiro-runner-install.sh",
  "kaoiro-runner-switch.sh",
  "kaoiro-runner-update.sh",
];

/** Mimics ONLY the `--version` contract cli.ts implements (read the sibling
 *  build-info.json, print the canonical `<rev>[-dirty]` form, exit 0). The
 *  real cli.ts behaviour is pinned separately by args.test.ts /
 *  build_info.test.ts. */
const STUB_CLI = `
const fs = require("node:fs");
const path = require("node:path");
// A REAL module dependency, not decoration. The previous stub imported
// nothing, so removing a module from the tree left it running perfectly and
// the "one missing module is caught before exec" property could not be
// measured at all (issue #229 round 2, ふじ 差し戻し must-fix 3). Requiring a
// sibling makes the negative control possible: delete dist/stub_dep.js and
// this exits non-zero on its own.
const dep = require("./stub_dep.js");
if (process.argv.includes("--version")) {
  // VERSION_OVERRIDE lets a test make the RUNNING artifact disagree with the
  // tree it sits in. Overriding VERSION or build-info.json cannot do that any
  // more: install now rejects a tree whose two identities disagree, which is
  // the point — the disagreement is caught before the service is stopped.
  const override = "@@VERSION_OVERRIDE@@";
  const info = JSON.parse(
    fs.readFileSync(path.join(__dirname, "build-info.json"), "utf8"),
  );
  process.stdout.write(
    (override || (info.dirty ? \`\${info.revision}-dirty\` : info.revision)) +
      "\\n",
  );
  process.exit(0);
}
process.stdout.write("stub cli.js started " + dep.marker + "\\n");
process.exit(0);
`;

const STUB_DEP = 'module.exports = { marker: "dep-loaded" };\n';

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a deploy script and returns its outcome, for success and failure
 *  alike. `env` is merged over the current environment; a value of
 *  `undefined` removes the variable, which is how a test can prove a script
 *  does not silently fall back to an inherited setting. */
export function runScript(
  script: string,
  args: string[],
  env: Record<string, string | undefined> = {},
): RunResult {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...env })) {
    if (value !== undefined) merged[key] = value;
  }
  const result = spawnSync(script, args, { encoding: "utf8", env: merged });
  if (result.error !== undefined) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** A 40-hex revision built from a short seed, so tests can name releases
 *  readably while staying inside the id value domain ADR-0053 defines. */
export function revisionOf(seed: string): string {
  return createHash("sha1").update(seed).digest("hex");
}

export interface ReleaseTreeOptions {
  /** Tree-relative paths to leave out, for the incomplete-release cases. */
  omit?: string[];
  /** Overrides the VERSION file's content — used for the id value-domain
   *  cases, where VERSION must NOT match the revision. */
  version?: string;
  dirty?: boolean;
  /** Makes the stub cli's `--version` report this instead of the tree's own
   *  identity — the only way left to stage a running artifact that disagrees
   *  with its release directory. */
  cliVersionOverride?: string;
  /** Skip MANIFEST.json generation — for the "release built by an older
   *  installer" / dev-checkout cases. */
  manifest?: false;
  /** Unix seconds to stamp on the archive's top-level directory. tar
   *  preserves it, so this is how a test produces a release whose tree
   *  carries a BUILD time rather than an install time. */
  treeMtime?: number;
}

/** Writes a complete, startable release tree at `tree` and returns it. */
export function writeReleaseTree(
  tree: string,
  revision: string,
  options: ReleaseTreeOptions = {},
): string {
  const omit = new Set(options.omit ?? []);
  const dirty = options.dirty ?? false;

  const put = (rel: string, content: string): void => {
    const path = join(tree, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };

  // The COMPLETE tree is written first, and `omit` is applied at the very
  // end. That ordering is what makes an omission test meaningful: the
  // manifest still LISTS the file that was removed, which is exactly the
  // state a truncated extraction or a half-deleted release is in. Generating
  // the manifest after the removal would produce a self-consistent tree that
  // no check could object to.
  put("VERSION", `${options.version ?? (dirty ? `${revision}-dirty` : revision)}\n`);
  put(
    "dist/cli.js",
    STUB_CLI.replace("@@VERSION_OVERRIDE@@", options.cliVersionOverride ?? ""),
  );
  put("dist/stub_dep.js", STUB_DEP);
  put(
    "dist/build-info.json",
    JSON.stringify({
      revision,
      dirty,
      built_at: "2026-08-16T00:00:00.000Z",
    }),
  );
  put("node_modules/@kaoiro/claude-code/dist/cli.js", "// stub wrapper\n");
  put("node_modules/@kaoiro/codex/dist/cli.js", "// stub wrapper\n");

  mkdirSync(join(tree, "deploy"), { recursive: true });
  for (const script of DEPLOY_SCRIPTS) {
    const dest = join(tree, "deploy", script);
    copyFileSync(join(deploySrc, script), dest);
    chmodSync(dest, script === "kaoiro-runner-common.sh" ? 0o644 : 0o755);
  }

  // Built by the REAL generator the builder runs, so the fixture cannot
  // drift into describing a manifest format nothing produces.
  if (options.manifest !== false) {
    execFileSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../scripts/build-release-manifest.mjs", import.meta.url),
        ),
        tree,
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
  }

  for (const rel of omit) rmSync(join(tree, rel), { force: true });
  return tree;
}

/** Builds `<dir>/kaoiro-runner-<id>-linux-x64.tar.gz` the way
 *  scripts/build-runner-tarball.sh does: one top-level directory holding the
 *  whole tree. Returns the archive path.
 *
 *  The archive name comes from the REVISION, never from `options.version`.
 *  The install script must take the id from the VERSION file rather than
 *  from the archive name, so the two have to be able to disagree here. */
export function makeReleaseTarball(
  dir: string,
  revision: string,
  options: ReleaseTreeOptions = {},
): string {
  const id = options.dirty === true ? `${revision}-dirty` : revision;
  const name = `kaoiro-runner-${id}-linux-x64`;
  const stage = join(dir, "stage");
  mkdirSync(stage, { recursive: true });
  writeReleaseTree(join(stage, name), revision, options);
  if (options.treeMtime !== undefined) {
    utimesSync(join(stage, name), options.treeMtime, options.treeMtime);
  }
  const archive = join(dir, `${name}.tar.gz`);
  execFileSync("tar", ["czf", archive, "-C", stage, name]);
  return archive;
}

/** Content digest of a whole tree: every regular file's path plus its bytes,
 *  and every symlink's path plus its target. Used to assert that a live
 *  release is byte-identical before and after an install — the "nothing in
 *  the live dist changed" acceptance criterion, which a mtime or a
 *  directory listing would not actually establish. */
export function treeDigest(root: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const path = join(dir, entry.name);
      const rel = relative(root, path);
      if (entry.isDirectory()) {
        hash.update(`d ${rel}\n`);
        walk(path);
      } else if (entry.isSymbolicLink()) {
        hash.update(`l ${rel} -> ${readlinkSync(path)}\n`);
      } else {
        hash.update(`f ${rel} ${statSync(path).mode}\n`);
        hash.update(readFileSync(path));
      }
    }
  };
  walk(root);
  return hash.digest("hex");
}
