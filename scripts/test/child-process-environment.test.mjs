import { isolationNodeOptions } from "./fixtures/test-isolation.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHILD_PATH, childEnvironment, execChildSync, spawnChildSync } from "../child-process-environment.mjs";
import { checkReleaseChildEnvironments } from "../check-release-child-environments.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hostile = { PATH: "/attacker", GIT_DIR: "/attacker", GIT_WORK_TREE: "/attacker",
  GIT_EXEC_PATH: "/attacker", GIT_SSH: "/attacker", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "evil",
  LD_PRELOAD: "/attacker", NODE_OPTIONS: "--import=/attacker", GH_TOKEN: "inert-secret", EXTRA_SECRET: "secret", KAOIRO_RELEASE_RETAINED_UNIT: "retired-worker" };
// The test isolation boundary gives every child exactly its own preload in
// NODE_OPTIONS; a leaked hostile value would be kept in front of it.
const expectedChild = key => key === "NODE_OPTIONS" ? isolationNodeOptions() : undefined;

test("default constructor executes a real child with a closed environment", () => {
  const saved = { ...process.env };
  Object.assign(process.env, hostile);
  try {
    const actual = JSON.parse(execChildSync("git", process.execPath, ["-e", "console.log(JSON.stringify(process.env))"], { encoding: "utf8" }));
    for (const key of Object.keys(hostile).filter(key => key !== "PATH")) assert.equal(actual[key], expectedChild(key), key);
    assert.equal(actual.PATH, CHILD_PATH);
    assert.equal(actual.GIT_CONFIG_GLOBAL, "/dev/null");
  } finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
});

test("each operation's explicit keys preserve only its intended authority", () => {
  for (const profile of ["git", "ci-git", "ssh-git", "ssh", "gh", "systemd", "authority", "runner", "build"]) {
    const env = childEnvironment(profile, { ...hostile, SSH_AUTH_SOCK: "/fixture/socket", DBUS_SESSION_BUS_ADDRESS: "unix:path=/fixture/bus" });
    assert.equal(env.PATH, profile === "build" ? hostile.PATH : CHILD_PATH);
    for (const key of ["GIT_DIR", "GIT_EXEC_PATH", "GIT_SSH", "LD_PRELOAD", "NODE_OPTIONS", "EXTRA_SECRET"]) assert.equal(env[key], undefined, profile + key);
    assert.equal(env.GH_TOKEN, profile === "gh" ? hostile.GH_TOKEN : undefined);
  }
  const runnerKeys = { KAOIRO_NODE: "/fixture/node", KAOIRO_RUNNER_DIR: "/fixture/config", INVOCATION_ID: "fixture-invocation" };
  const runner = childEnvironment("runner", { ...hostile, ...runnerKeys });
  for (const [key, value] of Object.entries(runnerKeys)) assert.equal(runner[key], value);
  assert.equal(runner.KAOIRO_RELEASE_RETAINED_UNIT, undefined);
  assert.throws(() => childEnvironment("unknown"));
  assert.equal(childEnvironment("ci-git", hostile).GIT_CONFIG_VALUE_0, "AUTHORIZATION: basic " + Buffer.from("x-access-token:inert-secret").toString("base64"));
});

test("build children retain the exact selected toolchain PATH without ambient credentials", () => {
  const selectedPath = "/fixture/toolchain:/fixture/compiler:/fixture/toolchain";
  const actual = JSON.parse(execChildSync("build", process.execPath,
    ["-e", "console.log(JSON.stringify(process.env))"],
    { encoding: "utf8", env: { ...hostile, PATH: selectedPath, PNPM_HOME: "/fixture/toolchain" } }));
  assert.equal(actual.PATH, selectedPath);
  assert.equal(actual.PNPM_HOME, "/fixture/toolchain");
  for (const key of Object.keys(hostile).filter(key => key !== "PATH")) assert.equal(actual[key], expectedChild(key), key);
  for (const value of [undefined, "", null, 1]) {
    assert.equal(childEnvironment("build", { PATH: value }).PATH, CHILD_PATH);
  }
});

test("coverage check rejects separate existing and new bypasses and its own disabled guard", () => {
  const green = checkReleaseChildEnvironments(root);
  assert.equal(green.files, 3); assert.ok(green.calls >= 11);
  assert.equal(green.unchanged_legacy_calls, 4);
  for (const target of ["scripts/build-identity.mjs", "scripts/with-build-identity.mjs",
    "server/deploy/kaoiro-server-deploy.mjs"]) {
    assert.throws(() => checkReleaseChildEnvironments(root, (path, encoding) => {
      const source = readFileSync(path, encoding);
      return path.endsWith(target) ? source + "\nspawnSync('unsafe', []);\n" : source;
    }), /unmanaged child process/);
  }
});

test("coverage pins import-only, spawn/fork, exact legacy count and both scope-presence checks", () => {
  const mutate = (target, transform) => () => checkReleaseChildEnvironments(root, (path, encoding) => {
    const source = readFileSync(path, encoding);
    return path.endsWith(target) ? transform(source) : source;
  });
  for (const target of ["scripts/build-identity.mjs", "scripts/with-build-identity.mjs", "server/deploy/kaoiro-server-deploy.mjs"]) {
    for (const extra of ["import cp from 'node:child_process';", "spawn('unsafe', []);", "fork('unsafe');"]) {
      assert.throws(mutate(target, source => source + "\n" + extra), /unmanaged/);
    }
    assert.throws(mutate(target, source => source.replace("child-process-environment.mjs", "missing-helper.mjs")), /helper import missing/);
    assert.throws(mutate(target, source => source.replaceAll("spawnChildSync", "unusedChild").replaceAll("execChildSync", "unusedExec")), /no checked call/);
  }
  assert.throws(mutate("runner/deploy/codex-service.mjs", source => source + "\nexecFileSync('unsafe', []);"), /unmanaged/);
});

test("gh keyring session values reach a real child without SSH or loader authority", () => {
  // Session pointers live in an owned directory: the isolation boundary would
  // replace a host-like pointer, which would hide whether the product kept it.
  const session = mkdtempSync(join(tmpdir(), "kaoiro-gh-session-"));
  try {
    const env = { ...hostile, DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(session, "bus")}`, XDG_RUNTIME_DIR: join(session, "runtime"), SSH_AUTH_SOCK: "/fixture/ssh" };
    const actual = JSON.parse(execChildSync("gh", process.execPath, ["-e", "console.log(JSON.stringify(process.env))"], { encoding: "utf8", env }));
    assert.equal(actual.DBUS_SESSION_BUS_ADDRESS, env.DBUS_SESSION_BUS_ADDRESS);
    assert.equal(actual.XDG_RUNTIME_DIR, env.XDG_RUNTIME_DIR);
    assert.equal(actual.SSH_AUTH_SOCK, undefined);
    assert.equal(actual.LD_PRELOAD, undefined);
    assert.equal(actual.GIT_DIR, undefined);
  } finally { rmSync(session, { recursive: true, force: true }); }
});


test("the checker enumerates every source directory and follows new relative dependencies", () => {
  const scratch = mkdtempSync(join(tmpdir(), "kaoiro-child-sources-"));
  const fixture = join(scratch, "repository");
  try {
    for (const dir of ["scripts", "scripts/lib", "server/deploy", "runner/deploy", "extra"]) mkdirSync(join(fixture, dir), { recursive: true });
    writeFileSync(join(fixture, "runner/deploy/child-process-environment.mjs"), "export function execChildSync() {}\n");
    for (const file of ["scripts/build-identity.mjs", "scripts/with-build-identity.mjs", "server/deploy/kaoiro-server-deploy.mjs"]) {
      const path = file.startsWith("scripts/") ? "../runner/deploy/child-process-environment.mjs" : "../../runner/deploy/child-process-environment.mjs";
      writeFileSync(join(fixture, file), `import { execChildSync } from ${JSON.stringify(path)};\nexecChildSync('git', 'git', []);\n`);
    }
    assert.equal(checkReleaseChildEnvironments(fixture).files, 3);
    for (const dir of ["scripts", "scripts/lib", "server/deploy", "runner/deploy"]) {
      const added = join(fixture, dir, "unchecked.mjs");
      writeFileSync(added, "import cp from 'node:child_process';\n");
      assert.throws(() => checkReleaseChildEnvironments(fixture), /unmanaged/);
      rmSync(added);
    }
    const source = join(fixture, "scripts/build-identity.mjs"), original = readFileSync(source, "utf8");
    writeFileSync(source, original + "import '../extra/dependency.mjs';\n");
    const dependency = join(fixture, "extra/dependency.mjs");
    writeFileSync(dependency, "spawn('unsafe', []);\n");
    assert.throws(() => checkReleaseChildEnvironments(fixture), /unmanaged/);
    writeFileSync(dependency, "export const valid = true;\n");
    assert.equal(checkReleaseChildEnvironments(fixture).calls, 3);
    rmSync(dependency);
    symlinkSync(join(fixture, "runner/deploy/child-process-environment.mjs"), dependency);
    assert.throws(() => checkReleaseChildEnvironments(fixture), /regular unlinked file/);
    rmSync(dependency);
    writeFileSync(dependency, "export const valid = true;\n");
    const scope = join(fixture, "scripts/lib");
    rmSync(scope, { recursive: true });
    symlinkSync(join(fixture, "extra"), scope);
    assert.throws(() => checkReleaseChildEnvironments(fixture), /linked child source directory/);
    rmSync(scope);
    mkdirSync(scope);
    for (let index = 0; index < 513; index++) writeFileSync(join(scope, `bound-${index}.mjs`), "");
    assert.throws(() => checkReleaseChildEnvironments(fixture), /file bound/);
    rmSync(scope, { recursive: true });
    mkdirSync(scope);
    writeFileSync(join(scratch, "outside.mjs"), "export const outside = true;\n");
    writeFileSync(source, original + "import '../../outside.mjs';\n");
    assert.throws(() => checkReleaseChildEnvironments(fixture), /escapes repository/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
