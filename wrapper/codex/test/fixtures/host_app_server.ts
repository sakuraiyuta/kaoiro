import "../../../../scripts/test/fixtures/test-isolation.mjs";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { expect, vi } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { CodexHost, type CodexHostOptions } from "../../src/host.js";
import { AppServerSession } from "../../src/app_server_session.js";
import type { RpcObject } from "../../src/app_server_rpc.js";

export const appServerHostConfig: WrapperConfig = { agent_id: "host-app", persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P",
  server_url: "ws://unused", model: "gpt-5.6-sol", effort: "high", codex_auth_mode: "chatgpt", codex_chatgpt_plan: "plus" };

export function appServerHostFixture(overrides: Partial<CodexHostOptions> = {}, launch = appServerHostConfig, omitBackend = false,
  options: { autoRun?: boolean; threadId?: string; onTurnStart?: (request: RpcObject, number: number) => void } = {}) {
  const threadId = options.threadId ?? "thread";
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough(), stderr = new PassThrough(), sent: RpcObject[] = [];
  let number = 0, active = 0, maxActive = 0;
  let holdConfig: Promise<void> | null = null, holdHistory: Promise<void> | null = null;
  let invalidHistory = false;
  let interrupted = true, autocomplete = false;
  let startReply: "immediate" | "silent" | "held" | "held-terminal" | "error" | "exit" = "immediate", heldReply: (() => void) | null = null;
  const send = (value: unknown) => stdout.write(JSON.stringify(value) + "\n");
  const reply = (request: RpcObject, result: unknown) => send({ id: request.id, result });
  const terminal = (status = "completed") => {
    active -= 1;send({ method: "turn/completed", params: { threadId, turn: { id: `turn-${number}`, status } } });
  };
  const stdin = new Writable({ write(chunk, _encoding, cb) {
    const request = JSON.parse(String(chunk)) as RpcObject;sent.push(request);
    if (request.method === "initialize") reply(request, { userAgent: "test/0.153.4" });
    if (request.method === "thread/start" || request.method === "thread/resume") reply(request, { thread: { id: threadId }, model: "gpt-5.6-sol", reasoningEffort: "medium" });
    if (request.method === "account/rateLimits/read") send({ id: request.id, error: { code: -32600, message: "no account" } });
    if (request.method === "config/read") void (holdConfig ?? Promise.resolve()).then(() => reply(request, { config: { model_reasoning_effort: "low" } }));
    if (request.method === "thread/read") void (holdHistory ?? Promise.resolve()).then(() => reply(request, invalidHistory ? {} : {
      thread: { id: threadId, turns: [{ id: "past", items: [{ id: "answer", type: "agentMessage", text: "PAST" }] }] },
    }));
    if (request.method === "turn/start" && startReply === "error") send({ id: request.id, error: { code: -32600, message: "rejected" } });
    else if (request.method === "turn/start" && startReply === "exit") exit();
    else if (request.method === "turn/start") {
      number += 1;options.onTurnStart?.(request, number);active += 1;maxActive = Math.max(active, maxActive);
      const respond = () => reply(request, { turn: { id: `turn-${number}` } });
      const started = () => send({ method: "turn/started", params: { threadId, turn: { id: `turn-${number}` } } });
      if (startReply === "silent") respond();
      else if (startReply === "immediate") { respond();started(); }
      else { started();if (startReply === "held-terminal") terminal();heldReply = respond; }
      if (autocomplete && number > 1) queueMicrotask(() => terminal());
    }
    if (request.method === "turn/interrupt") { reply(request, {});if (interrupted) terminal("interrupted"); }
    cb();
  } });
  Object.assign(child, { stdin, stdout, stderr, exitCode: null, signalCode: null });
  const exit = () => {
    if (child.exitCode !== null) return;
    Object.assign(child, { exitCode: 0 });child.emit("exit", 0, null);stdout.end();stderr.end();queueMicrotask(() => child.emit("close", 0, null));
  };
  stdin.on("finish", exit);child.kill = vi.fn(() => { exit();return true; });
  const states: Envelope[] = [], logs: Envelope[] = [], tasks: Envelope[] = [];
  const starts = vi.fn(), ends = vi.fn(), finals = vi.fn(), boundaries = vi.fn();
  const createSession = vi.fn(options => AppServerSession.create({ ...options, transport: { spawnChild: () => child, shutdownTimeoutMs: 100 } }));
  const host = new CodexHost(launch, { appServerSessionFactory: createSession,
    appendSystemPrompt: "PERSONA", onState: e => states.push(e), onLog: e => logs.push(e), onTask: e => tasks.push(e),
    onTurnStart: starts, onTurnEnd: ends, onTurnFinalized: finals, onTurnBoundary: boundaries, ...overrides });
  const running = options.autoRun === false ? Promise.resolve() : host.run();
  const close = async () => { host.close();await running; };
  const turns = () => sent.filter(r => r.method === "turn/start");
  const until = (count: number) => vi.waitFor(() => expect(turns()).toHaveLength(count));
  return { close, host, sent, states, logs, tasks, starts, ends, finals, boundaries, createSession, send, terminal, exit, running, turns, until,
    set startReply(value: typeof startReply) { startReply = value; },
    releaseReply() { const release = heldReply;heldReply = null;release?.(); },
    set holdHistory(value: Promise<void>) { holdHistory = value; }, set invalidHistory(value: boolean) { invalidHistory = value; },
    get maxActive() { return maxActive; }, set autocomplete(value: boolean) { autocomplete = value; }, set holdConfig(value: Promise<void>) { holdConfig = value; }, set interrupted(value: boolean) { interrupted = value; } };
}
