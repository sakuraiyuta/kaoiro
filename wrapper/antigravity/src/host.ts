import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { RequestError, type PromptResponse, type SessionNotification } from "@agentclientprotocol/sdk";
import { selfCommand, type RecoveryReporter } from "@kaoiro/wrapper-core";
import {
  boundErrorDetail,
  clipText,
  initialMachineState,
  logEntryToPayload,
  makeLog,
  makeResult,
  makeStateChange,
  mergeExtraModels,
  permissionSyncFailure,
  stepState,
  withAgentMarker,
  writeRedactedStderr,
  type EngineAdapter,
  type Envelope,
  type InterAgentErrorClassifyInput,
  type KaoiroState,
  type LogEntry,
  type MachineState,
  type PendingPermissionExt,
  type PendingQuestionExt,
  type PermissionBroker,
  type PermissionMode,
  type PermissionSelection,
  type QuestionBroker,
  type ToolDescriptor,
  type WrapperConfig,
} from "@kaoiro/agent-common";
import type { AcpSession } from "@kaoiro/agent-common/dist/acp/session.js";
import { MCP_NOT_CONNECTED, ToolHost } from "@kaoiro/agent-common/dist/toolhost.js";
import { PermissionSyncTimeoutError } from "@kaoiro/wrapper-core";
import type {
  EngineModelInfo,
  PermissionAxesExt,
  PermissionConfiguration,
  PermissionControlExt,
  PermissionObservation,
  PermissionSubmission,
  PermissionSyncMessage,
  WrapperPermissionLifecycleMessage,
} from "@kaoiro/protocol";
import { activityProjection, classifyUpdate, toolName } from "./acp_events.js";
import { CallVerifier, type VerificationFault } from "./call_verification.js";
import { antigravityCatalogSnapshot, parseAgyModelsOutput } from "./catalog.js";
import { DEFAULT_AGY_PROBE_TIMEOUT_MS, resolveAgyExecutable, type AgyExecutableResolution } from "./cli-path.js";
import {
  CustomizationDir,
  GATE_DEADLINE_MS,
  checkHookList,
  sweepStaleCustomizationDirs,
} from "./customization.js";
import { AcpToolPolicy, type AntigravityLaunchConfig } from "./gate.js";
import { Generation, type AcpAgyChild, type StartSession } from "./generation.js";
import { HookGateServer, type HookGateServerOptions, type PreToolUseRequest } from "./hook_gate.js";
import { reportedPair, splitSlug, switchModel } from "./model_selection.js";
import { effectiveNetworkAccess } from "./network_access.js";
import { ceilingExceeded, type SwitchCeiling } from "./permission_switch.js";
import { answerStop, type StopRequest } from "./stop_answer.js";
import { antigravitySubcommandPrefix } from "./subcommand.js";
import { signalSubtree, signalTarget, terminateWithGrace, type GraceTerminationHandle, type SignalTargetOperation } from "./subtree_termination.js";
import { nonInteractiveToolEnv } from "./tool_child_env.js";
import type { TurnWatchdogInterruptCause } from "./turn_watchdog.js";
import { DEFAULT_TURN_WATCHDOG_ABORT_GRACE_MS, DEFAULT_TURN_WATCHDOG_INACTIVITY_MS } from "./turn_watchdog.js";

/** Below the runner's reset-relaunch grace (5 s), which can SIGKILL this
 *  wrapper while a close is pending. */
const DEFAULT_CLOSE_GRACE_MS = 2_000;
const DEFAULT_MCP_READY_TIMEOUT_MS = 15_000;
const GATE_FAULT_REASON = "antigravity_gate_unobserved_tool";
const TAMPER_REASON = "antigravity_customization_tampered";
const UNEXPECTED_PERMISSION_REASON = "antigravity_unexpected_permission_request";
const DELIVERY_UNCONFIRMED = "antigravity_delivery_unconfirmed";
const AUTH_REQUIRED = "antigravity_auth_required";

/** The identifying fields of the "Authentication required" error captured
 *  from `agy` 1.5.14 without credentials. */
function isAuthRequired(error: RequestError): boolean {
  return error.code === -32000 && error.message === "Authentication required";
}

/** The first action of a stop decides its deadline (design L3). */
type StopRoute = "interrupt" | "watchdog" | "gate_fault" | "permission" | "close" | "pre_ack" | "fail_stop";

export type GenerationEndReason = "retired" | "start_failed" | StopRoute;

interface Input {
  text: string;
  conversationIds?: readonly string[];
  turnToken?: string;
}

/** Why the prompt's wait ended. */
type Settlement =
  | { kind: "response"; response: PromptResponse }
  | { kind: "rpc_error"; error: RequestError }
  | { kind: "closed" }
  | { kind: "stopped" }
  | { kind: "skipped" }
  | { kind: "start_failed"; detail: string; permissionSyncTimeout?: boolean; apiError?: boolean };

interface StepHandlers<T> {
  /** Writes what the step's value means for the host, while owned. */
  publish?: (value: T) => void;
  /** Takes a value that arrived after ownership ended. */
  release?: (value: T) => void;
  /** Maps an error while owned; a throw replaces it. */
  refuse?: (error: unknown) => void;
}

type ModelOutcome =
  | { kind: "none" }
  | { kind: "commit"; value: string }
  | { kind: "switch_error"; requested: string; reason: string; rolledBackTo?: string };

interface Active {
  token: string;
  conversationIds: readonly string[];
  /** The input's ownership of its start (design 4.4). Aborted, with its
   *  reason, by the first stop, by the readiness bound and by settlement; a
   *  start step, its continuation and the hand-off act only before that. */
  readonly owner: AbortController;
  stop: StopRoute | null;
  interruptedAt: string | null;
  generation: Generation | null;
  toolHost: ToolHost | null;
  gateServer: HookGateServer | null;
  verifier: CallVerifier | null;
  probe: { stop(): void } | null;
  sessionId: string | undefined;
  observedSessionId: string | undefined;
  window: AbortController | null;
  delivery: "pending" | "attempted" | "confirmed";
  acked: boolean;
  /** The prompt's wait ended. */
  resolved: boolean;
  /** The outcome was decided (design L2); nothing changes it afterwards. */
  settled: boolean;
  settle: ((settlement: Settlement) => void) | null;
  preAckTimer: unknown;
  abortDeadline: { atMs: number; timer: unknown } | null;
  termination: GraceTerminationHandle | null;
  gateFault: string | null;
  toolTimeout: boolean;
  unexpectedPermission: boolean;
  processError: string | null;
  submission: PermissionSubmission | null;
  evidence: boolean;
  continuations: number;
  seenCalls: Set<string>;
  steps: Map<string, number>;
  text: string;
  assistantText: string;
  resultText: string;
}

class Stopped extends Error {
  constructor() {
    super("antigravity input stopped");
  }
}

/** A failed start step. `cause` and `restoreCause` keep the errors it wraps,
 *  which classification reads (design 4.5). */
class StartFailure extends Error {
  readonly restoreCause: unknown;
  constructor(detail: string, causes: { cause?: unknown; restoreCause?: unknown } = {}) {
    super(detail, causes.cause === undefined ? undefined : { cause: causes.cause });
    this.restoreCause = causes.restoreCause;
  }
}

/** The RPC errors a start failure carries: the error itself, its `cause` and
 *  its `restoreCause`, each followed down `.cause` to depth 4. */
function wrappedRpcErrors(error: unknown): RequestError[] {
  const roots = error instanceof Error
    ? [error, error.cause, (error as { restoreCause?: unknown }).restoreCause]
    : [error];
  const found: RequestError[] = [];
  for (const root of roots) {
    let node: unknown = root;
    for (let depth = 0; depth <= 4 && node !== undefined; depth += 1) {
      if (node instanceof RequestError) found.push(node);
      node = node instanceof Error ? node.cause : undefined;
    }
  }
  return found;
}

export interface SpawnedAgy extends AcpAgyChild {}

export interface GateProbe {
  stdout: NodeJS.ReadableStream;
  stderr?: NodeJS.ReadableStream | null;
  once(event: "close" | "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  kill?(signal?: NodeJS.Signals): boolean;
}

export interface AntigravityHostOptions {
  recovery?: RecoveryReporter;
  cwd: string;
  appendSystemPrompt: string;
  onState: (envelope: Envelope) => void;
  onLog?: (envelope: Envelope) => void;
  onSessionId?: (sessionId: string) => void;
  onPermissionLifecycle?: (event: WrapperPermissionLifecycleMessage) => void;
  /** The delivery acknowledgement: fired once per prompt, after delivery is
   *  confirmed (design L7). */
  onTurnStart?: (info: { turnToken: string; conversationIds: readonly string[] }) => void;
  /** Synchronous final check before the prompt is written. */
  prepareInput?: (turnToken: string) => { text: string; conversationIds: readonly string[] } | null | undefined;
  onTurnEnd?: (info: {
    turnToken: string;
    conversationIds: readonly string[];
    error?: InterAgentErrorClassifyInput;
    cancellation?:
      | { kind: "watchdog_fail_stop"; started: false }
      | { kind: "interrupt"; reason: "interrupted" };
    /** True when `agy` answered the prompt (any stop reason), not when the
     *  turn succeeded. */
    terminal: boolean;
  }) => void;
  onTurnBoundary?: (info: { turnToken: string }) => void;
  onTurnProgress?: (info: { turnToken: string }) => void;
  /** One `agy acp` process exited. */
  onGenerationEnded?: (info: { serial: number; reason: GenerationEndReason; code: number | null; signal: NodeJS.Signals | null }) => void;
  /** Activity or other input outside a prompt's window: recorded with its
   *  kind and call ID only, never projected onto a turn. */
  onOutOfTurnEvent?: (info: { eventKind: string; callId?: string }) => void;
  onToolStart?: (info: { turnToken: string; stepIndex: number; toolName: string }) => void;
  onToolEnd?: (info: { turnToken: string; stepIndex: number }) => void;
  onWatchdogFailStop?: (info: { turnToken?: string; conversationIds: readonly string[]; attribution: "exact" | "unattributed" }) => void;
  onInterruptRequested?: (info: { turnToken: string; pendingPermission: boolean; pendingQuestion: boolean; childPid: number | null }) => void;
  onInterruptSettled?: (info: { turnToken: string; exitCode: number | null; signal: NodeJS.Signals | null; elapsedMs: number }) => void;
  /** The gate fault latched (design D3): admission stays closed until the
   *  wrapper restarts or the session is reset. */
  onGateFault?: (info: { reason: string; detail: string }) => void;
  onSendRejected?: (info: {
    turnToken?: string;
    conversationIds?: readonly string[];
    reason: "closed" | "gate_broken" | "watchdog_fail_stopped" | "attachments_unsupported";
  }) => void;
  toolDescriptors?: ToolDescriptor[];
  permissionBroker: PermissionBroker;
  questionBroker?: Pick<QuestionBroker, "close">;
  resumeSessionId?: string;
  permissionSyncSupported?: boolean;
  waitForPermissionSync?: () => Promise<void>;
  nodePath?: string;
  nodeArgs?: readonly string[] | undefined;
  entryPath?: string;
  agyPath?: string;
  spawn?: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => SpawnedAgy;
  /** Test-only seam. Production uses the checked PID/process-group signal gate. */
  signalTarget?: SignalTargetOperation;
  toolHostListen?: (descriptors: ToolDescriptor[], options: { turnSignal: () => AbortSignal | null }) => Promise<ToolHost>;
  gateServerListen?: (options: HookGateServerOptions) => Promise<HookGateServer>;
  probeSpawn?: (command: string, args: string[], options: { cwd: string }) => GateProbe;
  modelsProbeSpawn?: (command: string, args: string[], options: { cwd: string }) => GateProbe;
  gateProbeTimeoutMs?: number;
  /** The grace a cancel waits before SIGKILL (design L3). */
  abortGraceMs?: number;
  /** The grace of close and of ordinary retirement. */
  closeGraceMs?: number;
  /** The bound on an unconfirmed delivery: the watchdog's inactivity timeout. */
  preAckBoundMs?: number;
  mcpReadyTimeoutMs?: number;
  probeModels?: () => Promise<EngineModelInfo[] | null>;
  warn?: (message: string) => void;
  now?: () => string;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  nowMs?: () => number;
}

export function initialStatusExt(
  config: AntigravityLaunchConfig,
  models = mergeExtraModels(antigravityCatalogSnapshot(), config.antigravity_extra_models),
  permissionSyncSupported = false,
): Record<string, unknown> {
  const sandbox = config.sandbox ?? "workspace-write";
  const approval = config.approval ?? "on-request";
  const ceiling =
    config.max_sandbox !== undefined && config.max_approval !== undefined && config.max_network_access !== undefined
      ? { max_sandbox: config.max_sandbox, max_approval: config.max_approval, max_network_access: config.max_network_access }
      : null;
  return {
    engine: "antigravity",
    model: config.model ?? "",
    ...(config.model_source === undefined ? {} : { model_source: config.model_source }),
    models,
    supports_effort_switch: false,
    permission: { sandbox, approval, enforcement: "advisory" },
    network_access: effectiveNetworkAccess(sandbox, config.network_access ?? false),
    ...(ceiling !== null && permissionSyncSupported
      ? { supports_permission_switch: true, permission_switch_axes: ["sandbox", "network_access", "approval"], ...ceiling }
      : {}),
  };
}

export class AntigravityHost implements EngineAdapter {
  readonly #config: AntigravityLaunchConfig;
  readonly #options: AntigravityHostOptions;
  readonly #signalTarget: SignalTargetOperation;
  readonly #now: () => string;
  readonly #nowMs: () => number;
  readonly #setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly #clearTimer: (timer: unknown) => void;
  readonly #agyExecutable: AgyExecutableResolution;
  readonly #probeTimeoutMs: number;
  readonly #abortGraceMs: number;
  readonly #closeGraceMs: number;
  readonly #preAckBoundMs: number;
  #machine: MachineState = initialMachineState();
  #closed = false;
  #failStopped = false;
  #gateFault: { reason: string; detail: string } | null = null;
  #queue: Input[] = [];
  #draining = false;
  #active: Active | null = null;
  #previousExit: Promise<unknown> = Promise.resolve();
  #sessionId: string | null;
  #announcedSessionId: string | null = null;
  #serial = 0;
  #running: Promise<void> | null = null;
  #customization: CustomizationDir | null = null;
  #catalog: EngineModelInfo[];
  #pendingModel: string | null = null;
  #switchError: Record<string, unknown> | null = null;
  #pendingPermission: PendingPermissionExt | null = null;
  #pendingQuestion: PendingQuestionExt | null = null;
  #leases = new Map<string, { turnToken: string; source: "native" | "mcp" }>();
  #lastRevision = 0;
  #pendingPermissionSwitch: { revision: number; requested: PermissionConfiguration } | null = null;
  #permissionControl: PermissionControlExt | null = null;
  #lastEffectivePermission: PermissionObservation | null = null;
  #permissionSyncSupported: boolean;
  readonly #toolNames = new Map<string, string>();
  #closePromise: Promise<void> | null = null;

  constructor(config: WrapperConfig, options: AntigravityHostOptions) {
    this.#config = config as AntigravityLaunchConfig;
    if (this.#config.approval === "on-failure") {
      throw new Error("antigravity approval=on-failure is unsupported");
    }
    this.#catalog = mergeExtraModels(antigravityCatalogSnapshot(), this.#config.antigravity_extra_models);
    this.#options = options;
    this.#signalTarget = options.signalTarget ?? signalTarget;
    this.#agyExecutable = options.agyPath === undefined
      ? resolveAgyExecutable(this.#config.antigravity_cli_path)
      : { ok: true, path: options.agyPath };
    this.#probeTimeoutMs = options.gateProbeTimeoutMs ?? this.#config.antigravity_probe_timeout_ms ?? DEFAULT_AGY_PROBE_TIMEOUT_MS;
    this.#abortGraceMs = options.abortGraceMs ?? DEFAULT_TURN_WATCHDOG_ABORT_GRACE_MS;
    this.#closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    this.#preAckBoundMs = options.preAckBoundMs ?? DEFAULT_TURN_WATCHDOG_INACTIVITY_MS;
    this.#sessionId = options.resumeSessionId ?? null;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#nowMs = options.nowMs ?? (() => performance.now());
    this.#setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as never));
    this.#permissionSyncSupported = options.permissionSyncSupported ?? false;
    if (this.#permissionSyncSupported) this.#permissionControl = this.#baselineControl();
    sweepStaleCustomizationDirs();
    void this.#refreshCatalog();
  }

  get abortGraceMs(): number {
    return this.#abortGraceMs;
  }

  get state(): KaoiroState {
    return this.#gateFault !== null ? "error" : this.#machine.state;
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

  async send(text: string, attachmentIds?: string[], conversationIds?: readonly string[], turnToken?: string): Promise<void> {
    const reject = (reason: "closed" | "gate_broken" | "watchdog_fail_stopped" | "attachments_unsupported"): void =>
      this.#notifySendRejected({
        ...(turnToken === undefined ? {} : { turnToken }),
        ...(conversationIds === undefined || conversationIds.length === 0 ? {} : { conversationIds }),
        reason,
      });
    if (this.#failStopped) return reject("watchdog_fail_stopped");
    if (this.#closed) return reject("closed");
    if (this.#gateFault !== null) return reject("gate_broken");
    if (attachmentIds !== undefined && attachmentIds.length > 0) {
      this.#warn("antigravity: attachments are unsupported");
      return reject("attachments_unsupported");
    }
    this.#apply({ kind: "user_send" });
    this.#queue.push({
      text,
      ...(conversationIds === undefined || conversationIds.length === 0 ? {} : { conversationIds }),
      ...(turnToken === undefined ? {} : { turnToken }),
    });
    void this.#drain();
  }

  /** The turn token inter-agent tools act for, only while a prompt's window
   *  is open. */
  activeInterAgentTurnToken(): string | null {
    const active = this.#active;
    return active !== null && active.window !== null && !active.settled ? active.token : null;
  }

  beginPermissionWaitLease(turnToken: string, source: "native" | "mcp"): string | null {
    const active = this.#active;
    if (
      this.#closed ||
      active === null ||
      active.token !== turnToken ||
      active.window === null ||
      active.settled ||
      active.stop !== null
    ) return null;
    const leaseId = randomUUID();
    const wasEmpty = this.#leases.size === 0;
    this.#leases.set(leaseId, { turnToken, source });
    if (wasEmpty) this.#apply({ kind: "permission_request" });
    return leaseId;
  }

  endPermissionWaitLease(leaseId: string): boolean {
    const owner = this.#leases.get(leaseId);
    if (owner === undefined) return false;
    this.#leases.delete(leaseId);
    if (this.#leases.size !== 0) return true;
    const active = this.#active;
    if (active !== null && active.token === owner.turnToken && !active.settled && this.#machine.state === "waiting_permission") {
      this.#apply({ kind: "permission_resolved" });
    }
    return true;
  }

  async interrupt(): Promise<void> {
    const active = this.#active;
    this.#options.permissionBroker.close();
    this.#options.questionBroker?.close();
    this.#clearPendingAfterStop();
    if (active === null || active.settled) return;
    if (active.interruptedAt === null) {
      active.interruptedAt = this.#now();
      this.#options.onInterruptRequested?.({
        turnToken: active.token,
        pendingPermission: this.#pendingPermission !== null,
        pendingQuestion: this.#pendingQuestion !== null,
        childPid: active.generation?.child.pid ?? null,
      });
    }
    this.#stopActive(active, "interrupt");
  }

  /** The watchdog's interrupt: cancels the prompt; the watchdog owns the
   *  grace. */
  requestInterruptForTurn(turnToken: string, cause?: TurnWatchdogInterruptCause): boolean {
    const active = this.#active;
    if (active === null || active.token !== turnToken || active.settled || this.#closed) return false;
    if (cause?.kind === "tool_timeout") active.toolTimeout = true;
    return this.#stopActive(active, "watchdog");
  }

  failStopTurnForWatchdog(turnToken: string): boolean {
    const active = this.#active;
    if (this.#failStopped || this.#closed || active === null || active.token !== turnToken) return false;
    return this.#failStop("exact");
  }

  failStopForWatchdogAttributionUnknown(): boolean {
    if (this.#failStopped) return false;
    return this.#failStop("unattributed");
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closed = true;
    for (const input of this.#queue.splice(0)) this.#rejectInput(input, "closed");
    this.#options.permissionBroker.close();
    this.#options.questionBroker?.close();
    this.#clearPendingAfterStop();
    const active = this.#active;
    if (active !== null && !active.settled) this.#stopActive(active, "close");
    this.#closePromise = (async () => {
      await this.#running?.catch(() => {});
      await this.#previousExit.catch(() => {});
      this.#customization?.close();
      this.#customization = null;
    })();
    return this.#closePromise;
  }

  async setModel(value: string): Promise<void> {
    this.#pendingModel = value;
    this.#switchError = null;
    this.#emitState(this.#machine.state);
  }

  async setEffort(_level: string): Promise<void> {
    throw new Error("antigravity effort switching is unavailable; the level is part of the model slug");
  }

  setPermissionSyncSupported(supported: boolean): void {
    if (this.#permissionSyncSupported === supported) return;
    this.#permissionSyncSupported = supported;
    if (supported && this.#permissionControl === null) this.#permissionControl = this.#baselineControl();
    this.#emitState(this.#machine.state);
  }

  applyPermissionSync(message: PermissionSyncMessage): void {
    if (message.control === null) return;
    const control = message.control;
    if (control.revision < (this.#permissionControl?.revision ?? -1)) return;
    const current = this.#currentCell();
    const next = message.next.requested;
    const approval = next.approval ?? current.approval;
    const cell: PermissionConfiguration = { sandbox: next.sandbox, network_access: next.network_access, approval };
    const ceiling = this.#permissionCeiling();
    const violation = ceiling === null ? null : ceilingExceeded(cell, ceiling);
    if (violation !== null) {
      this.#rejectOverCeiling(message.next.revision, cell, current, violation, "permission_sync");
      return;
    }
    this.#permissionControl = control;
    if (control.status === "applied") this.#lastEffectivePermission = control.effective;
    else if (control.last_effective !== undefined) this.#lastEffectivePermission = control.last_effective;
    this.#config.sandbox = cell.sandbox;
    this.#config.network_access = cell.network_access;
    this.#config.approval = approval;
    // A durable next that was never applied is captured by the next turn.
    if (control.status !== "applied" && message.next.revision > 0) {
      this.#pendingPermissionSwitch = { revision: message.next.revision, requested: cell };
    }
    this.#emitState(this.#machine.state);
  }

  /** Stages a switch for the next turn's start; its process starts with it. */
  async setPermission(selection: PermissionSelection): Promise<void> {
    const ceiling = this.#permissionCeiling();
    if (ceiling === null) throw new Error("antigravity: permission switching is not advertised for this session");
    const current = this.#currentCell();
    const target: PermissionConfiguration = {
      sandbox: selection.requested.sandbox,
      network_access: selection.requested.network_access,
      approval: selection.requested.approval ?? current.approval,
    };
    const violation = ceilingExceeded(target, ceiling);
    if (violation !== null) {
      this.#pendingPermissionSwitch = null;
      this.#rejectOverCeiling(selection.revision, target, current, violation, "set_permission");
      return;
    }
    this.#pendingPermissionSwitch = { revision: selection.revision, requested: target };
    this.#permissionControl = {
      revision: selection.revision,
      requested: target,
      status: "pending",
      constraints: this.#constraints(current.approval),
      ...(this.#lastEffectivePermission === null ? {} : { last_effective: this.#lastEffectivePermission }),
    };
    this.#emitState(this.#machine.state);
  }

  async setPermissionMode(_mode: PermissionMode): Promise<void> {
    throw new Error("antigravity: permission-mode switching is unsupported; use set_permission");
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
    const out = this.statusExtSnapshot();
    if (this.#sessionId !== null) out.session_id = this.#sessionId;
    return out;
  }

  statusExtSnapshot(): Record<string, unknown> {
    return this.#statusExt();
  }

  // --- input lifecycle ---------------------------------------------------

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      for (;;) {
        if (this.#closed || this.#failStopped || this.#gateFault !== null) return;
        const input = this.#queue.shift();
        if (input === undefined) return;
        this.#running = this.#runInput(input);
        await this.#running;
        this.#running = null;
      }
    } finally {
      this.#draining = false;
    }
  }

  async #runInput(input: Input): Promise<void> {
    const active: Active = {
      token: input.turnToken ?? randomUUID(),
      conversationIds: input.conversationIds ?? [],
      owner: new AbortController(),
      stop: null,
      interruptedAt: null,
      generation: null,
      toolHost: null,
      gateServer: null,
      verifier: null,
      probe: null,
      sessionId: undefined,
      observedSessionId: undefined,
      window: null,
      delivery: "pending",
      acked: false,
      resolved: false,
      settled: false,
      settle: null,
      preAckTimer: null,
      abortDeadline: null,
      termination: null,
      gateFault: null,
      toolTimeout: false,
      unexpectedPermission: false,
      processError: null,
      submission: null,
      evidence: false,
      continuations: 0,
      seenCalls: new Set(),
      steps: new Map(),
      text: input.text,
      assistantText: "",
      resultText: "",
    };
    this.#active = active;
    let settlement: Settlement;
    try {
      await this.#start(active);
      settlement = await this.#prompt(active);
    } catch (error) {
      settlement = this.#startFailure(active, error);
    }
    this.#finish(active, settlement);
    this.#previousExit = this.#retire(active, settlement.kind === "start_failed" ? "start_failed" : active.stop ?? "retired");
    await this.#previousExit;
  }

  #owns(active: Active): boolean {
    return !active.owner.signal.aborted;
  }

  /** One start step. `start` runs only while the input owns its start; the
   *  step's own resolution then publishes a value or refuses an error while
   *  it still does. Otherwise a value is released, since nothing else owns
   *  it, and the step rejects with the reason ownership ended. */
  #step<T>(active: Active, start: () => Promise<T>, handlers: StepHandlers<T> = {}): Promise<T> {
    const signal = active.owner.signal;
    if (signal.aborted) return Promise.reject(signal.reason);
    const promise = start();
    return new Promise<T>((resolve, reject) => {
      const lost = (): void => reject(signal.reason);
      signal.addEventListener("abort", lost, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", lost);
          if (signal.aborted) {
            handlers.release?.(value);
            reject(signal.reason);
            return;
          }
          try {
            handlers.publish?.(value);
          } catch (error) {
            reject(error);
            return;
          }
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", lost);
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          try {
            handlers.refuse?.(error);
          } catch (mapped) {
            reject(mapped);
            return;
          }
          reject(error);
        },
      );
    });
  }

  /** The start's RPCs, each sent only while the input owns its start; the
   *  options are the session's current ones. */
  #startSession(active: Active, session: AcpSession): StartSession {
    const owned = <T>(send: () => Promise<T>): Promise<T> =>
      this.#owns(active) ? send() : Promise.reject(active.owner.signal.reason);
    return {
      get configOptions() {
        return session.configOptions;
      },
      initialize: () => owned(() => session.initialize()),
      newSession: (cwd, mcpServers, meta) => owned(() => session.newSession(cwd, mcpServers, meta)),
      resume: (sessionId, cwd, mcpServers) => owned(() => session.resume(sessionId, cwd, mcpServers)),
      setConfigOption: (configId, value) => owned(() => session.setConfigOption(configId, value)),
    };
  }

  #startFailure(active: Active, error: unknown): Settlement {
    if (error instanceof Stopped || active.stop !== null) return { kind: "stopped" };
    if (error instanceof PermissionSyncTimeoutError) {
      return { kind: "start_failed", detail: "permission_sync_timeout", permissionSyncTimeout: true };
    }
    // A process that failed to run explains the failed step after it.
    if (active.processError !== null) return { kind: "start_failed", detail: active.processError };
    if (error instanceof RequestError) {
      if (isAuthRequired(error)) return { kind: "start_failed", detail: AUTH_REQUIRED };
      return { kind: "start_failed", detail: `antigravity_api_error: ${boundErrorDetail(error.message)}`, apiError: true };
    }
    const detail = error instanceof Error ? error.message : String(error);
    // A wrapper keeps its own text; the errors it carries decide the class.
    const rpc = wrappedRpcErrors(error);
    if (rpc.some(isAuthRequired)) return { kind: "start_failed", detail: AUTH_REQUIRED };
    if (rpc.length > 0) return { kind: "start_failed", detail, apiError: true };
    return { kind: "start_failed", detail };
  }

  /** Starts the input's process up to readiness. Each step and the host-wide
   *  state it writes act only while the input owns its start (design 4.4). */
  async #start(active: Active): Promise<void> {
    await this.#step(active, () => this.#previousExit);
    await this.#step(active, () => this.#options.waitForPermissionSync?.() ?? Promise.resolve(), {
      publish: () => this.#capturePermission(active),
    });
    if (!this.#agyExecutable.ok) throw new StartFailure(`antigravity_cli_unavailable:${this.#agyExecutable.reason}`);
    const executable = this.#agyExecutable.path;
    let customization!: CustomizationDir;
    const toolHost = await this.#step(active, () => {
      customization = this.#customization ??= CustomizationDir.create(this.#entryCommand());
      customization.rewrite();
      return (this.#options.toolHostListen ?? ((descriptors, options) => ToolHost.listen(descriptors, options)))(
        this.#options.toolDescriptors ?? [],
        { turnSignal: () => active.window?.signal ?? null },
      );
    }, { publish: (host) => { active.toolHost = host; }, release: (late) => late.close() });
    const verifier = new CallVerifier({
      sessionId: () => active.sessionId,
      onFault: (fault) => this.#verificationFault(active, fault),
      onRepeat: (callId) => this.#options.onOutOfTurnEvent?.({ eventKind: "repeated_terminal", callId }),
    });
    active.verifier = verifier;
    // Each ask holds one lease while the operator answers; asks may overlap.
    const leases: (string | null)[] = [];
    const policy = new AcpToolPolicy({
      config: { ...this.#config },
      cwd: this.#options.cwd,
      customizationDir: customization.path,
      kaoiroToolNames: () => new Set((this.#options.toolDescriptors ?? []).map((descriptor) => descriptor.name)),
      broker: this.#options.permissionBroker,
      onPermissionRequest: () => { leases.push(this.beginPermissionWaitLease(active.token, "native")); },
      onPermissionResolved: () => {
        const lease = leases.pop();
        if (lease !== undefined && lease !== null) this.endPermissionWaitLease(lease);
      },
    });
    const gateServer = await this.#step(active, () => (this.#options.gateServerListen ?? HookGateServer.listen)({
      verifier,
      handlers: {
        preToolUse: (request, signal) => this.#preToolUse(active, policy, request, signal),
        stop: (request) => this.#answerStop(active, request),
      },
    }), { publish: (server) => { active.gateServer = server; }, release: (late) => late.close() });
    const listed = await this.#step(active, () => this.#hookList(active, executable, customization));
    if (!listed.ok) throw new StartFailure(`antigravity_hooks_refused:${listed.reason}`);
    const requested = this.#sessionId ?? undefined;
    let session!: StartSession;
    let ready!: Promise<boolean>;
    await this.#step(active, () => {
      const generation = this.#spawnGeneration(active, executable, customization, gateServer);
      session = this.#startSession(active, generation.session);
      return generation.attach({
        cwd: this.#options.cwd,
        mcpServers: [toolHost.mcpServer()],
        resumeSessionId: requested,
        systemPromptAppend: this.#options.appendSystemPrompt,
      }, session);
    }, {
      publish: (attached) => {
        if (attached.observedSessionId !== undefined && attached.observedSessionId !== attached.sessionId) {
          throw new StartFailure("antigravity_resume_echoed_another_session");
        }
        // The readiness bound counts from the attach response and ends the
        // start's ownership whichever step is then pending (design 4.4).
        ready = toolHost.listed(this.#options.mcpReadyTimeoutMs ?? DEFAULT_MCP_READY_TIMEOUT_MS).then(() => true, () => {
          active.owner.abort(new StartFailure(MCP_NOT_CONNECTED));
          return false;
        });
        active.sessionId = attached.sessionId;
        active.observedSessionId = attached.observedSessionId;
        if (this.#options.recovery?.accept(attached.sessionId, requested) === false) {
          void this.close();
          throw new Stopped();
        }
        if (this.#announcedSessionId !== attached.sessionId) {
          this.#sessionId = attached.sessionId;
          this.#announcedSessionId = attached.sessionId;
          this.#options.onSessionId?.(attached.sessionId);
        }
      },
      refuse: (error) => {
        if (requested !== undefined && error instanceof RequestError && error.code === -32603) {
          this.#options.recovery?.refuseLaunch();
          throw new StartFailure("antigravity_resume_failed", { cause: error });
        }
      },
    });
    await this.#step(active, () => this.#modelOutcome(session), { publish: (outcome) => this.#publishModel(outcome) });
    if (!(await this.#step(active, () => ready))) throw new StartFailure(MCP_NOT_CONNECTED);
  }

  #spawnGeneration(active: Active, executable: string, customization: CustomizationDir, gateServer: HookGateServer): Generation {
    const sandboxed = (this.#config.sandbox ?? "workspace-write") !== "danger-full-access";
    const args = ["acp", "--add-dir", customization.path, ...(sandboxed ? ["--sandbox"] : []), "--dangerously-skip-permissions"];
    const env: NodeJS.ProcessEnv = {
      ...withAgentMarker(process.env),
      ...nonInteractiveToolEnv(process.env).additions,
      KAOIRO_GATE_SOCKET: gateServer.socketPath,
      KAOIRO_GATE_NONCE: gateServer.nonce,
      KAOIRO_GATE_DEADLINE_MS: String(GATE_DEADLINE_MS),
    };
    delete env.CODEX_HOME;
    let child: SpawnedAgy;
    try {
      child = (this.#options.spawn ?? this.#defaultSpawn)(executable, args, { cwd: this.#options.cwd, env });
    } catch (error) {
      throw new StartFailure(`antigravity_cli_spawn_failure: ${boundErrorDetail(error instanceof Error ? error.message : String(error))}`);
    }
    const generation = new Generation(++this.#serial, child, {
      update: (notification) => this.#update(active, notification),
      permissionRequest: () => this.#unexpectedPermission(active),
      write: (result) => {
        if (result.method === "session/prompt") this.#promptWritten(active, result.ok);
      },
      // P's window opens with its write (design Terms), never after P settled.
      promptAttempted: () => {
        if (active.resolved) return;
        active.window = new AbortController();
        active.delivery = "attempted";
      },
      error: (error) => {
        active.processError ??= `antigravity_cli_process_error: ${boundErrorDetail(error.message)}`;
      },
      inbound: (eventKind) => this.#options.onOutOfTurnEvent?.({ eventKind }),
    });
    active.generation = generation;
    void generation.connection.closed.then(() => this.#connectionClosed(active), () => this.#connectionClosed(active));
    return generation;
  }

  /** Prepares the input and hands its one prompt to the SDK, then waits
   *  until it settles; the window opens when its write begins. From the
   *  ownership check to the hand-off nothing awaits, and the preparation,
   *  which may stop the input itself, is checked again after it returns. */
  #prompt(active: Active): Promise<Settlement> {
    if (!this.#owns(active)) throw active.owner.signal.reason;
    const prepared = this.#options.prepareInput?.(active.token);
    if (!this.#owns(active)) throw active.owner.signal.reason;
    if (prepared === null) return Promise.resolve({ kind: "skipped" });
    if (prepared !== undefined) {
      active.text = prepared.text;
      active.conversationIds = prepared.conversationIds;
    }
    const generation = active.generation!;
    return new Promise<Settlement>((resolve) => {
      active.settle = (settlement) => {
        if (active.resolved) return;
        active.resolved = true;
        resolve(settlement);
      };
      active.preAckTimer = this.#setTimer(() => {
        active.preAckTimer = null;
        if (!active.acked && !active.resolved) this.#stopActive(active, "pre_ack");
      }, this.#preAckBoundMs);
      generation.session.prompt(active.text).then(
        (response) => {
          this.#confirmDelivery(active);
          this.#evidence(active);
          active.settle?.({ kind: "response", response });
        },
        (error: unknown) => {
          // An error response is still P's response: delivery is confirmed.
          if (error instanceof RequestError) this.#confirmDelivery(active);
          active.settle?.(error instanceof RequestError ? { kind: "rpc_error", error } : { kind: "closed" });
        },
      );
    });
  }

  /** A failed write was already recorded as attempted when it began. */
  #promptWritten(active: Active, ok: boolean): void {
    if (ok) this.#confirmDelivery(active);
  }

  /** The ACK (design L7): once per prompt, on the first confirmation. */
  #confirmDelivery(active: Active): void {
    if (active.acked || active.resolved || active.window === null) return;
    active.acked = true;
    active.delivery = "confirmed";
    if (active.preAckTimer !== null) {
      this.#clearTimer(active.preAckTimer);
      active.preAckTimer = null;
    }
    this.#options.onTurnStart?.({ turnToken: active.token, conversationIds: active.conversationIds });
  }

  /** The SDK rejects the open prompt when the connection closes, which
   *  settles P. */
  #connectionClosed(active: Active): void {
    active.verifier?.stopLatched();
  }

  // --- engine input --------------------------------------------------------

  /** P's window: from the start of the prompt write until P settles. */
  #inWindow(active: Active): boolean {
    return active.window !== null && !active.resolved && this.#active === active;
  }

  #update(active: Active, notification: SessionNotification): void {
    const kind = classifyUpdate(notification, active.sessionId);
    const update = notification.update;
    const inWindow = this.#inWindow(active);
    if (kind === "other") {
      this.#options.onOutOfTurnEvent?.({ eventKind: `other:${String(update.sessionUpdate)}` });
      return;
    }
    let callId: string | undefined;
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      callId = update.toolCallId;
      active.verifier?.toolUpdate(callId, toolName(update), update.rawInput, update.status);
    }
    if (kind === "control") {
      if (inWindow) this.#options.onTurnProgress?.({ turnToken: active.token });
      return;
    }
    const firstSeen = callId === undefined || !active.seenCalls.has(callId);
    if (callId !== undefined) active.seenCalls.add(callId);
    if (!inWindow) {
      this.#options.onOutOfTurnEvent?.({ eventKind: update.sessionUpdate, ...(callId === undefined ? {} : { callId }) });
      return;
    }
    this.#options.onTurnProgress?.({ turnToken: active.token });
    if (firstSeen) {
      this.#confirmDelivery(active);
      this.#evidence(active);
    }
    const projection = activityProjection(notification);
    if (projection.log !== undefined) this.#flushAssistant(active);
    for (const event of projection.events) this.#apply(event);
    if (projection.text !== undefined) active.assistantText += projection.text;
    if (projection.log !== undefined) this.#emitLog(projection.log);
    if (callId !== undefined) this.#toolStep(active, callId, update);
  }

  #toolStep(active: Active, callId: string, update: SessionNotification["update"]): void {
    const status = (update as { status?: unknown }).status;
    let step = active.steps.get(callId);
    if (step === undefined) {
      step = active.steps.size + 1;
      active.steps.set(callId, step);
      this.#options.onToolStart?.({ turnToken: active.token, stepIndex: step, toolName: toolName(update) ?? "unknown" });
    }
    if (status === "completed" || status === "failed") this.#options.onToolEnd?.({ turnToken: active.token, stepIndex: step });
  }

  async #preToolUse(
    active: Active,
    policy: AcpToolPolicy,
    request: PreToolUseRequest,
    signal: AbortSignal,
  ): Promise<{ decision: "allow" | "deny"; reason?: string }> {
    if (!this.#inWindow(active)) {
      this.#options.onOutOfTurnEvent?.({ eventKind: "pre_tool_use", callId: request.callId });
      return { decision: "deny", reason: "kaoiro: no turn is open for this tool call" };
    }
    if (active.stop !== null) return { decision: "deny", reason: "kaoiro: the turn is stopping" };
    this.#options.onTurnProgress?.({ turnToken: active.token });
    return policy.decide({ name: request.name, args: request.args }, AbortSignal.any([signal, active.window!.signal]));
  }

  #answerStop(active: Active, request: StopRequest): { decision: "continue"; reason: string } | { decision: "stop" } {
    const answer = answerStop(request, {
      sessionId: active.sessionId,
      windowOpen: this.#inWindow(active),
      stopLatched: active.stop !== null,
      granted: active.continuations,
    });
    if (answer.decision === "continue") {
      active.continuations += 1;
      return { decision: "continue", reason: answer.reason };
    }
    return { decision: "stop" };
  }

  #unexpectedPermission(active: Active): void {
    if (!this.#inWindow(active)) {
      this.#options.onOutOfTurnEvent?.({ eventKind: "session/request_permission" });
      return;
    }
    active.unexpectedPermission = true;
    this.#stopActive(active, "permission");
  }

  #verificationFault(active: Active, fault: VerificationFault): void {
    const name = fault.kind === "duplicate_hook" ? fault.name : fault.name ?? "unknown";
    const detail = `${GATE_FAULT_REASON}:${name}`;
    // After the outcome was decided, a fault only applies to later input (L6).
    if (!active.settled) active.gateFault ??= detail;
    this.#latchGateFault(GATE_FAULT_REASON, detail);
    if (!active.resolved) this.#stopActive(active, "gate_fault");
  }

  /** D3: sticky at once; later input is rejected as gate_broken. */
  #latchGateFault(reason: string, detail: string): void {
    if (this.#gateFault !== null) return;
    this.#gateFault = { reason, detail };
    for (const input of this.#queue.splice(0)) this.#rejectInput(input, "gate_broken");
    try {
      this.#options.onGateFault?.({ reason, detail: boundErrorDetail(detail) });
    } catch {
      // A diagnostic callback cannot undo the latch.
    }
    this.#emitState(this.#machine.state);
  }

  // --- stopping ------------------------------------------------------------

  /** The first action of a stop route (design L3). Returns whether a cancel
   *  was sent. */
  #stopActive(active: Active, route: StopRoute): boolean {
    if (active.resolved || active.settled) return false;
    const first = active.stop === null;
    if (first) {
      active.stop = route;
      active.verifier?.stopLatched();
      active.owner.abort(new Stopped());
    }
    const generation = active.generation;
    // One grace per route, before and after the write (L3); the watchdog's
    // own grace governs its cancel.
    const grace = route === "close" || route === "pre_ack" ? this.#closeGraceMs : this.#abortGraceMs;
    if (route === "fail_stop") {
      // The watchdog's own grace already elapsed.
      active.probe?.stop();
      if (active.window === null) this.#closeHandedPrompt(active);
      if (generation !== null) signalSubtree(generation.child, "SIGKILL", this.#signalTarget);
      active.settle?.({ kind: "stopped" });
      return false;
    }
    if (active.window === null) {
      // Before the prompt is written: no cancel; end the child on the
      // route's grace and settle now.
      active.probe?.stop();
      this.#closeHandedPrompt(active);
      if (generation !== null) this.#terminate(active, grace);
      active.settle?.({ kind: "stopped" });
      return false;
    }
    if (route === "close" || route === "pre_ack") {
      this.#terminate(active, grace);
      active.settle?.({ kind: "stopped" });
      return false;
    }
    if (!first) return false;
    void generation?.session.cancel().catch(() => {});
    if (route !== "watchdog") this.#armAbortDeadline(active, grace);
    return true;
  }

  /** A prompt handed to the SDK whose write has not begun must never reach
   *  `agy` once its input stops: the process's input closes first, so no
   *  later callback can let the queued write through (design L5, L7). */
  #closeHandedPrompt(active: Active): void {
    if (active.settle !== null) active.generation?.closeOutput();
  }

  /** Armed once, by the first stop route that cancels (L3). */
  #armAbortDeadline(active: Active, graceMs: number): void {
    active.abortDeadline = {
      atMs: this.#nowMs() + graceMs,
      timer: this.#setTimer(() => {
        if (!active.resolved && active.generation !== null) {
          signalSubtree(active.generation.child, "SIGKILL", this.#signalTarget);
        }
      }, graceMs),
    };
  }

  /** SIGTERM now, SIGKILL after the grace; a later call only shortens it. */
  #terminate(active: Active, graceMs: number): void {
    const generation = active.generation;
    if (generation === null || generation.exit !== undefined) return;
    if (active.termination !== null) {
      active.termination.shortenGraceTo(graceMs);
      return;
    }
    active.termination = terminateWithGrace(generation.child, {
      graceMs,
      signalTarget: this.#signalTarget,
      setTimer: this.#setTimer,
      clearTimer: this.#clearTimer,
      nowMs: this.#nowMs,
    });
  }

  #failStop(attribution: "exact" | "unattributed"): boolean {
    this.#failStopped = true;
    this.#closed = true;
    const active = this.#active;
    this.#options.permissionBroker.close();
    this.#options.questionBroker?.close();
    this.#clearPendingAfterStop();
    const queued = this.#queue.splice(0);
    if (active !== null && !active.settled) this.#stopActive(active, "fail_stop");
    const error = {
      detail: attribution === "exact"
        ? "turn watchdog interrupt grace expired; host admission stopped pending operator recovery"
        : "turn watchdog token attribution unavailable; host admission stopped pending operator recovery",
    };
    for (const input of queued) {
      if (input.turnToken === undefined) {
        this.#rejectInput(input, "watchdog_fail_stopped");
        continue;
      }
      try {
        this.#options.onTurnEnd?.({
          turnToken: input.turnToken,
          conversationIds: input.conversationIds ?? [],
          error,
          cancellation: { kind: "watchdog_fail_stop", started: false },
          terminal: false,
        });
      } catch (caught) {
        try {
          this.#warn(`antigravity: watchdog queued-turn settlement failed: token=${input.turnToken} detail=${boundErrorDetail(String(caught))}`);
        } catch {
          // Continue settling the other queued input.
        }
      }
    }
    this.#options.onWatchdogFailStop?.({
      ...(active === null ? {} : { turnToken: active.token }),
      conversationIds: active?.conversationIds ?? [],
      attribution,
    });
    return true;
  }

  // --- settlement ----------------------------------------------------------

  /** Decides the input's one outcome (design L2) and publishes it. */
  #finish(active: Active, settlement: Settlement): void {
    active.owner.abort(new Stopped());
    active.resolved = true;
    if (active.preAckTimer !== null) this.#clearTimer(active.preAckTimer);
    // The checks due at settlement finish before the result is published.
    active.verifier?.settle();
    active.settled = true;
    active.window?.abort();
    this.#flushAssistant(active);
    for (const [leaseId, owner] of this.#leases) {
      if (owner.turnToken === active.token) this.#leases.delete(leaseId);
    }
    const tampered = active.generation !== null && this.#customization !== null && this.#customization.verify() !== true;
    if (tampered) this.#latchGateFault(TAMPER_REASON, TAMPER_REASON);
    this.#permissionWithoutEvidence(active, settlement);
    const outcome = this.#outcome(active, settlement, tampered);
    if (this.#active === active) this.#active = null;
    this.#publish(active, outcome);
  }

  #outcome(active: Active, settlement: Settlement, tampered: boolean): Outcome {
    if (settlement.kind === "skipped") return { kind: "skipped" };
    if (this.#closed) return { kind: "stale" };
    if (tampered) return { kind: "error", detail: TAMPER_REASON, classify: { detail: TAMPER_REASON } };
    if (active.interruptedAt !== null) return { kind: "interrupted" };
    if (settlement.kind === "start_failed") {
      if (settlement.permissionSyncTimeout === true) return { kind: "permission_sync_timeout" };
      // As for P's error response: the message text is not classified (4.7).
      const classify = settlement.apiError === true ? { detail: settlement.detail, reason: "api_error" as const } : { detail: settlement.detail };
      return { kind: "error", detail: settlement.detail, classify };
    }
    if (!active.acked) {
      const attempted = active.delivery === "attempted";
      return {
        kind: "error",
        detail: DELIVERY_UNCONFIRMED,
        classify: attempted ? { detail: DELIVERY_UNCONFIRMED, reason: "receipt_unknown" } : { detail: DELIVERY_UNCONFIRMED },
      };
    }
    if (active.gateFault !== null) return { kind: "error", detail: active.gateFault, classify: { detail: active.gateFault } };
    if (active.toolTimeout) return { kind: "error", detail: "tool_timeout", classify: { reason: "timeout" } };
    if (active.unexpectedPermission) {
      return { kind: "error", detail: UNEXPECTED_PERMISSION_REASON, classify: { detail: UNEXPECTED_PERMISSION_REASON } };
    }
    if (active.processError !== null) return { kind: "error", detail: active.processError, classify: { detail: active.processError } };
    if (settlement.kind === "closed" || settlement.kind === "stopped") {
      return { kind: "error", detail: "agy_exit_without_result", classify: { detail: "agy_exit_without_result" } };
    }
    if (settlement.kind === "rpc_error") {
      const detail = isAuthRequired(settlement.error) ? AUTH_REQUIRED : `antigravity_api_error: ${boundErrorDetail(settlement.error.message)}`;
      // No structural rate-limit field is measured on ACP, so the message
      // text must not make a mention of 429 a rate limit (design 4.7).
      return { kind: "error", detail, classify: { detail, reason: "api_error" } };
    }
    const stopReason = settlement.response.stopReason;
    if (stopReason === "end_turn") return { kind: "result" };
    return { kind: "error", detail: `antigravity_stop_reason:${stopReason}`, classify: { detail: `antigravity_stop_reason:${stopReason}` }, terminal: true };
  }

  #publish(active: Active, outcome: Outcome): void {
    const turnToken = active.token;
    if (outcome.kind === "skipped") {
      if (this.#queue.length === 0 && !this.#closed) {
        this.#machine = initialMachineState("waiting_input");
        this.#emitState("waiting_input");
      }
      return;
    }
    if (this.#failStopped) return;
    let error: InterAgentErrorClassifyInput | undefined;
    let cancellation: { kind: "interrupt"; reason: "interrupted" } | undefined;
    let terminal = false;
    if (outcome.kind === "interrupted") {
      this.#terminalError("interrupted");
      error = { reason: "interrupted" };
      cancellation = { kind: "interrupt", reason: "interrupted" };
      const exit = active.generation?.exit;
      this.#options.onInterruptSettled?.({
        turnToken,
        exitCode: exit?.code ?? null,
        signal: exit?.signal ?? null,
        elapsedMs: active.interruptedAt === null ? 0 : Math.max(0, Date.parse(this.#now()) - Date.parse(active.interruptedAt)),
      });
    } else if (outcome.kind === "permission_sync_timeout") {
      this.#options.onLog?.(makeResult(this.#config, this.#now(), permissionSyncFailure()));
      this.#apply({ kind: "result", subtype: "error_during_execution" });
      error = { reason: "permission_sync_timeout" };
    } else if (outcome.kind === "error") {
      this.#terminalError(outcome.detail);
      error = outcome.classify;
      terminal = outcome.terminal === true;
    } else if (outcome.kind === "result") {
      if (active.sessionId !== undefined) this.#options.recovery?.confirm(active.sessionId);
      this.#apply({ kind: "result", subtype: "success" });
      this.#options.onLog?.(makeResult(this.#config, this.#now(), { text: clipText(active.resultText).text }));
      terminal = true;
    }
    this.#options.onTurnBoundary?.({ turnToken });
    this.#options.onTurnEnd?.({
      turnToken,
      conversationIds: active.conversationIds,
      ...(error === undefined ? {} : { error }),
      ...(cancellation === undefined ? {} : { cancellation }),
      terminal,
    });
  }

  /** Ends the generation after its input settled (design 4.6), and resolves
   *  once its process exited, so the next one starts only then (L4). */
  async #retire(active: Active, reason: GenerationEndReason): Promise<void> {
    active.toolHost?.close();
    active.gateServer?.close();
    active.probe?.stop();
    const generation = active.generation;
    if (generation === null) return;
    // A stop that already ended the child keeps its own grace; otherwise
    // retirement takes the shorter of a cancel's remaining time and the close
    // grace (L3).
    if (generation.exit === undefined && active.termination === null) {
      const remaining = active.abortDeadline === null ? this.#closeGraceMs : Math.max(0, active.abortDeadline.atMs - this.#nowMs());
      this.#terminate(active, Math.min(remaining, this.#closeGraceMs));
    }
    const exit = await generation.exited;
    active.termination?.cancel();
    if (active.abortDeadline !== null) this.#clearTimer(active.abortDeadline.timer);
    try {
      this.#options.onGenerationEnded?.({ serial: generation.serial, reason, code: exit.code, signal: exit.signal });
    } catch {
      // Diagnostics only.
    }
  }

  // --- permission evidence (design L8) -------------------------------------

  #capturePermission(active: Active): void {
    const pending = this.#pendingPermissionSwitch;
    if (pending === null) return;
    const cell = pending.requested;
    this.#config.sandbox = cell.sandbox;
    this.#config.network_access = cell.network_access;
    if (cell.approval !== undefined) this.#config.approval = cell.approval;
    const approval = this.#config.approval ?? "on-request";
    const requested: PermissionConfiguration = { sandbox: cell.sandbox, network_access: cell.network_access, approval };
    const submission: PermissionSubmission = { revision: pending.revision, requested, execution_id: active.token };
    active.submission = submission;
    if (this.#permissionControl === null || this.#permissionControl.revision <= submission.revision) {
      this.#permissionControl = {
        revision: submission.revision,
        requested,
        status: "applying",
        constraints: this.#constraints(approval),
        submitted: submission,
        ...(this.#lastEffectivePermission === null ? {} : { last_effective: this.#lastEffectivePermission }),
      };
    }
    this.#emitState(this.#machine.state);
  }

  /** The captured prompt's response or first activity arrived. Like the ACK,
   *  it counts only before P settled (design L7, L8). */
  #evidence(active: Active): void {
    const submission = active.submission;
    if (submission === null || active.evidence || active.resolved) return;
    active.evidence = true;
    const current = this.#permissionControl;
    const same = current !== null && current.revision === submission.revision;
    const approval = submission.requested.approval ?? "on-request";
    if (active.observedSessionId === undefined) {
      if (same) this.#setUnknown(submission, "no_observed_session");
      return;
    }
    const observation: PermissionObservation = {
      ...submission,
      session_id: active.observedSessionId,
      permission: { sandbox: submission.requested.sandbox, approval, enforcement: "advisory" },
      network_access: effectiveNetworkAccess(submission.requested.sandbox, submission.requested.network_access),
    };
    this.#lastEffectivePermission = observation;
    if (this.#pendingPermissionSwitch?.revision === submission.revision) this.#pendingPermissionSwitch = null;
    if (same) {
      this.#permissionControl = {
        revision: submission.revision,
        requested: submission.requested,
        status: "applied",
        constraints: this.#constraints(approval),
        submitted: submission,
        effective: observation,
        last_effective: observation,
      };
    } else if (current !== null) {
      this.#permissionControl = { ...current, last_effective: observation } as PermissionControlExt;
    }
    this.#options.onPermissionLifecycle?.({ version: "0", kind: "permission_applied", at: this.#now(), details: observation });
    this.#emitState(this.#machine.state);
  }

  #permissionWithoutEvidence(active: Active, settlement: Settlement): void {
    const submission = active.submission;
    if (submission === null || active.evidence) return;
    const current = this.#permissionControl;
    if (current === null || current.revision !== submission.revision) return;
    // Nothing reached agy: a failed start, or a prompt never written.
    if (active.delivery === "pending") {
      this.#permissionControl = {
        revision: submission.revision,
        requested: submission.requested,
        status: "failed",
        constraints: this.#constraints(submission.requested.approval ?? "on-request"),
        submitted: submission,
        reason: "restart_failed",
        ...(this.#lastEffectivePermission === null ? {} : { last_effective: this.#lastEffectivePermission }),
      };
      this.#emitState(this.#machine.state);
      return;
    }
    this.#setUnknown(submission, settlement.kind === "rpc_error" ? "rpc_error" : active.acked ? "connection_closed" : "delivery_unconfirmed");
  }

  #setUnknown(submission: PermissionSubmission, reason: string): void {
    this.#permissionControl = {
      revision: submission.revision,
      requested: submission.requested,
      status: "unknown",
      constraints: this.#constraints(submission.requested.approval ?? "on-request"),
      submitted: submission,
      reason,
      ...(this.#lastEffectivePermission === null ? {} : { last_effective: this.#lastEffectivePermission }),
    };
    this.#emitState(this.#machine.state);
  }

  #permissionCeiling(): SwitchCeiling | null {
    const { max_sandbox, max_approval, max_network_access } = this.#config;
    if (max_sandbox === undefined || max_approval === undefined || max_network_access === undefined) return null;
    return { sandbox: max_sandbox, approval: max_approval, network_access: max_network_access };
  }

  #currentCell(): Required<PermissionConfiguration> {
    return {
      sandbox: this.#config.sandbox ?? "workspace-write",
      network_access: this.#config.network_access ?? false,
      approval: this.#config.approval ?? "on-request",
    };
  }

  #constraints(approval: PermissionAxesExt["approval"]): PermissionControlExt["constraints"] {
    return { approval, enforcement: "advisory" };
  }

  #baselineControl(): PermissionControlExt {
    const cell = this.#currentCell();
    return { revision: 0, requested: cell, status: "pending", constraints: this.#constraints(cell.approval) };
  }

  #rejectOverCeiling(revision: number, cell: PermissionConfiguration, current: Required<PermissionConfiguration>, violation: string, source: string): void {
    this.#permissionControl = {
      revision,
      requested: cell,
      status: "failed",
      constraints: this.#constraints(current.approval),
      reason: "exceeds_launch_ceiling",
      rolled_back_to: current,
      ...(this.#lastEffectivePermission === null ? {} : { last_effective: this.#lastEffectivePermission }),
    };
    this.#emitState(this.#machine.state);
    this.#options.onPermissionLifecycle?.({
      version: "0",
      kind: "permission_failed",
      at: this.#now(),
      details: { revision, requested: cell, reason: "exceeds_launch_ceiling", rolled_back_to: current },
    });
    this.#warn(`antigravity: ${source} rejected: ${violation}`);
  }

  // --- model (design 4.8) --------------------------------------------------

  /** Applies the committed slug, then a pending switch as one switch with
   *  rollback (design 4.8). Attach resets the pair, so this runs at every
   *  start. It writes no host state: its step publishes the outcome. */
  async #modelOutcome(session: StartSession): Promise<ModelOutcome> {
    // The account default is the pair attach reports; nothing is sent for it.
    if (this.#pendingModel === "") return { kind: "commit", value: "" };
    const committed = this.#config.model ?? "";
    if (committed !== "") {
      const result = await switchModel(session, splitSlug(committed, session), reportedPair(session));
      if (result.kind !== "applied") {
        throw new StartFailure(`antigravity_model_not_applied:${committed}`, {
          cause: result.cause,
          restoreCause: result.kind === "failed" ? result.restoreCause : undefined,
        });
      }
    }
    // An account default staged while the committed slug was being applied
    // waits for the next start: this G no longer has the attach pair.
    const pending = this.#pendingModel;
    if (pending === null || pending === "") return { kind: "none" };
    if (pending === committed) return { kind: "commit", value: pending };
    const result = await switchModel(session, splitSlug(pending, session), reportedPair(session));
    if (result.kind === "applied") return { kind: "commit", value: pending };
    if (result.kind === "failed") {
      throw new StartFailure(result.detail, { cause: result.cause, restoreCause: result.restoreCause });
    }
    return {
      kind: "switch_error",
      requested: pending,
      reason: result.reason,
      ...(result.kind === "rolled_back" ? { rolledBackTo: committed } : {}),
    };
  }

  #publishModel(outcome: ModelOutcome): void {
    if (outcome.kind === "commit") {
      this.#commitModel(outcome.value);
      return;
    }
    // A selection staged during the switch supersedes the attempted one.
    if (outcome.kind === "none" || this.#pendingModel !== outcome.requested) return;
    this.#pendingModel = null;
    this.#switchError = {
      kind: "model",
      requested: outcome.requested,
      reason: outcome.reason,
      ...(outcome.rolledBackTo === undefined ? {} : { rolled_back_to: outcome.rolledBackTo }),
    };
    this.#emitState(this.#machine.state);
  }

  /** The applied slug becomes the committed one; a newer selection staged
   *  meanwhile stays pending (as `#promotePendingModel` did before ACP). */
  #commitModel(value: string): void {
    this.#config.model = value;
    this.#config.model_source = "config";
    if (this.#pendingModel === value) {
      this.#pendingModel = null;
      this.#switchError = null;
    }
    this.#emitState(this.#machine.state);
  }

  // --- hook list (design 4.3 item 1) ---------------------------------------

  #hookList(active: Active, executable: string, customization: CustomizationDir): Promise<{ ok: true } | { ok: false; reason: string }> {
    const args = ["-p", "/hooks", "--add-dir", this.#options.cwd, "--add-dir", customization.path, "--output-format", "json"];
    return new Promise((resolve) => {
      let settled = false;
      let child: GateProbe | null = null;
      const settle = (value: { ok: true } | { ok: false; reason: string }): void => {
        if (settled) return;
        settled = true;
        this.#clearTimer(timer);
        active.probe = null;
        resolve(value);
      };
      const terminate = (): void => {
        if (child !== null) this.#signalTarget(child, "pid", "SIGTERM");
      };
      const timer = this.#setTimer(() => {
        terminate();
        settle({ ok: false, reason: "timeout" });
      }, this.#probeTimeoutMs);
      active.probe = { stop: () => { terminate(); settle({ ok: false, reason: "stopped" }); } };
      try {
        child = this.#options.probeSpawn?.(executable, args, { cwd: this.#options.cwd })
          ?? (spawn(executable, args, { cwd: this.#options.cwd, env: this.#safeChildEnv(), stdio: ["ignore", "pipe", "pipe"] }) as unknown as GateProbe);
      } catch (error) {
        settle({ ok: false, reason: `spawn_failure:${boundErrorDetail(error instanceof Error ? error.message : String(error))}` });
        return;
      }
      let output = "";
      let stdoutEnded = false;
      let closeCode: number | null | undefined;
      const finish = (): void => {
        if (!stdoutEnded || closeCode === undefined) return;
        if (closeCode !== 0) {
          settle({ ok: false, reason: "nonzero_exit" });
          return;
        }
        let parsed: unknown;
        try { parsed = JSON.parse(output); } catch {
          settle({ ok: false, reason: "invalid_json" });
          return;
        }
        settle(checkHookList(parsed, {
          source: join(customization.path, ".agents", "hooks.json"),
          command: antigravitySubcommandPrefix({ ...this.#entryCommand(), subcommand: "hook" }),
        }));
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { output += chunk; });
      child.stdout.once("end", () => { stdoutEnded = true; finish(); });
      child.stderr?.resume();
      child.once("error", (error) => settle({ ok: false, reason: `spawn_failure:${boundErrorDetail(error.message)}` }));
      child.once("close", (code) => { closeCode = code; finish(); });
    });
  }

  // --- catalog -------------------------------------------------------------

  async #refreshCatalog(): Promise<void> {
    let catalog: EngineModelInfo[] | null;
    try {
      catalog = await (this.#options.probeModels?.() ?? this.#defaultProbeModels());
    } catch {
      return;
    }
    if (catalog === null || this.#closed) return;
    this.#catalog = mergeExtraModels(catalog, this.#config.antigravity_extra_models);
    this.#emitState(this.#machine.state);
  }

  #defaultProbeModels(): Promise<EngineModelInfo[] | null> {
    if (!this.#agyExecutable.ok) return Promise.resolve(null);
    const executable = this.#agyExecutable.path;
    return new Promise((resolve) => {
      let output = "";
      let child: GateProbe;
      try {
        child = this.#options.modelsProbeSpawn?.(executable, ["models"], { cwd: this.#options.cwd })
          ?? (spawn(executable, ["models"], { cwd: this.#options.cwd, env: this.#safeChildEnv(), stdio: ["ignore", "pipe", "pipe"] }) as unknown as GateProbe);
      } catch {
        resolve(null);
        return;
      }
      const timer = this.#setTimer(() => {
        this.#signalTarget(child, "pid", "SIGTERM");
        resolve(null);
      }, this.#probeTimeoutMs);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { output += chunk; });
      child.stderr?.resume();
      child.once("error", () => { this.#clearTimer(timer); resolve(null); });
      child.once("close", (code) => {
        this.#clearTimer(timer);
        resolve(code === 0 ? parseAgyModelsOutput(output) : null);
      });
    });
  }

  // --- projection ----------------------------------------------------------

  #apply(event: Parameters<typeof stepState>[1]): void {
    const { next, emitted } = stepState(this.#machine, event);
    this.#machine = next;
    for (const state of emitted) this.#emitState(state);
  }

  #emitState(state: KaoiroState): void {
    this.#options.onState(makeStateChange(this.#config, this.#gateFault !== null ? "error" : state, this.#now(), {}, this.#statusExt(true)));
  }

  #emitLog(entry: LogEntry): void {
    if (entry.kind === "tool_use" && entry.tool_use_id !== undefined) this.#toolNames.set(entry.tool_use_id, entry.tool_name);
    this.#options.onLog?.(makeLog(this.#config, this.#machine.state, this.#now(), logEntryToPayload(entry, this.#toolNames)));
  }

  #flushAssistant(active: Active): void {
    const text = active.assistantText;
    active.assistantText = "";
    if (text === "") return;
    active.resultText += text;
    this.#emitLog({ kind: "assistant", text });
  }

  #terminalError(error: string): void {
    this.#apply({ kind: "result", subtype: "error_during_execution" });
    this.#options.onLog?.(makeResult(this.#config, this.#now(), { is_error: true, error_subtype: "error_during_execution", error_detail: error }));
  }

  #statusExt(consumeOneShot = false): Record<string, unknown> {
    const ext = initialStatusExt(this.#config, this.#catalog, this.#permissionSyncSupported);
    if (this.#pendingModel !== null) ext.pending_model = this.#pendingModel;
    if (this.#switchError !== null) {
      ext.switch_error = this.#switchError;
      if (consumeOneShot) this.#switchError = null;
    }
    if (this.#pendingPermission !== null) ext.pending_permission = this.#pendingPermission;
    if (this.#permissionControl !== null) ext.permission_control = this.#permissionControl;
    if (this.#pendingQuestion !== null) ext.pending_question = this.#pendingQuestion;
    ext.cwd = this.#options.cwd;
    return ext;
  }

  #clearPendingAfterStop(): void {
    if (this.#pendingPermission !== null) {
      this.#pendingPermission = null;
      this.#emitState(this.#machine.state);
    }
    if (this.#pendingQuestion !== null) this.setPendingQuestion(null);
  }

  #rejectInput(input: Input, reason: "closed" | "gate_broken" | "watchdog_fail_stopped"): void {
    this.#notifySendRejected({
      ...(input.turnToken === undefined ? {} : { turnToken: input.turnToken }),
      ...(input.conversationIds === undefined || input.conversationIds.length === 0 ? {} : { conversationIds: input.conversationIds }),
      reason,
    });
  }

  #notifySendRejected(info: Parameters<NonNullable<AntigravityHostOptions["onSendRejected"]>>[0]): void {
    try {
      this.#options.onSendRejected?.(info);
    } catch (error) {
      try {
        this.#warn(`antigravity: send rejection callback failed: token=${info.turnToken ?? "<tokenless>"} detail=${boundErrorDetail(String(error))}`);
      } catch {
        // A diagnostic callback cannot make a rejected input escape.
      }
    }
  }

  #warn(message: string): void {
    if (this.#options.warn !== undefined) {
      this.#options.warn(boundErrorDetail(message));
      return;
    }
    writeRedactedStderr(`${message}\n`);
  }

  #entryCommand(): { nodePath: string; nodeArgs: readonly string[]; entryPath: string } {
    if (this.#options.nodePath !== undefined && this.#options.nodeArgs !== undefined && this.#options.entryPath !== undefined) {
      return { nodePath: this.#options.nodePath, nodeArgs: this.#options.nodeArgs, entryPath: this.#options.entryPath };
    }
    const self = selfCommand();
    return {
      nodePath: this.#options.nodePath ?? self[0]!,
      nodeArgs: this.#options.nodeArgs ?? self.slice(1, -1),
      entryPath: this.#options.entryPath ?? self.at(-1)!,
    };
  }

  #safeChildEnv(): NodeJS.ProcessEnv {
    const environment = withAgentMarker(process.env);
    delete environment.CODEX_HOME;
    return environment;
  }

  #defaultSpawn(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): SpawnedAgy {
    // Its own process group, so a group signal reaches every command it runs.
    return spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], detached: true }) as ChildProcessWithoutNullStreams;
  }
}

type Outcome =
  | { kind: "skipped" }
  | { kind: "stale" }
  | { kind: "interrupted" }
  | { kind: "permission_sync_timeout" }
  | { kind: "error"; detail: string; classify: InterAgentErrorClassifyInput; terminal?: boolean }
  | { kind: "result" };
