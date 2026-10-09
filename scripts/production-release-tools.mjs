#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync,
  realpathSync, renameSync, chmodSync, writeFileSync, openSync, fsyncSync, closeSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RELEASE_DIGEST, RELEASE_SHA, parseReleaseOptions } from "./production-release-state.mjs";

const SCOPES = ["scripts", "scripts/lib", "server/deploy", "runner/deploy"];
const MANIFEST = "TOOL-MANIFEST.json";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const encode = value => `${JSON.stringify(value)}\n`;
const must = (condition, message) => { if (!condition) throw new Error(`release tooling refused: ${message}`); };
const syncPath = path => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
};
const safePath = value => typeof value === "string" && value.length <= 512 && /^[A-Za-z0-9._/-]+$/.test(value) &&
  !value.startsWith("/") && value.split("/").every(part => part && part !== "." && part !== "..");

function regularTool(root, name, { source = false } = {}) {
  must(safePath(name), "unsafe logical path");
  const path = join(root, name);
  const stat = lstatSync(path);
  must(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1_048_576 &&
    (stat.mode & (source ? 0o6002 : 0o6022)) === 0 && stat.uid === process.getuid() && realpathSync(path) === path,
  `non-regular/linked/unsafe tool: ${name}`);
  return path;
}

export function collectReleaseToolClosure(root) {
  root = realpathSync(root);
  const names = new Set();
  for (const scope of SCOPES) {
    const directory = join(root, scope);
    must(realpathSync(directory) === directory, `linked tool directory: ${scope}`);
    for (const name of readdirSync(directory)) {
      if (scope !== "runner/deploy" && !/\.(mjs|sh)$/.test(name) || /\.test\.mjs$/.test(name)) continue;
      names.add(`${scope}/${name}`);
    }
  }
  const pending = [...names];
  for (let index = 0; index < pending.length; index++) {
    const logical = pending[index];
    const path = regularTool(root, logical, { source: true });
    if (!logical.endsWith(".mjs")) continue;
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.[^"']+\.mjs)["']/g)) {
      const next = relative(root, resolve(dirname(path), match[1]));
      must(safePath(next), "first-party import escapes tooling root");
      if (!names.has(next)) { names.add(next); pending.push(next); }
    }
    must(names.size <= 512, "tool closure file bound");
  }
  const files = [...names].sort().map(path => ({ path, sha256: hash(readFileSync(regularTool(root, path, { source: true }))) }));
  return { schema: 1, files, sha256: hash(encode(files)) };
}

export function verifyReleaseToolClosure(root, expectedDigest, { actualRunnerDeploy } = {}) {
  must(RELEASE_DIGEST.test(expectedDigest ?? ""), "expected closure digest required");
  const raw = readFileSync(regularTool(root, MANIFEST));
  must(raw.length <= 131_072, "tool manifest bound");
  const manifest = JSON.parse(raw);
  must(manifest.schema === 1 && Array.isArray(manifest.files) && manifest.files.length >= 1 &&
    manifest.files.length <= 512 && hash(encode(manifest.files)) === expectedDigest && manifest.sha256 === expectedDigest, "tool manifest differs from captured closure");
  const paths = new Set();
  for (const item of manifest.files) {
    must(Object.keys(item).sort().join() === "path,sha256" && RELEASE_DIGEST.test(item.sha256 ?? "") &&
      !paths.has(item.path), "malformed or duplicate tool entry");
    paths.add(item.path);
    must(hash(readFileSync(regularTool(root, item.path))) === item.sha256, `captured tool changed: ${item.path}`);
    if (actualRunnerDeploy && item.path.startsWith("runner/deploy/")) {
      const path = join(actualRunnerDeploy, item.path.slice("runner/deploy/".length));
      const stat = lstatSync(path);
      must(stat.isFile() && !stat.isSymbolicLink() && realpathSync(path) === path &&
        hash(readFileSync(path)) === item.sha256, `physical updater tool changed: ${item.path}`);
    }
  }
  must(paths.has("scripts/production-release-launcher.mjs") && paths.has("runner/deploy/kaoiro-runner-update.sh"), "closure lacks launcher/updater");
  return manifest;
}

export function stageReleaseTools(source, destination) {
  const manifest = collectReleaseToolClosure(source);
  must(!existsSync(destination), "tool staging destination exists");
  mkdirSync(destination, { recursive: false, mode: 0o700 });
  for (const item of manifest.files) {
    const target = join(destination, item.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(regularTool(source, item.path, { source: true }), target, constants.COPYFILE_EXCL);
    chmodSync(target, item.path.endsWith(".sh") ? 0o755 : 0o644);
    syncPath(target);
  }
  writeFileSync(join(destination, MANIFEST), encode(manifest), { flag: "wx", mode: 0o644 });
  syncPath(join(destination, MANIFEST));
  const directories = new Set(manifest.files.flatMap(item => {
    const values = [];
    let directory = dirname(join(destination, item.path));
    while (directory !== destination) { values.push(directory); directory = dirname(directory); }
    return values;
  }));
  for (const path of [...directories].sort((a, b) => b.length - a.length)) syncPath(path);
  syncPath(destination);
  verifyReleaseToolClosure(destination, manifest.sha256);
  return manifest;
}

export function installReleaseTools({ source, root, revision, expectedDigest }) {
  must(RELEASE_SHA.test(revision ?? ""), "lowercase full tool revision required before path construction");
  verifyReleaseToolClosure(source, expectedDigest);
  if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
  const stat = lstatSync(root);
  must(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0 &&
    realpathSync(root) === resolve(root), "unsafe immutable tool installation root");
  const target = join(root, revision);
  if (existsSync(target)) { verifyReleaseToolClosure(target, expectedDigest); return { target, sha256: expectedDigest, reused: true }; }
  const temporary = join(root, `.staging-${randomUUID()}`);
  try {
    const manifest = stageReleaseTools(source, temporary);
    must(manifest.sha256 === expectedDigest, "source closure changed during installation");
    renameSync(temporary, target);
    syncPath(root);
  } finally { if (existsSync(temporary)) rmSync(temporary, { recursive: true }); }
  return { target, sha256: expectedDigest, reused: false };
}

export const currentReleaseToolRoot = () => resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, ...args] = process.argv.slice(2);
    const flags = parseReleaseOptions(args, ["source", "destination", "root", "revision", "expected-tool-sha256"]);
    const result = command === "stage" ? stageReleaseTools(flags.source, flags.destination) :
      command === "install" ? installReleaseTools({ source: flags.source, root: flags.root, revision: flags.revision, expectedDigest: flags["expected-tool-sha256"] }) :
      command === "verify" ? verifyReleaseToolClosure(flags.root, flags["expected-tool-sha256"]) : null;
    must(result, "unknown tool operation");
    console.log(JSON.stringify(result));
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 78; }
}
