import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const scratch: string[] = [];
afterEach(() => scratch.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

it.each([0, 1])("update cleanup frees build and links before a release gate returning %s", (gateStatus) => {
  const root = mkdtempSync(join(tmpdir(), "fuji571-cleanup-"));
  scratch.push(root);
  const build = join(root, "build"), lock = join(root, ".lock.update"), links = join(root, ".lock.links");
  for (const path of [build, lock, links]) mkdirSync(path);
  writeFileSync(join(lock, "release-owner.json"), "owned fixture");
  const source = readFileSync(new URL("../deploy/kaoiro-runner-update.sh", import.meta.url), "utf8");
  const cleanup = source.match(/^cleanup\(\) \{\n[\s\S]*?^\}/m)?.[0];
  expect(cleanup).toBeTruthy();
  const result = spawnSync("sh", ["-c", `
    root=$1; lock=$2; links_lock=$3; build_dir=$4; links_held=yes
    kaoiro_lock_release() { rm -rf "$1"; }
    ${cleanup}
    kaoiro_release_gate() {
      [ ! -e "$build_dir" ] && [ ! -e "$links_lock" ] || return 9
      return ${gateStatus}
    }
    cleanup
  `, "cleanup", root, lock, links, build], { encoding: "utf8" });
  expect(result.status).toBe(gateStatus);
  expect(existsSync(build)).toBe(false);
  expect(existsSync(links)).toBe(false);
  expect(existsSync(lock)).toBe(gateStatus !== 0);
});
