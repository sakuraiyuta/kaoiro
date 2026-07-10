// Tool host — the wrapper-side unix-socket server behind the MCP bridge
// (ADR-0032 F5). codex spawns dist/bridge.js per turn as a stdio MCP server;
// the bridge connects back here and forwards tools/list + tools/call, so the
// common ToolDescriptor handlers (@kaoiro/agent-common) run inside the
// wrapper process with full access to the brokers and the server link.
//
// Wire: newline-delimited JSON over a per-agent unix socket.
//   -> { id, method: "list_tools" }
//   <- { id, tools: [{ name, description, inputSchema }] }
//   -> { id, method: "call_tool", name, input }
//   <- { id, result: { content, isError? } }  |  { id, error }

import { mkdtempSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDescriptor } from "@kaoiro/agent-common";

/** Bounds one request line; far above any real tool input (the biggest is
 *  ask_user_question's 4 questions x 4 options). */
const MAX_LINE_BYTES = 1024 * 1024;

interface ListToolsRequest {
  id: number;
  method: "list_tools";
}
interface CallToolRequest {
  id: number;
  method: "call_tool";
  name: string;
  input?: Record<string, unknown>;
}
type BridgeRequest = ListToolsRequest | CallToolRequest;

export class ToolHost {
  readonly #descriptors: Map<string, ToolDescriptor>;
  readonly #server: Server;
  readonly socketPath: string;

  private constructor(
    descriptors: ToolDescriptor[],
    server: Server,
    socketPath: string,
  ) {
    this.#descriptors = new Map(descriptors.map((d) => [d.name, d]));
    this.#server = server;
    this.socketPath = socketPath;
  }

  /** Creates the socket in a fresh private tmp dir (0700 by mkdtemp) and
   *  starts listening. The path rides to the bridge via mcp_servers env. */
  static async listen(descriptors: ToolDescriptor[]): Promise<ToolHost> {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-codex-"));
    const socketPath = join(dir, "bridge.sock");
    const server = createServer();
    const host = new ToolHost(descriptors, server, socketPath);
    server.on("connection", (socket) => host.#serve(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    return host;
  }

  close(): void {
    this.#server.close();
  }

  #serve(socket: Socket): void {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {
      // A bridge dying mid-call is normal at turn end; the pending handler
      // result is simply unwritable then.
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE_BYTES) {
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
    try {
      request = JSON.parse(line) as BridgeRequest;
    } catch {
      return; // unparseable frame: drop, the bridge will time out its call
    }
    const reply = (payload: Record<string, unknown>): void => {
      if (!socket.destroyed) {
        socket.write(`${JSON.stringify({ id: request.id, ...payload })}\n`);
      }
    };
    if (request.method === "list_tools") {
      reply({
        tools: [...this.#descriptors.values()].map((d) => ({
          name: d.name,
          description: d.description,
          inputSchema: d.inputSchema,
        })),
      });
      return;
    }
    if (request.method === "call_tool") {
      const descriptor = this.#descriptors.get(request.name);
      if (!descriptor) {
        reply({ error: `unknown tool: ${request.name}` });
        return;
      }
      try {
        const result = await descriptor.handler(request.input ?? {});
        reply({ result });
      } catch (err) {
        reply({ error: String(err) });
      }
      return;
    }
    reply({ error: "unknown method" });
  }
}
