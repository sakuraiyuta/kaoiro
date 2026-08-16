// The repo-direct profile, measured on the LAYOUT PRODUCTION ACTUALLY HAS.
//
// verify-release.mjs supports two profiles: a built release, and a repo-direct
// checkout (no VERSION, no MANIFEST.json — the four sentinels only). The
// second one could never pass. pnpm links a workspace member into its
// dependents by a relative path that leaves the dependent, so every sentinel
// under runner/node_modules/@kaoiro/ resolved OUTSIDE runner/ and the
// containment check rejected it. The service went to exit 78 on the first
// restart after the check reached production, on a tree whose builds were
// current.
//
// releaseFixture.ts could not catch that, and still cannot: it writes
// node_modules/@kaoiro/* as real directories inside the release root, which is
// what a BUILT RELEASE looks like. The repo-direct test that ran against it
// was therefore measuring the fixture's own shape, not the shape it named. So
// this file does two things the other one cannot:
//
//   1. stages the workspace link topology itself — wrappers in sibling
//      members, reached through the same relative links pnpm writes — and
//      starts the real shim on it;
//   2. pins pnpm's layout as an explicit premise against the REAL checkout, so
//      a fixture that stops mirroring reality fails here rather than passing
//      quietly.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { revisionOf, runScript, writeWorkspaceCheckout } from "./releaseFixture.js";

const REVISION = revisionOf("repo-direct-workspace");

/** The checkout this file's fixture stands in for: runner/test/ -> repo root. */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** pnpm's own spelling, relative to the link's own directory
 *  (`<ws>/runner/node_modules/@kaoiro/`). Copied from the live checkout rather
 *  than composed: the premise test below is what keeps the two equal. */
const linkTarget = (wrapper: string): string => `../../../wrapper/${wrapper}`;

describe("repo-direct な workspace checkout の起動検証", () => {
  let dir: string;
  let ws: string;
  let runner: string;
  let confDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kaoiro-repo-direct-"));
    ws = join(dir, "workspace");
    mkdirSync(ws, { recursive: true });
    // writeWorkspaceCheckout (issue #259) stages the REAL pnpm workspace link
    // topology this file's tests actually need — the runner tree in
    // `runner/`, wrapper packages as sibling members, and
    // runner/node_modules/@kaoiro reaching them by relative links out of the
    // runner tree — rather than the built-release shape writeReleaseTree
    // alone produces.
    runner = writeWorkspaceCheckout(ws, REVISION);

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

  const launch = () =>
    runScript(join(runner, "deploy", "kaoiro-runner-launch.sh"), [], {
      KAOIRO_RUNNER_DIR: confDir,
    });

  it("wrapper が workspace リンク越しでも起動する", () => {
    const result = launch();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("stub cli.js started");
  });

  it("workspace の外を指すリンクは exit 78 で起動しない", () => {
    // The negative control the release root used to provide for free. Widening
    // the boundary to the workspace must not widen it to the filesystem: a
    // sentinel reached through a link out of the checkout is still a tree
    // whose contents nobody can account for.
    const outside = join(dir, "outside", "claude-code");
    mkdirSync(outside, { recursive: true });
    renameSync(join(ws, "wrapper", "claude-code"), outside);
    const link = join(runner, "node_modules", "@kaoiro", "claude-code");
    unlinkSync(link);
    symlinkSync(outside, link);

    const result = launch();

    expect(result.status).toBe(78);
    expect(result.stderr).toContain("resolves outside the release");
    expect(result.stdout).not.toContain("stub cli.js started");
    // issue #259: this exact failure class (a containment-boundary
    // violation) is the incident the launch shim's OLD unconditional "run
    // pnpm build" guidance misled an operator with — the artifacts were all
    // present and current, a rebuild changed nothing, and the same failure
    // recurred 15 seconds later. The guidance must not repeat that mistake.
    expect(result.stderr).not.toContain("pnpm -C wrapper build");
    expect(result.stderr).toContain("NOT a missing build");
  });

  it("workspace marker が無ければ release root 境界へ戻る", () => {
    // The wider boundary is bought by the marker and by nothing else. Without
    // one, the tree is its own boundary again — the stricter of the two — so
    // this same link topology is rejected. A boundary that widened
    // unconditionally (root's parent, say) would start here.
    unlinkSync(join(ws, "pnpm-workspace.yaml"));

    const result = launch();

    expect(result.status).toBe(78);
    expect(result.stderr).toContain("resolves outside the release");
    expect(result.stdout).not.toContain("stub cli.js started");
    // issue #259: same failure class as the previous test — not build-fixable.
    expect(result.stderr).not.toContain("pnpm -C wrapper build");
  });

  it("実チェックアウトのリンクは runner/ の外・workspace の内を指す (前提の pin)", () => {
    // THE PREMISE, TAKEN FROM pnpm RATHER THAN RESTATED. Everything above is
    // still a fixture; this is the assertion that fails if pnpm ever stops
    // linking workspace members out of the dependent, which would make the
    // fixture describe a layout that no longer exists.
    const link = join(REPO_ROOT, "runner", "node_modules", "@kaoiro", "claude-code");

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(linkTarget("claude-code"));
    const real = realpathSync(link);
    expect(relative(realpathSync(join(REPO_ROOT, "runner")), real)).toMatch(/^\.\./);
    expect(relative(realpathSync(REPO_ROOT), real)).not.toMatch(/^\.\./);
    expect(existsSync(join(REPO_ROOT, "pnpm-workspace.yaml"))).toBe(true);
  });

  it("実チェックアウトで最近傍の workspace marker は repo root である (前提の pin)", () => {
    // A MARKER IS NOT THE MARKER. workspaceRootOf stops at the FIRST one it
    // meets walking up, and this repo already carries a nested one —
    // dashboard/pnpm-workspace.yaml, an independent build root. One appearing
    // at runner/ or anywhere between would collapse the boundary back to
    // runner/ and return the service to exit 78, while every assertion in the
    // test above stayed green: the link topology would be unchanged.
    const repoReal = realpathSync(REPO_ROOT);

    for (
      let cur = realpathSync(join(REPO_ROOT, "runner"));
      cur !== repoReal;
      cur = dirname(cur)
    ) {
      // Walking past the filesystem root instead of reaching the repo root
      // means the premise itself is gone; fail loudly rather than spin.
      expect(cur).not.toBe(dirname(cur));
      expect(existsSync(join(cur, "pnpm-workspace.yaml"))).toBe(false);
    }
  });

  it("marker が symlink なら workspace とみなさない", () => {
    // The marker is trusted to say "a checkout starts here" and nothing else
    // (verify-release.mjs states the residual). A symlink standing in for it
    // is the one shape that costs nothing to refuse, so it is refused — and
    // the boundary falls back to the release root, which rejects this tree.
    const real = join(dir, "elsewhere", "pnpm-workspace.yaml");
    mkdirSync(dirname(real), { recursive: true });
    writeFileSync(real, "packages:\n  - runner\n");
    unlinkSync(join(ws, "pnpm-workspace.yaml"));
    symlinkSync(real, join(ws, "pnpm-workspace.yaml"));

    const result = launch();

    expect(result.status).toBe(78);
    expect(result.stderr).toContain("resolves outside the release");
  });
});
