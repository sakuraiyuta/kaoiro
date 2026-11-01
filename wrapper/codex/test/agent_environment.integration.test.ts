import "../../../scripts/test/fixtures/test-isolation.mjs";
import { createServer } from "node:http";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { CodexHost } from "../src/host.js";
import { runCodexCli } from "../src/cli.js";
import { AppServerRpc, resolveAppServerBinary } from "../src/app_server_rpc.js";
import { phoenixLoopback } from "./fixtures/phoenix_loopback.js";

const execFileAsync = promisify(execFile);

it.each([undefined, "exec", "app-server"] as const)("marks native %s shells with inherit-none across cold resumes", async backend => {
  const root = await mkdtemp(join(homedir(), ".fuji659-codex-"));
  const requests: Array<Record<string, unknown>> = [];
  const wire = await phoenixLoopback();
  const provider = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    const n = requests.length;
    const output = n % 2 === 1 ? [{
      type: "custom_tool_call", id: `call-${n}`, call_id: `call-${n}`, name: "exec", status: "completed",
      input: `text(await tools.exec_command(${JSON.stringify({ cmd: 'printf "FUJI_MARKER=%s\\n" "${KAOIRO_AGENT-unset}"' })}));`,
    }] : [{
      type: "message", id: `answer-${n}`, role: "assistant", phase: "final_answer", status: "completed",
      content: [{ type: "output_text", text: "DONE", annotations: [] }],
    }];
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id: `r${n}`, object: "response", status: "in_progress", output: [] } },
      ...output.flatMap((item, output_index) => [
        { type: "response.output_item.added", output_index, item },
        { type: "response.output_item.done", output_index, item },
      ]),
      { type: "response.completed", response: { id: `r${n}`, object: "response", status: "completed", output,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("No provider port");
  const argv = process.argv;
  const originalSignals = process.listeners("SIGINT");
  const hosts = vi.spyOn(CodexHost.prototype, "run");
  let childOutput = "";
  let running: Promise<void> | undefined;
  let nativeChild: ChildProcess | undefined;
  try {
    const hookLog = join(root, "hook-observations.jsonl");
    const hook = join(root, "hook.cjs");
    await writeFile(hook, `const fs = require("node:fs"); let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => { const data = JSON.parse(input || "{}");
fs.appendFileSync(${JSON.stringify(hookLog)}, JSON.stringify({ marker: process.env.KAOIRO_AGENT ?? "unset", source: data.source }) + "\\n"); });`);
    await writeFile(join(root, "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{
      type: "command", command: `"${process.execPath}" "${hook}"`, timeout: 5,
    }] }] } }));
    await writeFile(join(root, "config.toml"), `model = "gpt-6-luna"
model_provider = "local"
[model_providers.local]
name = "Marker integration test"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
[shell_environment_policy]
inherit = "none"
[features]
shell_snapshot = false
plugins = false
[analytics]
enabled = false
`);
    vi.stubEnv("HOME", root);
    vi.stubEnv("CODEX_HOME", root);
    for (const name of ["KAOIRO_AGENT", "OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID",
      "KAOIRO_CODEX_APPROVAL_AXIS", "KAOIRO_CODEX_OPERATOR_STEER"]) vi.stubEnv(name, undefined);
    const inspector = new AppServerRpc();
    try {
      await inspector.request("initialize", { clientInfo: { name: "marker-hook-trust", version: "0" }, capabilities: { experimentalApi: true } }).result;
      inspector.notify("initialized");
      const listed = await inspector.request("hooks/list", { cwds: [root] }).result as {
        data: Array<{ hooks: Array<{ key: string; currentHash: string }> }>;
      };
      const discovered = listed.data.flatMap(entry => entry.hooks);
      expect(discovered).toHaveLength(1);
      for (const entry of discovered) await appendFile(join(root, "config.toml"),
        `\n[hooks.state.${JSON.stringify(entry.key)}]\ntrusted_hash = ${JSON.stringify(entry.currentHash)}\n`);
    } finally { await inspector.close(); }
    const plainRun = execFileAsync(resolveAppServerBinary(), ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "seed"],
      { cwd: root, timeout: 45_000 });
    plainRun.child.stdin?.end();
    const plain = await plainRun;
    const seed = plain.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
      .find(event => event.type === "thread.started")?.thread_id;
    expect(typeof seed).toBe("string");
    expect(JSON.stringify(requests.at(-1)?.input)).toContain("FUJI_MARKER=unset");
    const hooks = async () => (await readFile(hookLog, "utf8")).trim().split("\n")
      .map(line => JSON.parse(line) as { marker: string; source?: string });
    expect((await hooks()).every(entry => entry.marker === "unset")).toBe(true);
    const configPath = join(root, "agent.json");
    await writeFile(configPath, JSON.stringify({ agent_id: "native-marker", persona: { id: "marker", name: "Marker", sprite_set: "marker" },
      display_name: "Marker", server_url: wire.url, model: "gpt-6-luna", sandbox: "read-only", network_access: false,
      codex_backend: backend }));
    let managedSession: string | undefined;
    for (const stage of ["fresh", "cold-resume-unmarked", "cold-resume-managed"] as const) {
      const before = wire.received.length;
      const hooksBefore = (await hooks()).length;
      const joins = wire.joins;
      const resumed = stage === "fresh" ? undefined : stage === "cold-resume-unmarked" ? seed as string : managedSession;
      process.argv = [process.execPath, "cli.js", configPath, "Read the marker", ...(resumed ? ["--resume", resumed] : [])];
      if (stage === "cold-resume-managed") {
        nativeChild = spawn(process.execPath, [fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
          configPath, "Read the marker", "--resume", resumed!], { stdio: ["ignore", "pipe", "pipe"] });
        childOutput = "";
        nativeChild.stdout!.on("data", chunk => { childOutput += chunk; });
        nativeChild.stderr!.on("data", chunk => { childOutput += chunk; });
        running = new Promise<void>((resolve, reject) => {
          nativeChild!.once("error", reject);
          nativeChild!.once("close", code => code === 0 ? resolve() : reject(new Error(`Wrapper child exited ${code}: ${childOutput}`)));
        });
      } else running = runCodexCli();
      void running.catch(() => {});
      await vi.waitFor(() => expect(wire.joins).toBe(joins + 1), { timeout: 10_000 });
      wire.push("permission_sync", { version: "0", control: null, next: null });
      wire.push("persona_prompt", { prompt: "Local marker fixture" });
      const result = () => wire.received.slice(before).find(e => e.event === "envelope" && e.payload.type === "result");
      await vi.waitFor(() => expect(result()).toBeDefined(), { timeout: 45_000 });
      expect((result()!.payload.payload as Record<string, unknown>).is_error).not.toBe(true);
      expect(JSON.stringify(requests.at(-1)?.input)).toContain("FUJI_MARKER=1");
      expect(process.env.KAOIRO_AGENT).toBeUndefined();
      if (nativeChild) expect(childOutput).toContain(`codex: backend=${backend ?? "app-server"}`);
      else expect((hosts.mock.contexts.at(-1) as CodexHost).historyBackend).toBe(backend ?? "app-server");
      const currentHooks = (await hooks()).slice(hooksBefore);
      expect(currentHooks.length).toBeGreaterThan(0);
      expect(currentHooks.every(entry => entry.marker === "1")).toBe(true);
      const session = result()!.payload.session_id as string;
      expect(session).toBeTruthy();
      if (stage === "fresh") managedSession = session;
      if (resumed) expect(session).toBe(resumed);
      if (nativeChild) nativeChild.kill("SIGTERM");
      else for (const listener of process.listeners("SIGINT")) if (!originalSignals.includes(listener)) {
        listener("SIGINT"); process.off("SIGINT", listener);
      }
      await running; running = undefined; nativeChild = undefined;
      console.info(JSON.stringify({ backend, stage, marker: "1", inherit: "none",
        resume_kind: stage === "cold-resume-managed" ? "new wrapper OS process" : "new host in test process",
        hook_sources: currentHooks.map(entry => entry.source) }));
    }
  } finally {
    nativeChild?.kill("SIGTERM");
    for (const listener of process.listeners("SIGINT")) if (!originalSignals.includes(listener)) {
      listener("SIGINT"); process.off("SIGINT", listener);
    }
    await running;
    hosts.mockRestore();
    process.argv = argv;
    vi.unstubAllEnvs();
    await wire.close(); provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
