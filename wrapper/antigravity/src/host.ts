import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  effectiveStatusEnvelopeFields,
  initialMachineState,
  logEntryToPayload,
  makeLog,
  makeResult,
  makeStateChange,
  stepState,
  type EngineAdapter,
  type Envelope,
  type KaoiroState,
  type LogEntry,
  type MachineState,
  type ModelSource,
  type PendingPermissionExt,
  type PendingQuestionExt,
  type PermissionBroker,
  type PermissionMode,
  type ToolDescriptor,
  type WrapperConfig,
} from "@kaoiro/agent-common";
import {
  agyEventToErrorDetail,
  agyEventToEvents,
  agyEventToLogs,
  agyEventToResult,
  agyEventToSessionId,
  parseAgyStreamLine,
  type AgyStreamEvent,
} from "./adapter.js";
import { antigravityCatalogSnapshot } from "./catalog.js";
import { CustomizationDir, GATE_DEADLINE_MS, sweepStaleCustomizationDirs } from "./customization.js";
import { AntigravityGate, GateServer, type AntigravityLaunchConfig } from "./gate.js";
import { effectiveNetworkAccess } from "./network_access.js";
import { ToolHost } from "./toolhost.js";

const BRIDGE_SCRIPT = new URL("../dist/bridge.js", import.meta.url).pathname;
const HOOK_SCRIPT = new URL("../dist/hook.js", import.meta.url).pathname;

export interface SpawnedAgy {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  stdin: NodeJS.WritableStream;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface AntigravityHostOptions {
  cwd: string;
  appendSystemPrompt: string;
  onState: (envelope: Envelope) => void;
  onLog?: (envelope: Envelope) => void;
  onSessionId?: (sessionId: string) => void;
  toolDescriptors?: ToolDescriptor[];
  permissionBroker: PermissionBroker;
  modelSource?: ModelSource;
  resumeSessionId?: string;
  dangerouslySkipPermissions?: boolean;
  nodePath?: string;
  agyPath?: string;
  spawn?: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => SpawnedAgy;
  verifyGate?: (args: string[]) => Promise<boolean>;
  runtimeAssetsAvailable?: () => boolean;
  warn?: (message: string) => void;
}

function digestFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readableLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      onLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (buffer !== "") onLine(buffer);
  });
}

export function isGateRegistered(value: unknown, expectedSource: string): boolean {
  const sources: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const record = node as Record<string, unknown>;
    if (typeof record.source === "string") sources.push(record.source);
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return sources.filter((source) => source === expectedSource).length === 1;
}

export function initialStatusExt(config: AntigravityLaunchConfig): Record<string, unknown> {
  const sandbox = config.sandbox ?? "workspace-write";
  const approval = config.approval ?? "on-request";
  return {
    engine: "antigravity",
    models: antigravityCatalogSnapshot(),
    permission: { sandbox, approval, enforcement: "advisory" },
    effective: {
      ...(config.model === undefined ? {} : { model: config.model }),
      ...(config.model_source === undefined ? {} : { model_source: config.model_source }),
      ...(config.effort === undefined ? {} : { effort: config.effort }),
      ...(config.effort_source === undefined ? {} : { effort_source: config.effort_source }),
      sandbox,
      network_access: effectiveNetworkAccess(sandbox, config.network_access ?? false),
    },
    session_capabilities: {
      supports_attachments: false,
      supports_user_input_dialog: true,
      supports_model_switch: true,
      supports_effort_switch: false,
      supports_context_usage: false,
    },
  };
}

export class AntigravityHost implements EngineAdapter {
  readonly #config: AntigravityLaunchConfig;
  readonly #options: AntigravityHostOptions;
  readonly #now: () => string;
  #machine: MachineState = initialMachineState();
  #closed = false;
  #running: SpawnedAgy | null = null;
  #sessionId: string | null;
  #turnQueue: string[] = [];
  #customization: CustomizationDir | null = null;
  #pendingPermission: PendingPermissionExt | null = null;
  #pendingQuestion: PendingQuestionExt | null = null;
  #lastRevision = 0;
  #gateBroken = false;
  readonly #toolNames = new Map<string, string>();

  constructor(config: WrapperConfig, options: AntigravityHostOptions) {
    this.#config = config as AntigravityLaunchConfig;
    if (this.#config.approval === "on-failure") {
      throw new Error("antigravity approval=on-failure is unsupported");
    }
    this.#options = options;
    this.#sessionId = options.resumeSessionId ?? null;
    this.#now = () => new Date().toISOString();
    sweepStaleCustomizationDirs();
  }

  get state(): KaoiroState {
    return this.#machine.state;
  }

  async run(prompt?: string): Promise<void> {
    if (prompt !== undefined) await this.send(prompt);
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (this.#closed) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });
  }

  async send(text: string, attachmentIds?: string[]): Promise<void> {
    if (this.#closed || this.#gateBroken) return;
    if (attachmentIds !== undefined && attachmentIds.length > 0) {
      this.#warn("antigravity: attachments are unsupported");
      return;
    }
    this.#apply({ kind: "user_send" });
    this.#turnQueue.push(text);
    void this.#drainTurns();
  }

  async interrupt(): Promise<void> {
    this.#turnQueue = [];
    this.#options.permissionBroker.close();
    this.#running?.kill("SIGTERM");
  }

  close(): void {
    this.#closed = true;
    this.#turnQueue = [];
    this.#options.permissionBroker.close();
    this.#running?.kill("SIGTERM");
    this.#customization?.close();
    this.#customization = null;
  }

  async setModel(value: string): Promise<void> {
    if (value === "") {
      delete this.#config.model;
    } else {
      this.#config.model = value;
    }
    this.#emitState(this.#machine.state);
  }

  async setEffort(_level: string): Promise<void> {
    throw new Error("antigravity effort switching is unavailable in Stage A");
  }

  async setPermissionMode(_mode: PermissionMode): Promise<void> {
    throw new Error("antigravity permission axes are fixed at spawn in Stage A");
  }

  setPendingPermission(pending: PendingPermissionExt | null): void {
    this.#pendingPermission = pending;
    this.#emitState(this.#machine.state);
  }

  setPendingQuestion(pending: PendingQuestionExt | null): void {
    this.#pendingQuestion = pending;
    this.#emitState(this.#machine.state);
  }

  renameDisplayName(displayName: string, revision: number): void {
    if (revision <= this.#lastRevision) return;
    this.#lastRevision = revision;
    this.#config.display_name = displayName;
    this.#emitState(this.#machine.state);
  }

  statusSnapshot(): Record<string, unknown> {
    return this.#statusExt();
  }

  async #drainTurns(): Promise<void> {
    if (this.#running !== null || this.#closed || this.#gateBroken) return;
    const text = this.#turnQueue.shift();
    if (text === undefined) return;
    try {
      await this.#runTurn(text);
    } catch (error) {
      this.#terminalError(error instanceof Error ? error.message : String(error));
    } finally {
      this.#running = null;
      void this.#drainTurns();
    }
  }

  async #runTurn(text: string): Promise<void> {
    this.#customization ??= CustomizationDir.create({
      cwd: this.#options.cwd,
      personaPrompt: this.#options.appendSystemPrompt,
      nodePath: this.#options.nodePath ?? process.execPath,
      hookPath: HOOK_SCRIPT,
      bridgePath: BRIDGE_SCRIPT,
    });
    this.#customization.rewrite();
    if (!(this.#options.runtimeAssetsAvailable?.() ?? (existsSync(HOOK_SCRIPT) && existsSync(BRIDGE_SCRIPT)))) {
      throw new Error("antigravity runtime assets are not built");
    }
    const toolHost = await ToolHost.listen(this.#options.toolDescriptors ?? []);
    const gate = new AntigravityGate({
      config: this.#config,
      cwd: this.#options.cwd,
      customizationDir: this.#customization.path,
      nodePath: this.#options.nodePath ?? process.execPath,
      bridgePath: BRIDGE_SCRIPT,
      toolNames: () => toolHost.toolNames(),
      broker: this.#options.permissionBroker,
      onPermissionRequest: () => this.#apply({ kind: "permission_request" }),
      onPermissionResolved: () => this.#apply({ kind: "permission_resolved" }),
      ...(this.#options.warn === undefined ? {} : { warn: this.#options.warn }),
    });
    const gateServer = await GateServer.listen({
      gate,
      onSocketClose: () => this.#options.permissionBroker.close(),
    });
    try {
      if (!(await this.#verifyGateRegistration())) {
        throw new Error("antigravity_gate_not_registered");
      }
      const args = this.#turnArguments(text, this.#customization.path);
      const child = (this.#options.spawn ?? this.#defaultSpawn)(this.#options.agyPath ?? "agy", args, {
        cwd: this.#options.cwd,
        env: {
          ...process.env,
          KAOIRO_GATE_SOCKET: gateServer.socketPath,
          KAOIRO_GATE_NONCE: gateServer.nonce,
          KAOIRO_GATE_DEADLINE_MS: String(GATE_DEADLINE_MS),
          KAOIRO_BRIDGE_SOCKET: toolHost.socketPath,
          KAOIRO_BRIDGE_NONCE: toolHost.nonce,
        },
      });
      this.#running = child;
      child.stdin.end();
      let resultSeen = false;
      let correlationFailure = false;
      readableLines(child.stdout, (line) => {
        const event = parseAgyStreamLine(line);
        if (event === null) {
          this.#warn(`antigravity: ignored malformed stream line from ${basename(this.#options.agyPath ?? "agy")}`);
          return;
        }
        this.#handleEvent(event, gate);
        if (event.event === "result") resultSeen = true;
        if (event.event === "step_update" && event.step_update.step_type === "tool" && (event.step_update.state === "DONE" || event.step_update.state === "ERROR") && typeof event.step_update.step_index === "number" && typeof event.step_update.tool_name === "string" && !gate.observeCompletedTool(event.step_update.step_index, event.step_update.tool_name)) {
          correlationFailure = true;
          child.kill("SIGTERM");
        }
      });
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      if (correlationFailure) {
        this.#gateBroken = true;
        this.#terminalError("antigravity_gate_unobserved_tool");
      } else if (!resultSeen) {
        this.#terminalError("agy_exit_without_result");
      }
    } finally {
      gateServer.close();
      toolHost.close();
    }
  }

  #handleEvent(event: AgyStreamEvent, gate: AntigravityGate): void {
    if (event.event === "init") {
      gate.inspectToolInventory(Array.isArray(event.init.tools) ? event.init.tools : []);
      const sessionId = agyEventToSessionId(event);
      if (sessionId !== null) {
        this.#sessionId = sessionId;
        this.#options.onSessionId?.(sessionId);
      }
    }
    for (const log of agyEventToLogs(event)) this.#emitLog(log);
    for (const adapterEvent of agyEventToEvents(event)) this.#apply(adapterEvent);
    const result = agyEventToResult(event);
    if (result !== null) this.#options.onLog?.(makeResult(this.#config, this.#now(), result));
  }

  #turnArguments(text: string, customizationDir: string): string[] {
    const args = ["--print", text, "--output-format", "stream-json", "--print-timeout", "24h", "--disable-slash-commands"];
    if (this.#options.dangerouslySkipPermissions ?? true) args.push("--dangerously-skip-permissions");
    if (this.#sessionId !== null) args.push("--conversation", this.#sessionId);
    if (this.#config.model !== undefined && this.#config.model !== "") args.push("--model", this.#config.model);
    if (this.#config.effort !== undefined) args.push("--effort", this.#config.effort);
    args.push("--add-dir", this.#options.cwd, "--add-dir", customizationDir);
    return args;
  }

  async #verifyGateRegistration(): Promise<boolean> {
    const args = ["-p", "/hooks", "--add-dir", this.#options.cwd, "--add-dir", this.#customization!.path, "--output-format", "json"];
    if (this.#options.verifyGate !== undefined) return this.#options.verifyGate(args);
    return new Promise<boolean>((resolveProbe) => {
      const child = spawn(this.#options.agyPath ?? "agy", args, { cwd: this.#options.cwd, stdio: ["ignore", "pipe", "ignore"] });
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { output += chunk; });
      child.once("exit", (code) => {
        if (code !== 0) { resolveProbe(false); return; }
        try {
          resolveProbe(isGateRegistered(JSON.parse(output) as unknown, HOOK_SCRIPT));
        } catch { resolveProbe(false); }
      });
    });
  }

  #apply(event: Parameters<typeof stepState>[1]): void {
    const { next, emitted } = stepState(this.#machine, event);
    this.#machine = next;
    for (const state of emitted) this.#emitState(state);
  }

  #emitState(state: KaoiroState): void {
    this.#options.onState(makeStateChange(this.#config, state, this.#now(), {}, this.#statusExt()));
  }

  #emitLog(entry: LogEntry): void {
    if (entry.kind === "tool_use" && entry.tool_use_id !== undefined) {
      this.#toolNames.set(entry.tool_use_id, entry.tool_name);
    }
    this.#options.onLog?.(
      makeLog(
        this.#config,
        this.#machine.state,
        this.#now(),
        logEntryToPayload(entry, this.#toolNames),
      ),
    );
  }

  #terminalError(error: string): void {
    this.#apply({ kind: "result", subtype: "error_during_execution" });
    this.#options.onLog?.(makeResult(this.#config, this.#now(), { is_error: true, error_subtype: "error_during_execution", error_detail: error }));
  }

  #statusExt(): Record<string, unknown> {
    const ext = initialStatusExt(this.#config);
    if (this.#pendingPermission !== null) ext.pending_permission = this.#pendingPermission;
    if (this.#pendingQuestion !== null) ext.pending_question = this.#pendingQuestion;
    ext.cwd = this.#options.cwd;
    return ext;
  }

  #warn(message: string): void {
    (this.#options.warn ?? ((line) => process.stderr.write(`${line}\n`)))(message);
  }

  #defaultSpawn(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): SpawnedAgy {
    return spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
  }
}
