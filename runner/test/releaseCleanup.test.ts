import "../../scripts/test/fixtures/test-isolation.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const scratch: string[] = [];
afterEach(() => scratch.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

it.each([
  { failRemoval: "none" },
  { failRemoval: "build" },
])("update cleanup propagates $failRemoval removal result and retains failed build lock", ({ failRemoval }) => {
  const root = mkdtempSync(join(tmpdir(), "fuji571-cleanup-"));
  scratch.push(root);
  const build = join(root, "build"), lock = join(root, ".lock.update"), links = join(root, ".lock.links");
  for (const path of [build, lock, links]) mkdirSync(path);
  const source = readFileSync(new URL("../deploy/kaoiro-runner-update.sh", import.meta.url), "utf8");
  const common = readFileSync(new URL("../deploy/kaoiro-runner-common.sh", import.meta.url), "utf8");
  const cleanup = source.match(/^cleanup\(\) \{\n[\s\S]*?^\}/m)?.[0];
  const release = common.match(/^kaoiro_lock_release\(\) \{\n[\s\S]*?^\}/m)?.[0];
  expect(cleanup).toBeTruthy();
  expect(release).toBeTruthy();
  const result = spawnSync("sh", ["-c", `
    root=$1; lock=$2; links_lock=$3; build_dir=$4; links_held=yes
    ${release}
    ${cleanup}
    rm() {
      case "$*" in
        "-rf $build_dir") [ "${failRemoval}" != build ] || return 1 ;;
      esac
      command rm "$@"
    }

    cleanup
  `, "cleanup", root, lock, links, build], { encoding: "utf8" });
  const failed = failRemoval !== "none";
  expect(result.status).toBe(failed ? 1 : 0);
  expect(existsSync(build)).toBe(failRemoval === "build");
  expect(existsSync(links)).toBe(false);
  expect(existsSync(lock)).toBe(failed);
});
