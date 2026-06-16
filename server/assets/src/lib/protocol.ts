// kaoiro public-protocol client — plain TS, no Svelte dependency
// (ADR-0007). Speaks Phoenix Channels (vsn=2.0.0 via the official client,
// ADR-0009) and consumes the same API as any external client: join
// "agents:lobby", receive one "snapshot" push, then "envelope" broadcasts.
// Reconnect/heartbeat belong to the phoenix client; every successful
// (re)join yields a fresh snapshot (protocol.md re-sync rule).

import { Socket } from "phoenix";
import type { Channel } from "phoenix";

/** Envelope v0 frame (docs/specs/protocol.md). */
export interface Persona {
  id: string;
  name: string;
  sprite_set: string;
}

export interface Envelope {
  version: string;
  agent_id: string;
  /** SDK conversation session id (protocol.md / ADR-0014); absent until the
   * wrapper reports one. Used to group/clear the transcript by session. */
  session_id?: string;
  persona?: Persona;
  ts: string;
  /** Wrapper-issued monotonic sequence (ADR-0011); absent on
   * server-derived envelopes such as disconnected. */
  seq?: number;
  type: string;
  state: string;
  payload?: Record<string, unknown>;
  ext?: Record<string, unknown>;
}

/** payload of a type="permission_request" envelope (protocol.md). */
export interface PermissionRequestPayload {
  request_id: string;
  tool_name: string;
  input?: Record<string, unknown>;
  truncated?: boolean;
}

/**
 * Narrows a permission_request envelope's payload, or null for any
 * other envelope (or a malformed payload).
 */
export function permissionRequestOf(
  envelope: Envelope,
): PermissionRequestPayload | null {
  if (envelope.type !== "permission_request") return null;
  const payload = envelope.payload;
  if (
    typeof payload?.request_id !== "string" ||
    typeof payload.tool_name !== "string"
  ) {
    return null;
  }
  return payload as unknown as PermissionRequestPayload;
}

/** payload of a type="log" envelope (protocol.md / ADR-0012).
 *  kind=user is the operator's instruction echoed into the transcript (#31). */
export interface LogPayload {
  kind: "assistant" | "tool_use" | "tool_result" | "user";
  text?: string;
  tool_name?: string;
  /** Pairs a tool_use with its tool_result (#40); present when known. */
  tool_use_id?: string;
  input?: Record<string, unknown>;
  output?: string;
  truncated?: boolean;
}

/** payload of a type="result" envelope (the turn's final reply). */
export interface ResultPayload {
  text?: string;
  is_error?: boolean;
}

/** Narrows a log envelope's payload, or null for any other envelope. */
export function logOf(envelope: Envelope): LogPayload | null {
  if (envelope.type !== "log") return null;
  const payload = envelope.payload;
  if (typeof payload?.kind !== "string") return null;
  return payload as unknown as LogPayload;
}

/** Narrows a result envelope's payload, or null for any other envelope. */
export function resultOf(envelope: Envelope): ResultPayload | null {
  if (envelope.type !== "result") return null;
  return (envelope.payload ?? {}) as ResultPayload;
}

/** True for reply-stream envelopes (operator-only, ADR-0012): these go
 *  to the per-agent transcript, not the latest-state map. */
export function isReplyEnvelope(envelope: Envelope): boolean {
  return envelope.type === "log" || envelope.type === "result";
}

/** Persona asset manifest served at GET /api/personas (ADR-0008). */
export interface SpriteEntry {
  /** Hash-versioned URL; safe to cache immutably. */
  url: string;
  /** Content hash, e.g. "sha256:<hex>". */
  hash: string;
}

export interface PersonaManifest {
  /** Changes whenever any sprite content changes (incremental sync). */
  version: string;
  personas: Record<string, { states: Record<string, SpriteEntry> }>;
}

/**
 * Fetches the persona manifest; null on any failure so callers can
 * fall back to sprite-less rendering.
 */
export async function fetchPersonaManifest(
  base = "",
): Promise<PersonaManifest | null> {
  try {
    const res = await fetch(`${base}/api/personas`);
    if (!res.ok) return null;
    return (await res.json()) as PersonaManifest;
  } catch {
    return null;
  }
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface KaoiroHandlers {
  onStatus: (status: ConnectionStatus) => void;
  /** Full re-sync; replaces all known agents (last-write-wins). */
  onSnapshot: (agents: Record<string, Envelope>) => void;
  /** Single-agent update (any envelope type; caller routes by type). */
  onEnvelope: (envelope: Envelope) => void;
  /** Reply-log history per agent (operator-only, ADR-0012); pushed once
   *  on join, chronological. Absent for viewers. */
  onHistory?: (histories: Record<string, Envelope[]>) => void;
  /** A past-session log purge (issue #48): the named agent's transcript
   *  should drop every line outside `sessionId`. Operator-only. */
  onHistoryCleared?: (agentId: string, sessionId: string) => void;
}

export interface KaoiroConnection {
  disconnect: () => void;
  /** Sends an operator instruction; rejects on server refusal
   * (forbidden / unknown_agent) or timeout. */
  sendInstruction: (agentId: string, text: string) => Promise<void>;
  /** Answers a pending permission_request; rejects like sendInstruction. */
  sendPermissionDecision: (
    agentId: string,
    requestId: string,
    allow: boolean,
  ) => Promise<void>;
  /** Purges the agent's past-session reply log (issue #48); rejects like
   * sendInstruction (forbidden / unknown_agent / no_current_session). */
  clearHistory: (agentId: string) => Promise<void>;
}

export interface ConnectOptions {
  /** User token (ADR-0011); resolved server-side to viewer/operator. */
  token?: string;
  /** Short-lived WS ticket fetched from the auth cookie (ADR-0013) — the
   *  reload path, where the token is not in the URL. */
  ticket?: string;
}

function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Envelope).agent_id === "string" &&
    typeof (value as Envelope).state === "string"
  );
}

function pushAsync(
  channel: Channel,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    channel
      .push(event, payload)
      .receive("ok", () => resolve())
      .receive("error", (reason: { reason?: string } | undefined) =>
        reject(new Error(reason?.reason ?? "error")),
      )
      .receive("timeout", () => reject(new Error("timeout")));
  });
}

/**
 * Connects to the kaoiro server's client socket and forwards protocol
 * events to the handlers. `url` is the socket endpoint, e.g.
 * `ws://host:4000/client` (the phoenix client appends "/websocket").
 */
export function connectKaoiro(
  url: string,
  handlers: KaoiroHandlers,
  options: ConnectOptions = {},
): KaoiroConnection {
  const params: Record<string, string> = {};
  if (options.token !== undefined) params.token = options.token;
  if (options.ticket !== undefined) params.ticket = options.ticket;
  const socket = new Socket(url, {
    params,
  });
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
  channel.on("history", (payload: { agents?: unknown }) => {
    const histories: Record<string, Envelope[]> = {};
    for (const [id, value] of Object.entries(payload.agents ?? {})) {
      if (Array.isArray(value)) {
        histories[id] = value.filter(isEnvelope);
      }
    }
    handlers.onHistory?.(histories);
  });
  channel.on(
    "history_cleared",
    (payload: { agent_id?: unknown; session_id?: unknown }) => {
      if (
        typeof payload.agent_id === "string" &&
        typeof payload.session_id === "string"
      ) {
        handlers.onHistoryCleared?.(payload.agent_id, payload.session_id);
      }
    },
  );
  channel.join();

  return {
    disconnect: () => {
      channel.leave();
      socket.disconnect();
    },
    sendInstruction: (agentId, text) =>
      pushAsync(channel, "instruction", { agent_id: agentId, text }),
    sendPermissionDecision: (agentId, requestId, allow) =>
      pushAsync(channel, "permission_decision", {
        agent_id: agentId,
        request_id: requestId,
        allow,
      }),
    clearHistory: (agentId) =>
      pushAsync(channel, "clear_history", { agent_id: agentId }),
  };
}

/** Socket endpoint derived from the page origin (Phoenix-served build). */
export function defaultSocketUrl(location: Location): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/client`;
}
