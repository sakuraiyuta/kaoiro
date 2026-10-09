import "./fixtures/host-systemd-guard.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync, execFile, spawn, execSync, exec, fork } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
import { installChildFixture } from "./fixtures/child-process-fixture.mjs";
import { execChildSync, spawnChildSync } from "../child-process-environment.mjs";

test("real user-manager commands are refused before native execution, including fixed PATH and symlinks", () => {
  for (const [file, args] of [["systemd-run", ["--version"]],
    ["/usr/bin/systemctl", ["--user", "show", "kaoiro-runner.service"]],
    ["busctl", ["--user", "list"]]]) {
    assert.throws(() => execChildSync("systemd", file, args), { code: "ERR_TEST_HOST_SYSTEMD" });
    assert.throws(() => spawnChildSync("systemd", file, args), { code: "ERR_TEST_HOST_SYSTEMD" });
  }
  const root = mkdtempSync(join(tmpdir(), "fuji571-systemd-guard-"));
  try {
    symlinkSync("/usr/bin/systemd-run", join(root, "fake"));
    assert.throws(() => execFileSync(join(root, "fake"), ["--version"]), { code: "ERR_TEST_HOST_SYSTEMD" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a new fixture maps an owned manager command before the shared safety boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "fuji571-systemd-fixture-"));
  writeFileSync(join(root, "systemd-run"), "#!/bin/sh\nprintf 'owned fixture'\n", { mode: 0o700 });
  const restore = installChildFixture(root);
  try {
    assert.equal(execChildSync("systemd", "systemd-run", ["--user"], { encoding: "utf8" }), "owned fixture");
  } finally { restore(); rmSync(root, { recursive: true, force: true }); }
});

test("the guard survives the product's NODE_OPTIONS-free Node child environment", () => {
  const helper = fileURLToPath(new URL("../child-process-environment.mjs", import.meta.url));
  const result = spawnChildSync("git", process.execPath, ["--input-type=module", "-e",
    `if(!globalThis[Symbol.for('kaoiro.test.host-systemd-guard')]) throw new Error('guard propagation missing');
     const {execChildSync}=await import(${JSON.stringify(helper)}); execChildSync('systemd','systemd-run',['--version']);`], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ERR_TEST_HOST_SYSTEMD/);
});

test("the real updater shell cannot use a production service name with its real manager", () => {
  const updater = fileURLToPath(new URL("../../runner/deploy/kaoiro-runner-update.sh", import.meta.url));
  const root = mkdtempSync(join(tmpdir(), "fuji571-updater-guard-"));
  try {
    const args = ["--install-dir", root, "--service", "kaoiro-runner", "--from-repo", root];
    assert.throws(() => spawnChildSync("runner", updater, args), { code: "ERR_TEST_HOST_SYSTEMD" });
    assert.throws(() => spawnSync("sh", [updater, ...args]), { code: "ERR_TEST_HOST_SYSTEMD" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the updater-shell safety self-test delegates only to an inert sink if its guard is cut", () => {
  const guard = fileURLToPath(new URL("./fixtures/host-systemd-guard.mjs", import.meta.url));
  const updater = fileURLToPath(new URL("../../runner/deploy/kaoiro-runner-update.sh", import.meta.url));
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import childProcess from 'node:child_process';
    delete globalThis[Symbol.for('kaoiro.test.host-systemd-guard')];
    childProcess.execFileSync = () => { throw new Error('inert updater sink reached'); };
    await import(${JSON.stringify(guard)} + '?updater-self-test');
    try { childProcess.execFileSync('sh',[${JSON.stringify(updater)},'--service','kaoiro-runner']); }
    catch(error) { if(error.code === 'ERR_TEST_HOST_SYSTEMD') process.exit(0); throw error; }
    process.exit(1);`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("the guard self-test uses an inert native sink if its refusal is removed", () => {
  const guard = fileURLToPath(new URL("./fixtures/host-systemd-guard.mjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import childProcess from 'node:child_process';
    delete globalThis[Symbol.for('kaoiro.test.host-systemd-guard')];
    childProcess.execFileSync = () => { throw new Error('inert native sink reached'); };
    await import(${JSON.stringify(guard)} + '?self-test');
    try { childProcess.execFileSync('/usr/bin/systemd-run',['--version']); }
    catch(error) { if(error.code === 'ERR_TEST_HOST_SYSTEMD') process.exit(0); throw error; }
    process.exit(1);`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("all shell and file overload refusals have the explicit safety error", () => {
  for (const work of [
    () => execFileSync("systemd-run", { encoding: "utf8" }),
    () => spawnSync("systemd-run", { stdio: "ignore" }),
    () => execFile("systemd-run", { encoding: "utf8" }, () => {}),
    () => spawn("systemd-run", { stdio: "ignore" }),
    () => execSync("systemd-run --version"),
    () => exec("systemd-run --version", () => {}),
    () => spawnSync("sh", ["-c", "systemd-run --version"]),
    () => spawnSync("bash", ["-lc", "systemctl --us --version"]),
    () => spawnSync("systemd-run", [], { shell: true }),
    () => fork("fixture.mjs", { execPath: "/usr/bin/systemd-run" }),
  ]) assert.throws(work, { code: "ERR_TEST_HOST_SYSTEMD" });
  for (const flag of ["--u", "--us", "--use", "--user", "--user=yes"]) {
    assert.throws(() => spawnSync("/usr/bin/systemctl", [flag, "--version"]), { code: "ERR_TEST_HOST_SYSTEMD" });
  }
});

test("safe overloads and promisified APIs retain their Node contracts", async () => {
  assert.equal(execFileSync("/usr/bin/true", { encoding: "utf8" }), "");
  assert.equal(spawnSync("/usr/bin/true", { encoding: "utf8" }).status, 0);
  await new Promise((resolve, reject) => execFile("/usr/bin/true", { encoding: "utf8" }, error => error ? reject(error) : resolve()));
  assert.equal((await promisify(execFile)("/usr/bin/true", { encoding: "utf8" })).stdout, "");
  assert.equal(execSync("printf owned", { encoding: "utf8" }), "owned");
  assert.equal((await promisify(exec)("printf owned", { encoding: "utf8" })).stdout, "owned");
});

test("fork and shell-launched Node carry the guard with a NODE_OPTIONS-free environment", async () => {
  const root = mkdtempSync(join(tmpdir(), "fuji571-guard-child-"));
  const module = join(root, "child.mjs");
  writeFileSync(module, "process.send(Boolean(globalThis[Symbol.for('kaoiro.test.host-systemd-guard')])); process.disconnect();");
  try {
    const child = fork(module, { env: {}, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const message = await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); child.once("exit", code => { if (code) reject(new Error('fork failed')); }); });
    assert.equal(message, true);
    const result = spawnSync("sh", ["-c", '"$1" --input-type=module -e "$2"', "sh", process.execPath,
      "process.exit(globalThis[Symbol.for('kaoiro.test.host-systemd-guard')] ? 0 : 1)"], { env: {}, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("all new safety decisions use inert native sinks in the mutation self-test", () => {
  const guard = fileURLToPath(new URL("./fixtures/host-systemd-guard.mjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import childProcess from 'node:child_process';
    delete globalThis[Symbol.for('kaoiro.test.host-systemd-guard')];
    for (const name of ['execFileSync','spawnSync','execFile','spawn','fork','execSync','exec'])
      childProcess[name] = () => { throw new Error('inert sink reached'); };
    await import(${JSON.stringify(guard)} + '?all-shapes-self-test');
    const checks = [
      () => childProcess.execSync('systemd-run --version'),
      () => childProcess.exec('systemd-run --version', () => {}),
      () => childProcess.spawnSync('sh',['-c','systemd-run --version']),
      () => childProcess.spawnSync('/usr/bin/systemctl',['--us','--version']),
      () => childProcess.execFile('systemd-run',{encoding:'utf8'},()=>{}),
      () => childProcess.fork('fixture.mjs',{execPath:'/usr/bin/systemd-run'}),
    ];
    for (const work of checks) {
      let refused = false;
      try { work(); } catch(error) { if(error.code !== 'ERR_TEST_HOST_SYSTEMD') throw error; refused = true; }
      if(!refused) throw new Error('safety decision missing');
    }
  `], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
