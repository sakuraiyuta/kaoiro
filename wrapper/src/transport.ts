// Server link — pushes envelopes to the kaoiro server over Phoenix Channels
// (ADR-0009: Channels only, wire vsn=2.0.0, which the official client speaks).
// The phoenix client owns reconnect/heartbeat; pushes made while disconnected
// are buffered and flushed on rejoin. Outbound envelopes get the wrapper's
// monotonic seq here (ADR-0011: one assignment point for the whole series);
// inbound pushes (instruction / permission_decision, protocol.md) are
// validated structurally and forwarded to the handlers.

import { Channel, Socket } from "phoenix";
import type { PermissionDecisionMessage } from "./permission.js";
import type { Envelope } from "./types.js";

export interface ServerLinkOptions {
  /** Wrapper auth token (ADR-0011), sent as a connect param. */
  token?: string;
  /** An operator's instruction relayed by the server. */
  onInstruction?: (text: string) => void;
  /** An operator's permission decision relayed by the server. */
  onPermissionDecision?: (decision: PermissionDecisionMessage) => void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class ServerLink {
  readonly #socket: Socket;
  readonly #channel: Channel;
  #seq = 0;
  #lastEnvelope: Envelope | null = null;

  /**
   * @param serverUrl Socket endpoint, e.g. "ws://localhost:4000/wrapper"
   *   (the client appends "/websocket").
   * @param agentId Stable agent id; the channel topic is `wrapper:<agentId>`.
   */
  constructor(
    serverUrl: string,
    agentId: string,
    options: ServerLinkOptions = {},
  ) {
    this.#socket = new Socket(serverUrl, {
      transport: WebSocket,
      params: options.token === undefined ? {} : { token: options.token },
    });
    this.#socket.connect();
    this.#channel = this.#socket.channel(`wrapper:${agentId}`);

    this.#channel.on("instruction", (payload: unknown) => {
      if (isObject(payload) && typeof payload.text === "string") {
        options.onInstruction?.(payload.text);
      }
    });
    this.#channel.on("permission_decision", (payload: unknown) => {
      if (
        isObject(payload) &&
        typeof payload.request_id === "string" &&
        typeof payload.allow === "boolean"
      ) {
        const decision: PermissionDecisionMessage = {
          request_id: payload.request_id,
          allow: payload.allow,
        };
        if (typeof payload.message === "string") {
          decision.message = payload.message;
        }
        options.onPermissionDecision?.(decision);
      }
    });

    // Re-announce the latest state after a reconnect: the server keeps
    // agent state in memory only, so a restart (deploy) empties the
    // snapshot, and an agent absent from it cannot receive instructions.
    // On the first open #lastEnvelope is null (no-op); on reconnects the
    // push is buffered by the client until the channel rejoins. send()
    // stamps a fresh seq.
    this.#socket.onOpen(() => {
      if (this.#lastEnvelope) this.send(this.#lastEnvelope);
    });

    // Surface join failures; the client retries the join on its own, but a
    // silent rejection would otherwise leave sends buffering unnoticed.
    this.#channel
      .join()
      .receive("error", (reason: unknown) => {
        process.stderr.write(
          `ServerLink join error: ${JSON.stringify(reason)}\n`,
        );
      })
      .receive("timeout", () => {
        process.stderr.write("ServerLink join timeout\n");
      });
  }

  /** Pushes one envelope with the next seq; buffered while disconnected. */
  send(envelope: Envelope): void {
    this.#lastEnvelope = envelope;
    this.#seq += 1;
    this.#channel.push("envelope", { ...envelope, seq: this.#seq });
  }

  /** Leaves the channel and closes the socket. */
  close(): void {
    this.#channel.leave();
    this.#socket.disconnect();
  }
}
