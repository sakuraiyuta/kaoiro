// kaoiro public-protocol client — plain TS, no Svelte dependency
// (ADR-0007). Speaks Phoenix Channels (vsn=2.0.0 via the official client,
// ADR-0009) and consumes the same API as any external client: join
// "agents:lobby", receive one "snapshot" push, then "envelope" broadcasts.
// Reconnect/heartbeat belong to the phoenix client; every successful
// (re)join yields a fresh snapshot (protocol.md re-sync rule).

import { Socket } from "phoenix";

/** Envelope v0 frame (docs/specs/protocol.md). */
export interface Persona {
  id: string;
  name: string;
  sprite_set: string;
}

export interface Envelope {
  version: string;
  agent_id: string;
  persona?: Persona;
  ts: string;
  type: string;
  state: string;
  payload?: Record<string, unknown>;
  ext?: Record<string, unknown>;
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface KaoiroHandlers {
  onStatus: (status: ConnectionStatus) => void;
  /** Full re-sync; replaces all known agents (last-write-wins). */
  onSnapshot: (agents: Record<string, Envelope>) => void;
  /** Single-agent update. */
  onEnvelope: (envelope: Envelope) => void;
}

export interface KaoiroConnection {
  disconnect: () => void;
}

function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Envelope).agent_id === "string" &&
    typeof (value as Envelope).state === "string"
  );
}

/**
 * Connects to the kaoiro server's client socket and forwards protocol
 * events to the handlers. `url` is the socket endpoint, e.g.
 * `ws://host:4000/client` (the phoenix client appends "/websocket").
 */
export function connectKaoiro(
  url: string,
  handlers: KaoiroHandlers,
): KaoiroConnection {
  const socket = new Socket(url);
  handlers.onStatus("connecting");
  socket.onOpen(() => handlers.onStatus("connected"));
  socket.onClose(() => handlers.onStatus("disconnected"));
  socket.onError(() => handlers.onStatus("disconnected"));
  socket.connect();

  const channel = socket.channel("agents:lobby");
  channel.on("snapshot", (payload: { agents?: unknown }) => {
    const agents: Record<string, Envelope> = {};
    for (const value of Object.values(payload.agents ?? {})) {
      if (isEnvelope(value)) agents[value.agent_id] = value;
    }
    handlers.onSnapshot(agents);
  });
  channel.on("envelope", (payload: unknown) => {
    if (isEnvelope(payload)) handlers.onEnvelope(payload);
  });
  channel.join();

  return {
    disconnect: () => {
      channel.leave();
      socket.disconnect();
    },
  };
}

/** Socket endpoint derived from the page origin (Phoenix-served build). */
export function defaultSocketUrl(location: Location): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/client`;
}
