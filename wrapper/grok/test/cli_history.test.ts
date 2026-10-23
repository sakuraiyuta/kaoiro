import "../../../scripts/test/fixtures/test-isolation.mjs";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runGrokCli } from "../src/cli.js";
import { GrokHost } from "../src/host.js";
import { groupName } from "../src/history.js";
import { phoenixLoopback } from "./fixtures/phoenix_loopback.js";

const SESSION = "fixture-session";
const T0 = 1_760_000_000;
const scratch: string[] = [];
const previous = process.env.GROK_HOME;

async function stage<T>(name: string, action: () => T | Promise<T>, timeoutMs = 12_000): Promise<T> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  console.info(`[cli_history] ${name}: started`);
  try {
    const value = await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    console.info(`[cli_history] ${name}: completed (${Date.now() - started} ms)`);
    return value;
  } catch (error) {
    console.error(`[cli_history] ${name}: failed (${Date.now() - started} ms)`);
    throw new Error(`cli_history: ${name} failed`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

async function withCleanup(action: () => Promise<void>, cleanup: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      console.error("[cli_history] cleanup also failed", cleanupError);
    }
    throw error;
  }
  await cleanup();
}

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
  if (previous === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = previous;
});
const record = (update: Record<string, unknown>, offset: number) =>
  JSON.stringify({ method: "session/update", params: { sessionId: SESSION, update }, timestamp: T0 + offset });
const transcript = [
  record({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "remember this" }, _meta: { promptIndex: 0 } }, 0),
  record({ sessionUpdate: "tool_call", toolCallId: "call-1", title: "probe", rawInput: { value: 7 } }, 1),
  record({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed",
    content: [{ type: "content", content: { type: "text", text: "tool output" } }] }, 2),
  record({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "all " } }, 3),
  record({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } }, 4),
].join("\n") + "\n";

/** A joined wrapper whose server asks for a replay (or not) and a Grok home
 *  that may hold the resumed session's transcript. */
async function run(options: { resume: boolean; replay: boolean; history?: string; historyId?: string; legacy?: boolean }) {
  const home = mkdtempSync(join(tmpdir(), "kaoiro-grok-cli-history-"));
  const cwd = mkdtempSync(join(homedir(), ".kaoiro-grok-history-"));
  scratch.push(home, cwd);
  process.env.GROK_HOME = home;
  if (options.history !== undefined) {
    const dir = join(home, "sessions", groupName(cwd), options.historyId ?? SESSION);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "updates.jsonl"), options.history);
  }
  const server = await phoenixLoopback(() => options.legacy ? {} : ({
    hydration: options.replay ? { replay_required: true, replay_id: "replay-1" } : { replay_required: false },
  }));
  let host: GrokHost | undefined;
  const work = runGrokCli({
    platform: "darwin", cwd,
    parseCliArgs: () => ({ configPath: "fixture", ...(options.resume ? { resume: SESSION } : {}) }),
    loadConfig: () => ({ agent_id: "composition.history", display_name: "Grok", server_url: server.url,
      sandbox: "danger-full-access", network_access: true,
      persona: { id: "default", name: "Default", sprite_set: "default" } }),
    loadWrapperBuildInfo: () => ({ revision: "unknown", dirty: false, built_at: "unknown", version: "unknown", channel: "dev" }),
    createHost: (hostOptions) => new GrokHost({ ...hostOptions,
      executable: fileURLToPath(new URL("./fixtures/grok.mjs", import.meta.url)) }),
    onHostCreated: (value) => { host = value; },
  });
  void work.catch(() => {});
  await vi.waitFor(() => expect(server.joins).toBe(1));
  server.push("persona_prompt", { prompt: "Fixture" });
  await vi.waitFor(() => expect(host?.state).toBe("waiting_input"), { timeout: 10_000 });
  return {
    server,
    finish: async () => {
      await withCleanup(async () => {
        await stage("host.close", async () => { host?.close(); await host?.closed; }, 5_000);
        await stage("work", () => work, 5_000);
      }, () => stage("server.close", () => server.close(), 5_000));
    },
    sequence: () => server.received.map((x) => x.event).filter((e) =>
      ["history_reset", "history_replay_complete"].includes(e) || e === "envelope"),
  };
}

it("replays a resumed session's transcript between the reset and the completion", async () => {
  const t = await run({ resume: true, replay: true, history: transcript });
  await withCleanup(async () => {
    await stage("history_replay_complete", () => vi.waitFor(() =>
      expect(t.server.received.some((x) => x.event === "history_replay_complete")).toBe(true), { timeout: 10_000 }));
    const events = t.server.received.map((x) => x);
    const reset = events.findIndex((x) => x.event === "history_reset");
    const complete = events.findIndex((x) => x.event === "history_replay_complete");
    expect(events[reset]!.payload).toMatchObject({ replay_id: "replay-1" });
    expect(events[complete]!.payload).toMatchObject({ replay_id: "replay-1" });
    const logs = events.slice(reset + 1, complete).filter((x) => x.event === "envelope" && x.payload.type === "log");
    expect(logs.map((x) => x.payload.payload)).toEqual([
      { kind: "user", text: "remember this" },
      { kind: "tool_use", tool_name: "probe", tool_use_id: "call-1", input: { value: 7 } },
      { kind: "tool_result", output: "tool output", tool_use_id: "call-1", tool_name: "probe" },
      { kind: "assistant", text: "all done" },
    ]);
    expect(logs.map((x) => x.payload.ts)).toEqual([0, 1, 2, 3].map((i) => new Date((T0 + i) * 1000).toISOString()));
    expect(logs.every((x) => x.payload.session_id === SESSION)).toBe(true);
    // The state the server needs to attach the replay to goes out before it.
    expect(events.slice(0, reset).some((x) => x.event === "envelope" && x.payload.type === "state_change")).toBe(true);
  }, t.finish);
}, 20_000);

it("still sends the reset and the completion when the resumed session has no file", async () => {
  const t = await run({ resume: true, replay: true });
  await withCleanup(async () => {
    await stage("history_replay_complete", () => vi.waitFor(() =>
      expect(t.server.received.some((x) => x.event === "history_replay_complete")).toBe(true), { timeout: 10_000 }));
    const events = t.server.received;
    const reset = events.findIndex((x) => x.event === "history_reset");
    const complete = events.findIndex((x) => x.event === "history_replay_complete");
    expect(reset).toBeGreaterThan(-1);
    expect(events.slice(reset + 1, complete).filter((x) => x.event === "envelope" && x.payload.type === "log")).toEqual([]);
  }, t.finish);
}, 20_000);

it("replays a resumed session for a legacy server that sends no verdict", async () => {
  const t = await run({ resume: true, replay: false, legacy: true, history: transcript });
  await withCleanup(async () => {
    await stage("history_replay_complete", () => vi.waitFor(() =>
      expect(t.server.received.some((x) => x.event === "history_replay_complete")).toBe(true), { timeout: 10_000 }));
    const events = t.server.received;
    const reset = events.findIndex((x) => x.event === "history_reset");
    const complete = events.findIndex((x) => x.event === "history_replay_complete");
    expect(events.slice(reset + 1, complete).filter((x) => x.event === "envelope" && x.payload.type === "log")).toHaveLength(4);
  }, t.finish);
}, 20_000);

it("replays nothing when the server does not ask", async () => {
  const t = await run({ resume: true, replay: false, history: transcript });
  await withCleanup(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(t.server.received.some((x) => x.event === "history_reset")).toBe(false);
    expect(t.server.received.some((x) => x.event === "history_replay_complete")).toBe(false);
  }, t.finish);
}, 20_000);

it("answers a replay request on a fresh session with an empty replay, whatever other sessions hold", async () => {
  const t = await run({ resume: false, replay: true, history: transcript, historyId: "an-older-session" });
  await withCleanup(async () => {
    await stage("history_replay_complete", () => vi.waitFor(() =>
      expect(t.server.received.some((x) => x.event === "history_replay_complete")).toBe(true), { timeout: 10_000 }));
    const events = t.server.received;
    const reset = events.findIndex((x) => x.event === "history_reset");
    const complete = events.findIndex((x) => x.event === "history_replay_complete");
    expect(events.slice(reset + 1, complete).filter((x) => x.event === "envelope" && x.payload.type === "log")).toEqual([]);
  }, t.finish);
}, 20_000);
