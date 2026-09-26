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
import { DEFAULT_EPOCH_IDLE_MS, epochSpecsEqual, type EpochEndReason, type EpochSpec } from "./epoch.js";
import { AntigravityGate, GateServer, type AntigravityLaunchConfig, type GateServerOptions } from "./gate.js";
import { effectiveNetworkAccess } from "./network_access.js";
import { ceilingExceeded, type SwitchCeiling } from "./permission_switch.js";
import { nonInteractiveToolEnv } from "./tool_child_env.js";
import { ToolHost } from "./toolhost.js";
import { DEFAULT_TURN_WATCHDOG_ABORT_GRACE_MS } from "./turn_watchdog.js";
import type { ToolTimeoutInfo, TurnWatchdogInterruptCause } from "./turn_watchdog.js";
import { signalSubtree, terminateWithGrace, type GraceTerminationHandle } from "./subtree_termination.js";

const BRIDGE_SCRIPT = new URL("../dist/bridge.js", import.meta.url).pathname;
const HOOK_SCRIPT = new URL("../dist/hook.js", import.meta.url).pathname;
// issue #379 M2: must stay below the tightest outer bound that can SIGKILL
// this wrapper PROCESS itself while `close()`'s own escalation is pending --
// currently the runner's reset-relaunch grace (`RESET_TERMINATION_GRACE_MS`
// = 5s, runner/src/supervisor.ts). systemd's `TimeoutStopSec` (30s) is looser
// and not the binding constraint.
const DEFAULT_CLOSE_GRACE_MS = 2_000;

/** issue #377 Stage 2: the two fixed background-task lifecycle lines agy
 *  prints to stderr (measured verbatim,
 *  docs/evidence/antigravity/print-mode-background-tasks.md probe 2 --
 *  `root agent idle; waiting up to %s for %d background task(s)` /
 *  `terminating %d background task(s) on exit`). Matched exactly so no
 *  other, unbounded stderr text is ever forwarded to the lifecycle log. */
const EPOCH_STDERR_WAITING_PATTERN = /^root agent idle; waiting up to \S+ for \d+ background task\(s\)$/;
const EPOCH_STDERR_TERMINATING_PATTERN = /^terminating \d+ background task\(s\) on exit$/;

/** issue #371 Design v2: `#runTurn` decides no terminal outcome itself --
 *  it returns one of these, and `#drainTurns`'s `finally` is the single
 *  place that projects an outcome into callbacks (`#terminalError` /
 *  `#publishTerminalResult` / rate-limit update / model promote-rollback /
 *  `onInterruptSettled` / `onTurnBoundary` / `onTurnEnd`). Invariant:
 *  `#currentTurnToken !== null` iff this turn's outcome has not yet been
 *  projected. Exception: `onWatchdogFailStop` deliberately fires while
 *  identity is still live (it reads `#activeTurnToken`); the queued turns
 *  it also settles never held identity at all. */
type TurnOutcome =
  | { kind: "stale" }
  | { kind: "skipped" }
  | { kind: "error"; detail: string; classify: InterAgentErrorClassifyInput; attemptedModel: string | null | undefined }
  | { kind: "result"; event: AgyStreamEvent; attemptedModel: string | null }
  | {
      kind: "interrupted";
      attemptedModel: string | null;
      exit: { code: number | null; signal: NodeJS.Signals | null } | null;
      requestedAt: string | undefined;
    };

/** issue #377 Stage 2: the live state of one epoch (one `agy` process
 *  spanning several turns). `endingReason` is set BEFORE the process is
 *  actually signalled to end, by whichever call site (interrupt/close/
 *  watchdog/tamper/gate_broken/spec_change/idle_ttl) decided to end it --
 *  the epoch's own close handler reads it to know this death was requested,
 *  as opposed to a spontaneous exit (`null`). `resolveDeath` lets `#endEpoch`
 *  await the child's actual closure instead of merely arming a signal. */
interface EpochRuntime {
  child: SpawnedAgy;
  spec: EpochSpec;
  toolHost: ToolHost;
  gateServer: GateServer;
  turns: number;
  idleTtlTimer: unknown | null;
  endingReason: EpochEndReason | null;
  deathPromise: Promise<void> | null;
  resolveDeath: (() => void) | null;
  stdinErrored: boolean;
  pendingDeliverySettle: ((delivered: boolean) => void) | null;
}

/** The turn currently owning the epoch's shared stdout stream. The epoch-
 *  level reader routes `result` events to `resolveResult` and folds every
 *  other event into this turn's own state (mirroring Stage 1's per-turn
 *  `#handleEvent` + tool ACTIVE/DONE correlation) -- exactly the
 *  `readableLines`/`#waitForChild` role Stage 1 attached per turn, now
 *  attached once per epoch and keyed off whichever turn is in flight. */
interface InFlightTurn {
  turnToken: string;
  gate: AntigravityGate;
  assistantText: Map<number, string>;
  correlationFailure: string | null;
  epochDeathError: Error | null;
  resolveResult: (event: AgyStreamEvent | null) => void;
}

export interface SpawnedAgy {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  stdin: NodeJS.WritableStream;
  /** Diagnostic-only (issue #371 `interrupt_requested` lifecycle event).
   *  Optional so existing fakes that construct a `SpawnedAgy` without it
   *  still satisfy the interface. */
  pid?: number | undefined;
  /** issue #379 M3: read at SIGKILL-escalation fire time to confirm the
   *  target is still running before signalling -- a pid can be reused once
   *  the process has actually exited. Optional so a fake that never tracks
   *  exit state is treated as always-alive (matches a real `ChildProcess`
   *  before `exit`). */
  exitCode?: number | null | undefined;
  signalCode?: NodeJS.Signals | null | undefined;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  /** issue #379: fires before `close` (no stdio-drain wait), so cancelling
   *  a pending escalation here frees it sooner than waiting for `close`. */
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
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
  /** Synchronous final check before writing the user input to the epoch. */
  prepareInput?: (turnToken: string) => { text: string; conversationIds: readonly string[] } | null | undefined;
  onTurnEnd?: (info: {
    turnToken: string;
    conversationIds: readonly string[];
    error?: InterAgentErrorClassifyInput;
    cancellation?:
      | { kind: "watchdog_fail_stop"; started: false }
      | { kind: "interrupt"; reason: "interrupted" };
    /** issue #396: true iff agy itself produced a `result` stream event for
     *  this turn -- NOT whether the turn succeeded. Set for a `result`
     *  outcome even when it carries `is_error: true` or an exhausted quota;
     *  false for `stale` / `interrupted` / `error` (wrapper-detected:
     *  tamper, gate violation, tool_timeout, crash, no-result) outcomes,
     *  where agy itself never confirmed anything. Same meaning as Codex's
     *  `terminal?: "turn.completed" | "turn.failed"`
     *  (`wrapper/codex/src/host.ts`), collapsed to a boolean because
     *  Antigravity has no SDK-side success/failure sub-type of its own to
     *  distinguish. A consumer that must act only on a real turn boundary
     *  (the deferred session reset, ADR-0043 D3) reads this rather than
     *  inferring from `error`/`cancellation` alone. */
    terminal: boolean;
  }) => void;
  onTurnBoundary?: (info: { turnToken: string }) => void;
  onTurnProgress?: (info: { turnToken: string }) => void;
  /** issue #377 Stage 2 N4: one epoch (agy process) ended, for any of the
   *  reasons in `EpochEndReason`. Fired at most once per epoch, from the
   *  moment its child is confirmed closed. Excludes a spontaneous exit
   *  while a turn was in flight -- that settles as the turn's own error
   *  (`agy_exit_without_result` / `epoch_exit_before_turn`), not this. */
  onEpochEnded?: (info: {
    reason: EpochEndReason;
    code: number | null;
    signal: NodeJS.Signals | null;
    turns: number;
  }) => void;
  /** issue #377 Stage 2: a stream-json line arrived while no turn owned the
   *  epoch's stream (no in-flight turn to attribute it to). Bounded on
   *  purpose -- no free text -- mirroring the stderr capture below. */
  onOutOfTurnEvent?: (
    info:
      | { eventKind: "init" }
      | { eventKind: "step_update"; stepIndex?: number; stepType?: string; state?: string }
      | { eventKind: "result"; status?: string },
  ) => void;
  /** issue #377 Stage 2: one of the two fixed background-task lifecycle
   *  lines agy prints to stderr (`EPOCH_STDERR_LINE_PATTERNS`), and only
   *  those -- every other stderr line is drained and discarded, never
   *  forwarded, so no free-form CLI text reaches the lifecycle log. */
  onEpochStderrLine?: (info: { kind: "waiting" | "terminating" }) => void;
  /** A parsed `step_update` tool step went ACTIVE / left ACTIVE. The
   *  watchdog keys its absolute tool deadline on `stepIndex`. */
  onToolStart?: (info: { turnToken: string; stepIndex: number; toolName: string }) => void;
  onToolEnd?: (info: { turnToken: string; stepIndex: number }) => void;
  onWatchdogFailStop?: (info: {
    turnToken?: string;
    conversationIds: readonly string[];
    attribution: "exact" | "unattributed";
  }) => void;
  /** issue #371: `interrupt()` targeted an active turn — fired synchronously
   *  from `interrupt()` itself, once per call that has a turn to target
   *  (an idle interrupt fires neither this nor `onInterruptSettled`). */
  onInterruptRequested?: (info: {
    turnToken: string;
    pendingPermission: boolean;
    pendingQuestion: boolean;
    childPid: number | null;
  }) => void;
  /** issue #371: the interrupted turn reached settlement (state back at
   *  rest). Fired at most once per `onInterruptRequested`. */
  onInterruptSettled?: (info: {
    turnToken: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    elapsedMs: number;
  }) => void;
  /** issue #371 S1: `send()` resolved without starting a turn (closed /
   *  gate-broken / fail-stopped) — the caller's own promise never rejects
   *  for this, so it cannot otherwise learn the reason. */
  onSendRejected?: (info: {
    turnToken?: string;
    reason: "closed" | "gate_broken" | "watchdog_fail_stopped" | "attachments_unsupported";
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
  /** Injectable for tests (issue #371): controls the timing of the
   *  pre-spawn `ToolHost.listen` await so a test can interrupt while it is
   *  still pending. Defaults to the real static method. */
  toolHostListen?: (descriptors: ToolDescriptor[]) => Promise<ToolHost>;
  /** Injectable for tests (issue #371), same rationale as `toolHostListen`
   *  for the pre-spawn `GateServer.listen` await. */
  gateServerListen?: (options: GateServerOptions) => Promise<GateServer>;
  probeSpawn?: (command: string, args: string[], options: { cwd: string }) => GateProbe;
  modelsProbeSpawn?: (command: string, args: string[], options: { cwd: string }) => GateProbe;
  verifyGate?: (args: string[]) => Promise<boolean>;
  gateProbeTimeoutMs?: number;
  /** Grace period (issue #379) between the initial SIGTERM and the SIGKILL
   *  escalation for an operator `interrupt()` or a gate-correlation-failure
   *  kill. Defaults to the CLI's resolved `TurnWatchdog` abort grace so the
   *  same "how long to wait for a clean exit" value applies everywhere. */
  abortGraceMs?: number;
  /** Grace period (issue #379 M2) between SIGTERM and SIGKILL specifically
   *  for `close()`. Deliberately separate from `abortGraceMs` and much
   *  shorter by default: an outer supervisor (runner reset:
   *  `RESET_TERMINATION_GRACE_MS` = 5s, or systemd `TimeoutStopSec` = 30s)
   *  may SIGKILL this wrapper PROCESS itself before a 60s abort grace could
   *  ever fire, which would leave the agy subtree orphaned with only the
   *  initial SIGTERM delivered. Keep this below the tightest outer bound. */
  closeGraceMs?: number;
  /** issue #377 Stage 2 M7: idle-epoch lifetime bound (`KAOIRO_ANTIGRAVITY_EPOCH_IDLE_MS`,
   *  read by the CLI entrypoint via `readEpochIdleMs`). Cleared at turn
   *  dequeue (before spec comparison / a possible respawn) and re-armed only
   *  once that turn's own result/error has settled, so the TTL can never
   *  fire mid-spawn or mid-delivery-ack. */
  epochIdleMs?: number;
  /** Injectable for tests (fake-timer pins): controls the idle-TTL timer
   *  only, independent of `subtree_termination`'s own grace timers. */
  epochIdleSetTimer?: (callback: () => void, delayMs: number) => unknown;
  epochIdleClearTimer?: (timer: unknown) => void;
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
      // issue #381: `new` and `clear` both map to the same fresh-relaunch
      // operation for this engine (no distinct primitive in the agy CLI
      // surface); the server's AgentStates/ClearWatermarks produce the
      // display difference (ADR-0057 F7).
      supports_session_reset: true,
      session_reset_modes: ["new", "clear"],
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
  #permissionWaitLeases = new Map<string, { turnToken: string; source: "bridge" | "native" }>();
  #permissionWaitBaseState: KaoiroState | null = null;
  #pendingQuestion: PendingQuestionExt | null = null;
  #lastRevision = 0;
  #gateBroken = false;
  #turnActive = false;
  #activeTurnToken: string | null = null;
  #activeTurnConversationIds: readonly string[] = [];
  #activeTurnToolTimeout: ToolTimeoutInfo | null = null;
  #watchdogFailStopped = false;
  #lifecycleGeneration = 0;
  /** The turnToken `#drainTurns` is currently processing, from the moment
   *  it dequeues a turn until the turn's `finally` clears it. Set earlier
   *  than `#activeTurnToken` (which only appears once the agy child has
   *  actually spawned), so `interrupt()` can record which turn it targets
   *  even during the pre-spawn setup phase. */
  #currentTurnToken: string | null = null;
  /** The model `#runTurn` attempted for the current turn, once computed,
   *  mirroring the `attemptedModel` local variable so a settlement outside
   *  `#runTurn` can roll back the same attempt (and only that attempt). */
  #currentAttemptedModel: string | null = null;
  /** issue #371: a one-shot record of the turn `interrupt()` targeted,
   *  written synchronously before the generation bump. Any later exit path
   *  that notices the stale generation consults it to tell "this turn was
   *  operator-interrupted" apart from any other cause (close, watchdog
   *  fail-stop, a genuine error) — the generation counter itself has
   *  already moved on by then. Cleared once the matching turn settles. */
  #interruptRecord: { turnToken: string; generation: number; at: string } | null = null;
  /** Exit info from the most recent agy child close, read by the interrupt
   *  settlement path for the `interrupt_settled` lifecycle event. */
  #lastChildExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  #toolHost: ToolHost | null = null;
  #gateServer: GateServer | null = null;
  // issue #377 Stage 2: the live epoch (one agy process spanning several
  // turns), if any is currently spawned. `#toolHost`/`#gateServer`/
  // `#running` mirror `#epoch`'s own fields while it is alive (kept in sync
  // by `#spawnEpoch` and the epoch's close handler), so `interrupt()` and
  // `close()`'s existing kill calls need no changes of their own -- ending
  // `#running` already ends the epoch that owns it. `#failStopForWatchdog`
  // and `requestInterruptForTurn` keep the same kill calls too, but each
  // gained one new line, `#markEpochEnding(...)`, since a SIGTERM/SIGKILL
  // now ends the whole multi-turn epoch rather than a single per-turn
  // process, and the epoch's close handler needs that reason recorded.
  #epoch: EpochRuntime | null = null;
  #inFlightTurn: InFlightTurn | null = null;
  readonly #epochIdleMs: number;
  readonly #setEpochIdleTimer: (callback: () => void, delayMs: number) => unknown;
  readonly #clearEpochIdleTimer: (timer: unknown) => void;
  #gateProbe: GateProbe | null = null;
  #cancelGateProbe: (() => void) | null = null;
  #catalog: EngineModelInfo[] = antigravityCatalogSnapshot();
  readonly #agyExecutable: AgyExecutableResolution;
  readonly #probeTimeoutMs: number;
  readonly #abortGraceMs: number;
  readonly #closeGraceMs: number;
  // issue #379: the single live SIGTERM->grace->SIGKILL escalation for
  // `#running`, if any. issue #377 Stage 2: a new epoch is only spawned
  // after the previous one's close is confirmed (`#endEpoch` awaits its
  // `deathPromise`), and `#armOrShortenTermination` reuses this same handle
  // via `shortenGraceTo` rather than creating a second one -- so at most
  // one of these is ever outstanding.
  #activeTermination: GraceTerminationHandle | null = null;
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
    this.#abortGraceMs = options.abortGraceMs ?? DEFAULT_TURN_WATCHDOG_ABORT_GRACE_MS;
    this.#closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    this.#epochIdleMs = options.epochIdleMs ?? DEFAULT_EPOCH_IDLE_MS;
    this.#setEpochIdleTimer = options.epochIdleSetTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#clearEpochIdleTimer = options.epochIdleClearTimer ?? ((timer) => clearTimeout(timer as never));
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
    // issue #371 S1: these resolve without starting a turn and without
    // throwing, so a caller's `.catch()` never sees them — fire the
    // diagnostic callback so the wrapper can still log the classified
    // reason (never the inbound text) to the lifecycle stream.
    if (this.#closed || this.#gateBroken || this.#watchdogFailStopped) {
      this.#options.onSendRejected?.({
        ...(turnToken === undefined ? {} : { turnToken }),
        // Most specific first: a watchdog fail-stop also sets `#closed`, and
        // a customization tamper (`#gateBroken`) can co-occur with either.
        reason: this.#watchdogFailStopped ? "watchdog_fail_stopped" : this.#gateBroken ? "gate_broken" : "closed",
      });
      return;
    }
    if (attachmentIds !== undefined && attachmentIds.length > 0) {
      this.#warn("antigravity: attachments are unsupported");
      this.#options.onSendRejected?.({
        ...(turnToken === undefined ? {} : { turnToken }),
        reason: "attachments_unsupported",
      });
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

  beginPermissionWaitLease(
    turnToken: string,
    source: "bridge" | "native",
  ): string | null {
    if (
      this.#closed ||
      this.#watchdogFailStopped ||
      this.#interruptRecord?.turnToken === turnToken ||
      this.#activeTurnToken !== turnToken
    ) return null;
    if (this.#permissionWaitLeases.size === 0) {
      if (this.#machine.state !== "tool_running") {
        throw new Error(`permission wait requires tool_running, got ${this.#machine.state}`);
      }
      this.#permissionWaitBaseState = this.#machine.state;
    } else if (this.#machine.state !== "waiting_permission") {
      throw new Error(`overlapping permission wait requires waiting_permission, got ${this.#machine.state}`);
    }
    const leaseId = randomUUID();
    const wasEmpty = this.#permissionWaitLeases.size === 0;
    this.#permissionWaitLeases.set(leaseId, { turnToken, source });
    if (wasEmpty) this.#apply({ kind: "permission_request" });
    return leaseId;
  }

  endPermissionWaitLease(leaseId: string): boolean {
    const owner = this.#permissionWaitLeases.get(leaseId);
    if (owner === undefined) return false;
    this.#permissionWaitLeases.delete(leaseId);
    if (this.#permissionWaitLeases.size !== 0) return true;
    const baseState = this.#permissionWaitBaseState;
    this.#permissionWaitBaseState = null;
    if (
      baseState === "tool_running" &&
      this.#activeTurnToken === owner.turnToken &&
      this.#machine.state === "waiting_permission"
    ) {
      this.#apply({ kind: "permission_resolved" });
    }
    return true;
  }

  async interrupt(): Promise<void> {
    // issue #371: record the interrupt target synchronously, before the
    // generation bump, so the settlement invariant in `#drainTurns` can
    // recognize this specific turn's ending as an operator interrupt no
    // matter which exit path in `#runTurn` first notices the stale
    // generation. No current turn (idle interrupt) leaves no record, so no
    // result / lifecycle event is produced and the next `send()` simply
    // starts under the new generation.
    // issue #371 Design v2 N3 (kohaku design review round 1): a record is
    // created -- and `onInterruptRequested` fires -- only the FIRST time
    // this turn is interrupted, so a second press repeats the kill routine
    // below without adding a duplicate lifecycle event ("once each" per
    // the docs stays true).
    if (this.#currentTurnToken !== null && this.#interruptRecord?.turnToken !== this.#currentTurnToken) {
      this.#interruptRecord = {
        turnToken: this.#currentTurnToken,
        generation: this.#lifecycleGeneration,
        at: this.#now(),
      };
      this.#options.onInterruptRequested?.({
        turnToken: this.#currentTurnToken,
        pendingPermission: this.#pendingPermission !== null,
        pendingQuestion: this.#pendingQuestion !== null,
        childPid: this.#running?.pid ?? null,
      });
    }
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
    // issue #377 Stage 2: ends the whole epoch, not just the active turn --
    // an idle interrupt (no `#currentTurnToken`) now has a live process to
    // stop, unlike Stage 1 where idle meant no process existed at all. The
    // next `send()` sees `#epoch === null` and spawns fresh with
    // `--conversation <this session's id>` (M6 keeps `#sessionId` current).
    void this.#endEpoch("interrupt");
  }

  /** issue #379: arms a SIGTERM->grace->SIGKILL escalation for `#running`
   *  if none is active yet; otherwise shortens the already-armed one to
   *  `graceMs` (never lengthens, never re-sends SIGTERM). This single
   *  method is what keeps a repeat `interrupt()` from re-signalling
   *  (calling it again with the SAME graceMs computes a later candidate
   *  deadline, which `shortenGraceTo` treats as a no-op) and what lets
   *  `close()` shrink an `interrupt()`-armed 60s grace down to its own
   *  short `closeGraceMs` (M2) using the same call. */
  #armOrShortenTermination(graceMs: number): void {
    if (this.#activeTermination !== null) {
      this.#activeTermination.shortenGraceTo(graceMs);
      return;
    }
    if (this.#running === null) return;
    this.#activeTermination = terminateWithGrace(this.#running, { graceMs });
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
    // issue #379: no grace armed here -- `TurnWatchdog` already owns that
    // timing itself (it arms its own `abortGraceMs` timer between this call
    // and `failStopTurnForWatchdog`); arming a second one here would double
    // the effective wait before an unresponsive watchdog-flagged turn dies.
    this.#markEpochEnding("watchdog");
    return this.#running !== null && signalSubtree(this.#running, "SIGTERM");
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
    // issue #379 M2: closeGraceMs, not abortGraceMs -- an outer supervisor
    // (runner reset / systemd stop) can SIGKILL this wrapper process well
    // before a 60s abort grace would fire, so close() always shortens down
    // to its own short bound rather than trusting whatever was already
    // armed (including a longer grace an `interrupt()` call just started,
    // e.g. the SIGINT handler's `interrupt().finally(() => close())`).
    void this.#endEpoch("close");
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
   *  should be enforced (`next`); this re-applies `next` to #config so the next
   *  turn's gate reads it and adopts the durable control. Unlike a live
   *  set_permission it emits no applied observation — the switch already applied
   *  before the disconnect.
   *
   *  The wrapper is the final gate (M7): the relayed `next` is checked against
   *  the launch ceiling BEFORE the server's control or its evidence is adopted.
   *  A violation is refused fail-closed with the SAME semantics as a live
   *  set_permission — permission_failed, reason "exceeds_launch_ceiling",
   *  rolled_back_to = the current cell — and the over-ceiling control /
   *  effective / last_effective is NOT adopted, so #config and the last
   *  effective observation stay at their current in-ceiling values. */
  applyPermissionSync(message: PermissionSyncMessage): void {
    if (message.control === null) return;
    const control = message.control;
    // A stale relay cannot regress an already-adopted higher revision.
    if (control.revision < (this.#permissionControl?.revision ?? -1)) return;
    const current = this.#currentCell();
    const next = message.next.requested;
    // The server relays approval for antigravity; keep the current value if a
    // legacy sandbox/network-only next omits it. Resolved to a concrete value so
    // #config.approval (non-optional) never receives undefined.
    const approval = next.approval ?? current.approval;
    const cell: PermissionConfiguration = {
      sandbox: next.sandbox,
      network_access: next.network_access,
      approval,
    };
    const ceiling = this.#permissionCeiling();
    const violation = ceiling === null ? null : ceilingExceeded(cell, ceiling);
    if (violation !== null) {
      // Fail-closed BEFORE adopting the control or its (possibly forged)
      // evidence: report failed against the current cell, exactly as a live
      // set_permission does, and leave #config / #lastEffectivePermission alone.
      this.#permissionControl = {
        revision: message.next.revision,
        requested: cell,
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
          revision: message.next.revision,
          requested: cell,
          reason: "exceeds_launch_ceiling",
          rolled_back_to: current,
        },
      });
      this.#warn(`antigravity: permission_sync rejected: ${violation}`);
      return;
    }
    // Within ceiling: adopt the durable control and re-apply next to #config.
    this.#permissionControl = control;
    if (control.status === "applied") {
      this.#lastEffectivePermission = control.effective;
    } else if (control.last_effective !== undefined) {
      this.#lastEffectivePermission = control.last_effective;
    }
    this.#config.sandbox = cell.sandbox;
    this.#config.network_access = cell.network_access;
    this.#config.approval = approval;
    this.#emitState(this.#machine.state);
  }

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
    this.#currentTurnToken = turnToken;
    // issue #371 M3 (momo round-2 review): `#runTurn` does not set
    // `#currentAttemptedModel` for THIS turn until after gate registration
    // (see the `attemptedModel` assignment below), so without this reset a
    // synchronous re-entrant `send()` from a finishing turn's onTurnEnd
    // would leave the PRIOR turn's attempted model in place; an interrupt
    // landing in that pre-spawn window would then roll back the wrong model.
    this.#currentAttemptedModel = null;
    let outcome: TurnOutcome = { kind: "stale" };
    try {
      outcome = await this.#runTurn(turn.text, generation, turnToken, turn.conversationIds ?? []);
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : String(caught);
      // issue #371 Design v2 M2 (kohaku design review): `attemptedModel:
      // undefined` matches the pre-#371 `#terminalError(detail)` call this
      // replaces -- an unconditional rollback, not a match-gated one.
      outcome = this.#isCurrent(generation)
        ? { kind: "error", detail, classify: { detail }, attemptedModel: undefined }
        : { kind: "stale" };
    } finally {
      // issue #377 Stage 2: `#running` is NOT reset here -- it now mirrors
      // the live EPOCH's child (which can outlive this one turn), not a
      // turn-scoped process. It is set once by `#spawnEpoch` and cleared
      // only by `#attachEpochWatcher`'s close handler, once the epoch's
      // child actually closes.
      this.#turnActive = false;
      // issue #371 Design v2: a `stale` outcome (generation mismatch, or
      // closed/fail-stopped) becomes `interrupted` only when the operator's
      // one-shot interrupt record targeted THIS turn and the host is still
      // in normal admission (`close()`/fail-stop already produce `stale`
      // too, but with no matching record -- their pre-#371 termination
      // semantics are unchanged: no fabricated result, no interrupt
      // lifecycle event). Any other outcome kind (a real error or result,
      // including one `#runTurn` decided AFTER an interrupt fired, e.g.
      // customization tampering) keeps its own kind -- an interrupt does
      // not override a turn's real outcome, only its absence.
      if (outcome.kind === "stale" && !this.#closed && this.#interruptRecord?.turnToken === turnToken) {
        outcome = {
          kind: "interrupted",
          attemptedModel: this.#currentAttemptedModel,
          exit: this.#lastChildExit,
          requestedAt: this.#interruptRecord.at,
        };
      }
      for (const [leaseId, owner] of this.#permissionWaitLeases) {
        if (owner.turnToken === turnToken) this.#permissionWaitLeases.delete(leaseId);
      }
      if (this.#permissionWaitLeases.size === 0) this.#permissionWaitBaseState = null;
      // issue #371: identity cleanup runs BEFORE every external callback
      // this turn's settlement can reach (onState/onLog via
      // `#terminalError`/`#publishTerminalResult`, onInterruptSettled,
      // onTurnBoundary, onTurnEnd), and unconditionally (even under
      // `#watchdogFailStopped`, so a later `interrupt()` cannot
      // misattribute to a turn that already ended for a different
      // reason). See the `TurnOutcome` comment for the invariant this
      // maintains.
      if (this.#currentTurnToken === turnToken) {
        this.#currentTurnToken = null;
        this.#currentAttemptedModel = null;
      }
      if (this.#activeTurnToken === turnToken) {
        this.#activeTurnToken = null;
        this.#activeTurnConversationIds = [];
      }
      if (this.#interruptRecord?.turnToken === turnToken) this.#interruptRecord = null;
      if (outcome.kind === "skipped") {
        if (this.#turnQueue.length === 0 && !this.#closed) {
          this.#machine = initialMachineState("waiting_input");
          this.#emitState("waiting_input");
        }
      } else if (!this.#watchdogFailStopped) {
        let error: InterAgentErrorClassifyInput | undefined;
        let cancellation: { kind: "interrupt"; reason: "interrupted" } | undefined;
        if (outcome.kind === "interrupted") {
          this.#terminalError("interrupted", outcome.attemptedModel);
          error = { reason: "interrupted" };
          cancellation = { kind: "interrupt", reason: "interrupted" };
          this.#options.onInterruptSettled?.({
            turnToken,
            exitCode: outcome.exit?.code ?? null,
            signal: outcome.exit?.signal ?? null,
            elapsedMs: outcome.requestedAt === undefined
              ? 0
              : Math.max(0, Date.parse(this.#now()) - Date.parse(outcome.requestedAt)),
          });
        } else if (outcome.kind === "error") {
          this.#terminalError(outcome.detail, outcome.attemptedModel);
          error = outcome.classify;
        } else if (outcome.kind === "result") {
          // issue #371 Design v2 revision 1a: two independent axes, exactly
          // reproducing the pre-#371 `#runTurn` success-path branches.
          const quota = agyEventToQuotaExhaustion(outcome.event);
          if (quota !== null) {
            this.#rateLimits.set("seven_day", {
              status: "blocked",
              utilization: 1,
              resets_at: Math.floor(Date.parse(this.#now()) / 1_000) + quota.resetDelaySeconds,
            });
          } else if (agyEventIsSuccessfulResult(outcome.event)) {
            this.#rateLimits.delete("seven_day");
          }
          const result = agyEventToResult(outcome.event);
          if (result?.is_error === true) this.#rollbackPendingModel(outcome.attemptedModel);
          else this.#promotePendingModel(outcome.attemptedModel);
          this.#publishTerminalResult(outcome.event);
          if (quota !== null) {
            error = { reason: "blocking_limit", rateLimitResetSeconds: quota.resetDelaySeconds };
          } else if (result?.is_error === true) {
            error = { detail: "antigravity turn failed" };
          }
        }
        // outcome.kind === "stale" (close / fail-stop, no matching
        // interrupt record) projects nothing, matching pre-#371 behaviour.
        this.#options.onTurnBoundary?.({ turnToken });
        this.#options.onTurnEnd?.({
          turnToken,
          conversationIds: turn.conversationIds ?? [],
          ...(error === undefined ? {} : { error }),
          ...(cancellation === undefined ? {} : { cancellation }),
          // issue #396: agy itself produced a `result` event -- see the
          // field's own doc comment for why this is not "succeeded".
          terminal: outcome.kind === "result",
        });
      }
      void this.#drainTurns();
    }
  }

  async #runTurn(
    text: string,
    generation: number,
    turnToken: string,
    conversationIds: readonly string[],
  ): Promise<TurnOutcome> {
    // issue #377 Stage 2 M7: the idle TTL clears at DEQUEUE -- before spec
    // comparison or a possible respawn -- and is re-armed (in the `finally`
    // below) only once this turn's own result/error has settled. That keeps
    // the TTL from ever firing mid-spawn or mid-delivery-ack.
    this.#clearIdleTtl();
    // Review finding (issue #371 round 1): without this reset, a turn
    // interrupted before its own child ever spawns would report a PRIOR
    // turn's leftover exit code/signal in `onInterruptSettled`, misleading
    // an operator reading the lifecycle journal.
    this.#lastChildExit = null;
    this.#activeTurnToolTimeout = null;
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
    if (!(this.#options.runtimeAssetsAvailable?.() ?? (existsSync(HOOK_SCRIPT) && existsSync(BRIDGE_SCRIPT)))) {
      throw new Error("antigravity runtime assets are not built");
    }
    try {
      // issue #359 M1: block this turn's gate until the server's permission_sync
      // for the current connection has been applied, so a durable control/next
      // relayed on reconnect lands before the gate reads the cell. A no-op once
      // the sync arrived, or when sync is unsupported.
      await (this.#options.waitForPermissionSync?.() ?? Promise.resolve());
      if (!this.#isCurrent(generation)) return { kind: "stale" };
      // ADR-0057 F4c Stage B0 (issue #359): apply a staged permission switch
      // now, at the execution boundary, so this turn's fresh gate below reads
      // the new cell while the just-ended turn's gate was left untouched.
      this.#applyPendingPermissionSwitch(turnToken);
      const attemptedModel = this.#pendingModel;
      this.#currentAttemptedModel = attemptedModel;
      const spec: EpochSpec = {
        conversationId: this.#sessionId,
        model: attemptedModel ?? this.#config.model,
        effort: this.#config.effort,
        addDirs: [this.#options.cwd, customization.path],
      };

      // issue #377 Stage 2: a live epoch whose spec no longer matches this
      // turn's requirements (model/effort rollback or switch, a different
      // conversation) is ended first -- respawning below picks up the new
      // spec. M2: a model rollback after an is_error result is absorbed by
      // this same comparison (the next turn's spec reverts to the
      // pre-switch model, which mismatches the still-live epoch). An epoch
      // already ending for another reason (e.g. an idle `interrupt()` that
      // raced this turn's dequeue) is also waited out and respawned here,
      // even when its recorded spec still matches -- reusing a dying
      // process is never correct.
      if (this.#epoch !== null && (this.#epoch.endingReason !== null || !epochSpecsEqual(this.#epoch.spec, spec))) {
        await this.#endEpoch(this.#epoch.endingReason ?? "spec_change");
      }
      if (!this.#isCurrent(generation)) return { kind: "stale" };

      if (this.#epoch === null) {
        const spawned = await this.#spawnEpoch(spec, generation, customization, executable);
        if (!spawned.ok) return { kind: "stale" };
      }
      const epoch = this.#epoch!;
      // A skipped input can leave an unused epoch until its ordinary idle TTL.
      const prepared = this.#options.prepareInput?.(turnToken);
      if (prepared === null) return { kind: "skipped" };
      if (prepared !== undefined) {
        text = prepared.text;
        conversationIds = prepared.conversationIds;
      }
      this.#activeTurnToken = turnToken;
      this.#activeTurnConversationIds = conversationIds;

      // ADR-0057 F4c Stage B0 (issue #359) / issue #377 Stage 2: a live
      // epoch's gate is swapped at the turn boundary via `setGate()` --
      // never mutated mid-turn -- so a step ACTIVE before the swap still
      // resolves against the same `GateServer`-owned ledger once it goes
      // DONE after it (Stage 1 M3).
      let nativePermissionLease: string | null = null;
      const gate = new AntigravityGate({
        config: this.#config,
        cwd: this.#options.cwd,
        customizationDir: customization.path,
        nodePath: this.#options.nodePath ?? process.execPath,
        bridgePath: BRIDGE_SCRIPT,
        toolNames: () => epoch.toolHost.toolNames(),
        broker: this.#options.permissionBroker,
        onPermissionRequest: () => {
          const token = this.#activeTurnToken;
          nativePermissionLease = token === null ? null : this.beginPermissionWaitLease(token, "native");
        },
        onPermissionResolved: () => {
          if (nativePermissionLease !== null) this.endPermissionWaitLease(nativePermissionLease);
          nativePermissionLease = null;
        },
        ...(this.#options.warn === undefined ? {} : { warn: this.#options.warn }),
      });
      epoch.gateServer.setGate(gate);

      const inFlight: InFlightTurn = {
        turnToken,
        gate,
        assistantText: new Map(),
        correlationFailure: null,
        epochDeathError: null,
        resolveResult: () => {},
      };
      const terminalResultPromise = new Promise<AgyStreamEvent | null>((resolve) => {
        inFlight.resolveResult = resolve;
      });
      this.#inFlightTurn = inFlight;

      // issue #377 Stage 1 M4 (kept for Stage 2): the delivery ack
      // (onTurnStart) fires only once the write is confirmed -- not merely
      // once `write()` returns, since a pipe write can succeed into the
      // kernel buffer on a dying process -- so a race where the epoch dies
      // before or during this write never reports a turn as started.
      const delivered = await this.#deliverTurnInput(epoch, text);
      if (delivered) {
        this.#options.onTurnStart?.({ turnToken, conversationIds });
      } else {
        // issue #377 Stage 1 M1 (kept for Stage 2): a failed delivery does
        // not guarantee the epoch has exited (an EPIPE write error need not
        // kill the whole process), and no ack means no TurnWatchdog is
        // running to bound the wait below -- arm one explicitly.
        // `closeGraceMs`, not `abortGraceMs`: nothing here is worth waiting
        // a full abort grace for, so this mirrors `close()`'s own bound.
        this.#armOrShortenTermination(this.#closeGraceMs);
      }

      // issue #377 Stage 2: this turn's own completion signal is now its
      // `result` event on the epoch's shared stream (routed by
      // `#attachEpochStreamReader`), not the process exiting -- an epoch
      // that stays alive across turns must not make every turn wait for a
      // process death that need not happen. A dead epoch still resolves
      // this (with `null`) via its close handler, so a mid-turn crash is
      // never missed.
      const terminalResult = await terminalResultPromise;
      if (this.#inFlightTurn === inFlight) this.#inFlightTurn = null;
      epoch.turns += 1;

      // issue #371 Design v2 M1 (kohaku design review round 1, kept for
      // Stage 2): closed/fail-stopped and generation-mismatch are `stale`
      // (an operator interrupt is projected as `interrupted` only when
      // nothing else outranks it); customization tampering outranks a
      // stale generation, since a broken gate is a heavier fact than the
      // interrupt. issue #377 Stage 1 M1: `!delivered`
      // (epoch_exit_before_turn) ranks below tampering and a stale
      // generation for the same reason.
      if (this.#closed || this.#watchdogFailStopped) return { kind: "stale" };
      if (customization.verify() !== true) {
        this.#gateBroken = true;
        // issue #377 Stage 2: tamper is detected only after the process has
        // had a chance to run this turn (mirroring Stage 1's post-hoc
        // check), but an epoch persists across turns -- so unlike Stage 1
        // (where the process was already dead by the time this fired) this
        // must actively end the epoch, not just report the error.
        await this.#endEpoch("tamper");
        const detail = "antigravity_customization_tampered";
        return { kind: "error", detail, classify: { detail }, attemptedModel };
      } else if (!this.#isCurrent(generation)) {
        return { kind: "stale" };
      } else if (!delivered) {
        const detail = "epoch_exit_before_turn";
        return { kind: "error", detail, classify: { detail }, attemptedModel };
      } else if (inFlight.correlationFailure !== null) {
        this.#gateBroken = true;
        const detail = `antigravity_gate_unobserved_tool:${inFlight.correlationFailure}`;
        return { kind: "error", detail, classify: { detail }, attemptedModel };
      } else if (this.#activeTurnToolTimeout !== null) {
        // Whatever agy printed after SIGTERM, the turn outcome is the
        // deadline, not the CLI's own terminal record.
        return { kind: "error", detail: "tool_timeout", classify: { reason: "timeout" }, attemptedModel };
      } else if (inFlight.epochDeathError !== null) {
        const error = inFlight.epochDeathError;
        const detail = `antigravity_cli_${this.#spawnFailureReason(error)}: ${boundErrorDetail(error.message)}`;
        return { kind: "error", detail, classify: { detail }, attemptedModel };
      } else if (terminalResult === null) {
        const detail = "agy_exit_without_result";
        return { kind: "error", detail, classify: { detail }, attemptedModel };
      } else {
        return { kind: "result", event: terminalResult, attemptedModel };
      }
    } finally {
      this.#activeTurnToolTimeout = null;
      if (this.#epoch !== null) this.#armIdleTtl();
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
    // issue #379: no grace here either -- by the time TurnWatchdog calls
    // this, its OWN abortGraceMs has already elapsed since
    // requestInterruptForTurn's SIGTERM, so escalate straight to SIGKILL.
    this.#markEpochEnding("watchdog");
    if (this.#running !== null) signalSubtree(this.#running, "SIGKILL");
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
        // issue #396: these turns never even started -- agy produced
        // nothing for them.
        terminal: false,
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
      this.#emitState(this.#machine.state);
    }
  }

  /** issue #377 Stage 1 M4, adapted for Stage 2: writes the turn's prompt as
   *  exactly one NDJSON line (`--input-format stream-json`'s accepted
   *  shape, measured in docs/evidence/antigravity/print-mode-background-tasks.md).
   *  Unlike Stage 1 this does NOT close stdin -- an epoch's stdin stays open
   *  for every turn it serves. Resolves `true` only once the write callback
   *  has resolved without error AND the epoch has not already ended in the
   *  meantime; resolves `false` on a write error or that race, in which
   *  case the caller reports `epoch_exit_before_turn` and does not re-send
   *  the line on its own -- the model may already have read it, and a
   *  duplicate turn is worse than a visible failure. Checks `this.#epoch !==
   *  epoch` (rather than each call installing its own `close` listener) so
   *  an epoch serving many turns accumulates no listeners on its child. */
  #deliverTurnInput(epoch: EpochRuntime, text: string): Promise<boolean> {
    return new Promise((resolveDelivery) => {
      let settled = false;
      const settle = (delivered: boolean): void => {
        if (settled) return;
        settled = true;
        if (epoch.pendingDeliverySettle === settle) epoch.pendingDeliverySettle = null;
        resolveDelivery(delivered);
      };
      epoch.pendingDeliverySettle = settle;
      if (epoch.stdinErrored || this.#epoch !== epoch) {
        settle(false);
        return;
      }
      const line = `${JSON.stringify({ event: "user", message: { role: "user", content: text } })}\n`;
      epoch.child.stdin.write(line, (error) => {
        if (error !== undefined && error !== null) {
          settle(false);
          return;
        }
        if (this.#epoch !== epoch) {
          settle(false);
          return;
        }
        settle(true);
      });
    });
  }

  /** issue #377 Stage 2: attaches the ONE-TIME (per epoch) listeners that
   *  detect the epoch's own death, whatever the cause. A stdin `error`
   *  (e.g. EPIPE) is tracked persistently -- rather than the per-delivery
   *  listener Stage 1 used -- so an epoch serving many turns accumulates no
   *  listeners; `pendingDeliverySettle` lets it settle an in-flight
   *  `#deliverTurnInput` immediately instead of waiting for `write()`'s own
   *  callback, which may never fire on a truly broken pipe. */
  #attachEpochWatcher(epoch: EpochRuntime): void {
    epoch.child.stdin.on("error", () => {
      epoch.stdinErrored = true;
      epoch.pendingDeliverySettle?.(false);
    });
    // issue #379: cancel any pending SIGKILL escalation for THIS child as
    // soon as it is known to have exited. `exit` fires before `close` (no
    // stdio-drain wait), so it frees the escalation sooner; `close` below is
    // a defensive second call (`cancel()` is idempotent) for the rare case
    // `exit` was not observed.
    epoch.child.once("exit", () => {
      this.#activeTermination?.cancel();
      this.#activeTermination = null;
    });
    epoch.child.once("close", (code, signal) => {
      this.#activeTermination?.cancel();
      this.#activeTermination = null;
      this.#lastChildExit = { code, signal };
      if (this.#epoch !== epoch) return;
      this.#epoch = null;
      if (this.#running === epoch.child) this.#running = null;
      if (this.#gateServer === epoch.gateServer) this.#gateServer = null;
      if (this.#toolHost === epoch.toolHost) this.#toolHost = null;
      this.#clearIdleTtlTimer(epoch);
      epoch.gateServer.close();
      epoch.toolHost.close();
      const reason = epoch.endingReason;
      if (reason === null) {
        // A spontaneous, unrequested death. Idle (no turn owns the stream)
        // is its own lifecycle event (N4 `idle_exit`); mid-turn is folded
        // into that turn's own error below instead (agy_exit_without_result
        // / epoch_exit_before_turn) -- no separate log for that case,
        // matching Stage 1 fidelity.
        if (this.#inFlightTurn === null) {
          this.#options.onEpochEnded?.({ reason: "idle_exit", code, signal, turns: epoch.turns });
        }
      } else {
        this.#options.onEpochEnded?.({ reason, code, signal, turns: epoch.turns });
      }
      // Always unblock an in-flight turn, whatever the reason -- its own
      // outcome-precedence switch decides the turn's error detail from
      // `terminalResult === null` (plus `epochDeathError`, if any).
      this.#inFlightTurn?.resolveResult(null);
      epoch.resolveDeath?.();
    });
    epoch.child.once("error", (error) => {
      if (this.#inFlightTurn !== null) this.#inFlightTurn.epochDeathError = error;
    });
  }

  /** issue #377 Stage 2: the epoch-level, continuous stream reader --
   *  attached ONCE per epoch spawn (not per turn). Routes `result` events to
   *  the in-flight turn's `resolveResult`; folds every other event into
   *  that turn's state (mirroring Stage 1's per-turn `#handleEvent` + tool
   *  ACTIVE/DONE correlation); logs anything arriving while no turn owns
   *  the stream as `out_of_turn_event` instead of projecting it onto a
   *  turn that never asked for it. */
  #attachEpochStreamReader(epoch: EpochRuntime, executable: string): void {
    readableLines(epoch.child.stdout, (line) => {
      const inFlight = this.#inFlightTurn;
      if (inFlight !== null) this.#options.onTurnProgress?.({ turnToken: inFlight.turnToken });
      const event = parseAgyStreamLine(line);
      if (event === null) {
        this.#warn(`antigravity: ignored malformed stream line from ${basename(executable)}`);
        return;
      }
      if (inFlight === null) {
        this.#logOutOfTurnEvent(event);
        return;
      }
      // ADR-0057 F4c Stage B0 (issue #359 M4) / issue #377 Stage 2 M1: a mid-
      // epoch permission switch has no fresh `init` to confirm against (that
      // only fires once, on the epoch's first turn) -- so the FIRST stream
      // event of the turn after the swap confirms it instead, whatever its
      // type -- including `result` itself, so this must run before the
      // `result` branch's early return below, not after it.
      // `#confirmAppliedPermission` is itself idempotent (no-ops once there
      // is no pending observation), so calling it on every in-turn event,
      // including `init` itself, is safe.
      this.#confirmAppliedPermission();
      if (event.event === "result") {
        // issue #377 Stage 2 M4: clear synchronously, in the same pass.
        // `readableLines` drains every line already buffered in one stdout
        // chunk back to back with no microtask yield between them, so a
        // stray event appended after this turn's own `result` in the SAME
        // chunk must see `#inFlightTurn === null` right here -- waiting for
        // `#runTurn`'s `await terminalResultPromise` continuation to clear
        // it would let that stray event still be routed to `#handleEvent`
        // with this turn's stale token instead of `#logOutOfTurnEvent`.
        if (this.#inFlightTurn === inFlight) this.#inFlightTurn = null;
        inFlight.resolveResult(event);
        return;
      }
      this.#handleEvent(event, inFlight.gate, inFlight.assistantText);
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
        inFlight.correlationFailure = validToolName(topLevelName) ? topLevelName : validToolName(nestedName) ? nestedName : "unknown";
        this.#warn(`antigravity: ${state === "ACTIVE" ? "started" : "completed"} tool correlation is unprovable: ${inFlight.correlationFailure}`);
        // issue #379: a gate-correlation failure means the safety gate
        // itself may be compromised, so this kill escalates to SIGKILL
        // (grace-bounded) rather than trusting a bare SIGTERM.
        this.#gateBroken = true;
        this.#markEpochEnding("gate_broken");
        this.#armOrShortenTermination(this.#abortGraceMs);
        return;
      }
      if (state === "ACTIVE") {
        this.#options.onToolStart?.({ turnToken: inFlight.turnToken, stepIndex: stepIndex as number, toolName });
        return;
      }
      this.#options.onToolEnd?.({ turnToken: inFlight.turnToken, stepIndex: stepIndex as number });
      if (!epoch.gateServer.observeCompletedTool(stepIndex as number, toolName)) {
        inFlight.correlationFailure = toolName;
        this.#gateBroken = true;
        this.#markEpochEnding("gate_broken");
        this.#armOrShortenTermination(this.#abortGraceMs);
      }
    });
  }

  /** issue #377 Stage 2 M4: `out_of_turn_event {step_index, step_type, state}`
   *  for a `step_update` -- a `result` arriving out of turn "is logged the
   *  same way and discarded" (its own status only, no turn projection). */
  #logOutOfTurnEvent(event: AgyStreamEvent): void {
    if (event.event === "init") {
      this.#options.onOutOfTurnEvent?.({ eventKind: "init" });
    } else if (event.event === "step_update") {
      const step = event.step_update;
      this.#options.onOutOfTurnEvent?.({
        eventKind: "step_update",
        ...(step.step_index === undefined ? {} : { stepIndex: step.step_index }),
        ...(step.step_type === undefined ? {} : { stepType: step.step_type }),
        ...(step.state === undefined ? {} : { state: step.state }),
      });
    } else {
      this.#options.onOutOfTurnEvent?.({
        eventKind: "result",
        ...(event.result.status === undefined ? {} : { status: event.result.status }),
      });
    }
  }

  /** issue #377 Stage 2: spawns a fresh epoch for `spec`. Moves what Stage 1
   *  did per turn (ToolHost/GateServer/gate-registration probe) to per-epoch
   *  scope -- these now span every turn the epoch serves until it ends. */
  async #spawnEpoch(
    spec: EpochSpec,
    generation: number,
    customization: CustomizationDir,
    executable: string,
  ): Promise<{ ok: true } | { ok: false; stale: true }> {
    customization.rewrite();
    let toolHost: ToolHost | null = null;
    let gateServer: GateServer | null = null;
    let succeeded = false;
    try {
      toolHost = await (this.#options.toolHostListen ?? ToolHost.listen)(this.#options.toolDescriptors ?? []);
      if (!this.#isCurrent(generation)) return { ok: false, stale: true };
      // A placeholder policy object -- `GateServer.listen` needs SOME gate to
      // register the socket against, but `#runTurn` unconditionally builds a
      // fresh gate and calls `setGate()` with it for EVERY turn, including
      // turn 1, before any child process can reach it over the socket. This
      // one is therefore live only across the registration probe below.
      const gate = new AntigravityGate({
        config: this.#config,
        cwd: this.#options.cwd,
        customizationDir: customization.path,
        nodePath: this.#options.nodePath ?? process.execPath,
        bridgePath: BRIDGE_SCRIPT,
        toolNames: () => toolHost!.toolNames(),
        broker: this.#options.permissionBroker,
        onPermissionRequest: () => {},
        onPermissionResolved: () => {},
        ...(this.#options.warn === undefined ? {} : { warn: this.#options.warn }),
      });
      gateServer = await (this.#options.gateServerListen ?? GateServer.listen)({
        gate,
        onSocketClose: () => {
          this.#options.permissionBroker.close();
          this.#clearPendingPermission();
        },
      });
      if (!this.#isCurrent(generation)) return { ok: false, stale: true };
      this.#toolHost = toolHost;
      this.#gateServer = gateServer;
      const registration = await this.#verifyGateRegistration(generation);
      if (!registration.ok) {
        // issue #371 Design v2 fidelity: a throw here (not a returned error)
        // lets `#drainTurns`'s catch convert this into `stale` when the
        // generation has ALSO moved (e.g. an `interrupt()` raced this same
        // window via `cancelGateProbe`) -- exactly the "via the throw path"
        // pin (vi) below relies on.
        throw new Error(`antigravity_gate_not_registered:${registration.reason}`);
      }
      if (!this.#isCurrent(generation)) return { ok: false, stale: true };
      const args = this.#epochArguments(spec);
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
      readableLines(child.stderr, (line) => {
        if (EPOCH_STDERR_WAITING_PATTERN.test(line)) {
          this.#options.onEpochStderrLine?.({ kind: "waiting" });
        } else if (EPOCH_STDERR_TERMINATING_PATTERN.test(line)) {
          this.#options.onEpochStderrLine?.({ kind: "terminating" });
        }
      });
      const epoch: EpochRuntime = {
        child,
        spec,
        toolHost,
        gateServer,
        turns: 0,
        idleTtlTimer: null,
        endingReason: null,
        deathPromise: null,
        resolveDeath: null,
        stdinErrored: false,
        pendingDeliverySettle: null,
      };
      this.#epoch = epoch;
      this.#running = child;
      this.#attachEpochWatcher(epoch);
      this.#attachEpochStreamReader(epoch, executable);
      succeeded = true;
      return { ok: true };
    } finally {
      if (!succeeded) {
        gateServer?.close();
        toolHost?.close();
        if (this.#gateServer === gateServer) this.#gateServer = null;
        if (this.#toolHost === toolHost) this.#toolHost = null;
      }
    }
  }

  /** issue #377 Stage 2: records that the live epoch is ending for `reason`
   *  (first cause wins -- a later call while one is already in flight never
   *  overwrites the original attribution) and lazily creates the shared
   *  `deathPromise` every caller can await, however many of them mark the
   *  same epoch ending. Returns `null` when no epoch is live. Callers that
   *  need immediate termination with NO grace (the watchdog's SIGKILL fail-
   *  stop, which owns its own timing already) call this directly instead of
   *  `#endEpoch`, so this method itself performs no signalling. */
  #markEpochEnding(reason: EpochEndReason): EpochRuntime | null {
    const epoch = this.#epoch;
    if (epoch === null) return null;
    if (epoch.endingReason === null) {
      epoch.endingReason = reason;
      this.#clearIdleTtlTimer(epoch);
    }
    epoch.deathPromise ??= new Promise<void>((resolve) => {
      epoch.resolveDeath = resolve;
    });
    return epoch;
  }

  /** issue #377 Stage 2: ends the live epoch for `reason` (SIGTERM, then a
   *  grace-bounded SIGKILL escalation) and waits for its child to actually
   *  close before resolving -- a no-op if no epoch is live. Safe to call
   *  more than once on the same epoch (e.g. `interrupt()`'s own fire-and-
   *  forget call racing a freshly dequeued turn's reuse check): every
   *  caller shares the one `deathPromise` `#markEpochEnding` creates.
   *  `#attachEpochWatcher`'s close handler reads `endingReason` (set here
   *  BEFORE the signal goes out) to log the right `epoch_ended` reason. */
  async #endEpoch(reason: EpochEndReason): Promise<void> {
    const epoch = this.#markEpochEnding(reason);
    if (epoch === null) return;
    this.#armOrShortenTermination(reason === "close" ? this.#closeGraceMs : this.#abortGraceMs);
    await epoch.deathPromise;
  }

  /** issue #377 Stage 2 M7: clears the CURRENT epoch's idle-TTL timer, if
   *  armed. Called at turn dequeue, before spec comparison/spawn. */
  #clearIdleTtl(): void {
    if (this.#epoch !== null) this.#clearIdleTtlTimer(this.#epoch);
  }

  #clearIdleTtlTimer(epoch: EpochRuntime): void {
    if (epoch.idleTtlTimer === null) return;
    this.#clearEpochIdleTimer(epoch.idleTtlTimer);
    epoch.idleTtlTimer = null;
  }

  /** issue #377 Stage 2 M7: (re-)arms the idle-TTL timer for the current
   *  epoch. Called only once a turn's own result/error has settled (never
   *  at dequeue), so the TTL can never fire mid-spawn or mid-delivery-ack. */
  #armIdleTtl(): void {
    const epoch = this.#epoch;
    if (epoch === null) return;
    this.#clearIdleTtlTimer(epoch);
    epoch.idleTtlTimer = this.#setEpochIdleTimer(() => {
      epoch.idleTtlTimer = null;
      void this.#endEpoch("idle_ttl");
    }, this.#epochIdleMs);
  }

  #handleEvent(event: AgyStreamEvent, gate: AntigravityGate, assistantText: Map<number, string>): void {
    if (event.event === "init") {
      gate.inspectToolInventory(Array.isArray(event.init.tools) ? event.init.tools : []);
      const sessionId = agyEventToSessionId(event);
      if (sessionId !== null) {
        this.#sessionId = sessionId;
        this.#options.onSessionId?.(sessionId);
        // issue #377 Stage 2 M6: the epoch adopts its OWN conversation id
        // from its own init -- this is the only writer of a LIVE epoch's
        // recorded spec. Without it, a freshly spawned epoch's spec
        // (conversationId: null) would permanently mismatch every later
        // turn's freshly computed spec (which reads the now-confirmed
        // #sessionId), forcing a spurious spec_change respawn on turn 2.
        if (this.#epoch !== null && this.#epoch.spec.conversationId !== sessionId) {
          this.#epoch.spec = { ...this.#epoch.spec, conversationId: sessionId };
        }
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

  /** issue #377 Stage 1: the prompt travels over stdin as one NDJSON line
   *  (`#deliverTurnInput`), not as an argv positional -- `agy --print`'s
   *  `--input-format stream-json` mode waits for a promoted `run_command`
   *  background task before emitting `result` (measured,
   *  docs/evidence/antigravity/print-mode-background-tasks.md probe E),
   *  whereas an argv-prompt run clamps `WaitMsBeforeAsync` at 10s and kills
   *  the task 5s after the model's last text (issue #377). issue #377 Stage
   *  2: built from an `EpochSpec` (spawn time only, once per epoch) rather
   *  than per-turn parameters -- `spec.conversationId` is `null` for a
   *  fresh epoch (the epoch adopts its own id from its own `init`, M6) and
   *  otherwise the id being continued (an interrupt-then-respawn, or a
   *  resumed session). */
  #epochArguments(spec: EpochSpec): string[] {
    const args = [
      "--print", "",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      // issue #377 Stage 2: `0` is the CLI's own documented "no timeout"
      // value (`agy --help`: "0 waits until the turn completes (default
      // 0s)"), measured live not to change promotion or error behaviour
      // (docs/evidence/antigravity/print-mode-background-tasks.md). A
      // background task outliving several turns is bounded by
      // `TurnWatchdog`, not this flag; an unsolicited exit while idle
      // becomes `epoch_ended{idle_exit}`.
      "--print-timeout", "0",
      "--disable-slash-commands",
    ];
    if (this.#options.dangerouslySkipPermissions ?? true) args.push("--dangerously-skip-permissions");
    if (spec.conversationId !== null) args.push("--conversation", spec.conversationId);
    if (spec.model !== undefined && spec.model !== "") args.push("--model", spec.model);
    if (spec.effort !== undefined) args.push("--effort", spec.effort);
    for (const dir of spec.addDirs) args.push("--add-dir", dir);
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
    // issue #379: `detached: true` starts agy as its own process-group
    // leader (POSIX `setsid`), so `signalSubtree`'s `process.kill(-pid,
    // signal)` reaches every descendant it spawns (e.g. a `run_command`
    // promoted background task, issue #377) instead of only the leader.
    // No `unref()` -- the wrapper must keep observing this child for its
    // full lifetime, not let it run detached from supervision.
    return spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], detached: true }) as ChildProcessWithoutNullStreams;
  }
}
