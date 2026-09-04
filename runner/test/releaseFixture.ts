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
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
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
 *  build-info.json, print the canonical project identity, exit 0). The
 *  real cli.ts behaviour is pinned separately by args.test.ts /
 *  build_info.test.ts.
 *
 *  ESM, LIKE THE RELEASE IT STANDS IN FOR. Every first-party package ships
 *  `"type": "module"` and every dist file is an ES module (measured on the
 *  real tarball, 2026-08-16), and the closure walk reads the STATIC import
 *  graph — so a CommonJS stub would have measured a shape the release does
 *  not have, and after the runtime-edge inference was removed it would have
 *  had no dependency edges at all. */
const STUB_CLI = `
import { readFileSync } from "node:fs";
import { join } from "node:path";
// A REAL module dependency, not decoration. The previous stub imported
// nothing, so removing a module from the tree left it running perfectly and
// the "one missing module is caught before exec" property could not be
// measured at all (issue #229 round 2, ふじ 差し戻し must-fix 3). Importing a
// sibling makes the negative control possible: delete dist/stub_dep.js and
// this exits non-zero on its own.
import dep from "./stub_dep.js";
if (process.argv.includes("--version")) {
  // VERSION_OVERRIDE lets a test make the RUNNING artifact disagree with the
  // tree it sits in. Overriding VERSION or build-info.json cannot do that any
  // more: install now rejects a tree whose two identities disagree, which is
  // the point — the disagreement is caught before the service is stopped.
  const override = "@@VERSION_OVERRIDE@@";
  const info = JSON.parse(
    readFileSync(join(import.meta.dirname, "build-info.json"), "utf8"),
  );
  const revision = typeof info.revision === "string" ? info.revision : "unknown";
  const version = typeof info.version === "string" ? info.version : "unknown";
  const channel = info.channel === "release" ? "release" : "dev";
  const shortHash = revision === "unknown" ? "unknown" : revision.slice(0, 7);
  process.stdout.write(
    (override || \`kaoiro \${channel} runner v\${version} / \${shortHash}\`) +
      "\\n",
  );
  process.exit(0);
}
process.stdout.write("stub cli.js started " + dep.marker + "\\n");
process.exit(0);
`;

const STUB_DEP = 'export default { marker: "dep-loaded" };\n';

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
  buildVersion?: string;
  dirty?: boolean;
  channel?: "dev" | "release";
  /** Makes the stub cli's `--version` report this instead of the tree's own
   *  identity — the only way left to stage a running artifact that disagrees
   *  with its release directory. */
  cliVersionOverride?: string;
  /** Skip MANIFEST.json generation — for the "release built by an older
   *  installer" / dev-checkout cases. */
  manifest?: false;
  /** Tree-relative paths to delete from the GENERATED manifest, leaving it
   *  internally consistent but describing less than the release needs. Pair
   *  with `omit` to stage the tampering もも measured: a module and its own
   *  entry removed together passed --require-manifest --hash at exit 0,
   *  because a manifest cannot witness a claim that was made smaller. */
  dropManifestEntries?: string[];
  /** Unix seconds to stamp on the archive's top-level directory. tar
   *  preserves it, so this is how a test produces a release whose tree
   *  carries a BUILD time rather than an install time. */
  treeMtime?: number;
  /** Text prepended to dist/cli.js, before the manifest is generated. Lets a
   *  test stage the exact SOURCE SHAPE a scanner defect turned on — a
   *  specifier sharing its line with a division, say — instead of asserting
   *  about the shape from outside. */
  cliPrelude?: string;
  /** Extra tree-relative files, written last but still before the manifest is
   *  generated, so the builder lists them like any other AND a test can
   *  OVERRIDE a standard-tree file. Pairs with `cliPrelude` when the staged
   *  shape needs a dependency the standard tree has no reason to carry;
   *  `omit` + `dropManifestEntries` then remove it again for the negative
   *  control, on the SAME tree that carries the shape. */
  extraFiles?: Record<string, string>;
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
  // The release root IS a package, and `"type": "module"` is what makes its
  // dist/*.js files ES modules — for node at run time and for the verifier's
  // parse alike. The real tarball ships exactly this (measured 2026-08-16).
  put(
    "package.json",
    JSON.stringify({ name: "@kaoiro/runner", version: "0.0.0", type: "module" }),
  );
  put(
    "dist/cli.js",
    (options.cliPrelude ?? "") +
      STUB_CLI.replace("@@VERSION_OVERRIDE@@", options.cliVersionOverride ?? ""),
  );
  put("dist/stub_dep.js", STUB_DEP);
  put(
    "dist/build-info.json",
    JSON.stringify({
      revision,
      dirty,
      built_at: "2026-08-16T00:00:00.000Z",
      version: options.buildVersion ?? "2026.9.0",
      channel: options.channel ?? "dev",
    }),
  );
  // The wrappers are real PACKAGES here, not two lone files, and a shared
  // first-party package sits behind both — the shape @kaoiro/wrapper-core and
  // @kaoiro/agent-common have in a real release. That transitive layer is
  // what the manifest generator's hand-written list of three dist directories
  // used to miss entirely: removing a file from it verified clean and then
  // failed at import, on a real tarball (issue #229, 2026-08-16). A fixture
  // with no dependency edges could not measure the difference.
  for (const wrapper of ["claude-code", "codex", "antigravity"]) {
    // The codex wrapper locates its bridge through `new URL(...,
    // import.meta.url)` — a real runtime module edge no import statement
    // expresses. The closure walk missed it entirely until もも removed
    // bridge.js with its manifest entry and strict verify still exited 0.
    // Reading it out of the call's TEXT was tried and withdrawn (a regex
    // cannot tell the global `URL` from a module-local one), so the package
    // DECLARES it and the verifier enforces the declaration.
    // claude-code and codex each carry one asset this way, because the real
    // ones do: codex composes ../dist/bridge.js with `new URL`, claude-code
    // resolves ./probe.js through createRequire. antigravity's adapter body
    // (ADR-0057 F5/A6/A8) carries TWO the same way — host.ts resolves both
    // ../dist/bridge.js (the CLI tool bridge) and ../dist/hook.js (the
    // PreToolUse gate) via `new URL`, plus dist/build-info.json (declared,
    // not `new URL`-resolved, like codex/claude-code's own build-info.json
    // — ADR-0053). A fixture that modelled only one of the two `new URL`
    // sites would let the other's deletion survive review, the same class
    // of gap that missed probe.js in round 2.
    const asset: string[] =
      wrapper === "codex"
        ? ["dist/bridge.js"]
        : wrapper === "claude-code"
          ? ["dist/probe.js"]
          : ["dist/bridge.js", "dist/hook.js", "dist/build-info.json"];
    const runtime = { kaoiro: { runtimeAssets: asset } };
    put(
      `node_modules/@kaoiro/${wrapper}/package.json`,
      JSON.stringify({
        name: `@kaoiro/${wrapper}`,
        version: "0.0.0",
        type: "module",
        dependencies: { "@kaoiro/wrapper-core": "workspace:*" },
        ...runtime,
      }),
    );
    // A REAL cross-package import edge. verify-release.mjs derives the
    // expected closure by following the specifiers written inside each
    // module, so a wrapper stub that imported nothing would leave that walk
    // with nothing to walk (issue #229, もも review must-fix 2).
    // The `new URL` lines below stay because the REAL wrappers have them:
    // they are what proves the verifier no longer reads edges out of call
    // text.
    const bridgeEdge =
      wrapper === "codex"
        ? 'const b = new URL("../dist/bridge.js", import.meta.url);\n'
        : wrapper === "antigravity"
          ? 'const b = new URL("../dist/bridge.js", import.meta.url);\n' +
            'const h = new URL("../dist/hook.js", import.meta.url);\n'
          : "";
    put(
      `node_modules/@kaoiro/${wrapper}/dist/cli.js`,
      `import "@kaoiro/wrapper-core";\n${bridgeEdge}`,
    );
  }
  put("node_modules/@kaoiro/codex/dist/bridge.js", "// stub bridge\n");
  put("node_modules/@kaoiro/claude-code/dist/probe.js", "// stub probe\n");
  put("node_modules/@kaoiro/antigravity/dist/bridge.js", "// stub bridge\n");
  put("node_modules/@kaoiro/antigravity/dist/hook.js", "// stub hook\n");
  put(
    "node_modules/@kaoiro/antigravity/dist/build-info.json",
    JSON.stringify({
      revision,
      dirty,
      built_at: "2026-08-16T00:00:00.000Z",
      version: options.buildVersion ?? "2026.9.0",
      channel: options.channel ?? "dev",
    }),
  );
  put(
    "node_modules/@kaoiro/wrapper-core/package.json",
    JSON.stringify({
      name: "@kaoiro/wrapper-core",
      version: "0.0.0",
      type: "module",
      main: "dist/index.js",
    }),
  );
  put(
    "node_modules/@kaoiro/wrapper-core/dist/index.js",
    "// stub shared wrapper package\n",
  );

  // LAST, so a test can override a standard-tree file and not merely add one.
  for (const [rel, content] of Object.entries(options.extraFiles ?? {})) {
    put(rel, content);
  }

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

  const dropped = options.dropManifestEntries ?? [];
  if (dropped.length > 0) {
    const path = join(tree, "MANIFEST.json");
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      files: Record<string, string>;
    };
    for (const rel of dropped) delete parsed.files[rel];
    writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
  }

  // recursive: true lets `omit` name a whole package directory (SF-2
  // negative control: a package ENTRY_PACKAGES/the manifest expects, wholly
  // missing from the tarball) as well as a single file — a plain file omit
  // is unaffected by the flag.
  for (const rel of omit) {
    rmSync(join(tree, rel), { force: true, recursive: true });
  }
  return tree;
}

/** Writes a checkout shaped like the REAL pnpm workspace this repo builds
 *  from (issue #259) — not the built-release shape `writeReleaseTree` alone
 *  produces. The runner tree lands at `<ws>/runner`; the wrapper packages
 *  are SIBLING workspace members at `<ws>/wrapper/<name>`; and
 *  `<ws>/runner/node_modules/@kaoiro/<name>` reaches them through the same
 *  RELATIVE link pnpm itself writes (`../../../wrapper/<name>`, leaving
 *  runner/ entirely) — never as real directories inside the release root,
 *  which is what only a BUILT release looks like.
 *
 *  `repoDirectWorkspace.test.ts`'s own premise tests pin this
 *  `../../../wrapper/<name>` target, and the nearest `pnpm-workspace.yaml`
 *  landing at the workspace root, against the real checkout — so a fixture
 *  that drifts from what pnpm actually writes fails there, not silently.
 *
 *  Always repo-direct: VERSION is forced absent and the manifest is never
 *  generated, regardless of `options` — only the builder writes either, and
 *  a real checkout never carries this link topology together with them.
 *
 *  Returns the runner tree path (the release root). */
export function writeWorkspaceCheckout(
  ws: string,
  revision: string,
  options: ReleaseTreeOptions = {},
): string {
  const runner = join(ws, "runner");
  writeReleaseTree(runner, revision, {
    ...options,
    manifest: false,
    omit: [...(options.omit ?? []), "VERSION"],
  });
  writeFileSync(
    join(ws, "pnpm-workspace.yaml"),
    "packages:\n  - runner\n  - wrapper/claude-code\n  - wrapper/codex\n" +
      "  - wrapper/antigravity\n",
  );
  for (const wrapper of ["claude-code", "codex", "antigravity"]) {
    const link = join(runner, "node_modules", "@kaoiro", wrapper);
    const member = join(ws, "wrapper", wrapper);
    mkdirSync(dirname(member), { recursive: true });
    renameSync(link, member);
    symlinkSync(`../../../wrapper/${wrapper}`, link);
  }
  return runner;
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
