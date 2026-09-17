import { randomUUID } from "node:crypto";
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
  mergeExtraModels,
  stepState,
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
import { boundErrorDetail, writeRedactedStderr } from "@kaoiro/agent-common";
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
import {
  agyEventToEvents,
  agyEventIsSuccessfulResult,
  agyEventToQuotaExhaustion,
  agyEventToLogs,
  agyEventToResult,
  agyEventToSessionId,
  parseAgyStreamLine,
  type AgyStreamEvent,
} from "./adapter.js";
import { antigravityCatalogSnapshot, parseAgyModelsOutput } from "./catalog.js";
import { DEFAULT_AGY_PROBE_TIMEOUT_MS, resolveAgyExecutable, type AgyExecutableFailureReason, type AgyExecutableResolution } from "./cli-path.js";
import { CustomizationDir, GATE_DEADLINE_MS, HOOK_TIMEOUT_SECONDS, sweepStaleCustomizationDirs } from "./customization.js";
import { AntigravityGate, GateServer, type AntigravityLaunchConfig } from "./gate.js";
import { effectiveNetworkAccess } from "./network_access.js";
import { ceilingExceeded, type SwitchCeiling } from "./permission_switch.js";
import { nonInteractiveToolEnv } from "./tool_child_env.js";
import { ToolHost } from "./toolhost.js";
import type { ToolTimeoutInfo, TurnWatchdogInterruptCause } from "./turn_watchdog.js";

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
  once(event: "close" | "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  kill?(signal?: NodeJS.Signals): boolean;
}

export interface AntigravityHostOptions {
  cwd: string;
  appendSystemPrompt: string;
  onState: (envelope: Envelope) => void;
  onLog?: (envelope: Envelope) => void;
  onSessionId?: (sessionId: string) => void;
  /** Persists a wrapper-observed permission lifecycle event (ADR-0057 F4c
   *  Stage B0, issue #359). The CLI forwards it to the server as a
   *  `session_lifecycle` report (permission_applied / permission_failed). */
  onPermissionLifecycle?: (event: WrapperPermissionLifecycleMessage) => void;
  onTurnStart?: (info: { turnToken: string; conversationIds: readonly string[] }) => void;
  onTurnEnd?: (info: {
    turnToken: string;
    conversationIds: readonly string[];
    error?: InterAgentErrorClassifyInput;
    cancellation?: { kind: "watchdog_fail_stop"; started: false };
  }) => void;
  onTurnBoundary?: (info: { turnToken: string }) => void;
  onTurnProgress?: (info: { turnToken: string }) => void;
  /** A parsed `step_update` tool step went ACTIVE / left ACTIVE. The
   *  watchdog keys its absolute tool deadline on `stepIndex`. */
  onToolStart?: (info: { turnToken: string; stepIndex: number; toolName: string }) => void;
  onToolEnd?: (info: { turnToken: string; stepIndex: number }) => void;
  onWatchdogFailStop?: (info: {
    turnToken?: string;
    conversationIds: readonly string[];
    attribution: "exact" | "unattributed";
  }) => void;
  toolDescriptors?: ToolDescriptor[];
  permissionBroker: PermissionBroker;
  questionBroker?: Pick<QuestionBroker, "close">;
  resumeSessionId?: string;
  /** Whether the server accepted this session's permission_sync negotiation
   *  (ADR-0057 F4c Stage B0, issue #359 M1). Gates the supports_permission_switch
   *  advertisement (Codex parity): a legacy server that cannot sync leaves the
   *  selector unadvertised, fail-closed. When true, the constructor seeds the
   *  revision-0 baseline control so the server can allocate switch revisions. */
  permissionSyncSupported?: boolean;
  /** Resolves once the server's permission_sync for the current connection has
   *  been applied (or immediately when sync is unsupported). Awaited before each
   *  turn's gate is built so a durable control/next relayed on reconnect lands
   *  before the gate reads the cell. */
  waitForPermissionSync?: () => Promise<void>;
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
  now?: () => string;
}

function validToolName(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** One identity for a tool step: the top-level `tool_name` and
 *  `tool_info.name` must agree when both are present (ADR-0057 F4b). */
function correlatedToolName(topLevelName: unknown, nestedName: unknown): unknown {
  return topLevelName === undefined
    ? nestedName
    : nestedName === undefined
      ? topLevelName
      : validToolName(topLevelName) && validToolName(nestedName) && topLevelName === nestedName
        ? topLevelName
        : null;
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

export function initialStatusExt(
  config: AntigravityLaunchConfig,
  // issue #292 (phase-34 Stage B6): same merge as the constructor's own
  // #catalog assignment below, applied as the default so a caller that
  // omits `models` (the two direct unit tests below) still sees a
  // declared model, not only the production call site which always
  // passes the current #catalog explicitly.
  models = mergeExtraModels(antigravityCatalogSnapshot(), config.antigravity_extra_models),
  // issue #359 M1: gate the supports_permission_switch advertisement on a
  // successful permission_sync negotiation (Codex parity). Defaults false so a
  // caller computing the pre-negotiation status advertises no selector, and a
  // legacy server that cannot sync stays fail-closed.
  permissionSyncSupported = false,
): Record<string, unknown> {
  const sandbox = config.sandbox ?? "workspace-write";
  const approval = config.approval ?? "on-request";
  // ADR-0057 F4c Stage B0 (issue #359): advertise the per-axis runtime
  // permission-switch ceilings the runner resolved and relayed. All three
  // must be present (the runner always relays them together for antigravity);
  // a legacy runner that omits them keeps Stage A behaviour — no advertised
  // clamp, supports_permission_switch fail-closed absent. The wrapper is the
  // source of truth for these; the server clamps against them (first gate)
  // and setPermission re-checks fail-closed (final gate).
  const switchAxes =
    config.max_sandbox !== undefined &&
    config.max_approval !== undefined &&
    config.max_network_access !== undefined
      ? {
          sandbox: { max: config.max_sandbox },
          network_access: { max: config.max_network_access },
          approval: { max: config.max_approval },
        }
      : undefined;
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
      ...(switchAxes === undefined || !permissionSyncSupported
        ? {}
        : {
            supports_permission_switch: true,
            permission_switch_axes: switchAxes,
          }),
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
  #turnQueue: Array<{
    text: string;
    conversationIds?: readonly string[];
    turnToken?: string;
  }> = [];
  #customization: CustomizationDir | null = null;
  #pendingPermission: PendingPermissionExt | null = null;
  #pendingQuestion: PendingQuestionExt | null = null;
  #lastRevision = 0;
  #gateBroken = false;
  #turnActive = false;
  #activeTurnToken: string | null = null;
  #activeTurnConversationIds: readonly string[] = [];
  #activeTurnToolTimeout: ToolTimeoutInfo | null = null;
  #watchdogFailStopped = false;
  #lifecycleGeneration = 0;
  #toolHost: ToolHost | null = null;
  #gateServer: GateServer | null = null;
  #gateProbe: GateProbe | null = null;
  #cancelGateProbe: (() => void) | null = null;
  #catalog: EngineModelInfo[] = antigravityCatalogSnapshot();
  readonly #agyExecutable: AgyExecutableResolution;
  readonly #probeTimeoutMs: number;
  #pendingModel: string | null = null;
  #switchError: Record<string, unknown> | null = null;
  // ADR-0057 F4c Stage B0 (issue #359): a server-accepted permission switch
  // awaiting the next execution boundary (applied at the start of the next
  // turn so a running gate is never mutated mid-turn), and the latest control
  // record echoed to the server as ext.permission_control so it can advance
  // pending -> applied / failed.
  #pendingPermissionSwitch:
    | { revision: number; requested: PermissionConfiguration }
    | null = null;
  // A switch whose config took effect this turn but whose applied observation
  // waits for the engine's init to confirm session identity (M4).
  #pendingAppliedObservation:
    | { submission: PermissionSubmission; approval: PermissionAxesExt["approval"] }
    | null = null;
  #permissionControl: PermissionControlExt | null = null;
  #lastEffectivePermission: PermissionObservation | null = null;
  // issue #359 M1: whether the server accepted permission_sync for this
  // connection. Gates the supports_permission_switch advertisement and seeds
  // the revision-0 baseline; updated on every join reply (setPermissionSyncSupported).
  #permissionSyncSupported = false;
  readonly #toolNames = new Map<string, string>();
  readonly #rateLimits = new Map<
    string,
    { status?: string; utilization?: number; resets_at?: number }
  >();

  constructor(config: WrapperConfig, options: AntigravityHostOptions) {
    this.#config = config as AntigravityLaunchConfig;
    if (this.#config.approval === "on-failure") {
      throw new Error("antigravity approval=on-failure is unsupported");
    }
    // issue #292 (phase-34 Stage B6): layer antigravity_extra_models on top
    // of the pinned snapshot before the live probe below (#refreshCatalog)
    // has a chance to run, so a declared model is visible even if the
    // probe never completes (agy binary absent, timeout, unparsable
    // output).
    this.#catalog = mergeExtraModels(
      antigravityCatalogSnapshot(),
      this.#config.antigravity_extra_models,
    );
    this.#options = options;
    this.#agyExecutable = options.agyPath === undefined
      ? resolveAgyExecutable(this.#config.antigravity_cli_path)
      : { ok: true, path: options.agyPath };
    this.#probeTimeoutMs = options.gateProbeTimeoutMs
      ?? this.#config.antigravity_probe_timeout_ms
      ?? DEFAULT_AGY_PROBE_TIMEOUT_MS;
    this.#sessionId = options.resumeSessionId ?? null;
    this.#now = options.now ?? (() => new Date().toISOString());
    // issue #359 M1: with sync negotiated, seed the revision-0 baseline control
    // (Codex parity) so the first status snapshot carries ext.permission_control
    // and the server can allocate switch revisions against it. Without it the
    // first set_permission is rejected as permission_not_ready. A reconnect's
    // durable control (applyPermissionSync) later supersedes this baseline.
    this.#permissionSyncSupported = options.permissionSyncSupported ?? false;
    if (this.#permissionSyncSupported) {
      this.#permissionControl = this.#baselineControl();
    }
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

  async send(
    text: string,
    attachmentIds?: string[],
    conversationIds?: readonly string[],
    turnToken?: string,
  ): Promise<void> {
    if (this.#closed || this.#gateBroken || this.#watchdogFailStopped) return;
    if (attachmentIds !== undefined && attachmentIds.length > 0) {
      this.#warn("antigravity: attachments are unsupported");
      return;
    }
    this.#apply({ kind: "user_send" });
    this.#turnQueue.push({
      text,
      ...(conversationIds === undefined ? {} : { conversationIds }),
      ...(turnToken === undefined ? {} : { turnToken }),
    });
    void this.#drainTurns();
  }

  /** The capability supplied to inter-agent tools only while this agy turn runs. */
  activeInterAgentTurnToken(): string | null {
    return this.#activeTurnToken;
  }

  async interrupt(): Promise<void> {
    this.#lifecycleGeneration += 1;
    // Preserve queued turns (issue #358): an ordinary interrupt aborts only
    // the active turn (via the generation bump + SIGTERM below). Queued
    // inter-agent turns are already accepted deliveries, so dropping them
    // silently would strand the sender's delivery ledger with no ack and no
    // notice. The drain loop's `finally` re-kick picks them up after the
    // active turn unwinds, running each under the new generation with its
    // own delivery token. Antigravity rejects attachments at `send()`, so
    // the queue never holds a temp turn to discard (unlike Codex). Queue
    // retirement on close / fail-stop is issue #354's explicit path.
    this.#options.permissionBroker.close();
    this.#options.questionBroker?.close();
    this.#clearPendingAfterInterrupt();
    this.#gateServer?.close();
    this.#toolHost?.close();
    this.#cancelGateProbe?.();
    this.#gateProbe?.kill?.("SIGTERM");
    this.#running?.kill("SIGTERM");
  }

  requestInterruptForTurn(turnToken: string, cause?: TurnWatchdogInterruptCause): boolean {
    if (
      this.#activeTurnToken !== turnToken ||
      this.#watchdogFailStopped ||
      this.#closed
    ) {
      return false;
    }
    // The CLI already logs the watchdog warning; the host only keeps the
    // cause so settlement can override the CLI's terminal record.
    if (cause?.kind === "tool_timeout") this.#activeTurnToolTimeout = cause;
    return this.#running?.kill("SIGTERM") ?? false;
  }

  failStopTurnForWatchdog(turnToken: string): boolean {
    if (
      this.#activeTurnToken !== turnToken ||
      this.#watchdogFailStopped ||
      this.#closed
    ) {
      return false;
    }
    return this.#failStopForWatchdog("exact");
  }

  failStopForWatchdogAttributionUnknown(): boolean {
    if (this.#watchdogFailStopped) return false;
    return this.#failStopForWatchdog("unattributed");
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

  /** This session's advertised per-axis permission-switch ceiling, or null when
   *  the runner relayed no clamp (a legacy runner — Stage A, switching off). */
  #permissionCeiling(): SwitchCeiling | null {
    const { max_sandbox, max_approval, max_network_access } = this.#config;
    if (
      max_sandbox === undefined ||
      max_approval === undefined ||
      max_network_access === undefined
    ) {
      return null;
    }
    return {
      sandbox: max_sandbox,
      approval: max_approval,
      network_access: max_network_access,
    };
  }

  /** The cell currently enforced (the launch defaults until a switch applies). */
  #currentCell(): Required<PermissionConfiguration> {
    return {
      sandbox: this.#config.sandbox ?? "workspace-write",
      network_access: this.#config.network_access ?? false,
      approval: this.#config.approval ?? "on-request",
    };
  }

  #permissionConstraints(
    approval: PermissionAxesExt["approval"],
  ): PermissionControlExt["constraints"] {
    // enforcement is always "advisory" for antigravity (the --sandbox flag has
    // no OS effect; the gate inspects tool arguments, ADR-0057 F4). approval is
    // required by the control shape but, unlike Codex's fixed "never", is not
    // rendered for antigravity (ext.permission carries the observed value); the
    // current effective approval is the truthful contract to report.
    return { approval, enforcement: "advisory" };
  }

  /** The revision-0 baseline control emitted once permission_sync is negotiated
   *  (Codex parity, issue #359 M1): the launch cell as `pending` with no
   *  submitted / effective evidence, so the server seeds its ledger and
   *  allocates switch revisions against it. */
  #baselineControl(): PermissionControlExt {
    const cell = this.#currentCell();
    return {
      revision: 0,
      requested: cell,
      status: "pending",
      constraints: this.#permissionConstraints(cell.approval),
    };
  }

  /** Called by the CLI after each join reply (Codex parity, issue #359 M1). A
   *  legacy server that cannot sync leaves the selector unadvertised. A
   *  re-negotiated connection re-seeds the baseline only when no control exists
   *  yet — a durable control adopted by applyPermissionSync is preserved. */
  setPermissionSyncSupported(supported: boolean): void {
    if (this.#permissionSyncSupported === supported) return;
    this.#permissionSyncSupported = supported;
    if (supported && this.#permissionControl === null) {
      this.#permissionControl = this.#baselineControl();
    }
    this.#emitState(this.#machine.state);
  }

  /** Applies the server's permission_sync for this connection (issue #359 M1).
   *  On reconnect the server relays the durable control and the cell that
   *  should be enforced (`next`); this adopts the control and re-applies `next`
   *  to #config so the next turn's gate reads it. The wrapper is the final gate:
   *  a `next` exceeding the launch ceiling is refused fail-closed, leaving the
   *  current cell. Unlike a live set_permission this emits no applied
   *  observation — the switch already applied before the disconnect. */
  applyPermissionSync(message: PermissionSyncMessage): void {
    if (message.control === null) return;
    const control = message.control;
    // A stale relay cannot regress an already-adopted higher revision.
    if (control.revision < (this.#permissionControl?.revision ?? -1)) return;
    this.#permissionControl = control;
    if (control.status === "applied") {
      this.#lastEffectivePermission = control.effective;
    } else if (control.last_effective !== undefined) {
      this.#lastEffectivePermission = control.last_effective;
    }
    const next = message.next.requested;
    // The server relays approval for antigravity; keep the current value if a
    // legacy sandbox/network-only next omits it. Resolved to a concrete value so
    // #config.approval (non-optional) never receives undefined.
    const approval = next.approval ?? this.#currentCell().approval;
    const cell: PermissionConfiguration = {
      sandbox: next.sandbox,
      network_access: next.network_access,
      approval,
    };
    const ceiling = this.#permissionCeiling();
    if (ceiling !== null && ceilingExceeded(cell, ceiling) !== null) {
      this.#warn("antigravity: permission_sync next exceeds the launch ceiling; ignored");
    } else {
      this.#config.sandbox = cell.sandbox;
      this.#config.network_access = cell.network_access;
      this.#config.approval = approval;
    }
    this.#emitState(this.#machine.state);
  }

  /** Applies a staged permission switch at the start of a turn (ADR-0057 F4c
   *  Stage B0): mutates #config so the turn's fresh gate enforces the new cell,
   *  then reports the applied observation as both ext.permission_control and a
   *  `permission_applied` audit event. */
  /** Applies a staged permission switch at the start of a turn (ADR-0057 F4c
   *  Stage B0): mutates #config so the turn's fresh gate enforces the new cell.
   *  The switch is reported as `applying` here (submitted captured, no
   *  effective yet) and only PROMOTED to `applied` once the engine's `init`
   *  event confirms this turn's session identity — session_id / turn_id are
   *  engine-observed and must never be manufactured from a wrapper token
   *  (protocol.md, PermissionObservation; #confirmAppliedPermission). */
  #applyPendingPermissionSwitch(turnToken: string): void {
    const pending = this.#pendingPermissionSwitch;
    if (pending === null) return;
    this.#pendingPermissionSwitch = null;
    const cell = pending.requested;
    this.#config.sandbox = cell.sandbox;
    this.#config.network_access = cell.network_access;
    if (cell.approval !== undefined) this.#config.approval = cell.approval;
    const approval = this.#config.approval ?? "on-request";
    const requested: PermissionConfiguration = {
      sandbox: cell.sandbox,
      network_access: cell.network_access,
      approval,
    };
    const submission: PermissionSubmission = {
      revision: pending.revision,
      requested,
      execution_id: turnToken,
    };
    this.#pendingAppliedObservation = { submission, approval };
    this.#permissionControl = {
      revision: pending.revision,
      requested,
      status: "applying",
      constraints: this.#permissionConstraints(approval),
      submitted: submission,
      ...(this.#lastEffectivePermission === null
        ? {}
        : { last_effective: this.#lastEffectivePermission }),
    };
    this.#emitState(this.#machine.state);
  }

  /** Promotes an `applying` permission switch to `applied` once the engine's
   *  `init` event has set this turn's session identity (M4). session_id is the
   *  engine-observed conversation id; turn_id is OMITTED — Antigravity has no
   *  per-turn identifier and manufacturing one from the session id or a wrapper
   *  token is forbidden (issue #359 M1, protocol.md "engine-observed
   *  identities"). execution_id is the wrapper's own correlation token. */
  #confirmAppliedPermission(): void {
    const pending = this.#pendingAppliedObservation;
    if (pending === null || this.#sessionId === null) return;
    this.#pendingAppliedObservation = null;
    const { submission, approval } = pending;
    const cell = submission.requested;
    const observation: PermissionObservation = {
      ...submission,
      session_id: this.#sessionId,
      permission: { sandbox: cell.sandbox, approval, enforcement: "advisory" },
      network_access: effectiveNetworkAccess(cell.sandbox, cell.network_access),
    };
    this.#lastEffectivePermission = observation;
    this.#permissionControl = {
      revision: submission.revision,
      requested: cell,
      status: "applied",
      constraints: this.#permissionConstraints(approval),
      submitted: submission,
      effective: observation,
      last_effective: observation,
    };
    this.#options.onPermissionLifecycle?.({
      version: "0",
      kind: "permission_applied",
      at: this.#now(),
      details: observation,
    });
    this.#emitState(this.#machine.state);
  }

  /** Applies a server-originated permission switch at the NEXT execution
   *  boundary (ADR-0057 F4c Stage B0, issue #359). The requested cell is
   *  re-checked fail-closed against this session's advertised ceiling (the
   *  wrapper's final gate); a violation is reported as `permission_failed`
   *  with the current cell as `rolled_back_to` and the config is left
   *  untouched. An accepted switch is staged and applied when the next turn
   *  starts (`#applyPendingPermissionSwitch`), so a running gate is never
   *  mutated mid-turn. */
  async setPermission(selection: PermissionSelection): Promise<void> {
    const ceiling = this.#permissionCeiling();
    if (ceiling === null) {
      throw new Error(
        "antigravity: permission switching is not advertised for this session",
      );
    }
    const current = this.#currentCell();
    const requested = selection.requested;
    const target: PermissionConfiguration = {
      sandbox: requested.sandbox,
      network_access: requested.network_access,
      // The server relays approval for antigravity; keep the current value if a
      // legacy sandbox/network-only request omits it.
      approval: requested.approval ?? current.approval,
    };
    const violation = ceilingExceeded(target, ceiling);
    if (violation !== null) {
      this.#pendingPermissionSwitch = null;
      this.#permissionControl = {
        revision: selection.revision,
        requested: target,
        status: "failed",
        constraints: this.#permissionConstraints(current.approval),
        reason: "exceeds_launch_ceiling",
        rolled_back_to: current,
        ...(this.#lastEffectivePermission === null
          ? {}
          : { last_effective: this.#lastEffectivePermission }),
      };
      this.#emitState(this.#machine.state);
      this.#options.onPermissionLifecycle?.({
        version: "0",
        kind: "permission_failed",
        at: this.#now(),
        details: {
          revision: selection.revision,
          requested: target,
          reason: "exceeds_launch_ceiling",
          rolled_back_to: current,
        },
      });
      this.#warn(`antigravity: set_permission rejected: ${violation}`);
      return;
    }
    this.#pendingPermissionSwitch = { revision: selection.revision, requested: target };
    this.#permissionControl = {
      revision: selection.revision,
      requested: target,
      status: "pending",
      constraints: this.#permissionConstraints(current.approval),
      ...(this.#lastEffectivePermission === null
        ? {}
        : { last_effective: this.#lastEffectivePermission }),
    };
    this.#emitState(this.#machine.state);
  }

  async setPermissionMode(_mode: PermissionMode): Promise<void> {
    throw new Error(
      "antigravity: permission-mode switching is unsupported; use set_permission " +
        "for the sandbox / approval / network_access axes (ADR-0057 F4c)",
    );
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
    return this.statusExtSnapshot();
  }

  statusExtSnapshot(): Record<string, unknown> {
    return this.#statusExt();
  }

  async #drainTurns(): Promise<void> {
    if (this.#turnActive || this.#closed || this.#gateBroken || this.#watchdogFailStopped) return;
    const turn = this.#turnQueue.shift();
    if (turn === undefined) return;
    this.#turnActive = true;
    const generation = this.#lifecycleGeneration;
    // Every turn gets a token (Codex parity) so the watchdog bounds operator
    // instructions too; inter-agent bookkeeping ignores a token it never
    // issued.
    const turnToken = turn.turnToken ?? randomUUID();
    let error: InterAgentErrorClassifyInput | undefined;
    try {
      error = await this.#runTurn(turn.text, generation, turnToken, turn.conversationIds ?? []);
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : String(caught);
      error = { detail };
      if (this.#isCurrent(generation)) this.#terminalError(detail);
    } finally {
      this.#running = null;
      this.#turnActive = false;
      if (!this.#watchdogFailStopped) {
        this.#options.onTurnBoundary?.({ turnToken });
        this.#options.onTurnEnd?.({
          turnToken,
          conversationIds: turn.conversationIds ?? [],
          ...(error === undefined ? {} : { error }),
        });
      }
      if (this.#activeTurnToken === turnToken) {
        this.#activeTurnToken = null;
        this.#activeTurnConversationIds = [];
      }
      void this.#drainTurns();
    }
  }

  async #runTurn(
    text: string,
    generation: number,
    turnToken: string,
    conversationIds: readonly string[],
  ): Promise<InterAgentErrorClassifyInput | undefined> {
    if (!this.#agyExecutable.ok) {
      throw new Error(`antigravity_cli_unavailable:${this.#agyExecutable.reason}`);
    }
    const executable = this.#agyExecutable.path;
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
      if (!this.#isCurrent(generation)) return undefined;
      // issue #359 M1: block this turn's gate until the server's permission_sync
      // for the current connection has been applied, so a durable control/next
      // relayed on reconnect lands before the gate reads the cell. A no-op once
      // the sync arrived, or when sync is unsupported.
      await (this.#options.waitForPermissionSync?.() ?? Promise.resolve());
      if (!this.#isCurrent(generation)) return undefined;
      // ADR-0057 F4c Stage B0 (issue #359): apply a staged permission switch
      // now, at the execution boundary, so this turn's fresh gate below reads
      // the new cell while the just-ended turn's gate was left untouched.
      this.#applyPendingPermissionSwitch(turnToken);
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
      if (!this.#isCurrent(generation)) return undefined;
      this.#toolHost = toolHost;
      this.#gateServer = gateServer;
      const registration = await this.#verifyGateRegistration(generation);
      if (!registration.ok) {
        throw new Error(`antigravity_gate_not_registered:${registration.reason}`);
      }
      if (!this.#isCurrent(generation)) return;
      const attemptedModel = this.#pendingModel;
      const args = this.#turnArguments(text, customization.path, attemptedModel ?? this.#config.model);
      let child: SpawnedAgy;
      try {
        child = (this.#options.spawn ?? this.#defaultSpawn)(executable, args, {
          cwd: this.#options.cwd,
          env: {
            ...process.env,
            ...nonInteractiveToolEnv(process.env).additions,
            KAOIRO_GATE_SOCKET: gateServer.socketPath,
            KAOIRO_GATE_NONCE: gateServer.nonce,
            KAOIRO_GATE_DEADLINE_MS: String(GATE_DEADLINE_MS),
            KAOIRO_BRIDGE_SOCKET: toolHost.socketPath,
            KAOIRO_BRIDGE_NONCE: toolHost.nonce,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`antigravity_cli_${this.#spawnFailureReason(error)}: ${boundErrorDetail(message)}`);
      }
      this.#running = child;
      this.#activeTurnToolTimeout = null;
      this.#activeTurnToken = turnToken;
      this.#activeTurnConversationIds = conversationIds;
      this.#options.onTurnStart?.({ turnToken, conversationIds });
      child.stdin.end();
      child.stderr.on("data", () => {});
      let terminalResult: AgyStreamEvent | null = null;
      let correlationFailure: string | null = null;
      const assistantText = new Map<number, string>();
      readableLines(child.stdout, (line) => {
        this.#options.onTurnProgress?.({ turnToken });
        const event = parseAgyStreamLine(line);
        if (event === null) {
          this.#warn(`antigravity: ignored malformed stream line from ${basename(executable)}`);
          return;
        }
        if (event.event === "result") {
          terminalResult ??= event;
          return;
        }
        this.#handleEvent(event, gate, assistantText);
        if (event.event !== "step_update" || event.step_update.step_type !== "tool") return;
        const stepIndex = event.step_update.step_index;
        const topLevelName = event.step_update.tool_name;
        const nestedName = event.step_update.tool_info?.name;
        const state = event.step_update.state;
        if (state !== "ACTIVE" && state !== "DONE" && state !== "ERROR") return;
        const toolName = correlatedToolName(topLevelName, nestedName);
        if (!Number.isSafeInteger(stepIndex) || !validToolName(toolName)) {
          // An ACTIVE step the deadline cannot key on is as unprovable as a
          // completion the gate cannot correlate: fail closed either way.
          correlationFailure = validToolName(topLevelName) ? topLevelName : validToolName(nestedName) ? nestedName : "unknown";
          this.#warn(`antigravity: ${state === "ACTIVE" ? "started" : "completed"} tool correlation is unprovable: ${correlationFailure}`);
          child.kill("SIGTERM");
          return;
        }
        if (state === "ACTIVE") {
          this.#options.onToolStart?.({ turnToken, stepIndex: stepIndex as number, toolName });
          return;
        }
        this.#options.onToolEnd?.({ turnToken, stepIndex: stepIndex as number });
        if (!gate.observeCompletedTool(stepIndex as number, toolName)) {
          correlationFailure = toolName;
          child.kill("SIGTERM");
        }
      });
      const childError = await this.#waitForChild(child);
      if (this.#closed || this.#watchdogFailStopped) return undefined;
      if (customization.verify() !== true) {
        this.#gateBroken = true;
        const detail = "antigravity_customization_tampered";
        this.#terminalError(detail, attemptedModel);
        return { detail };
      } else if (!this.#isCurrent(generation)) {
        return undefined;
      } else if (correlationFailure !== null) {
        this.#gateBroken = true;
        const detail = `antigravity_gate_unobserved_tool:${correlationFailure}`;
        this.#terminalError(detail, attemptedModel);
        return { detail };
      } else if (this.#activeTurnToolTimeout !== null) {
        // Whatever agy printed after SIGTERM, the turn outcome is the
        // deadline, not the CLI's own terminal record.
        this.#terminalError("tool_timeout", attemptedModel);
        return { reason: "timeout" };
      } else if (childError !== null) {
        const detail = `antigravity_cli_${this.#spawnFailureReason(childError)}: ${boundErrorDetail(childError.message)}`;
        this.#terminalError(detail, attemptedModel);
        return { detail };
      } else if (terminalResult === null) {
        const detail = "agy_exit_without_result";
        this.#terminalError(detail, attemptedModel);
        return { detail };
      } else {
        const result = agyEventToResult(terminalResult);
        const quota = agyEventToQuotaExhaustion(terminalResult);
        if (quota !== null) {
          this.#rateLimits.set("seven_day", {
            status: "blocked",
            utilization: 1,
            resets_at: Math.floor(Date.parse(this.#now()) / 1_000) + quota.resetDelaySeconds,
          });
        } else if (agyEventIsSuccessfulResult(terminalResult)) {
          this.#rateLimits.delete("seven_day");
        }
        if (result?.is_error === true) this.#rollbackPendingModel(attemptedModel);
        else this.#promotePendingModel(attemptedModel);
        this.#publishTerminalResult(terminalResult);
        if (quota !== null) {
          return {
            reason: "blocking_limit",
            rateLimitResetSeconds: quota.resetDelaySeconds,
          };
        }
        return result?.is_error === true ? { detail: "antigravity turn failed" } : undefined;
      }
    } finally {
      this.#activeTurnToolTimeout = null;
      gateServer?.close();
      toolHost?.close();
      if (this.#gateServer === gateServer) this.#gateServer = null;
      if (this.#toolHost === toolHost) this.#toolHost = null;
    }
  }

  #failStopForWatchdog(attribution: "exact" | "unattributed"): boolean {
    this.#watchdogFailStopped = true;
    this.#closed = true;
    this.#lifecycleGeneration += 1;
    const queued = this.#turnQueue.splice(0);
    this.#options.permissionBroker.close();
    this.#options.questionBroker?.close();
    this.#clearPendingAfterInterrupt();
    this.#gateServer?.close();
    this.#toolHost?.close();
    this.#cancelGateProbe?.();
    this.#gateProbe?.kill?.("SIGTERM");
    this.#running?.kill("SIGTERM");
    const error = {
      detail: attribution === "exact"
        ? "turn watchdog interrupt grace expired; host admission stopped pending operator recovery"
        : "turn watchdog token attribution unavailable; host admission stopped pending operator recovery",
    };
    for (const turn of queued) {
      if (turn.turnToken === undefined) continue;
      this.#options.onTurnEnd?.({
        turnToken: turn.turnToken,
        conversationIds: turn.conversationIds ?? [],
        error,
        cancellation: { kind: "watchdog_fail_stop", started: false },
      });
    }
    this.#options.onWatchdogFailStop?.({
      ...(this.#activeTurnToken === null ? {} : { turnToken: this.#activeTurnToken }),
      conversationIds: this.#activeTurnConversationIds,
      attribution,
    });
    return true;
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

  #handleEvent(event: AgyStreamEvent, gate: AntigravityGate, assistantText: Map<number, string>): void {
    if (event.event === "init") {
      gate.inspectToolInventory(Array.isArray(event.init.tools) ? event.init.tools : []);
      const sessionId = agyEventToSessionId(event);
      if (sessionId !== null) {
        this.#sessionId = sessionId;
        this.#options.onSessionId?.(sessionId);
        // M4: now that the engine has confirmed this turn's session identity,
        // promote any applied-but-unconfirmed permission switch to `applied`
        // with engine-observed session_id / turn_id.
        this.#confirmAppliedPermission();
      }
    }
    const step = event.event === "step_update" ? event.step_update : null;
    if (step?.step_type === "agent_response" && typeof step.step_index === "number" && Number.isSafeInteger(step.step_index)) {
      const stepIndex = step.step_index;
      if (typeof step.text_delta === "string") {
        assistantText.set(stepIndex, `${assistantText.get(stepIndex) ?? ""}${step.text_delta}`);
      }
      if (step.state === "DONE") {
        const text = assistantText.get(stepIndex);
        assistantText.delete(stepIndex);
        if (text !== undefined && text !== "") this.#emitLog({ kind: "assistant", text });
      }
    }
    for (const log of agyEventToLogs(event)) {
      if (log.kind !== "assistant") this.#emitLog(log);
    }
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

  async #verifyGateRegistration(generation: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!this.#agyExecutable.ok) return { ok: false, reason: this.#agyExecutable.reason };
    const executable = this.#agyExecutable.path;
    const args = ["-p", "/hooks", "--add-dir", this.#options.cwd, "--add-dir", this.#customization!.path, "--output-format", "json"];
    return new Promise((resolveProbe) => {
      let settled = false;
      let child: GateProbe | null = null;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const settle = (value: { ok: true } | { ok: false; reason: string }): void => {
        if (settled) return;
        settled = true;
        if (timeout !== null) clearTimeout(timeout);
        if (this.#cancelGateProbe === cancel) this.#cancelGateProbe = null;
        if (this.#gateProbe === child) this.#gateProbe = null;
        resolveProbe(value);
      };
      const cancel = (): void => {
        child?.kill?.("SIGTERM");
        settle({ ok: false, reason: "timeout" });
      };
      timeout = setTimeout(cancel, this.#probeTimeoutMs);
      this.#cancelGateProbe = cancel;
      if (this.#options.verifyGate !== undefined) {
        void this.#options.verifyGate(args).then(
          (registered) => settle(registered && this.#isCurrent(generation)
            ? { ok: true }
            : { ok: false, reason: "registration_mismatch" }),
          () => settle({ ok: false, reason: "spawn_failure" }),
        );
        return;
      }
      let probeChild: GateProbe;
      try {
        probeChild = this.#options.probeSpawn?.(executable, args, { cwd: this.#options.cwd })
          ?? spawn(executable, args, { cwd: this.#options.cwd, stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        settle({ ok: false, reason: `spawn_failure:${boundErrorDetail(detail)}` });
        return;
      }
      child = probeChild;
      this.#gateProbe = probeChild;
      let output = "";
      let stderr = "";
      let stdoutEnded = false;
      let closeCode: number | null | undefined;
      const finishClose = (): void => {
        if (!stdoutEnded || closeCode === undefined) return;
        if (closeCode !== 0) {
          settle({ ok: false, reason: `nonzero_exit${stderr === "" ? "" : `:${boundErrorDetail(stderr)}`}` });
          return;
        }
        try {
          const registered = isGateRegistered(JSON.parse(output) as unknown, {
            source: join(this.#customization!.path, ".agents", "hooks.json"),
            command: `${this.#options.nodePath ?? process.execPath} ${HOOK_SCRIPT}`,
            timeoutSeconds: HOOK_TIMEOUT_SECONDS,
          });
          settle(registered && this.#isCurrent(generation)
            ? { ok: true }
            : { ok: false, reason: "registration_mismatch" });
        } catch {
          settle({ ok: false, reason: "invalid_json" });
        }
      };
      probeChild.stdout.setEncoding("utf8");
      probeChild.stdout.on("data", (chunk: string) => { output += chunk; });
      probeChild.stdout.once("end", () => { stdoutEnded = true; finishClose(); });
      probeChild.stderr?.setEncoding("utf8");
      probeChild.stderr?.on("data", (chunk: string) => { stderr += chunk; });
      probeChild.once("error", (error) => {
        settle({ ok: false, reason: `spawn_failure:${boundErrorDetail(error.message)}` });
      });
      probeChild.once("close", (code) => { closeCode = code; finishClose(); });
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
    // issue #292 (phase-34 Stage B6): re-apply the merge on top of the
    // freshly probed catalog so a live refresh does not drop an
    // operator-declared extra model that the pinned snapshot merge above
    // already exposed.
    this.#catalog = mergeExtraModels(catalog, this.#config.antigravity_extra_models);
    this.#emitState(this.#machine.state);
  }

  #defaultProbeModels(): Promise<EngineModelInfo[] | null> {
    if (!this.#agyExecutable.ok) return Promise.resolve(null);
    const executable = this.#agyExecutable.path;
    return new Promise((resolveProbe) => {
      let output = "";
      let child: GateProbe;
      try {
        child = this.#options.modelsProbeSpawn?.(executable, ["models"], { cwd: this.#options.cwd })
          ?? spawn(executable, ["models"], {
            cwd: this.#options.cwd,
            stdio: ["ignore", "pipe", "pipe"],
          });
      } catch {
        resolveProbe(null);
        return;
      }
      const timeout = setTimeout(() => {
        child.kill?.("SIGTERM");
        resolveProbe(null);
      }, this.#probeTimeoutMs);
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
    const ext = initialStatusExt(this.#config, this.#catalog, this.#permissionSyncSupported);
    if (this.#pendingModel !== null) ext.pending_model = this.#pendingModel;
    if (this.#switchError !== null) {
      ext.switch_error = this.#switchError;
      if (consumeOneShot) this.#switchError = null;
    }
    if (this.#pendingPermission !== null) ext.pending_permission = this.#pendingPermission;
    // ADR-0057 F4c Stage B0 (issue #359): echo the permission-switch control so
    // the server advances pending -> applied / failed (record_observation).
    if (this.#permissionControl !== null) ext.permission_control = this.#permissionControl;
    if (this.#pendingQuestion !== null) ext.pending_question = this.#pendingQuestion;
    if (this.#rateLimits.size > 0) ext.rate_limits = Object.fromEntries(this.#rateLimits);
    ext.cwd = this.#options.cwd;
    return ext;
  }

  #warn(message: string): void {
    if (this.#options.warn !== undefined) {
      this.#options.warn(boundErrorDetail(message));
      return;
    }
    writeRedactedStderr(`${message}\n`);
  }

  #spawnFailureReason(error: unknown): AgyExecutableFailureReason {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return "executable_missing";
    if (code === "EACCES" || code === "EPERM") return "permission_denied";
    return "spawn_failure";
  }

  #defaultSpawn(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): SpawnedAgy {
    return spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
  }
}
