// @vitest-environment jsdom
// ADR-0015 coverage for the client -> server hop (issue #218, extending
// issue #182): EVERY message this client pushes carries a flat `version`
// frame key, not just the subset the server relays on to the runner.
//
// This file used to be `runnerControlVersion.integration.test.ts` and pinned
// the opposite: it asserted `restore` had NO version, as a deliberate scope
// marker for the runner-relay subset. That pin encoded the exact misreading
// #218 exists to remove — ADR-0015 covers all three parties and draws no
// runner-relay exception — so the case is inverted here rather than deleted.
//
// Drives the REAL phoenix client (only the WebSocket transport is a fake),
// same pattern as reconnect.integration.test.ts, but this fake additionally
// auto-acks every push with a generic "ok" phx_reply so `pushAsync()`
// promises resolve and the channel actually reaches the "joined" state
// (Phoenix buffers pushes made before join completes, then flushes them).
// This asserts what actually leaves the socket, not a stubbed connection.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectKaoiro, type KaoiroConnection } from "../src/lib/protocol";

type WireFrame = {
  joinRef: string | null;
  ref: string | null;
  topic: string;
  event: string;
  payload: unknown;
};

class AckingWebSocket {
  static instances: AckingWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState: number = AckingWebSocket.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: WireFrame[] = [];
  /** Binary (V2) frames, which carry no JSON payload to inspect. Only
   *  `attach_chunk` uses this path — see the ADR-0015 carve-out below. */
  binarySent: unknown[] = [];

  constructor(public url: string) {
    AckingWebSocket.instances.push(this);
    setTimeout(() => {
      if (this.readyState === AckingWebSocket.CLOSED) return;
      this.readyState = AckingWebSocket.OPEN;
      this.onopen?.({});
    }, 0);
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    // phoenix encodes an ArrayBuffer payload as a V2 binary frame. There is
    // no JSON to parse and the server answers `attach_chunk` with :noreply,
    // so record it and stop — auto-acking would be a lie about the wire.
    if (typeof data !== "string") {
      this.binarySent.push(data);
      return;
    }
    const [joinRef, ref, topic, event, payload] = JSON.parse(data) as [
      string | null,
      string | null,
      string,
      string,
      unknown,
    ];
    this.sent.push({ joinRef, ref, topic, event, payload });
    // Generic ok-ack for every push (join, heartbeat, operator control
    // pushes alike) — this fixture only asserts outgoing payload shape,
    // never real server behaviour.
    setTimeout(() => {
      if (this.readyState !== AckingWebSocket.OPEN) return;
      const reply = [joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }];
      this.onmessage?.({ data: JSON.stringify(reply) });
    }, 0);
  }

  close(): void {
    this.readyState = AckingWebSocket.CLOSED;
  }
}

function makeHandlers() {
  return {
    onStatus: vi.fn(),
    onSnapshot: vi.fn(),
    onEnvelope: vi.fn(),
    onHosts: vi.fn(),
  };
}

/** Advances fake timers in small steps so every hop of the join/ack
 *  round-trip (WS open -> phx_join send -> reply schedule -> onmessage ->
 *  channel "joined") settles, without depending on the exact hop count. */
async function settleSocket(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(5);
  }
}

async function connectAndJoin(): Promise<{
  conn: KaoiroConnection;
  ws: AckingWebSocket;
}> {
  const conn = connectKaoiro("ws://test/client", makeHandlers(), {
    transport: AckingWebSocket,
    heartbeatIntervalMs: 1000,
  });
  await settleSocket();
  const ws = AckingWebSocket.instances[0];
  if (ws === undefined) throw new Error("fake WebSocket was not created");
  return { conn, ws };
}

/** Phoenix's own transport frames. They are not application messages and
 *  carry no ADR-0015 version, so they are excluded from the sweep. */
const TRANSPORT_EVENTS = new Set(["phx_join", "phx_leave", "heartbeat"]);

/** Every APPLICATION frame that left the socket, in send order. */
function appFrames(ws: AckingWebSocket): WireFrame[] {
  return ws.sent.filter((f) => !TRANSPORT_EVENTS.has(f.event));
}

const AGENT_ID = "hostA.abc123";

/** One entry per push-capable `KaoiroConnection` method.
 *
 *  `event` is the wire event the call is expected to produce, or `null` for
 *  the binary carve-out. `fire` performs the call; some of these return a
 *  promise that only settles on a server broadcast the fake never sends
 *  (`refreshModels`, `refreshEngineCatalog`) or on a reply body the generic
 *  ok-ack does not supply (`spawn`), so those swallow their rejection — the
 *  outgoing frame is what is under test. */
const PUSH_CASES: ReadonlyArray<{
  method: keyof KaoiroConnection;
  event: string | null;
  fire: (conn: KaoiroConnection) => unknown;
}> = [
  {
    method: "sendInstruction",
    event: "instruction",
    fire: (c) => c.sendInstruction(AGENT_ID, "hello"),
  },
  {
    method: "sendPermissionDecision",
    event: "permission_decision",
    fire: (c) => c.sendPermissionDecision(AGENT_ID, "req-1", true),
  },
  {
    method: "sendQuestionResponse",
    event: "question_response",
    fire: (c) => c.sendQuestionResponse(AGENT_ID, "req-1", { Q: "A" }),
  },
  {
    method: "sendInterrupt",
    event: "interrupt",
    fire: (c) => c.sendInterrupt(AGENT_ID),
  },
  {
    method: "setModel",
    event: "set_model",
    fire: (c) => c.setModel(AGENT_ID, "sonnet"),
  },
  {
    method: "setEffort",
    event: "set_effort",
    fire: (c) => c.setEffort(AGENT_ID, "high"),
  },
  {
    method: "refreshModels",
    event: "refresh_models",
    fire: (c) => void c.refreshModels(AGENT_ID).catch(() => {}),
  },
  {
    method: "refreshEngineCatalog",
    event: "refresh_engine_catalog",
    fire: (c) => void c.refreshEngineCatalog("hostA", "claude-code").catch(() => {}),
  },
  {
    method: "setPermissionMode",
    event: "set_permission_mode",
    fire: (c) => c.setPermissionMode(AGENT_ID, "default"),
  },
  {
    method: "renameAgent",
    event: "rename_agent",
    fire: (c) => c.renameAgent(AGENT_ID, "あお"),
  },
  {
    method: "clearHistory",
    event: "clear_history",
    fire: (c) => c.clearHistory(AGENT_ID),
  },
  {
    method: "deleteAgent",
    event: "delete_agent",
    fire: (c) => c.deleteAgent(AGENT_ID),
  },
  { method: "stop", event: "stop", fire: (c) => c.stop(AGENT_ID) },
  { method: "restore", event: "restore", fire: (c) => c.restore(AGENT_ID) },
  {
    method: "resumeSession",
    event: "resume_session",
    fire: (c) => c.resumeSession(AGENT_ID, "sess-1"),
  },
  {
    method: "sendSessionReset",
    event: "session_reset",
    fire: (c) => c.sendSessionReset(AGENT_ID, "new"),
  },
  {
    method: "spawn",
    event: "spawn",
    fire: (c) =>
      void c
        .spawn({ host_id: "hostA", persona: "ao", cwd: "/workspace" })
        .catch(() => {}),
  },
  {
    method: "getLaunchDefaults",
    event: "launch_defaults",
    fire: (c) => c.getLaunchDefaults(),
  },
  {
    method: "enumerateSessions",
    event: "enumerate_sessions",
    fire: (c) => c.enumerateSessions("hostA", "/workspace"),
  },
  {
    method: "enumerateAgentSessions",
    event: "enumerate_sessions",
    fire: (c) => c.enumerateAgentSessions(AGENT_ID),
  },
  {
    method: "attachOpen",
    event: "attach_open",
    fire: (c) =>
      c.attachOpen(AGENT_ID, {
        upload_id: "up-1",
        filename: "a.png",
        mime: "image/png",
        size: 3,
        chunks: 1,
      }),
  },
  {
    method: "attachClose",
    event: "attach_close",
    fire: (c) => c.attachClose(AGENT_ID, "up-1"),
  },
  {
    method: "uploadFile",
    // Composite: attach_open -> attach_chunk(s) -> attach_close. The JSON
    // legs are asserted through `attach_open` here; the chunk leg is the
    // binary carve-out covered separately below.
    event: "attach_open",
    fire: (c) =>
      void c
        .uploadFile(AGENT_ID, new File([new Uint8Array([1, 2, 3])], "a.png"))
        .catch(() => {}),
  },
  {
    method: "attachChunk",
    // ADR-0015 carve-out: a V2 binary frame has no JSON object to hold a
    // `version` key. Asserted by its own case below.
    event: null,
    fire: (c) => c.attachChunk(new Uint8Array([1, 2, 3]).buffer),
  },
];

/** Methods on `KaoiroConnection` that never push to the channel, so they are
 *  outside this file's subject. Everything else must appear in PUSH_CASES —
 *  the completeness test at the bottom enforces that. */
const NON_PUSH_METHODS = new Set<string>([
  "disconnect",
  "reconnect",
  "notifyOnline",
]);

beforeEach(() => {
  AckingWebSocket.instances.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("client -> server messages carry version (issue #218, ADR-0015)", () => {
  // Every case fires the push first, then advances fake timers with
  // settleSocket() so the auto-ack reply (a fake `setTimeout`) can run
  // before the returned promise is awaited — under vi.useFakeTimers() a
  // bare `await` on a timer-dependent promise never settles on its own.
  it.each(PUSH_CASES.filter((c) => c.event !== null))(
    "$method -> $event に version が乗る",
    async ({ event, fire }) => {
      const { conn, ws } = await connectAndJoin();
      const pending = fire(conn);
      await settleSocket();
      await pending;

      const frames = appFrames(ws);
      // The named event actually left the socket (a call that silently sends
      // nothing must not read as compliant).
      expect(frames.map((f) => f.event)).toContain(event);
      // EVERY frame the call produced carries the stamp — not merely the
      // first one matching `event` (ふじ #218 レビュー MF-2). `uploadFile`
      // is why: it is a three-leg composite (attach_open -> attach_chunk ->
      // attach_close), and asserting only the open leg let the close leg
      // lose its stamp with the suite still green. Reported as event names
      // so a failure says WHICH leg regressed.
      const unstamped = frames.filter(
        (f) => (f.payload as Record<string, unknown> | null)?.version !== "0",
      );
      expect(unstamped.map((f) => f.event)).toEqual([]);
    },
  );

  // The one documented exception (protocol.md 「version」節). A binary frame
  // carries a fixed length-prefixed header plus raw bytes; stamping a
  // `version` key would need a wire change, which #218 rules out of scope.
  // Pinned positively — the chunk must still reach the socket — so a future
  // change that quietly stops sending chunks does not read as "compliant".
  it("attach_chunk は binary frame なので version を持たない (恒久 carve-out)", async () => {
    const { conn, ws } = await connectAndJoin();
    conn.attachChunk(new Uint8Array([1, 2, 3]).buffer);
    await settleSocket();
    expect(ws.binarySent).toHaveLength(1);
    expect(ws.sent.some((f) => f.event === "attach_chunk")).toBe(false);
  });

  // Structural pin (issue #218, こはく D4 追加要請): the per-case list above
  // only proves what it enumerates. This asserts the enumeration itself is
  // complete, so adding a push method to `KaoiroConnection` without adding
  // it to PUSH_CASES fails here instead of silently going uncovered.
  it("PUSH_CASES が push 系メソッドを網羅している", async () => {
    const { conn } = await connectAndJoin();
    const pushMethods = Object.keys(conn)
      .filter((k) => !NON_PUSH_METHODS.has(k))
      .sort();
    const covered = [...new Set(PUSH_CASES.map((c) => c.method as string))].sort();
    expect(covered).toEqual(pushMethods);
  });
});
