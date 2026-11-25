import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
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
import { formatTurnWatchdogLine, type RecoveryReporter } from "@kaoiro/wrapper-core";
import { AcpSession } from "./acp/session.js";
import { connectAcp } from "./acp/connection.js";
import { MuseLaunchError } from "./muse/errors.js";
import { updateEvents } from "./muse/events.js";
import { childEnvironment, museAcpArgs, MuseProcess } from "./muse/process.js";
import {
  parseModes,
  parseSelection,
  preferredApprovalMode,
  type MuseModes,
  type MuseSelection,
} from "./muse/usage.js";
import { resolveMuseSettings, type MuseSettings } from "./settings.js";

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
  recovery?: RecoveryReporter;
  onSessionId?: (id: string) => void;
  onMetadata?: (metadata: { direction: string; method?: string; variant?: string }) => void;
  onTurnStart?: (turn: { turnToken: string }) => void;
  onTurnEnd?: (turn: {
    turnToken: string;
    conversationIds: string[];
    error?: { detail: string; reason?: string };
    settled?: { authoritative: boolean; why?: string };
  }) => void;
  /** Test seam for the startup deadline (M10). */
  startupTimeoutMs?: number;
  switchTimeoutMs?: number;
  watchdogTimeoutMs?: number;
}

interface Turn {
  text: string;
  token: string;
  conversations: string[];
  resolve: () => void;
  reject: (error: Error) => void;
}

type Axis = "model" | "effort";

interface SwitchJob {
  axis: Axis;
  value: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

const STARTUP_TIMEOUT_MS = 30_000;

class StartupAborted extends Error {
  constructor() {
    super("muse startup aborted");
  }
}

/**
 * The Muse engine host: one resident `muse acp` process, one ACP session,
 * one queued unit of work at a time (a turn or a model/effort switch, in
 * arrival order). Muse Code's ACP support is experimental and
 * plain-standard: this adapter consumes no vendor extensions, passes the
 * kaoiro tools as an HTTP MCP server in `session/new`, routes ACP
 * permission requests to the operator through the permission broker, and
 * selects the session's approval mode through ACP session modes.
 *
 * Declared limits of this adapter (see docs/reference/engines/
 * muse-acp.md): no kaoiro permission-mode or two-axis permission
 * switching (the ACP approval mode is the agent's own selector, set once
 * at startup), no attachments, no session reset, and no dashboard history
 * replay. Each is rejected explicitly rather than silently ignored.
 */
export class MuseHost implements EngineAdapter {
  #machine: MachineState = initialMachineState();
  #process: MuseProcess | undefined;
  #session: AcpSession | undefined;
  #toolHost: ToolHost | undefined;
  #sessionId: string | undefined;
  #selection: MuseSelection = { models: [], effortLevels: [] };
  #modes: MuseModes | undefined;
  #modelSource: "default" | "launch" | "config" = "default";
  #effortSource: "default" | "launch" | "config" = "default";
  #switchErrorOnce: { kind: Axis; requested: string; reason: string; rolled_back_to?: string } | undefined;
  #context: { used: number; size: number } | undefined;
  #queue: Turn[] = [];
  #switches: SwitchJob[] = [];
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
  #abortTimer: ReturnType<typeof setTimeout> | undefined;
  #watchdogGrace = false;
  #pendingPermission: PendingPermissionExt | null = null;
  #pendingQuestion: PendingQuestionExt | null = null;
  #displayNameRevision = 0;
  #personaPending: boolean;
  #resumed = false;
  #recoveryConfirmed = false;
  #modeUpdate: string | undefined;
  #modeConfig: string | undefined;
  #cancelStartup!: () => void;
  #startupCancelled = new Promise<void>((resolve) => {
    this.#cancelStartup = resolve;
  });
  #toolsNoticeSent = false;
  readonly #settings: MuseSettings;
  readonly #options: MuseHostOptions;

  constructor(options: MuseHostOptions) {
    this.#options = options;
    this.#personaPending = !(options.resumeSessionId &&
      options.config.muse_persona_delivered === true);
    this.#closedPromise = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    const resolved = resolveMuseSettings(
      options.env ?? process.env,
      writeRedactedStderr,
      options.config,
    );
    this.#settings = resolved.settings;
    writeRedactedStderr(formatTurnWatchdogLine(
      "muse", process.pid, resolved.watchdog, options.config.permission_timeout_ms,
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
    const currentMode = this.#modes?.available.find((mode) => mode.id === this.#modes?.current);
    return {
      engine: "muse",
      cwd: this.#options.cwd,
      models: switchableModel
        ? selection.models
        : [{ value: "default", display_name: "Account default" }],
      ...(selection.model
        ? { model: selection.model, model_source: this.#modelSource }
        : {}),
      ...(selection.effort
        ? { effort: selection.effort, effort_source: this.#effortSource }
        : {}),
      ...(this.#switches.some((job) => job.axis === "model")
        ? { pending_model: this.#switches.find((job) => job.axis === "model")!.value }
        : {}),
      ...(this.#switches.some((job) => job.axis === "effort")
        ? { pending_effort: this.#switches.find((job) => job.axis === "effort")!.value }
        : {}),
      ...(this.#switchErrorOnce ? { switch_error: this.#switchErrorOnce } : {}),
      ...(this.#modes
        ? {
          approval_mode: {
            id: this.#modes.current,
            ...(currentMode ? { name: currentMode.name } : {}),
            available: this.#modes.available.map((mode) => mode.id),
          },
        }
        : {}),
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
      ...(ext.approval_mode ? { approval_mode: ext.approval_mode } : {}),
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

  /** Re-sends the current state unchanged, so a control the server
   *  believes it applied (e.g. an after-join set_permission_mode push) is
   *  reconciled against the effective state this adapter reports. */
  republishState(): void {
    if (this.#started && !this.#closing) this.#state(this.state);
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
    // Launch restriction inputs this adapter cannot honour are refused
    // before start, never accepted and silently ignored: kaoiro's
    // permission axes have no projection onto Muse's ACP approval modes.
    const refused: string[] = [];
    if (config.permission_mode) refused.push("permission_mode");
    if (config.sandbox) refused.push("sandbox");
    if (config.approval) refused.push("approval");
    if (config.network_access !== undefined) refused.push("network_access");
    if (refused.length > 0) {
      throw new Error(
        `muse launch does not accept ${refused.join(", ")}: ` +
        "the approval mode is selected through ACP at session start",
      );
    }
    try {
      this.#starting = true;
      await this.#start();
      this.#starting = false;
      if (!this.#closing) {
        if (this.#modes?.current !== "promptUnmatched" ||
          (this.#modeConfig !== undefined && this.#modeConfig !== "promptUnmatched")) {
          throw new MuseLaunchError("muse approval mode changed during startup");
        }
        this.#started = true;
        this.#state("waiting_input");
        if (prompt !== undefined) void this.send(prompt).catch(() => {});
        void this.#drain();
      }
      await this.closed;
      if (this.#failure) throw this.#failure;
    } catch (error) {
      this.#starting = false;
      // A close() that lands mid-startup aborts it quietly; anything else
      // (including the startup deadline) is a real launch failure.
      const stopping = error instanceof StartupAborted;
      if (!stopping) this.#state("error");
      if (error instanceof MuseLaunchError) {
        this.#options.send(makeLog(config, this.state, new Date().toISOString(),
          { kind: "system", text: error.message }));
      }
      this.close();
      await this.closed;
      if (this.#failure) throw this.#failure;
      if (!stopping) throw error;
    }
  }

  /** Startup under one lifecycle: every step is bounded by the startup
   *  deadline, and a close() landing mid-startup aborts the remaining
   *  steps instead of letting the host and child be created afterwards. */
  async #start(): Promise<void> {
    const config = this.#options.config;
    const timeoutMs = this.#options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new MuseLaunchError(
          `muse startup did not finish within ${timeoutMs}ms`,
        ));
      }, timeoutMs);
    });
    const check = () => {
      if (this.#closing) throw new StartupAborted();
    };
    try {
      await Promise.race([
        this.#startSteps(check), deadline,
        this.#startupCancelled.then(() => { throw new StartupAborted(); }),
      ]);
    } catch (error) {
      if (error instanceof StartupAborted) throw error;
      void expired;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async #startSteps(check: () => void): Promise<void> {
    const config = this.#options.config;
    const env = childEnvironment(this.#options.env ?? process.env);
    const executable = this.#options.executable ?? config.engine_executable ?? "muse";
    const toolHost = await ToolHost.listen(this.#options.toolDescriptors ?? [], {
      turnSignal: () => this.#signal?.signal ?? null,
    });
    if (this.#closing) {
      toolHost.close();
      throw new StartupAborted();
    }
    this.#toolHost = toolHost;
    check();
    const childProcess = new MuseProcess(
      executable,
      museAcpArgs(config.model, this.#settings.trustWorkspace),
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
    check();
    if (initialized.agentCapabilities?.mcpCapabilities?.http !== true) {
      throw new MuseLaunchError("muse does not support HTTP MCP servers");
    }
    const mcpServers = [toolHost.mcpServer()];
    const resumeId = this.#options.resumeSessionId;
    let modes: acp.SessionModeState | null | undefined;
    if (resumeId !== undefined) {
      if (initialized.agentCapabilities?.sessionCapabilities?.resume == null) {
        throw new MuseLaunchError("muse does not support session resume");
      }
      let resumed;
      try {
        resumed = await session.resume(resumeId, this.#options.cwd, mcpServers);
      } catch {
        check();
        throw new MuseLaunchError("muse could not resume the session");
      }
      check();
      this.#resumed = true;
      modes = resumed.modes;
      if (this.#options.recovery?.confirm(resumeId) === false) {
        throw this.#options.recovery.failure;
      }
      this.#recoveryConfirmed = true;
    } else {
      const created = await session.newSession(this.#options.cwd, mcpServers);
      check();
      modes = created.modes;
      if (session.sessionId !== undefined &&
        this.#options.recovery?.observe(session.sessionId) === false) {
        throw this.#options.recovery.failure;
      }
    }
    this.#sessionId = session.sessionId;
    this.#adoptSelection(parseSelection(session.configOptions));
    this.#modeConfig = this.#readModeConfig(session.configOptions);
    this.#modes = parseModes(modes);
    await this.#applyDefaultMode(check);
    if (config.model && config.model !== "default") {
      this.#enqueueSwitch("model", config.model, "launch").catch(() => {});
    }
    if (config.effort && this.#selection.effort !== config.effort) {
      this.#enqueueSwitch("effort", config.effort, "launch").catch(() => {});
    }
    if (this.#sessionId !== undefined) this.#options.onSessionId?.(this.#sessionId);
  }

  async #applyDefaultMode(check: () => void): Promise<void> {
    if (!this.#modes || !this.#session || !this.#sessionId ||
      !preferredApprovalMode(this.#modes)) {
      throw new MuseLaunchError("muse approval mode promptUnmatched unavailable");
    }
    if (this.#modes.current === "promptUnmatched") {
      if (this.#modeConfig !== undefined && this.#modeConfig !== this.#modes.current) {
        throw new MuseLaunchError("muse approval mode information conflicts");
      }
      return;
    }
    this.#modeUpdate = undefined;
    await this.#session.connection.agent.request(
      acp.methods.agent.session.setMode,
      { sessionId: this.#sessionId, modeId: "promptUnmatched" },
    );
    check();
    if (this.#modeUpdate !== "promptUnmatched" ||
      (this.#modeConfig !== undefined && this.#modeConfig !== "promptUnmatched")) {
      throw new MuseLaunchError("muse approval mode was not confirmed");
    }
  }

  #readModeConfig(configOptions: acp.SessionConfigOption[] | undefined): string | undefined {
    const option = configOptions?.find((entry) => entry.category === "mode");
    return option?.type === "select" ? option.currentValue : undefined;
  }

  #checkModeConfig(configOptions: acp.SessionConfigOption[] | undefined): boolean {
    this.#modeConfig = this.#readModeConfig(configOptions);
    if (!this.#started || this.#modeConfig === undefined ||
      this.#modeConfig === "promptUnmatched") return true;
    this.#signal?.abort();
    void this.#session?.cancel().catch(() => {});
    this.#state("error");
    this.#fail(new Error("muse approval mode changed unexpectedly"));
    return false;
  }

  #adoptSelection(next: MuseSelection) {
    this.#selection = {
      ...next,
      models: next.modelConfigId === undefined ? this.#selection.models : next.models,
      effortLevels: next.effortConfigId === undefined
        ? this.#selection.effortLevels : next.effortLevels,
    };
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

  /** One work loop for turns and switches alike, in arrival order within
   *  each kind: a switch can never slip between a prompt and the switch
   *  that was requested before it, and switches apply one at a time. */
  async #drain(): Promise<void> {
    if (this.#draining || !this.#started) return;
    this.#draining = true;
    try {
      while (!this.#closing) {
        const job = this.#switches[0];
        if (job) {
          this.#switches.shift();
          await this.#applySwitch(job);
          continue;
        }
        const turn = this.#queue[0];
        if (!turn) break;
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
    const carriesPersona = this.#personaPending;
    try {
      const promptText = carriesPersona
        ? `${this.#options.personaPrompt}\n\n${turn.text}`
        : turn.text;
      const response = await this.#session!.prompt(promptText);
      if (this.#closing) throw new Error("muse host closed");
      const interrupted = response.stopReason === "cancelled";
      const personaDelivered = carriesPersona && response.stopReason === "end_turn";
      if ((!interrupted && !this.#recoveryConfirmed || personaDelivered) &&
        this.#sessionId !== undefined &&
        this.#options.recovery?.confirm(this.#sessionId, personaDelivered) === false) {
        throw this.#options.recovery.failure;
      }
      if (!interrupted) this.#recoveryConfirmed = true;
      if (personaDelivered) this.#personaPending = false;
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
      clearTimeout(this.#abortTimer);
      this.#watchdogGrace = false;
      this.#signal?.abort();
      this.#signal = undefined;
      this.#active = undefined;
      this.#reportToolsMissing();
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

  /** A session whose kaoiro tools never connected is not healthy: the
   *  agent is running without its tool surface. Reported once, at the
   *  first turn's end (the latest point by which a turn-start MCP
   *  connection must have happened). */
  #reportToolsMissing() {
    if ((this.#toolHost?.stats().authenticatedLists ?? 0) > 0 ||
      this.#toolsNoticeSent || this.#closing) return;
    this.#toolsNoticeSent = true;
    this.#options.send(makeLog(
      this.#options.config, this.state, new Date().toISOString(),
      {
        kind: "system",
        text: "muse: the kaoiro tools are not connected to this session " +
          "(no MCP tools/list arrived); the agent is running without them. " +
          "For a trusted workspace, set KAOIRO_MUSE_TRUST_WORKSPACE=on and restart " +
          "the runner and wrapper; other MCP failures can also cause this warning.",
      },
    ));
  }

  /** Arms the inactivity watchdog. It does not run while the operator is
   *  answering a permission request or a question: a pending request
   *  pauses it, and clearing the request re-arms it. */
  #progress() {
    clearTimeout(this.#timer);
    if (!this.#active || this.#closing || this.#watchdogGrace ||
      this.#pendingPermission || this.#pendingQuestion) return;
    this.#timer = setTimeout(() => {
      // Expiry first cancels the turn and gives it the abort grace to
      // settle; only a turn still running after the grace closes the host.
      this.#watchdogGrace = true;
      void this.#session?.cancel().catch(() => {});
      this.#abortTimer = setTimeout(
        () => {
          this.#options.recovery?.block("watchdog");
          this.#fail(new Error("muse turn watchdog expired"));
        },
        Math.min(this.#settings.watchdog.abortGraceMs, 3_000),
      );
    }, this.#options.watchdogTimeoutMs ?? this.#settings.watchdog.inactivityMs);
  }

  #update(notification: acp.SessionNotification) {
    if (this.#closing || notification.sessionId !== this.#sessionId) return;
    if (notification.update.sessionUpdate === "config_option_update") {
      if (!this.#checkModeConfig(notification.update.configOptions)) return;
      const selection = parseSelection(notification.update.configOptions);
      if (selection.model !== this.#selection.model ||
        selection.effort !== this.#selection.effort) {
        try { process.stderr.write("[kaoiro] muse config notification differs from response\n"); }
        catch { /* diagnostic output must not affect the session */ }
      }
      return;
    }
    if (notification.update.sessionUpdate === "current_mode_update") {
      this.#modeUpdate = notification.update.currentModeId;
      if (this.#modes) {
        this.#modes = { ...this.#modes, current: this.#modeUpdate };
        if (this.#started && this.#modeUpdate !== "promptUnmatched") {
          this.#signal?.abort();
          void this.#session?.cancel().catch(() => {});
          this.#state("error");
          this.#fail(new Error("muse approval mode changed unexpectedly"));
          return;
        }
        this.#state(this.state);
      }
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
    if (this.#closing || !this.#active || request.sessionId !== this.#sessionId) {
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
    if (alive.aborted || this.#closing) {
      return { outcome: { outcome: "cancelled" } };
    }
    const kind = decision.allow ? "allow_once" : "reject_once";
    const option = request.options.find((o) => o.kind === kind);
    return option
      ? { outcome: { outcome: "selected", optionId: option.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }

  async interrupt(): Promise<void> {
    if (!this.#active || !this.#session) return;
    if (this.#watchdogGrace) return;
    clearTimeout(this.#abortTimer);
    this.#abortTimer = setTimeout(
      () => this.close(),
      Math.min(this.#settings.watchdog.abortGraceMs, 3_000),
    );
    await this.#session.cancel();
  }

  close(): void {
    if (this.#closing) return;
    this.#closing = true;
    this.#cancelStartup();
    this.#signal?.abort();
    clearTimeout(this.#timer);
    clearTimeout(this.#abortTimer);
    for (const turn of this.#queue.splice(0)) {
      turn.reject(new Error("muse host closed"));
    }
    for (const job of this.#switches.splice(0)) {
      job.reject(new Error("muse host closed"));
    }
    try {
      const closing = this.#session?.connection.close() as unknown;
      if (closing instanceof Promise) void closing.catch(() => {});
    } catch { /* already closed */ }
    this.#toolHost?.close();
    void this.#process?.close().finally(() => this.#resolveClosed());
    if (!this.#process) this.#resolveClosed();
  }

  #enqueueSwitch(
    axis: Axis,
    value: string,
    source: "launch" | "config",
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#switches.push({
        axis,
        value,
        resolve: () => {
          if (axis === "model") this.#modelSource = source;
          else this.#effortSource = source;
          resolve();
        },
        reject,
      });
      this.#state(this.state);
      void this.#drain();
    });
  }

  /** Applies one switch and reports the last response values. */
  async #applySwitch(job: SwitchJob): Promise<void> {
    const { axis, value } = job;
    const configId = axis === "model"
      ? this.#selection.modelConfigId
      : this.#selection.effortConfigId;
    const current = axis === "model" ? this.#selection.model : this.#selection.effort;
    if (configId === undefined) {
      job.reject(new Error(`muse ${axis} switching is unavailable`));
      return;
    }
    if (value === current) {
      job.resolve();
      this.#state(this.state);
      return;
    }
    let returned: string | undefined;
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let response: Awaited<ReturnType<AcpSession["setConfigOption"]>>;
      try {
        response = await Promise.race([
          this.#session!.setConfigOption(configId, value),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              const error = new Error("muse config switch timed out");
              this.#state("error");
              this.#fail(error);
              reject(error);
            }, this.#options.switchTimeoutMs ?? 30_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (this.#closing) throw new Error("muse host closed");
      if (!this.#checkModeConfig(response.configOptions)) {
        throw new Error("muse approval mode changed unexpectedly");
      }
      const selection = parseSelection(response.configOptions);
      this.#adoptSelection(selection);
      returned = axis === "model" ? selection.model : selection.effort;
      if (returned !== value) {
        throw new Error("muse switch not applied");
      }
      if (axis === "model") this.#context = undefined;
      job.resolve();
      this.#state(this.state);
    } catch {
      if (this.#closing) {
        job.reject(new Error(`muse ${axis} switching stopped`));
        return;
      }
      this.#switchErrorOnce = {
        kind: axis,
        requested: value,
        reason: "control_rejected",
        ...(returned !== undefined ? { rolled_back_to: returned } : {}),
      };
      this.#state(this.state);
      job.reject(new Error(`muse ${axis} switching rejected`));
    }
  }

  async setModel(value: string): Promise<void> {
    if (!this.#selection.models.some((model) => model.value === value)) {
      this.#switchErrorOnce = {
        kind: "model",
        requested: value,
        reason: "control_rejected",
      };
      this.#state(this.state);
      throw new Error("muse model switching rejected");
    }
    await this.#enqueueSwitch("model", value, "config");
  }

  async setEffort(level: string): Promise<void> {
    if (!this.#selection.effortLevels.includes(level)) {
      this.#switchErrorOnce = {
        kind: "effort",
        requested: level,
        reason: "control_rejected",
      };
      this.#state(this.state);
      throw new Error("muse effort switching rejected");
    }
    await this.#enqueueSwitch("effort", level, "config");
  }

  async setPermission(_selection: PermissionSelection): Promise<void> {
    throw new Error("muse permission switching is unsupported");
  }

  async setPermissionMode(_mode: PermissionMode): Promise<void> {
    throw new Error("muse permission mode switching is unsupported");
  }

  setPendingPermission(pending: PendingPermissionExt | null): void {
    this.#pendingPermission = pending;
    if (!this.#active) return;
    if (pending) {
      // Pause the watchdog while the operator answers, and say so.
      clearTimeout(this.#timer);
      this.#event({ kind: "permission_request" });
    } else {
      this.#event({ kind: "permission_resolved" });
      this.#progress();
    }
  }

  setPendingQuestion(pending: PendingQuestionExt | null): void {
    this.#pendingQuestion = pending;
    if (!this.#active) return;
    if (pending) {
      clearTimeout(this.#timer);
      this.#event({ kind: "question_request" });
    } else {
      this.#event({ kind: "question_resolved" });
      this.#progress();
    }
  }

  renameDisplayName(displayName: string, revision: number): void {
    if (revision <= this.#displayNameRevision) return;
    this.#displayNameRevision = revision;
    this.#options.config.display_name = displayName;
    this.#state(this.state);
  }
}
