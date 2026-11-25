import "../../scripts/test/fixtures/test-isolation.mjs";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
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
const stateTool = (args: string[]) => {
  const result = spawnSync(process.execPath, [
    "--experimental-vm-modules", "--disable-warning=ExperimentalWarning",
    join(tree, "deploy/kaoiro-runner-codex-state.mjs"), ...args,
  ], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};
/** Installs the bundle next to a legacy current with a different native. */
const installDifferingNative = () => {
  writeReleaseTree(join(installed, "releases", legacy), legacy);
  symlinkSync(`releases/${legacy}`, join(installed, "current"));
  const path = join(tree, "dist/codex-native.json");
  const record = JSON.parse(readFileSync(path, "utf8"));
  record.sha256 = "1".repeat(64);
  writeFileSync(path, JSON.stringify(record));
  writeBundleManifest(tree);
  expect(install().status).toBe(0);
};

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
  ["build identity and its record omitted", "dist/build-info.json", true],
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

it("rejects matching malformed Codex hashes before changing links", () => {
  const active = revisionOf("active-bundle");
  const releases = join(installed, "releases");
  const activeTree = writeBundleTree(join(releases, active), active);
  writeReleaseTree(join(releases, legacy), legacy);
  const current = join(installed, "current");
  const previous = join(installed, "previous");
  symlinkSync(`releases/${active}`, current);
  symlinkSync(`releases/${legacy}`, previous);

  // Equality alone would accept the same invalid digest in both releases.
  for (const release of [activeTree, tree]) {
    const path = join(release, "dist/codex-native.json");
    const record = JSON.parse(readFileSync(path, "utf8"));
    record.sha256 = "A".repeat(64);
    writeFileSync(path, JSON.stringify(record));
    writeBundleManifest(release);
  }

  const installation = install();
  expect(installation.status, installation.stderr).toBe(0);
  const result = switchTo(bundled);
  expect(result.status, result.stderr).toBe(78);
  expect(result.stderr).toContain("Invalid bundled Codex native identity");
  expect(readlinkSync(current)).toBe(`releases/${active}`);
  expect(readlinkSync(previous)).toBe(`releases/${legacy}`);
});

it("accepts a differing native only with the fixed accept word", () => {
  installDifferingNative();
  const guard = (accept: string[]) =>
    stateTool(["guard", installed, bundled, ...accept]);
  expect(guard([""]).status).toBe(78);
  expect(guard([""]).stderr).toContain("Codex native pin differs");
  expect(guard(["accept-native-change"]).status).toBe(0);
  for (const accept of [["yes"], ["--codex-native-change"], []]) {
    expect(guard(accept).status, accept.join()).toBe(64);
  }
  expect(readlinkSync(join(installed, "current"))).toBe(`releases/${legacy}`);
});

it("crosses a native change in either direction only with the flag", () => {
  installDifferingNative();
  const current = join(installed, "current");
  const previous = join(installed, "previous");
  const forward = run("switch",
    [bundled, "--install-dir", installed, "--codex-native-change"]);
  expect(forward.status, forward.stderr).toBe(0);
  expect(readlinkSync(current)).toBe(`releases/${bundled}`);

  const refused = switchTo("--rollback");
  expect(refused.status).toBe(78);
  expect(refused.stderr).toContain("--codex-native-change");
  expect(readlinkSync(current)).toBe(`releases/${bundled}`);
  expect(readlinkSync(previous)).toBe(`releases/${legacy}`);

  const back = run("switch",
    ["--rollback", "--install-dir", installed, "--codex-native-change"]);
  expect(back.status, back.stderr).toBe(0);
  expect(readlinkSync(current)).toBe(`releases/${legacy}`);
  expect(readlinkSync(previous)).toBe(`releases/${bundled}`);
});

it("passes a first install and keeps no release for Codex state", () => {
  expect(install().status).toBe(0);
  expect(stateTool(["guard", installed, bundled, ""]).status).toBe(0);
  const listed = stateTool(["protected", installed]);
  expect(listed).toEqual({ status: 0, stdout: "", stderr: "" });
  for (const action of ["preflight", "prepare", "prepare-restore", "resume",
    "recover", "prune", "promote", "next", "classify", "inspect"]) {
    expect(stateTool([action, installed, bundled, ""]).status, action).toBe(64);
  }
});

it("leaves the state capability line out of the native check", () => {
  // Updaters before this release read this exact line as the capability to
  // carry a retained snapshot; without it they refuse this release while a
  // snapshot is retained.
  const tool = fileURLToPath(
    new URL("../deploy/kaoiro-runner-codex-state.mjs", import.meta.url));
  expect(readFileSync(tool, "utf8"))
    .not.toMatch(/^export const CODEX_STATE_SCHEMA = 2;\r?$/m);
});

it("installs a bundle without the compatibility-only Codex files", () => {
  for (const name of ["codex-snapshot.mjs", "codex-service.mjs"]) {
    rmSync(join(tree, "deploy", name));
  }
  writeBundleManifest(tree);
  const result = install();
  expect(result.status, result.stderr).toBe(0);
});

it.each(["kaoiro-runner-codex-state.mjs", "codex-native.mjs"])(
  "refuses a bundle without deploy/%s", (name) => {
    rmSync(join(tree, "deploy", name));
    writeBundleManifest(tree);
    const result = install();
    expect(result.status).toBe(70);
    expect(result.stderr).toContain(`deploy/${name}`);
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
