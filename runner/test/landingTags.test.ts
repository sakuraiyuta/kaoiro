import { installChildFixture } from "../../scripts/test/fixtures/child-process-fixture.mjs";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { BUILD_REPOSITORY_ID, readLandingTag } from "../../scripts/build-identity.mjs";

const realGit = process.env.PATH?.split(delimiter).map(directory => join(directory, "git")).find(path => existsSync(path));
if (!realGit) throw new Error("git executable is required for landing tag tests");
const allocatorUrl = new URL("../../scripts/landing-tags.mjs", import.meta.url).href;
const environmentUrl = new URL("../../scripts/child-process-environment.mjs", import.meta.url).href;
const { childEnvironment } = await import(environmentUrl);
const fixtures: string[] = [];
const initialPath = process.env.PATH ?? "";
const initialLoseResponse = process.env.LANDING_GIT_LOSE_RESPONSE;
const initialRealGit = process.env.LANDING_GIT_REAL;

const git = (cwd: string, args: string[], input?: string) => execFileSync(realGit, args, {
  cwd,
  encoding: "utf8",
  input,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
}).trimEnd();

function fixture(commitCount = 2) {
  const root = mkdtempSync(join(tmpdir(), "momo571-landing-"));
  fixtures.push(root);
  const seed = join(root, "seed");
  const remote = join(root, "origin.git");
  const first = join(root, "first");
  const second = join(root, "second");
  mkdirSync(seed);
  git(seed, ["init", "--quiet", "--initial-branch=develop"]);
  git(seed, ["config", "user.name", "landing fixture"]);
  git(seed, ["config", "user.email", "landing-fixture@example.invalid"]);
  const targets: string[] = [];
  for (let index = 1; index <= commitCount; index += 1) {
    writeFileSync(join(seed, "state.txt"), `commit ${index}\n`);
    git(seed, ["add", "state.txt"]);
    git(seed, ["commit", "--quiet", "-m", `commit ${index}`]);
    targets.push(git(seed, ["rev-parse", "HEAD"]));
  }
  git(root, ["clone", "--quiet", "--bare", seed, remote]);
  git(root, ["clone", "--quiet", remote, first]);
  git(root, ["clone", "--quiet", remote, second]);
  return { root, seed, remote, first, second, targets };
}

async function loadAllocator() {
  return (await import(allocatorUrl)).allocateLanding as (input: {
    cwd: string;
    remote: string;
    target: string;
    originalRunId: number;
    createdAt: string;
    repositoryId: number;
    gitEnv: Record<string, string>;
  }) => { record: Record<string, unknown>; tag: string; object: string; created: boolean };
}

async function loadInventoryAuditor() {
  return (await import(allocatorUrl)).auditLandingInventory as (input: {
    cwd: string;
    remote: string;
    repositoryId: number;
    gitEnv: Record<string, string>;
  }) => boolean;
}

function inputFor(repo: string, remote: string, target: string, createdAt = "2026-10-09T12:00:00Z", originalRunId = 101) {
  return { cwd: repo, remote, target, originalRunId, createdAt, repositoryId: BUILD_REPOSITORY_ID, gitEnv: childEnvironment("git") };
}

function remoteRefs(remote: string) {
  return git(remote, ["for-each-ref", "--format=%(objectname) %(refname)", "refs"])
    .split("\n").filter(Boolean).map(line => {
      const separator = line.indexOf(" ");
      return { object: line.slice(0, separator), ref: line.slice(separator + 1) };
    });
}

function seedLanding(repo: string, remote: string, target: string, day: string, number: number, runId: number) {
  const version = `${day.replaceAll("-", ".")}.${number}`;
  const record = { schema: 1, kind: "landing", repository_id: BUILD_REPOSITORY_ID, revision: target,
    branch: "develop", version, original_run_id: runId, created_at: `${day}T12:00:00Z` };
  const tag = `v${version}`;
  git(repo, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "tag", "-a", tag,
    target, "--cleanup=verbatim", "-m", JSON.stringify(record)]);
  const object = git(repo, ["rev-parse", `refs/tags/${tag}`]);
  git(repo, ["update-ref", `refs/tags/identity/landing/${target}`, object]);
  git(repo, ["push", "--atomic", remote, `refs/tags/${tag}`, `refs/tags/identity/landing/${target}`]);
}

function seedPublicLandingOnly(repo: string, remote: string, target: string, day: string, number: number, runId: number) {
  const version = `${day.replaceAll("-", ".")}.${number}`;
  const record = { schema: 1, kind: "landing", repository_id: BUILD_REPOSITORY_ID, revision: target,
    branch: "develop", version, original_run_id: runId, created_at: `${day}T12:00:00Z` };
  const tag = `v${version}`;
  git(repo, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "tag", "-a", tag,
    target, "--cleanup=verbatim", "-m", JSON.stringify(record)]);
  const object = git(repo, ["rev-parse", `refs/tags/${tag}`]);
  git(repo, ["push", remote, `refs/tags/${tag}`]);
  return { record, tag, object };
}

function makeGitShim(root: string) {
  const bin = join(root, "shim-bin");
  mkdirSync(bin);
  const shim = join(bin, "git");
  const shimModule = join(bin, "git-shim.mjs");
  writeFileSync(shimModule, `import { spawnSync } from "node:child_process";
import { existsSync, openSync, closeSync, readdirSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const isPush = args[0] === "push";
const barrier = process.env.LANDING_GIT_PUSH_BARRIER;
if (isPush && barrier && !existsSync(join(barrier, "released"))) {
  let fd;
  try { fd = openSync(join(barrier, "ready-" + process.pid), "wx"); closeSync(fd); } catch {}
  const deadline = Date.now() + 15000;
  while (readdirSync(barrier).filter(name => name.startsWith("ready-")).length < 2 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (readdirSync(barrier).filter(name => name.startsWith("ready-")).length < 2) process.exit(92);
  try { fd = openSync(join(barrier, "released"), "wx"); closeSync(fd); } catch {}
}
const result = spawnSync(process.env.LANDING_GIT_REAL, args, { stdio: "inherit", env: process.env });
if (result.error) process.exit(93);
if (isPush && process.env.LANDING_GIT_LOSE_RESPONSE === "1" && result.status === 0) process.exit(71);
process.exit(result.status ?? 1);
`);
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(shim, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(shimModule)} "$@"\n`, { mode: 0o755 });
  chmodSync(shim, 0o755);
  writeFileSync(join(bin, "preload.mjs"), `import { installChildFixture } from ${JSON.stringify(new URL("../../scripts/test/fixtures/child-process-fixture.mjs", import.meta.url).href)}; installChildFixture(${JSON.stringify(bin)});`);
  return { bin, path: `${bin}${delimiter}${initialPath}` };
}

function withPath<T>(path: string, callback: () => T): T {
  const oldPath = process.env.PATH;
  process.env.PATH = path;
  const restore = installChildFixture(path.split(delimiter)[0]!);
  try {
    return callback();
  } finally {
    restore();
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
}

function runAllocatorProcess(input: ReturnType<typeof inputFor>, env: NodeJS.ProcessEnv) {
  const childCode = `
    const { allocateLanding } = await import(${JSON.stringify(allocatorUrl)});
    try {
      const { childEnvironment } = await import(${JSON.stringify(environmentUrl)});
      const result = await allocateLanding({ ...JSON.parse(process.env.LANDING_INPUT_JSON), gitEnv: childEnvironment("git") });
      process.stdout.write(JSON.stringify({ ok: true, result }));
    } catch (error) {
      process.stderr.write(String(error?.stack ?? error));
      process.exitCode = 1;
    }
  `;
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", join((env.PATH ?? "").split(delimiter)[0]!, "preload.mjs"), "--input-type=module", "-e", childCode], {
      cwd: input.cwd,
      env: { ...env, LANDING_INPUT_JSON: JSON.stringify(input) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
}

afterEach(() => {
  process.env.PATH = initialPath;
  if (initialLoseResponse === undefined) delete process.env.LANDING_GIT_LOSE_RESPONSE;
  else process.env.LANDING_GIT_LOSE_RESPONSE = initialLoseResponse;
  if (initialRealGit === undefined) delete process.env.LANDING_GIT_REAL;
  else process.env.LANDING_GIT_REAL = initialRealGit;
  if (initialRealGit === undefined) delete process.env.LANDING_GIT_REAL;
  else process.env.LANDING_GIT_REAL = initialRealGit;
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("landing tag allocation against a bare Git remote", () => {
  it("audits empty and valid inventories without changing remote refs", async () => {
    const f = fixture();
    const auditLandingInventory = await loadInventoryAuditor();
    const emptyRefs = remoteRefs(f.remote);

    expect(await auditLandingInventory({ cwd: f.first, remote: "origin", repositoryId: BUILD_REPOSITORY_ID, gitEnv: childEnvironment("git") })).toBe(true);
    expect(remoteRefs(f.remote)).toEqual(emptyRefs);

    seedLanding(f.first, f.remote, f.targets[0]!, "2026-10-09", 1, 400);
    const populatedRefs = remoteRefs(f.remote);
    expect(await auditLandingInventory({ cwd: f.second, remote: "origin", repositoryId: BUILD_REPOSITORY_ID, gitEnv: childEnvironment("git") })).toBe(true);
    expect(remoteRefs(f.remote)).toEqual(populatedRefs);
  });

  it("publishes one annotated version tag and its full-SHA claim as the same atomic object", async () => {
    const f = fixture();
    const allocateLanding = await loadAllocator();
    const beforeDevelop = git(f.remote, ["--git-dir", f.remote, "rev-parse", "refs/heads/develop"]);
    const result = await allocateLanding(inputFor(f.first, "origin", f.targets[1]!));

    expect(result).toMatchObject({ tag: "v2026.10.09.1", created: true, record: {
      repository_id: BUILD_REPOSITORY_ID, revision: f.targets[1], branch: "develop", version: "2026.10.09.1",
      original_run_id: 101, created_at: "2026-10-09T12:00:00Z",
    } });
    const refs = remoteRefs(f.remote);
    expect(refs.find(ref => ref.ref === `refs/tags/${result.tag}`)?.object).toBe(result.object);
    expect(refs.find(ref => ref.ref === `refs/tags/identity/landing/${f.targets[1]}`)?.object).toBe(result.object);
    expect(refs.find(ref => ref.ref === "refs/heads/develop")?.object).toBe(beforeDevelop);
    git(f.first, ["fetch", "--no-tags", f.remote, "+refs/tags/*:refs/tags/*"]);
    expect(readLandingTag(f.first, result.tag, BUILD_REPOSITORY_ID).record).toEqual(result.record);
  });

  it("reuses the original SHA claim after a later-day retry and ignores stale checkout tags", async () => {
    const f = fixture();
    const allocateLanding = await loadAllocator();
    const first = await allocateLanding(inputFor(f.first, f.remote, f.targets[0]!));
    const retry = await allocateLanding(inputFor(f.first, f.remote, f.targets[0]!, "2026-10-10T00:01:00Z", 202));
    expect(retry).toMatchObject({ tag: first.tag, object: first.object, created: false, record: first.record });
    expect(remoteRefs(f.remote).filter(ref => /^refs\/tags\/v2026\./.test(ref.ref))).toHaveLength(1);
  });

  it("counts the complete remote inventory rather than only tags in the caller checkout", async () => {
    const f = fixture(2);
    const allocateLanding = await loadAllocator();
    seedLanding(f.first, f.remote, f.targets[0]!, "2026-10-09", 1, 100);
    const result = await allocateLanding(inputFor(f.second, f.remote, f.targets[1]!));
    expect(result.tag).toBe("v2026.10.09.2");
  });

  it("uses numeric sequences and refuses a gap instead of reusing a deleted number", async () => {
    const f = fixture(10);
    const allocateLanding = await loadAllocator();
    for (let index = 0; index < 9; index += 1) {
      seedLanding(f.first, f.remote, f.targets[index]!, "2026-10-09", index + 1, index + 1);
    }
    const tenth = await allocateLanding(inputFor(f.second, f.remote, f.targets[9]!));
    expect(tenth.tag).toBe("v2026.10.09.10");
    git(f.remote, ["--git-dir", f.remote, "update-ref", "-d", "refs/tags/v2026.10.09.5"]);
    git(f.remote, ["--git-dir", f.remote, "update-ref", "-d", `refs/tags/identity/landing/${f.targets[4]}`]);
    expect(() => allocateLanding(inputFor(f.second, f.remote, f.targets[8]!))).toThrow(/not contiguous/);
  }, 60_000);

  it("starts a new UTC-day sequence at one while same-day publication order chooses N", async () => {
    const f = fixture(3);
    const allocateLanding = await loadAllocator();
    const first = await allocateLanding(inputFor(f.first, f.remote, f.targets[0]!, "2026-10-09T23:59:59Z", 201));
    const second = await allocateLanding(inputFor(f.second, f.remote, f.targets[1]!, "2026-10-09T00:00:01Z", 200));
    const nextDay = await allocateLanding(inputFor(f.first, f.remote, f.targets[2]!, "2026-10-10T00:00:00Z", 202));
    expect(first.tag).toBe("v2026.10.09.1");
    expect(second.tag).toBe("v2026.10.09.2");
    expect(second.record.original_run_id).toBe(200);
    expect(nextDay.tag).toBe("v2026.10.10.1");
  });

  it("reconciles a lost push response by reading the accepted pair back", async () => {
    const f = fixture();
    const allocateLanding = await loadAllocator();
    const shim = makeGitShim(f.root);
    process.env.LANDING_GIT_REAL = realGit;
    process.env.LANDING_GIT_LOSE_RESPONSE = "1";
    const result = await withPath(shim.path, () => allocateLanding(inputFor(f.first, f.remote, f.targets[0]!)));
    expect(result).toMatchObject({ tag: "v2026.10.09.1", created: true });
    expect(remoteRefs(f.remote).filter(ref => ref.ref.startsWith("refs/tags/identity/landing/"))).toHaveLength(1);
  });

  it("keeps different revisions from claiming one day and sequence in a concurrent race", async () => {
    const f = fixture();
    const shim = makeGitShim(f.root);
    const barrier = join(f.root, "push-barrier");
    mkdirSync(barrier);
    const env = { ...process.env, PATH: shim.path, LANDING_GIT_REAL: realGit, LANDING_GIT_PUSH_BARRIER: barrier };
    const [left, right] = await Promise.all([
      runAllocatorProcess(inputFor(f.first, f.remote, f.targets[0]!), env),
      runAllocatorProcess(inputFor(f.second, f.remote, f.targets[1]!), env),
    ]);
    expect([left.code, right.code]).toEqual([0, 0]);
    const results = [JSON.parse(left.stdout).result, JSON.parse(right.stdout).result] as Array<{ tag: string; record: { revision: string } }>;
    expect(results.map(result => result.tag).sort()).toEqual(["v2026.10.09.1", "v2026.10.09.2"]);
    for (const result of results) {
      const claim = remoteRefs(f.remote).find(ref => ref.ref === `refs/tags/identity/landing/${result.record.revision}`);
      expect(claim).toBeDefined();
      expect(claim?.object).toBe(remoteRefs(f.remote).find(ref => ref.ref === `refs/tags/${result.tag}`)?.object);
    }
  }, 60_000);

  it("keeps one original identity when the same SHA races with different event dates", async () => {
    const f = fixture(3);
    seedLanding(f.first, f.remote, f.targets[2]!, "2026-10-09", 1, 300);
    const shim = makeGitShim(f.root);
    const barrier = join(f.root, "push-barrier");
    mkdirSync(barrier);
    const env = { ...process.env, PATH: shim.path, LANDING_GIT_REAL: realGit, LANDING_GIT_PUSH_BARRIER: barrier };
    const [left, right] = await Promise.all([
      runAllocatorProcess(inputFor(f.first, f.remote, f.targets[0]!, "2026-10-09T23:59:59Z", 301), env),
      runAllocatorProcess(inputFor(f.second, f.remote, f.targets[0]!, "2026-10-10T00:00:01Z", 302), env),
    ]);
    expect([left.code, right.code]).toEqual([0, 0]);
    const results = [JSON.parse(left.stdout).result, JSON.parse(right.stdout).result] as Array<{ tag: string; object: string; record: Record<string, unknown> }>;
    expect(results[0]).toMatchObject({ tag: results[1]!.tag, object: results[1]!.object, record: results[1]!.record });
    expect(["v2026.10.09.2", "v2026.10.10.1"]).toContain(results[0]!.tag);
    expect(remoteRefs(f.remote).filter(ref => /^refs\/tags\/v2026\./.test(ref.ref))).toHaveLength(2);
    expect(remoteRefs(f.remote).filter(ref => ref.ref === `refs/tags/identity/landing/${f.targets[0]}`)).toHaveLength(1);
  }, 60_000);

  it("refuses malformed reserved version refs", async () => {
    const f = fixture();
    const allocateLanding = await loadAllocator();
    git(f.first, ["tag", "v2026.10.09.01", f.targets[0]!]);
    git(f.first, ["push", f.remote, "refs/tags/v2026.10.09.01"]);
    expect(() => allocateLanding(inputFor(f.second, f.remote, f.targets[1]!))).toThrow(/malformed reserved landing tag/);
  });

  it("rejects a hand-made public version tag without a full-SHA claim", async () => {
    const f = fixture();
    const allocateLanding = await loadAllocator();
    const publicOnly = seedPublicLandingOnly(f.first, f.remote, f.targets[0]!, "2026-10-09", 1, 401);

    expect(remoteRefs(f.remote)).toContainEqual({ object: publicOnly.object, ref: `refs/tags/${publicOnly.tag}` });
    expect(remoteRefs(f.remote).some(ref => ref.ref === `refs/tags/identity/landing/${f.targets[0]}`)).toBe(false);
    expect(() => allocateLanding(inputFor(f.second, f.remote, f.targets[1]!)))
      .toThrow(/landing public tag, claim and annotation disagree/);
  });

  it("audit rejects a public landing tag without its SHA claim", async () => {
    const f = fixture();
    const auditLandingInventory = await loadInventoryAuditor();
    const publicOnly = seedPublicLandingOnly(f.first, f.remote, f.targets[0]!, "2026-10-09", 1, 403);

    expect(remoteRefs(f.remote)).toContainEqual({ object: publicOnly.object, ref: `refs/tags/${publicOnly.tag}` });
    expect(remoteRefs(f.remote).some(ref => ref.ref === `refs/tags/identity/landing/${f.targets[0]}`)).toBe(false);
    expect(() => auditLandingInventory({ cwd: f.second, remote: "origin", repositoryId: BUILD_REPOSITORY_ID, gitEnv: childEnvironment("git") }))
      .toThrow(/landing public tag, claim and annotation disagree/);
  });

  it("rejects a full-SHA claim that points to a different tag object", async () => {
    const f = fixture();
    const allocateLanding = await loadAllocator();
    const day = "2026-10-09";
    const number = 1;
    const runId = 402;
    seedLanding(f.first, f.remote, f.targets[0]!, day, number, runId);
    const version = `${day.replaceAll("-", ".")}.${number}`;
    const record = { schema: 1, kind: "landing", repository_id: BUILD_REPOSITORY_ID, revision: f.targets[0],
      branch: "develop", version, original_run_id: runId, created_at: `${day}T12:00:00Z` };
    const alternateObject = git(f.remote, ["mktag"],
      `object ${f.targets[0]}\ntype commit\ntag v${version}\n` +
      "tagger fixture <fixture@example.invalid> 1000000000 +0000\n\n" + JSON.stringify(record) + "\n");
    git(f.remote, ["update-ref", `refs/tags/identity/landing/${f.targets[0]}`, alternateObject]);

    const publicObject = remoteRefs(f.remote).find(ref => ref.ref === `refs/tags/v${version}`)?.object;
    expect(alternateObject).not.toBe(publicObject);
    expect(remoteRefs(f.remote)).toContainEqual({ object: alternateObject, ref: `refs/tags/identity/landing/${f.targets[0]}` });
    expect(() => allocateLanding(inputFor(f.second, f.remote, f.targets[1]!)))
      .toThrow(/landing public tag, claim and annotation disagree/);
  });

  it("rejects the whole pair when the receiver refuses the SHA claim", async () => {
    const f = fixture();
    const allocateLanding = await loadAllocator();
    const hook = join(f.remote, "hooks", "update");
    writeFileSync(hook, `#!/bin/sh\nif [ "$1" = "refs/tags/identity/landing/${f.targets[0]}" ]; then exit 1; fi\nexit 0\n`);
    chmodSync(hook, 0o755);
    expect(() => allocateLanding(inputFor(f.first, f.remote, f.targets[0]!))).toThrow();
    expect(remoteRefs(f.remote).filter(ref => ref.ref.startsWith("refs/tags/v2026."))).toHaveLength(0);
    expect(remoteRefs(f.remote).filter(ref => ref.ref.startsWith("refs/tags/identity/landing/"))).toHaveLength(0);
  });
});
