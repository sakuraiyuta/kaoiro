import "../../../scripts/test/fixtures/test-isolation.mjs";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runGrokCli } from "../src/cli.js";
import { GrokHost } from "../src/host.js";
import { phoenixLoopback } from "../../../runner/test/fixtures/phoenix_loopback.js";

const scratch: string[] = [];
const cwd = () => { const path = mkdtempSync(join(homedir(), ".kaoiro-grok-model-")); scratch.push(path); return path; };
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

async function connected(env: NodeJS.ProcessEnv) {
  const server = await phoenixLoopback(() => ({}));
  let host: GrokHost | undefined;
  const work = runGrokCli({
    platform: "darwin", cwd: cwd(),
    parseCliArgs: () => ({ configPath: "fixture" }),
    loadConfig: () => ({ agent_id: "composition.model", display_name: "Grok", server_url: server.url,
      sandbox: "danger-full-access", network_access: true,
      persona: { id: "default", name: "Default", sprite_set: "default" } }),
    loadWrapperBuildInfo: () => ({ revision: "unknown", dirty: false, built_at: "unknown", version: "unknown", channel: "dev" }),
    createHost: (options) => new GrokHost({ ...options, env: { ...process.env, ...env },
      executable: fileURLToPath(new URL("./fixtures/grok.mjs", import.meta.url)) }),
    onHostCreated: (value) => { host = value; },
  });
  void work.catch(() => {});
  await vi.waitFor(() => expect(server.joins).toBe(1), { timeout: 10_000 });
  server.push("persona_prompt", { prompt: "Fixture" });
  await vi.waitFor(() => expect(host?.state).toBe("waiting_input"), { timeout: 5000 });
  const states = () => server.received.filter((x) => x.event === "envelope" && x.payload.type === "state_change")
    .map((x) => x.payload.ext as Record<string, any>);
  const logs = () => server.received.filter((x) => x.event === "envelope" && x.payload.type === "log")
    .map((x) => (x.payload.payload as any).text);
  return { server, states, logs, finish: async () => { host?.close(); await work; await server.close(); } };
}

it("applies the operator's model and effort picks from the wire", async () => {
  const t = await connected({});
  try {
    t.server.push("set_model", { model: "grok-4.6" });
    await vi.waitFor(() => expect(t.states().at(-1)).toMatchObject({ model: "grok-4.6", model_source: "config" }), { timeout: 10_000 });
    t.server.push("set_effort", { effort: "low" });
    await vi.waitFor(() => expect(t.states().at(-1)).toMatchObject({ effort: "low", effort_source: "config" }), { timeout: 10_000 });
    t.server.push("set_model", { model: "bogus" });
    await vi.waitFor(() => expect(t.states().some((s) => s.switch_error?.requested === "bogus")).toBe(true), { timeout: 10_000 });
    expect(t.states().at(-1)).toMatchObject({ model: "grok-4.6" });
  } finally { await t.finish(); }
}, 15_000);

it("reports a pick the host cannot honour as a failure", async () => {
  const t = await connected({ KAOIRO_TEST_GROK_CONFIG: "none" });
  try {
    t.server.push("set_model", { model: "grok-4.6" });
    await vi.waitFor(() => expect(t.logs()).toContain("grok model switching failed"), { timeout: 10_000 });
    t.server.push("set_effort", { effort: "low" });
    await vi.waitFor(() => expect(t.logs()).toContain("grok effort switching failed"), { timeout: 10_000 });
    expect(t.states().at(-1)).toMatchObject({ model: "default" });
  } finally { await t.finish(); }
}, 15_000);
