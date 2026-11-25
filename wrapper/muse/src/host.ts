import { randomUUID } from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import {
  clipText,
  initialMachineState,
  logEntryToPayload,
  makeLog,
  makeResult,
  makeStateChange,
  stepState,
  writeRedactedStderr,
  type AdapterEvent,
  type EngineAdapter,
  type Envelope,
  type MachineState,
  type PendingPermissionExt,
  type PendingQuestionExt,
  type PermissionMode,
  type PermissionSelection,
  type ToolDescriptor,
  type WrapperConfig,
} from "@kaoiro/agent-common";
import { ToolHost } from "@kaoiro/agent-common/dist/toolhost.js";
import { formatTurnWatchdogLine } from "@kaoiro/wrapper-core";
import { AcpSession } from "./acp/session.js";
import { connectAcp } from "./acp/connection.js";
import { MuseLaunchError } from "./muse/errors.js";
import { updateEvents } from "./muse/events.js";
import { childEnvironment, museAcpArgs, MuseProcess } from "./muse/process.js";
import { parseSelection, type MuseSelection } from "./muse/usage.js";
import { resolveTurnWatchdogSettings, type WatchdogSettings } from "./settings.js";

export interface MuseHostOptions {
  config: WrapperConfig;
  cwd: string;
  personaPrompt: string;
  send: (envelope: Envelope) => void;
  toolDescriptors?: ToolDescriptor[];
  decidePermission: (
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{ allow: boolean }>;
  executable?: string;
  env?: NodeJS.ProcessEnv;
  /** The stored session the first turn attaches to with `session/resume`. */
  resumeSessionId?: string;
  onSessionId?: (id: string) => void;
  onMetadata?: (metadata: { direction: string; method?: string; variant?: string }) => void;
  onTurnStart?: (turn: { turnToken: string }) => void;
  onTurnEnd?: (turn: {
    turnToken: string;
    conversationIds: string[];
    error?: { detail: string; reason?: string };
    settled?: { authoritative: boolean; why?: string };
  }) => void;
}

interface Turn {
  text: string;
  token: string;
  conversations: string[];
  resolve: () => void;
  reject: (error: Error) => void;
}

type Axis = "model" | "effort";

/**
 * The Muse engine host: one resident `muse acp` process, one ACP session,
 * one queued turn at a time. Muse Code's ACP support is experimental and
 * plain-standard: this adapter consumes no vendor extensions, passes the
 * kaoiro tools as an HTTP MCP server in `session/new`, and routes ACP
 * permission requests to the operator through the permission broker.
 *
 * Declared limits of this first adapter (see docs/reference/engines/
 * muse-acp.md): no permission-mode or two-axis permission switching, no
 * attachments, no session reset, and no dashboard history replay. Each is
 * rejected explicitly rather than silently ignored.
 */
export class MuseHost implements EngineAdapter {
  #machine: MachineState = initialMachineState();
  #process: MuseProcess | undefined;
  #session: AcpSession | undefined;
  #toolHost: ToolHost | undefined;
  #sessionId: string | undefined;
  #selection: MuseSelection = { models: [], effortLevels: [] };
  #modelSource: "default" | "launch" | "config" = "default";
  #effortSource: "default" | "launch" | "config" = "default";
  #pending: Partial<Record<Axis, string>> = {};
  #switchErrorOnce: { kind: Axis; requested: string; reason: string; rolled_back_to?: string } | undefined;
  #context: { used: number; size: number } | undefined;
  #queue: Turn[] = [];
  #active: Turn | undefined;
  #signal: AbortController | undefined;
  #draining = false;
  #started = false;
  #starting = false;
  #closing = false;
  #failure: Error | undefined;
  #closedPromise: Promise<void>;
  #resolveClosed!: () => void;
  #text = "";
  #assistantText = "";
  #timer: ReturnType<typeof setTimeout> | undefined;
  #pendingPermission: PendingPermissionExt | null = null;
  #pendingQuestion: PendingQuestionExt | null = null;
  #displayNameRevision = 0;
  #personaPending = true;
  readonly #settings: WatchdogSettings;
  readonly #options: MuseHostOptions;

  constructor(options: MuseHostOptions) {
    this.#options = options;
    this.#closedPromise = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    const resolved = resolveTurnWatchdogSettings(
      options.env ?? process.env,
      writeRedactedStderr,
      options.config,
    );
    this.#settings = resolved.settings;
    writeRedactedStderr(formatTurnWatchdogLine(
      "muse", process.pid, resolved, options.config.permission_timeout_ms,
    ));
  }

  get state() {
    return this.#machine.state;
  }
  get processId() {
    return this.#process?.child.pid;
  }
  get closed() {
    return this.#closedPromise;
  }
  activeInterAgentTurnToken() {
    return this.#active?.token ?? null;
  }

  statusExtSnapshot(): Record<string, unknown> {
    const selection = this.#selection;
    const switchableModel = selection.models.length > 0 && selection.modelConfigId !== undefined;
    const switchableEffort = selection.effortLevels.length > 0 && selection.effortConfigId !== undefined;
    return {
      engine: "muse",
      cwd: this.#options.cwd,
      models: switchableModel
        ? selection.models
        : [{ value: "default", display_name: "Account default" }],
      ...(selection.model
        ? { model: selection.model, model_source: this.#modelSource }
        : { model: "default", model_source: "default" }),
      ...(selection.effort
        ? { effort: selection.effort, effort_source: this.#effortSource }
        : {}),
      ...(this.#pending.model ? { pending_model: this.#pending.model } : {}),
      ...(this.#pending.effort ? { pending_effort: this.#pending.effort } : {}),
      ...(this.#switchErrorOnce ? { switch_error: this.#switchErrorOnce } : {}),
      ...(this.#context ? {
        context: {
          used_tokens: this.#context.used,
          max_tokens: this.#context.size,
          used_percentage: (100 * this.#context.used) / this.#context.size,
        },
      } : {}),
      session_capabilities: {
        supports_model_switch: switchableModel,
        supports_effort_switch: switchableEffort,
        supports_permission_switch: false,
        supports_permission_mode_switch: false,
        supports_attachments: false,
        supports_user_input_dialog: true,
        supports_session_reset: false,
        supports_context_usage: true,
        permission_switch_axes: {},
      },
      delivery_modes: { early: "none", yield: "none" },
      ...(this.#pendingPermission ? { pending_permission: this.#pendingPermission } : {}),
      ...(this.#pendingQuestion ? { pending_question: this.#pendingQuestion } : {}),
    };
  }

  statusSnapshot() {
    const ext = this.statusExtSnapshot();
    return {
      engine: "muse",
      ...(ext.model ? { model: ext.model, model_source: ext.model_source } : {}),
      ...(ext.effort ? { effort: ext.effort, effort_source: ext.effort_source } : {}),
      ...(ext.context ? { context: ext.context } : {}),
    };
  }

  #state(state: MachineState["state"]) {
    this.#machine = { ...this.#machine, state };
    const envelope = makeStateChange(
      this.#options.config,
      state,
      new Date().toISOString(),
      {},
      this.statusExtSnapshot(),
    );
    this.#switchErrorOnce = undefined;
    this.#options.send(envelope);
  }

  #event(event: AdapterEvent) {
    const { next, emitted } = stepState(this.#machine, event);
    this.#machine = next;
    for (const state of emitted) {
      this.#state(
        this.#pendingPermission
          ? "waiting_permission"
          : this.#pendingQuestion
            ? "waiting_question"
            : state,
      );
    }
  }

  async run(prompt?: string): Promise<void> {
    if (this.#started || this.#starting || this.#closing) {
      throw new Error("muse host already started");
    }
    const config = this.#options.config;
    if (config.permission_mode) {
      throw new Error("muse permission mode is unsupported");
    }
    try {
      this.#starting = true;
      await this.#start();
      this.#starting = false;
      if (!this.#closing) {
        this.#started = true;
        this.#state("waiting_input");
        if (prompt !== undefined) void this.send(prompt).catch(() => {});
        void this.#drain();
      }
      await this.closed;
      if (this.#failure) throw this.#failure;
    } catch (error) {
      this.#starting = false;
      const stopping = this.#closing && !this.#failure;
      if (!stopping) this.#state("error");
      if (error instanceof MuseLaunchError) {
        this.#options.send(makeLog(config, this.state, new Date().toISOString(),
          { kind: "system", text: error.message }));
      }
      this.close();
      await this.closed;
      if (!stopping) throw error;
    }
  }

  async #start(): Promise<void> {
    const config = this.#options.config;
    const env = childEnvironment(this.#options.env ?? process.env);
    const executable = this.#options.executable ?? config.engine_executable ?? "muse";
    this.#toolHost = await ToolHost.listen(this.#options.toolDescriptors ?? [], {
      turnSignal: () => this.#signal?.signal ?? null,
    });
    const childProcess = new MuseProcess(
      executable,
      museAcpArgs(config.model),
      this.#options.cwd,
      env,
    );
    this.#process = childProcess;
    const connection = connectAcp(childProcess.child, {
      update: (notification) => this.#update(notification),
      permission: (request, signal) => this.#permission(request, signal),
      metadata: (metadata) => this.#options.onMetadata?.(metadata),
    });
    const session = new AcpSession(connection);
    this.#session = session;
    void connection.closed.then(() => {
      if (!this.#closing) this.#fail(new Error("muse ACP connection closed unexpectedly"));
    });
    void childProcess.exited.then(
      () => { if (!this.#closing) this.#fail(new Error("muse child exited unexpectedly")); },
      (error: Error) => { if (!this.#closing) this.#fail(error); },
    );
    const initialized = await session.initialize();
    if (initialized.agentCapabilities?.mcpCapabilities?.http !== true) {
      throw new MuseLaunchError("muse does not support HTTP MCP servers");
    }
    const mcpServers = [this.#toolHost.mcpServer()];
    const resumeId = this.#options.resumeSessionId;
    if (resumeId !== undefined) {
      if (initialized.agentCapabilities?.sessionCapabilities?.resume == null) {
        throw new MuseLaunchError("muse does not support session resume");
      }
      try {
        await session.resume(resumeId, this.#options.cwd, mcpServers);
      } catch {
        throw new MuseLaunchError("muse could not resume the session");
      }
    } else {
      await session.newSession(this.#options.cwd, mcpServers);
    }
    this.#sessionId = session.sessionId;
    this.#adoptSelection();
    if (config.model && config.model !== "default" && this.#selection.model !== config.model) {
      this.#pending.model = config.model;
      this.#modelSource = "launch";
    }
    if (config.effort && this.#selection.effort !== config.effort) {
      this.#pending.effort = config.effort;
      this.#effortSource = "launch";
    }
    if (this.#sessionId !== undefined) this.#options.onSessionId?.(this.#sessionId);
  }

  #adoptSelection() {
    if (!this.#session) return;
    const next = parseSelection(this.#session.configOptions);
    // An empty reading never shrinks a known catalog.
    if (next.models.length > 0 || this.#selection.models.length === 0) {
      this.#selection = next;
    }
  }

  #fail(error: Error) {
    if (this.#closing || this.#failure) return;
    this.#failure = error;
    this.close();
  }

  send(
    text: string,
    attachments?: readonly string[],
    conversations: string[] = [],
    token: string = randomUUID(),
  ): Promise<void> {
    if (attachments !== undefined && attachments.length > 0) {
      return Promise.reject(new Error("muse attachments are unsupported"));
    }
    if (this.#closing) return Promise.reject(new Error("muse host is closing"));
    return new Promise<void>((resolve, reject) => {
      this.#queue.push({ text, token, conversations, resolve, reject });
      void this.#drain();
    });
  }

  async #drain(): Promise<void> {
    if (this.#draining || !this.#started) return;
    this.#draining = true;
    try {
      while (!this.#closing) {
        const turn = this.#queue[0];
        if (!turn) break;
        await this.#applyPending();
        if (this.#closing) return;
        this.#queue.shift();
        await this.#execute(turn);
      }
    } finally {
      this.#draining = false;
    }
  }

  async #execute(turn: Turn): Promise<void> {
    this.#active = turn;
    this.#signal = new AbortController();
    this.#text = "";
    this.#assistantText = "";
    this.#event({ kind: "user_send" });
    if (turn.conversations.length === 0) {
      this.#options.send(
        makeLog(this.#options.config, this.state, new Date().toISOString(), {
          kind: "user",
          text: turn.text,
        }),
      );
    }
    this.#options.onTurnStart?.({ turnToken: turn.token });
    this.#progress();
    let error: Error | undefined;
    let settled: { authoritative: boolean; why?: string } = {
      authoritative: false,
      why: "the turn failed",
    };
    try {
      // Provisional persona delivery: Muse's ACP surface documents no
      // session/new system-prompt metadata, so the persona rides at the
      // head of the first turn only. See docs/reference/engines/muse-acp.md.
      const promptText = this.#personaPending
        ? `${this.#options.personaPrompt}\n\n${turn.text}`
        : turn.text;
      this.#personaPending = false;
      const response = await this.#session!.prompt(promptText);
      const interrupted = response.stopReason === "cancelled";
      this.#flushAssistantLog();
      settled = interrupted
        ? { authoritative: false, why: "the turn was interrupted" }
        : { authoritative: true };
      this.#event({
        kind: "result",
        subtype: "success",
      });
      this.#options.send(
        makeResult(
          this.#options.config,
          new Date().toISOString(),
          { text: clipText(this.#text).text, is_error: false },
          {
            stop_reason: response.stopReason,
            completion_source: "prompt_response",
            ...(interrupted ? { interrupted: true } : {}),
          },
        ),
      );
      turn.resolve();
    } catch (cause) {
      error = cause instanceof Error ? cause : new Error("muse turn failed");
      this.#flushAssistantLog();
      this.#event({ kind: "result", subtype: "error_during_execution" });
      this.#options.send(
        makeResult(this.#options.config, new Date().toISOString(), {
          text: "",
          is_error: true,
          error_code: "muse_turn_failed",
        }),
      );
      turn.reject(error);
    } finally {
      clearTimeout(this.#timer);
      this.#signal?.abort();
      this.#signal = undefined;
      this.#active = undefined;
      this.#options.onTurnEnd?.({
        turnToken: turn.token,
        conversationIds: turn.conversations,
        ...(error ? { error: { detail: "muse turn failed" } } : {}),
        settled: this.#closing
          ? { authoritative: false, why: "the wrapper is shutting down" }
          : settled,
      });
      if (!this.#closing) this.#state("waiting_input");
    }
  }

  #progress() {
    clearTimeout(this.#timer);
    if (!this.#active || this.#closing || this.#pendingPermission || this.#pendingQuestion) return;
    this.#timer = setTimeout(() => {
      this.close();
    }, this.#settings.inactivityMs);
  }

  #update(notification: acp.SessionNotification) {
    if (notification.sessionId !== this.#sessionId) return;
    if (notification.update.sessionUpdate === "config_option_update") {
      const before = `${this.#selection.model}/${this.#selection.effort}`;
      this.#adoptSelection();
      const after = `${this.#selection.model}/${this.#selection.effort}`;
      if (before !== after) this.#state(this.state);
      return;
    }
    if (!this.#active) return;
    this.#progress();
    const update = updateEvents(notification);
    if (update.usage) {
      this.#context = update.usage;
      return;
    }
    if (update.log && update.log.kind !== "assistant") this.#flushAssistantLog();
    for (const event of update.events) this.#event(event);
    if (update.text) {
      this.#text += update.text;
      this.#assistantText += update.text;
    }
    if (update.log) {
      this.#options.send(
        makeLog(this.#options.config, this.state, new Date().toISOString(), update.log),
      );
    }
  }

  #flushAssistantLog() {
    const text = this.#assistantText;
    this.#assistantText = "";
    if (!text) return;
    this.#options.send(
      makeLog(
        this.#options.config,
        this.state,
        new Date().toISOString(),
        logEntryToPayload({ kind: "assistant", text }, new Map()),
      ),
    );
  }

  async #permission(
    request: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse> {
    if (!this.#active || request.sessionId !== this.#sessionId) {
      return { outcome: { outcome: "cancelled" } };
    }
    const alive = AbortSignal.any([signal, this.#signal!.signal]);
    const raw = request.toolCall.rawInput;
    const input =
      typeof raw === "object" && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    const decision = await this.#options.decidePermission(
      request.toolCall.title ?? "muse tool",
      { ...input, tool_call_id: request.toolCall.toolCallId },
      alive,
    );
    const kind = decision.allow ? "allow_once" : "reject_once";
    const option = request.options.find((o) => o.kind === kind);
    return option
      ? { outcome: { outcome: "selected", optionId: option.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }

  async interrupt(): Promise<void> {
    if (!this.#active || !this.#session) return;
    await this.#session.cancel();
  }

  close(): void {
    if (this.#closing) return;
    this.#closing = true;
    clearTimeout(this.#timer);
    for (const turn of this.#queue.splice(0)) {
      turn.reject(new Error("muse host closed"));
    }
    try {
      const closing = this.#session?.connection.close() as unknown;
      if (closing instanceof Promise) void closing.catch(() => {});
    } catch { /* already closed */ }
    this.#toolHost?.close();
    void this.#process?.close().finally(() => this.#resolveClosed());
    if (!this.#process) this.#resolveClosed();
  }

  async #applyPending(): Promise<void> {
    if (!this.#session) return;
    for (const axis of ["model", "effort"] as Axis[]) {
      const value = this.#pending[axis];
      if (value === undefined) continue;
      const configId = axis === "model"
        ? this.#selection.modelConfigId
        : this.#selection.effortConfigId;
      const current = axis === "model" ? this.#selection.model : this.#selection.effort;
      delete this.#pending[axis];
      if (configId === undefined || value === current) continue;
      try {
        await this.#session.setConfigOption(configId, value);
        this.#adoptSelection();
        if (axis === "model") this.#context = undefined;
      } catch {
        this.#switchErrorOnce = {
          kind: axis,
          requested: value,
          reason: "control_rejected",
          ...(current ? { rolled_back_to: current } : {}),
        };
        this.#state(this.state);
      }
    }
  }

  async setModel(value: string): Promise<void> {
    if (!this.#selection.models.some((model) => model.value === value)) {
      this.#switchErrorOnce = {
        kind: "model",
        requested: value,
        reason: "control_rejected",
        ...(this.#selection.model ? { rolled_back_to: this.#selection.model } : {}),
      };
      this.#state(this.state);
      throw new Error("muse model switching rejected");
    }
    this.#pending.model = value;
    this.#modelSource = "config";
    this.#state(this.state);
    if (!this.#active) await this.#applyPending();
  }

  async setEffort(level: string): Promise<void> {
    if (!this.#selection.effortLevels.includes(level)) {
      this.#switchErrorOnce = {
        kind: "effort",
        requested: level,
        reason: "control_rejected",
        ...(this.#selection.effort ? { rolled_back_to: this.#selection.effort } : {}),
      };
      this.#state(this.state);
      throw new Error("muse effort switching rejected");
    }
    this.#pending.effort = level;
    this.#effortSource = "config";
    this.#state(this.state);
    if (!this.#active) await this.#applyPending();
  }

  async setPermission(_selection: PermissionSelection): Promise<void> {
    throw new Error("muse permission switching is unsupported");
  }

  async setPermissionMode(_mode: PermissionMode): Promise<void> {
    throw new Error("muse permission mode switching is unsupported");
  }

  setPendingPermission(pending: PendingPermissionExt | null): void {
    this.#pendingPermission = pending;
    if (this.#active) this.#state(this.state);
  }

  setPendingQuestion(pending: PendingQuestionExt | null): void {
    this.#pendingQuestion = pending;
    if (this.#active) this.#state(this.state);
  }

  renameDisplayName(displayName: string, revision: number): void {
    if (revision <= this.#displayNameRevision) return;
    this.#displayNameRevision = revision;
    this.#options.config.display_name = displayName;
    this.#state(this.state);
  }
}
