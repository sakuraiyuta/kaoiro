// Throwaway (issue 517): compare projected initializationResult().commands with
// live system/init slash_commands, and record the model spelling an opus[1m]
// pick reports from init and getContextUsage(). Loopback Messages API, an
// isolated config dir (skills/plugins linked, plugins enabled, no hooks).
import { createServer } from "node:http";
import { mkdtempSync, symlinkSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
const [sdkDir] = process.argv.slice(2);
const { query } = await import(join(sdkDir, "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"));
const project = (c) => { if (!c || typeof c.name !== "string" || !c.name) return null; const p = Array.isArray(c.aliases) ? c.aliases.find((a) => typeof a === "string" && a.includes(":")) : undefined; return p ?? c.name; };
const cfg = mkdtempSync(join(tmpdir(), "kogane517-cfg-")); const cwd = mkdtempSync(join(tmpdir(), "kogane517-cwd-"));
symlinkSync(join(homedir(), ".claude/skills"), join(cfg, "skills"));
symlinkSync(join(homedir(), ".claude/plugins"), join(cfg, "plugins"));
const user = JSON.parse(readFileSync(join(homedir(), ".claude/settings.json"), "utf8"));
writeFileSync(join(cfg, "settings.json"), JSON.stringify({ enabledPlugins: user.enabledPlugins ?? {} }));
const server = createServer((req, res) => { let b = ""; req.on("data", (c) => b += c); req.on("end", () => {
  if (!req.url.startsWith("/v1/messages") || req.url.includes("count_tokens")) { res.writeHead(200, { "content-type": "application/json" }); res.end(req.url.includes("count_tokens") ? '{"input_tokens":10}' : "{}"); return; }
  const emit = (e, d) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
  res.writeHead(200, { "content-type": "text/event-stream" });
  emit("message_start", { type: "message_start", message: { id: "msg_517c", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  emit("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  emit("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } });
  emit("content_block_stop", { type: "content_block_stop", index: 0 });
  emit("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
  emit("message_stop", { type: "message_stop" }); res.end(); }); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
let release; const done = new Promise((r) => { release = r; }); let go; const ready = new Promise((r) => { go = r; });
async function* prompt() { await ready; yield { type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: "hello" } }; await done; }
const q = query({ prompt: prompt(), options: { cwd, model: "opus[1m]", env: { ...process.env, ANTHROPIC_API_KEY: "kogane517-placeholder", ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } } });
const out = { sdk: JSON.parse(readFileSync(join(sdkDir, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8")).version };
const init = await q.initializationResult();
const projected = (init.commands ?? []).map(project).filter((x) => x !== null);
go();
const deadline = setTimeout(() => release(), 20000);
for await (const m of q) {
  if (m.type === "system" && m.subtype === "init") {
    const live = m.slash_commands ?? [];
    out.init_model = m.model; out.projected_count = projected.length; out.live_count = live.length;
    out.equal_in_order = JSON.stringify(projected) === JSON.stringify(live);
    out.colon_alias_rows = (init.commands ?? []).filter((c) => Array.isArray(c.aliases) && c.aliases.some((a) => typeof a === "string" && a.includes(":"))).length;
    out.first_diff = projected.findIndex((x, i) => x !== live[i]);
    try { const ctx = await q.getContextUsage(); out.context_usage_model = ctx?.model ?? ctx?.response?.model ?? Object.keys(ctx ?? {}).join(","); } catch (e) { out.context_usage_error = String(e).slice(0, 120); }
  }
  if (m.type === "result") { clearTimeout(deadline); release(); }
}
console.log(JSON.stringify(out));
server.close(); rmSync(cfg, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true });
process.exit(0);
