import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { WrapperConfig } from "@kaoiro/agent-common";
import { askGate, type HookDecision } from "../src/hook_client.js";
import { AntigravityHost, type AntigravityHostOptions, type GateProbe, type SpawnedAgy } from "../src/host.js";

/** Scripted stand-in for one `agy acp` process: answers the ACP requests the
 *  host sends and lets a test drive updates, hooks, responses and exit. */
export class FakeAgy extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly args: string[];
  readonly env: NodeJS.ProcessEnv;
  readonly requests: { method: string; params: Record<string, unknown>; id?: number | string }[] = [];
  /** The host's answers to requests this process sent. */
  readonly responses: Record<string, unknown>[] = [];
  /** Answers a request of this method with this JSON-RPC error. */
  readonly failRequest = new Map<string, { code: number; message: string }>();
  readonly signals: NodeJS.Signals[] = [];
  sessionId = "session-1";
  config = new Map<string, string>([["model", "gemini-4-carbon"], ["thought_level", "medium"]]);
  models = ["gemini-4-carbon", "gemini-4-neon", "gemini-3.8-flash"];
  levels = ["low", "medium", "high"];
  /** Set to make `session/set_config_option` for this value fail with -32602. */
  rejectValue: string | undefined;
  /** Delays the answer to a method until the test releases it. */
  hold = new Set<string>();
  /** Echo another ID on resume. */
  resumeEcho: string | undefined;
  /** Keep running after SIGTERM, as a busy child might. */
  survivesTerm = false;
  /** Leave out the session ID from the resume response. */
  echoResume = true;
  /** Hold the write callback of the session/prompt line until released. */
  holdPromptWrite = false;
  /** Hold the write callback of the first line of this method until
   *  released; the request is still answered. */
  holdWrite: string | undefined;
  /** Every chunk written to this process's stdin, in order. */
  readonly written: string[] = [];
  /** Per-call answers to `session/set_config_option`, used in order before
   *  the default: apply, acknowledge without applying, or fail. */
  readonly configScript: ("apply" | "ack" | { code: number; message: string })[] = [];
  /** Skip the eager tools/list after attach. */
  listOnAttach = true;
  /** Answer session/resume with -32603, as for an unknown session. */
  rejectResume = false;
  #promptWrite: ((error?: Error | null) => void) | undefined;
  #held = new Map<string, () => void>();
  #promptId: number | string | undefined;
  #buffer = "";
  #mcp: { url: string; headers: Record<string, string> } | undefined;

  constructor(pid: number, args: string[], env: NodeJS.ProcessEnv) {
    super();
    this.pid = pid;
    this.args = args;
    this.env = env;
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        if (this.exitCode !== null || this.signalCode !== null) {
          callback(new Error("EPIPE"));
          return;
        }
        this.written.push(chunk.toString("utf8"));
        this.#buffer += chunk.toString("utf8");
        let held = false;
        let newline = this.#buffer.indexOf("\n");
        while (newline !== -1) {
          const line = this.#buffer.slice(0, newline);
          this.#buffer = this.#buffer.slice(newline + 1);
          const message = JSON.parse(line) as Record<string, unknown>;
          if (message.method === "session/prompt" && this.holdPromptWrite) held = true;
          if (message.method !== undefined && message.method === this.holdWrite) {
            this.holdWrite = undefined;
            held = true;
          }
          void this.#receive(message);
          newline = this.#buffer.indexOf("\n");
        }
        if (held) this.#promptWrite = callback;
        else callback();
      },
    });
  }

  /** Completes the held write, with an error when given one. */
  releasePromptWrite(error?: Error): void {
    const callback = this.#promptWrite;
    this.#promptWrite = undefined;
    callback?.(error ?? null);
  }

  /** Completes the write held by `holdWrite`. */
  releaseWrite(error?: Error): void {
    this.releasePromptWrite(error);
  }

  get sandboxed(): boolean {
    return this.args.includes("--sandbox");
  }

  get promptOpen(): boolean {
    return this.#promptId !== undefined;
  }

  count(method: string): number {
    return this.requests.filter((request) => request.method === method).length;
  }

  release(method: string): void {
    this.#held.get(method)?.();
    this.#held.delete(method);
  }

  #send(message: Record<string, unknown>): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  #options(): unknown[] {
    return [
      { id: "model", name: "Model", category: "model", type: "select", currentValue: this.config.get("model"), options: this.models.map((value) => ({ value, name: value })) },
      { id: "thought_level", name: "Thinking", category: "thought_level", type: "select", currentValue: this.config.get("thought_level"), options: this.levels.map((value) => ({ value, name: value })) },
    ];
  }

  async #receive(message: Record<string, unknown>): Promise<void> {
    if (message.method === undefined) {
      this.responses.push(message);
      return;
    }
    const method = String(message.method);
    const params = (message.params ?? {}) as Record<string, unknown>;
    this.requests.push({ method, params, ...(message.id === undefined ? {} : { id: message.id as number | string }) });
    if (this.hold.has(method)) await new Promise<void>((resolve) => this.#held.set(method, resolve));
    if (message.id === undefined) {
      if (method === "session/cancel" && this.#promptId !== undefined) this.respond("cancelled");
      return;
    }
    const id = message.id;
    const failure = this.failRequest.get(method);
    if (failure !== undefined) {
      this.#send({ id, error: failure });
      return;
    }
    switch (method) {
      case "initialize":
        this.#send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
        return;
      case "session/new":
      case "session/resume": {
        if (method === "session/resume" && this.rejectResume) {
          this.#send({ id, error: { code: -32603, message: "Internal error" } });
          return;
        }
        const servers = (params.mcpServers ?? []) as { url: string; headers: { name: string; value: string }[] }[];
        const server = servers[0];
        if (server !== undefined) this.#mcp = { url: server.url, headers: Object.fromEntries(server.headers.map((h) => [h.name, h.value])) };
        if (method === "session/resume") this.sessionId = String(params.sessionId);
        const sessionId = method === "session/resume" ? this.resumeEcho ?? this.sessionId : this.sessionId;
        const echo = method === "session/new" || this.echoResume;
        this.#send({ id, result: { ...(echo ? { sessionId } : {}), configOptions: this.#options() } });
        if (this.listOnAttach) void this.listTools();
        return;
      }
      case "session/set_config_option": {
        const configId = String(params.configId);
        const value = String(params.value);
        const scripted = this.configScript.shift();
        if (scripted !== undefined && scripted !== "apply") {
          if (scripted === "ack") this.#send({ id, result: { configOptions: this.#options() } });
          else this.#send({ id, error: scripted });
          return;
        }
        if (value === this.rejectValue || (configId === "model" && !this.models.includes(value)) || (configId === "thought_level" && !this.levels.includes(value))) {
          this.#send({ id, error: { code: -32602, message: "Invalid params" } });
          return;
        }
        this.config.set(configId, value);
        this.#send({ id, result: { configOptions: this.#options() } });
        return;
      }
      case "session/prompt":
        this.#promptId = id as number | string;
        this.emit("prompt", params);
        return;
      default:
        this.#send({ id, error: { code: -32601, message: "Method not found" } });
    }
  }

  /** Answers the open prompt. */
  respond(stopReason: string): void {
    const id = this.#promptId;
    if (id === undefined) return;
    this.#promptId = undefined;
    this.#send({ id, result: { stopReason } });
  }

  /** Answers the open prompt with a JSON-RPC error. */
  fail(code: number, message: string): void {
    const id = this.#promptId;
    if (id === undefined) return;
    this.#promptId = undefined;
    this.#send({ id, error: { code, message } });
  }

  update(update: Record<string, unknown>, sessionId = this.sessionId): void {
    this.#send({ method: "session/update", params: { sessionId, update } });
  }

  toolCall(callId: string, name: string, rawInput: Record<string, unknown>, status = "in_progress"): void {
    this.update({ sessionUpdate: "tool_call", toolCallId: callId, name, title: name, kind: "other", status, rawInput });
  }

  toolDone(callId: string, name: string, rawInput: Record<string, unknown>, status: "completed" | "failed" = "completed"): void {
    this.update({ sessionUpdate: "tool_call_update", toolCallId: callId, name, status, rawInput });
  }

  message(text: string): void {
    this.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  }

  /** One raw line on stdout, newline added. */
  line(text: string): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.stdout.write(`${text}\n`);
  }

  /** The stdin chunks written after the first `skip` ones. */
  writtenAfter(skip: number): string {
    return this.written.slice(skip).join("");
  }

  /** A request of a method the host does not serve. */
  request(id: string, method: string, params: Record<string, unknown> = {}): void {
    this.#send({ id, method, params });
  }

  requestPermission(): void {
    this.#send({ id: "perm-1", method: "session/request_permission", params: { sessionId: this.sessionId, toolCall: { toolCallId: "x" }, options: [] } });
  }

  /** A PreToolUse hook through the production hook client. */
  preToolUse(callId: string, name: string, args: Record<string, unknown>, conversationId = this.sessionId): Promise<HookDecision> {
    return askGate(this.env.KAOIRO_GATE_SOCKET!, this.env.KAOIRO_GATE_NONCE!, {
      hookEventName: "PreToolUse", conversationId, stepIdx: 1, toolCall: { id: callId, name, args },
    }, 2_000);
  }

  stop(fullyIdle: boolean, conversationId = this.sessionId, terminationReason = "NO_TOOL_CALL"): Promise<HookDecision> {
    return askGate(this.env.KAOIRO_GATE_SOCKET!, this.env.KAOIRO_GATE_NONCE!, {
      hookEventName: "Stop", conversationId, terminationReason, fullyIdle, executionNum: 1, continuationActive: false,
    }, 2_000);
  }

  /** The eager `tools/list` `agy` sends after attach (P0). */
  async listTools(): Promise<number> {
    if (this.#mcp === undefined) return 0;
    const response = await fetch(this.#mcp.url, {
      method: "POST",
      headers: { ...this.#mcp.headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }).catch(() => undefined);
    return response?.status ?? 0;
  }

  /** The MCP server entry the host gave at attach. */
  get mcp(): { url: string; headers: Record<string, string> } | undefined {
    return this.#mcp;
  }

  /** A kaoiro `tools/call` over the host's HTTP MCP server. */
  async callTool(name: string, args: Record<string, unknown>, options: { signal?: AbortSignal; headers?: Record<string, string>; mcp?: { url: string; headers: Record<string, string> } } = {}): Promise<{ status: number; body: string }> {
    const mcp = options.mcp ?? this.#mcp!;
    const response = await fetch(mcp.url, {
      method: "POST",
      headers: { ...mcp.headers, ...options.headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return { status: response.status, body: await response.text() };
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }

  ignoreTerm(signal: NodeJS.Signals): boolean {
    return signal === "SIGTERM" && this.survivesTerm;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    return true;
  }
}

/** A `agy -p /hooks` stand-in that lists the given groups. */
export function fakeHookList(groups: unknown[], code = 0): GateProbe {
  const child = new EventEmitter() as EventEmitter & GateProbe & { stdout: PassThrough; stderr: PassThrough };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  queueMicrotask(() => {
    child.stdout.end(JSON.stringify({ command: { name: "hooks", data: { hooks: groups } } }));
    child.stderr.end();
    setTimeout(() => child.emit("close", code, null), 0);
  });
  return child;
}

/** The groups `agy` 1.5.14 lists for the hooks.json files under `--add-dir`. */
export function hookGroups(args: readonly string[]): Record<string, unknown>[] {
  const groups: Record<string, unknown>[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "--add-dir") continue;
    const source = join(args[i + 1]!, ".agents", "hooks.json");
    let hooks: Record<string, any>;
    try {
      hooks = (JSON.parse(readFileSync(source, "utf8")) as { hooks: Record<string, any> }).hooks;
    } catch {
      continue;
    }
    const actions: Record<string, unknown>[] = [];
    for (const entry of hooks.PreToolUse ?? []) {
      for (const hook of entry.hooks ?? []) {
        actions.push({ event: "PreToolUse", matcher: entry.matcher, type: "command", command: hook.command, timeout_seconds: hook.timeout });
      }
    }
    for (const hook of hooks.Stop ?? []) actions.push({ event: "Stop", type: "command", command: hook.command, timeout_seconds: hook.timeout });
    groups.push({ name: "hooks", enabled: true, source, actions });
  }
  return groups;
}

export interface TestHost {
  host: AntigravityHost;
  agys: FakeAgy[];
  /** The latest spawned process. */
  agy(): FakeAgy;
  signals: { pid: number | undefined; destination: string; signal: NodeJS.Signals }[];
  hookLists: string[][];
  /** Extra groups the next `/hooks` lists, beside the managed ones. */
  extraHookGroups: Record<string, unknown>[];
  /** The `/hooks` listing never ends. */
  holdHookList: boolean;
  /** Runs right after each spawn, before the host writes anything. */
  onSpawn: (agy: FakeAgy) => void;
}

/** One place that keeps unit tests from starting or signalling real
 *  processes: every spawn is a FakeAgy, every signal is recorded, and a
 *  SIGKILL or SIGTERM to a FakeAgy's group ends it. */
export function createTestHost(config: WrapperConfig, options: Partial<AntigravityHostOptions> & Pick<AntigravityHostOptions, "onState">): TestHost {
  const test: TestHost = {
    host: undefined as unknown as AntigravityHost,
    agys: [],
    agy: () => test.agys.at(-1)!,
    signals: [],
    hookLists: [],
    extraHookGroups: [],
    holdHookList: false,
    onSpawn: () => {},
  };
  let pid = 4000;
  test.host = new AntigravityHost(config, {
    cwd: process.cwd(),
    appendSystemPrompt: "persona",
    permissionBroker: { decide: async () => ({ allow: true }), close: () => {} } as never,
    agyPath: "/fake/agy",
    nodePath: "/usr/bin/node",
    nodeArgs: [],
    entryPath: "/fake/kaoiro.js",
    probeModels: async () => null,
    spawn: (_command, args, spawnOptions) => {
      const agy = new FakeAgy(++pid, args, spawnOptions.env);
      test.agys.push(agy);
      test.onSpawn(agy);
      return agy as unknown as SpawnedAgy;
    },
    probeSpawn: (_command, args) => {
      test.hookLists.push(args);
      if (test.holdHookList) {
        const held = new EventEmitter() as EventEmitter & GateProbe & { stdout: PassThrough };
        held.stdout = new PassThrough();
        return held;
      }
      return fakeHookList([...hookGroups(args), ...test.extraHookGroups]);
    },
    signalTarget: (target, destination, signal) => {
      const agy = target as unknown as FakeAgy;
      test.signals.push({ pid: agy.pid, destination, signal });
      if (agy instanceof FakeAgy && (signal === "SIGKILL" || signal === "SIGTERM") && !agy.ignoreTerm(signal)) {
        queueMicrotask(() => agy.exit(null, signal));
      }
      return true;
    },
    ...options,
  });
  return test;
}

export type { SpawnedAgy };
