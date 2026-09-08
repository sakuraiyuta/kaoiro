import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunnerLinkOptions } from "../src/transport.js";
import { runRunnerCli } from "../src/cli.js";
import { loadRunnerConfig } from "../src/config.js";
import type { ManagedChild } from "../src/supervisor.js";
import type { WrapperConfig } from "@kaoiro/protocol";

class FakeChild implements ManagedChild {
  readonly #exitListeners: Array<() => void> = [];
  kills = 0;

  on(_event: "exit", listener: () => void): void {
    this.#exitListeners.push(listener);
  }

  kill(): boolean {
    this.kills += 1;
    return true;
  }

  exit(): void {
    for (const listener of [...this.#exitListeners]) listener();
  }
}

class FakeRunnerLink {
  readonly #options: RunnerLinkOptions;

  constructor(options: RunnerLinkOptions) {
    this.#options = options;
  }

  spawn(payload: unknown): void {
    this.#options.onSpawn?.(payload);
  }

  reset(payload: unknown): void {
    this.#options.onResetSession?.(payload);
  }

  sendSpawnResult(): void {}
  sendSessions(): void {}
  sendResetResult(): void {}
  sendCatalogResult(): void {}
  updateRegister(): void {}
  reconnect(): void {}
  close(): void {}
}

function spawnPayload(agentId: string): Record<string, unknown> {
  return {
    version: "0",
    agent_id: agentId,
    persona: { id: "momo", name: "もも", sprite_set: "momo" },
    cwd: ".",
    engine: "antigravity",
  };
}

async function wrapperConfigPath(agentId: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    for (const dir of readdirSync(tmpdir(), { withFileTypes: true })) {
      if (!dir.isDirectory() || !dir.name.startsWith("kaoiro-runner-"))
        continue;
      const base = join(tmpdir(), dir.name);
      const filename = readdirSync(base).find(
        (name) => name.startsWith(`${agentId}-`) && name.endsWith(".json"),
      );
      if (filename !== undefined) return join(base, filename);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for wrapper config for ${agentId}`);
}

describe("runner CLI Antigravity config wiring", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) rmSync(root, { force: true, recursive: true });
    root = undefined;
  });

  it("relays a config-file executable to fresh, reload, and recreated wrapper snapshots", async () => {
    root = mkdtempSync(join(tmpdir(), "kaoiro-runner-agy-cli-"));
    const firstExecutable = join(root, "first agy");
    const secondExecutable = join(root, "second agy");
    for (const executable of [firstExecutable, secondExecutable]) {
      writeFileSync(
        executable,
        "#!/bin/sh\nprintf 'fixture-model\\tFixture Model\\n'\n",
      );
      chmodSync(executable, 0o755);
    }
    const configPath = join(root, "runner.config.json");
    const makeConfig = (cliPath: string) => ({
      host_id: "runner-fixture",
      server_url: "ws://runner.invalid/runner",
      cwd_allowlist: [root],
      capabilities: ["antigravity"],
      antigravity: { cli_path: cliPath, probe_timeout_ms: 45_000 },
    });
    writeFileSync(configPath, JSON.stringify(makeConfig(firstExecutable)));

    const children: FakeChild[] = [];
    const configs: WrapperConfig[] = [];
    let link: FakeRunnerLink | undefined;
    let triggerReload: (() => void) | undefined;
    const runtime = await runRunnerCli(
      {
        makeLauncher: () => (_agentId, config) => {
          configs.push(config);
          const child = new FakeChild();
          children.push(child);
          return child;
        },
        createRunnerLink: (_serverUrl, _hostId, options) => {
          link = new FakeRunnerLink(options);
          return link;
        },
        watchRunnerConfig: (path, onReload) => {
          triggerReload = () => {
            onReload(loadRunnerConfig(path));
          };
          return { close: () => {} };
        },
        installSignalHandlers: false,
      },
      [configPath],
    );
    expect(runtime).toBeDefined();
    expect(link).toBeDefined();

    link!.spawn({ ...spawnPayload("runner-fixture.antigravity-a"), cwd: root });
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      antigravity_cli_path: firstExecutable,
      antigravity_probe_timeout_ms: 45_000,
    });

    writeFileSync(configPath, JSON.stringify(makeConfig(secondExecutable)));
    triggerReload!();
    await runtime!.waitForReloads();
    expect(children[0]!.kills).toBe(0);
    expect(configs[0]!.antigravity_cli_path).toBe(firstExecutable);

    link!.spawn({ ...spawnPayload("runner-fixture.antigravity-b"), cwd: root });
    expect(configs[1]).toMatchObject({
      antigravity_cli_path: secondExecutable,
    });

    link!.reset({
      agent_id: "runner-fixture.antigravity-a",
      mode: "new",
      request_id: "reset-after-reload",
      previous_session_id: "old-session",
    });
    expect(children[0]!.kills).toBe(1);
    children[0]!.exit();
    expect(configs[2]).toMatchObject({
      antigravity_cli_path: secondExecutable,
    });

    triggerReload!();
    await runtime!.waitForReloads();
    link!.spawn({ ...spawnPayload("runner-fixture.antigravity-c"), cwd: root });
    expect(configs[3]).toMatchObject({
      antigravity_cli_path: secondExecutable,
    });
    runtime!.close();
  });

  it("writes the initial and reloaded config-file selections through the default launcher", async () => {
    root = mkdtempSync(join(tmpdir(), "kaoiro-runner-agy-default-"));
    const hostId = `runner-default-${root.split("-").at(-1)!}`;
    const firstExecutable = join(root, "first agy");
    const secondExecutable = join(root, "second agy");
    for (const executable of [firstExecutable, secondExecutable]) {
      writeFileSync(
        executable,
        "#!/bin/sh\nprintf 'fixture-model\\tFixture Model\\n'\n",
      );
      chmodSync(executable, 0o755);
    }
    const configPath = join(root, "runner.config.json");
    const makeConfig = (cliPath: string) => ({
      host_id: hostId,
      server_url: "ws://runner.invalid/runner",
      cwd_allowlist: [root],
      capabilities: ["antigravity"],
      antigravity: { cli_path: cliPath },
    });
    writeFileSync(configPath, JSON.stringify(makeConfig(firstExecutable)));
    let link: FakeRunnerLink | undefined;
    let triggerReload: (() => void) | undefined;
    const runtime = await runRunnerCli(
      {
        createRunnerLink: (_serverUrl, _hostId, options) => {
          link = new FakeRunnerLink(options);
          return link;
        },
        watchRunnerConfig: (path, onReload) => {
          triggerReload = () => onReload(loadRunnerConfig(path));
          return { close: () => {} };
        },
        installSignalHandlers: false,
      },
      [configPath],
    );
    try {
      const initialAgent = `${hostId}.antigravity-a`;
      link!.spawn({ ...spawnPayload(initialAgent), cwd: root });
      const initialConfig = JSON.parse(
        readFileSync(await wrapperConfigPath(initialAgent), "utf8"),
      ) as WrapperConfig;
      expect(initialConfig.antigravity_cli_path).toBe(firstExecutable);

      writeFileSync(configPath, JSON.stringify(makeConfig(secondExecutable)));
      triggerReload!();
      await runtime!.waitForReloads();
      expect(
        JSON.parse(
          readFileSync(await wrapperConfigPath(initialAgent), "utf8"),
        ) as WrapperConfig,
      ).toMatchObject({ antigravity_cli_path: firstExecutable });

      const freshAgent = `${hostId}.antigravity-b`;
      link!.spawn({ ...spawnPayload(freshAgent), cwd: root });
      const reloadedConfig = JSON.parse(
        readFileSync(await wrapperConfigPath(freshAgent), "utf8"),
      ) as WrapperConfig;
      expect(reloadedConfig.antigravity_cli_path).toBe(secondExecutable);
    } finally {
      runtime?.close();
    }
  });
});
