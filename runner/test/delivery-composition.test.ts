import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { describe, expect, it, vi } from "vitest";
import type { RunnerRegister } from "@kaoiro/protocol";

async function endpoint() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("no port");
  const registers: RunnerRegister[] = [];
  const joins = new Map<string, Record<string, any>>();
  let runner: WebSocket; let topic: string; let joinRef: string;
  server.on("connection", socket => socket.on("message", data => {
    const frame = JSON.parse(data.toString()); const [jr, ref, currentTopic, event, payload] = frame;
    if (event === "phx_join" && currentTopic.startsWith("runner:")) { runner = socket; topic = currentTopic; joinRef = jr; }
    if (event === "phx_join" && currentTopic.startsWith("wrapper:")) joins.set(currentTopic.slice(8), payload);
    if (event === "register") registers.push(payload);
    if (ref !== null) socket.send(JSON.stringify([jr, ref, currentTopic, "phx_reply", { status: "ok", response: {} }]));
    // Withholding persona_prompt stops both real wrappers before host/native initialization.
  }));
  return { url: `ws://127.0.0.1:${address.port}/runner`, registers, joins,
    sendSpawn: (value: unknown) => runner.send(JSON.stringify([joinRef, null, topic, "spawn", value])),
    async close() { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

async function start(extra: Record<string, unknown>, environment: Record<string, string> = {}, changeEnvironment = false) {
  const dir = mkdtempSync(join(tmpdir(), "kogane562-composition-"));
  const server = await endpoint(); const file = join(dir, "runner.config.json");
  mkdirSync(join(dir, "codex-home"));
  const config = { host_id: "composition", server_url: server.url, cwd_allowlist: [dir], capabilities: ["claude-code", "codex"],
    codex: { backend: "app-server", auth_mode: "chatgpt", chatgpt_plan: "plus" }, claude_code: { phase2_delivery: true }, ...extra };
  writeFileSync(file, JSON.stringify(config));
  let entry = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  if (changeEnvironment) {
    entry = join(dir, "change-env.mjs");
    const cli = new URL("../dist/runner-cli.js", import.meta.url).href;
    writeFileSync(entry, `import { runRunnerCli } from ${JSON.stringify(cli)};\nawait runRunnerCli();\n` +
      'process.env.KAOIRO_CLAUDE_PHASE2_DELIVERY="0";\nprocess.env.KAOIRO_CODEX_OPERATOR_STEER="1";\nconsole.log("DELIVERY_ENV_CHANGED");\n');
  }
  const child = spawn(process.execPath, [entry, file], { detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { HOME: dir, PATH: "/usr/bin:/bin", CODEX_HOME: join(dir, "codex-home"), ...environment } });
  let output = ""; child.stdout!.on("data", data => { output += data; }); child.stderr!.on("data", data => { output += data; });
  const stop = async () => {
    const pid = child.pid; if (!Number.isSafeInteger(pid) || pid! <= 0) throw new Error("invalid owned child pid");
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, "exit");
    try { process.kill(-pid!, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    await exited; await server.close(); rmSync(dir, { recursive: true, force: true });
  };
  try {
    await vi.waitFor(() => { expect(child.exitCode, output).toBeNull(); expect(server.registers).toHaveLength(1);
      if (changeEnvironment) expect(output).toContain("DELIVERY_ENV_CHANGED"); }, { timeout: 15_000 });
  } catch (error) { await stop(); throw error; }
  return { ...server, child, config, output: () => output, stop,
    reload: (next: Record<string, unknown>) => writeFileSync(file, JSON.stringify({ ...config, ...next })),
    async wrapper(id: string, engine: "claude-code" | "codex") {
      server.sendSpawn({ version: "0", agent_id: id, cwd: dir, engine, persona: { id: "P", name: "P", sprite_set: "P" } });
      await vi.waitFor(() => expect(server.joins.has(id), output).toBe(true), { timeout: 15_000 });
      return server.joins.get(id)!;
    },
  };
}

function declaration(join: Record<string, any>) {
  return { operator_early: join.operator_input_modes?.early ?? join.inter_agent_delivery_modes.early,
    inter_agent_early: join.inter_agent_delivery_modes.early, inter_agent_yield: join.inter_agent_delivery_modes.yield };
}
function metadata(register: RunnerRegister, engine: string) { return register.engines!.find(e => e.id === engine)!.launch_delivery_policy!; }

describe("built runner and wrapper delivery composition", () => {
  it("rejects malformed startup settings before connecting", () => {
    const dir = mkdtempSync(join(tmpdir(), "kogane562-invalid-start-"));
    try {
      for (const block of [null, [], false, { claude_code: {} }, { codex: null }, { codex: [] }, { codex: { enabeld: true } }, { codex: { default: "false" } }]) {
        const path = join(dir, "config.json");
        writeFileSync(path, JSON.stringify({ host_id: "invalid", server_url: "ws://127.0.0.1:59999/runner", cwd_allowlist: [dir], in_flight_delivery: block }));
        const result = spawnSync(process.execPath, [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), path],
          { env: { HOME: dir, PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5000 });
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("in_flight_delivery");
        expect(result.stderr).not.toContain("connecting to");
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("uses default constructors and keeps existing declarations while the next lifetime follows reload", async () => {
    const h = await start({});
    try {
      const first = await h.wrapper("first", "claude-code");
      expect(declaration(first)).toEqual(metadata(h.registers[0]!, "claude-code").mechanisms);
      expect(declaration(first).inter_agent_early).toBe("fold");
      h.reload({ in_flight_delivery: { "claude-code": { enabled: false, default: false } } });
      await vi.waitFor(() => expect(h.registers).toHaveLength(2), { timeout: 10_000 });
      const next = await h.wrapper("next", "claude-code");
      expect(declaration(next)).toEqual(metadata(h.registers[1]!, "claude-code").mechanisms);
      expect(declaration(next).inter_agent_early).toBe("none");
      expect(declaration(h.joins.get("first")!).inter_agent_early).toBe("fold");
    } finally { await h.stop(); }
  }, 40_000);
  it("applies each wrapper ceiling after enabled legacy variables", async () => {
    const h = await start({ in_flight_delivery: { "claude-code": { enabled: false }, codex: { enabled: false } } },
      { KAOIRO_CLAUDE_PHASE2_DELIVERY: "1", KAOIRO_CODEX_OPERATOR_STEER: "1" });
    try {
      for (const engine of ["claude-code", "codex"] as const) {
        const actual = declaration(await h.wrapper(engine, engine));
        expect(actual).toEqual(metadata(h.registers[0]!, engine).mechanisms);
        expect(actual).toEqual({ operator_early: "none", inter_agent_early: "none", inter_agent_yield: "none" });
      }
    } finally { await h.stop(); }
  }, 40_000);
  it("the child observes captured present and absent environment values after process.env changes", async () => {
    const h = await start({}, { KAOIRO_CLAUDE_PHASE2_DELIVERY: "1" }, true);
    try {
      const claude = declaration(await h.wrapper("claude", "claude-code"));
      const codex = declaration(await h.wrapper("codex", "codex"));
      expect(claude).toEqual(metadata(h.registers[0]!, "claude-code").mechanisms); expect(claude.inter_agent_early).toBe("fold");
      expect(codex).toEqual(metadata(h.registers[0]!, "codex").mechanisms); expect(codex.operator_early).toBe("none");
      expect(codex.inter_agent_early).toBe("steer");
    } finally { await h.stop(); }
  }, 40_000);
});
