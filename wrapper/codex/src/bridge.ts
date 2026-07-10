// MCP bridge — the stdio MCP server codex spawns per turn (ADR-0032 F5).
// It owns NO tool logic: tools/list and tools/call are forwarded over the
// wrapper's unix socket (KAOIRO_BRIDGE_SOCKET, see toolhost.ts) so the
// common ToolDescriptor handlers run inside the wrapper process. A blocking
// call (ask_user_question awaiting the operator) simply keeps the MCP
// request pending, which blocks the codex turn — that is what makes
// waiting_question hold on codex (ADR-0032 F6).

import { createConnection, type Socket } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

interface BridgeResponse {
  id: number;
  tools?: unknown[];
  result?: { content: unknown[]; isError?: boolean };
  error?: string;
}

/** Line-buffered request/response client over the wrapper's unix socket. */
class ToolHostClient {
  #socket: Socket | null = null;
  #buffer = "";
  #nextId = 1;
  readonly #pending = new Map<
    number,
    { resolve: (r: BridgeResponse) => void; reject: (e: Error) => void }
  >();
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async #connect(): Promise<Socket> {
    if (this.#socket && !this.#socket.destroyed) return this.#socket;
    const socket = createConnection(this.#path);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.#buffer += chunk;
      let newline = this.#buffer.indexOf("\n");
      while (newline !== -1) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        if (line.trim() !== "") this.#dispatch(line);
        newline = this.#buffer.indexOf("\n");
      }
    });
    const fail = (err: Error): void => {
      for (const { reject } of this.#pending.values()) reject(err);
      this.#pending.clear();
    };
    socket.on("error", (err) => fail(err));
    socket.on("close", () => fail(new Error("tool host connection closed")));
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    this.#socket = socket;
    return socket;
  }

  #dispatch(line: string): void {
    let response: BridgeResponse;
    try {
      response = JSON.parse(line) as BridgeResponse;
    } catch {
      return;
    }
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    pending.resolve(response);
  }

  async request(
    payload: Record<string, unknown>,
  ): Promise<BridgeResponse> {
    const socket = await this.#connect();
    const id = this.#nextId++;
    const promise = new Promise<BridgeResponse>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    socket.write(`${JSON.stringify({ id, ...payload })}\n`);
    const response = await promise;
    if (response.error !== undefined) throw new Error(response.error);
    return response;
  }
}

async function main(): Promise<void> {
  const socketPath = process.env.KAOIRO_BRIDGE_SOCKET;
  if (!socketPath) {
    process.stderr.write("KAOIRO_BRIDGE_SOCKET is not set\n");
    process.exitCode = 1;
    return;
  }
  const client = new ToolHostClient(socketPath);
  const server = new Server(
    { name: "kaoiro", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const response = await client.request({ method: "list_tools" });
    return { tools: (response.tools ?? []) as never };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const response = await client.request({
      method: "call_tool",
      name: request.params.name,
      input: request.params.arguments ?? {},
    });
    return (response.result ?? {
      content: [{ type: "text", text: "tool host returned no result" }],
      isError: true,
    }) as never;
  });
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
