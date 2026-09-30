import { redactCredentials, writeRedactedStderr, type WrapperConfig } from "@kaoiro/agent-common";
import { readAppServerHistory, type AppServerHistory } from "./app_server_history.js";
import {
  AppServerConnectionError, AppServerRpc, AppServerRpcError, rpcObject, serverRequestKey,
  type AppServerNotification, type AppServerRpcOptions, type AppServerServerRequest, type RpcObject, type RpcTicket,
} from "./app_server_rpc.js";
import {
  ApprovalRouter, createApprovalOwner, isApprovalPolicy,
  type ApprovalDecide, type ApprovalOwner, type ApprovalPolicy, type ApprovalTransition,
} from "./app_server_approval.js";
import { appServerInput, type AppServerInput } from "./app_server_input.js";
import { AppServerTurnStream } from "./app_server_stream.js";
import type { SteerResponse } from "./app_server_steer.js";
import { AppServerAccountTelemetry, type AppServerRateLimits } from "./app_server_telemetry.js";

import { appServerTurnSettings, type AppServerTurnSettings, type AppServerPreparedSettings, type AppServerSettingsSnapshot } from "./app_server_settings.js";

export interface AppServerThreadOptions {
  config?: RpcObject;
  cwd?: string;
  model?: string;
  developerInstructions?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
}

export interface AppServerTurnInput {
  threadId: string;
  hostTurnToken: string;
  input: AppServerInput;
  clientUserMessageId?: string;
  settings?: AppServerTurnSettings;
  beforeDispatch?: (settings: AppServerPreparedSettings) => Promise<void>;
  /** Synchronous admission and input preparation immediately before turn/start.
   * Returning an input replaces the queued value; throwing sends no turn. */
  onDispatch?: (identity: AppServerDispatchIdentity, settings: AppServerPreparedSettings) => string | void;
}

export type AppServerDispatchIdentity = Pick<AppServerTurnIdentity, "threadId" | "hostTurnToken" | "clientUserMessageId">;

export interface AppServerTurnIdentity {
  readonly threadId: string;
  readonly turnId: string;
  readonly hostTurnToken: string;
  readonly requestId: number;
  readonly clientUserMessageId?: string;
}

export interface AppServerTurn {
  identity: AppServerTurnIdentity;
  events: AsyncIterable<AppServerNotification>;
}

export interface AppServerSteerRequest {
  hostTurnToken: string;
  input: AppServerInput;
  clientUserMessageId: string;
  /** Runs in the same synchronous section as the request write, after the
   * active-turn snapshot. Returning a reason sends nothing. */
  admit: (turnId: string) => string | null;
}

export type AppServerSteerAttempt =
  | { kind: "refused"; reason: "idle" | "closed" | "foreign_turn" }
  | { kind: "starting"; ready: Promise<void> }
  | { kind: "declined"; reason: string }
  | { kind: "sent"; turnId: string; requestId: number; response: Promise<SteerResponse> };

export interface AppServerForeignTurn { threadId: string; turnId: string }

/** A turn/start that was possibly delivered but got no valid reply, so the app-server may have run the turn. */
export class AppServerTurnStartUnknownError extends AppServerConnectionError {
  readonly reason: "turn_start_timeout" | "turn_start_invalid_response" | "turn_start_disconnected";
  constructor(readonly original: AppServerConnectionError) {
    super(original.message, original.kind);
    // String(error) feeds the failure classifier; keep it equal to the original's.
    this.name = original.name;
    this.reason = original.kind === "timeout" ? "turn_start_timeout"
      : original.kind === "invalid_response" ? "turn_start_invalid_response" : "turn_start_disconnected";
  }
}

export class AppServerForeignTurnError extends Error {
  constructor() {
    super("App-server thread has a turn this host did not start; new turns are stopped pending operator recovery");
    this.name = "AppServerForeignTurnError";
  }
}

// Only a turn start or a turn item shows that a turn is running. Thread-level
// notifications (token usage, goals, status, compaction) carry past turn IDs
// after a resume, measured on 0.156.1 for `thread/tokenUsage/updated`.
function isTurnEvidence(event: AppServerNotification): boolean {
  return event.method === "turn/started" || event.method.startsWith("item/");
}

const MAX_OWN_TURN_IDS = 256;
// Notifications buffered while turn/start is unanswered. The buffer is the
// source of the owner's terminal fact, so overflow fails the connection
// instead of evicting.
const MAX_BEFORE_RESPONSE = 4_096;
const MAX_FILE_CHANGE_SNAPSHOTS = 256;

/** Operator approval of app-server requests (ADR-0064). Absent = disabled. */
export interface AppServerApprovalOptions {
  decide: ApprovalDecide;
  /** Per-request deadline; null = none (ADR-0022 F6). */
  deadlineMs: number | null;
  inactivityLimitMs?: number;
  onTransition?: (transition: ApprovalTransition) => void;
}

type ReservationEnding = { kind: "named"; turnId: string } | { kind: "unnamed" } | { kind: "failed" };

// A cold CODEX_HOME (first start, or the first start after a CLI update that
// migrates the state schema) can make one app-server child fail to open its
// sqlite state while another wrapper is creating it. The child exits quickly
// with this line; the failure is transient in the measured cases.
const SQLITE_INIT_SIGNATURE = "failed to initialize sqlite state runtime";
const INITIALIZE_MAX_ATTEMPTS = 3;
// Delay range (ms) before the 2nd and the 3rd attempt.
const INITIALIZE_RETRY_DELAY_MS: ReadonlyArray<readonly [number, number]> = [[100, 400], [400, 1600]];

function sqliteSignatureLine(stderr: string): string | undefined {
  const lines = stderr.split("\n").filter(line => line.includes(SQLITE_INIT_SIGNATURE));
  const line = lines[lines.length - 1]?.trim();
  return line === undefined ? undefined : redactCredentials(line).slice(0, 300);
}

/** Failure handling of one spawned child while `initialize` is unanswered. */
interface InitializeAttempt { failure?: Error; promoted: boolean }

function notificationTurnId(event: AppServerNotification): string | undefined {
  const nested = event.params.turn;
  const turnId = event.params.turnId ?? (rpcObject(nested) ? nested.id : undefined);
  return typeof turnId === "string" ? turnId : undefined;
}

// The two expected-turn rejections carry no error data (measured on 0.156.1,
// issue #366 probe L0); non-steerable turns carry codexErrorInfo (probe L4).
function classifySteerError(error: unknown): SteerResponse {
  if (!(error instanceof AppServerRpcError)) return { kind: "C" };
  const info = rpcObject(error.data) ? error.data.codexErrorInfo : undefined;
  const notSteerable = rpcObject(info) ? info.activeTurnNotSteerable : undefined;
  if (rpcObject(notSteerable) && typeof notSteerable.turnKind === "string") {
    return { kind: "P", reason: `not_steerable:${notSteerable.turnKind}` };
  }
  if (error.code === -32600 && (error.message.startsWith("expected active turn id ") || error.message === "no active turn to steer")) {
    return { kind: "P", reason: "turn_changed" };
  }
  return { kind: "E", code: error.code, message: error.message };
}

interface ActiveTurn {
  threadId: string;
  hostTurnToken: string;
  ready: Promise<void>;
  interrupt?: Promise<boolean>;
  stream: AppServerTurnStream;
  beforeResponse: AppServerNotification[];
  /** Turn evidence (notifications and item/* requests) awaiting the window end. */
  evidence: Array<{ threadId: string; turnId: string }>;
  owner: ApprovalOwner;
  windowEnded: boolean;
  turnId?: string;
  failure?: Error;
}

export class AppServerTransport {
  #rpc: AppServerRpc;
  #attempt: InitializeAttempt = { promoted: false };
  #wakeRetry: (() => void) | undefined;
  readonly #options: Omit<AppServerRpcOptions, "onNotification" | "onFailure" | "onServerRequest"> & { onDisconnect?: (error: Error) => void };
  readonly #approvals: ApprovalRouter;
  readonly #maxBeforeResponse: number;
  #generation = 0;
  readonly #threadOpenTimeoutMs: number | undefined;
  #initializing: Promise<void> | undefined;
  #active: ActiveTurn | undefined;
  #failure: Error | undefined;
  #version: string | undefined;
  #initialSettings: AppServerSettingsSnapshot | null = null;
  readonly #disconnected = new AbortController();
  #closing = false;
  #opening = false;
  #readingHistory = false;
  readonly #account = new AppServerAccountTelemetry();
  #boundThreadId: string | undefined;
  readonly #ownTurnIds = new Set<string>();
  #foreign: AppServerForeignTurn | undefined;
  readonly #enforceForeignTurn: boolean;
  readonly #onForeignTurn: ((turn: AppServerForeignTurn) => void) | undefined;

  constructor(options: Omit<AppServerRpcOptions, "onNotification" | "onFailure" | "onServerRequest"> & {
    threadOpenTimeoutMs?: number; onDisconnect?: (error: Error) => void;
    onForeignTurn?: (turn: AppServerForeignTurn) => void; enforceForeignTurn?: boolean;
    approvals?: AppServerApprovalOptions; maxBeforeResponse?: number;
  } = {}) {
    this.#threadOpenTimeoutMs = options.threadOpenTimeoutMs;
    this.#enforceForeignTurn = options.enforceForeignTurn ?? false;
    this.#onForeignTurn = options.onForeignTurn;
    this.#maxBeforeResponse = options.maxBeforeResponse ?? MAX_BEFORE_RESPONSE;
    const { approvals, maxBeforeResponse: _max, ...rest } = options;
    this.#options = rest;
    // Installed with or without the opt-in: the gate, not the hook, keeps a
    // non-opted-in persona at today's -32601.
    this.#approvals = new ApprovalRouter({
      enabled: approvals !== undefined,
      ...(approvals === undefined ? {} : {
        decide: approvals.decide, deadlineMs: approvals.deadlineMs,
        ...(approvals.inactivityLimitMs === undefined ? {} : { inactivityLimitMs: approvals.inactivityLimitMs }),
        ...(approvals.onTransition === undefined ? {} : { onTransition: approvals.onTransition }),
      }),
      ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
    });
    this.#rpc = this.#spawn();
  }

  // Until `initialize` succeeds a child's failure belongs to its attempt, not
  // to the transport: a discarded child must not disconnect the transport.
  #spawn(): AppServerRpc {
    const attempt: InitializeAttempt = { promoted: false };
    // Request ids restart with each child, so keys carry the child's generation.
    const generation = ++this.#generation;
    const rpc: AppServerRpc = new AppServerRpc({
      ...this.#options,
      onNotification: (event) => this.#notification(event, rpc, generation),
      onServerRequest: (request) => this.#serverRequest(request, rpc, generation),
      onFailure: (error) => {
        this.#approvals.fail({ channel: rpc });
        if (attempt.promoted) this.#rpcFailed(error);
        else attempt.failure ??= error;
      },
    });
    this.#attempt = attempt;
    return rpc;
  }

  #rpcFailed(error: Error): void {
    const first = this.#failure === undefined;
    this.#failure ??= error;
    this.#disconnected.abort(error);
    this.#approvals.fail();
    if (this.#active) {
      this.#active.failure ??= error;
      if (this.#active.turnId !== undefined) this.#active.stream.fail(error);
    }
    if (first && !this.#closing) this.#options.onDisconnect?.(error);
  }

  get initialSettings(): AppServerSettingsSnapshot | null { return this.#initialSettings && { ...this.#initialSettings }; }
  get version(): string | undefined { return this.#version; }
  get stderrTail(): string { return this.#rpc.stderrTail; }
  get rateLimits(): AppServerRateLimits { return this.#account.snapshot; }
  get foreignTurn(): AppServerForeignTurn | undefined { return this.#foreign && { ...this.#foreign }; }

  async readRateLimits(): Promise<AppServerRateLimits> {
    await this.#initialize();
    const token = this.#account.beginRead();
    try {
      this.#account.finishRead(token, await this.#rpc.request("account/rateLimits/read", {}).result);
    } catch (error) {
      if (!(error instanceof AppServerRpcError)) throw error;
      this.#account.finishRead(token, null);
    }
    return this.rateLimits;
  }

  async readHistory(threadId: string, config: WrapperConfig, now: () => string): Promise<AppServerHistory> {
    if (this.#failure) throw this.#failure;
    if (this.#active || this.#opening || this.#readingHistory) throw new Error("Cannot read history during an active operation");
    this.#readingHistory = true;
    try {
      await this.#initialize();
      return await readAppServerHistory((method, params) => this.#rpc.request(method, params).result, threadId, config, now);
    } finally {
      this.#readingHistory = false;
    }
  }

  async startThread(options: AppServerThreadOptions = {}): Promise<string> {
    return this.#openThread("thread/start", { ...options });
  }

  async resumeThread(threadId: string, options: AppServerThreadOptions = {}): Promise<string> {
    return this.#openThread("thread/resume", { ...options, threadId, excludeTurns: true });
  }

  async startTurn(input: AppServerTurnInput): Promise<AppServerTurn> {
    if (this.#failure) throw this.#failure;
    if (this.#foreign && this.#enforceForeignTurn) throw new AppServerForeignTurnError();
    if (this.#active || this.#opening || this.#readingHistory) throw new Error("App-server already has an active or submitting operation");
    // Invalid images must fail before reserving an operation or initializing RPC.
    if (typeof input.input !== "string") appServerInput(input.input);
    const dispatch: AppServerDispatchIdentity = {
      threadId: input.threadId, hostTurnToken: input.hostTurnToken,
      ...(input.clientUserMessageId === undefined ? {} : { clientUserMessageId: input.clientUserMessageId }),
    };
    let release!: () => void;
    const active: ActiveTurn = { ...dispatch, stream: new AppServerTurnStream(), beforeResponse: [],
      evidence: [], owner: createApprovalOwner(dispatch.threadId), windowEnded: false,
      ready: new Promise<void>(resolve => { release = resolve; }) };
    // Reserve before initialize/request awaits; overlapping calls must never become implicit steering.
    this.#active = active;
    let ticket: RpcTicket | undefined;
    try {
      await this.#initialize();
      const settings = await appServerTurnSettings(input.settings ?? {}, (method, params) => this.#rpc.request(method, params).result);
      const prepared: AppServerPreparedSettings = Object.freeze({
        ...(typeof settings.model === "string" ? { model: settings.model } : {}),
        ...(typeof settings.effort === "string" ? { effort: settings.effort } : {}),
      });
      if (input.beforeDispatch) await this.#beforeDispatch(() => input.beforeDispatch!(prepared));
      if (this.#failure) throw this.#failure;
      const preparedInput = input.onDispatch?.(dispatch, prepared);
      const wireInput = appServerInput(preparedInput ?? input.input);
      const approvalPolicy = this.#approvalPolicy(input.settings);
      active.owner.approvalPolicy = approvalPolicy;
      ticket = this.#rpc.request("turn/start", {
        ...settings, threadId: dispatch.threadId,
        input: wireInput,
        ...(dispatch.clientUserMessageId === undefined ? {} : { clientUserMessageId: dispatch.clientUserMessageId }),
        approvalPolicy, approvalsReviewer: "user",
      });
      const result = await ticket.result;
      if (!rpcObject(result) || !rpcObject(result.turn) || typeof result.turn.id !== "string") {
        throw new AppServerConnectionError("Invalid turn/start response", "invalid_response");
      }
      active.turnId = result.turn.id;
      this.#ownTurnIds.add(active.turnId);
      if (this.#ownTurnIds.size > MAX_OWN_TURN_IDS) this.#ownTurnIds.delete(this.#ownTurnIds.values().next().value!);
      this.#endReservation(active, { kind: "named", turnId: active.turnId });
      for (const event of active.beforeResponse) this.#deliver(active, event);
      active.beforeResponse = [];
      if (active.failure) active.stream.fail(active.failure);
      return {
        identity: {
          ...dispatch, turnId: active.turnId, requestId: ticket.id,
        },
        events: active.stream,
      };
    } catch (error) {
      if (!active.windowEnded) {
        this.#endReservation(active, error instanceof AppServerConnectionError || this.#failure !== undefined
          ? { kind: "failed" } : { kind: "unnamed" });
      }
      if (this.#active === active) this.#active = undefined;
      if (error instanceof AppServerConnectionError) {
        this.#failure = error;
        await this.#rpc.close();
        // Read after the child has closed: bytes still buffered when a timeout
        // ended stdin can reach the child, so only then is the state final.
        const written = ticket?.writeState();
        if (written === "writing" || written === "written") throw new AppServerTurnStartUnknownError(error);
      }
      throw error;
    } finally {
      if (!active.windowEnded) this.#endReservation(active, { kind: "unnamed" });
      release();
    }
  }

  /** The single exit of the unresolved-start window: judges every deferred
   * turn evidence item, folds a buffered owner terminal, then settles the
   * owner's held approval requests. A named start keeps the active turn;
   * only an unnamed or failed start releases it here. */
  #endReservation(active: ActiveTurn, ending: ReservationEnding): void {
    if (active.windowEnded) throw new Error("App-server reservation window ended twice");
    active.windowEnded = true;
    const named = ending.kind === "named" ? ending.turnId : undefined;
    for (const { threadId, turnId } of active.evidence) {
      if (turnId !== named && !this.#ownTurnIds.has(turnId)) this.#foreignTurn(threadId, turnId);
    }
    active.evidence = [];
    const owner = active.owner;
    if (named !== undefined) {
      // The buffer holds only this thread's notifications (#notification).
      if (active.beforeResponse.some(event => event.method === "turn/completed" &&
          notificationTurnId(event) === named)) owner.terminal = true;
      owner.start = { kind: "started", turnId: named };
      this.#approvals.start(owner, this.#boundThreadId);
      return;
    }
    owner.start = { kind: "failed" };
    if (ending.kind === "failed") this.#approvals.fail({ owner });
    else this.#approvals.start(owner, this.#boundThreadId);
    if (this.#active === active) this.#active = undefined;
  }

  #approvalPolicy(settings: AppServerTurnSettings | undefined): ApprovalPolicy {
    const requested = settings?.permission?.approval;
    return this.#approvals.enabled && isApprovalPolicy(requested) ? requested : "never";
  }

  /** Synchronous: the host calls it before aborting the turn, so no approval
   * request of that turn can reach, or stay in front of, the operator. */
  abortApprovals(hostTurnToken: string): void {
    const active = this.#active;
    if (!active || active.hostTurnToken !== hostTurnToken || active.owner.aborted) return;
    active.owner.aborted = true;
    this.#approvals.abort(active.owner);
  }

  async #beforeDispatch(prepare: () => Promise<void>): Promise<void> {
    if (this.#failure) throw this.#failure;
    let abort!: () => void;
    const disconnected = new Promise<never>((_, reject) => {
      abort = () => reject(this.#failure);
      this.#disconnected.signal.addEventListener("abort", abort, { once: true });
    });
    try { await Promise.race([disconnected, prepare()]); }
    finally { this.#disconnected.signal.removeEventListener("abort", abort); }
  }

  /** Synchronous: the snapshot, `admit`, and the request write share one
   * section, so no state change can land between the check and the write. */
  steer(request: AppServerSteerRequest): AppServerSteerAttempt {
    if (this.#failure || this.#closing) return { kind: "refused", reason: "closed" };
    if (this.#foreign && this.#enforceForeignTurn) return { kind: "refused", reason: "foreign_turn" };
    const active = this.#active;
    if (!active || active.hostTurnToken !== request.hostTurnToken) return { kind: "refused", reason: "idle" };
    if (active.turnId === undefined) return { kind: "starting", ready: active.ready };
    const turnId = active.turnId;
    const wireInput = appServerInput(request.input);
    const reason = request.admit(turnId);
    if (reason !== null) return { kind: "declined", reason };
    const ticket = this.#rpc.request("turn/steer", {
      threadId: active.threadId, expectedTurnId: turnId, input: wireInput,
      clientUserMessageId: request.clientUserMessageId,
    });
    const response = ticket.result.then((result): SteerResponse => {
      if (rpcObject(result) && result.turnId === turnId) return { kind: "A" };
      return { kind: "V", turnId: rpcObject(result) && typeof result.turnId === "string" ? result.turnId : "" };
    }, classifySteerError);
    return { kind: "sent", turnId, requestId: ticket.id, response };
  }

  interrupt(hostTurnToken: string): Promise<boolean> {
    const active = this.#active;
    if (!active || active.hostTurnToken !== hostTurnToken) return Promise.resolve(false);
    active.interrupt ??= (async () => {
      await active.ready;
      // A buffered terminal may have retired this turn before its start reply.
      if (this.#active !== active || active.turnId === undefined) return false;
      await this.#rpc.request("turn/interrupt", { threadId: active.threadId, turnId: active.turnId }).result;
      return true;
    })();
    return active.interrupt;
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#wakeRetry?.();
    await this.#rpc.close();
  }

  async #initialize(): Promise<void> {
    this.#initializing ??= this.#connect();
    await this.#initializing;
  }

  async #connect(): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      const rpc = this.#rpc;
      const state = this.#attempt;
      let error: unknown;
      try {
        await this.#handshake(rpc, state);
        return;
      } catch (caught) {
        error = caught;
      }
      // The rpc failed by itself (as opposed to a rejection raised here) when
      // its failure is already recorded.
      const causal = state.failure;
      await rpc.close();
      // Only after the child has closed is stderr complete: stdout can end
      // before the last stderr bytes arrive.
      // A JSON-RPC reply is a real answer; a timed-out attempt may still have a
      // live child and is never retried, whatever its stderr says.
      const answered = error instanceof AppServerRpcError;
      const timedOut = error instanceof AppServerConnectionError && error.kind === "timeout";
      const line = answered || timedOut ? undefined : sqliteSignatureLine(rpc.stderrTail);
      if (line === undefined || this.#closing || attempt >= INITIALIZE_MAX_ATTEMPTS) {
        const failure = error instanceof AppServerConnectionError && line !== undefined
          ? new AppServerConnectionError(`${error.message} (initialize attempt ${attempt}/${INITIALIZE_MAX_ATTEMPTS}: ${line})`, error.kind)
          : error instanceof Error ? error : new AppServerConnectionError("App-server initialization failed");
        throw this.#giveUp(failure, causal);
      }
      const [min, max] = INITIALIZE_RETRY_DELAY_MS[attempt - 1]!;
      const delay = Math.round(min + Math.random() * (max - min));
      const message = writeRedactedStderr(
        `codex: app-server initialize failed (attempt ${attempt}/${INITIALIZE_MAX_ATTEMPTS}), retrying in ${delay} ms: ${line}\n`,
      );
      this.#options.onDiagnostic?.(message);
      await this.#wait(delay);
      if (this.#closing) throw this.#giveUp(new AppServerConnectionError("App-server closed by client"), undefined);
      try {
        this.#rpc = this.#spawn();
      } catch (spawnError) {
        throw this.#giveUp(spawnError instanceof Error ? spawnError : new AppServerConnectionError("App-server spawn failed"), undefined);
      }
    }
  }

  async #handshake(rpc: AppServerRpc, state: InitializeAttempt): Promise<void> {
    const result = await rpc.request("initialize", {
      clientInfo: { name: "kaoiro", version: "0" },
      capabilities: { experimentalApi: false },
    }).result;
    if (!rpcObject(result)) throw new AppServerConnectionError("Invalid initialize response");
    const serverInfo = result.serverInfo;
    if (rpcObject(serverInfo) && typeof serverInfo.version === "string") {
      this.#version = serverInfo.version;
    } else if (typeof result.userAgent === "string") {
      this.#version = result.userAgent.match(/^[^/]+\/([^ ]+)/)?.[1];
    }
    state.promoted = true;
    rpc.notify("initialized");
  }

  /** Records the final failure the way a failed rpc always did: the transport
   * disconnects once, and only when the rpc failed by itself. */
  #giveUp(failure: Error, causal: Error | undefined): Error {
    if (causal === undefined) this.#failure = failure;
    this.#rpcFailed(failure);
    this.#failure = failure;
    return failure;
  }

  #wait(ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer);
        this.#wakeRetry = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.#wakeRetry = done;
    });
  }

  async #openThread(method: string, params: RpcObject): Promise<string> {
    if (this.#active || this.#opening || this.#readingHistory) throw new Error("Cannot change threads during an active operation");
    this.#opening = true;
    try {
      await this.#initialize();
      const result = await this.#rpc.request(method, {
        ...params, approvalPolicy: "never", approvalsReviewer: "user",
      }, this.#threadOpenTimeoutMs).result;
      if (!rpcObject(result) || !rpcObject(result.thread) || typeof result.thread.id !== "string") {
        this.#failure = new AppServerConnectionError(`Invalid ${method} response`);
        await this.#rpc.close();
        throw this.#failure;
      }
      this.#boundThreadId = result.thread.id;
      this.#initialSettings = typeof result.model === "string" &&
        (result.reasoningEffort === null || typeof result.reasoningEffort === "string")
        ? { model: result.model, effort: result.reasoningEffort } : null;
      return result.thread.id;
    } finally {
      this.#opening = false;
    }
  }

  #notification(event: AppServerNotification, rpc: AppServerRpc, generation: number): void {
    if (event.method === "account/rateLimits/updated") {
      this.#account.update(event.params.rateLimits);
      return;
    }
    if (event.method === "serverRequest/resolved") {
      const requestId = event.params.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") {
        this.#approvals.resolved(`${generation}:${serverRequestKey(requestId)}`);
      }
    }
    const active = this.#active;
    const turnId = notificationTurnId(event);
    if (turnId !== undefined && isTurnEvidence(event) && typeof event.params.threadId === "string") {
      this.#turnEvidence(event.params.threadId, turnId);
    }
    if (!active || event.params.threadId !== active.threadId) return;
    this.#fileChangeSnapshot(active, event);
    if (active.turnId === undefined) {
      if (active.beforeResponse.length >= this.#maxBeforeResponse) {
        rpc.failProtocol("App-server sent too many notifications before the turn/start response");
        return;
      }
      active.beforeResponse.push(event);
    } else this.#deliver(active, event);
  }

  /** The issue #366 predicate, for notifications and item/* requests alike.
   * A reserved turn without its start response is judged when its window
   * ends; late items of this host's own completed turns are known. */
  #turnEvidence(threadId: string, turnId: string): void {
    if (threadId !== this.#boundThreadId) return;
    const active = this.#active;
    if (active && active.turnId === undefined) {
      if (threadId === active.threadId) active.evidence.push({ threadId, turnId });
      return;
    }
    if (turnId !== active?.turnId && !this.#ownTurnIds.has(turnId)) this.#foreignTurn(threadId, turnId);
  }

  #serverRequest(request: AppServerServerRequest, rpc: AppServerRpc, generation: number): void {
    const params = rpcObject(request.params) ? request.params : undefined;
    if (request.method.startsWith("item/") && typeof params?.threadId === "string" && typeof params.turnId === "string") {
      this.#turnEvidence(params.threadId, params.turnId);
    }
    this.#approvals.receive({ ...request, key: `${generation}:${request.key}` }, rpc, {
      boundThreadId: this.#boundThreadId, owner: this.#active?.owner,
    });
  }

  #fileChangeSnapshot(active: ActiveTurn, event: AppServerNotification): void {
    if (!event.method.startsWith("item/")) return;
    const item = event.params.item;
    if (!rpcObject(item) || item.type !== "fileChange" || typeof item.id !== "string" || item.changes === undefined) return;
    const snapshots = active.owner.fileChanges;
    if (!snapshots.has(item.id) && snapshots.size >= MAX_FILE_CHANGE_SNAPSHOTS) return;
    snapshots.set(item.id, item.changes);
  }

  #foreignTurn(threadId: unknown, turnId: string): void {
    if (this.#foreign || typeof threadId !== "string") return;
    this.#foreign = { threadId, turnId };
    this.#onForeignTurn?.({ ...this.#foreign });
  }

  #deliver(active: ActiveTurn, event: AppServerNotification): void {
    const nested = event.params.turn;
    const turnId = event.params.turnId ?? (rpcObject(nested) ? nested.id : undefined);
    if (turnId !== active.turnId) return;
    active.stream.push(event);
    if (event.method === "turn/completed") {
      // Settle the owner's records before the owner can be retired.
      active.owner.terminal = true;
      this.#approvals.terminal(active.owner);
      active.stream.finish();
      if (this.#active === active) this.#active = undefined;
    }
  }
}
