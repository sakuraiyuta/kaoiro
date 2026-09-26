import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.FUJI401_ROOT;
const repo = process.env.FUJI401_REPO;
if (!root || !repo) throw new Error("missing fixture paths");
const fixture = join(root, "claude-fixture.mjs");
writeFileSync(fixture, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
writeFileSync(process.env.FUJI401_CHILD_PID_FILE, String(process.pid));
setInterval(() => {}, 1000);
`);
chmodSync(fixture, 0o755);
const { runClaudeCli } = await import(pathToFileURL(join(repo, "wrapper/claude-code/dist/cli.js")));
const { AgentHost } = await import(pathToFileURL(join(repo, "wrapper/claude-code/dist/host.js")));
const config = { agent_id: "fuji401.measure", persona: { id: "test", name: "Test", sprite_set: "test" },
  display_name: "Test", server_url: "ws://unused" };
const run = runClaudeCli({
  parseCliArgs: () => ({ configPath: "fixture", prompt: "first instruction", resume: undefined }),
  loadConfig: () => config,
  createServerLink: (_url, _agentId, options) => {
    queueMicrotask(() => {
      options.onPersonaPrompt?.("system prompt");
      options.onInterAgentDeliveryStatus?.({ issued_seq: 0, acked_seq: 0 });
    });
    return { close: () => {}, currentSessionId: () => null, setSessionId: () => {}, send: () => {},
      reportSessionLifecycle: () => {}, acknowledgeInterAgentDelivery: () => {},
      flushInterAgentRetirements: async () => {}, reportDisconnectIntent: async () => {} };
  },
  createHost: (cfg, options) => new AgentHost(cfg, { ...options,
    queryOptions: { ...options.queryOptions, pathToClaudeCodeExecutable: fixture } }),
});
run.catch(error => { writeFileSync(join(root, "wrapper-error.txt"), String(error));process.exitCode = 1; });
