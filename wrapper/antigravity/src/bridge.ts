import { createConnection, type Socket } from "node:net";

interface Reply {
  id: number;
  tools?: unknown;
  result?: unknown;
  error?: string;
}

class ToolHostClient {
  #socket: Socket | null = null;
  #buffer = "";
  #nextId = 1;
  readonly #pending = new Map<number, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>();
  readonly #path: string;
  readonly #nonce: string;

  constructor(path: string, nonce: string) {
    this.#path = path;
    this.#nonce = nonce;
  }

  async call(method: "list_tools" | "call_tool", extra: Record<string, unknown> = {}): Promise<Reply> {
    const socket = await this.#connect();
    const id = this.#nextId++;
    return new Promise<Reply>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      socket.write(`${JSON.stringify({ id, nonce: this.#nonce, method, ...extra })}\n`);
    });
  }

  close(): void {
    this.#fail(new Error("bridge client closed"));
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null && !socket.destroyed) {
      socket.end();
      socket.destroy();
    }
  }

  async #connect(): Promise<Socket> {
    if (this.#socket !== null && !this.#socket.destroyed) return this.#socket;
    return new Promise<Socket>((resolve, reject) => {
      const socket = createConnection(this.#path);
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        this.#socket = socket;
        resolve(socket);
      });
      socket.once("error", reject);
      socket.on("data", (chunk: string) => this.#read(chunk));
      socket.on("error", (error) => this.#fail(error));
      socket.on("close", () => this.#fail(new Error("bridge socket closed")));
    });
  }

  #read(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      try {
        const reply = JSON.parse(line) as Reply;
        const pending = this.#pending.get(reply.id);
        if (pending !== undefined) {
          this.#pending.delete(reply.id);
          pending.resolve(reply);
        }
      } catch {}
      newline = this.#buffer.indexOf("\n");
    }
  }

  #fail(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

async function main(): Promise<void> {
  const [command, toolName, encoded] = process.argv.slice(2);
  const socketPath = process.env.KAOIRO_BRIDGE_SOCKET;
  const nonce = process.env.KAOIRO_BRIDGE_NONCE;
  if (socketPath === undefined || nonce === undefined) fail("KAOIRO bridge environment is not set");
  const client = new ToolHostClient(socketPath, nonce);
  try {
    if (command === "list" && toolName === undefined) {
      const reply = await client.call("list_tools");
      if (reply.error !== undefined) fail(reply.error);
      process.stdout.write(`${JSON.stringify(reply.tools)}\n`);
      return;
    }
    if (command !== "call" || toolName === undefined || encoded === undefined || process.argv.length !== 5 || !/^[a-z_]{1,64}$/.test(toolName) || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
      fail("usage: bridge.js list | bridge.js call <tool> <base64url-json>");
    }
    let input: unknown;
    try {
      const bytes = Buffer.from(encoded, "base64url");
      if (bytes.byteLength > 64 * 1024) fail("bridge input exceeds 64 KiB");
      input = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("bridge input is not base64url JSON");
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) fail("bridge input must be an object");
    const reply = await client.call("call_tool", { name: toolName, input });
    if (reply.error !== undefined) fail(reply.error);
    process.stdout.write(`${JSON.stringify(reply.result)}\n`);
  } finally {
    client.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
