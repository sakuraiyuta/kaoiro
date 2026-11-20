// The bundled engines and what `kaoiro wrapper <engine> <verb>` runs
// (ADR-0076). This is the only list of the engine names on the start path:
// the launcher passes a name through, and the entry looks it up here. A verb
// imports its module when it runs, so one engine never loads another.

import type { EngineKind } from "@kaoiro/protocol";
import { ENGINE_ARTIFACTS } from "@kaoiro/agent-common";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Receives the arguments that follow the verb. */
type Verb = (args: string[]) => void | Promise<void>;
type RunCli = (dependencies: Record<string, never>, argv: string[]) => Promise<unknown>;

const run = (load: () => Promise<RunCli>): Verb =>
  async (args) => {
    await (await load())({}, ["run", ...args]);
  };

type ArtifactName = (platform: string, arch: string, libc: "glibc" | "musl") => string;
type Engine = { verbs: Record<string, Verb>; artifactName?: ArtifactName };

export const ENGINES: Record<EngineKind, Engine> = {
  "claude-code": {
    artifactName: (platform, arch, libc) =>
      `@anthropic-ai/claude-agent-sdk-${platform}-${arch}${
        platform === "linux" && libc === "musl" ? "-musl" : ""}`,
    verbs: {
      run: run(async () => (await import("@kaoiro/claude-code/dist/cli.js")).runClaudeCli),
      probe: async (args) => {
        (await import("@kaoiro/claude-code/dist/probe.js")).runProbeProcess(args);
      },
    },
  },
  codex: {
    artifactName: (platform, arch) => `@openai/codex-${platform}-${arch}`,
    verbs: {
      run: run(async () => (await import("@kaoiro/codex/dist/cli.js")).runCodexCli),
      bridge: async () => {
        await (await import("@kaoiro/codex/dist/bridge.js")).main();
      },
    },
  },
  antigravity: {
    verbs: {
      run: run(async () => (await import("@kaoiro/antigravity/dist/cli.js")).runAntigravityCli),
      hook: async () => {
        await (await import("@kaoiro/antigravity/dist/hook.js")).runAntigravityHook();
      },
      bridge: async (args) => {
        await (await import("@kaoiro/antigravity/dist/bridge.js")).runAntigravityBridge(args);
      },
    },
  },
  grok: {
    verbs: {
      run: run(async () => (await import("@kaoiro/grok/dist/cli.js")).runGrokCli),
    },
  },
};

export function isEngine(value: unknown): value is EngineKind {
  return typeof value === "string" && Object.hasOwn(ENGINES, value);
}

export function hostLibc(): "glibc" | "musl" {
  const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } };
  return report.header.glibcVersionRuntime ? "glibc" : "musl";
}

export function engineArtifact(engine: EngineKind) {
  const name = ENGINES[engine].artifactName?.(process.platform, process.arch, hostLibc());
  return ENGINE_ARTIFACTS.find((item) => item.name === name);
}

export function engineBinaryPath(
  engine: EngineKind, packageDir: string,
  platform = process.platform, arch = process.arch,
): string {
  if (engine === "claude-code") return join(packageDir, "claude");
  const triples: Record<string, string> = {
    "linux:x64": "x86_64-unknown-linux-musl",
    "linux:arm64": "aarch64-unknown-linux-musl",
    "darwin:x64": "x86_64-apple-darwin",
    "darwin:arm64": "aarch64-apple-darwin",
  };
  const triple = triples[`${platform}:${arch}`];
  if (!triple) throw new Error("Unsupported Codex platform");
  return join(packageDir, "vendor", triple, "bin", "codex");
}

declare const __KAOIRO_BUNDLED__: true | undefined;

export function storedEngineExecutable(engine: EngineKind): string | undefined {
  const store = process.env.KAOIRO_ENGINE_STORE_DIR;
  if (store) {
    const artifact = engineArtifact(engine);
    if (artifact) {
      const version = `${artifact.name.split("/")[1]}@${artifact.version}`;
      const binary = engineBinaryPath(engine, join(store, version));
      if (existsSync(binary)) return binary;
    }
  }
  if (typeof __KAOIRO_BUNDLED__ !== "undefined" &&
      ENGINES[engine].artifactName !== undefined) {
    throw new Error(
      `Pinned ${engine} executable is missing; run the release's engines install`,
    );
  }
  return undefined;
}
