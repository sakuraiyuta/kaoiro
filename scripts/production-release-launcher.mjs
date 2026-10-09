#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const must = (value, message) => { if (!value) throw new Error(`release bootstrap refused: ${message}`); };
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function verifyLauncherClosure(expected, actualDeploy) {
  must(typeof expected === "string" && /^[0-9a-f]{64}$/.test(expected), "captured closure digest required");
  const manifestPath = join(root, "TOOL-MANIFEST.json");
  const manifestStat = lstatSync(manifestPath);
  must(manifestStat.isFile() && !manifestStat.isSymbolicLink() && realpathSync(manifestPath) === manifestPath &&
    (manifestStat.mode & 0o6022) === 0 && manifestStat.size <= 131_072, "unsafe manifest file");
  const raw = readFileSync(manifestPath);
  must(raw.length <= 131_072, "manifest bound");
  const manifest = JSON.parse(raw);
  must(manifest.schema === 1 && manifest.sha256 === expected && Array.isArray(manifest.files) &&
    manifest.files.length >= 1 && manifest.files.length <= 512 &&
    digest(`${JSON.stringify(manifest.files)}\n`) === expected, "manifest/captured digest differs");
  const seen = new Set();
  for (const item of manifest.files) {
    must(typeof item.path === "string" && /^[A-Za-z0-9._/-]+$/.test(item.path) && !item.path.startsWith("/") &&
      item.path.split("/").every(part => part && part !== "." && part !== "..") &&
      /^[0-9a-f]{64}$/.test(item.sha256 ?? "") && !seen.has(item.path), "unsafe/duplicate manifest path");
    seen.add(item.path);
    const path = join(root, item.path);
    const stat = lstatSync(path);
    must(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o6022) === 0 && stat.size <= 1_048_576 && realpathSync(path) === path &&
      digest(readFileSync(path)) === item.sha256, "captured module changed");
    if (actualDeploy && item.path.startsWith("runner/deploy/")) {
      const current = join(actualDeploy, item.path.slice("runner/deploy/".length));
      const stat = lstatSync(current);
      must(stat.isFile() && !stat.isSymbolicLink() && realpathSync(current) === current &&
        digest(readFileSync(current)) === item.sha256, "actual updater closure differs");
    }
  }
  must(seen.has("scripts/production-release-launcher.mjs"), "launcher omitted from closure");
  return manifest;
}

async function main() {
  const [operation, expected, ...args] = process.argv.slice(2);
  const actualDeploy = operation === "worker" || operation.startsWith("runner-") ? args[0] : undefined;
  verifyLauncherClosure(expected, actualDeploy);
  if (operation === "worker") {
    must(actualDeploy && realpathSync(actualDeploy) === actualDeploy, "physical deploy path required");
    execFileSync(join(actualDeploy, "kaoiro-runner-update.sh"), args.slice(1), { stdio: "inherit", env: process.env });
  } else if (operation === "export" || operation === "import") {
    const endpoint = await import("./production-release-endpoint.mjs");
    await endpoint.runReleaseEndpoint(operation, expected);
  } else if (operation === "audit") {
    const { runReconciliationCli } = await import("./production-release-reconciliation.mjs");
    await runReconciliationCli(args);
  } else if (["runner-audit", "runner-seal", "runner-switch", "runner-cleanup", "runner-restore-admission", "runner-recovery-switch"].includes(operation)) {
    const { runRunnerReleaseGate } = await import("./production-release-runner.mjs");
    const result = await runRunnerReleaseGate(operation, args.slice(1), { toolRoot: root, toolDigest: expected, actualDeploy });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else throw new Error("unknown fixed release bootstrap operation");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = error.status || 78; }
}
