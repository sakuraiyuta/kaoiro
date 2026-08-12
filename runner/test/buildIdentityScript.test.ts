// scripts/build-identity.mjs (issue #228 round 2, ふじ MF-2/MF-5 差し戻し):
// the repo-level shared revision/dirty computation used by BOTH
// runner/scripts/generate-build-info.mjs and the server build's
// KAOIRO_BUILD_REVISION/KAOIRO_BUILD_DIRTY args. Exercised here against a
// REAL temp git repo (real `git` subprocess calls, not mocked) so this
// pins the actual production wiring, not a restated assumption about how
// git behaves. The degrade-on-status-failure rule (MF-2) needs a mocked
// git call and lives in its own file (buildIdentityScriptDegrade.test.ts)
// so that mock does not leak into these real-subprocess tests.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeBuildIdentity,
  formatIdentityString,
} from "../../scripts/build-identity.mjs";
import { formatBuildRevision, loadBuildInfo } from "../src/build_info.js";

const scriptPath = fileURLToPath(
  new URL("../../scripts/build-identity.mjs", import.meta.url),
);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

describe("computeBuildIdentity (issue #228 round 2)", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir !== undefined) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("clean な commit を実 SHA / dirty: false として返す", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaoiro-build-identity-"));
    git(["init", "--quiet"], tmpDir);
    writeFileSync(join(tmpDir, "a.txt"), "hello\n");
    git(["add", "a.txt"], tmpDir);
    git(
      ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "x", "--quiet"],
      tmpDir,
    );

    const identity = computeBuildIdentity(tmpDir);
    expect(identity.degraded).toBe(false);
    expect(identity.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(identity.dirty).toBe(false);
  });

  it("tracked ファイルの未コミット変更を dirty: true として検出する", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaoiro-build-identity-"));
    git(["init", "--quiet"], tmpDir);
    writeFileSync(join(tmpDir, "a.txt"), "hello\n");
    git(["add", "a.txt"], tmpDir);
    git(
      ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "x", "--quiet"],
      tmpDir,
    );
    writeFileSync(join(tmpDir, "a.txt"), "changed\n");

    expect(computeBuildIdentity(tmpDir).dirty).toBe(true);
  });

  // issue #227 の実際の作業で untracked ファイルが tracked-only の dirty
  // 判定をすり抜けた実例が、この untracked-counts-as-dirty 規約の根拠。
  it("untracked ファイルも dirty: true として検出する (issue #227 の実例)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaoiro-build-identity-"));
    git(["init", "--quiet"], tmpDir);
    writeFileSync(join(tmpDir, "a.txt"), "hello\n");
    git(["add", "a.txt"], tmpDir);
    git(
      ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "x", "--quiet"],
      tmpDir,
    );
    writeFileSync(join(tmpDir, "untracked.txt"), "new\n");

    expect(computeBuildIdentity(tmpDir).dirty).toBe(true);
  });

  it("git checkout 外のディレクトリでは unknown へ degrade する", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaoiro-build-identity-not-a-repo-"));

    const identity = computeBuildIdentity(tmpDir);
    expect(identity).toEqual({
      revision: "unknown",
      dirty: false,
      degraded: true,
      degradeReason: expect.stringContaining("rev-parse"),
    });
  });
});

describe("formatIdentityString (issue #228 round 2)", () => {
  it("clean なら revision をそのまま返す", () => {
    expect(
      formatIdentityString({ revision: "0123456789abcdef0123456789abcdef01234567", dirty: false }),
    ).toBe("0123456789abcdef0123456789abcdef01234567");
  });

  it("dirty なら -dirty サフィックスを付ける", () => {
    expect(
      formatIdentityString({ revision: "0123456789abcdef0123456789abcdef01234567", dirty: true }),
    ).toBe("0123456789abcdef0123456789abcdef01234567-dirty");
  });
});

describe("build-identity.mjs --format <file> CLI (issue #228 round 2 MF-5)", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir !== undefined) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  // Real subprocess invocation of the actual CLI entry point — this is
  // what scripts/build-runner-tarball.sh calls to build its VERSION file,
  // so pinning the real `node scripts/build-identity.mjs --format <file>`
  // invocation (not just the exported function) is what MF-5's tri-way
  // consistency claim rests on.
  it("build-info.json を読んで canonical form を stdout へ出す", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaoiro-build-identity-cli-"));
    const buildInfo = join(tmpDir, "build-info.json");
    writeFileSync(
      buildInfo,
      JSON.stringify({
        revision: "0123456789abcdef0123456789abcdef01234567",
        dirty: true,
        built_at: "2026-08-12T00:00:00.000Z",
      }),
    );

    const out = execFileSync("node", [scriptPath, "--format", buildInfo], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(out.trim()).toBe("0123456789abcdef0123456789abcdef01234567-dirty");
  });

  // issue #228 round 3 MF-3 (ふじ 差し戻し): round 2's --format skipped
  // value-domain validation entirely. Reproduces the exact bug found —
  // `dirty` given as the STRING "false" (not the boolean) is truthy in JS,
  // so a naive `dirty ? ... : ...` appends "-dirty" even though the value
  // is nominally "false". Ruling: degrade to the SAME "unknown" the
  // runner's own loadBuildInfo() would produce for this file, not
  // fail-loud and not a literal pass-through of the malformed value.
  it("malformed な build-info.json (revision 値域外 + dirty が文字列) は unknown へ degrade する", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaoiro-build-identity-cli-"));
    const buildInfo = join(tmpDir, "build-info.json");
    writeFileSync(
      buildInfo,
      JSON.stringify({ revision: "not-a-sha", dirty: "false", built_at: "tomorrow" }),
    );

    const out = execFileSync("node", [scriptPath, "--format", buildInfo], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(out.trim()).toBe("unknown");
  });

  it("dirty が truthy な文字列でも malformed として degrade する (\"false\" 文字列が -dirty を誘発するバグの再現)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaoiro-build-identity-cli-"));
    const buildInfo = join(tmpDir, "build-info.json");
    writeFileSync(
      buildInfo,
      JSON.stringify({
        revision: "0123456789abcdef0123456789abcdef01234567",
        dirty: "false",
      }),
    );

    const out = execFileSync("node", [scriptPath, "--format", buildInfo], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    // A round-2-shaped bug would print
    // "0123456789abcdef0123456789abcdef01234567-dirty" here (the string
    // "false" is truthy). The correct output is the degraded "unknown".
    expect(out.trim()).toBe("unknown");
  });

  // issue #228 round 4 (ふじ 差し戻し): round 3 closed the revision/dirty
  // validation gap in --format but left built_at unvalidated — a file with
  // a VALID revision/dirty and a malformed built_at still passed straight
  // through, while the runner's own loadBuildInfo() (which validates the
  // FULL shape) degraded the identical file to unknown. Two readers of the
  // same file disagreeing again, just on a different field.
  it("built_at だけ malformed (revision/dirty は valid) でも unknown へ degrade する", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaoiro-build-identity-cli-"));
    const buildInfo = join(tmpDir, "build-info.json");
    writeFileSync(
      buildInfo,
      JSON.stringify({
        revision: "0123456789abcdef0123456789abcdef01234567",
        dirty: false,
        built_at: "2026-99-99T99:99:99.999Z",
      }),
    );

    const out = execFileSync("node", [scriptPath, "--format", buildInfo], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(out.trim()).toBe("unknown");
  });

  // issue #228 round 4: round 3 wrapped the SHAPE check but left
  // `readFileSync`/`JSON.parse` uncaught — a missing file or corrupt JSON
  // crashed this CLI with a raw stack trace (exit 1) instead of degrading
  // like loadBuildInfo() does for the identical failure.
  it("壊れた JSON は例外を投げず unknown へ degrade する (exit 0)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaoiro-build-identity-cli-"));
    const buildInfo = join(tmpDir, "build-info.json");
    writeFileSync(buildInfo, "{ not json");

    const out = execFileSync("node", [scriptPath, "--format", buildInfo], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(out.trim()).toBe("unknown");
  });

  it("ファイルが存在しなくても例外を投げず unknown へ degrade する (exit 0)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaoiro-build-identity-cli-"));
    const missing = join(tmpDir, "does-not-exist.json");

    const out = execFileSync("node", [scriptPath, "--format", missing], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(out.trim()).toBe("unknown");
  });

  // Tri-way consistency pin (MF-5's original claim, now actually enforced
  // across BOTH the well-formed path AND every failure path): --format's
  // output must equal what the runner's own
  // formatBuildRevision(loadBuildInfo(dir)) computes for the identical
  // file/directory — the two readers of the same build-info.json must
  // never disagree, whether the file is well-formed, partially malformed,
  // corrupt, or missing (issue #228 round 4, ふじ 差し戻し: extends the
  // round-3 well-formed-only version of this pin to the 3 failure modes
  // she reproduced independently).
  describe.each([
    [
      "well-formed",
      { revision: "0123456789abcdef0123456789abcdef01234567", dirty: true, built_at: "2026-08-12T00:00:00.000Z" },
    ],
    [
      "built_at だけ malformed",
      { revision: "0123456789abcdef0123456789abcdef01234567", dirty: true, built_at: "2026-99-99T99:99:99.999Z" },
    ],
  ])("--format と formatBuildRevision(loadBuildInfo(dir)) の一致 (%s)", (_label, fixture) => {
    it("一致する", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "kaoiro-build-identity-cli-"));
      writeFileSync(join(tmpDir, "build-info.json"), JSON.stringify(fixture));

      const out = execFileSync(
        "node",
        [scriptPath, "--format", join(tmpDir, "build-info.json")],
        { cwd: repoRoot, encoding: "utf8" },
      );
      expect(out.trim()).toBe(formatBuildRevision(loadBuildInfo(tmpDir)));
    });
  });

  it("--format と loadBuildInfo は壊れた JSON でも一致する (どちらも unknown)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaoiro-build-identity-cli-"));
    writeFileSync(join(tmpDir, "build-info.json"), "{ not json");

    const out = execFileSync(
      "node",
      [scriptPath, "--format", join(tmpDir, "build-info.json")],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(out.trim()).toBe(formatBuildRevision(loadBuildInfo(tmpDir)));
  });

  it("--format と loadBuildInfo はファイル欠落でも一致する (どちらも unknown)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaoiro-build-identity-cli-"));
    // Deliberately no build-info.json written into tmpDir.

    const out = execFileSync(
      "node",
      [scriptPath, "--format", join(tmpDir, "build-info.json")],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(out.trim()).toBe(formatBuildRevision(loadBuildInfo(tmpDir)));
  });
});
