import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { artifactBuildIdentity, BUILD_REPOSITORY_ID, computeBuildIdentity, consumeBuildIdentity,
  formatLandingVersion, parseLandingVersion, readFrozenBuildIdentity, requireTaggedIdentity } from "../../scripts/build-identity.mjs";

const script = fileURLToPath(new URL("../../scripts/build-identity.mjs", import.meta.url));
let dir: string;
let repo: string;
let revision: string;
const git = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function publish(fields: Record<string, unknown> = {}) {
  const record = { schema: 1, kind: "landing", repository_id: BUILD_REPOSITORY_ID, revision,
    branch: "develop", version: "2026.10.09.1", original_run_id: 11, created_at: "2026-10-09T00:00:00Z", ...fields };
  const tag = `v${String(record.version)}`;
  git(["-c", "tag.gpgSign=false", "tag", "-a", tag, revision, "--cleanup=verbatim", "-m", JSON.stringify(record)]);
  git(["update-ref", `refs/tags/identity/landing/${revision}`, git(["rev-parse", tag])]);
  return record;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fuji571-landing-reader-"));
  repo = join(dir, "source"); mkdirSync(repo);
  git(["init", "-q", "-b", "develop"]);
  git(["config", "user.name", "fixture"]);
  git(["config", "user.email", "fixture@example.com"]);
  writeFileSync(join(repo, "source"), "first\n");
  git(["add", "source"]); git(["commit", "-qm", "first"]);
  revision = git(["rev-parse", "HEAD"]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("exact landing identity", () => {
  it("requires the annotated public tag and matching claim, independent of containing branches", () => {
    publish();
    git(["branch", "main"]); git(["checkout", "-q", "main"]);
    expect(computeBuildIdentity(repo)).toMatchObject({ version: "2026.10.09.1", branch: "develop", revision, dirty: false, degraded: false, channel: "dev" });
    git(["checkout", "-q", "--detach", "HEAD"]);
    expect(computeBuildIdentity(repo).version).toBe("2026.10.09.1");
  });
  it("does not derive a version from a nearest ancestor or a manual legacy tag", () => {
    publish();
    writeFileSync(join(repo, "source"), "second\n"); git(["commit", "-qam", "second"]);
    git(["tag", "v2026.9.0"]);
    expect(computeBuildIdentity(repo).version).toBe("untagged");
    expect(computeBuildIdentity(repo).degraded).toBe(false);
  });
  it.each(["missing claim", "lightweight tag", "another repository", "wrong revision", "wrong date", "multiple tags"])("refuses %s", (failure) => {
    if (failure === "lightweight tag") git(["tag", "v2026.10.09.1"]);
    else publish(failure === "another repository" ? { repository_id: 1 } : failure === "wrong revision" ? { revision: "f".repeat(40) }
      : failure === "wrong date" ? { created_at: "2026-10-10T00:00:00Z" } : {});
    if (failure === "missing claim") git(["update-ref", "-d", `refs/tags/identity/landing/${revision}`]);
    if (failure === "multiple tags") git(["tag", "v2026.10.09.2"]);
    const identity = computeBuildIdentity(repo);
    expect(identity.version).toBe("untagged");
    expect(identity.degraded).toBe(true);
  });
  it("dirty tracked and untracked sources never claim the landing version", () => {
    publish();
    for (const path of ["source", "untracked"]) {
      writeFileSync(join(repo, path), "changed\n");
      expect(computeBuildIdentity(repo)).toMatchObject({ version: "untagged", dirty: true });
    }
  });
  it("detached untagged sources require an explicit verified build ref", () => {
    git(["checkout", "-q", "--detach", "HEAD"]);
    expect(computeBuildIdentity(repo).branch).toBe("unknown");
    expect(computeBuildIdentity(repo, { buildRef: "develop" }).branch).toBe("develop");
    expect(computeBuildIdentity(repo, { buildRef: "absent" }).branch).toBe("unknown");
  });
  it("production refuses an untagged tip and shallow inventory before building", () => {
    const remote = join(dir, "origin.git");
    git(["clone", "-q", "--bare", repo, remote], dir);
    git(["remote", "add", "origin", remote]);
    expect(() => requireTaggedIdentity(repo, { target: revision, timeoutMs: 20 })).toThrow(/completed exact landing/);
    publish(); git(["push", "-q", "origin", "--tags"]);
    expect(requireTaggedIdentity(repo, { target: revision, timeoutMs: 1000 }).version).toBe("2026.10.09.1");
    const shallow = join(dir, "shallow");
    git(["clone", "-q", "--depth", "1", `file://${repo}`, shallow], dir);
    expect(computeBuildIdentity(shallow).degraded).toBe(true);
  });
  it("freezes one identity despite a tag arriving between consumer steps and rejects changed bytes", () => {
    const frozen = artifactBuildIdentity(computeBuildIdentity(repo), "2026-10-09T00:00:00.000Z");
    const path = join(dir, "identity.json"); const bytes = JSON.stringify(frozen);
    writeFileSync(path, bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const env = { KAOIRO_BUILD_IDENTITY_FILE: path, KAOIRO_BUILD_IDENTITY_SHA256: digest };
    expect(consumeBuildIdentity(repo, env)).toEqual(frozen);
    publish();
    expect(consumeBuildIdentity(repo, env)).toEqual(frozen);
    writeFileSync(path, bytes + " ");
    expect(() => readFrozenBuildIdentity(path, digest)).toThrow(/digest mismatch/);
  });
  it("quotes a Git-valid branch with shell syntax without executing it", () => {
    const marker = join(dir, "marker");
    const branch = `topic/$(touch${"${IFS}"}${marker})'\"`;
    git(["checkout", "-qb", branch]);
    const output = execFileSync(process.execPath, [script, "--repo", repo], { encoding: "utf8" });
    const sourced = spawnSync("sh", ["-c", `${output}\nprintf '%s' "$KAOIRO_BUILD_BRANCH"`], { encoding: "utf8" });
    expect(sourced.status).toBe(0);
    expect(sourced.stdout).toBe(branch);
    expect(existsSync(marker)).toBe(false);
  });
  it("keeps numeric publication sequence and real UTC calendar boundaries", () => {
    expect(formatLandingVersion("2026-10-09", 10)).toBe("2026.10.09.10");
    expect(parseLandingVersion("2028.02.29.1")?.day).toBe("2028-02-29");
    for (const version of ["2026.02.30.1", "2026.10.09.0", "2026.10.09.01", "2026.10.09.1000000", "2026.10.9.1", "2026.10.09.1\n"]) expect(parseLandingVersion(version)).toBeNull();
  });
});
