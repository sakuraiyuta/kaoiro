import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync,
  statSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineKind } from "@kaoiro/protocol";
import { effectiveCapabilities, loadRunnerConfig } from "./config.js";
import { engineArtifact, engineBinaryPath, isEngine } from "./engines.js";

export async function installEngines(
  root: string, configPath: string, registry = "https://registry.npmjs.org",
): Promise<void> {
  try { statSync(configPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    process.stderr.write("engines: config missing; skipping acquisition\n");
    return;
  }
  const capabilities = effectiveCapabilities(loadRunnerConfig(configPath));
  for (const value of capabilities) {
    if (!isEngine(value)) continue;
    const artifact = engineArtifact(value);
    if (!artifact) {
      if (value === "claude-code" || value === "codex") {
        throw new Error(`No artifact for ${value} on this host`);
      }
      continue;
    }
    await installArtifact(root, value, artifact, registry);
  }
}

export async function installArtifact(
  root: string, engine: EngineKind,
  artifact: { name: string; version: string; integrity: string },
  registry: string,
): Promise<void> {
  const store = join(root, "engines");
  const basename = artifact.name.split("/")[1]!;
  const destination = join(store, `${basename}@${artifact.version}`);
  if (existsSync(destination)) return;
  mkdirSync(store, { recursive: true });
  const stage = mkdtempSync(join(store, ".staging-"));
  try {
    const suffix = basename.slice("codex-".length);
    const codexVersion = `${artifact.version}-${suffix}`;
    const url = engine === "codex"
      ? `${registry}/@openai/codex/-/codex-${codexVersion}.tgz`
      : `${registry}/${artifact.name}/-/${basename}-${artifact.version}.tgz`;
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`Engine fetch failed: ${response.status}`);
    }
    const archive = join(stage, "package.tgz");
    const file = await open(archive, "w");
    const hash = createHash("sha512");
    try {
      for await (const chunk of response.body) {
        hash.update(chunk);
        await file.writeFile(chunk);
      }
    } finally {
      await file.close();
    }
    if (`sha512-${hash.digest("base64")}` !== artifact.integrity) {
      throw new Error(`Engine integrity mismatch: ${artifact.name}`);
    }
    const unpack = spawnSync("tar", ["-xzf", archive, "-C", stage], {
      stdio: "inherit",
    });
    if (unpack.status !== 0) {
      throw new Error(`Engine unpack failed: ${artifact.name}`);
    }
    const pkg = join(stage, "package");
    if (engine === "codex") {
      const identityFile = fileURLToPath(
        new URL("./codex-native.json", import.meta.url),
      );
      const identity = JSON.parse(readFileSync(identityFile, "utf8")) as {
        version: string; sha256: string;
      };
      const binary = engineBinaryPath(engine, pkg);
      const digest = createHash("sha256")
        .update(readFileSync(binary)).digest("hex");
      if (identity.version !== artifact.version || identity.sha256 !== digest) {
        throw new Error("Codex native identity mismatch");
      }
    }
    try {
      renameSync(pkg, destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export async function runEngines(args: string[]): Promise<void> {
  if (args.length !== 3 || args[0] !== "install" ||
      args[1] !== "--install-dir") {
    throw new Error("usage: kaoiro engines install --install-dir <dir>");
  }
  const config = process.env.KAOIRO_RUNNER_CONFIG;
  if (!config) throw new Error("KAOIRO_RUNNER_CONFIG is required");
  await installEngines(args[2]!, config);
}
