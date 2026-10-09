import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { makeReleaseTarball, revisionOf, runScript, writeReleaseTree } from "./releaseFixture.js";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const scratch: string[] = [];
const json = (value: unknown) => `${JSON.stringify(value)}\n`;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture(onStop = ":", withAttempt = false) {
  const base = mkdtempSync(join(tmpdir(), "kaoiro-runner-release-gate-"));
  scratch.push(base);
  const root = join(base, "install"), history = join(base, "history"), configDir = join(base, "config");
  for (const path of [root, history, configDir]) mkdirSync(path, { mode: 0o700 });
  const source = revisionOf("release-gate-source"), target = revisionOf("release-gate-target");
  const tree = writeReleaseTree(join(root, "releases", source), source, { manifest: false });
  const deploy = join(tree, "deploy"), toolRoot = join(deploy, "release-tools");
  execFileSync(process.execPath, [join(repo, "scripts/production-release-tools.mjs"), "stage", "--source", repo, "--destination", toolRoot]);
  const exportRoot = join(base, "recording-tools");
  execFileSync(process.execPath, [join(repo, "scripts/production-release-tools.mjs"), "stage", "--source", repo, "--destination", exportRoot]);
  execFileSync(process.execPath, [join(repo, "scripts/build-release-manifest.mjs"), tree]);
  symlinkSync(`releases/${source}`, join(root, "current"));
  const tool = JSON.parse(readFileSync(join(toolRoot, "TOOL-MANIFEST.json"), "utf8")) as { sha256: string };
  const descriptor = { schema: 1, install_root: root, transport: "local", recording_hostname: hostname(), root: history,
    tool_sha256: tool.sha256, exporter_path: join(exportRoot, "scripts/production-release-launcher.mjs"),
    node_major: Number(process.versions.node.split(".")[0]), node_path: process.execPath };
  const authority = json(descriptor);
  writeFileSync(join(root, "release-authority.json"), authority, { mode: 0o600 });
  writeFileSync(join(root, "release-host-aliases.json"), json([{ alias: "worker-a", runtime_host_id: "private-runner-marker" }]), { mode: 0o600 });
  writeFileSync(join(configDir, "runner.config.json"), json({ host_id: "private-runner-marker" }), { mode: 0o600 });
  const calls = join(base, "service-calls"), systemctl = join(base, "systemctl");
  writeFileSync(systemctl, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\ncase "$*" in\n*"show -p ExecStart"*) printf '{ path=${root}/current/deploy/kaoiro-runner-launch.sh ; argv[]=${root}/current/deploy/kaoiro-runner-launch.sh ; }\\n' ;;\n*" stop "*) ${onStop.replaceAll("@@EXPORTER@@", descriptor.exporter_path)} ;;\nesac\nexit 0\n`, { mode: 0o755 });
  const systemdRun = join(base, "systemd-run");
  writeFileSync(systemdRun, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, 'QUEUE '+JSON.stringify(process.argv.slice(2))+'\\n');\n`, { mode: 0o755 });
  const archive = makeReleaseTarball(join(base, "archive"), target);
  const env = { KAOIRO_RUNNER_DIR: configDir, KAOIRO_SYSTEMCTL: systemctl, KAOIRO_SYSTEMD_RUN: systemdRun, KAOIRO_RUNNER_SERVER_URL: "", KAOIRO_RUNNER_ENV: join(base, "absent.env") };
  const pending = () => {
    const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e",
      `import {startReleaseAttempt} from ${JSON.stringify(join(repo, "scripts/production-release-record.mjs"))};
       import {artifactBuildIdentity,BUILD_REPOSITORY_ID} from ${JSON.stringify(join(repo, "scripts/build-identity.mjs"))};
       const identity=artifactBuildIdentity({revision:${JSON.stringify(target)},dirty:false,version:'2026.10.09.1',branch:'develop',channel:'dev',landing:{schema:1,kind:'landing',repository_id:BUILD_REPOSITORY_ID,revision:${JSON.stringify(target)},branch:'develop',version:'2026.10.09.1',original_run_id:1,created_at:'2026-10-09T00:00:00Z'}});
       console.log(JSON.stringify(startReleaseAttempt(${JSON.stringify(history)},identity,['worker-a'],[],{runtime_hosts:[{alias:'worker-a',runtime_host_id:'private-runner-marker'}],authority:{server:{root:${JSON.stringify(root)},sha256:${JSON.stringify(digest(authority))}},runners:[{alias:'worker-a',root:${JSON.stringify(root)},sha256:${JSON.stringify(digest(authority))}}]}})));`], { encoding: "utf8" })) as { dir: string; plan: { attempt_uuid: string } };
    return { dir: result.dir, uuid: result.plan.attempt_uuid, sha: digest(readFileSync(join(result.dir, "attempt.json"))) };
  };
  const context = withAttempt ? pending() : undefined;
  if (context) {
    const copies = join(root, "production-attempts");
    mkdirSync(copies, { mode: 0o700 });
    const copy = join(copies, context.uuid);
    mkdirSync(copy, { mode: 0o700 });
    writeFileSync(join(copy, "attempt.json"), readFileSync(join(context.dir, "attempt.json")), { mode: 0o600 });
  }
  const contextArgs = context ? ["--release-attempt", context.uuid, "--release-plan-sha256", context.sha, "--release-target", target] : [];
  const update = (args: string[] = []) => runScript(join(deploy, "kaoiro-runner-update.sh"), ["--install-dir", root, "--tarball", archive, ...contextArgs, ...args], env);
  const seen = () => existsSync(calls) ? readFileSync(calls, "utf8") : "";
  return { base, root, history, source, target, deploy, archive, update, pending, context, contextArgs, env, seen };
}

it("the real enrolled updater audits, seals its proof, switches, and releases its lock", () => {
  const f = fixture();
  const result = f.update();
  expect(result.status, result.stderr).toBe(0);
  expect(f.seen()).toContain("--user stop kaoiro-runner");
  expect(f.seen()).toContain("--user start kaoiro-runner");
  expect(readlinkSync(join(f.root, "current"))).toBe(`releases/${f.target}`);
  expect(existsSync(join(f.root, ".lock.update"))).toBe(false);
  expect(existsSync(join(f.root, "release-audits"))).toBe(true);
});

it("own X continues through the actual worker, and the post-stop switch needs no exporter", () => {
  const f = fixture("mv '@@EXPORTER@@' '@@EXPORTER@@.offline'", true);
  const result = f.update();
  expect(result.status, result.stderr).toBe(0);
  expect(readlinkSync(join(f.root, "current"))).toBe(`releases/${f.target}`);
  expect(f.seen()).toContain("--user start kaoiro-runner");
});

it("an enrolled updater exempts its own X and refuses a different in-progress Y before stop or detach", () => {
  const f = fixture(":", true);
  f.pending();
  for (const args of [[], ["--detach"]]) {
    const result = f.update([...args, "--skip-release-reconciliation", f.context!.uuid, "--skip-reason", "operator deferred only X"]);
    expect(result.status, result.stderr).toBe(78);
    expect(result.stderr).toContain("unresolved attempts");
    expect(f.seen()).toBe("");
    expect(readlinkSync(join(f.root, "current"))).toBe(`releases/${f.source}`);
  }
});

it("the actual worker repeats its audit under the update lock before preparing an archive", () => {
  const f = fixture(":", true), y = f.pending(), staged = join(f.base, "staged-y");
  renameSync(y.dir, staged);
  const bin = join(f.base, "bin");
  mkdirSync(bin);
  const realMkdir = execFileSync("/bin/sh", ["-c", "command -v mkdir"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "mkdir"), `#!/bin/sh\nif [ "$#" -eq 3 ] && [ "$3" = '${f.root}/.lock.update' ]; then mv '${staged}' '${y.dir}'; fi\nexec '${realMkdir}' "$@"\n`, { mode: 0o755 });
  const result = runScript(join(f.deploy, "kaoiro-runner-update.sh"), ["--install-dir", f.root, "--tarball", f.archive, ...f.contextArgs, "--skip-release-reconciliation", f.context!.uuid, "--skip-reason", "operator deferred only X"], { ...f.env, PATH: `${bin}:${process.env.PATH}` });
  expect(result.status, result.stderr).toBe(78);
  expect(result.stderr).toContain("Executed worker reconciliation refused before prepare");
  expect(existsSync(join(f.root, "releases", f.target))).toBe(false);
  expect(f.seen()).toBe("");
});

it("ordinary enrolled detach captures the launcher, authority and closure before its worker can execute", () => {
  const f = fixture();
  const queued = f.update(["--detach"]);
  expect(queued.status, queued.stderr).toBe(0);
  const line = f.seen().split("\n").find(line => line.startsWith("QUEUE "));
  expect(line).toBeDefined();
  const argv = JSON.parse(line!.slice(6)) as string[];
  expect(argv).toContain("--expand-environment=no");
  const command = argv.slice(argv.indexOf("--") + 1);
  expect(command[1]).toBe(join(f.deploy, "release-tools/scripts/production-release-launcher.mjs"));
  expect(command).toContain("--expected-authority-sha256");
  writeFileSync(join(f.deploy, "kaoiro-runner-common.sh"), `${readFileSync(join(f.deploy, "kaoiro-runner-common.sh"), "utf8")}\n`);
  const result = runScript(command[0]!, command.slice(1), f.env);
  expect(result.status, result.stderr).toBe(78);
  expect(result.stderr).toContain("actual updater closure differs");
  expect(f.seen()).not.toContain("--user stop kaoiro-runner");
  expect(readlinkSync(join(f.root, "current"))).toBe(`releases/${f.source}`);
});

it("a late proof refusal restarts the unchanged source", () => {
  const f = fixture(`printf 'corrupt' > "$KAOIRO_GATE_ROOT/.lock.update/release-switch-proof.json"`);
  const result = runScript(join(f.deploy, "kaoiro-runner-update.sh"), ["--install-dir", f.root, "--tarball", f.archive], { ...f.env, KAOIRO_GATE_ROOT: f.root });
  expect(result.status, result.stderr).toBe(70);
  expect(f.seen()).toContain("--user start kaoiro-runner");
  expect(readlinkSync(join(f.root, "current"))).toBe(`releases/${f.source}`);
});


it("a direct enrolled switch cannot use an exact UUID skip for A to cover unfinished B", () => {
  const f = fixture(":", true);
  f.pending();
  writeReleaseTree(join(f.root, "releases", f.target), f.target);
  const result = runScript(join(f.deploy, "kaoiro-runner-switch.sh"), [f.target,
    "--install-dir", f.root, "--skip-release-reconciliation", f.context!.uuid,
    "--skip-reason", "operator deferred only A"], f.env);
  expect(result.status, result.stderr).toBe(78);
  expect(result.stderr).toContain("unresolved attempts");
  expect(readlinkSync(join(f.root, "current"))).toBe(`releases/${f.source}`);
  expect(f.seen()).toBe("");
});
