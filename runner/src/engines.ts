// The bundled engines and what `kaoiro wrapper <engine> <verb>` runs
// (ADR-0076). This is the only list of the engine names on the start path:
// the launcher passes a name through, and the entry looks it up here. A verb
// imports its module when it runs, so one engine never loads another.

import type { EngineKind } from "@kaoiro/protocol";

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
    },
  },
  antigravity: {
    verbs: {
      run: run(async () => (await import("@kaoiro/antigravity/dist/cli.js")).runAntigravityCli),
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
