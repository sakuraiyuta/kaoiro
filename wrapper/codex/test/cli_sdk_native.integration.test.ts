import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import { runCodexCli } from "../src/cli.js";
import { resolveAppServerBinary } from "../src/app_server_rpc.js";
import { phoenixLoopback } from "./fixtures/phoenix_loopback.js";

// Only the external peers are scripted. No CLI construction seam is injected;
// the exec case also measures the SDK reader on actual native command output.
it.each(["exec", "app-server"] as const)("runs the %s production factories against a local provider", async backend => {
  const home = await mkdtemp(join(homedir(), "niko-539-cli-native-"));
  const nonce = `native-${randomUUID()}`;
  const unicode = `before${String.fromCodePoint(0x2028)}middle${String.fromCodePoint(0x2029)}after`;
  const requests: Array<Record<string, unknown>> = [];
  const wire = await phoenixLoopback();
  const provider = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body) as Record<string, unknown>; requests.push(parsed);
    const n = requests.length, id = `response-${n}`;
    const command = JSON.stringify(process.execPath) + ' -e "process.stdout.write(\'before\'+String.fromCodePoint(0x2028)+\'middle\'+String.fromCodePoint(0x2029)+\'after\')"';
    const items = n === 1
      ? [{ type: "custom_tool_call", id: "call-item", call_id: "call-1", name: "exec", status: "completed",
        input: `text(await tools.exec_command(${JSON.stringify({ cmd: command })}));` }]
      : [{ type: "message", id: `answer-${n}`, role: "assistant", phase: "final_answer", status: "completed",
        content: [{ type: "output_text", text: nonce, annotations: [] }] }];
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: "response.created", response: { id, object: "response", status: "in_progress", output: [] } });
    items.forEach((item, output_index) => {
      send({ type: "response.output_item.added", output_index, item });
      send({ type: "response.output_item.done", output_index, item });
    });
    send({ type: "response.completed", response: { id, object: "response", status: "completed", output: items,
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    response.end();
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address(); if (!address || typeof address === "string") throw new Error("No provider port");
  const argv = process.argv, signals = process.listeners("SIGINT");
  let running: Promise<void> | undefined;
  try {
    await writeFile(join(home, "config.toml"), `model = "gpt-6-luna"\nmodel_provider = "local"\n[model_providers.local]\nname = "Native SDK test"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\n[features]\nshell_snapshot = false\nplugins = false\n[analytics]\nenabled = false\n`);
    const configPath = join(home, "kaoiro.json");
    await writeFile(configPath, JSON.stringify({ agent_id: "native-fixture", persona: { id: "native-fixture", name: "Native", sprite_set: "native-fixture" },
      display_name: "Native", server_url: wire.url, model: "gpt-6-luna", sandbox: "read-only", network_access: false,
      ...(backend === "app-server" ? { codex_backend: backend } : {}) }));
    vi.stubEnv("HOME", home); vi.stubEnv("CODEX_HOME", home);
    for (const name of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "CODEX_MODEL_DEFAULT",
      "KAOIRO_CODEX_APPROVAL_AXIS", "KAOIRO_CODEX_OPERATOR_STEER"]) vi.stubEnv(name, undefined);
    process.argv = [process.execPath, "cli.js", configPath, "Exercise actual command output"];
    running = runCodexCli();
    await vi.waitFor(() => expect(wire.joins).toBe(1));
    wire.push("permission_sync", { version: "0", control: null, next: null });
    wire.push("persona_prompt", { prompt: "Local acceptance fixture" });
    const results = () => wire.received.filter(e => e.event === "envelope" && e.payload.type === "result");
    await vi.waitFor(() => expect(results()).toHaveLength(1), { timeout: 45_000 });
    expect(results()[0]!.payload).toMatchObject({ state: "done", payload: { text: expect.stringContaining(nonce) } });
    expect((results()[0]!.payload.payload as Record<string, unknown>).is_error).not.toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.model).toBe("gpt-6-luna");
    expect(JSON.stringify(requests[1]!.input)).toContain(unicode);
    const native = resolveAppServerBinary();
    const version = execFileSync(native, ["--version"], { encoding: "utf8" }).trim();
    expect(version).toBe("codex-cli 0.161.0");
    const record = { backend, node: process.version, native_version: version,
      native_sha256: createHash("sha256").update(await readFile(native)).digest("hex"),
      requests: requests.map(r => ({ model: r.model, reasoning: r.reasoning })), unicode_observed: true,
      result: results()[0]!.payload, factory_injections: [] };
    const outputDir = process.env.KAOIRO_CODEX_0161_EVIDENCE_DIR;
    if (outputDir) await writeFile(join(outputDir, `cli-native-${backend}.json`), JSON.stringify(record, null, 2) + "\n");
  } finally {
    for (const listener of process.listeners("SIGINT")) if (!signals.includes(listener)) listener("SIGINT");
    await running;
    process.argv = argv; vi.unstubAllEnvs();
    await wire.close(); provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);
