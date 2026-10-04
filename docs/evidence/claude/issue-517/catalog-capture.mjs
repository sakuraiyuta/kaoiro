// Throwaway (issue 517): init-only SDK query, as wrapper/claude-code/src/probe.ts
// does, printing init.models. argv: sdkDir [model|-] [offline|nonessential]
// Uses the caller's real Claude configuration and credentials against the real
// catalog endpoint; the prompt never yields, so no model request is sent.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const [sdkDir, model, offline] = process.argv.slice(2);
const { query } = await import(join(sdkDir, "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"));
const cwd = mkdtempSync(join(tmpdir(), "kogane517-catalog-"));
async function* never() { await new Promise(() => {}); }
const env = { ...process.env };
if (offline === "offline") Object.assign(env, { HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9", http_proxy: "http://127.0.0.1:9", NO_PROXY: "", no_proxy: "" });
if (offline === "nonessential") env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
const q = query({ prompt: never(), options: { cwd, env, ...(model && model !== "-" ? { model } : {}), mcpServers: {}, tools: [], allowedTools: [], disallowedTools: [], additionalDirectories: [], agents: {} } });
try {
  const init = await q.initializationResult();
  process.stdout.write(JSON.stringify(init.models) + "\n");
} finally {
  try { q.close(); } catch {}
  rmSync(cwd, { recursive: true, force: true });
}
process.exit(0);
