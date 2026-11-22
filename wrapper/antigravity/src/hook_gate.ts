import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallVerifier } from "./call_verification.js";
import type { StopRequest } from "./stop_answer.js";

export interface PreToolUseRequest {
  conversationId: string;
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface HookGateHandlers {
  /** `signal` aborts when the hook connection closes before the answer. */
  preToolUse: (
    request: PreToolUseRequest,
    signal: AbortSignal,
  ) => Promise<{ decision: "allow" | "deny"; reason?: string }>;
  stop: (request: StopRequest) => { decision: "continue"; reason: string } | { decision: "stop" };
}

export interface HookGateServerOptions {
  nonce?: string;
  verifier: CallVerifier;
  handlers: HookGateHandlers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The unix socket the hook command of one generation reaches, one JSON line
 *  per connection. PreToolUse requests are recorded for verification before
 *  they are decided; a Stop request is answered at once. */
export class HookGateServer {
  readonly #server: Server;
  readonly #dir: string;
  readonly nonce: string;
  readonly socketPath: string;
  readonly #verifier: CallVerifier;
  readonly #handlers: HookGateHandlers;
  readonly #sockets = new Set<Socket>();

  private constructor(server: Server, dir: string, options: HookGateServerOptions) {
    this.#server = server;
    this.#dir = dir;
    this.nonce = options.nonce ?? randomUUID();
    this.socketPath = join(dir, "gate.sock");
    this.#verifier = options.verifier;
    this.#handlers = options.handlers;
  }

  static async listen(options: HookGateServerOptions): Promise<HookGateServer> {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-agy-gate-"));
    const server = createServer();
    const gate = new HookGateServer(server, dir, options);
    server.on("connection", (socket) => gate.#serve(socket));
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(gate.socketPath, () => {
        server.removeListener("error", reject);
        resolveListen();
      });
    });
    return gate;
  }

  /** Closes every connection; a pending hook fails closed in its client. */
  close(): void {
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    this.#server.close();
    rmSync(this.#dir, { recursive: true, force: true });
  }

  #serve(socket: Socket): void {
    let buffer = "";
    let handled = false;
    const closed = new AbortController();
    this.#sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("close", () => {
      this.#sockets.delete(socket);
      closed.abort();
    });
    socket.on("data", (chunk: string) => {
      if (handled) return;
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      handled = true;
      void this.#handleLine(socket, buffer.slice(0, newline), closed.signal);
    });
  }

  async #handleLine(socket: Socket, line: string, closed: AbortSignal): Promise<void> {
    let request: unknown;
    try { request = JSON.parse(line); } catch { request = undefined; }
    if (!isRecord(request) || request.nonce !== this.nonce || typeof request.conversationId !== "string") {
      reply(socket, { decision: "deny", reason: "kaoiro: invalid gate request" });
      return;
    }
    if (request.hookEventName === "Stop") {
      reply(socket, this.#handlers.stop({
        conversationId: request.conversationId,
        terminationReason: request.terminationReason,
        fullyIdle: request.fullyIdle,
      }));
    } else {
      await this.#preToolUse(socket, request, request.conversationId, closed);
    }
  }

  async #preToolUse(
    socket: Socket,
    request: Record<string, unknown>,
    conversationId: string,
    closed: AbortSignal,
  ): Promise<void> {
    const toolCall = request.toolCall;
    if (
      request.hookEventName !== "PreToolUse" ||
      !isRecord(toolCall) ||
      typeof toolCall.id !== "string" ||
      typeof toolCall.name !== "string" ||
      !isRecord(toolCall.args)
    ) {
      reply(socket, { decision: "deny", reason: "kaoiro: invalid gate request" });
      return;
    }
    const call: PreToolUseRequest = {
      conversationId,
      callId: toolCall.id,
      name: toolCall.name,
      args: toolCall.args,
    };
    if (!this.#verifier.hookReceived(call.conversationId, call.callId, call.name, call.args)) {
      reply(socket, { decision: "deny", reason: "kaoiro: duplicate tool call" });
      return;
    }
    let answer: { decision: "allow" | "deny"; reason?: string };
    try {
      answer = await this.#handlers.preToolUse(call, closed);
    } catch {
      answer = { decision: "deny", reason: "kaoiro: gate failure" };
    }
    reply(socket, answer, (written) => {
      if (written) this.#verifier.hookDecided(call.conversationId, call.callId, answer.decision);
      else this.#verifier.hookAbandoned(call.conversationId, call.callId);
    });
  }
}

/** `done` learns whether the answer reached the socket without error; it
 *  can hear of an error after a success, which the verifier ignores. */
function reply(socket: Socket, answer: unknown, done: (written: boolean) => void = () => {}): void {
  if (socket.destroyed) done(false);
  else {
    socket.once("error", () => done(false));
    socket.end(`${JSON.stringify(answer)}\n`, (error?: Error | null) => done(error == null));
  }
}
