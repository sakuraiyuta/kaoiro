// runner/deploy/kaoiro-runner-launch.sh (issue #229): the shim verifies, it
// never builds.
//
// "It does not build" is not observable from a passing start, so it is
// measured rather than asserted from the source: the shim runs with recorder
// stubs for the build tools ahead of them on PATH, and the test fails if any
// of them was invoked. That also covers the rejected `ExecStartPre=pnpm
// build` design — if someone reintroduces a build step here, this goes red.
//
// The artifact set is checked one omission at a time. A single "complete
// tree starts / empty tree fails" pair would pass just as happily with only
// dist/cli.js checked, which is the state this issue set out to fix: a tree
// with a runner build and a stale wrapper build starts, then fails much
// later on the first agent spawn.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { revisionOf, runScript, writeReleaseTree } from "./releaseFixture.js";

const REVISION = revisionOf("shim-verify");

/** Every artifact the shim requires at start time. VERSION is absent on
 *  purpose — see the shim's own comment for why release completeness is
 *  install-time business.
 *
 *  The last entry is a package NEITHER the runner nor the shim names: it is
 *  reached only as a dependency of both wrappers. It is listed here because
 *  the manifest missing it is not a smaller failure than missing cli.js —
 *  the runner starts, and the first agent spawn dies at import instead. */
const REQUIRED_ARTIFACTS = [
  "dist/cli.js",
  "dist/build-info.json",
  "node_modules/@kaoiro/claude-code/dist/cli.js",
  "node_modules/@kaoiro/codex/dist/cli.js",
  "node_modules/@kaoiro/wrapper-core/dist/index.js",
];

/** Tools that must never run from the shim. `node` is excluded: the shim is
 *  supposed to exec the entry point with it. */
const BUILD_TOOLS = ["pnpm", "npm", "yarn", "tsc", "make"];

describe("kaoiro-runner-launch.sh の verify-only 起動 (issue #229)", () => {
  let dir: string;
  let tree: string;
  let confDir: string;
  let shim: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kaoiro-shim-verify-"));
    tree = join(dir, "release");
    writeReleaseTree(tree, REVISION);
    shim = join(tree, "deploy", "kaoiro-runner-launch.sh");

    confDir = join(dir, "config");
    mkdirSync(confDir, { recursive: true });
    writeFileSync(
      join(confDir, "runner.config.json"),
      JSON.stringify({ host_id: "test-host", server_url: "ws://localhost/x" }),
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const launch = (env: Record<string, string | undefined> = {}) =>
    runScript(shim, [], { KAOIRO_RUNNER_DIR: confDir, ...env });

  it("artifact が揃っていれば entry point を exec する", () => {
    const result = launch();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("stub cli.js started");
  });

  it.each(REQUIRED_ARTIFACTS)(
    "%s が欠けていれば exit 78 で起動しない",
    (artifact) => {
      unlinkSync(join(tree, artifact));

      const result = launch();

      expect(result.status).toBe(78);
      expect(result.stderr).toContain("release verification failed");
      expect(result.stderr).toContain(artifact);
      expect(result.stdout).not.toContain("stub cli.js started");
    },
  );

  it("VERSION が無くても起動する (repo-direct な checkout には無いため)", () => {
    unlinkSync(join(tree, "VERSION"));

    expect(launch().status).toBe(0);
  });

  it("MANIFEST.json を失った release (VERSION あり) は exit 78 で起動しない", () => {
    // もも review (issue #229): readManifest() folded EVERY read error into
    // "no manifest", and the shim treated that as the repo-direct checkout
    // case. A real release with its MANIFEST.json removed therefore fell back
    // to the four sentinels and reached the final exec at exit 0 — the same
    // enumeration this file exists to close, re-entered through the degrade
    // path instead of the check itself.
    unlinkSync(join(tree, "MANIFEST.json"));

    const result = launch();

    expect(result.status).toBe(78);
    expect(result.stderr).toContain("MANIFEST.json is missing from a built release");
    expect(result.stdout).not.toContain("stub cli.js started");
  });

  it("VERSION も MANIFEST も無ければ repo-direct として起動する", () => {
    // The discriminator is VERSION, not the manifest: only the builder writes
    // one, so its absence is what actually identifies a dev checkout.
    unlinkSync(join(tree, "MANIFEST.json"));
    unlinkSync(join(tree, "VERSION"));

    const result = launch();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("stub cli.js started");
  });

  it("MANIFEST.json が読めない (存在するが不正) なら縮退せず落ちる", () => {
    // ENOENT is the ONLY code that means absence. A directory in its place
    // makes readFileSync throw EISDIR, and folding that into "no manifest"
    // is the same degrade by another route.
    unlinkSync(join(tree, "MANIFEST.json"));
    mkdirSync(join(tree, "MANIFEST.json"));

    const result = launch();

    expect(result.status).toBe(78);
    expect(result.stderr).toContain("present but unreadable");
  });

  it("build-info.json の shape が不正なら exit 78 で起動しない", () => {
    // もも review must-fix 3: VALID JSON with a malformed field, which is
    // what actually exercises the shape guard. A syntactically broken file
    // would stop at JSON.parse instead and leave the guard unmeasured —
    // rolling the guard back then keeps the suite green (measured: it did).
    writeFileSync(
      join(tree, "dist", "build-info.json"),
      JSON.stringify({ revision: REVISION, dirty: false, built_at: "not-a-date" }),
    );

    const result = launch();

    expect(result.status).toBe(78);
    expect(result.stdout).not.toContain("stub cli.js started");
  });

  it("build ツールを一切起動しない", () => {
    const binDir = join(dir, "stub-bin");
    const marker = join(dir, "build-was-invoked");
    mkdirSync(binDir, { recursive: true });
    for (const tool of BUILD_TOOLS) {
      const stub = join(binDir, tool);
      writeFileSync(
        stub,
        `#!/bin/sh\nprintf '%s %s\\n' "${tool}" "$*" >> ${JSON.stringify(marker)}\nexit 0\n`,
      );
      chmodSync(stub, 0o755);
    }

    const result = launch({ PATH: `${binDir}:${process.env.PATH ?? ""}` });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("stub cli.js started");
    expect(existsSync(marker)).toBe(false);
  });

  it("artifact が欠けていても build を試みず、その場で止まる", () => {
    // The failure path is where a build would be most tempting ("dist is
    // missing, so make one"), so the tool recorders run over it too — the
    // success path alone would not measure this.
    const binDir = join(dir, "stub-bin");
    const marker = join(dir, "build-was-invoked");
    mkdirSync(binDir, { recursive: true });
    for (const tool of BUILD_TOOLS) {
      const stub = join(binDir, tool);
      writeFileSync(
        stub,
        `#!/bin/sh\nprintf '%s %s\\n' "${tool}" "$*" >> ${JSON.stringify(marker)}\nexit 0\n`,
      );
      chmodSync(stub, 0o755);
    }
    unlinkSync(join(tree, "dist", "cli.js"));

    const result = launch({ PATH: `${binDir}:${process.env.PATH ?? ""}` });

    expect(result.status).toBe(78);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(tree, "dist", "cli.js"))).toBe(false);
  });

  // PRODUCTION NEVER STARTS THE SHIM BY ITS PHYSICAL PATH, AND EVERY CASE
  // ABOVE DOES. systemd runs <install-root>/current/deploy/kaoiro-runner-
  // launch.sh, and reaching the verifier through that symlink used to skip it
  // entirely: node resolves an ESM module's own URL through realpath but
  // leaves process.argv[1] as typed, so verify-release.mjs's entry-point
  // guard was false, main() never ran, and the process exited 0 without
  // reading anything. A release missing dist/args.js then started and died at
  // import with node's exit 1 — restart-looping on the exact fault 78 exists
  // to stop (measured on a real tarball install, 2026-08-16). Running the
  // whole matrix through a `current` link is what keeps a fixture path from
  // standing in for the only path that ships.
  describe("current symlink 越しの起動 (本番と同じ経路)", () => {
    let viaCurrent: string;

    beforeEach(() => {
      symlinkSync("release", join(dir, "current"));
      viaCurrent = join(dir, "current", "deploy", "kaoiro-runner-launch.sh");
    });

    const launchViaCurrent = () =>
      runScript(viaCurrent, [], { KAOIRO_RUNNER_DIR: confDir });

    it("artifact が揃っていれば entry point を exec する", () => {
      const result = launchViaCurrent();

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("stub cli.js started");
    });

    it.each(REQUIRED_ARTIFACTS)(
      "%s が欠けていれば exit 78 で起動しない",
      (artifact) => {
        unlinkSync(join(tree, artifact));

        const result = launchViaCurrent();

        expect(result.status).toBe(78);
        expect(result.stderr).toContain("release verification failed");
        expect(result.stderr).toContain(artifact);
        expect(result.stdout).not.toContain("stub cli.js started");
      },
    );
  });

  // The `--version` shortcut still runs BEFORE any of this, so a first-run
  // host with no config and no node_modules can answer it (issue #228 round
  // 2 MF-5). That ordering is pinned by launchShimVersion.test.ts, whose
  // fixture deliberately has neither.
});
