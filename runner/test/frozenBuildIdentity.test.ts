import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { artifactBuildIdentity, computeBuildIdentity, consumeBuildIdentity, explicitBuildIdentity, assertSourceIdentity } from "../../scripts/build-identity.mjs";

const root = resolve(import.meta.dirname, "../..");
const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function project() {
  const repo = mkdtempSync(join(tmpdir(), "fuji571-frozen-test-")); scratch.push(repo);
  mkdirSync(join(repo, "scripts")); mkdirSync(join(repo, "runner/scripts"), { recursive: true });
  for (const name of ["build-identity.mjs", "with-build-identity.mjs", "serialize-build-identity.mjs", "generate-wrapper-build-info.mjs", "child-process-environment.mjs"])
    cpSync(join(root, "scripts", name), join(repo, "scripts", name));
  mkdirSync(join(repo, "runner/deploy"));
  cpSync(join(root, "runner/deploy/child-process-environment.mjs"), join(repo, "runner/deploy/child-process-environment.mjs"));
  cpSync(join(root, "runner/scripts/generate-build-info.mjs"), join(repo, "runner/scripts/generate-build-info.mjs"));
  writeFileSync(join(repo, ".gitignore"), "runner/dist\nwrapper-dist\nserver.json\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-q", "-b", "develop"); git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=t@example.com", "commit", "-qm", "fixture");
  return { repo, git };
}
function invoke(repo: string, body: string) {
  return spawnSync(process.execPath, [join(repo, "scripts/with-build-identity.mjs"), "--", process.execPath, "--input-type=module", "-e", body],
    { cwd: repo, encoding: "utf8", env: { PATH: process.env.PATH } });
}

describe("production frozen identity consumers", () => {
  it("uses the real coordinator and generators without injected implementations", () => {
    const { repo, git } = project();
    const result = invoke(repo, `import {execFileSync} from 'node:child_process';
      execFileSync(process.execPath,['runner/scripts/generate-build-info.mjs']);
      const revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
      const landing={schema:1,kind:'landing',repository_id:1343265983,revision,branch:'develop',
        version:'2026.10.09.1',original_run_id:1,created_at:'2026-10-09T00:00:00Z'};
      execFileSync('git',['-c','user.name=Test','-c','user.email=t@example.com','tag','-a','v2026.10.09.1','-m',JSON.stringify(landing)]);
      const object=execFileSync('git',['rev-parse','refs/tags/v2026.10.09.1'],{encoding:'utf8'}).trim();
      execFileSync('git',['update-ref','refs/tags/identity/landing/'+revision,object]);
      execFileSync(process.execPath,['scripts/generate-wrapper-build-info.mjs','wrapper-dist']);
      execFileSync(process.execPath,['scripts/serialize-build-identity.mjs','server.json']);`);
    expect(result.stderr).toBe(""); expect(result.status).toBe(0);
    const runner = JSON.parse(readFileSync(join(repo, "runner/dist/build-info.json"), "utf8"));
    expect(runner.version).toBe("untagged"); expect(runner.revision).toBe(git("rev-parse", "HEAD"));
    for (const file of ["wrapper-dist/build-info.json", "server.json"])
      expect(JSON.parse(readFileSync(join(repo, file), "utf8"))).toEqual(runner);
    expect(runner.branch).toBe("develop");
  });
  it("refuses a source change after successful child execution", () => {
    const { repo } = project();
    const result = invoke(repo, `import {writeFileSync} from 'node:fs'; writeFileSync('moved-source','x');`);
    expect(result.status).toBe(78); expect(result.stderr).toContain("source revision or dirty state changed");
  });
  it("finds pnpm and its nested tool only through the supplied toolchain PATH", () => {
    const { repo, git } = project();
    const bin = join(repo, ".git/toolchain");
    mkdirSync(bin);
    writeFileSync(join(bin, "pnpm"), '#!/bin/sh\nexec fixture-build-tool "$@"\n', { mode: 0o755 });
    writeFileSync(join(bin, "fixture-build-tool"), `#!/bin/sh
test "$PNPM_HOME" = "$PATH" || exit 90
test -z "\${GH_TOKEN+x}" || exit 91
test -z "\${GIT_DIR+x}" || exit 92
test -n "$KAOIRO_BUILD_IDENTITY_FILE" || exit 93
test -n "$KAOIRO_BUILD_IDENTITY_SHA256" || exit 94
test "$KAOIRO_BUILD_VERSION" = untagged || exit 95
test "$KAOIRO_BUILD_BRANCH" = develop || exit 96
printf '%s\\n' "$PATH" "$KAOIRO_BUILD_REVISION" "$*"
`, { mode: 0o755 });
    const result = spawnSync(process.execPath, [join(repo, "scripts/with-build-identity.mjs"), "--", "pnpm", "run", "build"],
      { cwd: repo, encoding: "utf8", env: { PATH: bin, PNPM_HOME: bin, GH_TOKEN: "inert-secret", GIT_DIR: "/fixture/foreign" } });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${bin}\n${git("rev-parse", "HEAD")}\nrun build\n`);
  });
  it("refuses altered frozen bytes after a child makes the file writable", () => {
    const { repo } = project();
    const result = invoke(repo, `import {chmodSync,readFileSync,writeFileSync} from 'node:fs';
      const file=process.env.KAOIRO_BUILD_IDENTITY_FILE;const i=JSON.parse(readFileSync(file,'utf8'));i.branch='different-valid-branch';
      chmodSync(file,0o600);writeFileSync(file,JSON.stringify(i));`);
    expect(result.status).toBe(78); expect(result.stderr).toContain("digest mismatch");
  });
  it("does not merge partial explicit values with the live checkout", () => {
    expect(() => explicitBuildIdentity({ KAOIRO_BUILD_VERSION: "2026.10.09.1" })).toThrow("five valid");
    expect(() => consumeBuildIdentity(root, { KAOIRO_BUILD_CHANNEL: "dev" })).toThrow();
  });
  it("serializes a valid branch containing quotes without hand-built JSON", () => {
    const env = { KAOIRO_BUILD_VERSION: "untagged", KAOIRO_BUILD_CHANNEL: "dev", KAOIRO_BUILD_REVISION: "a".repeat(40),
      KAOIRO_BUILD_DIRTY: "false", KAOIRO_BUILD_BRANCH: `topic/quote'\"` };
    expect(explicitBuildIdentity(env)?.branch).toBe(env.KAOIRO_BUILD_BRANCH);
  });
  it("rejects mismatching pinned source before invoking a child", () => {
    const { repo } = project();
    const identity = artifactBuildIdentity(computeBuildIdentity(repo));
    expect(() => assertSourceIdentity(repo, { ...identity, revision: "b".repeat(40) })).toThrow();
  });
});
