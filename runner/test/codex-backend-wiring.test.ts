import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { WrapperConfig } from "@kaoiro/protocol";
import { loadRunnerConfig } from "../src/config.js";
import { runRunnerCli } from "../src/runner-cli.js";
import type { RunnerLinkOptions } from "../src/transport.js";
import type { ManagedChild } from "../src/supervisor.js";

it("relays the runner-local backend at bootstrap/reload and preserves running wrappers", async () => {
  const root = mkdtempSync(join(tmpdir(), "fuji-348-backend-wiring-")), configPath = join(root, "runner.config.json");
  const file = (backend?: string) => writeFileSync(configPath, JSON.stringify({ host_id: "fixture", server_url: "ws://fixture/runner",
    cwd_allowlist: [root], capabilities: ["codex"], codex: { auth_mode: "chatgpt", backend } }));
  const configs: WrapperConfig[] = [], children: Array<ManagedChild & { exit: () => void }> = [];
  const resumes: Array<string | undefined> = [];
  let callbacks!: RunnerLinkOptions, reload!: () => void;
  const diagnostic = vi.spyOn(process.stderr, "write");
  file("app-server");
  const runtime = await runRunnerCli({
    makeLauncher: () => (_agent, config, _cwd, resume) => {
      configs.push(config);resumes.push(resume);const listeners: Array<() => void> = [];
      const child = { on: (_event: "exit", cb: () => void) => { listeners.push(cb); }, kill: vi.fn(() => true), exit: () => { for (const cb of [...listeners]) cb(); } };
      children.push(child);return child;
    },
    createRunnerLink: (_url, _id, options) => {
      callbacks = options;
      return { sendSpawnResult() {}, sendSessions() {}, sendResetResult() {}, sendStopAgent() {}, sendCatalogResult() {}, updateRegister() {}, reconnect() {}, close() {} };
    },
    watchRunnerConfig: (path, onReload) => { reload = () => onReload(loadRunnerConfig(path));return { close() {} }; },
    installSignalHandlers: false,
  }, [configPath]);
  const spawn = (id: string, extra = {}) => ({ version: "0", agent_id: id, persona: { id: "p", name: "P", sprite_set: "p" }, cwd: root, engine: "codex", ...extra });
  try {
    callbacks.onSpawn?.(spawn("a", { backend: "exec", codex_backend: "exec", resume_snapshot: { backend: "exec" } }));
    expect(configs[0]?.codex_backend).toBe("app-server");
    file("exec");reload();await runtime!.waitForReloads();
    expect(children[0]?.kill).not.toHaveBeenCalled();expect(configs[0]?.codex_backend).toBe("app-server");
    expect(diagnostic.mock.calls.some(([s]) => String(s).includes("codex backend=exec for subsequent wrappers"))).toBe(true);
    callbacks.onSpawn?.(spawn("b", { backend: "app-server", codex_backend: "app-server" }));
    expect(configs[1]?.codex_backend).toBe("exec");
    callbacks.onResetSession?.({ agent_id: "a", mode: "new", request_id: "reset", previous_session_id: "old" });
    children[0]!.exit();expect(configs[2]?.codex_backend).toBe("exec");
    file("app-server");reload();await runtime!.waitForReloads();
    children[1]!.exit();expect(configs[3]?.codex_backend).toBe("app-server");
    file();reload();await runtime!.waitForReloads();
    callbacks.onSpawn?.(spawn("c"));expect(configs[4]?.codex_backend).toBe("exec");
    callbacks.onSpawn?.(spawn("claude", { engine: "claude-code", codex_backend: "app-server" }));
    expect(configs[5]).not.toHaveProperty("codex_backend");
    expect(resumes).toEqual(Array(6).fill(undefined));
  } finally { runtime?.close();diagnostic.mockRestore();rmSync(root, { recursive: true, force: true }); }
});
