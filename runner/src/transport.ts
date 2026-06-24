// Runner link — the host's resident runner connects to the kaoiro server over
// Phoenix Channels (ADR-0009, wire vsn=2.0.0) on the control topic
// `runner:<host_id>` (ADR-0023), a separate system from the wrapper data path.
// The phoenix client owns reconnect/heartbeat at the transport level; this
// class drives the application-level protocol: it (re-)registers the host on
// every (re)connect and sends a periodic `heartbeat` so the server's
// HostRegistry keeps the host live.

import { Channel, Socket } from "phoenix";
import type {
  RunnerRegister,
  RunnerSessions,
  SpawnResult,
} from "@kaoiro/protocol";
import { buildHeartbeat } from "./config.js";

export interface RunnerLinkOptions {
  /** Per-host runner auth token (ADR-0023), sent as a connect param. Omitted
   *  when the server runs with runner auth disabled (dev). */
  token?: string;
  /** The `register` message, re-sent on every (re)connect since the server
   *  keeps host state in memory only (a server restart empties it). */
  register: RunnerRegister;
  /** Liveness ping interval in ms. */
  heartbeatMs: number;
  /** Operator lifecycle control relayed by the server (ADR-0023). Payloads are
   *  opaque here — the supervisor validates them. */
  onSpawn?: (payload: unknown) => void;
  onStop?: (payload: unknown) => void;
  onRestart?: (payload: unknown) => void;
  onEnumerateSessions?: (payload: unknown) => void;
}

export class RunnerLink {
  readonly #socket: Socket;
  readonly #channel: Channel;
  readonly #hostId: string;
  readonly #heartbeat: ReturnType<typeof setInterval>;

  /**
   * @param serverUrl Runner socket endpoint, e.g. "ws://localhost:4000/runner"
   *   (the client appends "/websocket").
   * @param hostId Stable host id; the channel topic is `runner:<hostId>`.
   */
  constructor(serverUrl: string, hostId: string, options: RunnerLinkOptions) {
    this.#hostId = hostId;
    this.#socket = new Socket(serverUrl, {
      transport: WebSocket,
      params: options.token === undefined ? {} : { token: options.token },
    });
    this.#socket.connect();
    this.#channel = this.#socket.channel(`runner:${hostId}`);

    // Re-register on every socket (re)open: the server holds host state in
    // memory, so a reconnect after a deploy must re-announce. The push is
    // buffered by the client until the channel rejoins (mirrors the wrapper's
    // ServerLink re-announce).
    this.#socket.onOpen(() => {
      this.#channel
        .push("register", options.register)
        .receive("ok", () => {
          process.stderr.write(`runner: registered host=${this.#hostId}\n`);
        })
        .receive("error", (reason: unknown) => {
          process.stderr.write(
            `runner: register rejected: ${JSON.stringify(reason)}\n`,
          );
        });
    });

    // Operator lifecycle control, relayed by the server onto this topic
    // (ADR-0023). Payloads are forwarded opaquely to the supervisor, which
    // validates them.
    this.#channel.on("spawn", (payload: unknown) => options.onSpawn?.(payload));
    this.#channel.on("stop", (payload: unknown) => options.onStop?.(payload));
    this.#channel.on("restart", (payload: unknown) =>
      options.onRestart?.(payload),
    );
    this.#channel.on("enumerate_sessions", (payload: unknown) =>
      options.onEnumerateSessions?.(payload),
    );

    this.#channel
      .join()
      .receive("error", (reason: unknown) => {
        process.stderr.write(
          `RunnerLink join error: ${JSON.stringify(reason)}\n`,
        );
      })
      .receive("timeout", () => {
        process.stderr.write("RunnerLink join timeout\n");
      });

    // Liveness only while connected: pushing on a dead socket would just
    // pile up in the buffer to flush as a burst on reconnect.
    this.#heartbeat = setInterval(() => {
      if (this.#socket.isConnected()) {
        this.#channel.push("heartbeat", buildHeartbeat(this.#hostId));
      }
    }, options.heartbeatMs);
  }

  /** Reports a spawn outcome back to the operators (via the server). */
  sendSpawnResult(result: SpawnResult): void {
    this.#channel.push("spawn_result", result);
  }

  /** Replies to enumerate_sessions with the resume candidates. */
  sendSessions(sessions: RunnerSessions): void {
    this.#channel.push("sessions", sessions);
  }

  /** Stops heartbeating, leaves the channel and closes the socket. */
  close(): void {
    clearInterval(this.#heartbeat);
    this.#channel.leave();
    this.#socket.disconnect();
  }
}
