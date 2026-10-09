import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { CHILD_PATH, childEnvironment, execChildSync, spawnChildSync } from "../child-process-environment.mjs";
import { checkReleaseChildEnvironments } from "../check-release-child-environments.mjs";
import { operatorSshSnapshot } from "../landing-repair-ssh.mjs";
import { releaseAuthorityRequest } from "../production-release-authority.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hostile = { PATH: "/attacker", GIT_DIR: "/attacker", GIT_WORK_TREE: "/attacker",
  GIT_EXEC_PATH: "/attacker", GIT_SSH: "/attacker", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "evil",
  LD_PRELOAD: "/attacker", NODE_OPTIONS: "--import=/attacker", GH_TOKEN: "inert-secret", EXTRA_SECRET: "secret" };

test("default constructor executes a real child with a closed environment", () => {
  const saved = { ...process.env };
  Object.assign(process.env, hostile);
  try {
    const actual = JSON.parse(execChildSync("git", process.execPath, ["-e", "console.log(JSON.stringify(process.env))"], { encoding: "utf8" }));
    for (const key of Object.keys(hostile).filter(key => key !== "PATH")) assert.equal(actual[key], undefined, key);
    assert.equal(actual.PATH, CHILD_PATH);
    assert.equal(actual.GIT_CONFIG_GLOBAL, "/dev/null");
  } finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
});

test("each operation's explicit keys preserve only its intended authority", () => {
  for (const profile of ["git", "ci-git", "ssh-git", "ssh", "gh", "systemd", "authority", "runner", "build"]) {
    const env = childEnvironment(profile, { ...hostile, SSH_AUTH_SOCK: "/fixture/socket", DBUS_SESSION_BUS_ADDRESS: "unix:path=/fixture/bus" });
    assert.equal(env.PATH, CHILD_PATH);
    for (const key of ["GIT_DIR", "GIT_EXEC_PATH", "GIT_SSH", "LD_PRELOAD", "NODE_OPTIONS", "EXTRA_SECRET"]) assert.equal(env[key], undefined, profile + key);
    assert.equal(env.GH_TOKEN, profile === "gh" ? hostile.GH_TOKEN : undefined);
  }
  assert.throws(() => childEnvironment("unknown"));
  assert.equal(childEnvironment("ci-git", hostile).GIT_CONFIG_VALUE_0, "AUTHORIZATION: basic " + Buffer.from("x-access-token:inert-secret").toString("base64"));
});

test("existing authority and new repair SSH launches both exclude ambient secrets", () => {
  const original = childProcess.spawnSync, originalExec = childProcess.execFileSync, captured = [];
  childProcess.spawnSync = (file, args, options) => {
    captured.push(options.env);
    return { status: args[0] === "-G" ? 0 : 1, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "Hi OperatorOne! You've successfully authenticated, but GitHub does not provide shell access.\n" };
  };
  childProcess.execFileSync = (file, args, options) => {
    captured.push(options.env);
    return JSON.stringify({ schema: 1, nonce: "fixture", root: "/fixture/history", recording_hostname: "fixture",
      tool_sha256: "a".repeat(64), node_major: Number(process.versions.node.split(".")[0]) });
  };
  syncBuiltinESMExports();
  try {
    operatorSshSnapshot("OperatorOne", { env: hostile });
    const saved = { ...process.env };
    Object.assign(process.env, hostile);
    try {
      releaseAuthorityRequest({ status: "enrolled", descriptor: { transport: "local", root: "/fixture/history", recording_hostname: "fixture",
        tool_sha256: "a".repeat(64), node_path: process.execPath, exporter_path: "/fixture/exporter", node_major: Number(process.versions.node.split(".")[0]) } }, { nonce: "fixture" });
    } finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
    assert.equal(captured.length, 3);
    for (const env of captured) for (const key of Object.keys(hostile).filter(key => key !== "PATH")) assert.equal(env[key], undefined, key);
  } finally { childProcess.spawnSync = original; childProcess.execFileSync = originalExec; syncBuiltinESMExports(); }
});

test("coverage check rejects separate existing and new bypasses and its own disabled guard", () => {
  const green = checkReleaseChildEnvironments(root);
  assert.equal(green.files, 17); assert.ok(green.calls >= 25);
  for (const target of ["scripts/production-release-authority.mjs", "scripts/landing-repair-ssh.mjs"]) {
    assert.throws(() => checkReleaseChildEnvironments(root, (path, encoding) => {
      const source = readFileSync(path, encoding);
      return path.endsWith(target) ? source + "\nspawnSync('unsafe', []);\n" : source;
    }), /unmanaged child process/);
  }
});
