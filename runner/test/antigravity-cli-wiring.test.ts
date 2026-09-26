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
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunnerLinkOptions } from "../src/transport.js";
import { runRunnerCli } from "../src/runner-cli.js";
import { loadRunnerConfig } from "../src/config.js";
import type { ManagedChild } from "../src/supervisor.js";
import type { RunnerRegister, WrapperConfig } from "@kaoiro/protocol";

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
  readonly initialRegister: RunnerRegister;
  readonly updatedRegisters: RunnerRegister[] = [];
  readonly reconnectedRegisters: RunnerRegister[] = [];

  constructor(options: RunnerLinkOptions) {
    this.#options = options;
    this.initialRegister = options.register;
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
  sendStopAgent(): void {}
  sendCatalogResult(): void {}
  updateRegister(register: RunnerRegister): void {
    this.updatedRegisters.push(register);
  }
  reconnect(_serverUrl: string, _hostId: string, register: RunnerRegister): void {
    this.reconnectedRegisters.push(register);
  }
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

async function wrapperConfigPath(
  agentId: string,
  searchRoot = tmpdir(),
  beforeCandidateRead?: (base: string) => void,
  readCandidate: (base: string) => string[] = (base) => readdirSync(base),
): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    for (const dir of readdirSync(searchRoot, { withFileTypes: true })) {
      if (!dir.isDirectory() || !dir.name.startsWith("kaoiro-runner-"))
        continue;
      const base = join(searchRoot, dir.name);
      let filename: string | undefined;
      try {
        beforeCandidateRead?.(base);
        filename = readCandidate(base).find(
          (name) => name.startsWith(`${agentId}-`) && name.endsWith(".json"),
        );
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          continue;
        }
        throw error;
      }
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

  it.each([
    {
      name: "normal output",
      initial: "agy-cli 1.0.0",
      reload: "agy-cli 1.0.1",
      pad: false,
      expectedInitial: "agy-cli 1.0.0",
      expectedReload: "agy-cli 1.0.1",
    },
    {
      name: "whitespace is trimmed",
      initial: "agy-cli 1.0.0",
      reload: "agy-cli 1.0.1",
      pad: true,
      expectedInitial: "agy-cli 1.0.0",
      expectedReload: "agy-cli 1.0.1",
    },
    {
      name: "empty output is omitted",
      initial: "",
      reload: "",
      pad: false,
      expectedInitial: undefined,
      expectedReload: undefined,
    },
    {
      name: "control characters are omitted",
      initial: "agy\nversion",
      reload: "agy\nversion",
      pad: false,
      expectedInitial: undefined,
      expectedReload: undefined,
    },
    {
      name: "256 UTF-8 bytes are accepted",
      initial: `${"界".repeat(85)}a`,
      reload: `${"界".repeat(85)}a`,
      pad: false,
      expectedInitial: `${"界".repeat(85)}a`,
      expectedReload: `${"界".repeat(85)}a`,
    },
    {
      name: "257 UTF-8 bytes are omitted",
      initial: `${"界".repeat(85)}ab`,
      reload: `${"界".repeat(85)}ab`,
      pad: false,
      expectedInitial: undefined,
      expectedReload: undefined,
    },
    {
      name: "probe failure is omitted",
      initial: "__FAIL__",
      reload: "__FAIL__",
      pad: false,
      expectedInitial: undefined,
      expectedReload: undefined,
    },
  ])("sends the $name version on initial register and reload", async (scenario) => {
    root = mkdtempSync(join(tmpdir(), "kaoiro-runner-agy-register-"));
    const executable = join(root, "agy");
    const versionFile = join(root, "version.txt");
    writeFileSync(versionFile, `${scenario.initial}\n`);
    writeFileSync(
      executable,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  value=$(cat "${versionFile}")\n  [ "$value" = "__FAIL__" ] && exit 7\n  ${scenario.pad ? "printf '   '" : ":"}\n  printf '%s' "$value"\n  ${scenario.pad ? "printf '   \\n'" : "printf '\\n'"}\nelse\n  printf 'fixture-model\\tFixture Model\\n'\nfi\n`,
    );
    chmodSync(executable, 0o755);
    const configPath = join(root, "runner.config.json");
    const makeConfig = (budget: number) => ({
      host_id: "runner-register-fixture",
      server_url: "ws://runner.invalid/runner",
      cwd_allowlist: [root],
      capabilities: ["antigravity"],
      context_work_budget_percent: budget,
      antigravity: { cli_path: executable },
    });
    writeFileSync(configPath, JSON.stringify(makeConfig(50)));

    let link: FakeRunnerLink | undefined;
    let triggerReload: (() => void) | undefined;
    const runtime = await runRunnerCli(
      {
        resolveCodexAuthMode: async () => "unknown",
        resolveAntigravityCatalog: async () => [],
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
      writeFileSync(versionFile, `${scenario.reload}\n`);
      writeFileSync(configPath, JSON.stringify(makeConfig(51)));
      triggerReload!();
      await runtime!.waitForReloads();

      expect(link!.updatedRegisters).toHaveLength(1);
      expect([
        link!.initialRegister.antigravity_cli_version,
        link!.updatedRegisters[0]!.antigravity_cli_version,
      ]).toEqual([scenario.expectedInitial, scenario.expectedReload]);
    } finally {
      runtime?.close();
    }
  });

  it("omits the version from initial and reloaded registers when Antigravity is disabled", async () => {
    root = mkdtempSync(join(tmpdir(), "kaoiro-runner-agy-disabled-register-"));
    const configPath = join(root, "runner.config.json");
    const makeConfig = (budget: number) => ({
      host_id: "runner-disabled-fixture",
      server_url: "ws://runner.invalid/runner",
      cwd_allowlist: [root],
      capabilities: ["claude-code"],
      context_work_budget_percent: budget,
    });
    writeFileSync(configPath, JSON.stringify(makeConfig(50)));

    let link: FakeRunnerLink | undefined;
    let triggerReload: (() => void) | undefined;
    const resolveAgyVersion = vi.fn(async () => "agy-cli 1.0.0");
    const runtime = await runRunnerCli(
      {
        resolveCodexAuthMode: async () => "unknown",
        resolveAgyVersion,
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
      expect(link!.initialRegister.antigravity_cli_version).toBeUndefined();
      writeFileSync(configPath, JSON.stringify(makeConfig(51)));
      triggerReload!();
      await runtime!.waitForReloads();
      expect(link!.updatedRegisters).toHaveLength(1);
      expect(link!.updatedRegisters[0]!.antigravity_cli_version).toBeUndefined();
      expect(resolveAgyVersion).not.toHaveBeenCalled();
    } finally {
      runtime?.close();
    }
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

  it("finds a wrapper config in a stable test-owned scan root", async () => {
    root = mkdtempSync(join(tmpdir(), "hiiro413-wrapper-scan-"));
    const agentId = "runner-fixture.antigravity-stable";
    const candidate = mkdtempSync(join(root, "kaoiro-runner-stable-"));
    const configPath = join(candidate, `${agentId}-0.json`);
    writeFileSync(configPath, "{}");

    await expect(wrapperConfigPath(agentId, root)).resolves.toBe(configPath);
  });

  it("skips a wrapper temp dir removed after listing it", async () => {
    root = mkdtempSync(join(tmpdir(), "hiiro413-wrapper-scan-"));
    const agentId = "runner-fixture.antigravity-race";
    const candidates = [
      mkdtempSync(join(root, "kaoiro-runner-first-")),
      mkdtempSync(join(root, "kaoiro-runner-second-")),
    ];
    const filename = `${agentId}-0.json`;
    for (const candidate of candidates) {
      writeFileSync(join(candidate, filename), "{}");
    }

    let removed: string | undefined;
    const configPath = await wrapperConfigPath(agentId, root, (candidate) => {
      if (removed !== undefined) return;
      removed = candidate;
      rmSync(candidate, { recursive: true });
    });

    const surviving = candidates.find((candidate) => candidate !== removed);
    expect(removed).toBeDefined();
    expect(configPath).toBe(join(surviving!, filename));
  });

  it("propagates non-ENOENT wrapper config read errors", async () => {
    root = mkdtempSync(join(tmpdir(), "hiiro413-wrapper-scan-"));
    mkdtempSync(join(root, "kaoiro-runner-error-"));
    const readError = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });

    await expect(
      wrapperConfigPath(
        "runner-fixture.antigravity-error",
        root,
        undefined,
        () => {
          throw readError;
        },
      ),
    ).rejects.toBe(readError);
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

  it("issue #387 Part 2(A): agy のバージョン変更を reload 時に stderr warning として出す", async () => {
    root = mkdtempSync(join(tmpdir(), "kaoiro-runner-agy-version-"));
    const executable = join(root, "agy");
    writeFileSync(executable, "#!/bin/sh\nprintf 'fixture-model\\tFixture Model\\n'\n");
    chmodSync(executable, 0o755);
    const configPath = join(root, "runner.config.json");
    const config = {
      host_id: "runner-version-fixture",
      server_url: "ws://runner.invalid/runner",
      cwd_allowlist: [root],
      capabilities: ["antigravity"],
      antigravity: { cli_path: executable },
    };
    writeFileSync(configPath, JSON.stringify(config));

    let triggerReload: (() => void) | undefined;
    let versionCall = 0;
    const stderrWrites: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stderrWrites.push(String(chunk));
        return true;
      });
    let runtime;
    try {
      runtime = await runRunnerCli(
        {
          resolveAgyVersion: () => {
            versionCall += 1;
            return Promise.resolve(versionCall === 1 ? "agy-cli 1.0.0" : "agy-cli 2.0.0");
          },
          createRunnerLink: (_serverUrl, _hostId, options) => new FakeRunnerLink(options),
          watchRunnerConfig: (path, onReload) => {
            triggerReload = () => onReload(loadRunnerConfig(path));
            return { close: () => {} };
          },
          installSignalHandlers: false,
        },
        [configPath],
      );
      // Register-time probe only reports the version -- no prior value to
      // diff against yet, so no "changed" warning.
      expect(stderrWrites.some((line) => line.includes("agy version agy-cli 1.0.0"))).toBe(true);
      expect(stderrWrites.some((line) => line.includes("warn — antigravity agy version changed"))).toBe(false);

      triggerReload!();
      await runtime!.waitForReloads();

      expect(
        stderrWrites.some((line) =>
          line.includes("warn — antigravity agy version changed agy-cli 1.0.0 -> agy-cli 2.0.0"),
        ),
      ).toBe(true);
    } finally {
      runtime?.close();
      stderrSpy.mockRestore();
    }
  });

  it("issue #387 Part 2(A) 否定対照: agy のバージョンが変わらなければ warning を出さない", async () => {
    root = mkdtempSync(join(tmpdir(), "kaoiro-runner-agy-version-stable-"));
    const executable = join(root, "agy");
    writeFileSync(executable, "#!/bin/sh\nprintf 'fixture-model\\tFixture Model\\n'\n");
    chmodSync(executable, 0o755);
    const configPath = join(root, "runner.config.json");
    const config = {
      host_id: "runner-version-stable",
      server_url: "ws://runner.invalid/runner",
      cwd_allowlist: [root],
      capabilities: ["antigravity"],
      antigravity: { cli_path: executable },
    };
    writeFileSync(configPath, JSON.stringify(config));

    let triggerReload: (() => void) | undefined;
    const stderrWrites: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stderrWrites.push(String(chunk));
        return true;
      });
    let runtime;
    try {
      runtime = await runRunnerCli(
        {
          resolveAgyVersion: () => Promise.resolve("agy-cli 1.0.0"),
          createRunnerLink: (_serverUrl, _hostId, options) => new FakeRunnerLink(options),
          watchRunnerConfig: (path, onReload) => {
            triggerReload = () => onReload(loadRunnerConfig(path));
            return { close: () => {} };
          },
          installSignalHandlers: false,
        },
        [configPath],
      );
      triggerReload!();
      await runtime!.waitForReloads();

      expect(stderrWrites.some((line) => line.includes("warn — antigravity agy version changed"))).toBe(false);
    } finally {
      runtime?.close();
      stderrSpy.mockRestore();
    }
  });
});
