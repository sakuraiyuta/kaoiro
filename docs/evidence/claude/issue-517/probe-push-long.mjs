// Throwaway probe (issue 517): push a mid-turn user message into an SDK
// session while a Bash tool runs, with priority "now" (kaoiro's yield "cut")
// or without (kaoiro's "fold"), against a loopback Messages API.
import { createServer } from "node:http";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [sdkDir, mode, sleepS, pushMs, kind] = process.argv.slice(2); const originKind = undefined;
const { query } = await import(join(sdkDir, "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"));
const pkg = (await import(join(sdkDir, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"), { with: { type: "json" } })).default;
const root = mkdtempSync(join(tmpdir(), "kohaku517-push-"));
const marker = join(root, "slept");
const t0 = Date.now();
const at = () => String(Date.now() - t0).padStart(6);
const log = (...a) => console.log(`[${at()}]`, ...a);
const INJECT = "INJECT-517";
let reqNo = 0;
let toolSent = false;

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (!req.url.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.url.includes("count_tokens") ? '{"input_tokens":10}' : "{}");
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const n = ++reqNo;
    const msgs = body.messages ?? [];
    const last = msgs.at(-1);
    const blocks = typeof last?.content === "string" ? [{ type: "text", text: last.content }] : (last?.content ?? []);
    const summary = blocks.map((b) => b.type === "tool_result"
      ? `tool_result(${JSON.stringify(typeof b.content === "string" ? b.content : b.content?.map?.((c) => c.text ?? c.type).join("|")).slice(0, 140)})`
      : b.type === "text" ? `text(${JSON.stringify(b.text).slice(0, 160)})` : b.type);
    const hasInject = JSON.stringify(msgs).includes(INJECT);
    const firstPrompt = !toolSent && !JSON.stringify(msgs).includes("tool_result");
    log(`REQ#${n} msgs=${msgs.length} injectInHistory=${hasInject} last=${summary.join(" + ")}`);
    const tool = firstPrompt;
    if (tool) toolSent = true;
    const block = tool
      ? { type: "tool_use", id: `toolu_517_${n}`, name: "Bash", input: {} }
      : { type: "text", text: "" };
    const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    emit("message_start", { type: "message_start", message: { id: `msg_517_${n}`, type: "message", role: "assistant", model: "claude-sonnet-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    emit("content_block_start", { type: "content_block_start", index: 0, content_block: block });
    if (tool) emit("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: `sleep ${sleepS}; echo done > ${marker}; echo SLEPT_OK`, description: "probe sleep" }) } });
    else emit("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `reply-${n}` } });
    emit("content_block_stop", { type: "content_block_stop", index: 0 });
    emit("message_delta", { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
    emit("message_stop", { type: "message_stop" });
    res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));

let release;
const done = new Promise((r) => { release = r; });
let toolSeen;
const toolStarted = new Promise((r) => { toolSeen = r; });
async function* prompt() {
  yield { type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: "Run the probe command." } };
  await toolStarted;
  await new Promise((r) => setTimeout(r, Number(pushMs)));
  const msg = { type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: `${INJECT}: please acknowledge` } };
  if (mode === "cut") msg.priority = "now";
  if (originKind) msg.origin = { kind: originKind };
  log(`PUSH mode=${mode} (sleep marker exists=${existsSync(marker)})`);
  yield msg;
  await done;
}

log(`sdk ${pkg.version} node ${process.versions.node} mode ${mode}`);
const q = query({
  prompt: prompt(),
  options: {
    model: "sonnet",
    cwd: root,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    env: { ...process.env, ANTHROPIC_API_KEY: "kogane517-placeholder", ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, CLAUDE_CONFIG_DIR: join(root, "config"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
  },
});
let results = 0;
const stopAt = setTimeout(() => { log("STOP (deadline)"); release(); }, 60000);
for await (const m of q) {
  if (m.type === "assistant") {
    const b = m.message.content.map((c) => c.type === "tool_use" ? `tool_use:${c.name}` : c.type === "text" ? `text:${c.text}` : c.type).join(",");
    log(`assistant ${b}`);
    if (b.includes("tool_use")) toolSeen();
  } else if (m.type === "user") {
    const c = m.message.content;
    const s = typeof c === "string" ? `text:${c.slice(0, 80)}` : c.map((x) => x.type === "tool_result" ? `tool_result:${JSON.stringify(x.content).slice(0, 160)}` : x.type === "text" ? `text:${x.text.slice(0, 120)}` : x.type).join(",");
    log(`user ${s}${m.tool_use_result !== undefined ? ` tool_use_result=${JSON.stringify(m.tool_use_result).slice(0, 160)}` : ""}${m.isSynthetic ? " synthetic" : ""}${m.priority ? ` priority=${m.priority}` : ""}`);
  } else if (m.type === "result") {
    results++;
    log(`result#${results} subtype=${m.subtype} result=${JSON.stringify(m.result ?? "").slice(0, 60)} num_turns=${m.num_turns}`);
    if (results >= 2 && existsSync(marker)) { setTimeout(release, 1500); }
  } else if (m.type === "system") {
    log(`system ${m.subtype}${m.subtype === "init" ? "" : " " + JSON.stringify(m).slice(0, 200)}`);
  } else {
    log(`${m.type} ${JSON.stringify(m).slice(0, 160)}`);
  }
}
clearTimeout(stopAt);
log(`END results=${results} sleep_completed=${existsSync(marker)} requests=${reqNo}`);
server.close();
process.exit(0);
