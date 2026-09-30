import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { SpawnResult, WrapperConfig } from "@kaoiro/protocol";
import { loadRunnerConfig } from "../src/config.js";
import { runRunnerCli } from "../src/runner-cli.js";
import type { RunnerLinkOptions } from "../src/transport.js";
import { writeFileSync } from "node:fs";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function bootRunner() {
  const root = mkdtempSync(join(tmpdir(), "kaoiro-codex-home-wiring-"));
  roots.push(root);
  const configPath = join(root, "runner.config.json");
  writeFileSync(configPath, JSON.stringify({ host_id: "fixture", server_url: "ws://fixture/runner",
    cwd_allowlist: [root], capabilities: ["codex"], codex: { auth_mode: "chatgpt" } }));
  const configs: WrapperConfig[] = [], results: SpawnResult[] = [];
  let callbacks!: RunnerLinkOptions;
  const stderr = vi.spyOn(process.stderr, "write");
  const runtime = await runRunnerCli({
    makeLauncher: () => (_agent, config) => {
      configs.push(config);
      return { on: () => {}, kill: () => true };
    },
    createRunnerLink: (_url, _id, options) => {
      callbacks = options;
      return { sendSpawnResult: (result: SpawnResult) => { results.push(result); }, sendSessions() {}, sendResetResult() {},
        sendStopAgent() {}, sendCatalogResult() {}, updateRegister() {}, reconnect() {}, close() {} };
    },
    watchRunnerConfig: (path) => { void loadRunnerConfig(path); return { close() {} }; },
    installSignalHandlers: false,
  }, [configPath]);
  const spawn = (id: string, engine: string) => ({ version: "0", agent_id: id, persona: { id: "p", name: "P", sprite_set: "p" }, cwd: root, engine });
  const lines = () => stderr.mock.calls.map(([text]) => String(text)).filter((text) => text.startsWith("runner: "));
  return { runtime, callbacks: () => callbacks, configs, results, spawn, lines, stop: () => { runtime?.close(); stderr.mockRestore(); } };
}

it("reports the default Codex home and launches Codex when CODEX_HOME is unset", async () => {
  vi.stubEnv("CODEX_HOME", undefined);
  const r = await bootRunner();
  try {
    expect(r.lines()).toContain(`runner: codex home=${join(homedir(), ".codex")}\n`);
    r.callbacks().onSpawn?.(r.spawn("codex-a", "codex"));
    expect(r.configs).toHaveLength(1);
  } finally { r.stop(); }
});

it("reports a valid CODEX_HOME and launches Codex against it", async () => {
  const home = mkdtempSync(join(tmpdir(), "kaoiro-codex-home-wiring-home-"));
  roots.push(home);
  vi.stubEnv("CODEX_HOME", home);
  const r = await bootRunner();
  try {
    expect(r.lines()).toContain(`runner: codex home=${home}\n`);
    expect(r.lines().some((line) => line.startsWith("runner: error"))).toBe(false);
    r.callbacks().onSpawn?.(r.spawn("codex-a", "codex"));
    expect(r.configs).toHaveLength(1);
  } finally { r.stop(); }
});

it("reports an invalid CODEX_HOME once and refuses Codex while other engines still launch", async () => {
  vi.stubEnv("CODEX_HOME", "relative/codex-home");
  const r = await bootRunner();
  try {
    expect(r.lines().filter((line) => line.startsWith("runner: error"))).toEqual([
      "runner: error — CODEX_HOME=relative/codex-home is not an absolute path; Codex launches are refused until it is fixed\n",
    ]);
    r.callbacks().onSpawn?.(r.spawn("codex-a", "codex"));
    expect(r.configs).toHaveLength(0);
    expect(r.results.at(-1)).toMatchObject({ ok: false, reason: "error" });
    r.callbacks().onSpawn?.(r.spawn("claude-a", "claude-code"));
    expect(r.configs).toHaveLength(1);
  } finally { r.stop(); }
});
