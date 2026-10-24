import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LEGACY_CHILD_CALLS = {
  "runner/deploy/codex-service.mjs": 1,
  "scripts/check-github-issue-import.mjs": 1,
  "scripts/github-issue-import.mjs": 1,
  "server/deploy/kaoiro-deploy-docker.mjs": 1,
};
const nativeCalls = /\b(?:execFileSync|execFile|execSync|spawnSync|spawn|fork)\s*\(/g;

export const CHILD_ENVIRONMENT_SCOPE = [
  "scripts/build-identity.mjs", "scripts/with-build-identity.mjs",
  "server/deploy/kaoiro-server-deploy.mjs",
];

const SOURCE_DIRECTORIES = ["scripts", "scripts/lib", "server/deploy", "runner/deploy"];

function checkedSource(root, name) {
  if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.startsWith("/") ||
      name.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("child source escapes repository: " + name);
  }
  const path = join(root, name), stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error("child source must be a regular unlinked file: " + name);
  }
  return path;
}

function collectChildSources(root) {
  root = realpathSync(root);
  const names = new Set();
  for (const scope of SOURCE_DIRECTORIES) {
    const directory = join(root, scope);
    if (realpathSync(directory) !== directory) throw new Error("linked child source directory: " + scope);
    for (const name of readdirSync(directory)) {
      if ((scope !== "runner/deploy" && !/\.(mjs|sh)$/.test(name)) || /\.test\.mjs$/.test(name)) continue;
      names.add(`${scope}/${name}`);
    }
  }
  const pending = [...names];
  for (let index = 0; index < pending.length; index++) {
    if (names.size > 512) throw new Error("child source file bound");
    const name = pending[index], path = checkedSource(root, name);
    if (!name.endsWith(".mjs")) continue;
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.[^"']+\.mjs)["']/g)) {
      const next = relative(root, resolve(dirname(path), match[1]));
      checkedSource(root, next);
      if (!names.has(next)) { names.add(next); pending.push(next); }
    }
  }
  return [...names].sort();
}

export function checkReleaseChildEnvironments(root, read = readFileSync) {
  let calls = 0;
  const sources = collectChildSources(root);
  for (const path of sources.filter(name => name.endsWith(".mjs"))) {
    if (path === "runner/deploy/child-process-environment.mjs") continue;
    const source = read(resolve(root, path), "utf8");
    const native = [...source.matchAll(nativeCalls)].length;
    if (native || /(?:from\s*|import\s*\(|require\s*\()\s*["'](?:node:)?child_process["']/.test(source)) {
      if (!Object.hasOwn(LEGACY_CHILD_CALLS, path) || native !== LEGACY_CHILD_CALLS[path]) {
        throw new Error("unmanaged child process: " + path);
      }
    }
  }
  for (const name of CHILD_ENVIRONMENT_SCOPE) {
    const source = read(resolve(root, name), "utf8");
    if (!source.includes("child-process-environment.mjs")) throw new Error("child helper import missing: " + name);
    const count = [...source.matchAll(/\b(?:execChildSync|spawnChildSync)\s*\(/g)].length;
    if (!count) throw new Error("child scope has no checked call: " + name);
    calls += count;
  }
  return { files: CHILD_ENVIRONMENT_SCOPE.length, calls, closure_files: sources.length,
    unchanged_legacy_calls: Object.values(LEGACY_CHILD_CALLS).reduce((a, b) => a + b, 0) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(checkReleaseChildEnvironments(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)))));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
