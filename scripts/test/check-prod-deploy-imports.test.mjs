import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const checker = fileURLToPath(new URL("../check-prod-deploy-imports.mjs", import.meta.url));

function write(path, content) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

/** A deploy-shaped tree in pnpm's layout: the runner root links an engine
 *  package from the virtual store, whose own dependencies (wrapper-core and
 *  phoenix) sit beside it in the store entry's node_modules. A decoy
 *  @kaoiro/protocol lies outside the deploy root, where the workspace would
 *  have it. */
function withDeploy(callback) {
  const scratch = mkdtempSync(join(tmpdir(), "kuroe214-deploy-check-"));
  try {
    const root = join(scratch, "deploy", "runner");
    const store = join(root, "node_modules", ".pnpm", "engine@1", "node_modules");
    const engine = join(store, "@kaoiro", "claude-code");
    const core = join(store, "@kaoiro", "wrapper-core");
    write(join(root, "package.json"), "{}");
    write(join(root, "dist", "supervisor.js"), 'import { spawn } from "node:child_process";\nimport "./spawn.js";\nimport "@kaoiro/claude-code";\n');
    write(join(root, "dist", "spawn.js"), "export {};\n");
    write(join(engine, "package.json"), "{}");
    write(join(engine, "dist", "index.js"), 'import "@kaoiro/wrapper-core";\n');
    write(join(core, "package.json"), "{}");
    write(join(core, "dist", "index.js"), 'import { Socket } from "phoenix";\nexport const x = await import("fs");\n');
    write(join(store, "phoenix", "package.json"), "{}");
    mkdirSync(join(root, "node_modules", "@kaoiro"), { recursive: true });
    symlinkSync(engine, join(root, "node_modules", "@kaoiro", "claude-code"));
    write(join(scratch, "node_modules", "@kaoiro", "protocol", "package.json"), "{}");
    return callback({ root, core });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function run(root) {
  return spawnSync(process.execPath, [checker, root], { encoding: "utf8" });
}

test("passes when every bare import of first-party code is installed", () => {
  withDeploy(({ root }) => {
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /4 files, every bare import resolves/);
  });
});

test("fails on a runtime import of a package that was not deployed", () => {
  withDeploy(({ root, core }) => {
    write(join(core, "dist", "shutdown_budget.js"), 'import { RESET_TERMINATION_GRACE_MS } from "@kaoiro/protocol";\n');
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /shutdown_budget\.js imports "@kaoiro\/protocol", which is not installed/);
  });
});

test("checks the runner's own dist as well as linked packages", () => {
  withDeploy(({ root }) => {
    write(join(root, "dist", "behaviour.js"), 'export { x } from "@kaoiro/protocol";\n');
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /behaviour\.js imports "@kaoiro\/protocol"/);
  });
});

test("fails closed when the tree has no first-party JS", () => {
  const scratch = mkdtempSync(join(tmpdir(), "kuroe214-deploy-empty-"));
  try {
    const result = run(scratch);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no first-party JS/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
