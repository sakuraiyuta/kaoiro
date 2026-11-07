import { RequestError } from "@agentclientprotocol/sdk";
import type { RecoveryReporter } from "@kaoiro/wrapper-core";
import { randomUUID } from "node:crypto";
import type { PermissionSelection as Selection, PermissionSubmission, PermissionSyncMessage,
  PermissionGateExt, SwitchErrorExt, WrapperPermissionLifecycleMessage } from "@kaoiro/protocol";
import { createPermissionState, setPermissionSyncSupport, requestPermission,
  applyPermissionSyncState, capturePermission, beginPermissionExecution,
  permissionLaneFailed, permissionObservationApplied, permissionObservationFailed,
  withinCeiling, effectiveNetworkAccess, type PermissionState } from "./permission_state.js";
import type * as acp from "@agentclientprotocol/sdk";
import {
  clipText,
  computeResumeDrift,
  effectiveStatusEnvelopeFields,
  effectiveStatusWhoamiFields,
  initialMachineState,
  logEntryToPayload,
  makeLog,
  makeResult,
  permissionSyncFailure,
  makeStateChange,
  stepState,
  writeRedactedStderr,
  type AdapterEvent,
  type EffectiveStatusSnapshot,
  type EngineAdapter,
  type Envelope,
  type MachineState,
  type ModelSource,
  type PendingPermissionExt,
  type PendingQuestionExt,
  type PermissionMode,
  type PermissionSelection,
  type ResolvedSnapshotExt,
  type ToolDescriptor,
  type WrapperConfig,
} from "@kaoiro/agent-common";
import { AcpSession } from "./acp/session.js";
import { connectAcp } from "./acp/connection.js";
import { GrokProcess } from "./grok/process.js";
import {
  cancellationKind,
  promptIdOf,
  turnCompletion,
  updateEvents,
} from "./grok/events.js";
import {
  grokExtension,
  grokSessionMeta,
  type GrokWireMetadata,
} from "./grok/wire.js";
import {
  childEnvironment,
  inspectPolicy,
  sandboxProfile,
  type PermissionPolicyExt,
  type SandboxProfile,
} from "./grok/policy.js";
import { formatTurnWatchdogLine, PermissionSyncTimeoutError } from "@kaoiro/wrapper-core";
import { resolveTurnWatchdogSettings } from "./settings.js";
import { GrokLaunchError } from "./grok/errors.js";
import { GrokRateLimitReader, type GrokRateLimits } from "./grok/rate_limits.js";
import { stateChangeKey } from "./grok/state_key.js";
import {
  parseModelState,
  parseSelection,
  promptTokens,
  reportedSelection,
  type GrokModel,
} from "./grok/usage.js";
import { MCP_NOT_CONNECTED, ToolHost, type ToolHostStats } from "./toolhost.js";

export interface GrokHostOptions {
  recovery?: RecoveryReporter;
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
  /** How long to wait, after the session exists, for Grok to list the kaoiro
   *  tools. Startup fails with the reason when it does not. */
  mcpReadyTimeoutMs?: number;
  /** The stored session the first lane attaches to with `session/resume`. */
  resumeSessionId?: string;
  /** The snapshot the runner relayed with a resume, for `resume_drift`. */
  resumeSnapshot?: ResolvedSnapshotExt;
  platform?: NodeJS.Platform;
  permissionSyncSupported?: boolean;
  waitForPermissionSync?: () => Promise<void>;
  permissionGateTimeoutMs?: number;
  /** How long one `session/set_config_option` may take before the host
   *  fails; the request normally answers in milliseconds. */
  switchTimeoutMs?: number;
  onPermissionLifecycle?: (event: WrapperPermissionLifecycleMessage) => void;
  /** A synchronization seam for lifecycle tests; production has no observer. */
  onLaneStep?: (step: LaneStep, pid?: number) => Promise<void> | void;
  onSessionId?: (id: string) => void;
  onMetadata?: (metadata: GrokWireMetadata) => void;
  onTurnStart?: (turn: { turnToken: string }) => void;
  onTurnEnd?: (turn: {
    turnToken: string;
    conversationIds: string[];
    error?: { detail: string; reason?: string };
  }) => void;
}
/** Grok connects to the MCP server within about a second of session/new
 *  (measured at most 1.1 s); this is far past that and inside the 30 s startup
 *  deadline, so a missing connection reports its own reason first. */
const MCP_READY_TIMEOUT_MS = 15_000;
// Metadata held per loading generation until promotion; a memory bound, well
// above the few dozen lines a start-up sends.
const LOADING_METADATA_LIMIT = 256;
const SWITCH_TIMEOUT_MS = 15_000;
// session/load replays the history as session/update and Grok's own records,
// past hook executions included, as _x.ai/session/update.
const LOAD_REPLAY_METHODS = new Set(["session/update", "_x.ai/session/update"]);
type LaneStep = "stopping" | "inspect" | "spawn" | "initialize" | "load" | "readiness" | "promotion";
interface Generation {
  role: "current" | "loading" | "retired";
  process: GrokProcess;
  session: AcpSession;
  toolHost: ToolHost;
  profile: SandboxProfile;
  policy: PermissionPolicyExt;
  failure?: Error;
  failed: Promise<never>;
  fail: (error: Error) => void;
  held: GrokWireMetadata[];
  heldDropped: number;
  models: GrokModel[];
  rateLimitsReader: GrokRateLimitReader;
}
class SwitchTimeout extends Error {
  constructor() { super("grok configuration request timed out"); }
}
class LaneFailure extends Error {
  constructor(readonly step: PermissionGateExt["step"] | "stopping") { super("grok restart failed"); }
}
type Axis = "model" | "effort";
/** A model or effort value waiting to be applied, with the source it will
 *  carry once Grok confirms it. `operator` marks a live switch, as opposed to
 *  the start selection (a launch pick or a resumed pair). */
interface AxisRequest {
  value: string;
  source: ModelSource;
  operator: boolean;
}
type AxisRecord = Partial<Record<Axis, AxisRequest>>;
interface Turn {
  text: string;
  token: string;
  conversations: string[];
  resolve: () => void;
  reject: (error: Error) => void;
}

export class GrokHost implements EngineAdapter {
  #machine: MachineState = initialMachineState();
  #current: Generation | undefined;
  #loading: Generation | undefined;
  #sessionId: string | undefined;
  #lane: Promise<void> = Promise.resolve();
  #draining = false;
  #wake: (() => void) | undefined;
  #permissions: PermissionState;
  readonly #ceiling: Selection;
  readonly #platform: NodeJS.Platform;
  #queue: Turn[] = [];
  #active: Turn | undefined;
  #signal: AbortController | undefined;
  #started = false;
  #closing = false;
  #revision = 0;
  #failure: Error | undefined;
  #completion: { sessionId: string; promptId: string } | undefined;
  readonly #lifetime = new AbortController();
  #starting = false;
  #pendingPermission: PendingPermissionExt | null = null;
  #pendingQuestion: PendingQuestionExt | null = null;
  #text = "";
  #assistantText = "";
  #publishedState: string | undefined;
  // Model and effort as Grok holds them, read from its configOptions.
  #catalog: GrokModel[] = [];
  #selection: { model: string; effort: string } | undefined;
  #switchable = false;
  #modelSource: ModelSource = "default";
  #effortSource: ModelSource = "default";
  #pending: AxisRecord = {};
  #inflight: AxisRecord = {};
  // Axes an operator switch has set; resume_drift leaves them out.
  readonly #operatorSwitched = new Set<Axis>();
  // Start-selection axes that could not be applied (the restore hold, issue
  // #644). `effective` keeps the requested pair so the next start retries
  // it; the displayed fields show what Grok actually runs.
  #held: AxisRecord = {};
  #switchErrorOnce: SwitchErrorExt | undefined;
  #effortResetOnce = false;
  // The model-call prompt size of the running turn, and the last published
  // reading. A reading shows only while its generation is the current one.
  #turnTokens: number | undefined;
  #contextGeneration = 0;
  #context: { generation: number; used: number; max: number } | undefined;
  #rateLimits: GrokRateLimits | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #abortTimer: ReturnType<typeof setTimeout> | undefined;
  #resolveClosed!: () => void;
  readonly closed = new Promise<void>((resolve) => {
    this.#resolveClosed = resolve;
  });
  readonly #options: GrokHostOptions;
  readonly #settings;

  constructor(options: GrokHostOptions) {
    this.#options = options;
    this.#platform = options.platform ?? process.platform;
    const sandbox = options.config.sandbox ?? "workspace-write";
    this.#ceiling = { revision: 0, requested: { sandbox,
      network_access: options.config.network_access ?? sandbox !== "read-only" } };
    this.#permissions = createPermissionState(this.#ceiling,
      this.#platform === "linux" && options.permissionSyncSupported === true);
    // The start selection is pending from the first status on, so no status
    // can publish the session's previous model as if it were the choice.
    // The source order is Codex's: a relayed source wins, else `config`.
    const { model, model_source, effort, effort_source } = options.config;
    if (model !== undefined && model !== "default")
      this.#pending.model = { value: model, source: model_source ?? "config", operator: false };
    if (effort !== undefined)
      this.#pending.effort = { value: effort, source: effort_source ?? "config", operator: false };
    const resolved = resolveTurnWatchdogSettings(
      options.env ?? process.env,
      writeRedactedStderr,
      options.config,
    );
    this.#settings = resolved.settings;
    writeRedactedStderr(formatTurnWatchdogLine(
      "grok", process.pid, resolved, options.config.permission_timeout_ms,
    ));
  }

  get state() {
    return this.#machine.state;
  }
  get processId() {
    return this.#current?.process.child.pid;
  }
  /** For tests: what the tool server has seen. It never holds the token. */
  toolHostStats(): ToolHostStats | undefined {
    return this.#current?.toolHost.stats();
  }
  activeInterAgentTurnToken() {
    return this.#active?.token ?? null;
  }
  statusExtSnapshot(): Record<string, unknown> {
    const { status, permission } = this.#effectiveStatus();
    const switching = this.#platform === "linux" && this.#permissions.syncSupported;
    const pair = this.#ceiling.requested;
    const envelope = this.#showHeldEffort(effectiveStatusEnvelopeFields(status));
    // An empty `effective` would clear the stored effort (the server replaces
    // effort as a pair), so it rides only with something to persist.
    if (Object.keys(status.resolved).length === 0) delete envelope.effective;
    const snapshot = this.#options.resumeSnapshot;
    return {
      ...envelope,
      ...this.#selectionFields(),
      cwd: this.#options.cwd,
      ...(snapshot ? { resume_snapshot: snapshot, resume_drift: this.#resumeDrift(snapshot, status.resolved) } : {}),
      ...(permission ? { permission } : {}),
      ...(this.#current ? { permission_policy: this.#current.policy } : {}),
      ...(this.#current && this.#rateLimits ? { rate_limits: this.#rateLimits } : {}),
      ...(this.#permissions.latest ? { permission_control: this.#permissions.latest } : {}),
      ...(this.#permissions.gate ? { permission_gate: this.#permissions.gate } : {}),
      session_capabilities: {
        supports_model_switch: this.#switchable,
        supports_effort_switch: this.#switchable,
        supports_permission_switch: switching,
        supports_permission_mode_switch: false,
        supports_attachments: false,
        supports_user_input_dialog: true,
        supports_session_reset: false,
        supports_context_usage: this.#switchable,
        permission_switch_axes: switching ? { sandbox: { max: pair.sandbox }, network_access: { max: pair.network_access } } : {},
      },
      delivery_modes: { early: "none", yield: "none" },
      ...(this.#pendingPermission
        ? { pending_permission: this.#pendingPermission }
        : {}),
      ...(this.#pendingQuestion
        ? { pending_question: this.#pendingQuestion }
        : {}),
    };
  }
  /** The values this run enforces, for state_change.ext and whoami alike.
   *  Model and effort are known once Grok's configOptions are adopted;
   *  sandbox and network only when the permission is known. */
  #effectiveStatus(): { status: EffectiveStatusSnapshot; permission: EffectiveStatusSnapshot["permission"] } {
    const profile = this.#current?.profile;
    const observed = this.#permissions.current?.observation;
    // issue #620: the launch profile is not projected over an unknown
    // execution. Two roles are checked and kept apart: `latest` is the newest
    // operator control, and `current` is the captured execution. A refused
    // successor makes `latest` failed while the captured execution stays
    // unknown, so both must be clear before the profile is projected.
    const projectProfile = (!this.#permissions.latest || !this.#permissions.lastEffective)
      && this.#permissions.latest?.status !== "unknown"
      && this.#permissions.current?.status !== "unknown";
    const projectedSandbox: NonNullable<ResolvedSnapshotExt["sandbox"]> = profile === "off" ? "danger-full-access"
      : profile === "workspace" ? "workspace-write" : "read-only";
    const permission = observed?.permission ?? (projectProfile && profile ? {
      sandbox: projectedSandbox, approval: "on-request",
      ...(profile === "off" ? {} : { enforcement: "os" }),
    } : undefined);
    const effective = observed ? { sandbox: observed.permission.sandbox, network_access: observed.network_access }
      : projectProfile && profile ? { sandbox: projectedSandbox, network_access: profile !== "read-only" } : undefined;
    const selection = this.#switchable ? this.#selection : undefined;
    const { model: heldModel, effort: heldEffort } = this.#held;
    const resolved: ResolvedSnapshotExt = {
      ...(selection ? { model: selection.model, model_source: this.#modelSource,
        effort: selection.effort, effort_source: this.#effortSource } : {}),
      ...(heldModel ? { model: heldModel.value, model_source: heldModel.source } : {}),
      ...(heldEffort ? { effort: heldEffort.value, effort_source: heldEffort.source } : {}),
      ...(effective ?? {}),
    };
    // A held model shows what Grok runs, as the `fallback` source (the
    // displayed_model contract of issue #363); without a selection that is
    // the account default.
    const displayed = heldModel ? { displayed_model: selection?.model ?? "default" } : {};
    return { status: { engine: "grok", resolved, ...(permission ? { permission } : {}), ...displayed }, permission };
  }
  // The shared projection copies the effort from `resolved`; a held effort
  // shows Grok's actual one instead, or none when Grok reports no selection.
  #showHeldEffort<T extends Record<string, unknown>>(fields: T): T {
    if (!this.#held.effort) return fields;
    const selection = this.#switchable ? this.#selection : undefined;
    const shown: Record<string, unknown> = { ...fields };
    delete shown.effort;
    delete shown.effort_source;
    return (selection ? { ...shown, effort: selection.effort, effort_source: "default" } : shown) as T;
  }
  // A field an operator switched on purpose is not drift; neither is a
  // permission after an operator control, nor a value not read yet.
  #resumeDrift(snapshot: ResolvedSnapshotExt, resolved: ResolvedSnapshotExt) {
    return computeResumeDrift(snapshot, resolved).filter((entry) => {
      if (entry.field === "sandbox" || entry.field === "network_access")
        return !this.#permissions.latest && entry.now !== undefined;
      const axis = entry.field.startsWith("effort") ? "effort" : entry.field.startsWith("model") ? "model" : undefined;
      if (!axis) return true;
      if (this.#operatorSwitched.has(axis) || this.#pending[axis] || this.#inflight[axis]) return false;
      return entry.now !== undefined;
    });
  }
  statusSnapshot() {
    const ext = this.statusExtSnapshot();
    const whoami = this.#showHeldEffort({ ...effectiveStatusWhoamiFields(this.#effectiveStatus().status) });
    return {
      ...whoami,
      ...(whoami.model === undefined ? { model: ext.model, model_source: ext.model_source } : {}),
      ...(ext.context ? { context: ext.context } : {}),
      ...(ext.rate_limits ? { rate_limits: ext.rate_limits } : {}),
    };
  }
  // Until a configOptions reading passes the checks of #adoptGeneration the
  // catalog stays the account default, so the switch capabilities stay off.
  // A value waiting to apply, or being applied, shows as pending throughout:
  // the server keeps no snapshot while it does.
  #selectionFields(): Record<string, unknown> {
    const selection = this.#switchable ? this.#selection : undefined;
    const pendingModel = (this.#pending.model ?? this.#inflight.model)?.value;
    const pendingEffort = (this.#pending.effort ?? this.#inflight.effort)?.value;
    const pending = {
      ...(pendingModel === undefined ? {} : { pending_model: pendingModel }),
      ...(pendingEffort === undefined ? {} : { pending_effort: pendingEffort }),
    };
    if (!selection) {
      return {
        models: [{ value: "default", display_name: "Account default" }],
        // A held model is already displayed as the fallback.
        ...(this.#held.model ? {} : { model: "default", model_source: "default" }),
        ...pending,
        ...(this.#switchErrorOnce ? { switch_error: this.#switchErrorOnce } : {}),
      };
    }
    const context = this.#context;
    return {
      models: this.#catalog.map(({ window: _window, effort_levels, ...info }) => ({
        ...info,
        ...(effort_levels.length > 0 ? { effort_levels } : {}),
      })),
      ...pending,
      ...(this.#effortResetOnce ? { effort_reset: true } : {}),
      ...(this.#switchErrorOnce ? { switch_error: this.#switchErrorOnce } : {}),
      ...(context && context.generation === this.#contextGeneration ? {
        context: {
          used_tokens: context.used,
          max_tokens: context.max,
          used_percentage: (100 * context.used) / context.max,
        },
      } : {}),
    };
  }
  #state(state: MachineState["state"]) {
    this.#machine = { ...this.#machine, state };
    // A switch error or an effort reset is reported once. Each is published
    // even when it repeats the last envelope.
    const once = this.#switchErrorOnce !== undefined || this.#effortResetOnce;
    const envelope = makeStateChange(
      this.#options.config,
      state,
      new Date().toISOString(),
      {},
      this.statusExtSnapshot(),
    );
    this.#switchErrorOnce = undefined;
    this.#effortResetOnce = false;
    const key = stateChangeKey(envelope);
    if (key === this.#publishedState && !once) return;
    this.#publishedState = key;
    this.#options.send(envelope);
  }
  #event(event: AdapterEvent) {
    if (event.kind === "assistant" && this.#machine.pendingToolUses.size > 0) {
      event = {
        ...event,
        blocks: [...event.blocks, "tool_use"],
        toolUseIds: [
          ...new Set([
            ...this.#machine.pendingToolUses,
            ...(event.toolUseIds ?? []),
          ]),
        ],
      };
    }
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
      throw new Error("grok host already started");
    }
    const config = this.#options.config;
    if (config.permission_mode)
      throw new Error("grok permission mode is unsupported");
    try {
      this.#starting = true;
      sandboxProfile(config, this.#options.cwd, this.#options.env ?? process.env, this.#platform);
      await this.#inLane(() => this.#replace(this.#ceiling));
      this.#starting = false;
      if (!this.#closing) {
        this.#started = true;
        this.#state("waiting_input");
        const generation = this.#current;
        if (prompt === undefined && generation) void this.#refreshRateLimits(generation);
        if (prompt !== undefined) void this.send(prompt).catch(() => {});
        void this.#drain();
      }
      await this.closed;
      if (this.#failure) throw this.#failure;
    } catch (error) {
      this.#starting = false;
      const stopping = this.#closing && !this.#failure;
      if (!stopping) this.#state("error");
      if (error instanceof GrokLaunchError) {
        this.#options.send(makeLog(config, this.state, new Date().toISOString(),
          { kind: "system", text: error.message }));
      }
      this.close();
      await this.closed;
      if (!stopping) throw error;
    }
  }

  #inLane(action: () => Promise<void>): Promise<void> {
    const result = this.#lane.then(action);
    this.#lane = result.catch(() => {});
    return result;
  }
  async #retire(generation: Generation | undefined) {
    if (!generation) return;
    generation.role = "retired";
    generation.rateLimitsReader.retire();
    generation.held = [];
    generation.heldDropped = 0;
    if (this.#current === generation) {
      this.#current = undefined;
      this.#rateLimits = undefined;
    }
    if (this.#loading === generation) this.#loading = undefined;
    generation.session.connection.close();
    generation.toolHost.close();
    await generation.process.close();
  }
  #generationFailed(generation: Generation, error: Error) {
    if (generation.role === "retired") return;
    if (generation.role === "loading") {
      generation.failure ??= error;
      generation.fail(error);
      return;
    }
    if (!this.#closing) {
      this.#failure = error;
      this.close();
    }
  }
  async #replace(selection: Selection) {
    let step: LaneStep = "stopping";
    let generation: Generation | undefined;
    let toolHost: ToolHost | undefined;
    let expired = false;
    const abort = new AbortController();
    const signal = AbortSignal.any([this.#lifetime.signal, abort.signal]);
    const aborted = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(new Error("grok lane aborted"));
      else signal.addEventListener("abort", () => reject(new Error("grok lane aborted")), { once: true });
    });
    void aborted.catch(() => {});
    const check = () => {
      if (this.#closing || signal.aborted) throw new Error("grok lane aborted");
    };
    const wait = async <T>(promise: Promise<T>): Promise<T> => {
      const value = await Promise.race([promise, aborted, ...(generation ? [generation.failed] : [])]);
      check();
      return value;
    };
    const at = async (value: LaneStep) => {
      step = value;
      check();
      if (this.#options.onLaneStep) {
        const observed = Promise.resolve(this.#options.onLaneStep(value, generation?.process.child.pid));
        if (value === "promotion") await Promise.race([observed, aborted]);
        else await wait(observed);
      }
      check();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await at("stopping");
      await this.#retire(this.#current);
      check();
      timer = setTimeout(() => { expired = true; abort.abort(); }, 30_000);
      await at("inspect");
      const profile = sandboxProfile(selection.requested, this.#options.cwd,
        this.#options.env ?? process.env, this.#platform);
      const env = childEnvironment(this.#options.env ?? process.env, profile);
      const executable = this.#options.executable ?? "grok";
      const policy = await wait(inspectPolicy(executable, this.#options.cwd, env, profile, signal));
      // Always collect the listener even if close won while listen was pending.
      toolHost = await ToolHost.listen(this.#options.toolDescriptors ?? [],
        { turnSignal: () => this.#signal?.signal ?? null });
      check();
      await at("spawn");
      const childProcess = new GrokProcess(executable, this.#options.cwd, env);
      let fail!: (error: Error) => void;
      const failed = new Promise<never>((_, reject) => { fail = reject; });
      void failed.catch(() => {});
      const connection = connectAcp<GrokWireMetadata>(childProcess.child, {
        update: (notification) => { if (generation?.role === "current") this.#update(notification); },
        permission: (request, requestSignal) => generation?.role === "current"
          ? this.#permission(request, requestSignal)
          : Promise.resolve({ outcome: { outcome: "cancelled" as const } }),
        metadata: (metadata) => {
          if (generation?.role === "current") this.#options.onMetadata?.(metadata);
          else if (generation?.role === "loading") this.#hold(generation, metadata);
        },
      }, grokExtension((notification) => { if (generation?.role === "current") this.#vendor(notification); }));
      generation = { role: "loading", process: childProcess, session: new AcpSession(connection), toolHost,
        profile, policy, failed, fail, held: [], heldDropped: 0, models: [],
        rateLimitsReader: new GrokRateLimitReader({
          request: (cancellationSignal) => connection.agent.request(
            "_x.ai/billing", {}, { cancellationSignal },
          ),
          diagnostic: (line) => writeRedactedStderr(`${line}\n`),
        }) };
      this.#loading = generation;
      const owned = generation;
      void connection.closed.then(() => this.#generationFailed(owned, new Error("grok ACP connection closed unexpectedly")));
      void childProcess.exited.then(() => this.#generationFailed(owned, new Error("grok child exited unexpectedly")),
        (error: Error) => this.#generationFailed(owned, error));
      await at("initialize");
      const initialized = await wait(generation.session.initialize());
      if (initialized.agentCapabilities?.mcpCapabilities?.http !== true)
        throw new GrokLaunchError("grok does not support HTTP MCP servers");
      generation.models = parseModelState(initialized._meta);
      await at("load");
      const resumeId = this.#options.resumeSessionId;
      if (this.#sessionId) {
        if (initialized.agentCapabilities?.loadSession !== true) throw new Error("grok session load unsupported");
        await wait(generation.session.load(this.#sessionId, this.#options.cwd, [toolHost.mcpServer()]));
        if (this.#options.recovery?.confirm(this.#sessionId) === false) throw this.#options.recovery.failure;
      } else if (resumeId !== undefined) {
        if (initialized.agentCapabilities?.sessionCapabilities?.resume == null)
          throw new GrokLaunchError("grok does not support session resume");
        try {
          await wait(generation.session.resume(resumeId, this.#options.cwd, [toolHost.mcpServer()]));
          if (this.#options.recovery?.confirm(resumeId) === false) throw this.#options.recovery.failure;
        } catch (error) {
          check();
          if (!generation.failure && error instanceof RequestError && error.code === -32603) this.#options.recovery?.refuseLaunch();
          // Grok answers -32603 for an unknown id and for a session bound to
          // another cwd; neither carries detail worth relaying.
          throw generation.failure ? error : new GrokLaunchError("grok could not resume the session");
        }
      } else {
        await wait(generation.session.newSession(this.#options.cwd, [toolHost.mcpServer()],
          grokSessionMeta(this.#options.personaPrompt)));
        if (generation.session.sessionId !== undefined && this.#options.recovery?.observe(generation.session.sessionId) === false) throw this.#options.recovery.failure;
      }
      await at("readiness");
      await wait(toolHost.listed(this.#options.mcpReadyTimeoutMs ?? MCP_READY_TIMEOUT_MS)
        .catch(() => { throw new GrokLaunchError(MCP_NOT_CONNECTED); }));
      await at("promotion");
      check();
      if (generation.failure) throw new LaneFailure("loading_exit");
      generation.role = "current";
      this.#current = generation;
      this.#loading = undefined;
      this.#sessionId = generation.session.sessionId;
      this.#completion = undefined;
      this.#adoptGeneration(generation);
      this.#flushHeld(generation);
      this.#options.onSessionId?.(this.#sessionId!);
    } catch (error) {
      if (!this.#sessionId) throw error;
      throw error instanceof LaneFailure ? error : new LaneFailure(expired ? "deadline" :
        (step as LaneStep) === "promotion" ? "loading_exit" : step as Exclude<LaneStep, "promotion">);
    } finally {
      clearTimeout(timer);
      if (generation && generation.role !== "current") await this.#retire(generation);
      else if (!generation) toolHost?.close();
    }
  }

  async #refreshRateLimits(generation: Generation) {
    if (this.#closing || generation.role !== "current" || this.#current !== generation) return;
    const reading = await generation.rateLimitsReader.read();
    if (this.#closing || generation.role !== "current" || this.#current !== generation) return;
    if (reading.kind === "reading") {
      const previous = this.#rateLimits?.seven_day;
      this.#rateLimits = reading.value;
      if (previous?.utilization !== reading.value.seven_day.utilization ||
          previous?.resets_at !== reading.value.seven_day.resets_at)
        this.#state(this.state);
    } else if ((reading.kind === "invalid_shape" || reading.kind === "unsupported") && this.#rateLimits) {
      this.#rateLimits = undefined;
      this.#state(this.state);
    }
  }

  send(
    text: string,
    attachmentIds?: string[],
    conversations: string[] = [],
    token: string = randomUUID(),
  ): Promise<void> {
    if (attachmentIds?.length)
      return Promise.reject(new Error("grok attachments are unsupported"));
    if (this.#closing) return Promise.reject(new Error("grok host is closed"));
    const promise = new Promise<void>((resolve, reject) => {
      this.#queue.push({ text, token, conversations, resolve, reject });
    });
    if (this.#started) void this.#drain();
    return promise;
  }

  async #awaitDispatch(): Promise<boolean> {
    let deadline: number | undefined;
    while (!this.#closing) {
      if (this.#permissions.gate) {
        deadline ??= Date.now() + (this.#options.permissionGateTimeoutMs ?? 30_000);
        this.#state("waiting_permission");
      }
      if (deadline !== undefined && Date.now() >= deadline) return false;
      let wake!: () => void;
      const awakened = new Promise<false>((resolve) => { wake = () => resolve(false); });
      this.#wake = wake;
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (deadline !== undefined) timer = setTimeout(wake, Math.max(0, deadline - Date.now()));
      try {
        const ready = await Promise.race([
          (this.#options.waitForPermissionSync?.() ?? Promise.resolve()).then(() => true), awakened,
        ]);
        if (this.#closing) return false;
        if (!ready) continue;
        if (!this.#permissions.gate && this.#permissions.next) return true;
        if (deadline === undefined) {
          deadline = Date.now() + (this.#options.permissionGateTimeoutMs ?? 30_000);
          this.#state("waiting_permission");
          timer = setTimeout(wake, Math.max(0, deadline - Date.now()));
        }
        await awakened;
      } finally { clearTimeout(timer); this.#wake = undefined; }
    }
    return false;
  }
  async #drain() {
    if (this.#draining || !this.#started || this.#closing) return;
    this.#draining = true;
    try {
      while (!this.#closing) {
        // An empty queue is an idle boundary: send what the operator chose.
        if (!this.#queue.length) {
          if (!await this.#applyPending()) break;
          continue;
        }
        const turn = this.#queue[0]!;
        let ready: boolean;
        let syncTimeout = false;
        try { ready = await this.#awaitDispatch(); }
        catch (error) {
          if (!(error instanceof PermissionSyncTimeoutError)) throw error;
          ready = false;syncTimeout = true;
        }
        if (!ready) {
          if (this.#closing) return;
          this.#queue.shift();
          const reason = syncTimeout ? "permission_sync_timeout" : "permission_gate_blocked";
          const error = syncTimeout ? new PermissionSyncTimeoutError() : new Error(reason);
          this.#options.send(makeResult(this.#options.config, new Date().toISOString(),
            syncTimeout ? permissionSyncFailure() : { text: "", is_error: true, error_code: reason }));
          if (syncTimeout) this.#state("error");
          this.#options.onTurnEnd?.({ turnToken: turn.token, conversationIds: turn.conversations,
            error: { detail: reason, reason } });
          turn.reject(error);
          this.#state("waiting_input");
          continue;
        }
        const submission = capturePermission(this.#permissions, turn.token);
        if (!submission) continue;
        let profile: SandboxProfile | undefined;
        try {
          profile = sandboxProfile(submission.requested, this.#options.cwd,
            this.#options.env ?? process.env, this.#platform);
        } catch {
          this.#permissions = permissionLaneFailed(this.#permissions, submission,
            undefined, new Date().toISOString(), "unsupported_permission_pair");
          this.#reportFailed(submission, "unsupported_permission_pair");
          this.#state(this.state);
          continue;
        }
        if (profile !== this.#current?.profile) {
          try { await this.#inLane(() => this.#replace(submission)); }
          catch (error) {
            if (this.#closing) return;
            const failedStep = error instanceof LaneFailure ? error.step : "spawn";
            // The wire has no stopping step; omit it instead of reporting a different phase.
            this.#permissions = permissionLaneFailed(this.#permissions, submission,
              failedStep === "stopping" ? undefined : failedStep, new Date().toISOString());
            this.#reportFailed(submission, "restart_failed");
            this.#state(this.state);
            continue;
          }
        }
        await this.#applyPending();
        if (this.#closing) return;
        this.#queue.shift();
        await this.#execute(turn, submission);
      }
    } finally { this.#draining = false; }
  }
  async #execute(turn: Turn, submission: PermissionSubmission) {
    this.#permissions = beginPermissionExecution(this.#permissions, submission);
    this.#active = turn;
    this.#signal = new AbortController();
    this.#text = "";
    this.#assistantText = "";
    this.#turnTokens = undefined;
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
    let permissionRejected = false;
    try {
      const response = await this.#current!.session.prompt(turn.text);
      this.#observe(submission, promptIdOf(response._meta));
      this.#settleContext(response._meta);
      const completed =
        this.#completion?.sessionId === this.#sessionId &&
        this.#completion?.promptId === promptIdOf(response._meta);
      const rejected =
        response.stopReason === "cancelled" &&
        cancellationKind(response._meta) === "rejected";
      permissionRejected = rejected;
      if (rejected) throw new Error("grok permission rejected");
      const interrupted = response.stopReason === "cancelled" && !rejected;
      this.#flushAssistantLog();
      if (!rejected && !interrupted && this.#sessionId !== undefined) {
        this.#options.recovery?.confirm(this.#sessionId);
        if (this.#options.recovery?.failure) return;
      }
      this.#event({
        kind: "result",
        subtype: rejected ? "error_during_execution" : "success",
      });
      this.#options.send(
        makeResult(
          this.#options.config,
          new Date().toISOString(),
          {
            text: clipText(this.#text).text,
            is_error: rejected,
            ...(rejected ? { error_code: "permission_rejected" } : {}),
          },
          {
            stop_reason: response.stopReason,
            completion_source: completed ? "vendor" : "prompt_response",
            ...(interrupted ? { interrupted: true } : {}),
          },
        ),
      );
      turn.resolve();
    } catch (cause) {
      error = cause instanceof Error ? cause : new Error("grok turn failed");
      if (this.#permissions.current?.submission.execution_id === submission.execution_id &&
        this.#permissions.current.status === "applying") this.#observe(submission, undefined);
      this.#flushAssistantLog();
      this.#event({ kind: "result", subtype: "error_during_execution" });
      this.#options.send(
        makeResult(this.#options.config, new Date().toISOString(), {
          text: "",
          is_error: true,
          error_code: permissionRejected
            ? "permission_rejected"
            : "grok_turn_failed",
        }),
      );
      turn.reject(error);
    } finally {
      clearTimeout(this.#timer);
      clearTimeout(this.#abortTimer);
      this.#signal?.abort();
      this.#signal = undefined;
      this.#active = undefined;
      this.#options.onTurnEnd?.({
        turnToken: turn.token,
        conversationIds: turn.conversations,
        ...(error ? { error: { detail: "grok turn failed" } } : {}),
      });
      if (!this.#closing) this.#state("waiting_input");
      const generation = this.#current;
      if (!this.#closing && generation) void this.#refreshRateLimits(generation);
    }
  }

  #progress() {
    clearTimeout(this.#timer);
    if (
      !this.#active ||
      this.#closing ||
      this.#pendingPermission ||
      this.#pendingQuestion
    )
      return;
    this.#timer = setTimeout(() => {
      this.close();
    }, this.#settings.inactivityMs);
  }
  #update(notification: acp.SessionNotification) {
    if (notification.sessionId !== this.#sessionId) return;
    if (notification.update.sessionUpdate === "config_option_update") {
      const selection = parseSelection(notification.update.configOptions);
      if (selection) this.#confirmSelection(selection.model, selection.effort);
      return;
    }
    if (!this.#active) return;
    this.#progress();
    const update = updateEvents(notification);
    if (update.log && update.log.kind !== "assistant") this.#flushAssistantLog();
    for (const event of update.events) this.#event(event);
    if (update.text) {
      this.#text += update.text;
      this.#assistantText += update.text;
    }
    if (update.log)
      this.#options.send(
        makeLog(
          this.#options.config,
          this.state,
          new Date().toISOString(),
          update.log,
        ),
      );
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
  // Grok sends the session_start hook after the session/new or session/load
  // response, often while the generation is still loading (issue #633). Its
  // metadata is held and published only if the generation is promoted. The
  // load replay is not held.
  #hold(generation: Generation, metadata: GrokWireMetadata) {
    if (metadata.method && LOAD_REPLAY_METHODS.has(metadata.method)) return;
    if (generation.held.length < LOADING_METADATA_LIMIT) generation.held.push(metadata);
    else generation.heldDropped += 1;
  }
  #flushHeld(generation: Generation) {
    const held = generation.held;
    const dropped = generation.heldDropped;
    generation.held = [];
    generation.heldDropped = 0;
    if (dropped > 0) held.push({ direction: "in", loading_lines_dropped: dropped });
    for (const metadata of held) {
      try {
        this.#options.onMetadata?.(metadata);
      } catch {
        /* Diagnostics must not fail the promotion. */
      }
    }
  }
  #vendor(notification: Record<string, unknown>) {
    const completion = turnCompletion(notification, this.#sessionId);
    if (completion) this.#completion = completion;
    const sessionId = notification.sessionId ?? notification.session_id;
    if (sessionId !== this.#sessionId) return;
    const tokens = promptTokens(notification);
    if (tokens !== undefined && this.#active) this.#turnTokens = tokens;
    const reported = reportedSelection(notification);
    if (reported) this.#confirmSelection(reported.model, reported.effort);
  }
  // model_changed and config_option_update only confirm what a request
  // returned. A disagreement is logged and the returned value stays.
  #confirmSelection(model: string | undefined, effort: string | undefined) {
    const held = this.#selection;
    if (!held || !this.#switchable || this.#inflight.model || this.#inflight.effort) return;
    if ((model !== undefined && model !== held.model) || (effort !== undefined && effort !== held.effort))
      writeRedactedStderr("[kaoiro] grok reported a model or effort other than the one it last returned\n");
  }
  // The reading of a turn is its last model call's prompt size, against the
  // window of the model the turn ran on. A turn that made no call keeps the
  // last reading.
  #settleContext(meta: unknown) {
    const tokens = this.#turnTokens;
    this.#turnTokens = undefined;
    const model = this.#selection?.model;
    if (tokens === undefined || !this.#switchable || model === undefined) return;
    const reported = (meta as Record<string, unknown> | null | undefined)?.modelId;
    if (typeof reported === "string" && reported !== model) {
      writeRedactedStderr("[kaoiro] grok ran a turn on a model other than the selected one; its context reading is withdrawn\n");
      this.#contextGeneration += 1;
      return;
    }
    const max = this.#catalog.find((entry) => entry.value === model)?.window;
    if (max === undefined) return;
    this.#context = { generation: this.#contextGeneration, used: tokens, max };
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
      request.toolCall.title ?? "grok tool",
      { ...input, tool_call_id: request.toolCall.toolCallId },
      alive,
    );
    const kind = decision.allow ? "allow_once" : "reject_once";
    const option = request.options.find((o) => o.kind === kind);
    return option
      ? { outcome: { outcome: "selected", optionId: option.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }
  async interrupt() {
    if (!this.#active) return;
    this.#abortTimer = setTimeout(
      () => this.close(),
      Math.min(this.#settings.abortGraceMs, 3_000),
    );
    await this.#current?.session.cancel();
  }
  close() {
    if (this.#closing) return;
    this.#closing = true;
    this.#lifetime.abort();
    clearTimeout(this.#timer);
    clearTimeout(this.#abortTimer);
    this.#signal?.abort();
    for (const turn of this.#queue.splice(0)) {
      turn.reject(new Error("grok host is closed"));
      this.#options.onTurnEnd?.({
        turnToken: turn.token,
        conversationIds: turn.conversations,
        error: { detail: "grok host closed" },
      });
    }
    this.#wake?.();
    void this.#inLane(async () => {
      await this.#retire(this.#loading);
      await this.#retire(this.#current);
    }).finally(() => this.#resolveClosed());
  }

  async setModel(value: string) {
    const selection = this.#requireSwitchable("model");
    if (!this.#catalog.some((entry) => entry.value === value))
      return this.#rejectSwitch("model", value, selection.model);
    this.#pending = { ...this.#pending, model: { value, source: "config", operator: true } };
    this.#state(this.state);
    void this.#drain();
  }
  async setEffort(value: string) {
    const selection = this.#requireSwitchable("effort");
    const target = this.#pending.model?.value ?? this.#inflight.model?.value ?? selection.model;
    const levels = this.#catalog.find((entry) => entry.value === target)?.effort_levels ?? [];
    if (!levels.includes(value)) return this.#rejectSwitch("effort", value, selection.effort);
    this.#pending = { ...this.#pending, effort: { value, source: "config", operator: true } };
    this.#state(this.state);
    void this.#drain();
  }
  #requireSwitchable(kind: "model" | "effort") {
    if (this.#closing) throw new Error("grok host is closed");
    if (!this.#switchable || !this.#selection) throw new Error(`grok ${kind} switching is unsupported`);
    return this.#selection;
  }
  #rejectSwitch(kind: "model" | "effort", requested: string, rolledBackTo: string) {
    this.#switchErrorOnce = { kind, requested, reason: "control_rejected", rolled_back_to: rolledBackTo };
    this.#state(this.state);
  }
  // Takes what Grok reports for a generation as the truth: the catalog from
  // initialize, the selection from configOptions. Switching is offered only
  // when both selects exist and every model they list has a catalog entry.
  #adoptGeneration(generation: Generation) {
    const selection = parseSelection(generation.session.configOptions);
    const known = new Set(generation.models.map((entry) => entry.value));
    const switchable = selection !== undefined && known.size > 0 && selection.models.every((value) => known.has(value))
      && known.has(selection.model);
    const previous = this.#switchable ? this.#selection : undefined;
    this.#catalog = generation.models;
    this.#switchable = switchable;
    this.#setSelection(switchable ? { model: selection.model, effort: selection.effort } : undefined);
    if (!switchable) {
      this.#dropUnappliable();
      return;
    }
    // A later generation (session/load after a permission switch) keeps each
    // source unless Grok now holds a different value than it last returned.
    for (const axis of ["model", "effort"] as const)
      this.#reconcile(axis, previous?.[axis], selection[axis], "after a restart");
    const model = this.#pending.model;
    if (model && !known.has(model.value)) {
      // Not in the catalog: rejected without a request, as setModel would.
      const { model: _rejected, ...rest } = this.#pending;
      this.#pending = rest;
      this.#switchErrorOnce = { kind: "model", requested: model.value, reason: "control_rejected", rolled_back_to: selection.model };
      if (!model.operator) {
        // The start effort was chosen for that model; it is held with it.
        this.#holdAxis("model", model);
        const effort = this.#pending.effort;
        if (effort && !effort.operator) {
          const { effort: _effort, ...remaining } = this.#pending;
          this.#pending = remaining;
          this.#holdAxis("effort", effort);
        }
      }
    }
    // A requested value Grok already holds needs no request; it takes its
    // source now. The effort waits while a model change is pending, because
    // the change can reset it.
    if (this.#pending.model?.value === selection.model) this.#settle("model");
    if (!this.#pending.model && this.#pending.effort?.value === selection.effort) this.#settle("effort");
  }
  // An axis this host did not just set: a held axis is released once Grok
  // holds the requested value; otherwise a value that changed since Grok last
  // returned it no longer has the source recorded for the old one.
  #reconcile(axis: Axis, before: string | undefined, after: string, when: string) {
    const held = this.#held[axis];
    if (held?.value === after) {
      this.#release(axis);
      this.#setSource(axis, held.source);
      return;
    }
    if (before !== undefined && before !== after && !this.#pending[axis] && !held) {
      writeRedactedStderr(`[kaoiro] grok holds a different ${axis} ${when} than it returned before\n`);
      this.#setSource(axis, "default");
    }
  }
  #settle(axis: Axis) {
    const request = this.#pending[axis];
    if (!request) return;
    const { [axis]: _settled, ...rest } = this.#pending;
    this.#pending = rest;
    this.#release(axis);
    this.#setSource(axis, request.source);
    if (request.operator) this.#operatorSwitched.add(axis);
  }
  #holdAxis(axis: Axis, request: AxisRequest) {
    this.#held = { ...this.#held, [axis]: request };
  }
  #release(axis: Axis) {
    const { [axis]: _released, ...rest } = this.#held;
    this.#held = rest;
  }
  #setSource(axis: Axis, source: ModelSource) {
    if (axis === "model") this.#modelSource = source;
    else this.#effortSource = source;
  }
  // Without usable configOptions nothing can be applied.
  #dropUnappliable() {
    if (!this.#pending.model && !this.#pending.effort) return;
    writeRedactedStderr("[kaoiro] grok offers no model or effort selection; the requested one is not applied\n");
    const request = this.#pending.model ?? this.#pending.effort!;
    this.#switchErrorOnce = { kind: this.#pending.model ? "model" : "effort", requested: request.value,
      reason: "control_rejected", rolled_back_to: "default" };
    for (const axis of ["model", "effort"] as const) {
      const pending = this.#pending[axis];
      if (pending && !pending.operator) this.#holdAxis(axis, pending);
    }
    this.#pending = {};
  }
  // A different model withdraws the context reading until a turn finishes on it.
  #setSelection(next: { model: string; effort: string } | undefined) {
    if (this.#selection && this.#selection.model !== next?.model) this.#contextGeneration += 1;
    this.#selection = next;
  }
  async #applyPending(): Promise<boolean> {
    const generation = this.#current;
    if (!generation || this.#loading || this.#active || this.#closing || !this.#switchable) return false;
    if (this.#pending.model === undefined && this.#pending.effort === undefined) return false;
    // Claim the values before the first await, so no second entry sends them.
    const claimed = (this.#inflight = this.#pending);
    this.#pending = {};
    try {
      await this.#sendSwitch(generation, claimed);
    } finally {
      this.#inflight = {};
    }
    if (!this.#closing) this.#state(this.state);
    return true;
  }
  async #sendSwitch(generation: Generation, claimed: AxisRecord) {
    const held = this.#selection!;
    const target = claimed.model?.value ?? held.model;
    if (target !== held.model) {
      const failure = await this.#setOption(generation, "model", target);
      if (failure === "closing") return;
      if (failure) {
        this.#switchErrorOnce = { kind: "model", requested: target, reason: "control_rejected", rolled_back_to: held.model };
        // A start pick that failed is held, with the effort chosen for it.
        if (claimed.model && !claimed.model.operator) this.#holdAxis("model", claimed.model);
        if (claimed.effort && !claimed.effort.operator) this.#holdAxis("effort", claimed.effort);
        // Unit 4's failure contract: an operator effort is dropped unsent.
        return;
      }
    }
    if (claimed.model) this.#confirmAxis("model", claimed.model);
    const now = this.#selection!;
    const entry = this.#catalog.find((candidate) => candidate.value === now.model);
    let effort = claimed.effort?.value ?? held.effort;
    let reset = false;
    if (entry && entry.effort_levels.length > 0 && !entry.effort_levels.includes(effort) && entry.default_effort) {
      effort = entry.default_effort;
      reset = true;
    }
    if (effort !== now.effort) {
      const failure = await this.#setOption(generation, "reasoning_effort", effort);
      if (failure === "closing") return;
      if (failure) {
        this.#switchErrorOnce ??= { kind: "effort", requested: effort,
          reason: reset ? "effort_reset_failed" : "control_rejected", rolled_back_to: now.effort };
        if (!reset && claimed.effort && !claimed.effort.operator) this.#holdAxis("effort", claimed.effort);
        return;
      }
    }
    // A substitution is recorded whether or not Grok needed a request for it.
    if (reset) {
      // Unit 4's reset contract: the substituted default is a config value.
      this.#release("effort");
      this.#effortSource = "config";
      this.#effortResetOnce = true;
    } else if (claimed.effort) {
      this.#confirmAxis("effort", claimed.effort);
    } else if (effort !== now.effort) {
      this.#confirmAxis("effort", { value: effort, source: "config", operator: true });
    }
  }
  #confirmAxis(axis: Axis, request: AxisRequest) {
    this.#release(axis);
    this.#setSource(axis, request.source);
    if (request.operator) this.#operatorSwitched.add(axis);
  }
  // Sends one request and adopts the configOptions it returns. Resolves to
  // why it did not apply, or undefined when it did.
  async #setOption(generation: Generation, id: "model" | "reasoning_effort", value: string): Promise<"failed" | "closing" | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SwitchTimeout()),
        this.#options.switchTimeoutMs ?? SWITCH_TIMEOUT_MS);
    });
    try {
      await Promise.race([generation.session.setConfigOption(id, value), expired]);
      const selection = parseSelection(generation.session.configOptions);
      if (!selection) throw new Error("grok returned no model or effort selection");
      const before = this.#selection;
      this.#setSelection({ model: selection.model, effort: selection.effort });
      const unsent = id === "model" ? "effort" : "model";
      this.#reconcile(unsent, before?.[unsent], selection[unsent], `after a ${id} switch`);
      return undefined;
    } catch (error) {
      if (this.#closing) return "closing";
      if (error instanceof SwitchTimeout) {
        this.#generationFailed(generation, error);
        return "closing";
      }
      return "failed";
    } finally {
      clearTimeout(timer);
    }
  }
  async setPermission(value: PermissionSelection) {
    if (this.#platform !== "linux" || !this.#permissions.syncSupported)
      throw new Error("grok permission switching was not negotiated; permissions are fixed");
    if (value.revision <= (this.#permissions.latest?.revision ?? 0)) return;
    let refusal: string | undefined;
    if (!withinCeiling(value, this.#ceiling)) refusal = "exceeds_launch_ceiling";
    else {
      try { sandboxProfile(value.requested, this.#options.cwd, this.#options.env ?? process.env, this.#platform); }
      catch { refusal = "unsupported_permission_pair"; }
    }
    this.#permissions = requestPermission(this.#permissions, value, refusal);
    if (refusal) this.#reportFailed(value, refusal);
    this.#state(this.state);
    this.#wake?.();
  }
  setPermissionSyncSupported(supported: boolean) {
    this.#permissions = setPermissionSyncSupport(this.#permissions, this.#platform === "linux" && supported);
    this.#state(this.state);
    this.#wake?.();
  }
  applyPermissionSync(message: PermissionSyncMessage) {
    this.#permissions = applyPermissionSyncState(this.#permissions, message, this.#ceiling, new Date().toISOString());
    this.#state(this.state);
    this.#wake?.();
  }
  #reportFailed(selection: Selection, reason: string) {
    if (selection.revision > 0) this.#options.onPermissionLifecycle?.({ version: "0",
      kind: "permission_failed", at: new Date().toISOString(),
      details: { revision: selection.revision, requested: selection.requested, reason } });
  }
  #observe(submission: PermissionSubmission, promptId: unknown) {
    if (!this.#permissions.latest) return;
    if (typeof promptId === "string" && promptId.length > 0) {
      const observation = { ...submission, session_id: this.#sessionId!, turn_id: promptId,
        permission: { sandbox: submission.requested.sandbox, approval: "on-request" as const,
          ...(this.#current!.profile === "off" ? {} : { enforcement: "os" as const }) },
        network_access: effectiveNetworkAccess(submission.requested) };
      const applied = permissionObservationApplied(this.#permissions, observation);
      this.#permissions = applied.state;
      if (applied.emitAudit) this.#options.onPermissionLifecycle?.({ version: "0",
        kind: "permission_applied", at: new Date().toISOString(), details: observation });
    } else {
      this.#permissions = permissionObservationFailed(this.#permissions, submission, new Date().toISOString());
      this.#reportFailed(submission, "observation_unavailable");
    }
    this.#state(this.state);
  }
  async setPermissionMode(_value: PermissionMode) {
    throw new Error("grok permission mode is unsupported");
  }
  setPendingPermission(pending: PendingPermissionExt | null) {
    if (pending) this.#flushAssistantLog();
    this.#pendingPermission = pending;
    if (pending) {
      clearTimeout(this.#timer);
      this.#event({ kind: "permission_request" });
    } else if (this.#active) {
      this.#event({ kind: "permission_resolved" });
      this.#progress();
    }
  }
  setPendingQuestion(pending: PendingQuestionExt | null) {
    if (pending) this.#flushAssistantLog();
    this.#pendingQuestion = pending;
    if (pending) {
      clearTimeout(this.#timer);
      this.#event({ kind: "question_request" });
    } else if (this.#active) {
      this.#event({ kind: "question_resolved" });
      this.#progress();
    }
  }
  renameDisplayName(name: string, revision: number) {
    if (revision <= this.#revision) return;
    this.#revision = revision;
    this.#options.config.display_name = name;
    this.#state(this.state);
  }
}
