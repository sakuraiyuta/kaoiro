import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { ServerLink } from "@kaoiro/wrapper-core";
import { CodexHost, type CodexHostOptions } from "../../src/host.js";
import { AppServerSession } from "../../src/app_server_session.js";
import { runCodexCli } from "../../src/cli.js";
import type { RpcObject } from "../../src/app_server_rpc.js";
import { phoenixLoopback } from "./phoenix_loopback.js";

export function watchdogClock() {
  let now = 0, next = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    nowMs: () => now,
    setTimer(callback: () => void, delay: number) { const id = ++next;timers.set(id, { at: now + delay, callback });return id; },
    clearTimer(id: unknown) { timers.delete(id as number); },
    get size() { return timers.size; },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const entry = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        now = entry[1].at;timers.delete(entry[0]);entry[1].callback();
      }
      now = end;
    },
  };
}

// Only the external app-server child and time are simulated. CLI callbacks,
// Host/Session, Unix ToolHost, ServerLink, brokers, IA and reset coordinator run.
export async function cliAppFixture(permissionSync = false, backend: "exec" | "app-server" = "app-server", replyBasis: "v1" | "legacy" = "legacy") {
  const home = await mkdtemp(join(tmpdir(), "fuji-348-cli-fixture-")), agentId = `fixture-${randomUUID()}`;
  const clock = watchdogClock(), sent: RpcObject[] = [];
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough(), stderr = new PassThrough();
  let turn = 0, socketPath = "", spawned = 0;
  let releaseExec!: () => void;
  const execTerminal = new Promise<void>(resolve => { releaseExec = resolve; });
  const send = (value: unknown) => stdout.write(JSON.stringify(value) + "\n");
  const reply = (request: RpcObject, result: unknown) => send({ id: request.id, result });
  const terminal = (status = "completed", id = `turn-${turn}`) => send({ method: "turn/completed", params: { threadId: "thread", turn: { id, status } } });
  const stdin = new Writable({ write(chunk, _encoding, cb) {
    const request = JSON.parse(String(chunk)) as RpcObject;sent.push(request);
    if (request.method === "initialize") reply(request, { userAgent: "fixture/0.153.4" });
    if (request.method === "thread/start") {
      socketPath = ((request.params as any).config.mcp_servers.kaoiro.env.KAOIRO_BRIDGE_SOCKET as string);
      reply(request, { thread: { id: "thread" }, model: "gpt-5.6-sol", reasoningEffort: "medium" });
    }
    if (request.method === "account/rateLimits/read") send({ id: request.id, error: { code: -32600, message: "no account" } });
    if (request.method === "config/read") reply(request, { config: { model_reasoning_effort: "medium" } });
    if (request.method === "turn/start") {
      turn += 1;reply(request, { turn: { id: `turn-${turn}` } });
      send({ method: "turn/started", params: { threadId: "thread", turn: { id: `turn-${turn}` } } });
    }
    // Receipt is deliberately separate from terminal: an ACK is not completion.
    if (request.method === "turn/interrupt") reply(request, {});
    cb();
  } });
  Object.assign(child, { stdin, stdout, stderr, exitCode: null, signalCode: null });
  const exit = () => { if (child.exitCode !== null) return;Object.assign(child, { exitCode: 0 });child.emit("exit", 0, null);stdout.end();stderr.end();queueMicrotask(() => child.emit("close", 0, null)); };
  stdin.on("finish", exit);child.kill = () => { exit();return true; };
  let rejection: Record<string, unknown> | undefined;
  const wire = await phoenixLoopback(() => ({ ...(replyBasis === "v1" ? { inter_agent_reply_basis: "v1" } : {}), permission_sync: permissionSync, delivery_resync: "skip-v1", delivery: { issued_seq: 0, acked_seq: 0, pending_since: null } }), (event, payload) =>
    event === "delivery_resync" ? { request_id: payload.request_id, skipped_ranges: payload.missing_ranges, delivery: { issued_seq: payload.cutoff, acked_seq: 1, pending_since: new Date().toISOString() } } :
    event === "session_reset_request" ? { request_id: "reset" } : { ingress_stamp: [1, 1] }, (event, payload) => {
      if (event !== "envelope" || payload.type !== "inter_agent_message") return undefined;
      const next = rejection; rejection = undefined; return next;
    });
  const signals = process.listeners("SIGINT");
  vi.stubEnv("HOME", home);vi.stubEnv("CODEX_HOME", home);
  vi.stubEnv("KAOIRO_CODEX_TURN_WATCHDOG_INACTIVITY_MS", "60000");
  vi.stubEnv("KAOIRO_CODEX_TURN_WATCHDOG_ABORT_GRACE_MS", "1000");
  let host!: CodexHost;
  let link!: ServerLink, session: AppServerSession | undefined;
  let permissionWaits = 0;
  let nextInbound: { enter: () => void; pending: Promise<void> } | undefined;
  const received: number[] = [], finalized: string[] = [], queued: string[] = [];
  let callbacks!: CodexHostOptions;
  const running = runCodexCli({ backend, watchdogClock: clock,
    parseCliArgs: () => ({ configPath: "fixture", prompt: undefined, resume: undefined }),
    loadConfig: () => ({ agent_id: agentId, persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P", server_url: wire.url, model: "gpt-5.6-sol" }),
    createServerLink: (url, id, options) => (link = new ServerLink(url, id, { ...options,
      onInterAgentMessage: async envelope => {
        const held = nextInbound;nextInbound = undefined;
        if (held) { held.enter();await held.pending; }
        await options.onInterAgentMessage?.(envelope);
        received.push((envelope as typeof envelope & { delivery_seq: number }).delivery_seq);
      },
    })),
    createHost: (config, options) => { callbacks = options;host = new CodexHost(config, { ...options,
      startupRateLimitResolver: async () => new Map(),
      waitForPermissionSync: () => { permissionWaits += 1;return options.waitForPermissionSync!(); },
      onTurnFinalized: info => { options.onTurnFinalized?.(info);finalized.push(info.turnToken); },
      codexFactory: () => { spawned += 1;const thread = { runStreamed: async () => { sent.push({ method: "turn/start" });return { events: (async function* () {
        yield { type: "thread.started" as const, thread_id: "thread" };await execTerminal;
        yield { type: "turn.completed" as const, usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, cache_write_input_tokens: 0 } };
      })() }; } };return { startThread: () => thread, resumeThread: () => thread }; },
      appServerSessionFactory: async options => (session = await AppServerSession.create({ ...options, transport: { spawnChild: () => { spawned += 1;return child; }, shutdownTimeoutMs: 20 } })),
    });
      const send = host.send.bind(host);
      host.send = async (...args) => { await send(...args);queued.push(args[0]); };
      return host;
    },
  });
  await vi.waitFor(() => expect(wire.joins).toBe(1));wire.push("persona_prompt", { prompt: "Fixture" });
  await vi.waitFor(() => expect(host).toBeDefined());
  const envelopes = (type: string) => wire.received.filter(e => e.event === "envelope" && e.payload.type === type).map(e => e.payload);
  return {
    rejectNextSend: (error: Record<string, unknown>) => { rejection = error; },
    clock, wire, host, callbacks, sent, send, terminal, exit, running, envelopes, releaseExec, finalized, queued,
    get spawned() { return spawned; }, get permissionWaits() { return permissionWaits; }, get rateLimits() { return session?.rateLimits; },
    // After the application callback finishes, a round trip drains earlier
    // writes on this same WebSocket; JSONL child writes cannot do that.
    drain: () => link.requestDirectory(),
    holdNextInbound() {
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const pending = new Promise<void>(resolve => { release = resolve; });
      nextInbound = { enter, pending };
      return { entered, release };
    },
    turns: () => sent.filter(r => r.method === "turn/start"), interrupts: () => sent.filter(r => r.method === "turn/interrupt"),
    acks: () => wire.received.filter(e => e.event === "delivery_ack").map(e => e.payload.delivery_seq),
    waitForAcks: (seqs: number[]) => vi.waitFor(() => expect(wire.received.filter(e => e.event === "delivery_ack").map(e => e.payload.delivery_seq)).toEqual(seqs)),
    async inbound(seq: number, cid: string, body = cid, peer = "peer.agent", number = 1) {
      wire.push("envelope", { version: "0", agent_id: peer, persona: { id: "p", name: "Peer", sprite_set: "p" }, display_name: "Peer",
        ts: new Date().toISOString(), type: "inter_agent_message", state: "tool_running", delivery_seq: seq, ingress_stamp: [1, seq],
        payload: { to: agentId, conversation_id: cid, turn_number: number, kind: "inform", body } });
      await vi.waitFor(() => expect(received).toContain(seq));
    },
    tool(name: string, input: Record<string, unknown> = {}): Promise<any> {
      return new Promise((resolve, reject) => {
        const socket = createConnection(socketPath);let buffer = "";
        socket.setEncoding("utf8");socket.setTimeout(2000, () => socket.destroy(new Error("Fixture tool timeout")));
        socket.on("error", reject);socket.on("data", data => { buffer += data;if (buffer.includes("\n")) { socket.end();resolve(JSON.parse(buffer.split("\n")[0]!)); } });
        socket.on("connect", () => socket.write(JSON.stringify({ id: 1, method: "call_tool", name, input, metadata: { "x-codex-turn-metadata": { thread_id: "thread", turn_id: `turn-${turn}` } } }) + "\n"));
      });
    },
    async close() {
      host.close();releaseExec();await running;await wire.close();
      for (const listener of process.listeners("SIGINT")) if (!signals.includes(listener)) process.removeListener("SIGINT", listener);
      vi.unstubAllEnvs();await rm(home, { recursive: true, force: true });
    },
  };
}
