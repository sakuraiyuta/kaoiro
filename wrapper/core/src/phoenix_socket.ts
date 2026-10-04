// The one place that builds a Phoenix `Socket` for the runner and the wrappers,
// so the transport handed to Phoenix is decided here and nowhere else.

import { Socket } from "phoenix";

type SocketOptions = NonNullable<ConstructorParameters<typeof Socket>[1]>;

/** Phoenix socket options; `transport` is fixed by `createPhoenixSocket`. */
export type PhoenixSocketOptions = Omit<SocketOptions, "transport">;

/** Upper bound on one opening handshake. Phoenix has no timer of its own before
 *  `open`, and undici gives up on an accepted-but-silent handshake only after
 *  its 300 s headers timeout (Node 22 and 24 alike). */
export const OPENING_HANDSHAKE_TIMEOUT_MS = 10_000;

const CLOSED = 3;

/** The slice of the platform `WebSocket` the adapter drives. */
export interface NativeWebSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: string;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: unknown) => void,
  ): void;
}

export type NativeWebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
) => NativeWebSocket;

/** Shape of the `close` events the adapter synthesizes. */
export interface CloseEventLike {
  readonly type: "close";
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

type Handler = ((event: unknown) => void) | null;

// Reasons are fixed strings, never native error text: RunnerLink logs
// `event.reason` raw, outside the Phoenix logger's token redaction.
const failedClose = (): CloseEventLike => ({
  type: "close",
  code: 1006,
  reason: "opening handshake failed",
  wasClean: false,
});
const timedOutClose = (): CloseEventLike => ({
  type: "close",
  code: 1006,
  reason: "opening handshake timed out",
  wasClean: false,
});

export interface CloseGuaranteedWebSocketConfig {
  /** Resolved per connection attempt; defaults to the global `WebSocket`. */
  native?: () => NativeWebSocketConstructor;
  openingHandshakeTimeoutMs?: number;
}

const globalWebSocket = (): NativeWebSocketConstructor => globalThis.WebSocket;

/**
 * The transport handed to Phoenix. Phoenix schedules a reconnect only from the
 * transport's `close`, but Node 22's built-in WebSocket (undici 6) reports a
 * failed opening handshake with `error` alone and never fires `close`
 * (nodejs/undici#3546), which leaves Phoenix waiting forever.
 *
 * Delivers exactly one `close` per connection attempt: the native one when it
 * comes, otherwise a synthesized 1006 on the macrotask after a pre-open
 * `error` (Node 24 fires its own `close` in the same task as the `error`, so
 * it passes through unchanged) or when the handshake bound expires. Nothing
 * is delivered after that `close`, and `readyState` reads CLOSED from then on.
 */
export class CloseGuaranteedWebSocket {
  onopen: Handler = null;
  onmessage: Handler = null;
  onerror: Handler = null;
  onclose: Handler = null;

  readonly #socket: NativeWebSocket;
  #phase: "connecting" | "open" | "failed" | "closed" = "connecting";
  readonly #handshakeTimer: ReturnType<typeof setTimeout>;
  #failureTimer: ReturnType<typeof setTimeout> | undefined;

  /** Phoenix constructs it with `(url, protocols)`; `config` is a test seam. */
  constructor(
    url: string,
    protocols?: string | string[],
    config: CloseGuaranteedWebSocketConfig = {},
  ) {
    const Native = (config.native ?? globalWebSocket)();
    this.#socket = new Native(url, protocols);
    this.#handshakeTimer = setTimeout(
      () => this.#deliverClose(timedOutClose(), true),
      config.openingHandshakeTimeoutMs ?? OPENING_HANDSHAKE_TIMEOUT_MS,
    );
    this.#socket.addEventListener("open", (event) => this.#onOpen(event));
    this.#socket.addEventListener("message", (event) => {
      if (this.#phase === "open") this.onmessage?.(event);
    });
    this.#socket.addEventListener("error", (event) => this.#onError(event));
    this.#socket.addEventListener("close", (event) =>
      this.#deliverClose(event, false),
    );
  }

  get readyState(): number {
    return this.#phase === "closed" ? CLOSED : this.#socket.readyState;
  }

  get bufferedAmount(): number {
    return this.#socket.bufferedAmount;
  }

  get binaryType(): string {
    return this.#socket.binaryType;
  }

  set binaryType(value: string) {
    this.#socket.binaryType = value;
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.#socket.send(data);
  }

  // Deliberately leaves the handshake timer running: it is the backstop for a
  // close() the native socket never answers with an event.
  close(code?: number, reason?: string): void {
    this.#socket.close(code, reason);
  }

  // Every handler below updates the phase and the timers before it calls out,
  // because the native socket may re-enter synchronously (a pending close()
  // fires its first event inside the call) and a consumer handler may throw.

  #onOpen(event: unknown): void {
    if (this.#phase !== "connecting") {
      this.#socket.close();
      return;
    }
    this.#phase = "open";
    clearTimeout(this.#handshakeTimer);
    this.onopen?.(event);
  }

  #onError(event: unknown): void {
    if (this.#phase === "connecting") {
      this.#phase = "failed";
      this.#failureTimer = setTimeout(
        () => this.#deliverClose(failedClose(), false),
        0,
      );
      this.onerror?.(event);
    } else if (this.#phase === "open") {
      this.onerror?.(event);
    }
  }

  #deliverClose(event: unknown, closeNative: boolean): void {
    if (this.#phase === "closed") return;
    this.#phase = "closed";
    clearTimeout(this.#handshakeTimer);
    clearTimeout(this.#failureTimer);
    if (closeNative) this.#socket.close();
    this.onclose?.(event);
  }
}

/** Builds a Phoenix socket whose transport always reports the end of a
 *  connection attempt with `close`. `transport` is spread last so no caller
 *  can replace it. */
export function createPhoenixSocket(
  endPoint: string,
  options: PhoenixSocketOptions = {},
): Socket {
  return new Socket(endPoint, {
    ...options,
    transport: CloseGuaranteedWebSocket,
  });
}
