import type { WrapperConfig } from "@kaoiro/agent-common";
import { readAppServerHistory, type AppServerHistory } from "./app_server_history.js";
import {
  AppServerConnectionError, AppServerRpc, AppServerRpcError, rpcObject,
  type AppServerNotification, type AppServerRpcOptions, type RpcObject,
} from "./app_server_rpc.js";
import { appServerInput, type AppServerInput } from "./app_server_input.js";
import { AppServerTurnStream } from "./app_server_stream.js";
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
  /** Synchronous admission check immediately before turn/start; throwing sends no turn. */
  onDispatch?: (identity: AppServerDispatchIdentity, settings: AppServerPreparedSettings) => void;
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

interface ActiveTurn {
  threadId: string;
  hostTurnToken: string;
  ready: Promise<void>;
  interrupt?: Promise<boolean>;
  stream: AppServerTurnStream;
  beforeResponse: AppServerNotification[];
  turnId?: string;
  failure?: Error;
}

export class AppServerTransport {
  readonly #rpc: AppServerRpc;
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

  constructor(options: Omit<AppServerRpcOptions, "onNotification" | "onFailure"> & { threadOpenTimeoutMs?: number; onDisconnect?: (error: Error) => void } = {}) {
    this.#threadOpenTimeoutMs = options.threadOpenTimeoutMs;
    this.#rpc = new AppServerRpc({
      ...options,
      onNotification: (event) => this.#notification(event),
      onFailure: (error) => {
        const first = this.#failure === undefined;
        this.#failure ??= error;
        this.#disconnected.abort(error);
        if (this.#active) {
          this.#active.failure ??= error;
          if (this.#active.turnId !== undefined) this.#active.stream.fail(error);
        }
        if (first && !this.#closing) options.onDisconnect?.(error);
      },
    });
  }

  get initialSettings(): AppServerSettingsSnapshot | null { return this.#initialSettings && { ...this.#initialSettings }; }
  get version(): string | undefined { return this.#version; }
  get stderrTail(): string { return this.#rpc.stderrTail; }
  get rateLimits(): AppServerRateLimits { return this.#account.snapshot; }

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
    return this.#openThread("thread/resume", { ...options, threadId });
  }

  async startTurn(input: AppServerTurnInput): Promise<AppServerTurn> {
    if (this.#failure) throw this.#failure;
    if (this.#active || this.#opening || this.#readingHistory) throw new Error("App-server already has an active or submitting operation");
    const wireInput = appServerInput(input.input);
    const dispatch: AppServerDispatchIdentity = {
      threadId: input.threadId, hostTurnToken: input.hostTurnToken,
      ...(input.clientUserMessageId === undefined ? {} : { clientUserMessageId: input.clientUserMessageId }),
    };
    let release!: () => void;
    const active: ActiveTurn = { ...dispatch, stream: new AppServerTurnStream(), beforeResponse: [],
      ready: new Promise<void>(resolve => { release = resolve; }) };
    // Reserve before initialize/request awaits; overlapping calls must never become implicit steering.
    this.#active = active;
    try {
      await this.#initialize();
      const settings = await appServerTurnSettings(input.settings ?? {}, (method, params) => this.#rpc.request(method, params).result);
      const prepared: AppServerPreparedSettings = Object.freeze({
        ...(typeof settings.model === "string" ? { model: settings.model } : {}),
        ...(typeof settings.effort === "string" ? { effort: settings.effort } : {}),
      });
      if (input.beforeDispatch) await this.#beforeDispatch(() => input.beforeDispatch!(prepared));
      if (this.#failure) throw this.#failure;
      input.onDispatch?.(dispatch, prepared);
      const ticket = this.#rpc.request("turn/start", {
        ...settings, threadId: dispatch.threadId,
        input: wireInput,
        ...(dispatch.clientUserMessageId === undefined ? {} : { clientUserMessageId: dispatch.clientUserMessageId }),
        approvalPolicy: "never", approvalsReviewer: "user",
      });
      const result = await ticket.result;
      if (!rpcObject(result) || !rpcObject(result.turn) || typeof result.turn.id !== "string") {
        throw new AppServerConnectionError("Invalid turn/start response");
      }
      active.turnId = result.turn.id;
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
      if (this.#active === active) this.#active = undefined;
      if (error instanceof AppServerConnectionError) {
        this.#failure = error;
        await this.#rpc.close();
      }
      throw error;
    } finally {
      release();
    }
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

  async close(): Promise<void> { this.#closing = true;await this.#rpc.close(); }

  async #initialize(): Promise<void> {
    if (!this.#initializing) {
      this.#initializing = (async () => {
        const result = await this.#rpc.request("initialize", {
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
        this.#rpc.notify("initialized");
      })().catch(async (error: unknown) => {
        this.#failure = error instanceof Error ? error : new AppServerConnectionError("App-server initialization failed");
        await this.#rpc.close();
        throw this.#failure;
      });
    }
    await this.#initializing;
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
      this.#initialSettings = typeof result.model === "string" &&
        (result.reasoningEffort === null || typeof result.reasoningEffort === "string")
        ? { model: result.model, effort: result.reasoningEffort } : null;
      return result.thread.id;
    } finally {
      this.#opening = false;
    }
  }

  #notification(event: AppServerNotification): void {
    if (event.method === "account/rateLimits/updated") {
      this.#account.update(event.params.rateLimits);
      return;
    }
    const active = this.#active;
    if (!active || event.params.threadId !== active.threadId) return;
    if (active.turnId === undefined) active.beforeResponse.push(event);
    else this.#deliver(active, event);
  }

  #deliver(active: ActiveTurn, event: AppServerNotification): void {
    const nested = event.params.turn;
    const turnId = event.params.turnId ?? (rpcObject(nested) ? nested.id : undefined);
    if (turnId !== active.turnId) return;
    active.stream.push(event);
    if (event.method === "turn/completed") {
      active.stream.finish();
      if (this.#active === active) this.#active = undefined;
    }
  }
}
