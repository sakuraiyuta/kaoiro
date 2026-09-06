// issue #304: a fake `phoenix` package (aliased in via
// bench/vite.harness.config.ts, only for the bench's own dev server — the
// production build/vite.config.ts is untouched) so the bench can mount the
// REAL src/App.svelte unmodified and drive it with synthetic server
// traffic, instead of stubbing individual component props the way
// bench/harness.ts does for AgentDetail alone. src/lib/protocol.ts talks to
// the real `phoenix` package's `Socket`/`Channel` classes directly
// (`new Socket(url, opts)`, `channel.on/push/join/leave`) with no injectable
// seam of its own, so faking the transport at the module-resolution level
// is the only way to drive it without touching App.svelte/protocol.ts (out
// of scope for this issue) or standing up a real Phoenix backend.
//
// Scope: only the subset of the Phoenix client API connectKaoiro
// (protocol.ts) actually calls. Two internal-API accessors
// (`reconnectTimer`, `clearHeartbeats`) that protocol.ts pokes at through a
// `typeof === "function"` guard are deliberately left ABSENT here rather
// than stubbed — the guards already no-op on absence, so implementing them
// would be dead code paths this bench never exercises (no reconnect/outage
// scenario is being measured).

type ReceiveStatus = "ok" | "error" | "timeout";
type ReceiveCallback = (payload?: unknown) => void;

/** Mimics Phoenix's `Push`: `.receive(status, cb)` is chainable, and
 *  resolves on a microtask so every synchronous `.receive()` call after
 *  `.push()`/`.join()` is registered before it fires — matching a real
 *  network round-trip's ordering without an actual one. */
class FakePush {
  #settled: { status: ReceiveStatus; payload?: unknown } | null = null;
  #handlers = new Map<ReceiveStatus, ReceiveCallback>();

  receive(status: ReceiveStatus, cb: ReceiveCallback): this {
    this.#handlers.set(status, cb);
    if (this.#settled !== null && this.#settled.status === status) {
      cb(this.#settled.payload);
    }
    return this;
  }

  /** Test-only: resolve this push. Called by FakeChannel, not user code. */
  _resolve(status: ReceiveStatus, payload?: unknown): void {
    this.#settled = { status, payload };
    this.#handlers.get(status)?.(payload);
  }
}

type ServerEventCallback = (payload: unknown) => void;

export class FakeChannel {
  #listeners = new Map<string, ServerEventCallback[]>();
  joined = false;

  on(event: string, cb: ServerEventCallback): number {
    const list = this.#listeners.get(event) ?? [];
    list.push(cb);
    this.#listeners.set(event, list);
    return list.length;
  }

  off(): void {
    // Not exercised by the bench scenarios (no dynamic unsubscribe path
    // under measurement); no-op keeps the shape complete.
  }

  join(): FakePush {
    const push = new FakePush();
    queueMicrotask(() => {
      this.joined = true;
      push._resolve("ok", {});
    });
    return push;
  }

  leave(): FakePush {
    const push = new FakePush();
    queueMicrotask(() => push._resolve("ok", {}));
    return push;
  }

  /** Client -> "server" send (e.g. instruction/model-switch pushes the real
   *  App may issue). The bench never asserts on these; resolving "ok"
   *  immediately keeps any awaiting caller from hanging. */
  push(_event: string, _payload?: unknown): FakePush {
    const push = new FakePush();
    queueMicrotask(() => push._resolve("ok", {}));
    return push;
  }

  /** Driver API: deliver a server -> client event to every listener
   *  registered via `.on()`, exactly like a real Phoenix broadcast. */
  _emit(event: string, payload: unknown): void {
    for (const cb of this.#listeners.get(event) ?? []) cb(payload);
  }
}

type SocketCallback = () => void;

export class Socket {
  #openListeners: SocketCallback[] = [];
  #closeListeners: SocketCallback[] = [];
  #errorListeners: SocketCallback[] = [];
  #channels = new Map<string, FakeChannel>();

  constructor(_url: string, _opts?: Record<string, unknown>) {
    // URL/opts (params, transport, heartbeatIntervalMs) are irrelevant here
    // -- there is no real transport underneath. App.svelte constructs this
    // exactly once per mount/session via connectKaoiro; expose the instance
    // so the harness driver script (which has no other handle into
    // protocol.ts's closed-over `socket` variable) can reach the channel to
    // push synthetic server events into.
    (window as unknown as { __fakeSocket?: Socket }).__fakeSocket = this;
  }

  onOpen(cb: SocketCallback): void {
    this.#openListeners.push(cb);
  }

  onClose(cb: SocketCallback): void {
    this.#closeListeners.push(cb);
  }

  onError(cb: SocketCallback): void {
    this.#errorListeners.push(cb);
  }

  connect(): void {
    // A real transport handshake is async; a microtask keeps that ordering
    // (callers register onOpen before connect() has a chance to fire it)
    // without an actual delay the bench would have to account for.
    queueMicrotask(() => {
      for (const cb of this.#openListeners) cb();
    });
  }

  disconnect(cb?: SocketCallback): void {
    queueMicrotask(() => {
      for (const listener of this.#closeListeners) listener();
      cb?.();
    });
  }

  channel(topic: string, _params?: Record<string, unknown>): FakeChannel {
    const existing = this.#channels.get(topic);
    if (existing) return existing;
    const ch = new FakeChannel();
    this.#channels.set(topic, ch);
    return ch;
  }

  /** Driver API: fetch the channel a scenario script wants to push server
   *  events into (there is only ever one topic, "agents:lobby", in
   *  practice, but keyed by topic for generality). */
  _channelFor(topic: string): FakeChannel | undefined {
    return this.#channels.get(topic);
  }
}
