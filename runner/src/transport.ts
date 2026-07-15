// Runner link — the host's resident runner connects to the kaoiro server over
// Phoenix Channels (ADR-0009, wire vsn=2.0.0) on the control topic
// `runner:<host_id>` (ADR-0023), a separate system from the wrapper data path.
// The phoenix client owns reconnect/heartbeat at the transport level; this
// class drives the application-level protocol: it (re-)registers the host on
// every (re)connect and sends a periodic `heartbeat` so the server's
// HostRegistry keeps the host live.

import { Channel, Socket } from "phoenix";
import type {
  EngineCatalogResult,
  RunnerRegister,
  RunnerSessions,
  SessionResetResult,
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
  onSwitchSession?: (payload: unknown) => void;
  /** phase-17 17-5: server → runner session_reset command. Payload is
   *  opaque here (the supervisor validates); it carries agent_id / mode /
   *  request_id / previous_session_id. */
  onResetSession?: (payload: unknown) => void;
  /** phase-20 (ADR-0039): server → runner request for a live engine-catalog
   *  probe (LaunchDialog manual button + cache-miss auto-refresh). Payload
   *  is opaque here; the orchestrator validates and dedups. */
  onRefreshEngineCatalog?: (payload: unknown) => void;
}

// exactOptionalPropertyTypes: true 下では、`Pick<RunnerLinkOptions, ...>` の
// optional な key に `undefined` を代入できない。ここは "常に該当 key を持ち、
// 値は関数 or undefined" が意図なので、明示的に `| undefined` を含める。
type ChannelCallback = (payload: unknown) => void;
interface ChannelCallbacks {
  onSpawn: ChannelCallback | undefined;
  onStop: ChannelCallback | undefined;
  onRestart: ChannelCallback | undefined;
  onEnumerateSessions: ChannelCallback | undefined;
  onSwitchSession: ChannelCallback | undefined;
  onResetSession: ChannelCallback | undefined;
  onRefreshEngineCatalog: ChannelCallback | undefined;
}

export class RunnerLink {
  #socket: Socket;
  #channel: Channel;
  #hostId: string;
  #register: RunnerRegister;
  readonly #token: string | undefined;
  readonly #callbacks: ChannelCallbacks;
  readonly #heartbeat: ReturnType<typeof setInterval>;

  /**
   * @param serverUrl Runner socket endpoint, e.g. "ws://localhost:4000/runner"
   *   (the client appends "/websocket").
   * @param hostId Stable host id; the channel topic is `runner:<hostId>`.
   */
  constructor(serverUrl: string, hostId: string, options: RunnerLinkOptions) {
    this.#hostId = hostId;
    this.#register = options.register;
    this.#token = options.token;
    this.#callbacks = {
      onSpawn: options.onSpawn,
      onStop: options.onStop,
      onRestart: options.onRestart,
      onEnumerateSessions: options.onEnumerateSessions,
      onSwitchSession: options.onSwitchSession,
      onResetSession: options.onResetSession,
      onRefreshEngineCatalog: options.onRefreshEngineCatalog,
    };
    const wired = this.#wire(serverUrl, hostId);
    this.#socket = wired.socket;
    this.#channel = wired.channel;

    // Liveness only while connected: pushing on a dead socket would just
    // pile up in the buffer to flush as a burst on reconnect. Reads
    // #socket / #channel / #hostId on every tick so a mid-flight reconnect
    // starts pinging the new channel without touching the interval.
    this.#heartbeat = setInterval(() => {
      if (this.#socket.isConnected()) {
        this.#channel.push("heartbeat", buildHeartbeat(this.#hostId));
      }
    }, options.heartbeatMs);
  }

  /** Builds a socket + channel + join for the given (serverUrl, hostId).
   *  Callbacks come from `this.#callbacks` and the register payload from
   *  `this.#register`, so a reconnect uses the values current AT the moment
   *  the reconnect fires — not the ones captured in the constructor. */
  #wire(serverUrl: string, hostId: string): { socket: Socket; channel: Channel } {
    const socket = new Socket(serverUrl, {
      transport: WebSocket,
      params: this.#token === undefined ? {} : { token: this.#token },
    });
    socket.connect();
    const channel = socket.channel(`runner:${hostId}`);

    // Re-register on every socket (re)open: the server holds host state in
    // memory, so a reconnect after a deploy must re-announce. The push is
    // buffered by the client until the channel rejoins (mirrors the wrapper's
    // ServerLink re-announce). Reads `this.#register` on every open so a
    // mid-connection updateRegister rides the next re-announce too.
    socket.onOpen(() => {
      channel
        .push("register", this.#register)
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
    channel.on("spawn", (payload: unknown) => this.#callbacks.onSpawn?.(payload));
    channel.on("stop", (payload: unknown) => this.#callbacks.onStop?.(payload));
    channel.on("restart", (payload: unknown) =>
      this.#callbacks.onRestart?.(payload),
    );
    channel.on("enumerate_sessions", (payload: unknown) =>
      this.#callbacks.onEnumerateSessions?.(payload),
    );
    channel.on("switch_session", (payload: unknown) =>
      this.#callbacks.onSwitchSession?.(payload),
    );
    channel.on("reset_session", (payload: unknown) =>
      this.#callbacks.onResetSession?.(payload),
    );
    channel.on("refresh_engine_catalog", (payload: unknown) =>
      this.#callbacks.onRefreshEngineCatalog?.(payload),
    );

    channel
      .join()
      .receive("error", (reason: unknown) => {
        process.stderr.write(
          `RunnerLink join error: ${JSON.stringify(reason)}\n`,
        );
      })
      .receive("timeout", () => {
        process.stderr.write("RunnerLink join timeout\n");
      });

    return { socket, channel };
  }

  /** Reports a spawn outcome back to the operators (via the server). */
  sendSpawnResult(result: SpawnResult): void {
    this.#channel.push("spawn_result", result);
  }

  /** Replies to enumerate_sessions with the resume candidates. */
  sendSessions(sessions: RunnerSessions): void {
    this.#channel.push("sessions", sessions);
  }

  /** Reports a session-reset outcome (phase-17 17-5). ADR-0036 F7: ok=true
   *  is the runner's "fresh spawn succeeded" report — the server keeps the
   *  reset in `:awaiting_connect` until the fresh wrapper's channel join
   *  confirms completion. ok=false is loud + closed-vocab. */
  sendResetResult(result: SessionResetResult): void {
    this.#channel.push("session_reset_result", result);
  }

  /** Reports an engine-catalog probe outcome (phase-20, ADR-0039). Server
   *  forwards this to operators on agents:lobby so LaunchDialog can toast
   *  success/failure. The refreshed catalog itself reaches the client via
   *  the `hosts` broadcast triggered by the paired updateRegister call. */
  sendCatalogResult(result: EngineCatalogResult): void {
    this.#channel.push("catalog_result", result);
  }

  /** Push a new register payload on the current channel. Used on config
   *  reload when host_id / server_url are UNCHANGED but persona trust /
   *  capabilities / engines changed. The server's `handle_in("register")`
   *  upserts the HostRegistry entry (`Map.put`), so a re-push is a valid
   *  in-place update — no reconnect needed. A disconnected socket is a
   *  silent no-op: the next auto-reconnect's `onOpen` will read the
   *  updated `#register` and announce it. */
  updateRegister(register: RunnerRegister): void {
    this.#register = register;
    if (this.#socket.isConnected()) {
      this.#channel
        .push("register", register)
        .receive("ok", () => {
          process.stderr.write(
            `runner: re-registered host=${this.#hostId}\n`,
          );
        })
        .receive("error", (reason: unknown) => {
          process.stderr.write(
            `runner: re-register rejected: ${JSON.stringify(reason)}\n`,
          );
        });
    }
  }

  /** Close the current socket/channel and open a fresh one under a new
   *  (serverUrl, hostId, register). Used on config reload when host_id or
   *  server_url changed. Existing wrappers spawned by the supervisor keep
   *  their own connections to the OLD wrapper URL — that propagation is a
   *  deferred item, not attempted here. The server-side old-host entry is
   *  released by RunnerChannel.terminate when the disconnect propagates
   *  (`HostRegistry.drop` under owner fencing). */
  reconnect(serverUrl: string, hostId: string, register: RunnerRegister): void {
    this.#channel.leave();
    this.#socket.disconnect();
    this.#hostId = hostId;
    this.#register = register;
    const wired = this.#wire(serverUrl, hostId);
    this.#socket = wired.socket;
    this.#channel = wired.channel;
  }

  /** Stops heartbeating, leaves the channel and closes the socket. */
  close(): void {
    clearInterval(this.#heartbeat);
    this.#channel.leave();
    this.#socket.disconnect();
  }
}
