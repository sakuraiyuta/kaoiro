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

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { handoffToolResult, discardToolResult, type ToolDescriptor, type ReplyOrigin } from "@kaoiro/agent-common";

/** Bounds one request line; far above any real tool input (the biggest is
 *  ask_user_question's 4 questions x 4 options). */
const MAX_LINE_BYTES = 1024 * 1024;

export interface ToolHostOptions {
  resolveOrigin?: (metadata: unknown) => ReplyOrigin | undefined | Promise<ReplyOrigin | undefined>;
  /** The signal of the engine turn currently executing, or null when none
   *  is. Each call's handler context aborts when EITHER this turn signal or
   *  the bridge connection aborts (issue #347 M2): the socket outlives the
   *  call — codex keeps one bridge per turn and never forwards MCP
   *  cancellation — so connection close alone would let a late operator
   *  answer act on behalf of a turn that already ended. A call arriving
   *  with no active turn gets an already-aborted signal. */
  turnSignal?: () => AbortSignal | null;
}

interface ListToolsRequest {
  id: number;
  method: "list_tools";
}
interface CallToolRequest {
  id: number;
  method: "call_tool";
  name: string;
  input?: Record<string, unknown>;
  metadata?: unknown;
}
type BridgeRequest = ListToolsRequest | CallToolRequest;

export class ToolHost {
  readonly #descriptors: Map<string, ToolDescriptor>;
  readonly #server: Server;
  readonly #options: ToolHostOptions;
  /** Live bridge connections and the controller each one's calls hang off. */
  readonly #connections = new Map<Socket, AbortController>();
  readonly socketPath: string;

  private constructor(
    descriptors: ToolDescriptor[],
    server: Server,
    socketPath: string,
    options: ToolHostOptions,
  ) {
    this.#descriptors = new Map(descriptors.map((d) => [d.name, d]));
    this.#server = server;
    this.socketPath = socketPath;
    this.#options = options;
  }

  /** Creates the socket in a fresh private tmp dir (0700 by mkdtemp) and
   *  starts listening. The path rides to the bridge via mcp_servers env. */
  static async listen(
    descriptors: ToolDescriptor[],
    options: ToolHostOptions = {},
  ): Promise<ToolHost> {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-codex-"));
    const socketPath = join(dir, "bridge.sock");
    const server = createServer();
    const host = new ToolHost(descriptors, server, socketPath, options);
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

  /** Stops listening AND severs every live bridge connection. `Server#close`
   *  alone keeps accepted sockets open, so a handler still waiting on the
   *  operator could deliver its result — and act — after the host was told
   *  to shut down (measured in review of issue #347). */
  close(): void {
    this.#server.close(() => { rmSync(dirname(this.socketPath), { recursive: true, force: true }); });
    for (const [socket, controller] of this.#connections) {
      this.#connections.delete(socket);
      controller.abort();
      socket.destroy();
    }
  }

  #serve(socket: Socket): void {
    let buffer = "";
    const controller = new AbortController();
    this.#connections.set(socket, controller);
    socket.setEncoding("utf8");
    socket.on("error", () => {
      // A bridge dying mid-call is normal at turn end; the pending handler
      // result is simply unwritable then.
    });
    socket.on("close", () => {
      this.#connections.delete(socket);
      controller.abort();
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
        if (line.trim() !== "") {
          void this.#handleLine(socket, controller.signal, line);
        }
        newline = buffer.indexOf("\n");
      }
    });
  }

  /** The signal a call's handler sees: connection OR active turn. */
  #callSignal(connection: AbortSignal): AbortSignal {
    const turn = this.#options.turnSignal?.();
    if (turn === undefined) return connection;
    if (turn === null) return AbortSignal.abort();
    return AbortSignal.any([connection, turn]);
  }

  async #handleLine(
    socket: Socket,
    connection: AbortSignal,
    line: string,
  ): Promise<void> {
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
        const callSignal = this.#callSignal(connection);
        const origin = await this.#options.resolveOrigin?.(request.metadata);
        const result = await descriptor.handler(request.input ?? {}, {
          signal: callSignal,
          ...(origin ? { origin: { ...origin, signal: AbortSignal.any([callSignal, ...(origin.signal ? [origin.signal] : [])]) } } : {}),
        });
        if (socket.destroyed) { discardToolResult(result); return; }
        if (callSignal.aborted && descriptor.name === "send_to_agent") { discardToolResult(result); reply({ error: "stale_tool_call" }); return; }
        let serialized: string;
        try { serialized = JSON.stringify({ id: request.id, result }) + "\n"; } catch (error) { discardToolResult(result); throw error; }
        if (!handoffToolResult(result, () => { socket.write(serialized); })) reply({ error: "stale_tool_call" });
      } catch (err) {
        reply({ error: String(err) });
      }
      return;
    }
    reply({ error: "unknown method" });
  }
}
