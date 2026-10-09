#!/usr/bin/env node
import { spawnChildSync } from "./child-process-environment.mjs";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactBuildIdentity, assertSourceIdentity, consumeBuildIdentity, requireTaggedIdentity } from "./build-identity.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const requireTagged = args[0] === "--require-tagged";
if (requireTagged) args.shift();
if (args[0] === "--") args.shift();
const scratch = mkdtempSync(join(tmpdir(), "kaoiro-build-identity-"));
try {
  if (!args.length) throw new Error("a build command is required");
  const identity = requireTagged ? artifactBuildIdentity(requireTaggedIdentity(root)) : consumeBuildIdentity(root);
  assertSourceIdentity(root, identity);
  const file = join(scratch, "identity.json");
  writeFileSync(file, `${JSON.stringify(identity)}\n`, { flag: "wx", mode: 0o400 });
  const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
  const result = spawnChildSync("build", args[0], args.slice(1), { stdio: "inherit", env: { ...process.env,
    KAOIRO_BUILD_IDENTITY_FILE: file, KAOIRO_BUILD_IDENTITY_SHA256: digest,
    KAOIRO_BUILD_IDENTITY_JSON: JSON.stringify(identity),
    KAOIRO_BUILD_REVISION: identity.revision, KAOIRO_BUILD_DIRTY: String(identity.dirty),
    KAOIRO_BUILD_VERSION: identity.version, KAOIRO_BUILD_BRANCH: identity.branch,
    KAOIRO_BUILD_CHANNEL: identity.channel } });
  if (result.error || result.signal || result.status !== 0) throw new Error(`build failed: ${result.error?.message ?? result.signal ?? result.status}`);
  consumeBuildIdentity(root, { KAOIRO_BUILD_IDENTITY_FILE: file, KAOIRO_BUILD_IDENTITY_SHA256: digest });
  assertSourceIdentity(root, identity);
} catch (error) {
  process.stderr.write(`with-build-identity: ${error.message}\n`);
  process.exitCode = 78;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
