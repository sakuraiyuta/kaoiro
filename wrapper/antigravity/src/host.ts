import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
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
  type PendingPermissionExt,
  type PendingQuestionExt,
  type PermissionBroker,
  type PermissionMode,
  type QuestionBroker,
  type ToolDescriptor,
  type WrapperConfig,
} from "@kaoiro/agent-common";
import type { EngineModelInfo } from "@kaoiro/protocol";
import {
  agyEventToEvents,
  agyEventToLogs,
  agyEventToResult,
  agyEventToSessionId,
  parseAgyStreamLine,
  type AgyStreamEvent,
} from "./adapter.js";
import { antigravityCatalogSnapshot, parseAgyModelsOutput } from "./catalog.js";
import { CustomizationDir, GATE_DEADLINE_MS, HOOK_TIMEOUT_SECONDS, sweepStaleCustomizationDirs } from "./customization.js";
import { AntigravityGate, GateServer, type AntigravityLaunchConfig } from "./gate.js";
import { effectiveNetworkAccess } from "./network_access.js";
import { ToolHost } from "./toolhost.js";

const BRIDGE_SCRIPT = new URL("../dist/bridge.js", import.meta.url).pathname;
const HOOK_SCRIPT = new URL("../dist/hook.js", import.meta.url).pathname;

export interface SpawnedAgy {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  stdin: NodeJS.WritableStream;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface GateProbe {
  stdout: NodeJS.ReadableStream;
  stderr?: NodeJS.ReadableStream | null;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  kill?(signal?: NodeJS.Signals): boolean;
}

export interface AntigravityHostOptions {
  cwd: string;
  appendSystemPrompt: string;
  onState: (envelope: Envelope) => void;
  onLog?: (envelope: Envelope) => void;
  onSessionId?: (sessionId: string) => void;
  toolDescriptors?: ToolDescriptor[];
  permissionBroker: PermissionBroker;
  questionBroker?: Pick<QuestionBroker, "close">;
  resumeSessionId?: string;
  dangerouslySkipPermissions?: boolean;
  nodePath?: string;
  agyPath?: string;
  spawn?: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => SpawnedAgy;
  probeSpawn?: (command: string, args: string[], options: { cwd: string }) => GateProbe;
  modelsProbeSpawn?: (command: string, args: string[], options: { cwd: string }) => GateProbe;
  verifyGate?: (args: string[]) => Promise<boolean>;
  gateProbeTimeoutMs?: number;
  probeModels?: () => Promise<EngineModelInfo[] | null>;
  runtimeAssetsAvailable?: () => boolean;
  warn?: (message: string) => void;
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

export interface ExpectedGateRegistration {
  source: string;
  command: string;
  timeoutSeconds: number;
}

export function isGateRegistered(value: unknown, expected: ExpectedGateRegistration): boolean {
  const registrations: Record<string, unknown>[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const record = node as Record<string, unknown>;
    if (record.source === expected.source) registrations.push(record);
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  if (registrations.length !== 1) return false;
  const actions = registrations[0]!.actions;
  if (!Array.isArray(actions) || actions.length !== 1) return false;
  const action = actions[0];
  return typeof action === "object" && action !== null
    && (action as Record<string, unknown>).event === "PreToolUse"
    && (action as Record<string, unknown>).matcher === "*"
    && (action as Record<string, unknown>).command === expected.command
    && (action as Record<string, unknown>).timeout_seconds === expected.timeoutSeconds;
}

export function initialStatusExt(config: AntigravityLaunchConfig, models = antigravityCatalogSnapshot()): Record<string, unknown> {
  const sandbox = config.sandbox ?? "workspace-write";
  const approval = config.approval ?? "on-request";
  return {
    ...effectiveStatusEnvelopeFields({
      engine: "antigravity",
      permission: { sandbox, approval },
      resolved: {
        ...(config.model === undefined ? {} : { model: config.model }),
        ...(config.model_source === undefined ? {} : { model_source: config.model_source }),
        ...(config.effort === undefined ? {} : { effort: config.effort }),
        ...(config.effort_source === undefined ? {} : { effort_source: config.effort_source }),
        sandbox,
        network_access: effectiveNetworkAccess(sandbox, config.network_access ?? false),
        // ADR-0057 F4c requires resume drift detection to compare approval too.
        approval,
      },
    }),
    models,
    permission: { sandbox, approval, enforcement: "advisory" },
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
  #turnActive = false;
  #lifecycleGeneration = 0;
  #toolHost: ToolHost | null = null;
  #gateServer: GateServer | null = null;
  #gateProbe: GateProbe | null = null;
  #cancelGateProbe: (() => void) | null = null;
  #catalog: EngineModelInfo[] = antigravityCatalogSnapshot();
  #pendingModel: string | null = null;
  #switchError: Record<string, unknown> | null = null;
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
    void this.#refreshCatalog();
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
    this.#lifecycleGeneration += 1;
    this.#turnQueue = [];
    this.#options.permissionBroker.close();
    this.#options.questionBroker?.close();
    this.#clearPendingAfterInterrupt();
    this.#gateServer?.close();
    this.#toolHost?.close();
    this.#cancelGateProbe?.();
    this.#gateProbe?.kill?.("SIGTERM");
    this.#running?.kill("SIGTERM");
  }

  close(): void {
    this.#closed = true;
    this.#lifecycleGeneration += 1;
    this.#turnQueue = [];
    this.#options.permissionBroker.close();
    this.#options.questionBroker?.close();
    this.#clearPendingAfterInterrupt();
    this.#gateServer?.close();
    this.#toolHost?.close();
    this.#cancelGateProbe?.();
    this.#gateProbe?.kill?.("SIGTERM");
    this.#running?.kill("SIGTERM");
    this.#customization?.close();
    this.#customization = null;
  }

  async setModel(value: string): Promise<void> {
    this.#pendingModel = value;
    this.#switchError = null;
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
    this.#apply({ kind: pending !== null ? "question_request" : "question_resolved" });
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
    if (this.#turnActive || this.#closed || this.#gateBroken) return;
    const text = this.#turnQueue.shift();
    if (text === undefined) return;
    this.#turnActive = true;
    const generation = this.#lifecycleGeneration;
    try {
      await this.#runTurn(text, generation);
    } catch (error) {
      if (this.#isCurrent(generation)) this.#terminalError(error instanceof Error ? error.message : String(error));
    } finally {
      this.#running = null;
      this.#turnActive = false;
      void this.#drainTurns();
    }
  }

  async #runTurn(text: string, generation: number): Promise<void> {
    this.#customization ??= CustomizationDir.create({
      cwd: this.#options.cwd,
      personaPrompt: this.#options.appendSystemPrompt,
      nodePath: this.#options.nodePath ?? process.execPath,
      hookPath: HOOK_SCRIPT,
      bridgePath: BRIDGE_SCRIPT,
    });
    const customization = this.#customization;
    customization.rewrite();
    if (!(this.#options.runtimeAssetsAvailable?.() ?? (existsSync(HOOK_SCRIPT) && existsSync(BRIDGE_SCRIPT)))) {
      throw new Error("antigravity runtime assets are not built");
    }
    let toolHost: ToolHost | null = null;
    let gateServer: GateServer | null = null;
    try {
      toolHost = await ToolHost.listen(this.#options.toolDescriptors ?? []);
      if (!this.#isCurrent(generation)) return;
      const gate = new AntigravityGate({
        config: this.#config,
        cwd: this.#options.cwd,
        customizationDir: customization.path,
        nodePath: this.#options.nodePath ?? process.execPath,
        bridgePath: BRIDGE_SCRIPT,
        toolNames: () => toolHost!.toolNames(),
        broker: this.#options.permissionBroker,
        onPermissionRequest: () => this.#apply({ kind: "permission_request" }),
        onPermissionResolved: () => this.#apply({ kind: "permission_resolved" }),
        ...(this.#options.warn === undefined ? {} : { warn: this.#options.warn }),
      });
      gateServer = await GateServer.listen({
        gate,
        onSocketClose: () => {
          this.#options.permissionBroker.close();
          this.#clearPendingPermission();
        },
      });
      if (!this.#isCurrent(generation)) return;
      this.#toolHost = toolHost;
      this.#gateServer = gateServer;
      if (!(await this.#verifyGateRegistration(generation))) {
        throw new Error("antigravity_gate_not_registered");
      }
      if (!this.#isCurrent(generation)) return;
      const attemptedModel = this.#pendingModel;
      const args = this.#turnArguments(text, customization.path, attemptedModel ?? this.#config.model);
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
      child.stderr.on("data", () => {});
      let terminalResult: AgyStreamEvent | null = null;
      let correlationFailure: string | null = null;
      readableLines(child.stdout, (line) => {
        const event = parseAgyStreamLine(line);
        if (event === null) {
          this.#warn(`antigravity: ignored malformed stream line from ${basename(this.#options.agyPath ?? "agy")}`);
          return;
        }
        if (event.event === "result") {
          terminalResult ??= event;
          return;
        }
        this.#handleEvent(event, gate);
        if (event.event === "step_update" && event.step_update.step_type === "tool" && (event.step_update.state === "DONE" || event.step_update.state === "ERROR")) {
          const stepIndex = event.step_update.step_index;
          const topLevelName = event.step_update.tool_name;
          const nestedName = event.step_update.tool_info?.name;
          const validName = (value: unknown): value is string => typeof value === "string" && value !== "";
          const toolName =
            topLevelName === undefined
              ? nestedName
              : nestedName === undefined
                ? topLevelName
                : validName(topLevelName) && validName(nestedName) && topLevelName === nestedName
                  ? topLevelName
                  : null;
          if (!Number.isSafeInteger(stepIndex) || !validName(toolName)) {
            correlationFailure = validName(topLevelName) ? topLevelName : validName(nestedName) ? nestedName : "unknown";
            this.#warn(`antigravity: completed tool correlation is unprovable: ${correlationFailure}`);
            child.kill("SIGTERM");
          } else if (!gate.observeCompletedTool(stepIndex!, toolName)) {
            correlationFailure = toolName;
            child.kill("SIGTERM");
          }
        }
      });
      const childError = await this.#waitForChild(child);
      if (this.#closed) return;
      if (customization.verify() !== true) {
        this.#gateBroken = true;
        this.#terminalError("antigravity_customization_tampered", attemptedModel);
      } else if (!this.#isCurrent(generation)) {
        return;
      } else if (correlationFailure !== null) {
        this.#gateBroken = true;
        this.#terminalError(`antigravity_gate_unobserved_tool:${correlationFailure}`, attemptedModel);
      } else if (childError !== null) {
        this.#terminalError(`agy_child_error: ${childError.message}`, attemptedModel);
      } else if (terminalResult === null) {
        this.#terminalError("agy_exit_without_result", attemptedModel);
      } else {
        const result = agyEventToResult(terminalResult);
        if (result?.is_error === true) this.#rollbackPendingModel(attemptedModel);
        else this.#promotePendingModel(attemptedModel);
        this.#publishTerminalResult(terminalResult);
      }
    } finally {
      gateServer?.close();
      toolHost?.close();
      if (this.#gateServer === gateServer) this.#gateServer = null;
      if (this.#toolHost === toolHost) this.#toolHost = null;
    }
  }

  #isCurrent(generation: number): boolean {
    return !this.#closed && generation === this.#lifecycleGeneration;
  }

  #clearPendingAfterInterrupt(): void {
    this.#clearPendingPermission();
    if (this.#pendingQuestion !== null) this.setPendingQuestion(null);
  }

  #clearPendingPermission(): void {
    if (this.#pendingPermission !== null) {
      this.#pendingPermission = null;
      if (this.#machine.state === "waiting_permission") this.#apply({ kind: "permission_resolved" });
      else this.#emitState(this.#machine.state);
    }
  }

  #waitForChild(child: SpawnedAgy): Promise<Error | null> {
    return new Promise((resolve) => {
      let settled = false;
      let closed = false;
      let stdoutEnded = false;
      let childError: Error | null = null;
      const settle = (error: Error | null): void => {
        if (settled) return;
        settled = true;
        resolve(error);
      };
      const settleAfterTerminalIo = (): void => {
        if (closed && stdoutEnded) settle(childError);
      };
      child.stdout.once("end", () => {
        stdoutEnded = true;
        settleAfterTerminalIo();
      });
      child.once("close", () => {
        closed = true;
        settleAfterTerminalIo();
      });
      child.once("error", (error) => {
        childError ??= error;
        settleAfterTerminalIo();
      });
    });
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
  }

  #publishTerminalResult(event: AgyStreamEvent): void {
    for (const adapterEvent of agyEventToEvents(event)) this.#apply(adapterEvent);
    const result = agyEventToResult(event);
    if (result !== null) this.#options.onLog?.(makeResult(this.#config, this.#now(), result));
  }

  #turnArguments(text: string, customizationDir: string, model: string | undefined): string[] {
    const args = ["--print", text, "--output-format", "stream-json", "--print-timeout", "24h", "--disable-slash-commands"];
    if (this.#options.dangerouslySkipPermissions ?? true) args.push("--dangerously-skip-permissions");
    if (this.#sessionId !== null) args.push("--conversation", this.#sessionId);
    if (model !== undefined && model !== "") args.push("--model", model);
    if (this.#config.effort !== undefined) args.push("--effort", this.#config.effort);
    args.push("--add-dir", this.#options.cwd, "--add-dir", customizationDir);
    return args;
  }

  async #verifyGateRegistration(generation: number): Promise<boolean> {
    const args = ["-p", "/hooks", "--add-dir", this.#options.cwd, "--add-dir", this.#customization!.path, "--output-format", "json"];
    return new Promise<boolean>((resolveProbe) => {
      let settled = false;
      let child: GateProbe | null = null;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const settle = (value: boolean): void => {
        if (settled) return;
        settled = true;
        if (timeout !== null) clearTimeout(timeout);
        if (this.#cancelGateProbe === cancel) this.#cancelGateProbe = null;
        if (this.#gateProbe === child) this.#gateProbe = null;
        resolveProbe(value);
      };
      const cancel = (): void => {
        child?.kill?.("SIGTERM");
        settle(false);
      };
      timeout = setTimeout(cancel, this.#options.gateProbeTimeoutMs ?? 10_000);
      this.#cancelGateProbe = cancel;
      if (this.#options.verifyGate !== undefined) {
        void this.#options.verifyGate(args).then(
          (registered) => settle(registered && this.#isCurrent(generation)),
          () => settle(false),
        );
        return;
      }
      const probeChild = this.#options.probeSpawn?.(this.#options.agyPath ?? "agy", args, { cwd: this.#options.cwd })
        ?? spawn(this.#options.agyPath ?? "agy", args, { cwd: this.#options.cwd, stdio: ["ignore", "pipe", "ignore"] });
      child = probeChild;
      this.#gateProbe = probeChild;
      let output = "";
      probeChild.stdout.setEncoding("utf8");
      probeChild.stdout.on("data", (chunk: string) => { output += chunk; });
      probeChild.once("error", () => settle(false));
      probeChild.once("exit", (code) => {
        if (code !== 0) { settle(false); return; }
        try {
          settle(isGateRegistered(JSON.parse(output) as unknown, {
            source: join(this.#customization!.path, ".agents", "hooks.json"),
            command: `${this.#options.nodePath ?? process.execPath} ${HOOK_SCRIPT}`,
            timeoutSeconds: HOOK_TIMEOUT_SECONDS,
          }));
        } catch { settle(false); }
      });
    });
  }

  async #refreshCatalog(): Promise<void> {
    let catalog: EngineModelInfo[] | null;
    try {
      catalog = await (this.#options.probeModels?.() ?? this.#defaultProbeModels());
    } catch {
      return;
    }
    if (catalog === null || this.#closed) return;
    this.#catalog = catalog;
    this.#emitState(this.#machine.state);
  }

  #defaultProbeModels(): Promise<EngineModelInfo[] | null> {
    return new Promise((resolveProbe) => {
      let output = "";
      const child = this.#options.modelsProbeSpawn?.(this.#options.agyPath ?? "agy", ["models"], { cwd: this.#options.cwd })
        ?? spawn(this.#options.agyPath ?? "agy", ["models"], {
          cwd: this.#options.cwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
      const timeout = setTimeout(() => {
        child.kill?.("SIGTERM");
        resolveProbe(null);
      }, 10_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { output += chunk; });
      child.stderr?.on("data", () => {});
      child.once("error", () => { clearTimeout(timeout); resolveProbe(null); });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        resolveProbe(code === 0 ? parseAgyModelsOutput(output) : null);
      });
    });
  }

  #apply(event: Parameters<typeof stepState>[1]): void {
    const { next, emitted } = stepState(this.#machine, event);
    this.#machine = next;
    for (const state of emitted) this.#emitState(state);
  }

  #emitState(state: KaoiroState): void {
    this.#options.onState(makeStateChange(this.#config, state, this.#now(), {}, this.#statusExt(true)));
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

  #terminalError(error: string, attemptedModel?: string | null): void {
    this.#rollbackPendingModel(attemptedModel);
    this.#apply({ kind: "result", subtype: "error_during_execution" });
    this.#options.onLog?.(makeResult(this.#config, this.#now(), { is_error: true, error_subtype: "error_during_execution", error_detail: error }));
  }

  #promotePendingModel(attemptedModel: string | null): void {
    if (attemptedModel === null || this.#pendingModel !== attemptedModel) return;
    this.#config.model = attemptedModel;
    this.#config.model_source = "config";
    this.#pendingModel = null;
    this.#switchError = null;
  }

  #rollbackPendingModel(attemptedModel?: string | null): void {
    if (this.#pendingModel === null) return;
    if (attemptedModel !== undefined && this.#pendingModel !== attemptedModel) return;
    const requested = this.#pendingModel;
    this.#pendingModel = null;
    this.#switchError = {
      kind: "model",
      requested,
      reason: "turn_failed",
      ...(this.#config.model === undefined ? {} : { rolled_back_to: this.#config.model }),
    };
  }

  #statusExt(consumeOneShot = false): Record<string, unknown> {
    const ext = initialStatusExt(this.#config, this.#catalog);
    if (this.#pendingModel !== null) ext.pending_model = this.#pendingModel;
    if (this.#switchError !== null) {
      ext.switch_error = this.#switchError;
      if (consumeOneShot) this.#switchError = null;
    }
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
