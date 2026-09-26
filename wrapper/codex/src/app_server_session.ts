import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolDescriptor, WrapperConfig, ReplyOrigin } from "@kaoiro/agent-common";
import { BRIDGE_MCP_POLICY, BRIDGE_THREAD_OPEN_TIMEOUT_MS } from "./bridge_policy.js";
import { ToolHost } from "./toolhost.js";
import {
  AppServerTransport, type AppServerThreadOptions, type AppServerTurn, type AppServerTurnInput,
} from "./app_server_transport.js";
import type { AppServerRpcOptions } from "./app_server_rpc.js";
import { projectAppServerTurn, type AppServerProjectedTurn } from "./app_server_projection.js";
import type { AppServerHistory } from "./app_server_history.js";
import type { AppServerRateLimits } from "./app_server_telemetry.js";

export interface AppServerSessionOptions {
  thread?: Omit<AppServerThreadOptions, "config">;
  internalSubagents?: boolean;
  tools?: ToolDescriptor[];
  turnSignal: () => AbortSignal | null;
  bridgeStderrPath?: string;
  onDisconnect?: (error: Error) => void;
  transport?: Omit<AppServerRpcOptions, "onNotification" | "onFailure">;
}

async function removeToolHostDirectory(host: ToolHost | null): Promise<void> {
  if (!host) return;
  // ToolHost.listen creates and owns this private directory; no caller path
  // or attachment path participates in this cleanup.
  await rm(dirname(host.socketPath), { recursive: true, force: true });
}

/** Internal composition only; normal launch still selects exec. */
export class AppServerSession {
  readonly #transport: AppServerTransport;
  readonly #toolHost: ToolHost | null;
  readonly #threadOptions: AppServerThreadOptions;
  #threadId: string | undefined;
  #opening = false;
  #closing: Promise<void> | undefined;
  readonly #turnSignal: () => AbortSignal | null;
  #originPending: { thread: string; token: string; signal?: AbortSignal; ready: Promise<string | undefined>; resolve: (id?: string) => void; waiting: number } | undefined;

  async resolveToolOrigin(metadata: unknown): Promise<ReplyOrigin | undefined> {
    const native = (metadata as { "x-codex-turn-metadata"?: { thread_id?: unknown; turn_id?: unknown } } | undefined)?.["x-codex-turn-metadata"];
    const pending = this.#originPending;
    if (!pending || !native || native.thread_id !== pending.thread || typeof native.turn_id !== "string" || pending.waiting >= 64) return undefined;
    pending.waiting++;
    try {
      const id = await pending.ready;
      if (id !== native.turn_id || this.#originPending !== pending || !pending.signal || pending.signal.aborted) return undefined;
      return { token: pending.token, signal: pending.signal };
    } finally { pending.waiting--; }
  }


  static async create(options: AppServerSessionOptions): Promise<AppServerSession> {
    let session: AppServerSession | undefined;
    const host = options.tools?.length
      ? await ToolHost.listen(options.tools, { turnSignal: options.turnSignal, resolveOrigin: metadata => session?.resolveToolOrigin(metadata) })
      : null;
    try {
      session = new AppServerSession(options, host);
      return session;
    } catch (error) {
      host?.close();
      await removeToolHostDirectory(host);
      throw error;
    }
  }

  private constructor(options: AppServerSessionOptions, host: ToolHost | null) {
    this.#toolHost = host;
    this.#turnSignal = options.turnSignal;
    this.#threadOptions = {
      ...options.thread,
      config: {
        features: { multi_agent: options.internalSubagents ?? true },
        ...(host === null ? {} : {
          mcp_servers: {
            kaoiro: {
              command: process.execPath,
              args: [fileURLToPath(new URL("../dist/bridge.js", import.meta.url))],
              env: {
                KAOIRO_BRIDGE_SOCKET: host.socketPath,
                ...(options.bridgeStderrPath === undefined ? {} : {
                  KAOIRO_BRIDGE_STDERR_PATH: options.bridgeStderrPath,
                }),
              },
              ...BRIDGE_MCP_POLICY,
            },
          },
        }),
      },
    };
    this.#transport = new AppServerTransport({
      ...options.transport,
      ...(options.onDisconnect === undefined ? {} : { onDisconnect: options.onDisconnect }),
      ...(host === null ? {} : { threadOpenTimeoutMs: BRIDGE_THREAD_OPEN_TIMEOUT_MS }),
    });
  }

  get initialSettings() { return this.#transport.initialSettings; }
  get version(): string | undefined { return this.#transport.version; }
  get stderrTail(): string { return this.#transport.stderrTail; }
  get rateLimits(): AppServerRateLimits { return this.#transport.rateLimits; }

  async startThread(): Promise<string> { return this.#openThread(); }
  async resumeThread(threadId: string): Promise<string> { return this.#openThread(threadId); }

  async #openThread(threadId?: string): Promise<string> {
    if (this.#closing) throw new Error("App-server session is closed");
    if (this.#opening || this.#threadId !== undefined) throw new Error("App-server session already opening or bound");
    this.#opening = true;
    try {
      this.#threadId = threadId === undefined
        ? await this.#transport.startThread(this.#threadOptions)
        : await this.#transport.resumeThread(threadId, this.#threadOptions);
      await this.#transport.readRateLimits();
      return this.#threadId;
    } catch (error) {
      await this.close();
      throw error;
    } finally {
      this.#opening = false;
    }
  }

  async readHistory(config: WrapperConfig, now: () => string): Promise<AppServerHistory> {
    if (this.#closing) throw new Error("App-server session is closed");
    if (this.#opening || this.#threadId === undefined) throw new Error("App-server session thread is not ready");
    return this.#transport.readHistory(this.#threadId, config, now);
  }

  async startTurn(input: AppServerTurnInput): Promise<AppServerTurn> {
    if (this.#closing) throw new Error("App-server session is closed");
    if (this.#opening || this.#threadId === undefined || input.threadId !== this.#threadId) {
      throw new Error("App-server session thread is not ready or does not match");
    }
    let resolve!: (id?: string) => void;
    const pending: { thread: string; token: string; signal?: AbortSignal; ready: Promise<string | undefined>; resolve: (id?: string) => void; waiting: number } = {
      thread: input.threadId, token: input.hostTurnToken,
      ready: new Promise<string | undefined>(r => { resolve = r; }),
      resolve: id => resolve(id), waiting: 0,
    };
    this.#originPending?.resolve();
    this.#originPending = pending;
    try {
      const turn = await this.#transport.startTurn({ ...input,
        onDispatch: (identity, settings) => {
          const result = input.onDispatch?.(identity, settings);
          pending.signal = this.#turnSignal() ?? AbortSignal.abort();
          pending.signal.addEventListener("abort", () => pending.resolve(), { once: true });
          return result;
        },
        settings: { ...(this.#threadOptions.cwd === undefined ? {} : { cwd: this.#threadOptions.cwd }), ...input.settings },
      });
      pending.resolve(turn.identity.turnId);
      return turn;
    } catch (error) { pending.resolve(); throw error; }

  }

  interrupt(hostTurnToken: string): Promise<boolean> {
    if (this.#closing) return Promise.resolve(false);
    return this.#transport.interrupt(hostTurnToken);
  }

  async startProjectedTurn(input: AppServerTurnInput): Promise<AppServerProjectedTurn> {
    return projectAppServerTurn(await this.startTurn(input));
  }

  close(): Promise<void> {
    if (!this.#closing) {
      this.#originPending?.resolve(); this.#originPending = undefined;
      // Mark closing before abort listeners run; stop tool access synchronously,
      // without waiting for the child's bounded graceful shutdown.
      this.#closing = Promise.resolve().then(async () => {
        try { await this.#transport.close(); }
        finally { await removeToolHostDirectory(this.#toolHost); }
      });
      this.#toolHost?.close();
    }
    return this.#closing;
  }
}
