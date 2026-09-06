import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { ConfigError, DEFAULT_CONFIG, loadConfig } from "../kaoiro-deploy-config.mjs";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kaoiro-deploy-config-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("loadConfig with no path returns the defaults", () => {
  assert.deepEqual(loadConfig(undefined), DEFAULT_CONFIG);
});

test("loadConfig throws when the file does not exist", () => {
  assert.throws(() => loadConfig(join(dir, "missing.json")), ConfigError);
});

test("loadConfig throws when the file is not mode 0600", () => {
  const path = join(dir, "config.json");
  writeFileSync(path, "{}");
  chmodSync(path, 0o644);
  assert.throws(() => loadConfig(path), ConfigError);
});

test("loadConfig merges a valid override over the defaults", () => {
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ keep_generations: 7 }));
  chmodSync(path, 0o600);
  const config = loadConfig(path);
  assert.equal(config.keep_generations, 7);
  assert.equal(config.retention_days, DEFAULT_CONFIG.retention_days);
});

test("loadConfig rejects an unknown key", () => {
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ keep_generation: 7 }));
  chmodSync(path, 0o600);
  assert.throws(() => loadConfig(path), ConfigError);
});

test("loadConfig rejects an out-of-domain value", () => {
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ keep_generations: 0 }));
  chmodSync(path, 0o600);
  assert.throws(() => loadConfig(path), ConfigError);
});

// クロエ round 1 review SF-6: a relative backup_root is not caught until
// well after the stop window opens (docker rejects a relative bind-mount
// source, but only once the archive step tries to use it) — reject it
// here, at config load, instead.
test("loadConfig rejects a relative backup_root", () => {
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ backup_root: "relative/path" }));
  chmodSync(path, 0o600);
  assert.throws(() => loadConfig(path), ConfigError);
});

test("loadConfig accepts an absolute backup_root", () => {
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ backup_root: "/var/lib/kaoiro-deploy" }));
  chmodSync(path, 0o600);
  const config = loadConfig(path);
  assert.equal(config.backup_root, "/var/lib/kaoiro-deploy");
});

test("loadConfig rejects malformed JSON", () => {
  const path = join(dir, "config.json");
  writeFileSync(path, "not json");
  chmodSync(path, 0o600);
  assert.throws(() => loadConfig(path), ConfigError);
});

test("loadConfig rejects a file not owned by the current user", () => {
  const path = join(dir, "config.json");
  writeFileSync(path, "{}");
  chmodSync(path, 0o600);
  // process.getuid() is temporarily made to disagree with the file's
  // real owner (this process itself), reaching the ownership guard
  // without needing root to actually create a file owned by someone
  // else.
  const original = process.getuid;
  process.getuid = () => original() + 1;
  try {
    assert.throws(() => loadConfig(path), ConfigError);
  } finally {
    process.getuid = original;
  }
});
