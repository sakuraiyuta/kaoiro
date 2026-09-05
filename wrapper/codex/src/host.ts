// CodexHost — owns the real Codex SDK session for one agent: spawns one
// `codex exec` per turn via @openai/codex-sdk (resume for turns 2+), derives
// kaoiro states from the ThreadEvent stream (adapter.ts + the shared state
// machine), and serves the common tools through the MCP bridge
// (docs/specs/codex-sdk-events.md, ADR-0032). The Claude twin is
// @kaoiro/claude-code's AgentHost; both implement EngineAdapter.
//
// Permission model (ADR-0033 F3): the sandbox axis is fixed at launch and
// the approval axis is pinned to "never" — codex exec cannot deliver
// approval requests to the caller, so waiting_permission never occurs here.

import { randomUUID } from "node:crypto";
import { Codex } from "@openai/codex-sdk";
import type {
  CodexOptions,
  ThreadEvent,
  ThreadOptions,
} from "@openai/codex-sdk";
import {
  initialMachineState,
  makeAttachRejected,
  makeInstructionRejected,
  makeLog,
  makeResult,
  makeStateChange,
  makeTask,
  normalizeTasklist,
  stepState,
  TASKLIST_TASK_ID,
} from "@kaoiro/agent-common";
import type {
  AdapterEvent,
  EffectiveStatusSnapshot,
  EngineAdapter,
  Envelope,
  KaoiroState,
  LogEntry,
  MachineState,
  ModelSource,
  PendingPermissionExt,
  PendingQuestionExt,
  PermissionMode,
  AttachRejectedPayload,
  InstructionRejectedPayload,
  ResolvedSnapshotExt,
  SwitchErrorExt,
  TaskPayload,
  TasklistSourceItem,
  ToolDescriptor,
  WhoamiSnapshot,
  WrapperConfig,
} from "@kaoiro/agent-common";
import {
  clipText,
  computeResumeDrift,
  effectiveStatusEnvelopeFields,
  effectiveStatusWhoamiFields,
  logEntryToPayload,
} from "@kaoiro/agent-common";
import {
  threadEventToErrorDetail,
  threadEventToEvents,
  threadEventToFinalText,
  threadEventToLogs,
  threadEventToSessionId,
  threadEventToTasklist,
} from "./adapter.js";
import {
  assertCuratedModelCompatible,
  effortLevelsForModel,
  resolveCodexCatalog,
} from "./catalog.js";
import { effectiveNetworkAccess } from "./network_access.js";
import {
  codexRateLimitsFromRolloutIn,
  codexRolloutsRoot,
  isRolloutCorruptionDetail,
  repairRolloutCorruption,
  resolveCodexModel,
  verifyRolloutCorruption,
  type CodexRateLimitSnapshot,
  type CodexRateLimitWindow,
  type RolloutCorruptionVerdict,
  type RolloutRepairResult,
} from "./rollout.js";
import {
  CodexTurnDiagnostics,
  codexTurnTraceCaptureDir,
  defaultCodexTurnTraceDir,
  pruneCodexTurnTraceCaptureDirs,
} from "./turn_diagnostics.js";
import { ToolHost } from "./toolhost.js";
import {
  MAX_ATTACHMENTS_PER_INSTRUCTION,
  MAX_INFLIGHT_UPLOADS,
  PENDING_UPLOAD_GC_INTERVAL_MS,
  PENDING_UPLOAD_TTL_MS,
  PROTOCOL_FILE_SIZE_LIMIT_BYTES,
  cleanupLocalImages,
  materializeLocalImages,
  parseChunkPayload,
  sweepOrphanLocalImages,
  type PendingUpload,
  type MaterializeLifecycle,
  type UploadMeta,
  validateClose,
  validateOpen,
} from "./upload.js";

/** Structural view of the SDK surface the host drives; injectable so tests
 *  script ThreadEvents without a codex binary. */
export interface CodexThreadLike {
  runStreamed(
    input: string | Array<{ type: "text"; text: string } | { type: "local_image"; path: string }>,
    turnOptions?: { signal?: AbortSignal },
  ): Promise<{ events: AsyncIterable<ThreadEvent> }>;
}
export interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
}

type CodexCatalog = ReturnType<typeof resolveCodexCatalog>;

const DEFAULT_CODEX_TERMINAL_DRAIN_GRACE_MS = 5_000;

export type CodexLifecycleEvent =
  | { kind: "turn_start"; turnToken: string }
  | { kind: "sdk_event"; turnToken: string; type: string }
  | {
      kind: "terminal";
      turnToken: string;
      type: "turn.completed" | "turn.failed";
      authoritative: boolean;
    }
  | { kind: "stream_eof"; turnToken: string; terminalSeen: boolean };

type NextEventOutcome<T> =
  | { kind: "result"; result: IteratorResult<T> }
  | { kind: "error"; error: unknown }
  | { kind: "timeout"; pending: Promise<IteratorResult<T>> };

/** Wait for one post-terminal item without allowing a perpetually open SDK
 * iterator to hold the host's single-turn queue forever. The pending next()
 * is retained so the caller can abort and await the SDK's cleanup path before
 * admitting another process. */
function nextEventBeforeDeadline<T>(
  iterator: AsyncIterator<T>,
  deadlineMs: number,
): Promise<NextEventOutcome<T>> {
  let pending: Promise<IteratorResult<T>>;
  try {
    pending = Promise.resolve(iterator.next());
  } catch (error) {
    return Promise.resolve({ kind: "error", error });
  }
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    return Promise.resolve({ kind: "timeout", pending });
  }
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ kind: "timeout", pending });
    }, remainingMs);
    pending.then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: "result", result });
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: "error", error });
      },
    );
  });
}

function initialStatusExtFromCatalog(
  catalog: CodexCatalog,
  model: string | null,
): Record<string, unknown> {
  return {
    engine: "codex",
    session_capabilities: {
      supports_attachments: true,
      attachment_types: ["image"],
      supports_user_input_dialog: true,
      supports_model_switch: catalog.length > 0,
      // Phase-23 dogfood 再回帰対策 (藤 修正版方針 3): exact match の
      // effort_levels 、無ければ catalog intersection (fail-closed) の
      // length で判定。model=null (account default 経路 / 前回セッション
      // が turn 未完了で snapshot 未 stamp) でも catalog に共通 effort
      // levels があれば true を stamp、UI 側 effort switch button が
      // 有効化される (dashboard も同じ helper 相当の 2 段階 fallback)。
      supports_effort_switch:
        effortLevelsForModel(catalog, model).length > 0,
      supports_session_reset: true,
      session_reset_modes: ["new", "clear"],
      // ADR-0040 phase-21: Codex は explicit false を stamp。
      // turn.completed.usage.input_tokens は per-turn 入力のみで compaction
      // で縮み reasoning/output も含まないため context 使用率とは semantics
      // が異なる。max window 取得経路もない (catalog に context_window field
      // なし)。UI は「未対応」表示。upstream で compaction telemetry が
      // 確定するまで estimated 投影も行わない (docs/specs/codex-sdk-events.md)。
      supports_context_usage: false,
    },
    ...(catalog.length > 0 ? { models: catalog } : {}),
  };
}

/** Config-static status fields available before the Codex SDK starts.
 *  Catalog resolution is synchronous and matches the host projection. */
export function initialStatusExt(
  config: WrapperConfig,
): Record<string, unknown> {
  // issue #292: operator-declared codex.extra_models, relayed by the
  // runner as codex_extra_models, layer on top of the resolved catalog —
  // same merge the runner already applied to the register's launch list.
  const catalog = resolveCodexCatalog(
    config.codex_auth_mode ?? "unknown",
    config.codex_chatgpt_plan,
    config.codex_extra_models,
  );
  return initialStatusExtFromCatalog(catalog, config.model ?? null);
}

export interface CodexHostOptions {
  /** Invoked on every state transition with the common envelope. */
  onState: (envelope: Envelope) => void;
  /** Invoked per relayable log line (assistant text / tool call / result). */
  onLog?: (envelope: Envelope) => void;
  /** Invoked for the parent agent's whole-list todo snapshot (issue #188,
   * ADR-0049). It is distinct from transcript logs and child-task progress. */
  onTask?: (envelope: Envelope) => void;
  /** Invoked once per turn boundary (success or error), alongside (not
   *  instead of) onLog's result envelope (issue #131; extended issue #221
   *  段階3 direction 2 for coalescing). `conversationIds` is the inter-agent
   *  conversation(s) that turn's injection came from (the value passed as
   *  send()'s third argument for that queued turn) — empty for an ordinary
   *  operator-instruction turn, one entry for an ordinary inter-agent turn,
   *  MULTIPLE entries when several same-peer pending messages were coalesced
   *  into this one turn — must-fix 1: turn-scoped, so the CLI never resolves
   *  a conversation the current turn was not actually answering. `error` is
   *  present only when the turn ended with is_error=true. Codex has no
   *  structured failure taxonomy like Claude's terminal_reason —
   *  `error.reason` is never populated here; `error.detail` carries whatever
   *  raw message is available (ThreadError.message / the runStreamed
   *  rejection), or is omitted when the stream simply ended without a
   *  terminal event. The CLI feeds `error` into the shared inter-agent error
   *  classifier, which keyword-sniffs `detail` and otherwise degrades to
   *  "api_error", then resolves exactly this turn's conversation(s) via
   *  InterAgentTool#resolveTurnEnd — on error, EVERY conversationId in the
   *  list gets its own peer_error notice (the wrapper cannot tell which one
   *  message in a coalesced batch caused the failure). Omitted = no notice
   *  is ever emitted (unit tests only — production wires it). */
  onTurnEnd?: (info: {
    /** Immutable identity of this exact host turn. */
    turnToken: string;
    conversationIds: readonly string[];
    error?: { reason?: string; detail?: string };
    cancellation?: { kind: "watchdog_fail_stop"; started: false };
  }) => void;
  /** The exact boundary at which an already-queued input begins an SDK turn.
   * Queue insertion intentionally does not count as dispatch (#247). */
  onTurnStart?: (info: { turnToken: string; conversationIds: readonly string[] }) => void;
  /** Wrapper-local lifecycle evidence for the Codex stream. This is kept out
   * of transcript envelopes because it exists to diagnose SDK wedges. */
  onLifecycle?: (event: CodexLifecycleEvent) => void;
  /** Exact SDK boundary, before lifecycle telemetry or failure persistence.
   * This is intentionally separate from the fail-soft observation sink. */
  onTurnBoundary?: (info: { turnToken: string }) => void;
  /** Invoked after this host turn has fully left or been dropped from the
   * stream path. Unlike stream_eof, this also covers timeout cleanup, stream
   * rejection, and queued fail-stop cancellation. */
  onTurnFinalized?: (info: { turnToken: string }) => void;
  /** Invoked for every SDK frame while the exact turn is active. */
  onTurnProgress?: (info: { turnToken: string }) => void;
  /** Called when watchdog grace expires. The active token is deliberately not
   * settled: its outcome remains owned by supervisor recovery. */
  onWatchdogFailStop?: (info: {
    turnToken?: string;
    conversationIds: readonly string[];
    attribution: "exact" | "unattributed";
  }) => void;
  /** Server-composed personality + common footer (ADR-0029 F5), injected as
   *  a developer-role message via config.developer_instructions (ADR-0032
   *  F3, verified 2026-07-10). */
  appendSystemPrompt: string;
  /** instruction_rejected sink (file-upload spec). */
  onInstructionRejected?: (envelope: Envelope) => void;
  /** attach_rejected sink for malformed / unsupported upload frames. */
  onAttachRejected?: (envelope: Envelope) => void;
  /** Reports the thread id (kaoiro session_id) once known (ADR-0014). */
  onSessionId?: (sessionId: string) => void;
  /** Common tools served to codex through the MCP bridge (ADR-0032 F5):
   *  inter-agent tools + ask_user_question. Empty/omitted = no bridge. */
  toolDescriptors?: ToolDescriptor[];
  /** Origin of the model resolved by the CLI at startup (ADR-0032 F4bc
   *  addendum, phase-15). "launch" / "env" / "config" means the wrapper
   *  received an explicit pick and stays with that source; leave undefined
   *  when config.model is unset so account default applies. */
  modelSource?: ModelSource;
  /** Origin of the effort resolved by the CLI at startup. Same semantics
   *  as modelSource; undefined when config.effort is unset. */
  effortSource?: ModelSource;
  /** Resume pointer: an existing codex thread id (UUIDv7). */
  resumeSessionId?: string;
  /** Resume snapshot from the server (ADR-0014 F1 追補, phase-15 D8):
   *  the "last effective" resolved values captured before this relaunch.
   *  Only set on a resume launch; absent on a fresh spawn. When set, the
   *  host stamps ext.resume_snapshot and ext.resume_drift on every
   *  state_change alongside ext.effective. */
  resumeSnapshot?: ResolvedSnapshotExt;
  /** SDK client factory; injectable for tests. */
  codexFactory?: (options: CodexOptions) => CodexClientLike;
  /** Resolves the server-selected model from the Codex rollout. */
  modelResolver?: (sessionId: string) => Promise<string | null>;
  /** Resolves the latest per-window rate-limit snapshots from the Codex
   *  rollout. Injectable so tests can script snapshots without a rollout
   *  file. Defaults to `codexRateLimitsFromRolloutIn(codexRolloutsRoot(), …)`. */
  rateLimitResolver?: (
    sessionId: string,
  ) => Promise<Map<CodexRateLimitWindow, CodexRateLimitSnapshot>>;
  /** Confirms whether a resume-failure CANDIDATE is real rollout corruption
   *  (issue #263, ふじ MF-1/MF-2). Injectable so tests can point the real
   *  `verifyRolloutCorruption` at a fixture rollout root instead of
   *  `~/.codex/sessions` — the default wraps `verifyRolloutCorruption`
   *  itself (real fatal-UTF-8-decode + per-line JSON.parse), never a stub,
   *  so an injected variant only changes WHERE it reads, not what
   *  "corrupted" means. */
  rolloutCorruptionVerifier?: (sessionId: string) => RolloutCorruptionVerdict;
  /** Repairs a confirmed corrupt rollout. Injectable so tests can direct the
   * real repairer at a fixture root; a failed repair remains on #253's
   * permanent error/manual-fallback path. */
  rolloutCorruptionRepairer?: (sessionId: string) => RolloutRepairResult;
  /** ISO timestamp source; injectable for tests. */
  now?: () => string;
  /** Epoch clock for deterministic upload TTL tests. */
  nowMs?: () => number;
  /** Maximum time to drain SDK output after a terminal event. */
  terminalDrainGraceMs?: number;
  /** Overrides the bundled CLI version for deterministic compatibility tests. */
  codexClientVersion?: string;
  /** Test seam for deterministic materialization lifecycle races. */
  materializeImages?: (
    agentId: string,
    uploads: PendingUpload[],
    lifecycle: MaterializeLifecycle,
  ) => Promise<{ dir: string; paths: string[] }>;
  /** Local directory for failure-only Codex turn traces. Production defaults
   * to ~/.kaoiro/codex-turn-traces; tests inject a temporary directory. */
  turnTraceDir?: string;
}

/** Bridge entry point, resolved against the built package layout. Works from
 *  dist/ (runtime) and src/ (tsx dev) alike — both point at dist/bridge.js,
 *  so dev spawns need a prior `pnpm build` of @kaoiro/codex. */
const BRIDGE_SCRIPT = new URL("../dist/bridge.js", import.meta.url).pathname;

function rateLimitsDiffer(
  a: Map<CodexRateLimitWindow, CodexRateLimitSnapshot>,
  b: Map<CodexRateLimitWindow, CodexRateLimitSnapshot>,
): boolean {
  if (a.size !== b.size) return true;
  for (const [window, next] of b) {
    const prev = a.get(window);
    if (prev === undefined) return true;
    if (
      prev.utilization !== next.utilization ||
      prev.resets_at !== next.resets_at
    ) {
      return true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The SDK types describe well-formed JSONL, but a malformed external event
 * must be traceable without entering the production adapter path.
 *
 * `runStreamed()` yields the Codex CLI's JSONL through `JSON.parse`. That
 * boundary creates data-only objects, so the property reads below cannot
 * invoke accessors or proxies. If this input ever gains another producer
 * (especially hand-constructed objects), wrap this gate before relying on
 * the same fail-soft guarantee. */
function isUsableThreadEvent(event: unknown): event is ThreadEvent {
  if (!isRecord(event) || typeof event.type !== "string") return false;
  switch (event.type) {
    case "thread.started":
      return typeof event.thread_id === "string";
    case "turn.started":
    case "turn.completed":
      return true;
    case "turn.failed":
      return isRecord(event.error) && typeof event.error.message === "string";
    case "error":
      return typeof event.message === "string";
    case "item.started":
    case "item.updated":
    case "item.completed":
      return isUsableThreadItem(event.item);
    default:
      return false;
  }
}

function isUsableThreadItem(item: unknown): boolean {
  if (!isRecord(item) || typeof item.id !== "string" || typeof item.type !== "string") {
    return false;
  }
  switch (item.type) {
    case "agent_message":
    case "reasoning":
      return typeof item.text === "string";
    case "command_execution":
      return (
        typeof item.command === "string" &&
        typeof item.aggregated_output === "string" &&
        typeof item.status === "string" &&
        (item.exit_code === undefined || typeof item.exit_code === "number")
      );
    case "file_change":
      return (
        typeof item.status === "string" &&
        Array.isArray(item.changes) &&
        item.changes.every(
          (change) =>
            isRecord(change) &&
            typeof change.path === "string" &&
            typeof change.kind === "string",
        )
      );
    case "mcp_tool_call":
      return (
        typeof item.server === "string" &&
        typeof item.tool === "string" &&
        typeof item.status === "string" &&
        (item.error === undefined ||
          (isRecord(item.error) && typeof item.error.message === "string")) &&
        (item.result === undefined ||
          item.result === null ||
          (isRecord(item.result) && Array.isArray(item.result.content)))
      );
    case "web_search":
      return typeof item.query === "string";
    case "todo_list":
      return (
        Array.isArray(item.items) &&
        item.items.every(
          (entry) =>
            isRecord(entry) &&
            typeof entry.text === "string" &&
            typeof entry.completed === "boolean",
        )
      );
    case "error":
      return typeof item.message === "string";
    default:
      return false;
  }
}

export class CodexHost implements EngineAdapter {
  readonly #config: WrapperConfig;
  /** Last-applied display_name sync revision (issue #197 段階3, D15,
   *  renamed issue #219 D19/D23) — see `AgentHost`'s identical field in
   *  `@kaoiro/claude-code` for the reasoning shared across both
   *  engines. */
  #displayNameRevision = 0;
  readonly #options: CodexHostOptions;
  readonly #now: () => string;
  #machine: MachineState = initialMachineState();
  #sessionId: string | null = null;
  /** issue #263: session id whose rollout has been CONFIRMED permanently
   *  corrupted — a resume failure whose detail matched the candidate
   *  pattern (`isRolloutCorruptionDetail`) AND whose rollout file itself
   *  verified as corrupted (`verifyRolloutCorruption`, ふじ MF-1). Once
   *  set, `#runTurn` skips the doomed `resumeThread()` call for THIS
   *  session id and returns the same classified error immediately instead
   *  of re-spawning `codex exec` every turn only to hit the identical
   *  failure — the silent exit-1 retry loop this issue exists to close.
   *  Cleared implicitly whenever `#sessionId` moves to a different value
   *  (a fresh thread has a fresh, presumably intact, rollout); this host
   *  never resets it pre-emptively. */
  #corruptedRolloutSessionId: string | null = null;
  /** issue #263 (ふじ should-fix 1): the root-cause error detail from the
   *  FIRST turn that confirmed `#corruptedRolloutSessionId`. Later turns'
   *  synthetic "resume skipped" error would otherwise replace it and lose
   *  the original diagnostic text an operator needs. */
  #corruptedRolloutDetail: string | null = null;
  #model: string | null;
  #modelPending: string | null = null;
  #modelLastGood: string | null = null;
  #modelLastGoodSource: ModelSource | null = null;
  #modelRollbackPinned = false;
  #modelSource: ModelSource | null;
  #effort: string | null;
  #effortPending: string | null = null;
  #effortLastGood: string | null = null;
  #effortLastGoodSource: ModelSource | null = null;
  #effortResetPending = false;
  #effortResetOnce = false;
  #switchErrorOnce: SwitchErrorExt | null = null;
  readonly #operatorSwitchedFields = new Set<keyof ResolvedSnapshotExt>();
  #effortSource: ModelSource | null;
  readonly #resumeSnapshot: ResolvedSnapshotExt | null;
  readonly #sandbox: NonNullable<WrapperConfig["sandbox"]>;
  readonly #networkAccess: boolean;
  readonly #cwd: string = process.cwd();
  readonly #catalog: CodexCatalog;
  #pendingPermission: PendingPermissionExt | null = null;
  #pendingQuestion: PendingQuestionExt | null = null;
  /** Queued SDK input. A local_image temp directory belongs to exactly one
   * turn and is deleted from #runTurn's finally path. `conversationIds`
   * (issue #131 must-fix 1; extended issue #221 段階3 direction 2 for
   * coalescing) tags a turn injected to answer inter-agent message(s);
   * undefined for an ordinary operator instruction, one entry for an
   * ordinary inter-agent turn, multiple entries when several same-peer
   * pending messages were coalesced into this one turn. Threaded through
   * #runTurn so onTurnEnd resolves exactly this turn's conversation(s). */
  readonly #queue: Array<{
    input: string | Array<{ type: "text"; text: string } | { type: "local_image"; path: string }>;
    tempDir?: string;
    conversationIds?: readonly string[];
    turnToken?: string;
  }> = [];
  readonly #pendingUploads = new Map<string, PendingUpload>();
  /** Includes dirs still being materialized, queued, or streaming. */
  readonly #activeTempDirs = new Set<string>();
  /** Incremented before interrupt/close cleanup; makes in-flight async
   * materialization observe cancellation before it can enqueue a turn. */
  #lifecycleGeneration = 0;
  readonly #nowMs: () => number;
  readonly #terminalDrainGraceMs: number;
  #gcTimer: ReturnType<typeof setInterval> | null = null;
  #wake: (() => void) | null = null;
  #abort: AbortController | null = null;
  /** Present only while the SDK is executing one host turn. */
  #activeTurnToken: string | null = null;
  #activeTurnConversationIds: readonly string[] = [];
  #closed = false;
  #watchdogFailStopped = false;
  /** Fail-stop cleanup is started synchronously with queue removal, then
   * awaited by recovery/tests without ever including the active turn. */
  #watchdogQueuedCleanup: Promise<void> = Promise.resolve();
  /** Invalidates an older turn's asynchronous account-default refresh. */
  #modelResolutionGeneration = 0;
  /** tool_use_id -> tool_name for tool_result backfill (protocol.md #40). */
  readonly #toolNames = new Map<string, string>();
  /** Exact last tasklist wire content. This de-duplicates repeated SDK
   * snapshots without applying the child-task time/token throttle. */
  #lastTasklistJson: string | null = null;
  /** Latest per-window rate-limit snapshot (mirrors AgentHost's #rateLimits).
   *  Populated when a session id becomes known and after each terminal
   *  ThreadEvent — Codex has no in-stream rate_limit event, unlike Claude. */
  readonly #rateLimits = new Map<
    CodexRateLimitWindow,
    CodexRateLimitSnapshot
  >();
  /** In-flight guard for #refreshRateLimits(): coalesces multiple concurrent
   *  refresh triggers so a slow rollout tail cannot pile up work. */
  #rateLimitsInflight = false;
  /** Session whose startup rollout snapshot was already attempted. The CLI
   *  initializes resumed sessions before its first state, while run() also
   *  invokes the same method as a safety net; this keeps that startup read
   *  exactly once per session. */
  #rateLimitsInitializedSessionId: string | null = null;
  /** This process's private trace capture directory. It is derived without
   * filesystem I/O so a broken diagnostic path cannot prevent host startup. */
  readonly #turnTraceCaptureDir: string;
  readonly #turnTraceBaseDir: string;

  constructor(config: WrapperConfig, options: CodexHostOptions) {
    this.#config = config;
    this.#options = options;
    this.#turnTraceBaseDir =
      options.turnTraceDir ?? defaultCodexTurnTraceDir();
    this.#turnTraceCaptureDir = codexTurnTraceCaptureDir(
      this.#turnTraceBaseDir,
      config.agent_id,
      randomUUID(),
    );
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#nowMs = options.nowMs ?? Date.now;
    this.#terminalDrainGraceMs = Math.max(
      0,
      options.terminalDrainGraceMs ?? DEFAULT_CODEX_TERMINAL_DRAIN_GRACE_MS,
    );
    this.#model = config.model ?? null;
    this.#modelSource = options.modelSource ?? null;
    this.#effort = config.effort ?? null;
    this.#effortSource = options.effortSource ?? null;
    this.#resumeSnapshot = options.resumeSnapshot ?? null;
    // Phase-23 dogfood 回帰対策 (ADR-0014 F1 追補 P1「launch pin vs display
    // hint」): runner の 5-case pair rule Case 2 (source=default) は
    // config.model / config.effort を unset するので、SDK には「委任」の
    // semantics で pin されない。しかし wrapper の display / catalog resolve
    // には前回セッションの value が必要 — resume_snapshot の (value,
    // source="default") ペアを display hint として復元し、`this.#model` /
    // `this.#effort` に反映する。config/option の explicit 値が既に set の
    // 場合はそちらが優先 (fallback は absent 時のみ)。pair 整合 pin: value
    // と source が両方揃った "default" ペアのみを対象にし、source-only や
    // explicit source pair は runner apply の管轄外なのでここでは扱わない。
    if (this.#resumeSnapshot !== null) {
      if (
        this.#model === null &&
        this.#resumeSnapshot.model !== undefined &&
        this.#resumeSnapshot.model_source === "default"
      ) {
        this.#model = this.#resumeSnapshot.model;
        this.#modelSource = "default";
      }
      if (
        this.#effort === null &&
        this.#resumeSnapshot.effort !== undefined &&
        this.#resumeSnapshot.effort_source === "default"
      ) {
        this.#effort = this.#resumeSnapshot.effort;
        this.#effortSource = "default";
      }
    }
    this.#sandbox = config.sandbox ?? "workspace-write";
    this.#networkAccess = config.network_access ?? false;
    // issue #292: same merge as initialStatusExt above, applied to the
    // constructor's own catalog (ext.models / effort-switch / setModel).
    this.#catalog = resolveCodexCatalog(
      config.codex_auth_mode ?? "unknown",
      config.codex_chatgpt_plan,
      config.codex_extra_models,
      options.codexClientVersion,
    );
    assertCuratedModelCompatible(
      this.#model,
      config.codex_extra_models,
      options.codexClientVersion,
    );
    this.#sessionId = options.resumeSessionId ?? null;
    // Phase-23 (ADR-0014 F1 追補 P1): a resume snapshot can restore both
    // model and effort into config even when the model has since been
    // catalogue-updated so effort_levels no longer include the persisted
    // effort. Mirror the setModel() code path: clear #effortPending and
    // route through the existing #effortResetPending / #effortResetOnce
    // one-shot so #finishTurn resets effort to the model's default_effort
    // on turn success and stamps ext.effort_reset once for UI feedback.
    //
    // Scope: RESUME PATH ONLY (`#resumeSnapshot !== null`). Fresh spawn
    // must retain the pre-Phase-23 behaviour — an operator-picked
    // incompatible effort passes through to the SDK unchanged, and the
    // SDK's own error / the existing switch_error rollback in
    // `#finishTurn` handles the mismatch. Widening the reset to fresh
    // spawn would silently override a launch-time choice that the
    // dashboard never explicitly asked to reset (藤 R1 must-fix).
    // Model absence / catalog entry without effort_levels → SDK 委任
    // (unchanged): the SDK's own error path handles a genuine mismatch,
    // covered by the existing switch_error rollback in #finishTurn.
    if (
      this.#resumeSnapshot !== null &&
      this.#model !== null &&
      this.#effort !== null
    ) {
      const modelInfo = this.#catalog.find(
        (entry) => entry.value === this.#model,
      );
      if (
        modelInfo?.effort_levels !== undefined &&
        !modelInfo.effort_levels.includes(this.#effort)
      ) {
        this.#effortPending = null;
        this.#effortResetPending = true;
        this.#effortResetOnce = true;
      }
    }
  }

  get state(): KaoiroState {
    return this.#machine.state;
  }

  /** whoami snapshot (protocol-inter-agent), mirroring AgentHost's shape. */
  statusSnapshot(): WhoamiSnapshot {
    const out: WhoamiSnapshot = {
      agent_id: this.#config.agent_id,
      persona: this.#config.persona,
      state: this.#machine.state,
      ...effectiveStatusWhoamiFields(this.#effectiveStatusSnapshot()),
    };
    out.cwd = this.#cwd;
    if (this.#sessionId !== null) out.session_id = this.#sessionId;
    // issue #254: the agent's own rate limits, read from the SAME map that
    // feeds ext.rate_limits, so the two agree at the moment this host stamps
    // them. That is the whole claim — a peer's copy travels through the
    // directory projection (core's projectRateLimits, which drops malformed
    // windows and trims to a cap), so peer-visible values can still differ.
    // An empty map omits the key, keeping absent = unknown rather than "no
    // limit". list_agents excludes the caller, so this is the only place an
    // agent can read its own utilisation.
    if (this.#rateLimits.size > 0) {
      out.rate_limits = Object.fromEntries(this.#rateLimits);
    }
    return out;
  }

  /**
   * Loads an already-written rollout snapshot before the CLI emits its
   * startup state. A fresh spawn has no session id yet, so this is a no-op
   * until thread.started establishes one in #runTurn.
   */
  async initializeRateLimits(): Promise<void> {
    const sessionId = this.#sessionId;
    if (
      sessionId === null ||
      this.#rateLimitsInitializedSessionId === sessionId
    ) {
      return;
    }
    this.#rateLimitsInitializedSessionId = sessionId;
    await this.#refreshRateLimits();
  }

  /** Single engine-neutral SoT for both state_change.ext and whoami (#113). */
  #effectiveStatusSnapshot(): EffectiveStatusSnapshot {
    // enforcement: "os" (ADR-0057 F4/F4c addendum) — Codex enforces sandbox
    // through the SDK's own OS sandbox, unlike Antigravity's advisory
    // (argument-inspection-only) enforcement.
    const permission = {
      sandbox: this.#sandbox,
      approval: "never",
      enforcement: "os",
    } as const;
    return {
      engine: "codex",
      resolved: {
        ...(this.#model !== null ? { model: this.#model } : {}),
        ...(this.#modelSource !== null
          ? { model_source: this.#modelSource }
          : {}),
        ...(this.#effort !== null ? { effort: this.#effort } : {}),
        ...(this.#effortSource !== null
          ? { effort_source: this.#effortSource }
          : {}),
        sandbox: this.#sandbox,
        network_access: effectiveNetworkAccess(
          this.#sandbox,
          this.#networkAccess,
        ),
      },
      permission,
    };
  }

  async send(
    text: string,
    attachmentIds?: string[],
    interAgentConversationIds?: readonly string[],
    interAgentTurnToken?: string,
  ): Promise<void> {
    if (this.#closed) return;
    if (
      attachmentIds !== undefined &&
      attachmentIds.length > MAX_ATTACHMENTS_PER_INSTRUCTION
    ) {
      this.#emitInstructionRejected({
        attachment_ids: attachmentIds,
        reason: "count_over",
        detail: `attachments=${attachmentIds.length} cap=${MAX_ATTACHMENTS_PER_INSTRUCTION}`,
      });
      return;
    }
    let input: string | Array<{ type: "text"; text: string } | { type: "local_image"; path: string }> = text;
    let tempDir: string | undefined;
    if (attachmentIds !== undefined && attachmentIds.length > 0) {
      const uploads = this.#resolveAttachments(attachmentIds);
      if (uploads === null) return;
      const generation = this.#lifecycleGeneration;
      const lifecycle: MaterializeLifecycle = {
        cancelled: () => this.#closed || generation !== this.#lifecycleGeneration,
        onDirectoryCreated: (dir) => this.#activeTempDirs.add(dir),
        onDirectoryDisposed: (dir) => this.#activeTempDirs.delete(dir),
      };
      try {
        const materialize = this.#options.materializeImages ?? materializeLocalImages;
        const materialized = await materialize(this.#config.agent_id, uploads, lifecycle);
        this.#activeTempDirs.add(materialized.dir);
        if (lifecycle.cancelled()) {
          await this.#cleanupTempDir(materialized.dir);
          return;
        }
        tempDir = materialized.dir;
        input = [
          { type: "text", text },
          ...materialized.paths.map((path) => ({ type: "local_image" as const, path })),
        ];
      } catch (error) {
        if (lifecycle.cancelled()) return;
        this.#emitInstructionRejected({
          attachment_ids: attachmentIds,
          reason: "sdk_error",
          detail: `local_image materialization failed: ${String(error)}`,
        });
        return;
      }
      for (const upload of uploads) this.#pendingUploads.delete(upload.meta.upload_id);
    }
    this.#apply({ kind: "user_send" });
    this.#queue.push({
      input,
      ...(tempDir === undefined ? {} : { tempDir }),
      ...(interAgentConversationIds === undefined
        ? {}
        : { conversationIds: interAgentConversationIds }),
      ...(interAgentTurnToken === undefined
        ? {}
        : { turnToken: interAgentTurnToken }),
    });
    this.#wake?.();
  }

  /** Turn ownership capability consumed by InterAgentTool. It is intentionally
   * null outside SDK execution so a late tool result cannot clear another
   * turn's pending inbound lease. */
  activeInterAgentTurnToken(): string | null {
    return this.#activeTurnToken;
  }

  async interrupt(): Promise<void> {
    this.#lifecycleGeneration += 1;
    this.#dropPendingUploads("interrupted");
    await this.#dropQueuedTempTurns();
    this.#abort?.abort();
  }

  /** Requests an interrupt only while this exact token owns the SDK turn.
   * The abort is a control signal, not a terminal acknowledgement. */
  requestInterruptForTurn(turnToken: string): boolean {
    if (
      this.#activeTurnToken !== turnToken ||
      this.#watchdogFailStopped ||
      this.#closed
    ) {
      return false;
    }
    this.#abort?.abort();
    return true;
  }

  /** Closes admission after an exact active token survives the watchdog
   * interrupt grace. The active token is retained without a result or ack;
   * supervisor recovery owns that uncertain outcome. */
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

  /** Fail closed when the watchdog can no longer prove which token is active. */
  failStopForWatchdogAttributionUnknown(): boolean {
    if (this.#watchdogFailStopped) return false;
    return this.#failStopForWatchdog("unattributed");
  }

  #failStopForWatchdog(
    attribution: "exact" | "unattributed",
  ): boolean {
    this.#watchdogFailStopped = true;
    this.#closed = true;
    if (this.#gcTimer !== null) clearInterval(this.#gcTimer);
    this.#gcTimer = null;
    this.#machine = initialMachineState("error");
    this.#emitState("error");

    // These entries have not reached #runTurn. They are safe to discard and,
    // when they belong to inter-agent batches, must settle as cancellations so
    // the caller can report the drop without touching the active token.
    const queuedTurns = this.#queue.splice(0);
    this.#watchdogQueuedCleanup = this.#cleanupWatchdogQueuedTurns(
      queuedTurns,
    ).then(() => {
      for (const turn of queuedTurns) {
        if (turn.turnToken !== undefined) {
          this.#options.onTurnFinalized?.({ turnToken: turn.turnToken });
        }
      }
    });
    const error = {
      detail:
        attribution === "exact"
          ? "turn watchdog interrupt grace expired; host admission stopped pending operator recovery"
          : "turn watchdog token attribution unavailable; host admission stopped pending operator recovery",
    };
    for (const turn of queuedTurns) {
      if (turn.turnToken === undefined) continue;
      this.#options.onTurnEnd?.({
        turnToken: turn.turnToken,
        conversationIds: turn.conversationIds ?? [],
        error,
        cancellation: { kind: "watchdog_fail_stop", started: false },
      });
    }
    this.#options.onWatchdogFailStop?.({
      ...(this.#activeTurnToken === null
        ? {}
        : { turnToken: this.#activeTurnToken }),
      conversationIds: this.#activeTurnConversationIds,
      attribution,
    });
    this.#wake?.();
    return true;
  }

  /** Waits for local-image directories belonging to fail-stopped queued
   * turns. The active turn's directory is intentionally outside this set. */
  async waitForWatchdogCleanup(): Promise<void> {
    await this.#watchdogQueuedCleanup;
  }

  close(): void {
    this.#closed = true;
    this.#lifecycleGeneration += 1;
    this.#dropPendingUploads("interrupted");
    if (this.#gcTimer !== null) clearInterval(this.#gcTimer);
    this.#gcTimer = null;
    void this.#dropQueuedTempTurns();
    this.#abort?.abort();
    this.#wake?.();
  }

  attachOpen(meta: UploadMeta): void {
    if (this.#pendingUploads.size >= MAX_INFLIGHT_UPLOADS) {
      this.#emitAttachRejected({ upload_id: meta.upload_id, reason: "count_over", detail: `in-flight=${this.#pendingUploads.size} cap=${MAX_INFLIGHT_UPLOADS}` });
      return;
    }
    const result = validateOpen(meta);
    if (!result.ok) {
      this.#emitAttachRejected({ upload_id: meta.upload_id, reason: result.reason, ...(result.detail === undefined ? {} : { detail: result.detail }) });
      return;
    }
    this.#pendingUploads.set(meta.upload_id, { meta, chunks: new Map(), sealed: false, accumulatedBytes: 0, addedAt: this.#nowMs() });
  }

  attachChunk(payload: ArrayBuffer | ArrayBufferView): void {
    let parsed;
    try { parsed = parseChunkPayload(payload); } catch { return; }
    const upload = this.#pendingUploads.get(parsed.upload_id);
    if (!upload || upload.sealed || parsed.chunk_index >= upload.meta.chunks) return;
    const total = upload.accumulatedBytes - (upload.chunks.get(parsed.chunk_index)?.byteLength ?? 0) + parsed.bytes.byteLength;
    if (total > upload.meta.size || total > PROTOCOL_FILE_SIZE_LIMIT_BYTES) {
      this.#pendingUploads.delete(parsed.upload_id);
      this.#emitAttachRejected({ upload_id: parsed.upload_id, reason: "size_over", detail: `accumulated=${total} declared=${upload.meta.size} cap=${PROTOCOL_FILE_SIZE_LIMIT_BYTES}` });
      return;
    }
    upload.chunks.set(parsed.chunk_index, parsed.bytes);
    upload.accumulatedBytes = total;
  }

  attachClose(uploadId: string): void {
    const upload = this.#pendingUploads.get(uploadId);
    if (!upload) return;
    const result = validateClose(upload);
    if (!result.ok) {
      this.#pendingUploads.delete(uploadId);
      this.#emitAttachRejected({ upload_id: uploadId, reason: result.reason, ...(result.detail === undefined ? {} : { detail: result.detail }) });
      return;
    }
    upload.sealed = true;
  }

  tickGC(): void {
    const cutoff = this.#nowMs() - PENDING_UPLOAD_TTL_MS;
    for (const [uploadId, upload] of this.#pendingUploads) {
      if (upload.addedAt < cutoff) {
        this.#pendingUploads.delete(uploadId);
        this.#emitAttachRejected({ upload_id: uploadId, reason: "timeout", detail: `ttl exceeded (added_at=${upload.addedAt} cutoff=${cutoff})` });
      }
    }
  }

  async setModel(value: string): Promise<void> {
    // Applies from the next turn: each turn resumes the thread with fresh
    // ThreadOptions, so no live session state needs touching.
    assertCuratedModelCompatible(
      value,
      this.#config.codex_extra_models,
      this.#options.codexClientVersion,
    );
    this.#modelPending = value;
    this.#effortResetPending = false;
    const model = this.#catalog.find((entry) => entry.value === value);
    const effort = this.#effortPending ?? this.#effort;
    if (
      effort !== null &&
      model?.effort_levels !== undefined &&
      !model.effort_levels.includes(effort)
    ) {
      this.#effortPending = null;
      this.#effortResetPending = true;
      this.#effortResetOnce = true;
    }
    this.#emitState(this.#machine.state);
  }

  async setEffort(level: string): Promise<void> {
    this.#effortPending = level;
    this.#effortResetPending = false;
    this.#emitState(this.#machine.state);
  }

  async setPermissionMode(_mode: PermissionMode): Promise<void> {
    throw new Error(
      "codex: permission is launch-fixed; mid-session change unsupported (ADR-0033 F3)",
    );
  }

  /** See `AgentHost#renameDisplayName` in `@kaoiro/claude-code` —
   *  identical contract, both engines share the same `EngineAdapter`
   *  surface (issue #197 段階3, renamed issue #219 D19/D23). */
  renameDisplayName(displayName: string, revision: number): void {
    if (revision <= this.#displayNameRevision) return;
    this.#displayNameRevision = revision;
    this.#config.display_name = displayName;
    this.#emitState(this.#machine.state);
  }

  setPendingPermission(pending: PendingPermissionExt | null): void {
    // Codex never produces permission requests (approval pinned to never);
    // kept for EngineAdapter conformance.
    this.#pendingPermission = pending;
  }

  /** Question twin of setPendingPermission — and, unlike the Claude host,
   *  ALSO the state driver: on codex the ask_user_question tool runs through
   *  the MCP bridge with no canUseTool hook, so the broker's pending change
   *  is the only signal that a question dialog opened/closed. */
  setPendingQuestion(pending: PendingQuestionExt | null): void {
    this.#pendingQuestion = pending;
    this.#apply({
      kind: pending !== null ? "question_request" : "question_resolved",
    });
  }

  async run(initialPrompt?: string): Promise<void> {
    // The CLI normally has already done this before its initial idle/sending
    // state. Keep the host self-sufficient for non-CLI callers; the per-
    // session guard makes the second call a no-op (issue #251).
    await this.initializeRateLimits();
    try {
      await pruneCodexTurnTraceCaptureDirs(
        this.#turnTraceBaseDir,
        this.#config.agent_id,
      );
    } catch (error) {
      // Retention is diagnostic-only; an unreadable trace root must not
      // prevent a real SDK turn or a default Codex factory from starting.
      process.stderr.write(`codex turn trace failed: ${String(error)}\n`);
    }
    const descriptors = this.#options.toolDescriptors ?? [];
    const toolHost =
      descriptors.length > 0 ? await ToolHost.listen(descriptors) : null;
    const factory =
      this.#options.codexFactory ??
      ((options: CodexOptions) => new Codex(options) as CodexClientLike);
    const codexConfig: Record<string, unknown> = {
      developer_instructions: this.#options.appendSystemPrompt,
    };
    // Runner config is authoritative over any user-global Codex config
    // (ADR-0038 F2): always inject the effective toggle so a positive
    // `internal_subagents: true` force-enables and `false` disables. Absent
    // resolves to the effective default (true), injected explicitly.
    codexConfig.features = {
      multi_agent: this.#config.codex_internal_subagents ?? true,
    };
    if (toolHost !== null) {
      codexConfig.mcp_servers = {
        kaoiro: {
          command: process.execPath,
          args: [BRIDGE_SCRIPT],
          env: {
            KAOIRO_BRIDGE_SOCKET: toolHost.socketPath,
            // The bridge appends only its own stderr to this private local
            // file. Each failure trace snapshots its tail; neither is sent
            // to a peer or interpolated into the notice template.
            KAOIRO_BRIDGE_STDERR_PATH:
              `${this.#turnTraceCaptureDir}/bridge.stderr.log`,
          },
          // `codex exec` forces approval_policy=never, which otherwise
          // auto-cancels every MCP tool call ("user cancelled MCP tool
          // call"). "approve" auto-approves the kaoiro tools so they run
          // (verified 2026-07-11; the other accepted values auto/prompt/
          // writes all leave the call cancelled). These tools are
          // wrapper-provided and gated by the operator elsewhere
          // (send_to_agent per-call on Claude; ask_user_question IS the
          // operator prompt), so auto-approving them is safe.
          default_tools_approval_mode: "approve",
          // Must outlive the 300s synchronous send_to_agent waiter. Leaving
          // Codex's 60s default here could cancel the outer MCP call while
          // the common-layer waiter still consumes a late reply (#114 M1).
          tool_timeout_sec: 310,
        },
      };
    }
    const codex = factory({
      config: codexConfig as NonNullable<CodexOptions["config"]>,
    });

    if (initialPrompt !== undefined) {
      this.#apply({ kind: "user_send" });
      this.#queue.push({ input: initialPrompt });
    }

    await sweepOrphanLocalImages(
      this.#config.agent_id,
      this.#warn,
      () => this.#activeTempDirs,
    );
    this.#gcTimer = setInterval(() => this.tickGC(), PENDING_UPLOAD_GC_INTERVAL_MS);

    try {
      while (!this.#closed) {
        const turn = this.#queue.shift();
        if (turn === undefined) {
          await new Promise<void>((resolve) => {
            this.#wake = resolve;
          });
          this.#wake = null;
          continue;
        }
        await this.#runTurn(
          codex,
          turn.input,
          turn.tempDir,
          turn.conversationIds ?? [],
          turn.turnToken ?? randomUUID(),
        );
      }
    } finally {
      if (this.#gcTimer !== null) clearInterval(this.#gcTimer);
      this.#gcTimer = null;
      this.#dropPendingUploads("interrupted");
      await this.#dropQueuedTempTurns();
      await this.#watchdogQueuedCleanup;
      toolHost?.close();
    }
  }

  #threadOptions(
    modelPending: string | null,
    effortPending: string | null,
    effortReset: boolean,
  ): ThreadOptions {
    const options: ThreadOptions = {
      sandboxMode: this.#sandbox,
      workingDirectory: this.#cwd,
      skipGitRepoCheck: true,
    };
    // A model observed from turn_context is display metadata, not an explicit
    // operator choice. Passing it back would silently pin later turns and
    // change the semantics of the account default.
    const model = modelPending ?? this.#model;
    if (
      model !== null &&
      (modelPending !== null ||
        this.#modelSource !== "default" ||
        this.#modelRollbackPinned)
    ) {
      options.model = model;
    }
    // Phase-23 dogfood 回帰対策: model 側の既存 gate (L446-454) と対称に、
    // effortSource="default" は SDK 委任継続で non-pin。display hint 復元で
    // this.#effort が set されていても、次 turn の SDK には渡さない。
    // operator setEffort は #effortSource="config" に上書きするため gate 通過。
    const effort = effortPending ?? this.#effort;
    if (
      !effortReset &&
      effort !== null &&
      (effortPending !== null || this.#effortSource !== "default")
    ) {
      options.modelReasoningEffort = effort as NonNullable<
        ThreadOptions["modelReasoningEffort"]
      >;
    }
    if (this.#sandbox === "workspace-write") {
      options.networkAccessEnabled = this.#networkAccess;
    }
    return options;
  }

  async #runTurn(
    codex: CodexClientLike,
    input: string | Array<{ type: "text"; text: string } | { type: "local_image"; path: string }>,
    tempDir?: string,
    conversationIds: readonly string[] = [],
    turnToken: string = randomUUID(),
    retryAfterRepair = false,
    settled: { value: boolean } = { value: false },
  ): Promise<void> {
    this.#activeTurnToken = turnToken;
    this.#activeTurnConversationIds = conversationIds;
    const diagnostics = new CodexTurnDiagnostics(this.#turnTraceCaptureDir);
    const persistFailure = async (
      input: Parameters<CodexTurnDiagnostics["writeFailure"]>[0],
    ): Promise<void> => {
      try {
        await diagnostics.writeFailure(input);
      } catch (error) {
        // A local diagnostic filesystem failure must never replace the SDK
        // turn's original outcome or suppress its fixed peer-error notice.
        process.stderr.write(`codex turn trace failed: ${String(error)}\n`);
      }
    };
    try {
      await diagnostics.begin();
    } catch (error) {
      // Match persistFailure's non-interference rule for the capture window.
      process.stderr.write(`codex turn trace failed: ${String(error)}\n`);
    }
    const resolutionGeneration = ++this.#modelResolutionGeneration;
    const attempted = {
      model: this.#modelPending,
      effort: this.#effortPending,
      effortReset: this.#effortResetPending,
      accountDefault:
        this.#modelPending === null &&
        (this.#model === null || this.#modelSource === "default"),
      resolutionGeneration,
    };
    // issue #263 (ふじ 必須pin): capture whether THIS turn is a resume
    // attempt, and which session id it targets, BEFORE anything in the
    // stream below can move `#sessionId`. Only a resume has a pre-existing
    // rollout that could be corrupted — a fresh startThread's mid-stream
    // failure must never be classified as permanent even if its text
    // happens to match a candidate pattern, since there is no pre-existing
    // rollout for that classification to mean anything about.
    const resumeSessionId = this.#sessionId;
    const isResumeAttempt = resumeSessionId !== null;
    // A resume already CONFIRMED permanently corrupted for THIS session id
    // is skipped — re-spawning `codex exec` would just re-read the same
    // broken rollout and fail identically, the silent exit-1 retry loop
    // this issue exists to close. Substitute an already-failing thread so
    // the ordinary catch(err) branch below handles it through the exact
    // same emit/trace path; carrying the ORIGINAL detail forward (ふじ
    // should-fix 1) keeps every subsequent turn's diagnostic text pointing
    // at the real root cause, not a generic "skipped" placeholder.
    const thread =
      resumeSessionId !== null &&
      resumeSessionId === this.#corruptedRolloutSessionId
        ? {
            runStreamed: () =>
              Promise.reject(
                new Error(
                  this.#corruptedRolloutDetail ??
                    `resume skipped: rollout for session ${resumeSessionId} already classified as permanently corrupted (issue #263)`,
                ),
              ),
          }
        : isResumeAttempt
          ? codex.resumeThread(
              resumeSessionId,
              this.#threadOptions(
                attempted.model,
                attempted.effort,
                attempted.effortReset,
              ),
            )
          : codex.startThread(
              this.#threadOptions(
                attempted.model,
                attempted.effort,
                attempted.effortReset,
              ),
            );
    // Creating/resuming the SDK thread is the last synchronous boundary
    // before `runStreamed()` hands the input to Codex. Confirm #247 delivery
    // here, never when its coordinator merely accepted the queue item.
    if (!retryAfterRepair) {
      this.#options.onLifecycle?.({ kind: "turn_start", turnToken });
      this.#options.onTurnStart?.({ turnToken, conversationIds });
    }
    this.#abort = new AbortController();
    let finalText: string | null = null;
    // A stream-level `error` is evidence, not a terminal boundary. Some SDK
    // versions may still follow it with turn.completed; retain it only so a
    // later terminal-less EOF has the best available local classification.
    let recordedThreadError: string | null = null;
    let sawResult = false;
    let sdkBoundaryEnded = false;
    const endSdkBoundary = (): void => {
      if (sdkBoundaryEnded) return;
      sdkBoundaryEnded = true;
      this.#options.onTurnBoundary?.({ turnToken });
    };
    try {
      const { events } = await thread.runStreamed(input, {
        signal: this.#abort.signal,
      });
      const iterator = events[Symbol.asyncIterator]();
      let terminalDrainDeadlineMs: number | null = null;
      let terminalEventSeen = false;
      while (true) {
        let next: IteratorResult<ThreadEvent>;
        if (terminalDrainDeadlineMs === null) {
          next = await iterator.next();
        } else {
          const outcome = await nextEventBeforeDeadline(
            iterator,
            terminalDrainDeadlineMs,
          );
          if (outcome.kind === "error") throw outcome.error;
          if (outcome.kind === "timeout") {
            // The SDK's iterator finally kills the child but does not await
            // its exit. Abort the pending read, then await that read and the
            // iterator close before the host admits the next process.
            this.#abort?.abort();
            await outcome.pending.catch(() => undefined);
            try {
              await iterator.return?.();
            } catch {
              // The terminal result is already settled; cleanup failure is
              // not allowed to produce a duplicate turn result.
            }
            break;
          }
          next = outcome.result;
        }
        if (next.done) {
          if (!terminalEventSeen && !this.#watchdogFailStopped) {
            endSdkBoundary();
          }
          this.#options.onLifecycle?.({
            kind: "stream_eof",
            turnToken,
            terminalSeen: terminalEventSeen,
          });
          break;
        }
        const event = next.value;
        const isUsable = isUsableThreadEvent(event);
        const isTerminalEvent =
          isUsable &&
          (event.type === "turn.completed" || event.type === "turn.failed");
        const firstTerminalEvent = isTerminalEvent && !terminalEventSeen;
        if (firstTerminalEvent) {
          terminalEventSeen = true;
          if (!this.#watchdogFailStopped) endSdkBoundary();
        }
        diagnostics.recordEvent(event);
        this.#options.onLifecycle?.({
          kind: "sdk_event",
          turnToken,
          type: isRecord(event) && typeof event.type === "string"
            ? event.type
            : "unknown",
        });
        this.#options.onTurnProgress?.({ turnToken });
        if (!isUsable || (terminalEventSeen && !firstTerminalEvent)) continue;
        if (firstTerminalEvent) {
          this.#options.onLifecycle?.({
            kind: "terminal",
            turnToken,
            type: event.type,
            authoritative: !this.#watchdogFailStopped,
          });
        }
        // A watchdog fail-stop makes the active outcome unknown. Continue to
        // consume the SDK stream for cleanup, but never re-enter the normal
        // result/state/ack path from a late frame.
        if (this.#watchdogFailStopped) {
          if (isTerminalEvent) sawResult = true;
          continue;
        }
        if (event.type === "error") recordedThreadError = event.message;
        const sessionId = threadEventToSessionId(event);
        if (sessionId !== null && sessionId !== this.#sessionId) {
          this.#sessionId = sessionId;
          this.#options.onSessionId?.(sessionId);
          // A fresh thread's first token_count can be absent, but a resumed
          // or reused rollout may already have a snapshot. Await its initial
          // read before the following SDK event emits state, so that state
          // carries ext.rate_limits when the rollout has data (issue #251).
          await this.initializeRateLimits();
        }
        for (const entry of threadEventToLogs(event)) {
          this.#emitLog(entry);
        }
        const tasklist = threadEventToTasklist(event);
        if (tasklist !== null) this.#emitTasklist(tasklist);
        const last = threadEventToFinalText(event);
        if (last !== null) finalText = last;
        if (event.type === "turn.completed") {
          sawResult = true;
          settled.value = true;
          this.#finishTurn(true, attempted);
          this.#emitResult({
            ...(finalText !== null ? { text: finalText } : {}),
          });
          this.#options.onTurnEnd?.({ turnToken, conversationIds });
          // Resolve only after the terminal event: at turn.started an existing
          // rollout can still expose the previous turn_context and look
          // spuriously "resolved". Keep this background so filesystem timing
          // never holds terminal delivery or the next instruction.
          if (attempted.accountDefault && this.#sessionId !== null) {
            void this.#refreshAccountDefaultModel(
              this.#sessionId,
              attempted.resolutionGeneration,
            );
          }
          void this.#refreshRateLimits();
        } else if (event.type === "turn.failed") {
          sawResult = true;
          settled.value = true;
          this.#finishTurn(false, attempted);
          this.#emitResult({ is_error: true });
          const detail = threadEventToErrorDetail(event);
          await persistFailure({
            sessionId: this.#sessionId,
            turnToken,
            conversationIds,
            ...(detail === null ? {} : { detail }),
            outcome: "turn_failed",
          });
          this.#options.onTurnEnd?.({
            turnToken,
            conversationIds,
            error: detail !== null ? { detail } : {},
          });
          // Failure paths (429 / max-output / auth error) still write a
          // token_count event to the rollout, so refresh on both branches.
          void this.#refreshRateLimits();
        }
        for (const adapterEvent of threadEventToEvents(event)) {
          this.#apply(adapterEvent);
        }
        if (isTerminalEvent && terminalDrainDeadlineMs === null) {
          // The terminal event is the SDK turn boundary, but upstream still
          // flushes the rollout after publishing it. Drain normal EOF first;
          // only a stuck tail may be aborted after this bounded grace.
          terminalDrainDeadlineMs =
            Date.now() + this.#terminalDrainGraceMs;
        }
      }
      if (!sawResult && !this.#watchdogFailStopped) {
        // Stream ended without a terminal turn event (abort, stream error
        // event, or process death): fold into the error path so the agent
        // never wedges in thinking/tool_running.
        settled.value = true;
        this.#finishTurn(false, attempted);
        this.#emitResult({ is_error: true });
        this.#apply({ kind: "result", subtype: "error_during_execution" });
        await persistFailure({
          sessionId: this.#sessionId,
          turnToken,
          conversationIds,
          ...(recordedThreadError === null
            ? {}
            : { detail: recordedThreadError }),
          outcome: "stream_ended_without_terminal",
        });
        this.#options.onTurnEnd?.({
          turnToken,
          conversationIds,
          error:
            recordedThreadError === null ? {} : { detail: recordedThreadError },
        });
      }
    } catch (err) {
      // runStreamed rejection or mid-stream throw (exec exited non-zero).
      if (this.#watchdogFailStopped) return;
      if (!sawResult) endSdkBoundary();
      let terminalError: unknown = err;
      if (!sawResult) {
        // A repair retry shares this marker with its original turn. Once the
        // retry began terminal delivery, its callback failure must not make
        // the original turn send a second result or peer-error notice.
        if (settled.value) return;
        const alreadyConfirmedCorrupted =
          resumeSessionId !== null &&
          resumeSessionId === this.#corruptedRolloutSessionId;
        // issue #263 (ふじ should-fix 1): once a session is confirmed
        // corrupted, every later turn's `err` is this file's OWN synthetic
        // "resume skipped" Error, built from `#corruptedRolloutDetail`.
        // Re-stringifying it here would double-wrap that Error's own
        // "Error: " toString prefix onto an already-stringified detail —
        // use the remembered root-cause text verbatim instead.
        let detail = alreadyConfirmedCorrupted
          ? (this.#corruptedRolloutDetail ?? String(err))
          : String(err);
        // issue #263 (ふじ MF-1 / 必須pin): a stderr keyword match alone
        // is only a CANDIDATE — several unrelated dependencies emit the
        // same generic wording (ふじ measured this directly against
        // codex-sdk 0.144.1's actual runStreamed stderr; neither pattern
        // in isRolloutCorruptionDetail is unique to the rollout reader).
        // Committing to the permanent classification requires confirming
        // against the ACTUAL rollout file via rolloutCorruptionVerifier /
        // verifyRolloutCorruption — "clean" or "unknown" (unreadable /
        // unresolvable) both fall back to the ordinary failure path rather
        // than risk permanently refusing to resume a session that failed
        // for an unrelated, self-recoverable reason. `isResumeAttempt`
        // (bound before the stream ran) is what keeps a fresh
        // startThread's mid-stream failure from ever reaching this branch,
        // even when its text happens to match a candidate pattern — there
        // is no pre-existing rollout for such a failure to have corrupted.
        let rolloutCorrupted = false;
        if (alreadyConfirmedCorrupted) {
          // Already confirmed on an earlier turn for this exact session —
          // no need to re-read the file every retry.
          rolloutCorrupted = true;
        } else if (isResumeAttempt && isRolloutCorruptionDetail(detail)) {
          const verify =
            this.#options.rolloutCorruptionVerifier ??
            ((id: string) => verifyRolloutCorruption(id));
          let verdict: RolloutCorruptionVerdict;
          try {
            verdict = verify(resumeSessionId);
          } catch {
            verdict = "unknown";
          }
          if (verdict === "corrupted") {
            let repaired = false;
            let repairedBackupPath: string | null = null;
            if (!retryAfterRepair) {
              try {
                const repair =
                  this.#options.rolloutCorruptionRepairer ??
                  ((id: string) => repairRolloutCorruption(id));
                const repairResult = repair(resumeSessionId);
                repaired = repairResult.repaired;
                if (repairResult.repaired) {
                  repairedBackupPath = repairResult.backupPath;
                }
              } catch {
                repaired = false;
              }
            }
            if (repaired && repairedBackupPath !== null) {
              try {
                process.stderr.write(
                  `codex rollout repaired for session ${resumeSessionId}; backup: ${repairedBackupPath}\n`,
                );
              } catch {
                // Diagnostics must not downgrade an already atomic repair.
              }
            }
            if (repaired) {
              try {
                await this.#runTurn(
                  codex,
                  input,
                  undefined,
                  conversationIds,
                  turnToken,
                  true,
                  settled,
                );
                return;
              } catch (retryError) {
                if (settled.value) return;
                // The retry has not reached a terminal event, so settle the
                // original turn once through the ordinary failure path.
                detail = String(retryError);
                terminalError = retryError;
              }
            } else {
              rolloutCorrupted = true;
            }
          }
        }
        settled.value = true;
        this.#finishTurn(false, attempted);
        if (rolloutCorrupted && resumeSessionId !== null) {
          // Remember both the session id AND this confirming turn's own
          // detail (ふじ should-fix 1) — #runTurn's guard at the top skips
          // the doomed resumeThread() call for this session id on every
          // later turn, and each of THOSE turns' synthetic "resume
          // skipped" detail would otherwise overwrite the real root cause.
          if (this.#corruptedRolloutSessionId !== resumeSessionId) {
            this.#corruptedRolloutDetail = detail;
          }
          this.#corruptedRolloutSessionId = resumeSessionId;
        }
        this.#emitResult(
          rolloutCorrupted
            ? {
                is_error: true,
                error_subtype: "error_rollout_corrupted",
                error_detail: detail,
              }
            : { is_error: true },
        );
        this.#apply({ kind: "result", subtype: "error_during_execution" });
        await persistFailure({
          sessionId: this.#sessionId,
          turnToken,
          conversationIds,
          detail,
          outcome: "run_streamed_rejected",
        });
        // issue #131 must-fix 2: String(err) is unstructured, untrusted text
        // (subprocess/exception message, possibly containing paths or other
        // detail unsafe to inject verbatim into a peer's LLM context). Safe
        // to pass as `detail` regardless: classifyInterAgentError uses
        // `detail` ONLY to keyword-sniff a code and never copies it into the
        // produced notice's message — the raw string itself never leaves
        // this process.
        this.#options.onTurnEnd?.({
          turnToken,
          conversationIds,
          error: { detail },
        });
      }
      if (!this.#closed) {
        // issue #263: operator/runner-log visibility for the permanent
        // classification — dashboard sees it via error_subtype above, but
        // this stderr line is what a runner-side log tail (or the
        // supervisor's own crash-loop diagnosis) can grep for without
        // reaching into the envelope stream.
        process.stderr.write(
          resumeSessionId !== null &&
            resumeSessionId === this.#corruptedRolloutSessionId
            ? // Same double-wrap concern as the `detail` computation above:
              // on a later turn `err` is this file's own synthetic
              // "resume skipped" Error, so use the remembered root cause
              // verbatim rather than re-stringifying it.
              `codex turn failed: rollout permanently corrupted for session ${resumeSessionId} (issue #263): ${this.#corruptedRolloutDetail ?? String(terminalError)}\n`
            : `codex turn failed: ${String(terminalError)}\n`,
        );
      }
    } finally {
      this.#abort = null;
      this.#activeTurnToken = null;
      this.#activeTurnConversationIds = [];
      if (tempDir !== undefined) await this.#cleanupTempDir(tempDir);
      if (!retryAfterRepair) {
        this.#options.onTurnFinalized?.({ turnToken });
      }
    }
  }

  #resolveAttachments(ids: string[]): PendingUpload[] | null {
    const uploads: PendingUpload[] = [];
    for (const id of ids) {
      const upload = this.#pendingUploads.get(id);
      if (!upload) {
        this.#emitInstructionRejected({ attachment_ids: ids, reason: "timeout", detail: `unknown upload_id ${id}` });
        return null;
      }
      const result = validateClose(upload);
      if (!result.ok) {
        this.#emitInstructionRejected({ attachment_ids: ids, reason: result.reason, ...(result.detail === undefined ? {} : { detail: result.detail }) });
        return null;
      }
      uploads.push(upload);
    }
    return uploads;
  }

  #dropPendingUploads(reason: "interrupted"): void {
    for (const uploadId of this.#pendingUploads.keys()) {
      this.#emitAttachRejected({ upload_id: uploadId, reason });
    }
    this.#pendingUploads.clear();
  }

  /** An interrupt drops not-yet-started image turns too: their local_image
   * paths must never outlive the cancelled instruction (ADR-0025 F3/F11). */
  async #dropQueuedTempTurns(): Promise<void> {
    const retained: Array<{
      input: string | Array<{ type: "text"; text: string } | { type: "local_image"; path: string }>;
      tempDir?: string;
      conversationIds?: readonly string[];
      turnToken?: string;
    }> = [];
    for (const turn of this.#queue) {
      if (turn.tempDir === undefined) {
        retained.push(turn);
      } else {
        await this.#cleanupTempDir(turn.tempDir);
      }
    }
    this.#queue.length = 0;
    this.#queue.push(...retained);
  }

  async #cleanupWatchdogQueuedTurns(
    turns: ReadonlyArray<{ tempDir?: string }>,
  ): Promise<void> {
    for (const turn of turns) {
      if (turn.tempDir !== undefined) await this.#cleanupTempDir(turn.tempDir);
    }
  }

  async #cleanupTempDir(dir: string): Promise<void> {
    await cleanupLocalImages(dir, this.#warn);
    this.#activeTempDirs.delete(dir);
  }

  #warn = (message: string): void => {
    process.stderr.write(`${message}\n`);
  };

  #emitAttachRejected(payload: AttachRejectedPayload): void {
    this.#options.onAttachRejected?.(
      makeAttachRejected(this.#config, this.#machine.state, this.#now(), payload),
    );
  }

  #emitInstructionRejected(payload: InstructionRejectedPayload): void {
    this.#options.onInstructionRejected?.(
      makeInstructionRejected(this.#config, this.#machine.state, this.#now(), payload),
    );
  }

  #finishTurn(
    success: boolean,
    attempted: {
      model: string | null;
      effort: string | null;
      effortReset: boolean;
      accountDefault: boolean;
      resolutionGeneration: number;
    },
  ): void {
    if (success) {
      if (attempted.model !== null) {
        this.#model = attempted.model;
        this.#modelSource = "config";
        this.#operatorSwitchedFields.add("model");
        this.#operatorSwitchedFields.add("model_source");
      } else if (attempted.accountDefault) {
        // Never retain the previous turn's account-default model when this
        // turn could not be resolved. Absence is the explicit "unknown"
        // state consumed by whoami and AgentDetail's 確認待ち transition.
        this.#model = null;
        this.#modelSource = null;
      }
      if (attempted.effort !== null) {
        this.#effort = attempted.effort;
        this.#effortSource = "config";
        this.#operatorSwitchedFields.add("effort");
        this.#operatorSwitchedFields.add("effort_source");
      } else if (attempted.effortReset) {
        const model = attempted.model ?? this.#model;
        this.#effort =
          this.#catalog.find((entry) => entry.value === model)
            ?.default_effort ?? null;
        this.#effortSource = "default";
        this.#operatorSwitchedFields.add("effort");
        this.#operatorSwitchedFields.add("effort_source");
      }
      this.#modelLastGood = this.#model;
      this.#modelLastGoodSource = this.#modelSource;
      this.#effortLastGood = this.#effort;
      this.#effortLastGoodSource = this.#effortSource;
      if (attempted.model !== null) this.#modelRollbackPinned = false;
      if (this.#modelPending === attempted.model) this.#modelPending = null;
      if (this.#effortPending === attempted.effort) this.#effortPending = null;
      if (this.#effortResetPending === attempted.effortReset) {
        this.#effortResetPending = false;
      }
      this.#switchErrorOnce = null;
      return;
    }

    const kind = attempted.model !== null ? "model" : "effort";
    const requested = attempted.model ?? attempted.effort;
    if (requested !== null) {
      const rolledBackTo =
        kind === "model" ? this.#modelLastGood : this.#effortLastGood;
      this.#switchErrorOnce = {
        kind,
        requested,
        reason: "turn_failed",
        ...(rolledBackTo === null ? {} : { rolled_back_to: rolledBackTo }),
      };
    }
    if (requested !== null) {
      this.#model = this.#modelLastGood;
      this.#modelSource = this.#modelLastGoodSource;
      this.#effort = this.#effortLastGood;
      this.#effortSource = this.#effortLastGoodSource;
      if (attempted.model !== null && this.#modelLastGood !== null) {
        this.#modelRollbackPinned = true;
      }
    }
    if (this.#modelPending === attempted.model) this.#modelPending = null;
    if (this.#effortPending === attempted.effort) this.#effortPending = null;
    if (this.#effortResetPending === attempted.effortReset) {
      this.#effortResetPending = false;
    }
  }

  async #refreshAccountDefaultModel(
    sessionId: string,
    generation: number,
  ): Promise<void> {
    const resolver = this.#options.modelResolver ?? resolveCodexModel;
    let model: string | null = null;
    for (let attempt = 0; attempt < 2 && model === null; attempt += 1) {
      try {
        model = await resolver(sessionId);
      } catch {
        // Unknown was already stamped at terminal delivery. A resolver
        // failure must not become an unhandled rejection or disturb the next
        // turn. Retry once; the default resolver also handles its inner
        // filesystem write race.
        model = null;
      }
      if (model === null && attempt === 0) await Promise.resolve();
    }
    if (
      model === null ||
      this.#closed ||
      generation !== this.#modelResolutionGeneration
    ) {
      return;
    }
    this.#model = model;
    this.#modelSource = "default";
    this.#modelLastGood = model;
    this.#modelLastGoodSource = "default";
    this.#emitState(this.#machine.state);
  }

  /** Refreshes #rateLimits from the rollout tail after a session becomes known
   *  and after a terminal ThreadEvent.
   *  Codex has no in-stream rate_limit event (unlike Claude's SDKRateLimitEvent),
   *  so this reads the JSONL the SDK's own `codex exec` subprocess writes.
   *  Fire-and-forget from the run loop; coalesces concurrent refreshes so a
   *  slow tail cannot pile up work. Emits a state_change only when the
   *  snapshot actually changes, matching #refreshAccountDefaultModel's
   *  eventual-consistency contract. */
  async #refreshRateLimits(): Promise<void> {
    if (this.#closed) return;
    if (this.#sessionId === null) return;
    if (this.#rateLimitsInflight) return;
    this.#rateLimitsInflight = true;
    const sessionId = this.#sessionId;
    try {
      const resolver =
        this.#options.rateLimitResolver ??
        ((id: string) =>
          Promise.resolve(codexRateLimitsFromRolloutIn(codexRolloutsRoot(), id)));
      let next: Map<CodexRateLimitWindow, CodexRateLimitSnapshot>;
      try {
        next = await resolver(sessionId);
      } catch {
        // Rollout tail I/O errors are optional telemetry — never disturb the
        // next turn. Absence stays absent.
        return;
      }
      if (this.#closed) return;
      if (!rateLimitsDiffer(this.#rateLimits, next)) return;
      this.#rateLimits.clear();
      for (const [window, snapshot] of next) {
        this.#rateLimits.set(window, snapshot);
      }
      this.#emitState(this.#machine.state);
    } finally {
      this.#rateLimitsInflight = false;
    }
  }

  #apply(event: AdapterEvent): void {
    const { next, emitted } = stepState(this.#machine, event);
    this.#machine = next;
    for (const state of emitted) {
      this.#emitState(state);
    }
  }

  #emitState(state: KaoiroState): void {
    this.#options.onState(
      makeStateChange(
        this.#config,
        state,
        this.#now(),
        {},
        this.#statusExt(true),
      ),
    );
  }

  /** Non-consuming ext snapshot for the CLI's synthetic initial idle. */
  statusExtSnapshot(): Record<string, unknown> {
    return this.#statusExt(false);
  }

  #statusExt(consumeOneShot = false): Record<string, unknown> {
    const effectiveStatus = this.#effectiveStatusSnapshot();
    const ext: Record<string, unknown> = {
      ...initialStatusExtFromCatalog(this.#catalog, this.#model),
      ...effectiveStatusEnvelopeFields(effectiveStatus),
    };
    // Effective resolved settings this run (ADR-0014 F1 追補, phase-15 D8).
    // Rides every state_change so the D8 drift audit and any downstream
    // consumer sees "what am I enforcing right now". resume_snapshot /
    // resume_drift only appear when a resume relayed a snapshot.
    if (this.#resumeSnapshot !== null) {
      ext.resume_snapshot = this.#resumeSnapshot;
      ext.resume_drift = computeResumeDrift(
        this.#resumeSnapshot,
        effectiveStatus.resolved,
      ).filter((entry) => !this.#operatorSwitchedFields.has(entry.field));
    }
    // Session capabilities (ADR-0034 F1/F4, #112): advertised
    // from the first state_change onward (adapter-static values, no
    // thread.started await — that event fires only once a turn runs,
    // so an idle-wait agent would stay "not yet reported"). Codex accepts
    // image attachments only; SDK-specific local_image path mapping remains
    // inside this adapter. The MCP bridge exposes ask_user_question.
    // supports_model_switch /
    // supports_effort_switch are reserved for phase-16 (ADR-0035 F4).
    // supports_session_reset (ADR-0036 F5, phase-17 17-6 flip): the
    // Codex adapter now supports the F2 fresh-relaunch handshake, which
    // uses `startThread()` (not `resumeThread()`) after the runner's
    // kill + fresh spawn. Both modes ride the same runner path — the
    // display projection differences (`new` keeps log / `clear` resets)
    // are the server's AgentStates concern (chunk δ 17-7), not the
    // adapter's. Codex's thread ID is lazy: the fresh session's ID is
    // not established at `startThread()` time, so the runner reports
    // `to_session_id=null` and the server's `session_reset_completed`
    // broadcast rides that null; the ordinary envelope ingest path
    // stamps the pointer once the first turn produces one.
    if (this.#modelPending !== null) {
      ext.pending_model = this.#modelPending;
    }
    if (this.#effortPending !== null) {
      ext.pending_effort = this.#effortPending;
    }
    if (this.#effortResetOnce) {
      ext.effort_reset = true;
      if (consumeOneShot) this.#effortResetOnce = false;
    }
    if (this.#switchErrorOnce !== null) {
      ext.switch_error = this.#switchErrorOnce;
      if (consumeOneShot) this.#switchErrorOnce = null;
    }
    ext.cwd = this.#cwd;
    // Only publish a model catalog when one exists (currently empty for
    // codex — the account default is used, see catalog.ts).
    if (this.#catalog.length > 0) ext.models = this.#catalog;
    if (this.#rateLimits.size > 0) {
      ext.rate_limits = Object.fromEntries(this.#rateLimits);
    }
    if (this.#pendingPermission !== null) {
      ext.pending_permission = this.#pendingPermission;
    }
    if (this.#pendingQuestion !== null) {
      ext.pending_question = this.#pendingQuestion;
    }
    return ext;
  }

  #emitLog(entry: LogEntry): void {
    if (this.#options.onLog === undefined) return;
    // logEntryToPayload owns clipping and the tool_use -> tool_result name
    // backfill via the shared map (protocol.md #40).
    const payload = logEntryToPayload(entry, this.#toolNames);
    this.#options.onLog(
      makeLog(this.#config, this.#machine.state, this.#now(), payload),
    );
  }

  /** Sends a changed whole-list snapshot immediately. Unlike child-task
   * progress, todo changes have no later token/tool signal that could flush a
   * throttle-suppressed update, so only an exact content duplicate is skipped. */
  #emitTasklist(sourceItems: readonly TasklistSourceItem[]): void {
    const snapshot = normalizeTasklist(sourceItems);
    const encoded = JSON.stringify(snapshot);
    if (encoded === this.#lastTasklistJson) return;
    this.#lastTasklistJson = encoded;

    const onTask = this.#options.onTask;
    if (onTask === undefined) return;
    const payload: Omit<TaskPayload, "agent_id"> = {
      kind: "updated",
      task_id: TASKLIST_TASK_ID,
      task_type: "tasklist",
      status: "running",
      items: snapshot.items,
      ...(snapshot.omitted !== undefined ? { omitted: snapshot.omitted } : {}),
    };
    onTask(makeTask(this.#config, this.#machine.state, this.#now(), payload));
  }

  #emitResult(payload: {
    text?: string;
    is_error?: boolean;
    // issue #263: SDK-agnostic result fields (ResultPayload, issue #127) —
    // Claude's adapter fills these from the SDK's own subtype/errors; Codex
    // has no SDK-native equivalent, so this host sets error_subtype only for
    // its own rollout-corruption classification (see #runTurn's catch(err)).
    error_subtype?: string;
    error_detail?: string;
  }): void {
    const clipped: {
      text?: string;
      is_error?: boolean;
      error_subtype?: string;
      error_detail?: string;
    } = { ...payload };
    if (clipped.text !== undefined) {
      const { text, truncated } = clipText(clipped.text);
      clipped.text = text;
      if (truncated) {
        // Match the log-payload truncation convention: clip, no marker field
        // on result (protocol.md result payload has no truncated flag).
      }
    }
    if (clipped.error_detail !== undefined) {
      // Same envelope-size discipline claude-code's #emitResult applies to
      // this field (host.ts:2870 there) — untrusted, unbounded subprocess
      // text must not ride the wire raw.
      clipped.error_detail = clipText(clipped.error_detail).text;
    }
    this.#options.onLog?.(
      makeResult(this.#config, this.#now(), clipped, this.#statusExt()),
    );
  }
}
