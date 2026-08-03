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
import {
  buildHeartbeat,
  isPhoenixHeartbeatLoggingEnabled,
} from "./config.js";

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

/** Server → runner control events, keyed by the callback that handles them.
 *  `Record<keyof ChannelCallbacks, string>` requires EVERY key, so adding a
 *  command to `ChannelCallbacks` without listing its event here is a compile
 *  error — which is how the version check below stays impossible to forget
 *  (issue #181: "各ハンドラに散らすと漏れる"). */
export const CONTROL_EVENT_BY_CALLBACK: Record<keyof ChannelCallbacks, string> =
  {
    onSpawn: "spawn",
    onStop: "stop",
    onRestart: "restart",
    onEnumerateSessions: "enumerate_sessions",
    onSwitchSession: "switch_session",
    onResetSession: "reset_session",
    onRefreshEngineCatalog: "refresh_engine_catalog",
  };

/** The protocol version this runner speaks (ADR-0015). Mirrors the "0" the
 *  send side stamps in config.ts / supervisor.ts / engine_catalog_refresh.ts. */
export const RUNNER_PROTOCOL_VERSION = "0";

/** `version` is unvalidated wire input, so it is rendered bounded — the same
 *  reason the server bounds its own inspect of the field. */
const MAX_LOGGED_VERSION_CHARS = 64;

function readVersion(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null) return undefined;
  return (payload as { version?: unknown }).version;
}

function describeVersion(value: unknown): string {
  if (value === undefined) return "(absent)";

  let text: string;
  try {
    text = JSON.stringify(value) ?? "(unserializable)";
  } catch {
    text = "(unserializable)";
  }

  return text.length > MAX_LOGGED_VERSION_CHARS
    ? `${text.slice(0, MAX_LOGGED_VERSION_CHARS)}…(truncated)`
    : text;
}

/** ADR-0015's receiver rule: only an exact match is normal, a mismatch is
 *  warned about, and the message is processed EITHER WAY (best-effort accept
 *  — rejecting would halt operations over a field nothing varies on yet).
 *
 *  An ABSENT version warns too. The server stamps "0" on every runner-bound
 *  message — the four it relays and the three it builds itself — so a missing
 *  field means that invariant broke, not that some sender has yet to catch
 *  up. The server's relay-side check treats absent the same way since #182
 *  gave the dashboard its own stamp, so both hops now agree (#181 / #182). */
export function warnOnVersionMismatch(
  event: string,
  payload: unknown,
  write: (line: string) => void = (line) => process.stderr.write(line),
): void {
  const version = readVersion(payload);
  if (version === RUNNER_PROTOCOL_VERSION) return;

  write(
    `runner: ${event}: server declared protocol version ` +
      `${describeVersion(version)}; accepting as ` +
      `${JSON.stringify(RUNNER_PROTOCOL_VERSION)} (ADR-0015 best-effort accept)\n`,
  );
}

/** The slice of a phoenix `Channel` this binding needs. Declared here so a
 *  test can drive `bindControlEvents` without standing up a live Socket. */
export interface ControlEventChannel {
  on(event: string, callback: (payload: unknown) => void): unknown;
}

/** Binds every server → runner control event, with the ADR-0015 version check
 *  in front of the handler. One loop rather than seven `channel.on` calls: the
 *  check is then structurally impossible to bind without.
 *
 *  `callbacks` is a getter, not a value, so the handler resolves the callback
 *  at DELIVERY time — the behaviour the previous per-event bindings had. */
export function bindControlEvents(
  channel: ControlEventChannel,
  callbacks: () => ChannelCallbacks,
  write?: (line: string) => void,
): void {
  for (const [key, event] of Object.entries(CONTROL_EVENT_BY_CALLBACK) as [
    keyof ChannelCallbacks,
    string,
  ][]) {
    channel.on(event, (payload: unknown) => {
      warnOnVersionMismatch(event, payload, write);
      callbacks()[key]?.(payload);
    });
  }
}

const MAX_TRACKED_HEARTBEAT_REFS = 64;

/** Phoenix's logger receives only a formatted message plus payload, so the
 * reply's ref has to be recovered from the formatted message. These patterns
 * deliberately match Phoenix 1.8's `Socket.push` / `onConnMessage` format:
 *
 *   push:    "runner:host heartbeat (join_ref, ref)"
 *   receive: "ok runner:host phx_reply (ref)"
 */
function parsePushLog(message: string):
  | { topic: string; event: string; ref: string }
  | undefined {
  const match = message.match(/^([^\s]+)\s+([^\s]+)\s+\([^,]*,\s*([^)]+)\)$/);
  if (match === null) return undefined;
  const [, topic, event, ref] = match;
  if (topic === undefined || event === undefined || ref === undefined) {
    return undefined;
  }
  return { topic, event, ref };
}

function parseReplyLog(message: string):
  | { topic: string; ref: string }
  | undefined {
  // `payload.status` is optional, hence match from the stable tail rather
  // than assuming an initial "ok" / "error" word.
  const match = message.match(/\s([^\s]+)\s+phx_reply\s+\(([^)]+)\)$/);
  if (match === null) return undefined;
  const [, topic, ref] = match;
  if (topic === undefined || ref === undefined) return undefined;
  return { topic, ref };
}

/** Suppresses only the runner channel's periodic heartbeat and its matching
 * successful reply. `phx_reply` alone is intentionally never suppressed: a
 * ref recorded from an actual heartbeat push is required, so command
 * acknowledgements on the same runner topic remain visible. Error replies are
 * operationally significant (for example, an unmatched topic) and stay in
 * runner.log. */
export class PhoenixHeartbeatLogFilter {
  readonly #channelTopic: string;
  readonly #includeHeartbeats: boolean;
  readonly #heartbeatRefs = new Set<string>();

  constructor(channelTopic: string, includeHeartbeats: boolean) {
    this.#channelTopic = channelTopic;
    this.#includeHeartbeats = includeHeartbeats;
  }

  shouldWrite(kind: string, message: string, data: unknown): boolean {
    if (this.#includeHeartbeats) return true;

    if (kind === "push") {
      const push = parsePushLog(message);
      if (
        push !== undefined &&
        push.event === "heartbeat" &&
        (push.topic === "phoenix" || push.topic === this.#channelTopic)
      ) {
        // Both Socket and Channel heartbeat pushes have a ref. Be defensive
        // about malformed logger input: without a usable ref the push itself
        // is still noise, but no later reply is suppressed blindly.
        if (push.ref !== "null" && push.ref !== "undefined") {
          if (this.#heartbeatRefs.size >= MAX_TRACKED_HEARTBEAT_REFS) {
            const oldest = this.#heartbeatRefs.values().next().value;
            if (oldest !== undefined) this.#heartbeatRefs.delete(oldest);
          }
          this.#heartbeatRefs.add(push.ref);
        }
        return false;
      }
      return true;
    }

    if (kind === "receive") {
      const reply = parseReplyLog(message);
      const status =
        typeof data === "object" && data !== null
          ? (data as { status?: unknown }).status
          : undefined;
      if (
        reply !== undefined &&
        (reply.topic === "phoenix" || reply.topic === this.#channelTopic)
      ) {
        // Always retire the observed ref; only a successful heartbeat reply
        // is noise. An error reply is the most useful sign that the channel
        // disappeared while the client still believed it joined.
        const isHeartbeatReply = this.#heartbeatRefs.delete(reply.ref);
        if (isHeartbeatReply && status === "ok") return false;
      }
    }
    return true;
  }
}

export interface PhoenixWireLoggerOptions {
  /** Retain heartbeat push/reply lines. Default false for an operationally
   *  useful runner.log; KAOIRO_RUNNER_LOG_PHOENIX_HEARTBEATS=1 enables it. */
  includeHeartbeats: boolean;
  /** Injectable sink for focused unit tests; production writes stderr. */
  write?: (line: string) => void;
}

/** Builds the Phoenix Socket logger without changing the established token
 * redaction. The filter owns ref correlation for this one Socket instance. */
export function createPhoenixWireLogger(
  channelTopic: string,
  options: PhoenixWireLoggerOptions,
): (kind: string, message: string, data: unknown) => void {
  const filter = new PhoenixHeartbeatLogFilter(
    channelTopic,
    options.includeHeartbeats,
  );
  const write = options.write ?? ((line: string) => process.stderr.write(line));
  return (kind, message, data) => {
    if (!filter.shouldWrite(kind, message, data)) return;
    const raw = `runner: phoenix ${kind}: ${message} ${JSON.stringify(data)}\n`;
    write(raw.replace(/(token=)[^&\s"]+/gi, "$1<REDACTED>"));
  };
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
    // Capture the host id for THIS wire() call: reconnect() (below) reassigns
    // this.#hostId synchronously while the old socket's teardown callbacks
    // (onError/onClose) fire asynchronously — reading the live field would
    // mislabel the OLD socket's closure with the NEW host id.
    const wiredHostId = hostId;
    const channelTopic = `runner:${hostId}`;
    const socket = new Socket(serverUrl, {
      transport: WebSocket,
      params: this.#token === undefined ? {} : { token: this.#token },
      // Surface Phoenix transport / channel state to runner.log so silent
      // reconnect failures (auth reject, vsn mismatch, sleep/wake) stop
      // being invisible. The periodic heartbeat push/reply pair is omitted
      // by default; KAOIRO_RUNNER_LOG_PHOENIX_HEARTBEATS=1 restores full wire
      // output for protocol debugging.
      // Phoenix's "transport" kind embeds endPointURL() which appends the
      // `params` object as a query string, so a raw pass-through would leak
      // KAOIRO_RUNNER_TOKEN into runner.log on every connect/reconnect —
      // redact any `token=<value>` before writing (security.md).
      logger: createPhoenixWireLogger(channelTopic, {
        includeHeartbeats: isPhoenixHeartbeatLoggingEnabled(),
      }),
    });
    socket.connect();
    const channel = socket.channel(channelTopic);

    // Silent-disconnect guard (ADR-0023 observability gap): the phoenix
    // client auto-reconnects, but persistent failures (invalid token,
    // server-side forbid, macOS sleep/wake) go unnoticed without these
    // hooks — the heartbeat push simply short-circuits on
    // isConnected()==false and the server marks the host dead.
    socket.onError((error) => {
      process.stderr.write(
        `runner: socket error host=${wiredHostId}: ${String(error)}\n`,
      );
    });
    socket.onClose((event) => {
      process.stderr.write(
        `runner: socket closed host=${wiredHostId} code=${event.code} reason=${JSON.stringify(event.reason)}\n`,
      );
    });

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
    // validates them — but the ADR-0015 version check runs for all of them
    // here, before the payload leaves this layer (issue #181).
    bindControlEvents(channel, () => this.#callbacks);

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
