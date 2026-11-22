// Every request must pass screening before its body is read.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type * as acp from "@agentclientprotocol/sdk";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js";
import {
  handoffToolResult,
  discardToolResult,
  type ReplyOrigin,
} from "./reply_basis.js";
import type { ToolDescriptor } from "./tooling.js";

/** Bounds one request body; far above any real tool input (the biggest is
 *  ask_user_question's 4 questions x 4 options). */
const MAX_BODY_BYTES = 1024 * 1024;
const MCP_PATH = "/mcp";
export const MCP_NOT_CONNECTED = "kaoiro MCP server did not connect";

export const BODY_TOO_LARGE = Symbol("body too large");
/** Reads a request body, or gives up with BODY_TOO_LARGE once it passes
 *  `limit`. A parameter of the host so a test can count the reads. */
export type BodyReader = (
  request: IncomingMessage,
  limit: number,
) => Promise<Buffer | typeof BODY_TOO_LARGE>;

export interface ToolHostOptions {
  resolveOrigin?: (
    metadata: unknown,
  ) => ReplyOrigin | undefined | Promise<ReplyOrigin | undefined>;
  /** A request spans turns, so each call also follows the active turn
   * lifetime. Calls outside a turn receive an already-aborted signal. */
  turnSignal?: () => AbortSignal | null;
  bodyReader?: BodyReader;
}

export interface ToolHostStats {
  url: string;
  /** `tools/list` calls that passed every check. */
  authenticatedLists: number;
  /** `tools/call` handler invocations. */
  calls: number;
  /** Requests turned away, by response status. */
  rejected: Record<number, number>;
}

interface Rejection {
  status: number;
  headers?: Record<string, string>;
  message: string;
  code: number;
}

class StaleToolCall extends Error {
  constructor() {
    super("stale_tool_call");
  }
}

export const readBoundedBody: BodyReader = (request, limit) =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const stop = (): void => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      request.removeListener("close", onClose);
    };
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > limit) {
        stop();
        request.pause();
        resolve(BODY_TOO_LARGE);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      stop();
      resolve(Buffer.concat(chunks));
    };
    const onError = (error: Error): void => {
      stop();
      reject(error);
    };
    const onClose = (): void => {
      stop();
      reject(new Error("request closed before its body ended"));
    };
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("close", onClose);
  });

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export class ToolHost {
  readonly #descriptors: Map<string, ToolDescriptor>;
  readonly #server: HttpServer;
  readonly #options: ToolHostOptions;
  readonly #token: string;
  readonly #tokenDigest: Buffer;
  #authority = "";
  #url = "";
  /** The abort controller of every request still being answered. */
  readonly #requests = new Set<AbortController>();
  readonly #rejected: Record<number, number> = {};
  readonly #listWaiters = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  #lists = 0;
  #calls = 0;
  #closed = false;

  private constructor(
    descriptors: ToolDescriptor[],
    options: ToolHostOptions,
  ) {
    this.#descriptors = new Map(descriptors.map((d) => [d.name, d]));
    this.#options = options;
    // 32 random bytes; held in memory only, for the life of this host.
    this.#token = randomBytes(32).toString("base64url");
    this.#tokenDigest = digest(this.#token);
    this.#server = createServer((request, response) => {
      void this.#handle(request, response, false);
    });
    // An `Expect: 100-continue` request must not be invited to send its body
    // before the checks have passed.
    this.#server.on("checkContinue", (request, response) => {
      void this.#handle(request, response, true);
    });
  }

  /** Listens on 127.0.0.1 at a free port. The literal address avoids name
   *  resolution and IPv6 differences. */
  static async listen(
    descriptors: ToolDescriptor[],
    options: ToolHostOptions = {},
  ): Promise<ToolHost> {
    const host = new ToolHost(descriptors, options);
    await new Promise<void>((resolve, reject) => {
      host.#server.once("error", reject);
      host.#server.listen(0, "127.0.0.1", () => {
        host.#server.removeListener("error", reject);
        resolve();
      });
    });
    const { port } = host.#server.address() as AddressInfo;
    host.#authority = `127.0.0.1:${port}`;
    host.#url = `http://${host.#authority}${MCP_PATH}`;
    return host;
  }

  /** The `mcpServers` entry for ACP. The URL carries no secret, because clients
   *  can persist MCP server URLs; the token rides in a header. */
  mcpServer(): acp.McpServerHttp & { type: "http" } {
    return {
      type: "http",
      name: "kaoiro",
      url: this.#url,
      headers: [{ name: "Authorization", value: `Bearer ${this.#token}` }],
    };
  }

  stats(): ToolHostStats {
    return {
      url: this.#url,
      authenticatedLists: this.#lists,
      calls: this.#calls,
      rejected: { ...this.#rejected },
    };
  }

  /** Resolves after the first `tools/list` that passed every check, which
   *  confirms the client connected. Rejects after `timeoutMs`, or when
   *  the host closes first. */
  listed(timeoutMs: number): Promise<void> {
    if (this.#lists > 0) return Promise.resolve();
    if (this.#closed) return Promise.reject(new Error(MCP_NOT_CONNECTED));
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(waiter.timer);
          this.#listWaiters.delete(waiter);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(waiter.timer);
          this.#listWaiters.delete(waiter);
          reject(error);
        },
        timer: setTimeout(
          () => waiter.reject(new Error(MCP_NOT_CONNECTED)),
          timeoutMs,
        ),
      };
      this.#listWaiters.add(waiter);
    });
  }

  /** Stops listening AND severs every open connection and aborts every call
   *  in flight, so a handler still waiting on the operator cannot deliver its
   *  result, and act, after the host was told to shut down (issue #347). */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#requests) controller.abort();
    this.#requests.clear();
    this.#server.close();
    this.#server.closeAllConnections();
    for (const waiter of [...this.#listWaiters]) {
      waiter.reject(new Error(MCP_NOT_CONNECTED));
    }
  }

  /** The checks that decide a request from its line and headers alone, in
   *  order; the first to fail decides the response. 403 comes before 401
   *  because the Host and Origin checks need no secret: a browser or a DNS
   *  rebinding page is refused the same way whether or not it guessed a token. */
  #screen(request: IncomingMessage): Rejection | undefined {
    // Exactly the listener's own authority: no DNS name (`localhost` too), and
    // no other port.
    if (request.headers.host !== this.#authority) {
      return { status: 403, message: "forbidden", code: -32002 };
    }
    // The native MCP client sends no Origin, so no value is legitimate here, and
    // `null` is not either. This is what stops a page in a browser.
    if (request.headers.origin !== undefined) {
      return { status: 403, message: "forbidden", code: -32002 };
    }
    if (!this.#authorized(request.headers.authorization)) {
      return {
        status: 401,
        headers: { "WWW-Authenticate": "Bearer" },
        message: "unauthorized",
        code: -32001,
      };
    }
    if (request.url !== MCP_PATH) {
      return { status: 404, message: "not found", code: -32004 };
    }
    if (request.method !== "POST") {
      return {
        status: 405,
        headers: { Allow: "POST" },
        message: "method not allowed",
        code: -32005,
      };
    }
    const declared = request.headers["content-length"];
    if (declared !== undefined && Number(declared) > MAX_BODY_BYTES) {
      return { status: 413, message: "payload too large", code: -32006 };
    }
    return undefined;
  }

  /** Compares hashes, so a token of any length is checked in the same way and
   *  neither throws nor returns early. */
  #authorized(header: string | undefined): boolean {
    const match = /^Bearer (\S+)$/.exec(header ?? "");
    const presented = digest(match?.[1] ?? "");
    return timingSafeEqual(presented, this.#tokenDigest) && match !== null;
  }

  #reject(response: ServerResponse, rejection: Rejection): void {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: rejection.code, message: rejection.message },
    });
    this.#rejected[rejection.status] =
      (this.#rejected[rejection.status] ?? 0) + 1;
    // The body, if any, is not read; closing the connection after the answer
    // ends it.
    response.writeHead(rejection.status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      Connection: "close",
      ...rejection.headers,
    });
    response.end(body);
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
    expectsContinue: boolean,
  ): Promise<void> {
    try {
      const rejection = this.#screen(request);
      if (rejection) {
        this.#reject(response, rejection);
        return;
      }
      if (expectsContinue) response.writeContinue();
      const reader = this.#options.bodyReader ?? readBoundedBody;
      const body = await reader(request, MAX_BODY_BYTES);
      if (body === BODY_TOO_LARGE) {
        this.#reject(response, {
          status: 413,
          message: "payload too large",
          code: -32006,
        });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        this.#reject(response, {
          status: 400,
          message: "parse error",
          code: -32700,
        });
        return;
      }
      await this.#serve(request, response, parsed);
    } catch {
      // A client that went away mid-request: nothing to answer.
      if (!response.headersSent && !response.destroyed) {
        this.#reject(response, {
          status: 500,
          message: "internal error",
          code: -32603,
        });
      }
    }
  }

  /** One MCP server and a stateless transport per request: no session id, JSON
   *  responses. */
  async #serve(
    request: IncomingMessage,
    response: ServerResponse,
    body: unknown,
  ): Promise<void> {
    const controller = new AbortController();
    this.#requests.add(controller);
    const server = new McpServer(
      { name: "kaoiro", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      this.#lists += 1;
      for (const waiter of [...this.#listWaiters]) waiter.resolve();
      return {
        tools: [...this.#descriptors.values()].map((d) => ({
          name: d.name,
          description: d.description,
          inputSchema: d.inputSchema as never,
        })),
      };
    });
    server.setRequestHandler(CallToolRequestSchema, (call) =>
      this.#call(call, controller.signal),
    );
    // No `sessionIdGenerator`: stateless, one request per transport.
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    response.on("close", () => {
      if (!response.writableFinished) controller.abort();
      this.#requests.delete(controller);
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
    // The SDK class declares `onclose` as optional in a way the strict option
    // typing of this package does not accept for its own interface.
    await server.connect(transport as Transport);
    await transport.handleRequest(request, response, body);
  }

  /** The signal a call's handler sees: its request OR the active turn. */
  #callSignal(requestSignal: AbortSignal): AbortSignal {
    const turn = this.#options.turnSignal?.();
    if (turn === undefined) return requestSignal;
    if (turn === null) return AbortSignal.abort();
    return AbortSignal.any([requestSignal, turn]);
  }

  async #call(
    call: CallToolRequest,
    requestSignal: AbortSignal,
  ): Promise<never> {
    const descriptor = this.#descriptors.get(call.params.name);
    if (!descriptor) throw new Error(`unknown tool: ${call.params.name}`);
    this.#calls += 1;
    try {
      const callSignal = this.#callSignal(requestSignal);
      const origin = await this.#options.resolveOrigin?.(call.params._meta);
      const result = await descriptor.handler(call.params.arguments ?? {}, {
        signal: callSignal,
        ...(origin
          ? {
              origin: {
                ...origin,
                signal: AbortSignal.any([
                  callSignal,
                  ...(origin.signal ? [origin.signal] : []),
                ]),
              },
            }
          : {}),
      });
      if (requestSignal.aborted) {
        discardToolResult(result);
        throw new Error("tool call aborted");
      }
      if (callSignal.aborted && descriptor.name === "send_to_agent") {
        discardToolResult(result);
        throw new StaleToolCall();
      }
      try {
        JSON.stringify(result);
      } catch (error) {
        discardToolResult(result);
        throw error;
      }
      // The answer is written by the transport after this returns; the handoff
      // commits here, as the Claude in-process MCP server does.
      if (!handoffToolResult(result, () => {})) throw new StaleToolCall();
      return result as never;
    } catch (error) {
      if (error instanceof StaleToolCall) throw error;
      throw new Error(String(error));
    }
  }
}
