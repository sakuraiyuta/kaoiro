import "../../scripts/test/fixtures/test-isolation.mjs";
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
import * as runnerConfig from "../src/config.js";
import { runRunnerCli } from "../src/runner-cli.js";
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

  sendSpawnResult = vi.fn();
  sendSessions(): void {}
  sendResetResult(): void {}
  sendStopAgent(): void {}
  sendCatalogResult(): void {}
  updateRegister(register: RunnerRegister): void {
    this.updatedRegisters.push(register);
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
      pad: false,
      expectedInitial: "agy-cli 1.0.0",
    },
    {
      name: "whitespace is trimmed",
      initial: "agy-cli 1.0.0",
      pad: true,
      expectedInitial: "agy-cli 1.0.0",
    },
    {
      name: "empty output is omitted",
      initial: "",
      pad: false,
      expectedInitial: undefined,
    },
    {
      name: "control characters are omitted",
      initial: "agy\nversion",
      pad: false,
      expectedInitial: undefined,
    },
    {
      name: "256 UTF-8 bytes are accepted",
      initial: `${"界".repeat(85)}a`,
      pad: false,
      expectedInitial: `${"界".repeat(85)}a`,
    },
    {
      name: "257 UTF-8 bytes are omitted",
      initial: `${"界".repeat(85)}ab`,
      pad: false,
      expectedInitial: undefined,
    },
    {
      name: "probe failure is omitted",
      initial: "__FAIL__",
      pad: false,
      expectedInitial: undefined,
    },
  ])("sends the $name version on initial register", async (scenario) => {
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
    const runtime = await runRunnerCli(
      {
        resolveCodexAuthMode: async () => "unknown",
        resolveAntigravityCatalog: async () => [],
        createRunnerLink: (_serverUrl, _hostId, options) => {
          link = new FakeRunnerLink(options);
          return link;
        },
        installSignalHandlers: false,
      },
      [configPath],
    );
    try {
      expect(link!.initialRegister.antigravity_cli_version).toBe(scenario.expectedInitial);
    } finally {
      runtime?.close();
    }
  });

  it("omits the version from the initial register when Antigravity is disabled", async () => {
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
    const resolveAgyVersion = vi.fn(async () => "agy-cli 1.0.0");
    const runtime = await runRunnerCli(
      {
        resolveCodexAuthMode: async () => "unknown",
        resolveAgyVersion,
        createRunnerLink: (_serverUrl, _hostId, options) => {
          link = new FakeRunnerLink(options);
          return link;
        },
        installSignalHandlers: false,
      },
      [configPath],
    );
    try {
      expect(link!.initialRegister.antigravity_cli_version).toBeUndefined();
      expect(resolveAgyVersion).not.toHaveBeenCalled();
    } finally {
      runtime?.close();
    }
  });

  it("relays a config-file executable to fresh and recreated wrapper snapshots", async () => {
    root = mkdtempSync(join(tmpdir(), "kaoiro-runner-agy-cli-"));
    const firstExecutable = join(root, "first agy");
    writeFileSync(
      firstExecutable,
      "#!/bin/sh\nprintf 'fixture-model\\tFixture Model\\n'\n",
    );
    chmodSync(firstExecutable, 0o755);
    const configPath = join(root, "runner.config.json");
    const makeConfig = (cliPath: string) => ({
      host_id: "runner-fixture",
      server_url: "ws://runner.invalid/runner",
      cwd_allowlist: [root],
      capabilities: ["antigravity"],
      antigravity: { auth: "google-cloud-sign-in", cli_path: cliPath, probe_timeout_ms: 45_000, max_sandbox: "read-only" },
    });
    writeFileSync(configPath, JSON.stringify(makeConfig(firstExecutable)));

    const children: FakeChild[] = [];
    const configs: WrapperConfig[] = [];
    let link: FakeRunnerLink | undefined;
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
        installSignalHandlers: false,
      },
      [configPath],
    );
    expect(runtime).toBeDefined();
    expect(link).toBeDefined();

    link!.spawn({ ...spawnPayload("denied"), cwd: root, sandbox: "workspace-write" });
    expect(link!.sendSpawnResult).toHaveBeenLastCalledWith(expect.objectContaining({
      ok: false, reason: "permission_ceiling_conflict",
    }));
    expect(children).toHaveLength(0);
    link!.spawn({ ...spawnPayload("runner-fixture.antigravity-a"), cwd: root, sandbox: "read-only" });
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      max_sandbox: "read-only",
      antigravity_cli_path: firstExecutable,
      antigravity_probe_timeout_ms: 45_000,
    });

    link!.spawn({ ...spawnPayload("runner-fixture.antigravity-b"), cwd: root, sandbox: "read-only" });
    expect(configs[1]).toMatchObject({
      antigravity_cli_path: firstExecutable,
    });

    link!.reset({
      agent_id: "runner-fixture.antigravity-a",
      mode: "new",
      request_id: "reset-at-startup",
      previous_session_id: "old-session",
    });
    expect(children[0]!.kills).toBe(1);
    children[0]!.exit();
    expect(configs[2]).toMatchObject({
      antigravity_cli_path: firstExecutable,
    });

    runtime!.close();
  });

  it("keeps the startup register and child model declarations through saves, then loads them on restart", async () => {
    root = mkdtempSync(join(tmpdir(), "runner-startup-models-"));
    const path = join(root, "runner.json");
    const extras = (engine: string, generation: string) => [
      { value: engine + "-" + generation, display_name: generation },
    ];
    const write = (generation: string) => writeFileSync(path, JSON.stringify({
      host_id: "fixture", server_url: "ws://runner.invalid/runner", cwd_allowlist: [root],
      capabilities: ["codex", "antigravity"], codex: {
        auth_mode: "apikey", extra_models: extras("codex", generation),
      },
      antigravity: { auth: "google-cloud-sign-in", extra_models: extras("antigravity", generation) },
    }));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const loadConfig = vi.spyOn(runnerConfig, "loadRunnerConfig");
    let link!: FakeRunnerLink;
    const launch = vi.fn((_id: string, _config: WrapperConfig) => new FakeChild());
    const start = (probe: () => Promise<never[]>) => runRunnerCli({
      resolveAgyExecutable: () => ({ ok: true, path: process.execPath }),
      resolveAntigravityCatalog: probe, resolveAgyVersion: async () => null,
      createRunnerLink: (_url, _host, options) => (link = new FakeRunnerLink(options)),
      makeLauncher: () => launch, installSignalHandlers: false,
    }, [path]);
    const checkSnapshot = (generation: string) => {
      for (const engine of ["codex", "antigravity"] as const) {
        const row = link.initialRegister.engines!.find(item => item.id === engine)!;
        expect(row.models).toContainEqual(extras(engine, generation)[0]);
        link.spawn({ ...spawnPayload(engine + "-" + generation), cwd: root, engine });
        expect(launch.mock.lastCall?.[1][`${engine}_extra_models`]).toEqual(extras(engine, generation));
      }
    };
    let runtime;
    try {
      write("first");
      runtime = await start(async () => {
        await Promise.resolve();
        write("while-starting");
        return [];
      });
      const notices = () => stderr.mock.calls.map(([line]) => String(line))
        .filter(line => line.includes("Runner config saves take effect"));
      expect(notices()).toHaveLength(2);
      write("next-start");
      await vi.waitFor(() => expect(notices()).toHaveLength(3));
      expect(notices().join("")).not.toContain("next-start");
      expect(loadConfig).toHaveBeenCalledTimes(1);
      expect(link.updatedRegisters).toEqual([]);
      checkSnapshot("first");
      runtime?.close();
      runtime = await start(async () => []);
      expect(loadConfig).toHaveBeenCalledTimes(2);
      checkSnapshot("next-start");
    } finally {
      runtime?.close();
      loadConfig.mockRestore();
      stderr.mockRestore();
    }
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

  it("writes the startup config-file selection through the default launcher", async () => {
    root = mkdtempSync(join(tmpdir(), "kaoiro-runner-agy-default-"));
    const hostId = `runner-default-${root.split("-").at(-1)!}`;
    const firstExecutable = join(root, "first agy");
    writeFileSync(
      firstExecutable,
      "#!/bin/sh\nprintf 'fixture-model\\tFixture Model\\n'\n",
    );
    chmodSync(firstExecutable, 0o755);
    const configPath = join(root, "runner.config.json");
    const makeConfig = (cliPath: string) => ({
      host_id: hostId,
      server_url: "ws://runner.invalid/runner",
      cwd_allowlist: [root],
      capabilities: ["antigravity"],
      antigravity: { auth: "google-cloud-sign-in", cli_path: cliPath },
    });
    writeFileSync(configPath, JSON.stringify(makeConfig(firstExecutable)));
    let link: FakeRunnerLink | undefined;
    const runtime = await runRunnerCli(
      {
        createRunnerLink: (_serverUrl, _hostId, options) => {
          link = new FakeRunnerLink(options);
          return link;
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
    } finally {
      runtime?.close();
    }
  });

  it.each([
    [undefined, "engine_auth_unsupported"],
    ["misspelled", "engine_auth_invalid"],
    [null, "engine_auth_invalid"],
    [73, "engine_auth_invalid"],
  ])("isolates declaration %j at startup", async (invalid, reason) => {
    root = mkdtempSync(join(tmpdir(), "runner-auth-"));
    const executable = join(root, "agy");
    const calls = join(root, "calls");
    writeFileSync(calls, "");
    writeFileSync(executable, `#!/bin/sh
echo "$1" >> "${calls}"
case "$1" in
  --version) echo fixture-version ;;
  models) printf 'fixture-model\\tFixture Model\\n' ;;
esac
`);
    chmodSync(executable, 0o700);
    vi.stubEnv("PATH", root);
    vi.stubEnv("AGY_ADC_AUTH", "true");
    const credentials = join(root, "credentials");
    writeFileSync(credentials, "fixture credentials");
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", credentials);
    const path = join(root, "runner.config.json");
    const save = (auth: unknown) => writeFileSync(path, JSON.stringify({
      host_id: "test", server_url: "ws://runner.invalid/runner", cwd_allowlist: [root],
      ...(auth === undefined ? {} : { antigravity: { auth } }),
    }));
    save(invalid);
    let link: FakeRunnerLink | undefined;
    const launch = vi.fn(() => new FakeChild());
    const runtime = await runRunnerCli({
      createRunnerLink: (_url, _host, options) => (link = new FakeRunnerLink(options)),
      makeLauncher: () => launch,
      installSignalHandlers: false,
    }, [path]);
    try {
      const spawn = (id: string) => link!.spawn({ ...spawnPayload(id), cwd: root });
      const probeCalls = () => readFileSync(calls, "utf8").trim().split("\n");
      const models = (reg: RunnerRegister) =>
        reg.engines!.find(e => e.id === "antigravity")!.models;
      spawn("test.first");
      expect(launch).not.toHaveBeenCalled();
      expect(link!.sendSpawnResult).toHaveBeenLastCalledWith(expect.objectContaining({ reason }));
      expect(probeCalls()).toEqual(["--version"]);
      const snapshot = models(link!.initialRegister);
      expect(snapshot.length).toBeGreaterThan(1);
      link!.spawn({ ...spawnPayload("test.other"), engine: "claude-code", cwd: root });
      expect(launch).toHaveBeenCalledTimes(1);
    } finally {
      runtime?.close();
      vi.unstubAllEnvs();
    }
  });

});
