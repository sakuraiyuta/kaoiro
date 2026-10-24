import "../../../scripts/test/fixtures/test-isolation.mjs";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ToolDescriptor } from "@kaoiro/agent-common";
import { runAntigravityCli } from "../src/cli.js";
import { AntigravityHost, type AntigravityHostOptions } from "../src/host.js";
import { ToolHost } from "../src/toolhost.js";
import { phoenixLoopback } from "../../grok/test/fixtures/phoenix_loopback.js";

const USAGE_OK = JSON.stringify({
  status: "SUCCESS",
  command: {
    name: "usage",
    data: {
      groups: [{
        buckets: [
          { id: "gemini-5h", window: "5h", remaining_fraction: 0.6, reset_time: "2026-10-03T12:00:00Z" },
          { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.25, reset_time: "2026-10-04T12:00:00Z" },
        ],
      }],
    },
  },
});
const LIMITS_OK = {
  five_hour: { utilization: 0.4, resets_at: 1791028800 },
  seven_day: { utilization: 0.75, resets_at: 1791115200 },
};

// A fake agy: the real one tries to self-update on every start.
function writeFakeAgy(root: string, usage: { stdout: string; code: number }): { path: string; capture: string } {
  const path = join(root, "agy-fixture.mjs");
  const capture = join(root, "calls.jsonl");
  writeFileSync(path, `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(capture)}, JSON.stringify(args) + "\\n");
if (args[0] === "models") process.stdout.write("gemini-3.8-flash-high\\tFixture\\n");
else if (args[0] === "-p" && args[1] === "/usage") {
  process.stdout.write(${JSON.stringify(usage.stdout)});
  process.exitCode = ${usage.code};
} else process.exitCode = 2;
`);
  chmodSync(path, 0o755);
  return { path, capture };
}

async function callWhoami(toolHost: ToolHost): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(toolHost.socketPath);
    let buffer = "";
    socket.once("error", reject);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, nonce: toolHost.nonce, method: "call_tool", name: "whoami", input: {} })}\n`);
    });
    socket.on("data", (chunk: string | Buffer) => {
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\n")) return;
      socket.end();
      const text = (JSON.parse(buffer) as { result?: { content?: { text?: string }[] } }).result?.content?.[0]?.text;
      if (text === undefined) reject(new Error("whoami returned no text"));
      else resolve(JSON.parse(text) as Record<string, unknown>);
    });
  });
}

// Real spawn, real ServerLink over loopback, real host: nothing but the config
// input is injected (createHost only keeps the options for the whoami tool).
async function startup(usage: { stdout: string; code: number }, resume?: string, waitForWarning?: string) {
  const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-startup-probe-"));
  const fake = writeFakeAgy(root, usage);
  const server = await phoenixLoopback(() => ({ permission_sync: false }));
  const persona = { id: "default", name: "Default", sprite_set: "default" };
  const config = {
    agent_id: "startup-probe.antigravity", display_name: "Probe", persona, server_url: server.url,
    model: "gemini-3.8-flash-high", antigravity_cli_path: fake.path,
  };
  const stderr: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  let host: AntigravityHost | undefined;
  let hostOptions: AntigravityHostOptions | undefined;
  const work = runAntigravityCli({
    parseCliArgs: () => ({ configPath: "fixture", ...(resume === undefined ? {} : { resume }) }),
    loadConfig: () => config,
    createHost: (cfg, options) => {
      hostOptions = options;
      return new AntigravityHost(cfg, options);
    },
    onHostCreated: (value) => { host = value; },
    probeSshAgentIdentities: async () => "unknown",
  });
  void work.catch(() => {});
  const states = () => server.received
    .filter((x) => x.event === "envelope" && x.payload.type === "state_change")
    .map((x) => x.payload as { ext?: { rate_limits?: unknown } });
  let toolHost: ToolHost | undefined;
  try {
    await vi.waitFor(() => expect(server.joins).toBe(1));
    server.push("persona_prompt", { version: "0", prompt: "Fixture persona" });
    // Wait on the host's own outcome, never on a sleep: the published limits,
    // or the warning it writes when the probe fails.
    await vi.waitFor(
      () => waitForWarning === undefined
        ? expect(states().some((s) => s.ext?.rate_limits !== undefined)).toBe(true)
        : expect(stderr.join("")).toContain(`antigravity usage probe failed: ${waitForWarning}`),
      { timeout: 10_000 },
    );
    toolHost = await ToolHost.listen(hostOptions!.toolDescriptors as ToolDescriptor[]);
    const whoami = await callWhoami(toolHost);
    const usageCalls = readFileSync(fake.capture, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as string[]).filter((args) => args[1] === "/usage");
    return { states: states(), whoami, usageCalls };
  } finally {
    toolHost?.close();
    await host?.close();
    try { await work; } finally { await server.close(); }
    spy.mockRestore();
    rmSync(root, { force: true, recursive: true });
  }
}

describe("Antigravity startup usage probe through the default CLI path (issue #664)", () => {
  it.each([["fresh", undefined], ["resumed", "session-664"]])(
    "%s idle start publishes both windows once, in state and in whoami",
    async (_name, resume) => {
      const { states, whoami, usageCalls } = await startup({ stdout: USAGE_OK, code: 0 }, resume);
      expect(usageCalls).toHaveLength(1);
      expect(states.at(-1)?.ext?.rate_limits).toEqual(LIMITS_OK);
      expect(whoami.rate_limits).toEqual(LIMITS_OK);
    },
    15_000,
  );

  it.each([
    ["a non-zero exit", "", 3, "exit_3"],
    ["non-JSON output", "not json", 0, "unrecognized_or_empty_bucket_set"],
    ["empty output with exit 0", "", 0, "unrecognized_or_empty_bucket_set"],
  ])("%s publishes no rate_limits anywhere", async (_name, stdout, code, warning) => {
    const { states, whoami, usageCalls } = await startup({ stdout, code }, undefined, warning);
    expect(usageCalls).toHaveLength(1);
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((s) => s.ext?.rate_limits === undefined)).toBe(true);
    expect(whoami).not.toHaveProperty("rate_limits");
  }, 15_000);
});
