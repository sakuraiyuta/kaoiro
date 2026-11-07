import "../../../scripts/test/fixtures/test-isolation.mjs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { assertMonitorAdvicePosition, monitorNotifications } from "./fixtures/monitor_notifications.js";
import { phoenixLoopback } from "./fixtures/phoenix_loopback.js";

async function jsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? jsonlFiles(join(dir, entry.name))
    : Promise.resolve(entry.isFile() && entry.name.endsWith(".jsonl") ? [join(dir, entry.name)] : [])));
  return nested.flat();
}
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const textParts = (value: any): string[] => typeof value === "string" ? [value]
  : Array.isArray(value) ? value.filter(part => part?.type === "text").map(part => part.text) : [];
const mask = (block: string) => block.replace(/<(task-id|tool-use-id|output-file|summary|event)>([\s\S]*?)<\/\1>/g,
  (_all, tag) => `<${tag}>MASKED</${tag}>`);

// The built CLI constructs the real Host, transport, SDK and bundled CLI.
// Only external provider/Phoenix services are fixtures; native text is never injected.
it.each(["completion-response", "event-inform", "setting-absent", "gate-absent", "bash-idle", "monitor-fold"] as const)(
  "native Monitor advice: %s", async mode => {
    const sdkPath = dirname(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
    const sdk = JSON.parse(await readFile(join(sdkPath, "package.json"), "utf8"));
    expect([sdk.version, sdk.claudeCodeVersion]).toEqual(["0.3.319", "2.1.319"]);
    const advice = monitorNotifications[0]!.advice;
    const root = await mkdtemp(join(tmpdir(), "kaoiro-monitor-advice-native-"));
    const cfg = join(root, ".claude"), cwd = join(root, "project");
    await mkdir(cfg); await mkdir(cwd);
    await writeFile(join(cfg, "settings.json"), JSON.stringify(mode === "setting-absent" ? {} : { agentPushNotifEnabled: true }));
    await writeFile(join(cfg, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, cachedGrowthBookFeatures: {
      tengu_amber_sentinel: true, ...(mode === "gate-absent" ? {} : { tengu_kairos_push_notifications: true }),
    }, cachedGrowthBookFeaturesAt: Date.now() }));
    const persistent = mode === "event-inform" || mode === "monitor-fold";
    let taskIssued = false, ownerIssued = false, sendIssued = false, searched = false, calls = 0, sendCallId = "";
    let taskBarrier: ServerResponse | undefined, ownerBarrier: ServerResponse | undefined;
    const toolResults: unknown[] = [], requests: unknown[] = [];
    const foldedBlocks: string[] = [], rootPromptIds = new Set<string>();
    const provider = createServer(async (request, response) => {
      if (request.url === "/task") { taskBarrier = response; return; }
      if (request.url === "/owner") { ownerBarrier = response; return; }
      let raw = ""; for await (const chunk of request) raw += chunk;
      if (!request.url?.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(request.url?.includes("count_tokens") ? '{"input_tokens":10}' : "{}"); return;
      }
      const payload = JSON.parse(raw); calls++;
      const offered = (name: string) => (payload.tools ?? []).some((tool: any) => tool.name === name);
      const messages = JSON.stringify(payload.messages);
      for (const message of payload.messages ?? []) for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part.type === "tool_result") {
          toolResults.push(part);
          if (mode === "monitor-fold") for (const text of textParts(part.content)) {
            for (const block of text.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? []) {
              if (block.includes("<event>") && !foldedBlocks.includes(block)) foldedBlocks.push(block);
            }
          }
        }
      }
      const address = provider.address(); if (!address || typeof address === "string") throw Error("No provider port");
      const command = (path: string, event: boolean) => {
        const code = `require("http").get("http://127.0.0.1:${address.port}/${path}",r=>{r.resume();r.on("end",()=>{${event ? 'console.log("EVENT-697");' : ""}${event && persistent ? "setTimeout(()=>{},60000);" : ""}})})`;
        return shellQuote(process.execPath) + " -e " + shellQuote(code);
      };
      let use: { name: string; input: Record<string, unknown> } | undefined;
      const source = mode === "bash-idle" ? "Bash" : "Monitor";
      if (!searched && offered("ToolSearch") && (!offered(source) || !offered("mcp__kaoiro__send_to_agent"))) {
        searched = true; use = { name: "ToolSearch", input: { query: "select:Monitor,mcp__kaoiro__send_to_agent" } };
      } else if (!taskIssued && offered(source) && messages.includes("START-697")) {
        taskIssued = true;
        use = { name: source, input: { command: command("task", true), description: "fixture monitor",
          ...(source === "Monitor" ? { persistent, timeout_ms: 60000 } : { run_in_background: true }) } };
      } else if (mode === "monitor-fold" && taskIssued && !ownerIssued && offered("Bash") && messages.includes("OWNER-697")) {
        ownerIssued = true; use = { name: "Bash", input: { command: command("owner", false), description: "fixture live owner", timeout: 20000 } };
      } else if (taskIssued && !sendIssued && offered("mcp__kaoiro__send_to_agent") && messages.includes("<task-notification>")) {
        sendIssued = true;
        sendCallId = `fixture_call_${calls}`;
        use = { name: "mcp__kaoiro__send_to_agent", input: { to: "fixture.peer", kind: mode === "event-inform" ? "inform" : "response",
          ...(mode === "event-inform" ? {} : { conversation_id: "fixture-conversation-697" }), body: "fixture notification report", done: true } };
      }
      requests.push({ call: calls, tool: use?.name ?? "text", offered: (payload.tools ?? []).map((t: any) => t.name), notice: messages.includes("<task-notification>") });
      const emit = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      response.writeHead(200, { "content-type": "text/event-stream" });
      emit("message_start", { type: "message_start", message: { id: `msg_${calls}`, type: "message", role: "assistant", model: payload.model,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      emit("content_block_start", { type: "content_block_start", index: 0, content_block: use
        ? { type: "tool_use", id: `fixture_call_${calls}`, name: use.name, input: {} } : { type: "text", text: "" } });
      emit("content_block_delta", { type: "content_block_delta", index: 0, delta: use
        ? { type: "input_json_delta", partial_json: JSON.stringify(use.input) } : { type: "text_delta", text: "DONE" } });
      emit("content_block_stop", { type: "content_block_stop", index: 0 });
      emit("message_delta", { type: "message_delta", delta: { stop_reason: use ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
      emit("message_stop", { type: "message_stop" }); response.end();
    });
    await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address(); if (!address || typeof address === "string") throw Error("No provider port");
    const wire = await phoenixLoopback(() => ({ inter_agent_reply_basis: "v1", notice_attribution: "v1", permission_sync: true }),
      (event, payload) => event === "envelope" && payload.type === "inter_agent_message" ? { ingress_stamp: [1, 2] } : {});
    const file = join(root, "wrapper.json");
    await writeFile(file, JSON.stringify({ agent_id: "fixture.697", persona: { id: "fixture", name: "Fixture", sprite_set: "fixture" },
      display_name: "Fixture", server_url: wire.url, model: "claude-haiku-4-5-20251001", permission_mode: "default",
      allowed_tools: ["Monitor", "Bash", "mcp__kaoiro__send_to_agent"] }));
    const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    const child = spawn(process.execPath, [cli, file], { cwd, stdio: ["ignore", "pipe", "pipe"], env: {
      PATH: process.env.PATH ?? "", HOME: root, TMPDIR: root, CLAUDE_CONFIG_DIR: cfg, LANG: "C.UTF-8",
      ANTHROPIC_API_KEY: "placeholder", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      // Remote feature payloads override the seeded gates; disable fetching while retaining disk reads.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF: "1",
    } });
    let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    const wait = async (ready: () => boolean | Promise<boolean>) => {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        if (await ready()) return;
        if (child.exitCode !== null || child.signalCode !== null) break;
        await delay(30);
      }
      throw Error(JSON.stringify({ mode, requests, toolResults, output: output.slice(-12000) }));
    };
    const results = () => wire.received.filter(item => item.event === "envelope" && item.payload.type === "result");
    const sends = () => wire.received.filter(item => item.event === "envelope" && item.payload.type === "inter_agent_message");
    let notifications: Array<{ row: any; block: string }> = [];
    const readNotifications = async () => {
      notifications = [];
      for (const path of await jsonlFiles(join(cfg, "projects"))) for (const line of (await readFile(path, "utf8")).split("\n")) {
        let row; try { row = JSON.parse(line); } catch { continue; }
        if (row.type === "user" && JSON.stringify(row.message?.content).includes("START-697") && typeof row.promptId === "string") rootPromptIds.add(row.promptId);
        if (row.type !== "user" || row.promptSource !== "system" || row.turnOrigin !== "task_notification") continue;
        for (const text of textParts(row.message?.content)) for (const block of text.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? []) {
          notifications.push({ row, block });
        }
      }
      return notifications.length > 0;
    };
    try {
      await wait(() => wire.joins === 1);
      wire.push("persona_prompt", { version: "0", prompt: "Native fixture. Follow the scripted task, then report. Do not call PushNotification." });
      await wait(() => wire.received.some(item => item.event === "envelope" && item.payload.type === "state_change"));
      const input = (turn: number, body: string) => wire.push("envelope", { version: "0", agent_id: "fixture.peer", persona: { id: "peer", name: "Peer", sprite_set: "peer" },
        display_name: "Peer", ts: "2026-10-20T00:00:00Z", type: "inter_agent_message", state: "thinking", ingress_stamp: [1, 1],
        payload: { to: "fixture.697", conversation_id: "fixture-conversation-697", turn_number: turn, kind: "request", body,
          owner: { kind: "user", id: "fixture-operator" }, new_conversation: false, meta: { done: false, propose_next: "" } }, ext: {} });
      input(1, "START-697");
      await wait(() => taskBarrier !== undefined && results().length === 1);
      if (mode === "monitor-fold") { input(3, "OWNER-697"); await wait(() => ownerBarrier !== undefined); }
      taskBarrier!.writeHead(200); taskBarrier!.end("release"); taskBarrier = undefined;
      if (mode === "monitor-fold") {
        // Native folds may be carried in a real tool result, without a new user transcript row.
        await wait(() => foldedBlocks.length > 0);
        expect(results()).toHaveLength(1);
        notifications = foldedBlocks.map(block => ({ row: { version: sdk.claudeCodeVersion }, block }));
      } else {
        await wait(readNotifications);
        expect(rootPromptIds.size).toBe(1);
        for (const { row } of notifications) expect(rootPromptIds.has(row.promptId)).toBe(false);
      }
      for (const { row, block } of notifications) {
        expect(row.version).toBe("2.1.306");
        if (mode !== "bash-idle") {
          assertMonitorAdvicePosition(block, advice, mode !== "setting-absent" && mode !== "gate-absent");
          expect(block.includes("<status>")).toBe(!persistent);
        }
      }
      await wait(() => sendIssued && toolResults.some(result => (result as { tool_use_id?: string }).tool_use_id === sendCallId));
      const refusal = process.env.KAOIRO_TEST_MONITOR_EXPECT_REFUSAL === "1";
      if (refusal) {
        expect(toolResults.some(result => JSON.stringify(result).includes("unbound_tool_call"))).toBe(true);
        expect(output).toContain("native continuation refused: native_notification_malformed");
        expect(sends()).toHaveLength(0);
      } else {
        expect(sends()).toHaveLength(1);
        expect(JSON.stringify(toolResults)).not.toContain("unbound_tool_call");
        const sent = sends()[0]!.payload.payload as Record<string, unknown>;
        expect(sent.kind).toBe(mode === "event-inform" ? "inform" : "response");
        if (mode === "event-inform") expect(sent.conversation_id).not.toBe("fixture-conversation-697");
        else { expect(sent.conversation_id).toBe("fixture-conversation-697"); expect(sent.in_reply_to).toBe(mode === "monitor-fold" ? 3 : 1); }
        await wait(() => results().length === 2);
      }
      const starts = output.split("\n").filter(line => line.includes('"event":"turn_start"'));
      // This CLI's delivery lifecycle records wrapper inputs; native notification roots are excluded.
      expect(starts).toHaveLength(mode === "monitor-fold" ? 2 : 1);
      expect(output).not.toContain("restart required");
      console.log(JSON.stringify({ native_monitor_advice: { mode, sdk: sdk.version, cli: sdk.claudeCodeVersion, settingSources: "omitted", refusal,
        sends: sends().length, wrapper_starts: starts.length, native_evidence: mode === "monitor-fold" ? "provider-tool-result" : "user-system-transcript",
        notices: notifications.map(({ row, block }) => ({ version: row.version,
          skeleton: mask(block), sha256: createHash("sha256").update(block).digest("hex") })),
        warnings: output.split("\n").filter(line => line.includes("Warning:") || line.includes("Unhandled")) } }));
    } finally {
      taskBarrier?.end("cleanup"); ownerBarrier?.end("cleanup");
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const fallback = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 5000);
      fallback.unref(); await closed; clearTimeout(fallback);
      await wire.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 90000,
);
