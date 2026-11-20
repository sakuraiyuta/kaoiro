import "../../../scripts/test/fixtures/test-isolation.mjs";
// Admission fail-stops abort the CLI (issue #1188). Real AgentHost, real SDK
// query() and its bundled CLI; only the Anthropic API is a loopback fixture.
// "/clear" makes the CLI switch sessions under a live wrapper turn, which the
// host stops at the result. EXIT_CEILING_MS turns a hang red; it is not a
// latency claim (measured exits were under 2.4 s, and bounded_spawn tries
// SIGKILL 4 s after the abort).
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { query, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type { WrapperConfig } from "@kaoiro/agent-common";
import { requirePositiveSafePid } from "@kaoiro/wrapper-core";
import { describe, expect, it } from "vitest";
import { AgentHost } from "../src/host.js";

const EXIT_CEILING_MS = 6_000;
const CLEANUP_CEILING_MS = 130_000;
const TEST_CEILING_MS = 240_000;
const BACKGROUND_LIFETIME_S = 120;
const FAIL_STOP = "notification result ownership ambiguous";

/** The process's start time (field 22 of /proc/<pid>/stat), or undefined when
 * it is gone or a zombie. Comparing it guards against a reused PID. */
const procStart = (pid: number): string | undefined => {
  try {
    const stat = readFileSync(`/proc/${requirePositiveSafePid(pid)}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] === "Z" ? undefined : fields[19];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};
const readPid = (path: string): number | undefined => {
  try { return requirePositiveSafePid(Number(readFileSync(path, "utf8").trim())); } catch { return undefined; }
};
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const until = async (ready: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (ready()) return true; await delay(25); }
  return ready();
};

async function fixture(background: boolean) {
  const root = mkdtempSync(join(tmpdir(), "claude-fail-stop-abort-native-"));
  const cfg = join(root, ".claude"), cwd = join(root, "project"), marks = join(root, "marks");
  for (const dir of [cfg, cwd, marks]) mkdirSync(dir);
  writeFileSync(join(cfg, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
  const requests: Array<{ resumed: boolean; stopped: boolean }> = [];
  let launched = false;
  let backgroundRequestedAt: number | undefined;
  const provider = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    if (!request.url?.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(request.url?.includes("count_tokens") ? '{"input_tokens":10}' : "{}"); return;
    }
    const payload = JSON.parse(raw);
    const messages = JSON.stringify(payload.messages ?? []);
    requests.push({ resumed: messages.includes("RESUMED-1188"), stopped: messages.includes("<status>stopped</status>") });
    const bash = background && !launched && messages.includes("START-1188");
    if (bash) {
      launched = true;
      backgroundRequestedAt = Date.now();
    }
    const block = bash
      ? { type: "tool_use", id: "fixture_bg", name: "Bash", input: {} }
      : { type: "text", text: "" };
    const delta = bash
      ? { type: "input_json_delta", partial_json: JSON.stringify({ run_in_background: true, description: "bg sleep",
        command: `sleep ${BACKGROUND_LIFETIME_S} & echo $! > ${shellQuote(join(marks, "sleep.pid"))}; echo $$ > ${shellQuote(join(marks, "shell.pid"))}; wait` }) }
      : { type: "text_delta", text: "TURN-DONE" };
    const emit = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    response.writeHead(200, { "content-type": "text/event-stream" });
    emit("message_start", { type: "message_start", message: { id: `msg_${requests.length}`, type: "message", role: "assistant",
      model: payload.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    emit("content_block_start", { type: "content_block_start", index: 0, content_block: block });
    emit("content_block_delta", { type: "content_block_delta", index: 0, delta });
    emit("content_block_stop", { type: "content_block_stop", index: 0 });
    emit("message_delta", { type: "message_delta", delta: { stop_reason: bash ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 } });
    emit("message_stop", { type: "message_stop" }); response.end();
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("missing loopback address");
  const env = { PATH: process.env.PATH ?? "", HOME: root, TMPDIR: root, CLAUDE_CONFIG_DIR: cfg, LANG: "C.UTF-8",
    ANTHROPIC_API_KEY: "placeholder", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  const config: WrapperConfig = { agent_id: "test.native", persona: { id: "p", name: "P", sprite_set: "p" },
    display_name: "P", server_url: "ws://unused", model: "claude-haiku-4-5-20251001", permission_mode: "default" };
  const clis: Array<{ child: ChildProcess; exit?: { code: number | null; signal: string | null } }> = [];
  const sessions: string[] = [];
  const start = (prompt: string, resume?: string) => {
    const states: string[] = [], warnings: string[] = [];
    let turnEnds = 0, outcome: "resolved" | "rejected" | undefined;
    const host = new AgentHost(config, {
      onState: e => states.push(e.state),
      warn: message => warnings.push(message),
      onTurnEnd: () => { turnEnds++; },
      decidePermission: () => ({ allow: true }),
      queryFn: args => {
        const real = query(args);
        return new Proxy(real, { get(target, key) {
          if (key === Symbol.asyncIterator) return async function* () {
            for await (const message of target) {
              if (message.type === "system" && message.subtype === "init") sessions.push(message.session_id);
              yield message;
            }
          };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        } });
      },
      queryOptions: { cwd, env, allowedTools: ["Bash"], ...(resume === undefined ? {} : { resume }),
        spawnClaudeCodeProcess: (o: SpawnOptions) => {
          const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, signal: o.signal, stdio: ["pipe", "pipe", "pipe"] });
          const entry: (typeof clis)[number] = { child };
          child.once("exit", (code, signal) => { entry.exit = { code, signal }; });
          clis.push(entry);
          return child as never;
        } },
    });
    const running = host.run(prompt).then(() => { outcome = "resolved"; }, () => { outcome = "rejected"; });
    return { host, states, warnings, running, turnEnds: () => turnEnds, outcome: () => outcome };
  };
  const recorded = new Map<string, { pid: number; start: string }>();
  const backgroundStarted = () => ["shell", "sleep"].every(name => {
    if (recorded.has(name)) return true;
    const pid = readPid(join(marks, `${name}.pid`));
    const start = pid === undefined ? undefined : procStart(pid);
    if (pid === undefined || start === undefined) return false;
    recorded.set(name, { pid, start });
    return true;
  });
  const backgroundRunning = () => [...recorded.values()].some(({ pid, start }) => procStart(pid) === start);
  const cleanup = async () => {
    const deadline = Date.now() + CLEANUP_CEILING_MS;
    try {
      for (const { child } of clis) {
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      const exited = await until(
        () => clis.every(({ child }) => child.exitCode !== null || child.signalCode !== null),
        Math.max(0, deadline - Date.now()),
      );
      if (!exited) throw new Error("CLI cleanup timed out");
      if (backgroundRequestedAt !== undefined) {
        const stopped = await until(
          () => backgroundStarted() && !backgroundRunning(),
          Math.max(0, deadline - Date.now()),
        );
        if (!stopped) throw new Error("background cleanup timed out");
      }
    } finally {
      provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  };
  return { start, clis, sessions, requests, backgroundStarted, backgroundRunning,
    backgroundRequestedAt: () => backgroundRequestedAt, cleanup };
}

/** Runs one turn (optionally leaving a background Bash), then fails admission
 * with "/clear" and waits for the CLI to exit. */
async function failStop(f: Awaited<ReturnType<typeof fixture>>, background: boolean) {
  const run = f.start("START-1188");
  expect(await until(() => run.turnEnds() >= 1 && (!background || f.backgroundStarted()), 30_000)).toBe(true);
  void run.host.send("/clear").catch(() => {});
  expect(await until(() => run.states.includes("error"), 15_000)).toBe(true);
  const failedAt = Date.now();
  if (background) {
    expect(f.backgroundRequestedAt()).toBeDefined();
    expect(failedAt - f.backgroundRequestedAt()!).toBeLessThanOrEqual(45_000);
  }
  expect(run.warnings.some(line => line.includes(FAIL_STOP))).toBe(true);
  const cli = f.clis[0]!;
  const exited = await until(() => cli.exit !== undefined && run.outcome() !== undefined
    && (!background || !f.backgroundRunning()), EXIT_CEILING_MS);
  console.log(JSON.stringify({ decision: { exited, cliExit: cli.exit ?? null,
    elapsedMs: Date.now() - failedAt } }));
  return { run, cli, exited, elapsedMs: Date.now() - failedAt };
}

describe.skipIf(process.platform !== "linux")("admission fail-stop aborts the CLI (issue #1188)", () => {
  it("ends the CLI and resolves the host when no background task runs", async () => {
    const f = await fixture(false);
    try {
      const { run, cli, exited, elapsedMs } = await failStop(f, false);
      console.log(JSON.stringify({ n0: { exit: cli.exit, elapsedMs } }));
      expect(exited).toBe(true);
      expect(run.outcome()).toBe("resolved");
    } finally { await f.cleanup(); }
  }, TEST_CEILING_MS);

  it("ends the CLI and its background Bash, which would otherwise keep it alive", async () => {
    const f = await fixture(true);
    try {
      const { run, cli, exited, elapsedMs } = await failStop(f, true);
      console.log(JSON.stringify({ n1: { exit: cli.exit, elapsedMs } }));
      expect(exited).toBe(true);
      expect(run.outcome()).toBe("resolved");
    } finally { await f.cleanup(); }
  }, TEST_CEILING_MS);

  it("reports the stopped Bash to the model when the aborted session is resumed", async () => {
    const f = await fixture(true);
    try {
      expect((await failStop(f, true)).exited).toBe(true);
      const resumed = f.start("RESUMED-1188", f.sessions[0]);
      expect(await until(() => resumed.turnEnds() >= 1, 30_000)).toBe(true);
      expect(f.requests.find(r => r.resumed)).toEqual({ resumed: true, stopped: true });
      expect(resumed.states).not.toContain("error");
      await resumed.host.close(); await resumed.running;
    } finally { await f.cleanup(); }
  }, TEST_CEILING_MS);
});
