import "../../../scripts/test/fixtures/test-isolation.mjs";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";

// The built CLI is launched directly, with no runner, as docs/reference/configuration/wrapper.md allows.
// Obsolete inputs must not change the startup declaration or emit warnings.
const cli = join(dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");
const secret = "secret-persona-id";

async function startup(env: Record<string, string>, extra: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), "ao563-codex-direct-"));
  const configPath = join(root, "kaoiro.json");
  await writeFile(configPath, JSON.stringify({ agent_id: "ao563.direct.codex", persona: { id: "p", name: "P", sprite_set: "p" },
    display_name: "P", server_url: "ws://127.0.0.1:9/wrapper", codex_backend: "app-server", ...extra }));
  const child = spawn(process.execPath, [cli, configPath], { cwd: root, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "", HOME: root, CODEX_HOME: root, TMPDIR: root, LANG: "C.UTF-8", ...env } });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  try {
    // The complete approval-axis line marks the end of startup declarations.
    await vi.waitFor(() => expect(output).toMatch(/codex: approval_axis=(on|off)\n/), { timeout: 20_000, interval: 20 });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await closed;
    await rm(root, { recursive: true, force: true });
  }
  return output;
}

it("a direct launch ignores every obsolete input without warning or persona disclosure", async () => {
  const output = await startup({ KAOIRO_CODEX_OPERATOR_STEER: "0", KAOIRO_CODEX_OPERATOR_STEER_PERSONAS: secret },
    { operator_steer: false });
  const lines = output.split("\n").filter(line => line.startsWith("codex: warn - "));
  expect(lines).toEqual([]);
  expect(output).not.toContain(secret);
  expect(output).toContain("codex: operator_steer=on");
}, 40_000);

it("a direct launch with no retired input prints no retirement line", async () => {
  const output = await startup({}, {});
  expect(output.split("\n").filter(line => line.startsWith("codex: warn - "))).toEqual([]);
  expect(output).toContain("codex: operator_steer=on");
}, 40_000);
