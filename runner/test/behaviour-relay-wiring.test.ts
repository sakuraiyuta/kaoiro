import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WrapperConfig } from "@kaoiro/protocol";
import { watchRunnerConfig } from "../src/config-watcher.js";
import { runRunnerCli } from "../src/runner-cli.js";
import type { RunnerLinkOptions } from "../src/transport.js";
import type { ManagedChild } from "../src/supervisor.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function harness(root: string, configPath: string) {
  const configs: WrapperConfig[] = [];
  const children: ManagedChild[] = [];
  let callbacks!: RunnerLinkOptions;
  let fire!: () => void;
  const fsWatch = ((_dir: string, _options: unknown, listener: (e: string, f: string) => void) => {
    fire = () => listener("change", "runner.config.json");
    return { close() {}, on() { return this; } };
  }) as unknown as typeof watch;
  const dependencies = {
    makeLauncher: () => (_agent: string, config: WrapperConfig) => {
      configs.push(config);
      const child = { on: () => {}, kill: vi.fn(() => true) };
      children.push(child);
      return child;
    },
    createRunnerLink: (_url: string, _id: string, options: RunnerLinkOptions) => {
      callbacks = options;
      return {
        sendSpawnResult() {},
        sendSessions() {},
        sendResetResult() {},
        sendStopAgent() {},
        sendCatalogResult() {},
        updateRegister() {},
        reconnect() {},
        close() {},
      };
    },
    // The real watcher (debounce, parse-error handling); only fs.watch is fake.
    watchRunnerConfig: (
      path: string,
      onReload: Parameters<typeof watchRunnerConfig>[1],
      onParseError: Parameters<typeof watchRunnerConfig>[2],
    ) => watchRunnerConfig(path, onReload, onParseError, { watch: fsWatch }),
    installSignalHandlers: false,
  };
  const spawn = (id: string, engine = "claude-code") => ({
    version: "0",
    agent_id: id,
    persona: { id: "p", name: "P", sprite_set: "p" },
    cwd: root,
    engine,
  });
  const reload = async (runtime: { waitForReloads(): Promise<void> }) => {
    fire();
    await sleep(350);
    await runtime.waitForReloads();
  };
  return {
    configs,
    children,
    dependencies,
    spawn,
    reload,
    callbacks: () => callbacks,
    configPath,
    writeConfig: (extra: Record<string, unknown>, capabilities = ["claude-code", "codex"]) =>
      writeFileSync(
        configPath,
        JSON.stringify({
          host_id: "fixture",
          server_url: "ws://fixture/runner",
          cwd_allowlist: [root],
          capabilities,
          codex: { auth_mode: "chatgpt" },
          ...extra,
        }),
      ),
  };
}

function withRoot<T>(run: (root: string, configPath: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "ao-469-relay-"));
  return run(root, join(root, "runner.config.json")).finally(() =>
    rmSync(root, { recursive: true, force: true }),
  );
}

describe("behaviour settings relay (issue #469)", () => {
  it("relays file values to Claude wrappers from the next lifetime and rejects an invalid reload", () =>
    withRoot(async (root, configPath) => {
      const h = harness(root, configPath);
      const diagnostic = vi.spyOn(process.stderr, "write");
      h.writeConfig({ claude_code: { folds_per_turn: 5 } });
      const runtime = await runRunnerCli(h.dependencies, [configPath]);
      try {
        h.callbacks().onSpawn?.(h.spawn("a"));
        h.callbacks().onSpawn?.(h.spawn("codex-one", "codex"));
        expect(h.configs[0]?.folds_per_turn).toBe(5);
        expect(h.configs[0]).not.toHaveProperty("urgent_overtake_limit");
        expect(h.configs[1]).not.toHaveProperty("folds_per_turn");

        // A valid reload reaches the next spawn only; the running one keeps 5.
        h.writeConfig({ claude_code: { folds_per_turn: 6, urgent_overtake_limit: 3 } });
        await h.reload(runtime!);
        expect(h.configs[0]?.folds_per_turn).toBe(5);
        h.callbacks().onSpawn?.(h.spawn("b"));
        expect(h.configs[2]).toMatchObject({ folds_per_turn: 6, urgent_overtake_limit: 3 });
        expect(
          diagnostic.mock.calls.some(([s]) =>
            /behaviour settings for subsequent wrappers: .*claude-code\.folds_per_turn=6/.test(
              String(s),
            ),
          ),
        ).toBe(true);

        // An invalid value is skipped: the last valid configuration stays.
        h.writeConfig({ claude_code: { folds_per_turn: 65 } });
        await h.reload(runtime!);
        h.callbacks().onSpawn?.(h.spawn("c"));
        expect(h.configs[3]).toMatchObject({ folds_per_turn: 6, urgent_overtake_limit: 3 });

        // Removing the key falls back to the wrapper default (nothing relayed).
        h.writeConfig({});
        await h.reload(runtime!);
        h.callbacks().onSpawn?.(h.spawn("d"));
        expect(h.configs[4]).not.toHaveProperty("folds_per_turn");
      } finally {
        runtime?.close();
        diagnostic.mockRestore();
      }
    }));

  it("a set variable wins: nothing is relayed for that key, with deprecation and shadow warnings", () =>
    withRoot(async (root, configPath) => {
      vi.stubEnv("KAOIRO_CLAUDE_FOLDS_PER_TURN", "9");
      const h = harness(root, configPath);
      const lines: string[] = [];
      const diagnostic = vi
        .spyOn(process.stderr, "write")
        .mockImplementation((chunk) => {
          lines.push(String(chunk));
          return true;
        });
      h.writeConfig({ claude_code: { folds_per_turn: 5, urgent_overtake_limit: 3 } });
      const runtime = await runRunnerCli(h.dependencies, [configPath]);
      try {
        h.callbacks().onSpawn?.(h.spawn("a"));
        // The wrapper will read the inherited variable itself.
        expect(h.configs[0]).not.toHaveProperty("folds_per_turn");
        expect(h.configs[0]?.urgent_overtake_limit).toBe(3);
        const deprecated = () =>
          lines.filter((l) => l.includes("KAOIRO_CLAUDE_FOLDS_PER_TURN is deprecated"));
        const shadowed = () => lines.filter((l) => l.includes("is shadowed by"));
        expect(deprecated()).toHaveLength(1);
        expect(shadowed()).toHaveLength(1);

        // file=A/variable=B then file=C/variable=B: no effective change, the
        // shadow warning still fires, the deprecation line does not repeat.
        h.writeConfig({ claude_code: { folds_per_turn: 7, urgent_overtake_limit: 3 } });
        await h.reload(runtime!);
        expect(shadowed()).toHaveLength(2);
        expect(deprecated()).toHaveLength(1);
        h.callbacks().onSpawn?.(h.spawn("b"));
        expect(h.configs[1]).not.toHaveProperty("folds_per_turn");

        // Unrelated reload: no repeat.
        h.writeConfig({
          claude_code: { folds_per_turn: 7, urgent_overtake_limit: 4 },
        });
        await h.reload(runtime!);
        expect(shadowed()).toHaveLength(2);
        expect(h.configs.length).toBe(2);
      } finally {
        runtime?.close();
        diagnostic.mockRestore();
      }
    }));

  it("an invalid variable of an enabled engine stops the runner at start; a disabled engine's does not", () =>
    withRoot(async (root, configPath) => {
      const h = harness(root, configPath);
      const diagnostic = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        vi.stubEnv("KAOIRO_CLAUDE_FOLDS_PER_TURN", " ");
        h.writeConfig({});
        await expect(runRunnerCli(h.dependencies, [configPath])).rejects.toThrow(
          "KAOIRO_CLAUDE_FOLDS_PER_TURN must be an integer from 1 through 64",
        );
        h.writeConfig({}, ["codex"]);
        const runtime = await runRunnerCli(h.dependencies, [configPath]);
        runtime?.close();
        expect(runtime).toBeDefined();
      } finally {
        diagnostic.mockRestore();
      }
    }));
});
