import "../../scripts/test/fixtures/test-isolation.mjs";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WrapperConfig } from "@kaoiro/protocol";
import { runRunnerCli } from "../src/runner-cli.js";
import type { RunnerLinkOptions } from "../src/transport.js";
import type { ManagedChild } from "../src/supervisor.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

function harness(root: string, configPath: string) {
  const configs: WrapperConfig[] = [];
  const children: ManagedChild[] = [];
  let callbacks!: RunnerLinkOptions;
  let connectedUrl = "";
  const dependencies = {
    makeLauncher: () => (_agent: string, config: WrapperConfig) => {
      configs.push(config);
      const child = { on: () => {}, kill: vi.fn(() => true) };
      children.push(child);
      return child;
    },
    createRunnerLink: (_url: string, _id: string, options: RunnerLinkOptions) => {
      connectedUrl = _url;
      callbacks = options;
      return {
        sendSpawnResult() {},
        sendSessions() {},
        sendResetResult() {},
        sendStopAgent() {},
        sendCatalogResult() {},
        updateRegister() {},
        close() {},
      };
    },
    installSignalHandlers: false,
  };
  const spawn = (id: string, engine = "claude-code") => ({
    version: "0",
    agent_id: id,
    persona: { id: "p", name: "P", sprite_set: "p" },
    cwd: root,
    engine,
  });
  return {
    connectedUrl: () => connectedUrl,
    configs,
    children,
    dependencies,
    spawn,
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
  it("relays file values to Claude wrappers from startup settings", () =>
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
      } finally {
        runtime?.close();
        diagnostic.mockRestore();
      }
    }));

  it.each(["codex", "antigravity"] as const)(
    "%s: relays the startup watchdog",
    (block) =>
      withRoot(async (root, configPath) => {
        const h = harness(root, configPath);
        const diagnostic = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const capabilities = ["claude-code", "codex", "antigravity"];
        const agy = join(root, "agy");
        writeFileSync(agy, "#!/bin/sh\nexit 0\n");
        chmodSync(agy, 0o755);
        // Antigravity is enabled for both parameters, so startup probes agy;
        // every parameter must point that probe at the stub, not host PATH.
        const relay = { turn_watchdog_inactivity_ms: 90_000 };
        h.writeConfig(
          block === "codex"
            ? {
                codex: { auth_mode: "chatgpt", ...relay },
                antigravity: { cli_path: agy },
              }
            : { antigravity: { auth: "google-cloud-sign-in", cli_path: agy, ...relay } },
          capabilities,
        );
        const runtime = await runRunnerCli(h.dependencies, [configPath]);
        try {
          h.callbacks().onSpawn?.(h.spawn("a", block));
          expect(h.configs[0]?.turn_watchdog_inactivity_ms).toBe(90_000);
        } finally {
          runtime?.close();
          diagnostic.mockRestore();
        }
      }),
  );

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
      } finally {
        runtime?.close();
        diagnostic.mockRestore();
      }
    }));

  it("Antigravity tool_timeout_ms and epoch_idle_ms reach Antigravity wrappers from the next lifetime", () =>
    withRoot(async (root, configPath) => {
      const h = harness(root, configPath);
      const diagnostic = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const capabilities = ["claude-code", "codex", "antigravity"];
      const agy = join(root, "agy");
      writeFileSync(agy, "#!/bin/sh\nexit 0\n");
      chmodSync(agy, 0o755);
      h.writeConfig(
        { antigravity: { auth: "google-cloud-sign-in", cli_path: agy,
          tool_timeout_ms: 2000, epoch_idle_ms: 3000 } },
        capabilities,
      );
      const runtime = await runRunnerCli(h.dependencies, [configPath]);
      try {
        h.callbacks().onSpawn?.(h.spawn("a", "antigravity"));
        h.callbacks().onSpawn?.(h.spawn("c"));
        expect(h.configs[0]).toMatchObject({
          antigravity_tool_timeout_ms: 2000,
          antigravity_epoch_idle_ms: 3000,
        });
        expect(h.configs[1]).not.toHaveProperty("antigravity_tool_timeout_ms");
      } finally {
        runtime?.close();
        diagnostic.mockRestore();
      }
    }));

  it("log_phoenix_heartbeats is fixed at startup, and a set variable wins", () =>
    withRoot(async (root, configPath) => {
      const h = harness(root, configPath);
      const diagnostic = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      h.writeConfig({});
      const runtime = await runRunnerCli(h.dependencies, [configPath]);
      try {
        const logHeartbeats = h.callbacks().logHeartbeats!;
        expect(logHeartbeats()).toBe(false);
      } finally {
        runtime?.close();
        diagnostic.mockRestore();
      }
      vi.stubEnv("KAOIRO_RUNNER_LOG_PHOENIX_HEARTBEATS", "0");
      h.writeConfig({ log_phoenix_heartbeats: true });
      const withVariable = await runRunnerCli(h.dependencies, [configPath]);
      try {
        expect(h.callbacks().logHeartbeats!()).toBe(false);
      } finally {
        withVariable?.close();
      }
    }));

  it("KAOIRO_RUNNER_SERVER_URL takes precedence over the file and warns at startup", () =>
    withRoot(async (root, configPath) => {
      vi.stubEnv("KAOIRO_RUNNER_SERVER_URL", "wss://prod.example/runner");
      const h = harness(root, configPath);
      const lines: string[] = [];
      const diagnostic = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        lines.push(String(chunk));
        return true;
      });
      h.writeConfig({ server_url: "ws://fixture/runner" });
      const runtime = await runRunnerCli(h.dependencies, [configPath]);
      try {
        expect(h.connectedUrl()).toBe("wss://prod.example/runner");
        const deprecated = () =>
          lines.filter((l) => l.includes("KAOIRO_RUNNER_SERVER_URL is deprecated"));
        const shadowed = () =>
          lines.filter((l) => l.includes('"server_url" in runner.config.json is shadowed'));
        expect(deprecated()).toHaveLength(1);
        expect(shadowed()).toHaveLength(1);
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
