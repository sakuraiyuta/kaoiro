import "../../scripts/test/fixtures/test-isolation.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { WrapperConfig } from "@kaoiro/protocol";
import { runRunnerCli } from "../src/runner-cli.js";
import type { RunnerLinkOptions } from "../src/transport.js";
import type { ManagedChild } from "../src/supervisor.js";

it("relays the runner-local backend at startup and preserves running wrappers", async () => {
  const root = mkdtempSync(join(tmpdir(), "fuji-348-backend-wiring-")), configPath = join(root, "runner.config.json");
  const file = (backend?: string) => writeFileSync(configPath, JSON.stringify({ host_id: "fixture", server_url: "ws://fixture/runner",
    cwd_allowlist: [root], capabilities: ["codex"], codex: { auth_mode: "chatgpt", backend } }));
  const configs: WrapperConfig[] = [], children: Array<ManagedChild & { exit: () => void }> = [];
  const resumes: Array<string | undefined> = [];
  let callbacks!: RunnerLinkOptions;
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
      return { sendSpawnResult() {}, sendSessions() {}, sendResetResult() {}, sendStopAgent() {}, sendCatalogResult() {}, updateRegister() {}, close() {} };
    },
    installSignalHandlers: false,
  }, [configPath]);
  const spawn = (id: string, extra = {}) => ({ version: "0", agent_id: id, persona: { id: "p", name: "P", sprite_set: "p" }, cwd: root, engine: "codex", ...extra });
  try {
    callbacks.onSpawn?.(spawn("a", { backend: "exec", codex_backend: "exec", resume_snapshot: { backend: "exec" } }));
    expect(configs[0]?.codex_backend).toBe("app-server");
    file("exec");
    expect(children[0]?.kill).not.toHaveBeenCalled();expect(configs[0]?.codex_backend).toBe("app-server");
    callbacks.onSpawn?.(spawn("b", { backend: "app-server", codex_backend: "app-server" }));
    expect(configs[1]?.codex_backend).toBe("app-server");
    callbacks.onResetSession?.({ agent_id: "a", mode: "new", request_id: "reset", previous_session_id: "old" });
    children[0]!.exit();expect(configs[2]?.codex_backend).toBe("app-server");
    callbacks.onSpawn?.(spawn("claude", { engine: "claude-code", codex_backend: "app-server" }));
    expect(configs[3]).not.toHaveProperty("codex_backend");
    expect(resumes).toEqual(Array(4).fill(undefined));
  } finally { runtime?.close();diagnostic.mockRestore();rmSync(root, { recursive: true, force: true }); }
});

it.each([["codex"], ["claude-code"]])("refuses exec through the runner CLI loader before creating a launcher (capabilities=%s)", async engine => {
  const root = mkdtempSync(join(tmpdir(), "runner-retired-exec-"));
  const path = join(root, "runner.json");
  writeFileSync(path, JSON.stringify({ host_id: "fixture", server_url: "ws://fixture/runner", cwd_allowlist: [root], capabilities: [engine], codex: { backend: "exec" } }));
  const makeLauncher = vi.fn(() => { throw new Error("launcher must not start"); });
  try {
    await expect(runRunnerCli({ makeLauncher, installSignalHandlers: false }, [path])).rejects.toThrow("exec is retired");
    expect(makeLauncher).not.toHaveBeenCalled();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
