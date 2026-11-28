import "../../../scripts/test/fixtures/test-isolation.mjs";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync,
  writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { MuseHost } from "../src/host.js";

const executable = fileURLToPath(new URL("./fixtures/muse.mjs", import.meta.url));
const config: WrapperConfig = { agent_id: "muse-test", display_name: "test",
  persona: { id: "p", name: "P", sprite_set: "p" }, server_url: "ws://localhost" };
const roots: string[] = [];
const hosts: MuseHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) { host.close(); await host.closed; }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "muse-preflight-"));
  roots.push(root);
  const xdg = join(root, "xdg");
  const home = join(root, "home");
  const path = join(xdg, "muse", "settings.json");
  const launch = join(root, "launch.json");
  mkdirSync(join(xdg, "muse"), { recursive: true });
  mkdirSync(join(home, ".config", "muse"), { recursive: true });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg,
    KAOIRO_TEST_LAUNCH_FILE: launch };
  return { root, xdg, home, path, launch, env };
}
function start(env: NodeJS.ProcessEnv) {
  const envelopes: Envelope[] = [];
  const host = new MuseHost({ config, cwd: process.cwd(), personaPrompt: "persona",
    executable, env, send: (e) => envelopes.push(e),
    decidePermission: async () => ({ allow: true }) });
  hosts.push(host);
  const run = host.run();
  void run.catch(() => {});
  return { host, run, envelopes };
}
async function rejected(env: NodeJS.ProcessEnv, launch: string, marker: string) {
  const { host, run, envelopes } = start(env);
  await vi.waitFor(() => expect(["error", "waiting_input"]).toContain(host.state),
    { timeout: 5_000 });
  expect(host.state).toBe("error");
  await expect(run).rejects.toThrow(/muse user settings/);
  await expect(run).rejects.not.toThrow(marker);
  expect(host.state).toBe("error");
  expect(() => readFileSync(launch)).toThrow();
  expect(JSON.stringify(envelopes)).not.toContain(marker);
}

it("isolates existing host tests from a simulated original HOME", async () => {
  const root = process.env.KAOIRO_MUSE_TEST_ROOT;
  expect(root).toBeDefined();
  expect(process.env.HOME).toBe(root);
  expect(process.env.XDG_CONFIG_HOME).toBe(join(root!, "config"));
  const f = fixture();
  writeFileSync(join(f.home, ".config", "muse", "settings.json"),
    JSON.stringify({ run: { system_prompt_append: "ORIGINAL_HOME_MARKER" } }));
  const { host } = start(f.env);
  await vi.waitFor(() => expect(host.state).toBe("waiting_input"), { timeout: 5_000 });
  expect(JSON.parse(readFileSync(f.launch, "utf8")).args).toContain("acp");
});

it.each([
  ["nested", { run: { system_prompt_append: "PRIVATE_MARKER" } }],
  ["flat", { "run.system_prompt_append": "PRIVATE_MARKER" }],
  ["flat empty", { "run.system_prompt_append": "" }],
  ["flat null", { "run.system_prompt_append": null }],
  ["both", { run: { system_prompt_append: null },
    "run.system_prompt_append": "PRIVATE_MARKER" }],
  ["empty", { run: { system_prompt_append: "" } }],
  ["null", { run: { system_prompt_append: null } }],
  ["bad run", { run: "PRIVATE_MARKER" }],
  ["bad root", ["PRIVATE_MARKER"]],
])("rejects %s without starting Muse or leaking settings", async (_label, value) => {
  const f = fixture();
  writeFileSync(f.path, JSON.stringify(value));
  await rejected(f.env, f.launch, "PRIVATE_MARKER");
});

it("does not leak a JSON parser error containing a settings fragment", async () => {
  const f = fixture();
  const invalid = '{"run": SECRET_MARKER_1302}';
  expect(() => JSON.parse(invalid)).toThrow(/SECRET_MAR/);
  writeFileSync(f.path, invalid);
  await rejected(f.env, f.launch, "SECRET_MAR");
});

it("passes a developer-only setting without copying it to argv", async () => {
  const f = fixture();
  writeFileSync(f.path, JSON.stringify({ run: { developer_prompt: "PRIVATE_MARKER" } }));
  const { host, envelopes } = start(f.env);
  await vi.waitFor(() => expect(host.state).toBe("waiting_input"), { timeout: 5_000 });
  const args = JSON.parse(readFileSync(f.launch, "utf8")).args as string[];
  expect(args[args.indexOf("-c") + 1]).toBe('run.system_prompt_append="persona"');
  expect(JSON.stringify({ args, envelopes })).not.toContain("PRIVATE_MARKER");
});

it("uses the same child environment for XDG and HOME fallback", async () => {
  const f = fixture();
  writeFileSync(join(f.home, ".config", "muse", "settings.json"),
    JSON.stringify({ run: { system_prompt_append: "PRIVATE_MARKER" } }));
  const first = start(f.env);
  await vi.waitFor(() => expect(first.host.state).toBe("waiting_input"), { timeout: 5_000 });
  rmSync(f.launch);
  await rejected({ ...f.env, XDG_CONFIG_HOME: "" }, f.launch, "PRIVATE_MARKER");
});

it("rejects relative or missing roots", async () => {
  const f = fixture();
  await rejected({ ...f.env, XDG_CONFIG_HOME: "relative" }, f.launch, "unused");
  await rejected({ ...f.env, XDG_CONFIG_HOME: "", HOME: "" }, f.launch, "unused");
});

it("accepts a symlink to a regular settings file", async () => {
  const f = fixture();
  const target = join(f.root, "linked-settings.json");
  writeFileSync(target, JSON.stringify({ schema_version: 1 }));
  symlinkSync(target, f.path);
  const { host } = start(f.env);
  await vi.waitFor(() => expect(host.state).toBe("waiting_input"), { timeout: 5_000 });
});

it("rejects a nonregular settings file and a file larger than 1 MiB", async () => {
  const f = fixture();
  const mkfifo = spawnSync("mkfifo", [f.path]);
  expect(mkfifo.status).toBe(0);
  await rejected(f.env, f.launch, "unused");
  rmSync(f.path);
  writeFileSync(f.path, " ".repeat(1024 * 1024 + 1));
  await rejected(f.env, f.launch, "unused");
});

it("rejects a non-ENOENT read failure", async () => {
  const f = fixture();
  mkdirSync(f.path);
  await rejected(f.env, f.launch, "unused");
});

it.skipIf(process.getuid?.() === 0)("rejects an unreadable file", async () => {
  const f = fixture();
  writeFileSync(f.path, "{}");
  chmodSync(f.path, 0);
  try { await rejected(f.env, f.launch, "unused"); }
  finally { chmodSync(f.path, 0o600); }
});
