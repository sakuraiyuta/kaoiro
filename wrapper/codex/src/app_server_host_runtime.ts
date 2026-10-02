import type { WrapperConfig } from "@kaoiro/agent-common";
import type { AppServerHistory } from "./app_server_history.js";
import type { AppServerContextEvent } from "./app_server_context.js";
import type { AppServerRateLimits } from "./app_server_telemetry.js";
import { AppServerSession, type AppServerSessionOptions } from "./app_server_session.js";
import { AppServerConnectionError, AppServerRpcError } from "./app_server_rpc.js";
import {
  appServerSettingsAfterSuccess, appServerSettingsForAttempt, AppServerSettingsError,
  type AppServerPendingSettings, type AppServerPreparedSettings, type AppServerSettingsIntent,
} from "./app_server_settings.js";
import {
  AppServerPermissionSuperseded, captureAppServerPermission, observeAppServerPermission,
  type AppServerPermissionAttempt, type CodexPermissionAssessment,
} from "./app_server_permission.js";
import { canSubmitPermission, type PermissionState } from "./permission_state.js";
import { codexRolloutsRoot } from "./rollout.js";
import { isApprovalPolicy, type ApprovalPolicy } from "./app_server_approval.js";
import type { AppServerProjection } from "./app_server_projection.js";
import type {
  AppServerDispatchIdentity, AppServerSteerAttempt, AppServerSteerRequest, AppServerTurnIdentity, AppServerTurnInput,
} from "./app_server_transport.js";

export type AppServerHostSession = Pick<AppServerSession,
  "readHistory" | "startThread" | "resumeThread" | "initialSettings" | "startProjectedTurn" | "interrupt" | "close"> & {
    steer?: AppServerSession["steer"];
    abortApprovals?: AppServerSession["abortApprovals"];
    rateLimits?: AppServerRateLimits;
  };
export interface AppServerHostRuntimeOptions {
  session: AppServerSessionOptions;
  resumeThreadId?: string;
  effortIntent: "explicit" | "default";
  rolloutRoot?: string;
  /** The approval axis is advertised (ADR-0064). Without it a requested
   * approval is not submitted and the turn keeps `never`. */
  approvalAxis?: boolean;
  createSession?: (options: AppServerSessionOptions) => Promise<AppServerHostSession>;
  onContext?: (event: AppServerContextEvent) => void;
  onRateLimits?: (snapshot: AppServerRateLimits) => void;
}
export interface AppServerRuntimeAttempt {
  pending: AppServerPendingSettings;
  prepared: AppServerPreparedSettings;
  permission: AppServerPermissionAttempt | null;
}
export interface AppServerRuntimeHooks {
  snapshot: () => { pending: AppServerPendingSettings; permission: PermissionState };
  /** Wait for sync and the blocked gate. Reject admission with AppServerAdmissionError
   * (permission_gate_blocked/interrupted); other failures close the session. */
  waitForPermissionSync: () => Promise<void>;
  /** Runs synchronously after final admission and before turn/start. */
  prepareInput?: () => string | null | undefined;
  onDispatch: (attempt: AppServerRuntimeAttempt, identity: AppServerDispatchIdentity) => void;
  /** Runs once, after the validated turn/start response and before any turn
   * event is consumed. It must not throw. */
  onHandoff?: (identity: AppServerTurnIdentity) => void;
  onTerminal?: (identity: AppServerTurnIdentity) => void;
  onPermission: (assessment: CodexPermissionAssessment, attempt: AppServerRuntimeAttempt) => void;
  onProjection: (event: Exclude<AppServerProjection, { kind: "result" | "input_item" }>) => void;
  onInputItem?: (event: Extract<AppServerProjection, { kind: "input_item" }>) => void;
}
export interface AppServerRuntimeCompletion {
  identity: AppServerTurnIdentity;
  terminal: Extract<AppServerProjection, { kind: "result" }>;
  attempt: AppServerRuntimeAttempt;
  permission: CodexPermissionAssessment | null;
  settingsCommitted: boolean;
}
export class AppServerAdmissionError extends Error {
  constructor(readonly reason: "interrupted" | "permission_gate_blocked" | "input_skipped") {
    super(`App-server admission cancelled: ${reason}`);
  }
}

// Only the values the app-server backend offers reach turn/start; the
// transport still writes `never` unless approvals are enabled.
function approvalOf(selection: { requested: { approval?: string } }): ApprovalPolicy | undefined {
  const approval = selection.requested.approval;
  return isApprovalPolicy(approval) ? approval : undefined;
}

type Active = { token: string; abort: AbortController; dispatched: boolean; interrupted: boolean; terminal?: { abandoned: boolean } };
async function cancellable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new AppServerAdmissionError("interrupted"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([operation, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

/** Internal runtime only. The Host owns queueing and external lifecycle callbacks. */
export class AppServerHostRuntime {
  readonly #options: AppServerHostRuntimeOptions;
  #creating: Promise<AppServerHostSession> | undefined;
  #session: AppServerHostSession | undefined;
  #opening: Promise<string> | undefined;
  #baseline: AppServerSettingsIntent | null = null;
  #fresh: boolean;
  #rollback = false;
  #active: Active | undefined;
  #closed = false;
  #readingHistory = false;
  #closing: Promise<void> | undefined;

  constructor(options: AppServerHostRuntimeOptions) {
    this.#options = options;
    this.#fresh = options.resumeThreadId === undefined;
  }
  get baseline(): AppServerSettingsIntent | null { return this.#baseline && { ...this.#baseline }; }
  get closed(): boolean { return this.#closed; }

  open(): Promise<string> {
    if (this.#closed) return Promise.reject(new AppServerConnectionError("App-server runtime closed"));
    this.#opening ??= (async () => {
      this.#creating = (this.#options.createSession ?? AppServerSession.create)({
        ...this.#options.session, onDisconnect: error => {
          if (this.#closed) return;
          void this.close();this.#options.session.onDisconnect?.(error);
        }, onRateLimits: snapshot => this.#forwardRateLimits(snapshot),
        onContext: event => { if (!this.#closed) this.#options.onContext?.(event); },
      });
      this.#session = await this.#creating;
      if (this.#closed) throw new AppServerConnectionError("App-server runtime closed");
      const threadId = this.#options.resumeThreadId === undefined
        ? await this.#session.startThread() : await this.#session.resumeThread(this.#options.resumeThreadId);
      if (this.#session.rateLimits !== undefined) this.#forwardRateLimits(this.#session.rateLimits);
      const initial = this.#session.initialSettings;
      this.#baseline = initial && { ...initial, effortIntent: this.#options.effortIntent };
      return threadId;
    })().catch(async error => {
      this.#closed = true;
      await this.#session?.close();
      throw error;
    });
    return this.#opening;
  }

  async readHistory(config: WrapperConfig, now: () => string): Promise<AppServerHistory> {
    if (this.#closed) throw new AppServerConnectionError("App-server runtime closed");
    if (this.#active || this.#readingHistory) throw new Error("App-server runtime already has an active operation");
    this.#readingHistory = true;
    try { await this.open();return await this.#session!.readHistory(config, now); }
    finally { this.#readingHistory = false; }
  }

  async run(
    input: Pick<AppServerTurnInput, "input" | "hostTurnToken" | "clientUserMessageId">,
    hooks: AppServerRuntimeHooks,
  ): Promise<AppServerRuntimeCompletion> {
    if (this.#closed) throw new AppServerConnectionError("App-server runtime closed");
    if (this.#active || this.#readingHistory) throw new Error("App-server runtime already has an active turn");
    const active: Active = { token: input.hostTurnToken, abort: new AbortController(), dispatched: false, interrupted: false };
    this.#active = active;
    const waitForAdmission = async () => {
      try { await hooks.waitForPermissionSync(); }
      catch (error) {
        if (error instanceof AppServerAdmissionError) throw error;
        throw new AppServerConnectionError("App-server admission synchronization failed");
      }
    };
    try {
      await cancellable(waitForAdmission(), active.abort.signal);
      const threadId = await cancellable(this.open(), active.abort.signal);
      for (;;) {
        if (active.abort.signal.aborted) throw new AppServerAdmissionError("interrupted");
        const snapshot = hooks.snapshot();
        if (snapshot.permission.blocked !== null) throw new AppServerAdmissionError("permission_gate_blocked");
        const pending = { ...snapshot.pending };
        const selection = { ...snapshot.permission.next, requested: { ...snapshot.permission.next.requested } };
        if (!this.#options.approvalAxis) delete selection.requested.approval;
        const baseline = this.#baseline;
        const rollback = this.#rollback;
        const settings = appServerSettingsForAttempt(baseline, pending, rollback);
        let attempt!: AppServerRuntimeAttempt;
        try {
          const turn = await this.#session!.startProjectedTurn({
            ...input, threadId,
            settings: { ...settings, permission: {
              sandbox: selection.requested.sandbox, networkAccess: selection.requested.network_access,
              ...(approvalOf(selection) === undefined ? {} : { approval: approvalOf(selection)! }),
            } },
            beforeDispatch: () => cancellable(waitForAdmission(), active.abort.signal),
            onDispatch: (identity, prepared) => {
              if (active.abort.signal.aborted || this.#closed) throw new AppServerAdmissionError("interrupted");
              const current = hooks.snapshot();
              if (!canSubmitPermission(current.permission, selection) || current.pending.model !== pending.model ||
                  current.pending.effort !== pending.effort || current.pending.effortReset !== pending.effortReset) {
                throw new AppServerPermissionSuperseded();
              }
              const preparedInput = hooks.prepareInput?.();
              if (preparedInput === null) throw new AppServerAdmissionError("input_skipped");
              attempt = { pending, prepared, permission: current.permission.syncSupported
                ? captureAppServerPermission(this.#options.rolloutRoot ?? codexRolloutsRoot(), current.permission, selection, identity, this.#fresh) : null };
              active.dispatched = true;
              this.#fresh = false;
              hooks.onDispatch(attempt, identity);
              return preparedInput;
            },
          });
          hooks.onHandoff?.(turn.identity);
          for await (const event of turn.events) {
            if (event.kind === "input_item") { hooks.onInputItem?.(event); continue; }
            if (event.kind !== "result") {
              // Delay the terminal state until policy evidence and settings are settled.
              if (event.kind !== "adapter" || event.event.kind !== "result") hooks.onProjection(event);
              continue;
            }
            // Observation can await rollout writes; later interrupts cannot abandon this completed boundary.
            active.terminal = { abandoned: active.interrupted };
            hooks.onTerminal?.(turn.identity);
            const permission = attempt.permission === null ? null
              : await observeAppServerPermission(attempt.permission, turn.identity, () => hooks.snapshot().permission);
            if (this.#closed) throw new AppServerConnectionError("App-server runtime closed");
            if (permission !== null) hooks.onPermission(permission, attempt);
            const settingsCommitted = event.status === "completed" && !active.terminal.abandoned;
            if (settingsCommitted) {
              this.#baseline = appServerSettingsAfterSuccess(baseline!, pending, attempt.prepared, rollback);
              this.#rollback = false;
            } else this.#rollback = true;
            return { identity: turn.identity, terminal: event, attempt, permission, settingsCommitted };
          }
          throw new AppServerConnectionError("App-server stream ended without a terminal turn");
        } catch (error) {
          if (!active.dispatched && error instanceof AppServerPermissionSuperseded) continue;
          throw error;
        }
      }
    } catch (error) {
      if (active.dispatched) this.#rollback = true;
      if (!(error instanceof AppServerAdmissionError || error instanceof AppServerSettingsError || error instanceof AppServerRpcError)) {
        await this.close();
      }
      throw error;
    } finally {
      if (this.#active === active) this.#active = undefined;
    }
  }

  /** The transport decides live-turn state from its own active turn; the
   * host's admit() owns abandonment and every other guard. */
  steer(request: AppServerSteerRequest): AppServerSteerAttempt {
    const active = this.#active;
    if (this.#closed) return { kind: "refused", reason: "closed" };
    if (!active || active.token !== request.hostTurnToken) return { kind: "refused", reason: "idle" };
    return this.#session?.steer?.(request) ?? { kind: "refused", reason: "idle" };
  }

  /** Synchronous; see AppServerTransport#abortApprovals. */
  abortApprovals(hostTurnToken: string): void {
    const active = this.#active;
    if (!active || active.token !== hostTurnToken) return;
    this.#session?.abortApprovals?.(hostTurnToken);
  }

  async interrupt(hostTurnToken: string): Promise<boolean> {
    const active = this.#active;
    if (this.#closed || !active || active.terminal || active.token !== hostTurnToken) return false;
    active.interrupted = true;
    if (!active.dispatched) { active.abort.abort();return true; }
    return this.#session!.interrupt(hostTurnToken);
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#active?.abort.abort();
    // An existing session must revoke tool access synchronously at close entry.
    this.#closing ??= this.#session ? this.#session.close()
      : this.#creating?.then(session => session.close(), () => {}) ?? Promise.resolve();
    return this.#closing;
  }

  #forwardRateLimits(snapshot: AppServerRateLimits): void {
    if (!this.#closed) this.#options.onRateLimits?.(snapshot);
  }
}
