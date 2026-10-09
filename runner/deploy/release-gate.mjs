#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

try {
  const [operation, root, ...args] = process.argv.slice(2);
  const descriptor = join(resolve(root), "release-authority.json");
  try { lstatSync(descriptor); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (["--expected-authority-sha256", "--release-attempt", "--release-plan-sha256", "--release-authority",
      "--skip-release-reconciliation", "--skip-reason"].some(flag => args.includes(flag))) {
      throw new Error("expected production release authority is absent");
    }
    process.stdout.write('{"status":"generic","pass":true}\n');
    process.exit(0);
  }
  const deploy = realpathSync(dirname(fileURLToPath(import.meta.url)));
  const tools = join(deploy, "release-tools");
  const manifestPath = join(tools, "TOOL-MANIFEST.json");
  const stat = lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 131_072) throw new Error("unsafe release tool manifest");
  const manifest = JSON.parse(readFileSync(manifestPath));
  const result = execFileSync(process.execPath, [join(tools, "scripts/production-release-launcher.mjs"), operation,
    manifest.sha256, deploy, "--install-root", realpathSync(root), ...args],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: operation === "runner-audit" ? 125_000 : 15_000, maxBuffer: 65_536 });
  process.stdout.write(result);
} catch (error) {
  process.stderr.write(`${error.stderr ? String(error.stderr).trim() : error.message}\n`);
  process.exitCode = 78;
}
