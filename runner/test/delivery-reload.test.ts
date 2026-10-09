import { mkdtempSync, rmSync, writeFileSync, type watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunnerRegister, WrapperConfig } from "@kaoiro/protocol";
import { runRunnerCli, type RunnerCliDependencies } from "../src/runner-cli.js";
import { watchRunnerConfig } from "../src/config-watcher.js";
import type { RunnerLinkOptions } from "../src/transport.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function harness(extra: Record<string, unknown> = {}, dependencyOverrides: RunnerCliDependencies = {}) {
  for (const key of ["KAOIRO_CLAUDE_PHASE2_DELIVERY", "KAOIRO_CLAUDE_PHASE2_DELIVERY_PERSONAS", "KAOIRO_CODEX_OPERATOR_STEER", "KAOIRO_CODEX_OPERATOR_STEER_PERSONAS"]) vi.stubEnv(key, undefined);
  const dir = mkdtempSync(join(tmpdir(), "kogane562-reload-"));
  const configPath = join(dir, "runner.config.json");
  const base = { host_id: "delivery-reload", server_url: "ws://localhost/runner", cwd_allowlist: [dir],
    capabilities: ["claude-code", "codex", "antigravity"], codex: { auth_mode: "chatgpt", backend: "app-server" } };
  const write = (value: Record<string, unknown>) => writeFileSync(configPath, JSON.stringify({ ...base, ...value }));
  write(extra);
  const wrappers: WrapperConfig[] = []; const registers: RunnerRegister[] = [];
  let callbacks!: RunnerLinkOptions; let trigger!: () => void; let settled = () => {};
  const fsWatch = ((_dir: string, _opts: unknown, listener: (event: string, file: string) => void) => {
    trigger = () => listener("change", "runner.config.json"); return { close() {}, on() { return this; } };
  }) as unknown as typeof watch;
  const updates = vi.fn((value: RunnerRegister) => { registers.push(value); });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const runtime = await runRunnerCli({
    makeLauncher: () => (_id, config) => { wrappers.push(config); return { on() {}, kill() { return true; } }; },
    resolveAgyExecutable: () => ({ ok: false, reason: "executable_missing" }),
    resolveAntigravityCatalog: async () => [], resolveAgyVersion: async () => null,
    createRunnerLink: (_url, _host, options) => {
      callbacks = options; registers.push(options.register);
      return { sendSpawnResult() {}, sendSessions() {}, sendResetResult() {}, sendStopAgent() {}, sendCatalogResult() {},
        updateRegister: updates, reconnect: (_url, _host, register) => updates(register), close() {} };
    },
    watchRunnerConfig: (path, onReload, onError) => watchRunnerConfig(path,
      next => { onReload(next); settled(); }, error => { onError(error); settled(); }, { watch: fsWatch }),
    installSignalHandlers: false, ...dependencyOverrides,
  }, [configPath]);
  let count = 0;
  return { wrappers, registers, updates, callbacks: () => callbacks,
    spawn(engine = "claude-code") {
      callbacks.onSpawn?.({ version: "0", agent_id: `agent-${count++}`, engine, cwd: dir,
        persona: { id: "P", name: "P", sprite_set: "P" } });
      return wrappers.at(-1)!;
    },
    async reload(value: Record<string, unknown>) {
      const done = new Promise<void>(resolve => { settled = resolve; }); write(value); trigger();
      await done; await runtime!.waitForReloads();
    },
    close() { runtime?.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
const mode = (register: RunnerRegister, engine: string) => register.engines!.find(e => e.id === engine)!.launch_delivery_policy!;

describe("applied delivery snapshot publication", () => {
  it("startup and successful reload publish ceilings, defaults, backend and both relayed flags together", async () => {
    const h = await harness({ claude_code: { phase2_delivery: false } });
    try {
      const original = h.spawn(); expect(original.in_flight_delivery_enabled).toBe(true);
      expect(mode(h.registers[0]!, "claude-code").mechanisms.inter_agent_early).toBe("none");
      const next = { claude_code: { phase2_delivery: true }, codex: { auth_mode: "chatgpt", backend: "app-server", operator_steer: true },
        in_flight_delivery: { "claude-code": { default: false }, codex: { default: false } } };
      await h.reload(next);
      expect(original.phase2_delivery).toBeUndefined();
      expect(h.spawn().phase2_delivery).toBe(true); expect(h.spawn("codex").operator_steer).toBe(true);
      expect(mode(h.registers.at(-1)!, "claude-code").mechanisms.inter_agent_early).toBe("fold");
      expect(mode(h.registers.at(-1)!, "codex").mechanisms.operator_early).toBe("steer");
      expect(h.registers.at(-1)!.in_flight_defaults).toEqual({ "claude-code": false, codex: false, antigravity: false });
      await h.reload({ ...next, in_flight_delivery: { "claude-code": { enabled: false }, codex: { enabled: false } } });
      expect(h.spawn().in_flight_delivery_enabled).toBe(false); expect(h.spawn("codex").in_flight_delivery_enabled).toBe(false);
      expect(mode(h.registers.at(-1)!, "codex").mechanisms).toEqual({ operator_early: "none", inter_agent_early: "none", inter_agent_yield: "none" });
      expect(original.in_flight_delivery_enabled).toBe(true);
    } finally { h.close(); }
  });
  it("invalid reloads preserve the previous register and the next wrapper's ceiling", async () => {
    const h = await harness({ in_flight_delivery: { "claude-code": { enabled: false, default: false } } });
    try {
      const original = h.registers[0];
      for (const block of [null, [], false, { claude_code: {} }, { codex: null }, { codex: [] }, { codex: 0 }, { codex: { enabeld: true } }, { codex: { enabled: "false" } }]) {
        await h.reload({ in_flight_delivery: block });
        expect(h.registers).toEqual([original]); expect(h.spawn().in_flight_delivery_enabled).toBe(false);
      }
    } finally { h.close(); }
  });
  it("late probe failure and publication failure preserve prior relay, backend and register", async () => {
    const version = vi.fn(async () => "1.0.0");
    const h = await harness({ claude_code: { phase2_delivery: true } }, { resolveAgyVersion: version });
    try {
      const initial = h.registers[0]!;
      version.mockRejectedValueOnce(new Error("late probe failure"));
      const next = { claude_code: { phase2_delivery: false }, codex: { auth_mode: "chatgpt", backend: "exec" },
        in_flight_delivery: { "claude-code": { enabled: false } } };
      await h.reload(next);
      expect(h.registers).toEqual([initial]); expect(h.spawn().phase2_delivery).toBe(true);
      expect(h.spawn("codex").codex_backend).toBe("app-server");
      h.updates.mockImplementationOnce(() => { throw new Error("publication failure"); });
      await h.reload(next);
      expect(h.registers.at(-1)).toEqual(initial); expect(h.spawn().in_flight_delivery_enabled).toBe(true);
      expect(h.spawn().phase2_delivery).toBe(true);
    } finally { h.close(); }
  });
  it("catalog refresh awaiting a probe reads the snapshot applied by a concurrent reload", async () => {
    const probe = deferred<{ ok: true; models: { value: string; display_name: string }[]; elapsed_ms: number; source: "init" }>();
    const h = await harness({}, { catalogProbe: () => probe.promise });
    try {
      h.callbacks().onRefreshEngineCatalog?.({ engine: "claude-code", request_id: "refresh", force: true });
      await h.reload({ claude_code: { phase2_delivery: true }, in_flight_delivery: { codex: { enabled: false, default: false } } });
      vi.stubEnv("KAOIRO_CLAUDE_PHASE2_DELIVERY", "0");
      probe.resolve({ ok: true, models: [{ value: "fresh", display_name: "Fresh" }], elapsed_ms: 1, source: "init" });
      await vi.waitFor(() => expect(h.registers).toHaveLength(3));
      const register = h.registers.at(-1)!;
      expect(register.engines![0]!.models[0]!.value).toBe("fresh");
      expect(mode(register, "codex").ceiling).toBe(false); expect(register.in_flight_defaults?.codex).toBe(false);
      expect(mode(register, "claude-code").mechanisms.inter_agent_early).toBe("fold");
      expect(h.spawn().phase2_delivery).toBe(true);
    } finally { h.close(); }
  });
});
