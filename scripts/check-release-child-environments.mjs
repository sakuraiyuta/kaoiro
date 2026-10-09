import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectReleaseToolClosure } from "./production-release-tools.mjs";

const LEGACY_CHILD_CALLS = {
  "runner/deploy/codex-service.mjs": 1,
  "scripts/check-github-issue-import.mjs": 1,
  "scripts/github-issue-import.mjs": 1,
  "server/deploy/kaoiro-deploy-docker.mjs": 1,
  "server/deploy/kaoiro-server-deploy.mjs": 9,
};
const nativeCalls = /\b(?:execFileSync|execFile|execSync|spawnSync|spawn|fork)\s*\(/g;

export const CHILD_ENVIRONMENT_SCOPE = [
  "scripts/build-identity.mjs", "scripts/landing-backlog.mjs", "scripts/landing-repair-records.mjs",
  "scripts/landing-repair-ssh.mjs", "scripts/landing-tags.mjs", "scripts/landing-workflow.mjs",
  "scripts/production-release-authority.mjs", "scripts/production-release-card.mjs",
  "scripts/production-release-launcher.mjs", "scripts/production-release-reconciliation.mjs",
  "scripts/production-release-tags.mjs", "scripts/production-release-unit.mjs",
  "scripts/production-release-workflow.mjs", "scripts/production-runner-worker.mjs",
  "scripts/with-build-identity.mjs", "runner/deploy/release-gate.mjs",
  "server/deploy/kaoiro-release-reconciliation.mjs",
];

export function checkReleaseChildEnvironments(root, read = readFileSync) {
  let calls = 0;
  const closure = collectReleaseToolClosure(root);
  for (const { path } of closure.files.filter(item => item.path.endsWith(".mjs"))) {
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
  return { files: CHILD_ENVIRONMENT_SCOPE.length, calls, closure_files: closure.files.length,
    unchanged_legacy_calls: Object.values(LEGACY_CHILD_CALLS).reduce((a, b) => a + b, 0) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(checkReleaseChildEnvironments(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)))));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
