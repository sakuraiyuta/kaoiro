import "./fixtures/host-systemd-guard.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
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
    `import {execChildSync} from ${JSON.stringify(helper)}; execChildSync('systemd','systemd-run',['--version']);`], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ERR_TEST_HOST_SYSTEMD/);
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
