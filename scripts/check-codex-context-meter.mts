import assert from "node:assert/strict";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

// Credentialed gate: the wire is local, while CLI, host, session, native process
// and account stay real. Observers forward the original calls and bytes.
const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? join(root, "tmp/context-meter-live"));
mkdirSync(output, { recursive: true });
const native: any[] = [];
const children: Array<{ pid: number; closed: Promise<void>; exited: boolean }> = [];
const spawn = cp.spawn;
cp.spawn = function (...args: Parameters<typeof cp.spawn>) {
  const child = Reflect.apply(spawn, this, args);
  if (Array.isArray(args[1]) && args[1].includes("app-server")) {
    assert(typeof child.pid === "number");
    const held = { pid: child.pid, closed: new Promise<void>(resolve => child.once("close", () => resolve())), exited: false };
    child.once("exit", () => { held.exited = true; });children.push(held);
    const iterate = child.stdout![Symbol.asyncIterator].bind(child.stdout);
    child.stdout![Symbol.asyncIterator] = async function* () {
      const decoder = new StringDecoder("utf8");let buffered = "";
      for await (const chunk of iterate()) {
        buffered += decoder.write(chunk);let end: number;
        while ((end = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, end);buffered = buffered.slice(end + 1);
          const message = JSON.parse(line);
          if (["thread/tokenUsage/updated", "item/started", "item/completed", "turn/completed"].includes(message.method)) native.push(message);
        }
        yield chunk;
      }
    };
  }
  return child;
} as typeof cp.spawn;
syncBuiltinESMExports();
const { resolveAppServerBinary, AppServerRpc } = await import("../wrapper/codex/dist/app_server_rpc.js");
const { CodexHost } = await import("../wrapper/codex/dist/host.js");
const { runCodexCli } = await import("../wrapper/codex/dist/cli.js");
const { phoenixLoopback } = await import("../wrapper/codex/test/fixtures/phoenix_loopback.js");
let host: InstanceType<typeof CodexHost> | undefined, rpc: InstanceType<typeof AppServerRpc> | undefined, threadId: string | undefined;
const run = CodexHost.prototype.run;
CodexHost.prototype.run = function (...args) { host = this;return Reflect.apply(run, this, args); };
const request = AppServerRpc.prototype.request;
AppServerRpc.prototype.request = function (method, params, ...args) {
  const ticket = Reflect.apply(request, this, [method, params, ...args]);
  if (method === "thread/start") {
    rpc = this;void ticket.result.then(result => { threadId = (result as any).thread.id; });
  }
  return ticket;
};
const binary = resolveAppServerBinary();
assert.equal(cp.execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(), "codex-cli 0.159.3");
assert.equal(cp.spawnSync(binary, ["login", "status"], { encoding: "utf8" }).status, 0, "credentialed account required");
const wire = await phoenixLoopback(() => ({ permission_sync: false }));
const config = { agent_id: `fuji485-gate-${randomUUID()}`, persona: { id: "fuji", name: "Fuji", sprite_set: "fuji" }, display_name: "Fuji context gate",
  server_url: wire.url, codex_backend: "app-server", cwd: output, model: "gpt-6.1-sol", effort: "low", sandbox: "read-only", network_access: false, codex_internal_subagents: false, codex_auth_mode: "chatgpt" };
const file = join(output, "config.json");writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
process.argv = [process.execPath, join(root, "wrapper/codex/dist/cli.js"), file];
const running = runCodexCli();let failure: unknown;void running.catch(error => { failure = error; });
const states = () => wire.received.filter(e => e.event === "envelope" && e.payload.type === "state_change").map(e => e.payload as any);
async function until(predicate: () => boolean, label: string, ms = 180000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (failure) throw failure;
    assert(Date.now() < deadline, `timeout: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
async function deadline<T>(operation: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); }
  finally { clearTimeout(timer!); }
}
try {
  await until(() => wire.joins === 1, "join", 10000);
  wire.push("persona_prompt", { prompt: "This is an isolated context-meter verification. Do not use tools or subagents. Respond in plain text." });
  await until(() => host?.state === "waiting_input" || host?.state === "idle", "ready", 20000);
  await host!.send("Reply with CONTEXT_GATE_OK only. Do not use tools.", undefined, undefined, undefined, { source: "operator" });
  await until(() => native.some(e => e.method === "turn/completed") && host!.state === "waiting_input", "successful ordinary turn");
  assert.equal(native.find(e => e.method === "turn/completed").params.turn.status, "completed");
  const usage = native.filter(e => e.method === "thread/tokenUsage/updated").at(-1).params.tokenUsage;
  await until(() => states().at(-1)?.state === "waiting_input", "outward completed state", 5000);
  const known = states().at(-1);
  assert.equal(known.ext.session_capabilities.supports_context_usage, true);
  assert(known.ext.context, "missing outward context after successful real response");
  assert.deepEqual(known.ext.context, { used_tokens: usage.last.totalTokens, max_tokens: usage.modelContextWindow,
    used_percentage: 100 * (usage.last.totalTokens / usage.modelContextWindow) });
  const before = states().length;
  await deadline(rpc!.request("thread/compact/start", { threadId }).result, 20000, "compaction request timeout");
  await until(() => native.some(e => e.method === "item/started" && e.params.item?.type === "contextCompaction"), "native boundary");
  await until(() => states().slice(before).some(e => e.ext?.context === undefined), "outward boundary withdrawal", 5000);
  const unknown = states().slice(before).find(e => e.ext?.context === undefined);
  assert.equal(unknown.ext.session_capabilities.supports_context_usage, true);
  await until(() => native.some(e => e.method === "item/completed" && e.params.item?.type === "contextCompaction"), "compaction completion");
  assert(states().slice(before).every(e => e.ext?.context === undefined), "boundary estimates must not restore context");
  writeFileSync(join(output, "result.json"), JSON.stringify({ known: known.ext.context, boundary_unknown: true, capability: true,
    binary_sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"), default_cli_host_session: true }, null, 2) + "\n");
  console.log("PASS default composition: native snapshot published; compaction withdrawn");
} finally {
  host?.close();
  try { await deadline(running, 15000, "CLI close timeout"); }
  finally {
    await wire.close();
    for (const child of children) {
      try { await deadline(child.closed, 5000, "native close timeout"); }
      catch (error) {
        if (!child.exited) process.kill(child.pid, "SIGTERM");
        await deadline(child.closed, 5000, "native SIGTERM close timeout");throw error;
      }
    }
    writeFileSync(join(output, "native.json"), JSON.stringify(native, null, 2) + "\n", { mode: 0o600 });
    writeFileSync(join(output, "cleanup.json"), JSON.stringify({ held_pids: children.map(c => c.pid), exited: children.every(c => c.exited) }) + "\n");
  }
}
