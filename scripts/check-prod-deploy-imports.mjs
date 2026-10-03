#!/usr/bin/env node
// Checks that every bare import in a production deploy of the runner resolves
// to an installed package, without executing any of it.
//
//   node scripts/check-prod-deploy-imports.mjs <deploy-root>
//
// MANIFEST.json (build-release-manifest.mjs) follows `dependencies`, so a
// package that first-party code imports at runtime but declares only as a
// devDependency is absent from both the deploy and the manifest, and only
// fails at import on the installed host. This walks the same first-party
// dist trees and resolves each bare specifier the way node does, from the
// importing file's real directory upward through node_modules, but never
// above the deploy root: the installed host has nothing beyond it, while a
// deploy staged inside the workspace would otherwise resolve through the
// workspace's own node_modules.
//
// Executing the modules instead would start a wrapper: the engine entries
// are CLIs. Relative imports are the manifest's job and are not checked.
import { builtinModules } from "node:module";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, parse, sep } from "node:path";

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"'\s]+)["']/g;
const BUILTINS = new Set(builtinModules);

function jsFiles(dir, out) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) jsFiles(path, out);
    else if (/\.(?:m?js)$/.test(name)) out.push(path);
  }
  return out;
}

function within(path, boundary) {
  return path === boundary || path.startsWith(boundary + sep);
}

function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** The node_modules directories node would search from `dir`, nearest
 *  first, stopping at `boundary`. */
function searchPath(dir, boundary) {
  const dirs = [];
  for (;;) {
    dirs.push(join(dir, "node_modules"));
    if (dir === boundary) return dirs;
    const parent = dirname(dir);
    if (parent === dir || !within(parent, boundary)) return dirs;
    dir = parent;
  }
}

function resolvesFrom(file, name, boundary) {
  return searchPath(dirname(realpathSync(file)), boundary)
    .some((dir) => existsSync(join(dir, name, "package.json")));
}

/** First-party package roots: the deploy root and every @kaoiro package
 *  that node would find from one of them, by real path. */
function firstPartyRoots(boundary) {
  const roots = new Set([boundary]);
  const queue = [boundary];
  while (queue.length > 0) {
    const root = queue.shift();
    for (const modules of searchPath(root, boundary)) {
      const scope = join(modules, "@kaoiro");
      if (!existsSync(scope)) continue;
      for (const name of readdirSync(scope)) {
        const real = realpathSync(join(scope, name));
        if (within(real, boundary) && !roots.has(real)) {
          roots.add(real);
          queue.push(real);
        }
      }
    }
  }
  return [...roots];
}

export function checkDeploy(deployRoot) {
  const boundary = realpathSync(deployRoot);
  const missing = [];
  let files = 0;
  for (const root of firstPartyRoots(boundary)) {
    const dist = join(root, "dist");
    if (!existsSync(dist)) continue;
    for (const file of jsFiles(dist, [])) {
      files += 1;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(SPECIFIER)) {
        const specifier = match[1];
        if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
        if (specifier.startsWith("node:") || BUILTINS.has(packageName(specifier))) continue;
        const name = packageName(specifier);
        if (!resolvesFrom(file, name, boundary)) missing.push({ file, specifier });
      }
    }
  }
  return { files, missing };
}

if (process.argv[1] !== undefined && parse(process.argv[1]).name === "check-prod-deploy-imports") {
  const deployRoot = process.argv[2];
  if (deployRoot === undefined) {
    process.stderr.write("usage: check-prod-deploy-imports.mjs <deploy-root>\n");
    process.exit(2);
  }
  const { files, missing } = checkDeploy(deployRoot);
  if (files === 0) {
    process.stderr.write(`check-prod-deploy-imports: no first-party JS under ${deployRoot}\n`);
    process.exit(1);
  }
  for (const { file, specifier } of missing) {
    process.stderr.write(`check-prod-deploy-imports: ${file} imports "${specifier}", which is not installed\n`);
  }
  if (missing.length > 0) process.exit(1);
  process.stdout.write(`check-prod-deploy-imports: ${files} files, every bare import resolves\n`);
}
