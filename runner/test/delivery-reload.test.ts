import "../../scripts/test/fixtures/test-isolation.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunnerRegister, WrapperConfig } from "@kaoiro/protocol";
import { runRunnerCli } from "../src/runner-cli.js";
import type { RunnerLinkOptions } from "../src/transport.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function harness(extra: Record<string, unknown> = {}, environment: Record<string, string> = {}) {
  for (const key of ["KAOIRO_CLAUDE_PHASE2_DELIVERY", "KAOIRO_CLAUDE_PHASE2_DELIVERY_PERSONAS", "KAOIRO_CODEX_OPERATOR_STEER", "KAOIRO_CODEX_OPERATOR_STEER_PERSONAS"]) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
  const dir = mkdtempSync(join(tmpdir(), "runner-delivery-start-"));
  const configPath = join(dir, "runner.config.json");
  const base = { host_id: "delivery-start", server_url: "ws://localhost/runner", cwd_allowlist: [dir],
    capabilities: ["claude-code", "codex", "antigravity"], codex: { auth_mode: "chatgpt", backend: "app-server" } };
  const write = (value: Record<string, unknown>) => writeFileSync(configPath, JSON.stringify({ ...base, ...value }));
  write(extra);
  const wrappers: WrapperConfig[] = [];
  const registers: RunnerRegister[] = [];
  let callbacks!: RunnerLinkOptions;
  const stderr: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { stderr.push(String(chunk)); return true; });
  const runtime = await runRunnerCli({
    makeLauncher: () => (_id, config) => { wrappers.push(config); return { on() {}, kill() { return true; } }; },
    resolveAgyExecutable: () => ({ ok: false, reason: "executable_missing" }),
    resolveAntigravityCatalog: async () => [], resolveAgyVersion: async () => null,
    createRunnerLink: (_url, _host, options) => {
      callbacks = options;
      registers.push(options.register);
      return {
        sendSpawnResult() {}, sendSessions() {}, sendResetResult() {}, sendStopAgent() {},
        sendCatalogResult() {}, updateRegister(value) { registers.push(value); }, close() {},
      };
    },
    installSignalHandlers: false,
  }, [configPath]);
  let count = 0;
  return { registers, stderr,
    spawn(engine = "claude-code") {
      callbacks.onSpawn?.({ version: "0", agent_id: `agent-${count++}`, engine, cwd: dir,
        persona: { id: "P", name: "P", sprite_set: "P" } });
      return wrappers.at(-1)!;
    },
    close() { runtime?.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
const mode = (register: RunnerRegister, engine: string) => register.engines!.find(e => e.id === engine)!.launch_delivery_policy!;

describe("startup delivery settings", () => {
  it.each([false, true])("publishes the startup enabled=%s ceiling and default independently", async enabled => {
    const h = await harness({ in_flight_delivery: {
      "claude-code": { enabled, default: false }, codex: { enabled, default: false },
    } });
    try {
      for (const engine of ["claude-code", "codex"]) {
        expect(h.spawn(engine).in_flight_delivery_enabled).toBe(enabled);
        const mechanisms = mode(h.registers[0]!, engine).mechanisms;
        if (enabled && engine === "codex") expect(mechanisms.operator_early).toBe("steer");
        else if (enabled) expect(mechanisms.inter_agent_early).toBe("fold");
        else expect(Object.values(mechanisms)).toEqual(["none", "none", "none"]);
      }
      expect(h.registers[0]!.in_flight_defaults).toMatchObject({ "claude-code": false, codex: false });
    } finally { h.close(); }
  });
});

it("ignores removed inputs at startup without warnings", async () => {
  const h = await harness({ codex: { auth_mode: "chatgpt", operator_steer: false }, claude_code: { phase2_delivery: false } }, {
    KAOIRO_CODEX_OPERATOR_STEER: "0", KAOIRO_CODEX_OPERATOR_STEER_PERSONAS: "private-sentinel",
    KAOIRO_CLAUDE_PHASE2_DELIVERY: "0", KAOIRO_CLAUDE_PHASE2_DELIVERY_PERSONAS: "private-sentinel",
  });
  try {
    const oldInputs = /KAOIRO_CODEX_OPERATOR_STEER|KAOIRO_CLAUDE_PHASE2_DELIVERY|codex\.operator_steer|claude_code\.phase2_delivery/;
    expect(h.stderr.filter(line => oldInputs.test(line))).toEqual([]);
    expect(h.spawn()).not.toHaveProperty("phase2_delivery");
    expect(h.spawn("codex")).not.toHaveProperty("operator_steer");
    expect(mode(h.registers.at(-1)!, "codex").mechanisms.operator_early).toBe("steer");
    expect(mode(h.registers.at(-1)!, "claude-code").mechanisms.inter_agent_early).toBe("fold");
    expect(h.stderr.join("")).not.toContain("private-sentinel");
  } finally { h.close(); }
});
