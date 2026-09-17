import {
  AppServerConnectionError, AppServerRpc, rpcObject,
  type AppServerNotification, type AppServerRpcOptions, type RpcObject,
} from "./app_server_rpc.js";
import { appServerInput, type AppServerInput } from "./app_server_input.js";
import { AppServerTurnStream } from "./app_server_stream.js";

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
}

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
  stream: AppServerTurnStream;
  beforeResponse: AppServerNotification[];
  turnId?: string;
  failure?: Error;
}

export class AppServerTransport {
  readonly #rpc: AppServerRpc;
  #initializing: Promise<void> | undefined;
  #active: ActiveTurn | undefined;
  #failure: Error | undefined;
  #version: string | undefined;
  #opening = false;

  constructor(options: Omit<AppServerRpcOptions, "onNotification" | "onFailure"> = {}) {
    this.#rpc = new AppServerRpc({
      ...options,
      onNotification: (event) => this.#notification(event),
      onFailure: (error) => {
        this.#failure ??= error;
        if (this.#active) {
          this.#active.failure ??= error;
          if (this.#active.turnId !== undefined) this.#active.stream.fail(error);
        }
      },
    });
  }

  get version(): string | undefined { return this.#version; }
  get stderrTail(): string { return this.#rpc.stderrTail; }

  async startThread(options: AppServerThreadOptions = {}): Promise<string> {
    return this.#openThread("thread/start", { ...options });
  }

  async resumeThread(threadId: string, options: AppServerThreadOptions = {}): Promise<string> {
    return this.#openThread("thread/resume", { ...options, threadId });
  }

  async startTurn(input: AppServerTurnInput): Promise<AppServerTurn> {
    if (this.#failure) throw this.#failure;
    if (this.#active || this.#opening) throw new Error("App-server already has an active or submitting operation");
    const wireInput = appServerInput(input.input);
    const active: ActiveTurn = { threadId: input.threadId, stream: new AppServerTurnStream(), beforeResponse: [] };
    // Reserve before initialize/request awaits; overlapping calls must never become implicit steering.
    this.#active = active;
    try {
      await this.#initialize();
      const ticket = this.#rpc.request("turn/start", {
        threadId: input.threadId,
        input: wireInput,
        ...(input.clientUserMessageId === undefined ? {} : { clientUserMessageId: input.clientUserMessageId }),
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
          threadId: input.threadId, turnId: active.turnId,
          hostTurnToken: input.hostTurnToken, requestId: ticket.id,
          ...(input.clientUserMessageId === undefined ? {} : { clientUserMessageId: input.clientUserMessageId }),
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
    }
  }

  async close(): Promise<void> { await this.#rpc.close(); }

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
    if (this.#active || this.#opening) throw new Error("Cannot change threads during an active operation");
    this.#opening = true;
    try {
      await this.#initialize();
      const result = await this.#rpc.request(method, {
        ...params, approvalPolicy: "never", approvalsReviewer: "user",
      }).result;
      if (!rpcObject(result) || !rpcObject(result.thread) || typeof result.thread.id !== "string") {
        this.#failure = new AppServerConnectionError(`Invalid ${method} response`);
        await this.#rpc.close();
        throw this.#failure;
      }
      return result.thread.id;
    } finally {
      this.#opening = false;
    }
  }

  #notification(event: AppServerNotification): void {
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
