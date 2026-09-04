import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolDescriptor } from "@kaoiro/agent-common";

const MAX_LINE_BYTES = 1024 * 1024;

type BridgeRequest =
  | { id: number; nonce: string; method: "list_tools" }
  | { id: number; nonce: string; method: "call_tool"; name: string; input?: Record<string, unknown> };

export class ToolHost {
  readonly #descriptors: Map<string, ToolDescriptor>;
  readonly #server: Server;
  readonly #dir: string;
  readonly socketPath: string;
  readonly nonce: string;
  readonly #sockets = new Set<Socket>();
  #closed = false;

  private constructor(descriptors: ToolDescriptor[], server: Server, dir: string, nonce: string) {
    this.#descriptors = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
    this.#server = server;
    this.#dir = dir;
    this.socketPath = join(dir, "bridge.sock");
    this.nonce = nonce;
  }

  static async listen(descriptors: ToolDescriptor[], nonce = randomUUID()): Promise<ToolHost> {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-agy-toolhost-"));
    const server = createServer();
    const host = new ToolHost(descriptors, server, dir, nonce);
    server.on("connection", (socket) => host.#serve(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(host.socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    return host;
  }

  toolNames(): ReadonlySet<string> {
    return new Set(this.#descriptors.keys());
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    this.#server.close();
    rmSync(this.#dir, { recursive: true, force: true });
  }

  #serve(socket: Socket): void {
    this.#sockets.add(socket);
    socket.once("close", () => this.#sockets.delete(socket));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
        socket.destroy();
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() !== "") void this.#handleLine(socket, line);
        newline = buffer.indexOf("\n");
      }
    });
  }

  async #handleLine(socket: Socket, line: string): Promise<void> {
    let request: BridgeRequest;
    try { request = JSON.parse(line) as BridgeRequest; } catch { return; }
    const reply = (payload: Record<string, unknown>): void => {
      if (!socket.destroyed) socket.write(`${JSON.stringify({ id: request.id, ...payload })}\n`);
    };
    if (typeof request.id !== "number" || request.nonce !== this.nonce) {
      reply({ error: "unauthorized bridge request" });
      return;
    }
    if (request.method === "list_tools") {
      reply({ tools: [...this.#descriptors.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      return;
    }
    if (request.method !== "call_tool" || typeof request.name !== "string") {
      reply({ error: "unknown method" });
      return;
    }
    const descriptor = this.#descriptors.get(request.name);
    if (descriptor === undefined) {
      reply({ error: `unknown tool: ${request.name}` });
      return;
    }
    try {
      reply({ result: await descriptor.handler(request.input ?? {}) });
    } catch (error) {
      reply({ error: String(error) });
    }
  }
}
