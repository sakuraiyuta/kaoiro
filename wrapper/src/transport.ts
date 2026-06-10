// Server link — pushes envelopes to the kaoiro server over Phoenix Channels
// (ADR-0009: Channels only, wire vsn=2.0.0, which the official client speaks).
// The phoenix client owns reconnect/heartbeat; pushes made while disconnected
// are buffered and flushed on rejoin.

import { Channel, Socket } from "phoenix";
import type { Envelope } from "./types.js";

export class ServerLink {
  readonly #socket: Socket;
  readonly #channel: Channel;

  /**
   * @param serverUrl Socket endpoint, e.g. "ws://localhost:4000/wrapper"
   *   (the client appends "/websocket").
   * @param agentId Stable agent id; the channel topic is `wrapper:<agentId>`.
   */
  constructor(serverUrl: string, agentId: string) {
    this.#socket = new Socket(serverUrl, { transport: WebSocket });
    this.#socket.connect();
    this.#channel = this.#socket.channel(`wrapper:${agentId}`);
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

  /** Pushes one envelope; buffered by the client while disconnected. */
  send(envelope: Envelope): void {
    this.#channel.push("envelope", envelope);
  }

  /** Leaves the channel and closes the socket. */
  close(): void {
    this.#channel.leave();
    this.#socket.disconnect();
  }
}
