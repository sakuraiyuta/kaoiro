import { isolationNodeOptions } from "./fixtures/test-isolation.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { CHILD_PATH, childEnvironment, execChildSync, spawnChildSync } from "../child-process-environment.mjs";
import { checkReleaseChildEnvironments } from "../check-release-child-environments.mjs";
import { releaseAuthorityRequest } from "../production-release-authority.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hostile = { PATH: "/attacker", GIT_DIR: "/attacker", GIT_WORK_TREE: "/attacker",
  GIT_EXEC_PATH: "/attacker", GIT_SSH: "/attacker", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "evil",
  LD_PRELOAD: "/attacker", NODE_OPTIONS: "--import=/attacker", GH_TOKEN: "inert-secret", EXTRA_SECRET: "secret" };
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

test("release authority launches exclude ambient secrets", () => {
  const originalExec = childProcess.execFileSync, captured = [];
  childProcess.execFileSync = (file, args, options) => {
    captured.push(options.env);
    return JSON.stringify({ schema: 1, nonce: "fixture", root: "/fixture/history", recording_hostname: "fixture",
      tool_sha256: "a".repeat(64), node_major: Number(process.versions.node.split(".")[0]) });
  };
  syncBuiltinESMExports();
  try {
    const saved = { ...process.env };
    Object.assign(process.env, hostile);
    try {
      releaseAuthorityRequest({ status: "enrolled", descriptor: { transport: "local", root: "/fixture/history", recording_hostname: "fixture",
        tool_sha256: "a".repeat(64), node_path: process.execPath, exporter_path: "/fixture/exporter", node_major: Number(process.versions.node.split(".")[0]) } }, { nonce: "fixture" });
    } finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
    assert.equal(captured.length, 1);
    for (const env of captured) for (const key of Object.keys(hostile).filter(key => key !== "PATH")) assert.equal(env[key], undefined, key);
  } finally { childProcess.execFileSync = originalExec; syncBuiltinESMExports(); }
});

test("coverage check rejects separate existing and new bypasses and its own disabled guard", () => {
  const green = checkReleaseChildEnvironments(root);
  assert.equal(green.files, 11); assert.ok(green.calls >= 23);
  assert.equal(green.unchanged_legacy_calls, 4);
  for (const target of ["scripts/production-release-authority.mjs", "scripts/build-identity.mjs", "scripts/with-build-identity.mjs",
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
