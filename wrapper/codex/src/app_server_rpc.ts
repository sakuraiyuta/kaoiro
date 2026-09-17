import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type RpcObject = Record<string, unknown>;
export interface AppServerNotification { method: string; params: RpcObject }
export interface RpcTicket { id: number; result: Promise<unknown> }

export class AppServerRpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = "AppServerRpcError";
  }
}

export class AppServerConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppServerConnectionError";
  }
}

export function rpcObject(value: unknown): value is RpcObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveAppServerBinary(): string {
  const packagePath = realpathSync(fileURLToPath(import.meta.resolve("@openai/codex/package.json")));
  const targetPlatform = platform() === "android" ? "linux" : platform();
  const targetArch = arch();
  const triples: Record<string, string> = {
    "linux:x64": "x86_64-unknown-linux-musl",
    "linux:arm64": "aarch64-unknown-linux-musl",
    "darwin:x64": "x86_64-apple-darwin",
    "darwin:arm64": "aarch64-apple-darwin",
    "win32:x64": "x86_64-pc-windows-msvc",
    "win32:arm64": "aarch64-pc-windows-msvc",
  };
  const triple = triples[`${targetPlatform}:${targetArch}`];
  if (!triple) throw new Error(`Unsupported Codex platform: ${targetPlatform}/${targetArch}`);
  let packageRoot = dirname(packagePath);
  // Search from the real package location so pnpm's optional-dependency aliases
  // and npm's nested installs resolve without granting a dynamic module loader.
  for (let directory = packageRoot; ; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", "@openai", `codex-${targetPlatform}-${targetArch}`);
    if (existsSync(join(candidate, "package.json"))) {
      packageRoot = candidate;
      break;
    }
    if (dirname(directory) === directory) break;
  }
  const binary = join(packageRoot, "vendor", triple, "bin", targetPlatform === "win32" ? "codex.exe" : "codex");
  if (!existsSync(binary)) throw new Error("The installed Codex package has no native app-server binary");
  return binary;
}

export interface AppServerRpcOptions {
  spawnChild?: () => ChildProcessWithoutNullStreams;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  onNotification?: (notification: AppServerNotification) => void;
  onFailure?: (error: Error) => void;
  onDiagnostic?: (message: string) => void;
}

interface Waiter {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AppServerRpc {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #options: AppServerRpcOptions;
  readonly #pending = new Map<number, Waiter>();
  readonly #closed: Promise<void>;
  #nextId = 1;
  #failure: Error | undefined;
  #closing = false;
  #killTimer: ReturnType<typeof setTimeout> | undefined;
  #stderrTail = "";

  constructor(options: AppServerRpcOptions = {}) {
    this.#options = options;
    this.#child = options.spawnChild?.() ?? spawn(resolveAppServerBinary(), [
      "--config", 'approvals_reviewer="user"', "--config", 'approval_policy="never"',
      "--config", "analytics.enabled=false", "app-server", "--listen", "stdio://",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    this.#closed = new Promise((resolve) => {
      this.#child.once("close", () => {
        if (this.#killTimer) clearTimeout(this.#killTimer);
        resolve();
      });
    });
    this.#child.once("error", () => this.#fail(new AppServerConnectionError("App-server child failed")));
    this.#child.stdin.on("error", () => this.#fail(new AppServerConnectionError("App-server stdin failed")));
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (data: string) => {
      this.#stderrTail = (this.#stderrTail + data).slice(-16_384);
    });
    this.#child.stderr.on("error", () => this.#fail(new AppServerConnectionError("App-server stderr failed")));
    // Child exit can precede delivery of the last stdout chunks. Only the reader ends routing.
    void this.#read();
  }

  get stderrTail(): string { return this.#stderrTail; }

  request(method: string, params: RpcObject): RpcTicket {
    const id = this.#nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      if (this.#failure || this.#closing) {
        reject(this.#failure ?? new AppServerConnectionError("App-server is closing"));
        return;
      }
      const timer = setTimeout(() => {
        // Once submitted, a timeout cannot establish that the operation was rejected.
        this.#fail(new AppServerConnectionError(`App-server response timeout: ${method}`));
      }, this.#options.requestTimeoutMs ?? 25_000);
      this.#pending.set(id, { resolve, reject, timer });
      this.#write({ id, method, params });
    });
    return { id, result };
  }

  notify(method: string): void {
    if (this.#failure || this.#closing) throw this.#failure ?? new AppServerConnectionError("App-server is closing");
    this.#write({ method, params: null });
  }

  async close(): Promise<void> {
    if (!this.#closing) {
      this.#closing = true;
      this.#fail(new AppServerConnectionError("App-server closed by client"));
    }
    await this.#closed;
  }

  #write(message: RpcObject): void {
    try {
      this.#child.stdin.write(JSON.stringify(message) + "\n", (error) => {
        if (error) this.#fail(new AppServerConnectionError("App-server write failed"));
      });
    } catch {
      this.#fail(new AppServerConnectionError("App-server write failed"));
    }
  }

  async #read(): Promise<void> {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffered = "";
    const consume = (text: string) => {
      buffered += text;
      let newline: number;
      while ((newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.trim()) this.#route(JSON.parse(line));
      }
    };
    try {
      for await (const chunk of this.#child.stdout) consume(decoder.decode(chunk as Uint8Array, { stream: true }));
      consume(decoder.decode());
      if (buffered.trim()) this.#route(JSON.parse(buffered));
      this.#fail(new AppServerConnectionError("App-server stdout ended"));
    } catch {
      this.#fail(new AppServerConnectionError("Invalid or interrupted app-server stream"));
    }
  }

  #route(message: unknown): void {
    if (!rpcObject(message)) throw new Error("Invalid RPC message");
    if (typeof message.method === "string") {
      if (message.id !== undefined) {
        if (typeof message.id !== "string" && typeof message.id !== "number") throw new Error("Invalid request id");
        this.#write({ id: message.id, error: { code: -32601, message: "Client approval and server-request handling are disabled" } });
        this.#options.onDiagnostic?.("Unexpected app-server request rejected");
      } else {
        if (!rpcObject(message.params)) throw new Error("Invalid notification params");
        this.#options.onNotification?.({ method: message.method, params: message.params });
      }
      return;
    }
    if (typeof message.id !== "number") throw new Error("Invalid response id");
    const waiter = this.#pending.get(message.id);
    if (!waiter) {
      this.#options.onDiagnostic?.("Unmatched app-server response ignored");
      return;
    }
    if (("result" in message) === ("error" in message)) throw new Error("Invalid response shape");
    if ("error" in message) {
      if (!rpcObject(message.error) || typeof message.error.code !== "number" || typeof message.error.message !== "string") {
        throw new Error("Invalid RPC error");
      }
      waiter.reject(new AppServerRpcError(message.error.code, message.error.message));
    } else {
      waiter.resolve(message.result);
    }
    clearTimeout(waiter.timer);
    this.#pending.delete(message.id);
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    for (const waiter of this.#pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#pending.clear();
    this.#child.stdin.end();
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#killTimer = setTimeout(() => this.#child.kill("SIGKILL"), this.#options.shutdownTimeoutMs ?? 5_000);
      this.#killTimer.unref();
    }
    this.#options.onFailure?.(error);
  }
}
