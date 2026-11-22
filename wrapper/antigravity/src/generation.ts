import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type * as acp from "@agentclientprotocol/sdk";
import { connectAcp, type AcpWriteResult } from "@kaoiro/agent-common/dist/acp/connection.js";
import { AcpSession } from "@kaoiro/agent-common/dist/acp/session.js";

/** The `agy acp` child as the host needs it. */
export type AcpAgyChild = Pick<
  ChildProcessWithoutNullStreams,
  "stdin" | "stdout" | "stderr" | "pid" | "exitCode" | "signalCode" | "kill" | "once" | "on" | "off"
>;

export interface GenerationHandlers {
  update: (notification: acp.SessionNotification) => void;
  /** `agy` asked for a permission; it is answered `cancelled`. */
  permissionRequest: () => void;
  /** Each JSON-RPC write the connection attempted, with its outcome. */
  write: (result: AcpWriteResult) => void;
  /** The session/prompt line is about to be written. */
  promptAttempted: () => void;
  /** The child process failed (spawn or signal error). */
  error: (error: Error) => void;
}

export interface AttachOptions {
  cwd: string;
  mcpServers: acp.McpServer[];
  resumeSessionId?: string | undefined;
  systemPromptAppend: string;
}

export interface Attached {
  /** The session the generation is attached to; hooks carry it as their
   *  conversation ID. */
  sessionId: string;
  /** Set only when the engine itself reported the ID: the `session/new`
   *  response, or the ID a `session/resume` response echoed. */
  observedSessionId: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One `agy acp` process with its ACP connection. It serves one prompt and is
 *  never reused. */
export class Generation {
  readonly serial: number;
  readonly child: AcpAgyChild;
  readonly session: AcpSession;
  readonly connection: acp.ClientConnection;
  /** Resolves once the child exited. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  #resumeRequestId: unknown;
  #echoedSessionId: string | undefined;
  #exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;

  constructor(serial: number, child: AcpAgyChild, handlers: GenerationHandlers) {
    this.serial = serial;
    this.child = child;
    this.exited = new Promise((resolve) => {
      child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        this.#exit = { code, signal };
        resolve(this.#exit);
      });
    });
    child.on("error", handlers.error);
    // Diagnostics must not fill the pipe; no stderr text is forwarded.
    child.stderr.resume();
    this.connection = connectAcp(child as ChildProcessWithoutNullStreams, {
      update: handlers.update,
      permission: async () => {
        handlers.permissionRequest();
        return { outcome: { outcome: "cancelled" } };
      },
      metadata: () => {},
    }, {
      onWrite: handlers.write,
      // The SDK's resume response type has no session ID, so the echo is read
      // off the wire: the outgoing request names the ID to match.
      wireFields: (message) => {
        // Only the client sends these two methods, so the direction is known.
        if (message.method === "session/prompt") handlers.promptAttempted();
        if (message.method === "session/resume") this.#resumeRequestId = message.id;
        else if (
          message.method === undefined &&
          this.#resumeRequestId !== undefined &&
          message.id === this.#resumeRequestId &&
          isRecord(message.result) &&
          typeof message.result.sessionId === "string"
        ) {
          this.#echoedSessionId = message.result.sessionId;
        }
        return {};
      },
    });
    this.session = new AcpSession(this.connection);
  }

  get exit(): { code: number | null; signal: NodeJS.Signals | null } | undefined {
    return this.#exit;
  }

  async attach(options: AttachOptions): Promise<Attached> {
    await this.session.initialize();
    if (options.resumeSessionId !== undefined) {
      await this.session.resume(options.resumeSessionId, options.cwd, options.mcpServers);
      return { sessionId: options.resumeSessionId, observedSessionId: this.#echoedSessionId };
    }
    const response = await this.session.newSession(options.cwd, options.mcpServers, {
      antigravity: { systemPrompt: { append: options.systemPromptAppend } },
    });
    return { sessionId: response.sessionId, observedSessionId: response.sessionId };
  }
}
