import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { engineBinaryPath } from "../runner/dist/engines.js";

const [root, target] = process.argv.slice(2);
const [platform, arch] = (target ?? "").split("-");
if (!root || !["linux-x64", "darwin-arm64"].includes(target)) {
  throw new Error("unsupported Codex target");
}
const artifacts = await import(
  "../wrapper/agent-common/dist/engine-artifacts.js"
);
const expected = artifacts.ENGINE_ARTIFACTS.find(
  (row) => row.name === `@openai/codex-${target}`,
);
if (!expected) throw new Error("Codex target missing from artifact table");
const modules = join(root, "node_modules", ".pnpm");
const candidates = readdirSync(modules).filter((name) =>
  name.startsWith(`@openai+codex@${expected.version}-${target}`));
if (candidates.length !== 1) {
  throw new Error("Codex target package is missing or ambiguous");
}
const packageRoot = join(modules, candidates[0], "node_modules/@openai/codex");
const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
if (pkg.version !== `${expected.version}-${target}`) {
  throw new Error("Codex version mismatch");
}
const binary = engineBinaryPath("codex", packageRoot, platform, arch);
const sha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
writeFileSync(join(root, "dist/codex-native.json"), `${JSON.stringify({
  path: relative(root, binary), version: expected.version, sha256,
})}\n`);
