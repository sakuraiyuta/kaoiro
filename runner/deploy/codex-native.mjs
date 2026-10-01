import { hasEntry } from "./codex-snapshot.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

function contained(root, path) {
  const real = realpathSync(path);
  const rel = relative(root, real);
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error("Codex runtime resolves outside its release");
  }
  return real;
}

export async function nativeIdentity(release) {
  const root = realpathSync(release);
  const cli = contained(root, join(root, "node_modules/@kaoiro/codex/dist/cli.js"));
  const fromWrapper = createRequire(cli);
  const sdkManifest = (fromWrapper.resolve.paths("@openai/codex-sdk") ?? [])
    .map((dir) => join(dir, "@openai/codex-sdk/package.json"))
    .find((path) => hasEntry(path));
  if (!sdkManifest) throw new Error("Codex SDK is missing");
  const sdkPackage = contained(root, sdkManifest);
  const importEntry = JSON.parse(readFileSync(sdkPackage, "utf8")).exports?.["."]?.import;
  if (typeof importEntry !== "string" || !importEntry.startsWith("./")) {
    throw new Error("Unsupported SDK import entry");
  }
  const sdkEntry = contained(root, join(dirname(sdkPackage), importEntry));
  const rpcEntry = contained(root, join(dirname(cli), "app_server_rpc.js"));
  // Resolution executes trusted release code. Hash/manifest verification
  // detects accidental corruption; it does not sandbox an untrusted archive.
  const [{ Codex }, { resolveAppServerBinary }] = await Promise.all([
    import(pathToFileURL(sdkEntry).href),
    import(pathToFileURL(rpcEntry).href),
  ]);
  // Both pinned SDKs resolve in the constructor without spawning. This
  // intentionally fails if that inspected private interface ever changes.
  const sdk = new Codex();
  const execPath = sdk.exec?.executablePath;
  if (typeof execPath !== "string") throw new Error("Unsupported SDK native resolver interface");
  const exec = contained(root, execPath);
  const app = contained(root, resolveAppServerBinary());
  if (exec !== app) throw new Error("Codex backend native paths disagree");
  if (!statSync(exec).isFile() || !(statSync(exec).mode & 0o111)) {
    throw new Error("Codex native path is not executable");
  }
  const platform = process.platform === "android" ? "linux" : process.platform;
  const triples = {
    "linux:x64": "x86_64-unknown-linux-musl", "linux:arm64": "aarch64-unknown-linux-musl",
    "darwin:x64": "x86_64-apple-darwin", "darwin:arm64": "aarch64-apple-darwin",
  };
  const triple = triples[`${platform}:${process.arch}`];
  if (!triple) throw new Error("Unsupported Codex activation platform");
  const pkg = contained(root, fromWrapper.resolve("@openai/codex/package.json"));
  const roots = new Set([dirname(pkg)]);
  for (let dir = dirname(pkg); ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules/@openai", `codex-${platform}-${process.arch}`);
    if (hasEntry(join(candidate, "package.json"))) roots.add(realpathSync(candidate));
    if (dirname(dir) === dir) break;
  }
  const candidates = new Set();
  for (const pkgRoot of roots) {
    for (const layout of ["bin", "codex"]) {
      const candidate = join(pkgRoot, "vendor", triple, layout, "codex");
      if (hasEntry(candidate)) candidates.add(contained(root, candidate));
    }
  }
  if (candidates.size !== 1 || !candidates.has(exec)) {
    throw new Error("Ambiguous Codex native candidates");
  }
  return {
    path: relative(root, exec),
    version: JSON.parse(readFileSync(pkg, "utf8")).version,
    sha256: createHash("sha256").update(readFileSync(exec)).digest("hex"),
  };
}
