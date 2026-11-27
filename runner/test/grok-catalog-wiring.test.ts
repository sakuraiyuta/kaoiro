import "../../scripts/test/fixtures/test-isolation.mjs";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineModelInfo, RunnerRegister } from "@kaoiro/protocol";
import type { RunnerLinkOptions } from "../src/transport.js";
import { runRunnerCli } from "../src/runner-cli.js";

// The register-time Grok catalog in the runner (issue #646): published when
// the probe answers, kept across a Claude refresh,
// and aborted by shutdown with its process group.

const FAKE = fileURLToPath(new URL("./fixtures/fake-grok-acp.mjs", import.meta.url));
const EXIT_DRIVER = fileURLToPath(new URL("./fixtures/grok-catalog-exit.ts", import.meta.url));
const SHUTDOWN_DRIVER = fileURLToPath(new URL("./fixtures/grok-catalog-shutdown.ts", import.meta.url));
const RUNNER = fileURLToPath(new URL("..", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

class FakeRunnerLink {
  readonly initialRegister: RunnerRegister;
  readonly updatedRegisters: RunnerRegister[] = [];
  constructor(readonly options: RunnerLinkOptions) {
    this.initialRegister = options.register;
  }
  sendSpawnResult(): void {}
  sendSessions(): void {}
  sendResetResult(): void {}
  sendStopAgent(): void {}
  sendCatalogResult(): void {}
  updateRegister(register: RunnerRegister): void {
    this.updatedRegisters.push(register);
  }
  reconnect(): void {}
  close(): void {}
}

const modelState = {
  modelState: { currentModelId: "grok-4.7", availableModels: [
    { modelId: "grok-4.7", name: "Grok 4.7", _meta: { reasoningEfforts: [{ value: "high", default: true }] } },
  ] },
};
const grokModels = (register: RunnerRegister): string[] =>
  register.engines?.find((engine) => engine.id === "grok")?.models.map((m: EngineModelInfo) => m.value) ?? [];

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

async function start(
  scenario: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  configFields: Record<string, unknown> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "kaoiro-grok-catalog-wiring-"));
  dirs.push(root);
  const scenarioPath = join(root, "scenario.json");
  const pids = join(root, "pids");
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const configPath = join(root, "runner.config.json");
  const config = (budget: number) => ({ host_id: "grok-catalog-fixture", server_url: "ws://runner.invalid/runner",
    cwd_allowlist: [root], capabilities: ["claude-code", "grok"], context_work_budget_percent: budget, ...configFields });
  writeFileSync(configPath, JSON.stringify(config(50)));
  let link: FakeRunnerLink | undefined;
  const runtime = await runRunnerCli({
    resolveCodexAuthMode: async () => "unknown",
    createRunnerLink: (_url, _host, options) => (link = new FakeRunnerLink(options)),
    grokCatalogProbe: { cwd: root, executable: FAKE,
      env: { ...process.env, FAKE_GROK_SCENARIO: scenarioPath, FAKE_GROK_PIDS: pids } },
    installSignalHandlers: false,
    ...extra,
  }, [configPath]);
  return {
    runtime: runtime!, link: link!, scenarioPath, pids,
    leader: async () => {
      await vi.waitFor(() => expect(existsSync(pids)).toBe(true));
      return Number(readFileSync(pids, "utf8").split(" ")[0]);
    },
  };
}

describe("grok catalog in the runner register", () => {
  it("registers the default entry first, then publishes the probed catalog", async () => {
    const h = await start({ initMeta: modelState });
    try {
      expect(grokModels(h.link.initialRegister)).toEqual(["default"]);
      await vi.waitFor(() => expect(h.link.updatedRegisters.map(grokModels)).toContainEqual(["default", "grok-4.7"]));
    } finally {
      h.runtime.close();
    }
  }, 10_000);

  it("keeps the probed catalog when a Claude refresh rebuilds the register", async () => {
    const row = { id: "sample", models: [], operations: { version: 1, spawn: true } };
    const output = JSON.stringify({ version: 1, ...row });
    const command = [process.execPath, "-e", "process.stdout.write(process.argv[1])", output];
    const h = await start({ initMeta: modelState }, {
      catalogProbe: async () => ({ ok: true, models: [{ value: "claude-x", display_name: "X" }], elapsed_ms: 1, source: "init" }),
    }, {
      capabilities: ["claude-code", "grok", row.id], external_engines: [{ id: row.id, command }],
    });
    try {
      await vi.waitFor(() => expect(h.link.updatedRegisters).toHaveLength(1));
      h.link.options.onRefreshEngineCatalog!({ version: "0", engine: "claude-code", request_id: "r1" });
      await vi.waitFor(() => expect(h.link.updatedRegisters).toHaveLength(2));
      expect(grokModels(h.link.updatedRegisters[1]!)).toEqual(["default", "grok-4.7"]);
      for (const register of [h.link.initialRegister, ...h.link.updatedRegisters]) {
        expect(register.capabilities).toContain(row.id);
        expect(register.engines?.find(engine => engine.id === row.id)).toEqual(row);
      }
    } finally {
      h.runtime.close();
    }
  }, 10_000);

  it("publishes nothing from a probe that shutdown aborts, and ends its group", async () => {
    const h = await start({ initHang: true, spawnChild: true });
    const leader = await h.leader();
    try {
      h.runtime.close();
      await vi.waitFor(() => expect(groupAlive(leader)).toBe(false), { timeout: 3_000 });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(h.link.updatedRegisters.map(grokModels).filter((models) => models.length > 1)).toEqual([]);
    } finally {
      if (groupAlive(leader)) process.kill(-leader, "SIGKILL");
    }
  }, 10_000);

  it("signals the group before a shutdown exits the process", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-grok-catalog-exit-"));
    dirs.push(root);
    const scenarioPath = join(root, "scenario.json");
    const pids = join(root, "pids");
    writeFileSync(scenarioPath, JSON.stringify({ initHang: true, spawnChild: true }));
    const driver = spawn(process.execPath, ["--import", "tsx", EXIT_DRIVER], {
      cwd: RUNNER, stdio: "ignore",
      env: { ...process.env, FAKE_EXECUTABLE: FAKE, FAKE_GROK_SCENARIO: scenarioPath, FAKE_GROK_PIDS: pids },
    });
    await new Promise((resolve) => driver.once("exit", resolve));
    const [leader, child] = readFileSync(pids, "utf8").split(" ").map(Number);
    try {
      expect(child).toBeGreaterThan(1);
      await vi.waitFor(() => expect(groupAlive(leader!)).toBe(false), { timeout: 2_000 });
    } finally {
      if (leader! > 1 && groupAlive(leader!)) process.kill(-leader!, "SIGKILL");
    }
  }, 15_000);

  it.each([
    ["a child that exits on SIGTERM", { spawnChild: true }],
    ["a child that ignores SIGTERM", { stubbornChild: true }],
  ])("ends the probe group before the runner's own SIGTERM handler exits, with %s", async (_label, child) => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-grok-catalog-shutdown-"));
    dirs.push(root);
    const scenarioPath = join(root, "scenario.json");
    const pids = join(root, "pids");
    const configPath = join(root, "runner.config.json");
    writeFileSync(scenarioPath, JSON.stringify({ initHang: true, ...child }));
    writeFileSync(configPath, JSON.stringify({ host_id: "grok-catalog-shutdown", server_url: "ws://runner.invalid/runner",
      cwd_allowlist: [root], capabilities: ["grok"] }));
    const driver = spawn(process.execPath, ["--import", "tsx", SHUTDOWN_DRIVER], {
      cwd: RUNNER, stdio: "ignore",
      env: { ...process.env, OWN_CONFIG: configPath, FAKE_EXECUTABLE: FAKE, FAKE_GROK_SCENARIO: scenarioPath,
        FAKE_GROK_PIDS: pids },
    });
    let leader = 0;
    try {
      const code = await new Promise<number | null>((resolve) => driver.once("exit", resolve));
      expect(code).toBe(0);
      leader = Number(readFileSync(pids, "utf8").split(" ")[0]);
      expect(leader).toBeGreaterThan(1);
      expect(groupAlive(leader)).toBe(false);
    } finally {
      if (!leader && existsSync(pids)) leader = Number(readFileSync(pids, "utf8").split(" ")[0]);
      if (leader > 1 && groupAlive(leader)) process.kill(-leader, "SIGKILL");
      if (driver.exitCode === null && driver.signalCode === null) driver.kill("SIGKILL");
    }
  }, 15_000);
});
