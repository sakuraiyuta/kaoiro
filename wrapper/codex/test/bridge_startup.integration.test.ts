import "../../../scripts/test/fixtures/test-isolation.mjs";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDescriptor } from "@kaoiro/agent-common";
import { expect, it, vi } from "vitest";
import { AppServerSession } from "../src/app_server_session.js";
import { AppServerTransport, type AppServerThreadOptions } from "../src/app_server_transport.js";
import { CodexHost } from "../src/host.js";

// The child, SDK, bridge, socket, and handler are real. Only the bridge's entry
// point is delayed; required/startup policy comes from production composition.
// Analytics/plugins are disabled in the isolated home (plugin clones can race
// cleanup); CLI update traffic remains possible on offline runners.
it.each([
  ["app-server", false], ["exec", false], ["app-server", true], ["exec", true],
] as const)("%s waits for the bridge and fails closed on startup timeout=%s", async (engine, timeout) => {
  const home = await mkdtemp(join(tmpdir(), "fuji-348-bridge-startup-"));
  const requests: Array<{ input: Array<Record<string, unknown>> }> = [];
  let toolCalls = 0;
  const provider = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    const n = requests.length;
    const output = n % 2 === 1 ? [{
      type: "custom_tool_call", id: `fc_${n}`, call_id: `call_${n}`, name: "exec", status: "completed",
      input: 'const result = await tools.mcp__kaoiro__probe({}); text(result);',
    }] : [{
      type: "message", id: `msg_${n}`, role: "assistant", status: "completed", phase: "final_answer",
      content: [{ type: "output_text", text: "DONE", annotations: [] }],
    }];
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id: `r${n}`, object: "response", status: "in_progress", output: [] } },
      ...output.flatMap((item, output_index) => [
        { type: "response.output_item.added", output_index, item: { ...item, status: "in_progress" } },
        { type: "response.output_item.done", output_index, item },
      ]),
      { type: "response.completed", response: { id: `r${n}`, object: "response", status: "completed", output,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("No local provider port");
  let session: AppServerSession | undefined, host: CodexHost | undefined;
  let running: Promise<void> | undefined;
  try {
    await writeFile(join(home, "config.toml"), `model = "gpt-6-astra"
model_provider = "local"
[model_providers.local]
name = "Local bridge startup test"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
[features]
shell_snapshot = false
plugins = false
[analytics]
enabled = false
`);
    const launcher = join(home, "delayed-bridge.mjs");
    await writeFile(launcher, `import { pathToFileURL } from "node:url";
await new Promise(resolve => setTimeout(resolve, 2500));
process.argv.splice(1, 1);
await import(pathToFileURL(process.argv[1]).href);
`);
    vi.stubEnv("HOME", home); vi.stubEnv("CODEX_HOME", home);
    for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID"]) vi.stubEnv(key, undefined);
    const delayBridge = (config: unknown) => {
      const bridge = (config as { mcp_servers: { kaoiro: { args: string[]; startup_timeout_sec: number } } }).mcp_servers.kaoiro;
      bridge.args = [launcher, ...bridge.args];
      // Keep the 30-second production default pinned separately; this real
      // timeout probe must finish before the integration test's outer deadline.
      if (timeout) bridge.startup_timeout_sec = 0.1;
    };
    const tool: ToolDescriptor = { name: "probe", description: "Probe", inputSchema: { type: "object", properties: {} },
      handler: async () => { toolCalls += 1; return { content: [{ type: "text", text: "BRIDGE_READY" }] }; } };
    {
      const start = AppServerTransport.prototype.startThread;
      const resume = AppServerTransport.prototype.resumeThread;
      vi.spyOn(AppServerTransport.prototype, "startThread").mockImplementation(function (this: AppServerTransport, options: AppServerThreadOptions = {}) {
        delayBridge(options.config); return start.call(this, options);
      });
      vi.spyOn(AppServerTransport.prototype, "resumeThread").mockImplementation(function (this: AppServerTransport, id, options: AppServerThreadOptions = {}) {
        delayBridge(options.config); return resume.call(this, id, options);
      });
      let threadId: string | undefined;
      for (let index = 1; index <= (timeout ? 1 : 2); index += 1) {
        session = await AppServerSession.create({ thread: { cwd: home, sandbox: "read-only" },
          tools: [tool], turnSignal: () => new AbortController().signal });
        const opening = threadId === undefined ? session.startThread() : session.resumeThread(threadId);
        if (timeout) {
          await expect(opening).rejects.toThrow(/required MCP servers failed to initialize/);
          await expect(session.startTurn({ threadId: "invalid", hostTurnToken: "blocked", input: "hello" })).rejects.toThrow("closed");
          expect(requests).toHaveLength(0); expect(toolCalls).toBe(0);
        } else {
          threadId = await opening;
          const turn = await session.startProjectedTurn({ threadId, hostTurnToken: `host-${index}`, input: "Call probe" });
          const events = [];
          for await (const event of turn.events) events.push(event);
          expect(toolCalls, JSON.stringify({ events, toolOutputs: requests.at(-1)?.input.filter(item => item.type === "custom_tool_call_output" || item.type === "function_call_output"), stderr: session.stderrTail })).toBe(index);
          expect(events.filter(e => e.kind === "result")).toEqual([
            { kind: "result", status: "completed", payload: { text: "DONE", is_error: false } },
          ]);
          expect(JSON.stringify(requests.at(-1))).toContain("BRIDGE_READY");
        }
        await session.close();
      }
    }
  } finally {
    host?.close(); await running; await session?.close();
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
}, 90_000);
