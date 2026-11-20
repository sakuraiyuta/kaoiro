import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createStateFixture } from "./codexStateFixture.js";
import {
  revisionOf, runScript, writeBundleManifest, writeBundleTree,
  writeReleaseTree,
} from "./releaseFixture.js";

const bundled = revisionOf("bundled");
const legacy = revisionOf("legacy");
let root: string;
let tree: string;
let installed: string;
let conf: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kaoiro-bundled-release-"));
  tree = writeBundleTree(join(root, "candidate"), bundled);
  installed = join(root, "install");
  conf = join(root, "config");
  mkdirSync(conf);
  writeFileSync(join(conf, "runner.config.json"), "{}");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (name: string, args: string[]) =>
  runScript(join(tree, "deploy", `kaoiro-runner-${name}.sh`), args);
const switchTo = (target: string) =>
  run("switch", [target, "--install-dir", installed]);
const archive = () => {
  const result = join(root, "candidate.tar.gz");
  execFileSync("tar", ["czf", result, "-C", root, "candidate"]);
  return result;
};
const install = () => run("install", [archive(), "--install-dir", installed]);

it("installs the bundled archive and rolls back to an unchanged legacy tree", () => {
  writeReleaseTree(join(installed, "releases", legacy), legacy);
  symlinkSync(`releases/${legacy}`, join(installed, "current"));
  expect(install().status).toBe(0);
  expect(switchTo(bundled).status).toBe(0);
  const shim = join(installed, "current/deploy/kaoiro-runner-launch.sh");
  const started = runScript(shim, [], { KAOIRO_RUNNER_DIR: conf });
  expect(started.status, started.stderr).toBe(0);
  expect(started.stdout.trim()).toBe("bundled runner started");
  const identity = runScript(shim, ["--version", "--json"]);
  expect(JSON.parse(identity.stdout).revision).toBe(bundled);
  expect(switchTo("--rollback").status).toBe(0);
  expect(readlinkSync(join(installed, "current"))).toBe(`releases/${legacy}`);
  expect(readlinkSync(join(installed, "previous"))).toBe(`releases/${bundled}`);
});

const variants = process.platform === "darwin"
  ? ["darwin-arm64"] : ["linux-x64", "linuxmusl-x64"];
const libvips = process.platform === "darwin"
  ? "libvips-cpp.8.18.3.dylib" : "libvips-cpp.so.8.18.3";
const omissions: Array<[string, string, boolean]> = [
  ["entry omitted from the tree", "dist/kaoiro.mjs", false],
  ["entry and its record omitted", "dist/kaoiro.mjs", true],
  ["identity record omitted", "dist/codex-native.json", true],
  ...variants.flatMap((variant): Array<[string, string, boolean]> => [
    [`${variant} native entry omitted`,
      `node_modules/@img/sharp-${variant}/lib/sharp-${variant}-0.35.2.node`, true],
    [`${variant} libvips omitted`,
      `node_modules/@img/sharp-libvips-${variant}/lib/${libvips}`, true],
  ]),
];
it.each(omissions)("refuses a bundle with %s", (_label, path, removeManifestEntry) => {
  rmSync(join(tree, path));
  if (removeManifestEntry) writeBundleManifest(tree);
  expect(install().status).toBe(70);
  expect(existsSync(join(installed, "current"))).toBe(false);
  expect(existsSync(join(installed, "releases", bundled))).toBe(false);
});

it("refuses both layout witnesses in one archive", () => {
  const oldWitness = join(tree, "node_modules/@kaoiro/codex/dist/cli.js");
  mkdirSync(dirname(oldWitness), { recursive: true });
  writeFileSync(oldWitness, "");
  writeBundleManifest(tree);
  const result = install();
  expect(result.status).toBe(70);
  expect(result.stderr).toContain("Mixed release layout");
});

it.each(["VERSION", "dist/codex-native.json"])("refuses a changed %s", (path) => {
  writeFileSync(join(tree, path), "changed");
  expect(install().status).toBe(70);
});

it("rejects a different expected Codex native before changing links", () => {
  writeReleaseTree(join(installed, "releases", legacy), legacy);
  const current = join(installed, "current");
  symlinkSync(`releases/${legacy}`, current);
  const path = join(tree, "dist/codex-native.json");
  const record = JSON.parse(readFileSync(path, "utf8"));
  record.sha256 = "1".repeat(64);
  writeFileSync(path, JSON.stringify(record));
  writeBundleManifest(tree);
  expect(install().status).toBe(0);
  const result = switchTo(bundled);
  expect(result.status).toBe(78);
  expect(result.stderr).toContain("Codex native pin differs");
  expect(readlinkSync(current)).toBe(`releases/${legacy}`);
  expect(existsSync(join(installed, "previous"))).toBe(false);
});

it("returns exit 78 from the installed shim when the entry is missing", () => {
  expect(install().status).toBe(0);
  expect(switchTo(bundled).status).toBe(0);
  const selected = join(installed, "releases", bundled);
  rmSync(join(selected, "dist/kaoiro.mjs"));
  writeBundleManifest(selected);
  const result = runScript(join(installed, "current/deploy/kaoiro-runner-launch.sh"), [], {
    KAOIRO_RUNNER_DIR: conf,
  });
  expect(result.status).toBe(78);
  expect(result.stdout).not.toContain("bundled runner started");
});

it.skipIf(process.platform !== "linux").each([false, true])(
  "preserves Codex recovery across a bundled update (different pin: %s)",
  async (differentPin) => {
    const h = await createStateFixture();
    try {
      const first = h.forward();
      expect(first.status, first.stderr).toBe(0);
      const record = h.records()[0]!;
      const prune = h.state("prune", h.root, record.uuid);
      expect(prune.status, prune.stderr).toBe(0);
      expect(h.records()[0]?.snapshot.status).toBe("retired");
      const retired = readFileSync(h.recordPath(record.uuid));
      const path = join(tree, "dist/codex-native.json");
      const identity = JSON.parse(readFileSync(path, "utf8"));
      identity.sha256 = differentPin ? "2".repeat(64) : record.target.sha256;
      writeFileSync(path, JSON.stringify(identity));
      writeBundleManifest(tree);

      const backup = join(h.dir, "bundled-backup");
      const updater = join(tree, "deploy/kaoiro-runner-update.sh");
      const flags = ["--install-dir", h.root, "--service", "kogane468-test"];
      const forward = runScript(updater, [
        ...flags, "--tarball", archive(),
        ...(differentPin
          ? ["--codex-home", h.home, "--codex-backup-dir", backup] : []),
      ], h.env());
      expect(forward.status, forward.stderr).toBe(0);
      expect(h.current()).toBe(bundled);
      if (differentPin) {
        const restore = runScript(updater, [
          ...flags, "--codex-home", h.home, "--restore-codex-backup", backup,
        ], h.env());
        expect(restore.status, restore.stderr).toBe(0);
        expect(h.records().find((tx) => tx.uuid !== record.uuid)?.phase)
          .toBe("restored");
      } else {
        const back = runScript(join(tree, "deploy/kaoiro-runner-switch.sh"),
          ["--rollback", "--install-dir", h.root], h.env());
        expect(back.status, back.stderr).toBe(0);
      }
      expect(h.current()).toBe(h.B);
      expect(readFileSync(h.recordPath(record.uuid))).toEqual(retired);
    } finally {
      await h.close();
    }
  },
);
