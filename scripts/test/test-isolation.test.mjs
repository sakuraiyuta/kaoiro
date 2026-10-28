import { permitHostAccess, registerForeignRoot } from "./fixtures/test-isolation.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync, execFile, spawn, execSync, exec, fork } from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import tls from "node:tls";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
import { installChildFixture } from "./fixtures/child-process-fixture.mjs";
import { childEnvironment, execChildSync, spawnChildSync } from "../child-process-environment.mjs";

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
    `if(!globalThis[Symbol.for('kaoiro.test.isolation')]) throw new Error('guard propagation missing');
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
  const guard = fileURLToPath(new URL("./fixtures/test-isolation.cjs", import.meta.url));
  const updater = fileURLToPath(new URL("../../runner/deploy/kaoiro-runner-update.sh", import.meta.url));
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import childProcess from 'node:child_process';
    delete globalThis[Symbol.for('kaoiro.test.isolation')];
    childProcess.execFileSync = () => { throw new Error('inert updater sink reached'); };
    { const { createRequire } = await import('node:module'); const load = createRequire(${JSON.stringify(guard)}); delete load.cache[${JSON.stringify(guard)}]; load(${JSON.stringify(guard)}); }
    try { childProcess.execFileSync('sh',[${JSON.stringify(updater)},'--service','kaoiro-runner']); }
    catch(error) { if(error.code === 'ERR_TEST_HOST_SYSTEMD') process.exit(0); throw error; }
    process.exit(1);`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("the guard self-test uses an inert native sink if its refusal is removed", () => {
  const guard = fileURLToPath(new URL("./fixtures/test-isolation.cjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import childProcess from 'node:child_process';
    delete globalThis[Symbol.for('kaoiro.test.isolation')];
    childProcess.execFileSync = () => { throw new Error('inert native sink reached'); };
    { const { createRequire } = await import('node:module'); const load = createRequire(${JSON.stringify(guard)}); delete load.cache[${JSON.stringify(guard)}]; load(${JSON.stringify(guard)}); }
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
  writeFileSync(module, "process.send(Boolean(globalThis[Symbol.for('kaoiro.test.isolation')])); process.disconnect();");
  try {
    const child = fork(module, { env: {}, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const message = await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); child.once("exit", code => { if (code) reject(new Error('fork failed')); }); });
    assert.equal(message, true);
    const result = spawnSync("sh", ["-c", '"$1" --input-type=module -e "$2"', "sh", process.execPath,
      "process.exit(globalThis[Symbol.for('kaoiro.test.isolation')] ? 0 : 1)"], { env: {}, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("all new safety decisions use inert native sinks in the mutation self-test", () => {
  const guard = fileURLToPath(new URL("./fixtures/test-isolation.cjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import childProcess from 'node:child_process';
    delete globalThis[Symbol.for('kaoiro.test.isolation')];
    for (const name of ['execFileSync','spawnSync','execFile','spawn','fork','execSync','exec'])
      childProcess[name] = () => { throw new Error('inert sink reached'); };
    { const { createRequire } = await import('node:module'); const load = createRequire(${JSON.stringify(guard)}); delete load.cache[${JSON.stringify(guard)}]; load(${JSON.stringify(guard)}); }
    const checks = [
      () => childProcess.execSync('systemd-run --version'),
      () => childProcess.exec('systemd-run --version', () => {}),
      () => childProcess.spawnSync('sh',['-c','systemd-run --version']),
      () => childProcess.spawnSync('true; systemd-run --version',[],{shell:true}),
      () => childProcess.spawnSync('sh',['-c','"$1" --version','sh','systemd-run']),
      () => childProcess.spawnSync('sh',['-c','"$1" "$2" --version','sh','systemctl','--user']),
      () => childProcess.spawnSync('sh',['-c','true','sh','--us']),
      ...['env','setsid','nohup','timeout','nice','xargs'].flatMap(launcher => [
        () => childProcess.spawnSync(launcher,['systemd-run','--version']),
        () => childProcess.spawnSync(launcher,['systemctl','--user','--version']),
        () => childProcess.spawnSync(launcher,['bash','-lc','systemd-run --version']),
      ]),
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

const MODULE = fileURLToPath(new URL("./fixtures/test-isolation.mjs", import.meta.url));
const PERMIT_PROBE = fileURLToPath(new URL("./fixtures/test-isolation-permit-probe.cjs", import.meta.url));
const CHILD_PATH_FOR_TESTS = `${dirname(process.execPath)}:/usr/bin:/bin`;
const HOST_TOOLS = ["systemctl", "systemd-run", "busctl", "journalctl", "loginctl", "gh", "docker"];

// Stand-in "host" programs: a foreign directory whose programs only record
// their argv and environment, so reaching one is observable and harmless.
function standIns() {
  const root = mkdtempSync(join(tmpdir(), "kaoiro577-standins-"));
  const bin = join(root, "bin"), sink = join(root, "sink.log");
  mkdirSync(bin);
  for (const name of HOST_TOOLS) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s %s|DOCKER_HOST=%s|DOCKER_CONFIG=%s|DOCKER_CONTEXT=%s|GH_CONFIG_DIR=%s|DBUS=%s|XDG=%s\\n' "${name}" "$*" "\${DOCKER_HOST-unset}" "\${DOCKER_CONFIG-unset}" "\${DOCKER_CONTEXT-unset}" "\${GH_CONFIG_DIR-unset}" "\${DBUS_SESSION_BUS_ADDRESS-unset}" "\${XDG_RUNTIME_DIR-unset}" >> ${JSON.stringify(sink)}\n`, { mode: 0o700 });
  }
  registerForeignRoot(root);
  return { root, bin, sink, calls: () => existsSync(sink) ? readFileSync(sink, "utf8").trim().split("\n") : [],
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function nodeEval(code, options = {}) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", ...options });
}

test("host tools outside owned roots are refused and never reach their sink", () => {
  const host = standIns();
  try {
    for (const name of HOST_TOOLS) {
      const code = ["systemctl", "systemd-run", "busctl", "journalctl", "loginctl"].includes(name)
        ? "ERR_TEST_HOST_SYSTEMD" : "ERR_TEST_HOST_TOOL";
      assert.throws(() => execFileSync(join(host.bin, name), ["--version"]), { code });
      assert.throws(() => execFileSync(name, ["--version"], { env: { PATH: `${host.bin}:/usr/bin:/bin` } }), { code });
      assert.throws(() => spawnSync("sh", ["-c", '"$1" --version', "sh", join(host.bin, name)]), { code: /ERR_TEST_HOST_/ });
      assert.throws(() => spawnSync("env", [join(host.bin, name), "--version"]), { code });
    }
    assert.deepEqual(host.calls(), []);
  } finally { host.cleanup(); }
});

test("owned fakes keep supplying behaviour", () => {
  const root = mkdtempSync(join(tmpdir(), "kaoiro577-owned-"));
  try {
    for (const name of ["gh", "docker", "systemctl"]) {
      writeFileSync(join(root, name), `#!/bin/sh\nprintf 'owned ${name}'\n`, { mode: 0o700 });
      assert.equal(execFileSync(name, [], { env: { PATH: `${root}:/usr/bin:/bin` }, encoding: "utf8" }), `owned ${name}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("relative and empty PATH elements are searched from the child's cwd, as the child does", () => {
  const host = standIns();
  const parent = mkdtempSync(join(tmpdir(), "kaoiro577-relative-path-"));
  const before = process.cwd();
  try {
    mkdirSync(join(parent, "bin"));
    for (const name of ["gh", "docker", "systemctl"]) {
      writeFileSync(join(parent, "bin", name), `#!/bin/sh\nprintf 'owned ${name}'\n`, { mode: 0o700 });
    }
    process.chdir(parent);
    for (const [name, code] of [["gh", "ERR_TEST_HOST_TOOL"], ["docker", "ERR_TEST_HOST_TOOL"], ["systemctl", "ERR_TEST_HOST_SYSTEMD"]]) {
      assert.throws(() => spawnSync(name, ["--version"], { cwd: host.root, env: { PATH: "bin" } }), { code });
      assert.throws(() => spawnSync(name, ["--version"], { cwd: host.bin, env: { PATH: ":/nonexistent" } }), { code });
      assert.equal(execFileSync(name, [], { cwd: parent, env: { PATH: "bin" }, encoding: "utf8" }), `owned ${name}`);
      assert.equal(execFileSync(name, [], { cwd: join(parent, "bin"), env: { PATH: "/nonexistent::" }, encoding: "utf8" }), `owned ${name}`);
    }
    assert.deepEqual(host.calls(), []);
  } finally {
    process.chdir(before);
    host.cleanup();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("issue 571 replay: a fixed PATH that skips the fake reaches a refusal, not the host", () => {
  const host = standIns();
  const fake = mkdtempSync(join(tmpdir(), "kaoiro577-skipped-fake-"));
  try {
    writeFileSync(join(fake, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    for (const [file, args] of [["systemctl", ["--user", "stop", "kaoiro-runner"]],
      ["systemd-run", ["--user", "--on-active=1", "true"]], ["gh", ["api", "user"]]]) {
      assert.throws(() => execFileSync(file, args, { env: { PATH: `${host.bin}:/usr/bin:/bin` } }), { code: /ERR_TEST_HOST_/ });
    }
    assert.deepEqual(host.calls(), []);
  } finally { host.cleanup(); rmSync(fake, { recursive: true, force: true }); }
});

test("outbound network is refused while loopback and unix sockets work", async () => {
  const refused = [];
  await new Promise(resolve => { const socket = net.connect({ host: "192.0.2.1", port: 9 }); socket.once("error", error => { refused.push(error.code); resolve(); }); socket.once("connect", () => { socket.destroy(); refused.push("connected"); resolve(); }); });
  await new Promise(resolve => { const socket = tls.connect({ host: "192.0.2.1", port: 443 }); socket.once("error", error => { refused.push(error.code); resolve(); }); socket.once("secureConnect", () => { socket.destroy(); refused.push("connected"); resolve(); }); });
  try { await fetch("http://192.0.2.1/", { signal: AbortSignal.timeout(5000) }); refused.push("fetched"); } catch (error) { refused.push(error.cause?.code ?? error.code); }
  await new Promise(resolve => dns.lookup("example.com", error => { refused.push(error?.code ?? "resolved"); resolve(); }));
  try { await dns.promises.resolve4("example.com"); refused.push("resolved"); } catch (error) { refused.push(error.code); }
  const udp = dgram.createSocket("udp4");
  try { udp.send("x", 9, "192.0.2.1"); refused.push("sent"); } catch (error) { refused.push(error.code); } finally { udp.close(); }
  assert.deepEqual(refused, Array(6).fill("ERR_TEST_NETWORK"));
  const server = createServer((request, response) => response.end("loopback"));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try { assert.equal(await (await fetch(`http://127.0.0.1:${server.address().port}/`)).text(), "loopback"); }
  finally { await new Promise(resolve => server.close(resolve)); }
  const root = mkdtempSync(join(tmpdir(), "kaoiro577-unix-"));
  const unix = net.createServer(socket => socket.end("unix"));
  await new Promise(resolve => unix.listen(join(root, "s.sock"), resolve));
  try {
    const reply = await new Promise((resolve, reject) => { const socket = net.connect(join(root, "s.sock")); socket.once("data", data => { socket.destroy(); resolve(String(data)); }); socket.once("error", reject); });
    assert.equal(reply, "unix");
  } finally { await new Promise(resolve => unix.close(resolve)); rmSync(root, { recursive: true, force: true }); }
});

test("a root process removes inherited credentials and host pointers once", () => {
  const result = spawnSync("env", ["-u", "KAOIRO_TEST_ISOLATION_CHILD", "GH_TOKEN=planted-host-token",
    "SSH_AUTH_SOCK=/planted/agent.sock", "DOCKER_CONTEXT=planted", "DBUS_SESSION_BUS_ADDRESS=unix:path=/planted/bus",
    process.execPath, "--input-type=module", "-e", `
      // The CommonJS implementation alone, as a --require preload loads it: the
      // ES facade would neutralise again for each entry and hide a missing root step.
      (await import("node:module")).createRequire(${JSON.stringify(MODULE)})(${JSON.stringify(MODULE.replace(/\.mjs$/, ".cjs"))});
      const { execFileSync } = await import("node:child_process");
      process.stdout.write(execFileSync("sh", ["-c", 'printf "%s|%s|%s|%s" "\${GH_TOKEN-unset}" "\${SSH_AUTH_SOCK-unset}" "\${DOCKER_CONTEXT-unset}" "$DBUS_SESSION_BUS_ADDRESS"'], { encoding: "utf8" }));`],
  { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const [token, agent, context, bus] = result.stdout.split("|");
  assert.deepEqual([token, agent, context], ["unset", "unset", "unset"]);
  assert.match(bus, /^unix:path=.*kaoiro-test-isolation-.*\/no-bus$/);
});

test("the boundary re-applies inert pointers after the product filters the child environment", () => {
  const host = standIns();
  const script = mkdtempSync(join(tmpdir(), "kaoiro577-probe-"));
  try {
    writeFileSync(join(script, "probe.sh"), '#!/bin/sh\n"$1/docker" version\n"$1/gh" api user\n', { mode: 0o700 });
    for (const profile of ["gh", "build", "authority", "runner", "systemd"]) {
      const env = { ...childEnvironment(profile), DOCKER_CONTEXT: "planted-context" };
      execFileSync(join(script, "probe.sh"), [host.bin], { env });
    }
    const calls = host.calls();
    assert.equal(calls.length, 10);
    for (const line of calls) {
      const fields = Object.fromEntries(line.split("|").slice(1).map(field => field.split(/=(.*)/s).slice(0, 2)));
      assert.match(fields.DOCKER_HOST, /^unix:\/\/.*kaoiro-test-isolation-.*\/no-docker\.sock$/);
      assert.match(fields.DOCKER_CONFIG, /kaoiro-test-isolation-.*\/docker$/);
      assert.equal(fields.DOCKER_CONTEXT, "unset");
      assert.match(fields.GH_CONFIG_DIR, /kaoiro-test-isolation-.*\/gh$/);
      assert.match(fields.DBUS, /kaoiro-test-isolation-.*\/no-bus$/);
      assert.match(fields.XDG, /kaoiro-test-isolation-.*\/runtime$/);
    }
  } finally { host.cleanup(); rmSync(script, { recursive: true, force: true }); }
});

test("a directly executed Node shebang child is guarded with an explicit environment", () => {
  const host = standIns();
  const root = mkdtempSync(join(tmpdir(), "kaoiro577-shebang-"));
  try {
    const entry = join(root, "entry");
    writeFileSync(entry, `#!/usr/bin/env node
const cp = require("node:child_process"), net = require("node:net");
let command; try { cp.execFileSync(${JSON.stringify(join(host.bin, "systemctl"))}, ["--user", "--version"]); command = "ran"; } catch (error) { command = error.code; }
const socket = net.connect({ host: "192.0.2.1", port: 9 });
socket.once("error", error => console.log(JSON.stringify({ marker: Boolean(globalThis[Symbol.for("kaoiro.test.isolation")]), command, network: error.code })));
socket.once("connect", () => { socket.destroy(); console.log(JSON.stringify({ network: "connected" })); });
`, { mode: 0o700 });
    const report = JSON.parse(execFileSync(entry, [], { env: { PATH: CHILD_PATH_FOR_TESTS }, encoding: "utf8" }));
    assert.deepEqual(report, { marker: true, command: "ERR_TEST_HOST_SYSTEMD", network: "ERR_TEST_NETWORK" });
    assert.deepEqual(host.calls(), []);
  } finally { host.cleanup(); rmSync(root, { recursive: true, force: true }); }
});

test("NODE_OPTIONS alone carries the guard to every Node launch form", async () => {
  const root = mkdtempSync(join(tmpdir(), "kaoiro577-forms-"));
  const probe = "process.exit(globalThis[Symbol.for('kaoiro.test.isolation')] ? 0 : 3)";
  try {
    writeFileSync(join(root, "fork.cjs"), `process.send(Boolean(globalThis[Symbol.for("kaoiro.test.isolation")]));`);
    const forms = {
      execPath: spawnSync(process.execPath, ["-e", probe], { env: { PATH: CHILD_PATH_FOR_TESTS } }).status,
      pathNode: spawnSync("node", ["-e", probe], { env: { PATH: CHILD_PATH_FOR_TESTS } }).status,
      shell: spawnSync("sh", ["-c", `node -e "${probe}"`], { env: { PATH: CHILD_PATH_FOR_TESTS } }).status,
      fork: await new Promise((resolve, reject) => {
        const child = fork(join(root, "fork.cjs"), { env: { PATH: CHILD_PATH_FOR_TESTS }, execArgv: [] });
        child.once("message", marker => { child.kill(); resolve(marker ? 0 : 3); });
        child.once("error", reject);
      }),
    };
    assert.deepEqual(forms, { execPath: 0, pathNode: 0, shell: 0, fork: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const mode of ["R1a", "R1b", "R2a", "R2b", "inherited", "cjs", "esm", "permit"]) {
  test(`worker boundary: ${mode}`, () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-worker-"));
    const probe = fileURLToPath(new URL("./fixtures/isolation-worker-probe.cjs", import.meta.url));
    try {
      // env removes the spawn boundary's preload too: the root must install
      // isolation by ordinary require, not accidentally inherit a preload.
      const result = spawnSync("env", ["-u", "NODE_OPTIONS", "-u", "KAOIRO_TEST_ISOLATION_CHILD",
        process.execPath, probe, mode, root], { encoding: "utf8", timeout: 15000 });
      assert.equal(result.status, 0, result.stderr);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("children keep explicit fixture tokens and owned pointers across generations", () => {
  const root = mkdtempSync(join(tmpdir(), "kaoiro577-lineage-"));
  try {
    const grandchild = "process.stdout.write(JSON.stringify({ token: process.env.GH_TOKEN, docker: process.env.DOCKER_HOST, marker: Boolean(globalThis[Symbol.for('kaoiro.test.isolation')]) }))";
    const child = `const cp = require("node:child_process"); process.stdout.write(cp.execFileSync(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { encoding: "utf8" }));`;
    const docker = `unix://${join(root, "fixture-docker.sock")}`;
    const report = JSON.parse(execFileSync(process.execPath, ["-e", child],
      { env: { PATH: CHILD_PATH_FOR_TESTS, GH_TOKEN: "local-fixture-only", DOCKER_HOST: docker }, encoding: "utf8" }));
    assert.deepEqual(report, { token: "local-fixture-only", docker, marker: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("permitHostAccess needs its opt-in variable and is handed to children", () => {
  const host = standIns();
  try {
    assert.throws(() => permitHostAccess({ optIn: "KAOIRO_ISOLATION_SELF_PROBE", reason: "r", kinds: ["root"] }), TypeError);
    assert.throws(() => permitHostAccess({ optIn: "KAOIRO_ISOLATION_SELF_PROBE", kinds: ["systemd"] }), TypeError);
    const code = optIn => `
      const { permitSelfProbe } = await import(${JSON.stringify(PERMIT_PROBE)});
      const granted = permitSelfProbe();
      const { execFileSync } = await import("node:child_process");
      let direct; try { execFileSync(${JSON.stringify(join(host.bin, "systemctl"))}, ["direct"]); direct = "ran"; } catch (error) { direct = error.code; }
      const child = execFileSync(process.execPath, ["-e", "try { require('node:child_process').execFileSync(" + ${JSON.stringify(JSON.stringify(join(host.bin, "systemctl")))} + ", ['child']); process.stdout.write('ran'); } catch (error) { process.stdout.write(String(error.code)); }"], { encoding: "utf8" });
      process.stdout.write(JSON.stringify({ granted, direct, child }));`;
    const without = nodeEval(code(), { env: { PATH: CHILD_PATH_FOR_TESTS } });
    assert.deepEqual(JSON.parse(without.stdout), { granted: false, direct: "ERR_TEST_HOST_SYSTEMD", child: "ERR_TEST_HOST_SYSTEMD" });
    assert.deepEqual(host.calls(), []);
    const withOptIn = nodeEval(code(), { env: { PATH: CHILD_PATH_FOR_TESTS, KAOIRO_ISOLATION_SELF_PROBE: "1" } });
    assert.deepEqual(JSON.parse(withOptIn.stdout), { granted: true, direct: "ran", child: "ran" });
    assert.equal(host.calls().length, 2);
  } finally { host.cleanup(); }
});

test("a permit is checked against the calling file's table entry, with or without its opt-in", () => {
  const extraKinds = ["network"];
  for (const kinds of [["systemd", "network"], ["systemd", ...extraKinds], ["docker"]]) {
    assert.throws(() => permitHostAccess({ kinds, optIn: "KAOIRO_ISOLATION_SELF_PROBE", reason: "r" }),
      { name: "TypeError", message: /not allowed for scripts\/test\/test-isolation\.test\.mjs/ });
  }
  assert.equal(permitHostAccess({ kinds: ["systemd"], optIn: "KAOIRO_ISOLATION_SELF_PROBE", reason: "r" }), false);
  const outside = mkdtempSync(join(tmpdir(), "kaoiro577-permit-caller-"));
  try {
    const call = `permitHostAccess({ kinds: ["systemd"], optIn: "KAOIRO_ISOLATION_SELF_PROBE", reason: "r" })`;
    writeFileSync(join(outside, "caller.mjs"), `import { permitHostAccess } from ${JSON.stringify(MODULE)};\n${call};\n`);
    for (const result of [spawnSync(process.execPath, [join(outside, "caller.mjs")], { encoding: "utf8" }),
      nodeEval(`const { permitHostAccess } = await import(${JSON.stringify(MODULE)});\n${call};`)]) {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /permitHostAccess is not allowed from a caller without a repository file/);
    }
  } finally { rmSync(outside, { recursive: true, force: true }); }
});

test("finding the caller keeps the process's stack settings and works without frames", () => {
  const prepare = Error.prepareStackTrace, limit = Error.stackTraceLimit;
  const custom = (error, sites) => `custom ${sites.length}`;
  try {
    Error.prepareStackTrace = custom;
    Error.stackTraceLimit = 0;
    assert.equal(permitHostAccess({ kinds: ["systemd"], optIn: "KAOIRO_ISOLATION_SELF_PROBE", reason: "r" }), false);
    assert.equal(Error.prepareStackTrace, custom);
    assert.equal(Error.stackTraceLimit, 0);
  } finally {
    Error.prepareStackTrace = prepare;
    Error.stackTraceLimit = limit;
  }
});

test("a shell or launcher that may change PATH or its cwd cannot reach a foreign gh or docker", () => {
  const host = standIns();
  const owned = mkdtempSync(join(tmpdir(), "kaoiro577-indirect-owned-"));
  try {
    for (const name of ["gh", "docker"]) writeFileSync(join(owned, name), `#!/bin/sh\nprintf 'owned ${name}'\n`, { mode: 0o700 });
    const env = { PATH: `${owned}:/usr/bin:/bin` };
    for (const run of [
      () => spawnSync("sh", ["-c", `PATH=${host.bin} docker version`], { env }),
      () => execSync(`export PATH=${host.bin}; gh api user`, { env }),
      () => spawnSync("env", [`PATH=${host.bin}`, "docker", "version"], { env }),
      () => spawnSync("env", ["-u", "PATH", "gh", "api", "user"], { env }),
      () => spawnSync("env", ["-C", host.root, "bin/docker", "version"], { env }),
      () => spawnSync("timeout", ["5", "gh", "api", "user"], { env }),
    ]) {
      assert.throws(run, { code: "ERR_TEST_HOST_TOOL", message: /absolute path to an owned program/ });
    }
    symlinkSync(join(host.bin, "gh"), join(owned, "renamed"));
    assert.throws(() => spawnSync("env", [join(owned, "renamed"), "api", "user"]), { code: "ERR_TEST_HOST_TOOL" });
    assert.deepEqual(host.calls(), []);
    assert.equal(execFileSync("env", [`PATH=${host.bin}`, join(owned, "docker")], { encoding: "utf8" }), "owned docker");
    assert.equal(execFileSync("sh", ["-c", `cd ${host.root} && ${join(owned, "gh")}`], { encoding: "utf8" }), "owned gh");
  } finally {
    host.cleanup();
    rmSync(owned, { recursive: true, force: true });
  }
});

test("a Node script with a non-JavaScript name still starts and is guarded", () => {
  const root = mkdtempSync(join(tmpdir(), "kaoiro577-sh-node-"));
  try {
    const tool = join(root, "fake-tool.sh");
    writeFileSync(tool, "#!/usr/bin/env node\nconsole.log(JSON.stringify({ marker: Boolean(globalThis[Symbol.for('kaoiro.test.isolation')]) }));\n", { mode: 0o700 });
    assert.deepEqual(JSON.parse(execFileSync(tool, [], { env: { PATH: CHILD_PATH_FOR_TESTS }, encoding: "utf8" })), { marker: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an updater path passed to another program is not an updater launch", () => {
  const updater = fileURLToPath(new URL("../../runner/deploy/kaoiro-runner-update.sh", import.meta.url));
  assert.equal(execFileSync(process.execPath, ["-e", "process.stdout.write(process.argv[1])", updater], { encoding: "utf8" }), updater);
  assert.throws(() => spawnSync("sh", [updater, "--service", "kaoiro-runner"]), { code: "ERR_TEST_HOST_SYSTEMD" });
  assert.throws(() => spawnSync("setsid", [updater, "--service", "kaoiro-runner"]), { code: "ERR_TEST_HOST_SYSTEMD" });
});

test("through a shell, gh and docker run only as an owned absolute path", () => {
  const host = standIns();
  const owned = mkdtempSync(join(tmpdir(), "kaoiro577-shell-owned-"));
  const empty = mkdtempSync(join(tmpdir(), "kaoiro577-shell-empty-"));
  try {
    assert.throws(() => spawnSync("/bin/sh", ["-c", "gh api user"], { env: { PATH: `${host.bin}:/usr/bin:/bin` } }), { code: "ERR_TEST_HOST_TOOL" });
    assert.throws(() => spawnSync("/bin/sh", ["-c", `${host.bin}/docker version`]), { code: "ERR_TEST_HOST_TOOL" });
    assert.throws(() => execSync("docker version", { env: { PATH: `${host.bin}:/usr/bin:/bin` } }), { code: "ERR_TEST_HOST_TOOL" });
    assert.deepEqual(host.calls(), []);
    writeFileSync(join(owned, "gh"), "#!/bin/sh\nprintf 'owned gh'\n", { mode: 0o700 });
    assert.equal(execFileSync("/bin/sh", ["-c", `${join(owned, "gh")} api user`], { encoding: "utf8" }), "owned gh");
    // A bare name is refused even when it would find the owned fake, or nothing.
    assert.throws(() => execFileSync("/bin/sh", ["-c", "gh api user"], { env: { PATH: `${owned}:/usr/bin:/bin` } }),
      { code: "ERR_TEST_HOST_TOOL", message: /absolute path to an owned program/ });
    assert.throws(() => execFileSync("/bin/sh", ["-c", "echo gh docker"], { env: { PATH: empty } }), { code: "ERR_TEST_HOST_TOOL" });
  } finally {
    host.cleanup();
    rmSync(owned, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

test("an opt-in gets the root's own environment back for its kinds, and a new entry ends it", () => {
  {
    const implementation = MODULE.replace(/\.mjs$/, ".cjs");
    const code = `
      const isolation = require(${JSON.stringify(implementation)});
      const { permitSelfProbe } = require(${JSON.stringify(PERMIT_PROBE)});
      const { execFileSync } = require("node:child_process");
      const view = () => execFileSync("sh", ["-c", 'printf "%s|%s|%s" "$DBUS_SESSION_BUS_ADDRESS" "$XDG_RUNTIME_DIR" "$DOCKER_HOST"'], { encoding: "utf8" });
      const grandchild = () => execFileSync(process.execPath, ["-e", "process.stdout.write(require('node:child_process').execFileSync('sh', ['-c', 'printf %s \\"$DBUS_SESSION_BUS_ADDRESS\\"'], { encoding: 'utf8' }))"], { encoding: "utf8" });
      const granted = permitSelfProbe();
      const during = view(), nested = grandchild();
      isolation.beginEntry();
      let after; try { execFileSync("systemctl", ["after"], { env: { PATH: "/nonexistent" } }); after = "ran"; } catch (error) { after = error.code; }
      process.stdout.write(JSON.stringify({ granted, during, nested, reset: view(), after }));`;
    // The probe goes in a file: launcher arguments naming systemd tools are refused.
    const probe = join(mkdtempSync(join(tmpdir(), "kaoiro577-optin-")), "probe.cjs");
    writeFileSync(probe, code);
    const run = optIn => spawnSync("env", ["-u", "KAOIRO_TEST_ISOLATION_CHILD", "DBUS_SESSION_BUS_ADDRESS=unix:path=/planted/bus",
      "XDG_RUNTIME_DIR=/planted/runtime", "DOCKER_HOST=unix:///planted/docker.sock", `KAOIRO_ISOLATION_SELF_PROBE=${optIn}`,
      process.execPath, probe], { encoding: "utf8" });
    const opted = run("1");
    assert.equal(opted.status, 0, opted.stderr);
    const report = JSON.parse(opted.stdout);
    const [bus, runtime, docker] = report.during.split("|");
    assert.deepEqual({ granted: report.granted, bus, runtime, nested: report.nested, after: report.after },
      { granted: true, bus: "unix:path=/planted/bus", runtime: "/planted/runtime", nested: "unix:path=/planted/bus", after: "ERR_TEST_HOST_SYSTEMD" });
    assert.match(docker, /kaoiro-test-isolation-.*\/no-docker\.sock$/);
    assert.match(report.reset.split("|")[0], /kaoiro-test-isolation-.*\/no-bus$/);
    const plain = JSON.parse(run("0").stdout);
    assert.equal(plain.granted, false);
    assert.match(plain.during.split("|")[0], /kaoiro-test-isolation-.*\/no-bus$/);
    rmSync(dirname(probe), { recursive: true, force: true });
  }
});

test("a child environment without PATH is searched the way libuv does, not with the parent's PATH", () => {
  const owned = mkdtempSync(join(tmpdir(), "kaoiro577-parent-path-"));
  const saved = { PATH: process.env.PATH, KAOIRO_SYSTEMCTL: process.env.KAOIRO_SYSTEMCTL, KAOIRO_SYSTEMD_RUN: process.env.KAOIRO_SYSTEMD_RUN };
  try {
    const sink = join(owned, "sink.log");
    for (const name of ["systemctl", "systemd-run", "kaoiro-runner-update.sh"]) {
      writeFileSync(join(owned, name), `#!/bin/sh\nprintf '${name}\\n' >> '${sink}'\n`, { mode: 0o700 });
    }
    process.env.PATH = `${owned}:${saved.PATH}`;
    process.env.KAOIRO_SYSTEMCTL = join(owned, "systemctl");
    process.env.KAOIRO_SYSTEMD_RUN = join(owned, "systemd-run");
    assert.equal(spawnSync("systemctl", [], { encoding: "utf8" }).status, 0);
    assert.throws(() => spawnSync("systemctl", ["--version"], { env: { FIXTURE: "1" } }), { code: "ERR_TEST_HOST_SYSTEMD" });
    assert.throws(() => spawnSync(join(owned, "kaoiro-runner-update.sh"), [], { env: { PATH: CHILD_PATH_FOR_TESTS } }), { code: "ERR_TEST_HOST_SYSTEMD" });
    assert.equal(readFileSync(sink, "utf8"), "systemctl\n");
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(owned, { recursive: true, force: true });
  }
});

test("an explicit undefined options slot keeps the callback and the promise", { timeout: 10_000 }, async () => {
  await new Promise((resolve, reject) => execFile("/usr/bin/true", [], undefined, error => error ? reject(error) : resolve()));
  assert.equal((await promisify(execFile)("/usr/bin/true", [], undefined)).stdout, "");
});

test("privilege tools and login shells are refused, also behind launchers", () => {
  for (const work of [
    () => spawnSync("sudo", ["true"]),
    () => spawnSync("env", ["sudo", "true"]),
    () => spawnSync("sh", ["-c", "sudo true"]),
    () => spawnSync("bash", ["-lc", "true"]),
    () => spawnSync("bash", ["--login", "-c", "true"]),
    () => spawnSync("setsid", ["bash", "-ic", "true"]),
  ]) assert.throws(work, { code: "ERR_TEST_ISOLATION" });
  assert.equal(execFileSync("sh", ["-c", 'printf "%s" "$1"', "sh", "-la"], { encoding: "utf8" }), "-la");
});

test("a launcher-wrapped shell string is checked like a direct one", () => {
  const host = standIns();
  try {
    assert.throws(() => spawnSync("env", ["sh", "-c", "docker ps"], { env: { PATH: `${host.bin}:/usr/bin:/bin` } }), { code: "ERR_TEST_HOST_TOOL" });
    assert.throws(() => spawnSync("timeout", ["5", "sh", "-c", "gh api user"], { env: { PATH: `${host.bin}:/usr/bin:/bin` } }), { code: "ERR_TEST_HOST_TOOL" });
    // Only the shell string itself shows these; the launcher sees one argument.
    assert.throws(() => spawnSync("env", ["sh", "-c", "sudo true"]), { code: "ERR_TEST_ISOLATION" });
    const updater = fileURLToPath(new URL("../../runner/deploy/kaoiro-runner-update.sh", import.meta.url));
    assert.throws(() => spawnSync("setsid", ["sh", "-c", `${updater} --service kaoiro-runner`]), { code: "ERR_TEST_HOST_SYSTEMD" });
    assert.deepEqual(host.calls(), []);
  } finally { host.cleanup(); }
});

test("a fake that is not executable does not count as the owned program", () => {
  const owned = mkdtempSync(join(tmpdir(), "kaoiro577-noexec-"));
  try {
    writeFileSync(join(owned, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o600 });
    assert.throws(() => spawnSync("systemctl", ["--version"], { env: { PATH: `${owned}:/nonexistent` } }), { code: "ERR_TEST_HOST_SYSTEMD" });
  } finally { rmSync(owned, { recursive: true, force: true }); }
});

test("a permit must name a probe's own KAOIRO_ variable", () => {
  for (const optIn of ["KAOIRO_TEST_ISOLATION_CHILD", "CI", "kaoiro_probe"]) {
    assert.throws(() => permitHostAccess({ kinds: ["systemd"], optIn, reason: "r" }), TypeError);
  }
});

test("a TMPDIR that holds the real runtime directory does not make the session bus owned", () => {
  const temp = mkdtempSync(join(tmpdir(), "kaoiro577-runtime-temp-"));
  try {
    const runtime = join(temp, "runtime");
    mkdirSync(runtime);
    const probe = join(temp, "probe.cjs");
    writeFileSync(probe, `
      require(${JSON.stringify(MODULE.replace(/\.mjs$/, ".cjs"))});
      const { execFileSync } = require("node:child_process");
      process.stdout.write(execFileSync("sh", ["-c", 'printf "%s" "$DBUS_SESSION_BUS_ADDRESS"'],
        { env: { PATH: process.env.PATH, DBUS_SESSION_BUS_ADDRESS: "unix:path=${join(runtime, "bus")}" }, encoding: "utf8" }));`);
    const result = spawnSync("env", ["-u", "KAOIRO_TEST_ISOLATION_CHILD", `TMPDIR=${temp}`, `XDG_RUNTIME_DIR=${runtime}`,
      process.execPath, probe], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /kaoiro-test-isolation-.*\/no-bus$/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("the updater runs with an owned manager and refuses a host systemd-run only for --detach", () => {
  const host = standIns();
  const owned = mkdtempSync(join(tmpdir(), "kaoiro577-updater-"));
  try {
    const sink = join(owned, "sink.log");
    for (const name of ["systemctl", "kaoiro-runner-update.sh"]) {
      writeFileSync(join(owned, name), `#!/bin/sh\nprintf '${name}\\n' >> '${sink}'\n`, { mode: 0o700 });
    }
    const updater = join(owned, "kaoiro-runner-update.sh");
    const env = { PATH: `${owned}:/nonexistent`, KAOIRO_SYSTEMCTL: join(owned, "systemctl") };
    assert.equal(spawnSync(updater, [], { env }).status, 0);
    // A host systemd-run on PATH or named by the seam, as on a CI runner, is
    // not reached without --detach.
    assert.equal(spawnSync(updater, [], { env: { ...env, PATH: `${owned}:${host.bin}` } }).status, 0);
    assert.equal(spawnSync("/bin/sh", [updater, "--service", "x"], { env: { ...env, KAOIRO_SYSTEMD_RUN: join(host.bin, "systemd-run") } }).status, 0);
    assert.throws(() => spawnSync(updater, ["--detach"], { env: { ...env, KAOIRO_SYSTEMD_RUN: join(host.bin, "systemd-run") } }), { code: "ERR_TEST_HOST_SYSTEMD" });
    assert.throws(() => spawnSync("setsid", [updater, "--detach"], { env: { ...env, PATH: `${owned}:${host.bin}:/usr/bin:/bin` } }), { code: "ERR_TEST_HOST_SYSTEMD" });
    assert.equal(spawnSync(updater, ["--detach"], { env: { ...env, KAOIRO_SYSTEMD_RUN: "/bin/false" } }).status, 0);
    assert.throws(() => spawnSync(updater, [], { env: { PATH: "/nonexistent" } }), { code: "ERR_TEST_HOST_SYSTEMD" });
    assert.equal(readFileSync(sink, "utf8"), "kaoiro-runner-update.sh\n".repeat(4));
    assert.deepEqual(host.calls(), []);
  } finally { host.cleanup(); rmSync(owned, { recursive: true, force: true }); }
});

test("a child reuses the root's inert pointers instead of creating its own", () => {
  const temp = mkdtempSync(join(tmpdir(), "kaoiro577-child-temp-"));
  try {
    const grandchild = "process.stdout.write(process.env.DBUS_SESSION_BUS_ADDRESS)";
    const child = `process.stdout.write(require("node:child_process").execFileSync(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { env: { PATH: process.env.PATH }, encoding: "utf8" }))`;
    const seen = execFileSync(process.execPath, ["-e", child], { env: { PATH: CHILD_PATH_FOR_TESTS, TMPDIR: temp }, encoding: "utf8" });
    assert.equal(seen, process.env.DBUS_SESSION_BUS_ADDRESS);
    assert.deepEqual(readdirSync(temp), []);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
