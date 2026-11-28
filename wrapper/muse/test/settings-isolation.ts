import "../../../scripts/test/fixtures/test-isolation.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";

let root: string;
const previous = {
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  KAOIRO_MUSE_TEST_ROOT: process.env.KAOIRO_MUSE_TEST_ROOT,
};
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "kaoiro-muse-settings-"));
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.KAOIRO_MUSE_TEST_ROOT = root;
});
afterAll(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});
