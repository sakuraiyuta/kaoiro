import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const scratch: string[] = [];
afterEach(() => scratch.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

it.each([
  { gateStatus: 0, failRemoval: "none" },
  { gateStatus: 1, failRemoval: "none" },
  { gateStatus: 0, failRemoval: "build" },
  { gateStatus: 1, failRemoval: "build" },
  { gateStatus: 0, failRemoval: "owner" },
])("update cleanup retains recoverable ownership after $failRemoval removal failure and gate $gateStatus", ({ gateStatus, failRemoval }) => {
  const root = mkdtempSync(join(tmpdir(), "fuji571-cleanup-"));
  scratch.push(root);
  const build = join(root, "build"), lock = join(root, ".lock.update"), links = join(root, ".lock.links");
  for (const path of [build, lock, links]) mkdirSync(path);
  writeFileSync(join(lock, "release-owner.json"), "owned fixture");
  writeFileSync(join(lock, "codex-owner.json"), "owned fixture");
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
        "-f $lock/codex-owner.json") [ "${failRemoval}" != owner ] || return 1 ;;
      esac
      command rm "$@"
    }
    kaoiro_release_gate() {
      [ ! -e "$links_lock" ] || return 9
      ${gateStatus === 0 ? 'command rm -f "$lock/release-owner.json"' : ""}
      return ${gateStatus}
    }
    cleanup
  `, "cleanup", root, lock, links, build], { encoding: "utf8" });
  const failed = gateStatus !== 0 || failRemoval !== "none";
  expect(result.status).toBe(failed ? 1 : 0);
  expect(existsSync(build)).toBe(failRemoval === "build");
  expect(existsSync(links)).toBe(false);
  expect(existsSync(lock)).toBe(failed);
  expect(existsSync(join(lock, "codex-owner.json"))).toBe(failed);
});
