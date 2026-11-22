import "../../../scripts/test/fixtures/test-isolation.mjs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { runAntigravityCli } from "../src/cli.js";
import { AntigravityHost } from "../src/host.js";
import { writeFakeAgy } from "./fake_agy_executable.js";

/** The real hook entry, so agy's hook command reaches this host's gate. */
const kaoiroPath = fileURLToPath(new URL("../../../runner/dist/kaoiro.js", import.meta.url));

async function waitFor(predicate: () => boolean, diagnostic: () => unknown, timeoutMs = 15_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out after ${timeoutMs}ms: ${JSON.stringify(diagnostic())}`);
}

interface Started {
  root: string;
  sent: Envelope[];
  options: Record<string, any>;
  host: { close(): Promise<void> | void; state: string } | undefined;
  run: Promise<void>;
  results(): Record<string, any>[];
  argv(): string[][];
}

const started: Started[] = [];

afterEach(async () => {
  for (const item of started.splice(0)) {
    await item.host?.close();
    await item.run.catch(() => {});
    rmSync(item.root, { recursive: true, force: true });
  }
});

async function start(
  overrides: Partial<WrapperConfig> = {},
  variables: Record<string, string> = {},
  realHook = false,
): Promise<Started> {
  const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-acp-"));
  const record = join(root, "argv.jsonl");
  const executable = writeFakeAgy(root, { record, env: variables });
  const configPath = join(root, "wrapper.config.json");
  const config: WrapperConfig = {
    agent_id: "self.agent",
    persona: { id: "p", name: "P", sprite_set: "p" },
    display_name: "P",
    server_url: "ws://localhost:4000/wrapper",
    antigravity_cli_path: executable,
    antigravity_probe_timeout_ms: 45_000,
    ...overrides,
  } as WrapperConfig;
  writeFileSync(configPath, JSON.stringify(config));
  const sent: Envelope[] = [];
  const item: Started = {
    root,
    sent,
    options: {},
    host: undefined,
    run: Promise.resolve(),
    results: () => sent.filter((envelope) => envelope.type === "result").map((envelope) => envelope.payload as Record<string, any>),
    argv: () => readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]),
  };
  item.run = runAntigravityCli({
    parseCliArgs: () => ({ configPath }),
    probeSshAgentIdentities: async () => "unknown",
    onHostCreated: (created) => { item.host = created as never; },
    ...(realHook
      ? { createHost: (cfg, options) => new AntigravityHost(cfg, { ...options, nodePath: process.execPath, nodeArgs: [], entryPath: kaoiroPath }) }
      : {}),
    createServerLink: (_url, _agentId, created) => {
      item.options = created as unknown as Record<string, any>;
      queueMicrotask(() => {
        item.options.onPersonaPrompt("persona");
        item.options.onInterAgentDeliveryStatus?.({ acked_seq: 0 });
      });
      return {
        close: () => {},
        setSessionId: () => {},
        reportPermissionLifecycle: () => {},
        acknowledgeInterAgentDelivery: () => {},
        send: (envelope: Envelope) => { sent.push(envelope); },
      } as never;
    },
  });
  started.push(item);
  await waitFor(() => item.host !== undefined && item.options.onInstruction !== undefined, () => ({}));
  return item;
}

describe("Antigravity over ACP through the production CLI", () => {
  it("runs one instruction on one agy acp process and returns its reply", async () => {
    const item = await start();
    item.options.onInstruction("ECHO hello there");
    await waitFor(() => item.results().length === 1, () => item.sent.map((e) => [e.type, e.state]));
    expect(item.results()[0]).toMatchObject({ text: "hello there" });
    expect(item.results()[0]?.is_error).not.toBe(true);
    await waitFor(() => item.host?.state === "waiting_input", () => item.host?.state);
  });

  it("from the defaults, runs a second turn on a second agy acp process (no injection)", async () => {
    const item = await start();
    item.options.onInstruction("ECHO first");
    await waitFor(() => item.results().length === 1, () => item.sent.map((e) => e.type));
    item.options.onInstruction("ECHO second");
    await waitFor(() => item.results().length === 2, () => item.sent.map((e) => e.type));
    expect(item.results().map((result) => result.text)).toEqual(["first", "second"]);
    expect(item.argv().filter((args) => args[0] === "acp")).toHaveLength(2);
    expect(item.argv().filter((args) => args[0] === "-p" && args[1] === "/hooks")).toHaveLength(2);
  });

  it("decides tool calls through the real hook command: an allow runs, a deny returns and the turn continues", async () => {
    const item = await start({}, {}, true);
    item.options.onInstruction(`TOOL read_file ${JSON.stringify({ Path: join(item.root, "a.txt") })}`);
    await waitFor(() => item.results().length === 1, () => item.sent.map((e) => [e.type, e.payload]));
    const toolResults = () => item.sent.filter((e) => e.type === "log" && (e.payload as { kind?: string }).kind === "tool_result");
    expect(item.results()[0]?.is_error).not.toBe(true);
    item.options.onInstruction(`TOOL run_command ${JSON.stringify({ CommandLine: "make deploy" })}`);
    await waitFor(() => item.results().length === 2, () => item.sent.map((e) => e.type));
    expect(item.results()[1]?.is_error).not.toBe(true);
    expect(toolResults().map((e) => (e.payload as { output?: string }).output)).toEqual([
      "allowed",
      "kaoiro: this tool needs network access in workspace-write",
    ]);
  });

  it("calls a kaoiro tool through the hook and the HTTP tool host", async () => {
    const item = await start({}, {}, true);
    item.options.onInstruction("KAOIRO whoami {}");
    await waitFor(() => item.results().length === 1, () => item.sent.map((e) => [e.type, e.payload]));
    const output = item.sent
      .filter((e) => e.type === "log" && (e.payload as { kind?: string }).kind === "tool_result")
      .map((e) => JSON.stringify(e.payload))
      .join("");
    expect(output).toContain("self.agent");
    expect(item.results()[0]?.is_error).not.toBe(true);
  });

  it("keeps the prompt open through the real Stop hook while agy reports background work", async () => {
    const item = await start({}, {}, true);
    item.options.onInstruction("HOLDSTOP");
    await waitFor(() => item.results().length === 1, () => item.sent.map((e) => e.type));
    expect(item.results()[0]).toMatchObject({ text: "held" });
  });

  it("a call that skipped the hook latches the gate fault; later input is refused", async () => {
    const item = await start({}, {}, true);
    item.options.onInstruction("UNHOOKED run_command");
    await waitFor(() => item.results().length === 1, () => item.sent.map((e) => e.type));
    expect(item.results()[0]).toMatchObject({ is_error: true, error_detail: "antigravity_gate_unobserved_tool:run_command" });
    await waitFor(() => item.host?.state === "error", () => item.host?.state);
    item.options.onInstruction("ECHO after");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(item.results()).toHaveLength(1);
    expect(item.argv().filter((args) => args[0] === "acp")).toHaveLength(1);
  });
});
