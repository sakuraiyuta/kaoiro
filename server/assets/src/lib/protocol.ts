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

/** Shape of a pending tool-permission request — carried on
 *  state_change.ext.pending_permission (ADR-0022, #59) as the
 *  authoritative source, and on the legacy permission_request envelope's
 *  payload as initial notification. `ts` is present on ext, optional on
 *  the legacy payload — the dashboard does not depend on it. */
export interface PermissionRequestPayload {
  request_id: string;
  tool_name: string;
  input?: Record<string, unknown>;
  truncated?: boolean;
  ts?: string;
}

/**
 * Reads ext.pending_permission off any envelope (ADR-0022 authoritative
 * source). Returns null when no pending decision is in flight or the
 * record is malformed. Carried on every state_change while
 * waiting_permission so the dialog survives intermediate state_change
 * envelopes that previously erased it (issue #59).
 */
export function pendingPermissionFrom(
  envelope: Envelope,
): PermissionRequestPayload | null {
  const ext = envelope.ext;
  if (typeof ext !== "object" || ext === null) return null;
  const pending = (ext as Record<string, unknown>).pending_permission;
  if (typeof pending !== "object" || pending === null) return null;
  const record = pending as Record<string, unknown>;
  if (
    typeof record.request_id !== "string" ||
    typeof record.tool_name !== "string"
  ) {
    return null;
  }
  return record as unknown as PermissionRequestPayload;
}

/** A selectable model surfaced on state_change.ext.models (#54, ADR-0020):
 *  the choices and per-model effort levels behind the dashboard's model /
 *  effort switch dialogs. Operator-only — ext is stripped for viewers (#46),
 *  so non-operators always see an empty list. */
export interface ModelOption {
  value: string;
  display_name: string;
  description?: string;
  effort_levels?: string[];
}

/** Reads ext.models off an envelope into well-typed ModelOption entries
 *  (#54). Returns [] when the key is absent or malformed; viewers always get
 *  [] since ext is stripped for non-operators (#46). */
export function modelsFrom(envelope: Envelope): ModelOption[] {
  const raw = envelope.ext?.models;
  if (!Array.isArray(raw)) return [];
  const out: ModelOption[] = [];
  for (const entry of raw) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as ModelOption).value === "string" &&
      typeof (entry as ModelOption).display_name === "string"
    ) {
      const m = entry as ModelOption;
      out.push({
        value: m.value,
        display_name: m.display_name,
        ...(typeof m.description === "string"
          ? { description: m.description }
          : {}),
        ...(Array.isArray(m.effort_levels)
          ? {
              effort_levels: m.effort_levels.filter(
                (l): l is string => typeof l === "string",
              ),
            }
          : {}),
      });
    }
  }
  return out;
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

/** Metadata for a file upload (file-upload spec / ADR-0025). The client
 *  computes chunks from CHUNK_SIZE; upload_id is client-generated (UUID v4). */
export interface AttachOpenMeta {
  upload_id: string;
  filename: string;
  mime: string;
  size: number;
  chunks: number;
}

/** payload of a type="attach_rejected" envelope (file-upload spec / ADR-0025
 *  F9). Individual upload rejection from the wrapper. */
export interface AttachRejectedPayload {
  upload_id: string;
  reason: string;
  detail?: string;
}

/** payload of a type="instruction_rejected" envelope (file-upload spec /
 *  ADR-0025 F9). Whole-instruction rejection (SDK error, attachment
 *  unresolved, etc.). */
export interface InstructionRejectedPayload {
  attachment_ids?: string[];
  reason: string;
  detail?: string;
}

/** Recommended chunk size for attach_chunk binary frames. The protocol is
 *  client-determined (file-upload spec F14); 64 KB stays well under the
 *  server's transport safety valve (8 MB frame cap, ADR-0025 transport
 *  section) while keeping the chunk count manageable for phase-0 sizes. */
export const ATTACH_CHUNK_SIZE = 64 * 1024;

/** Builds an attach_chunk binary payload matching the spec layout:
 *  `<u32 upload_id_len BE><upload_id utf8><u32 chunk_index BE><bytes>`.
 *  Exported so external clients (kaoiro.nvim 等) have a reference builder. */
export function buildChunkPayload(
  uploadId: string,
  chunkIndex: number,
  bytes: Uint8Array,
): ArrayBuffer {
  const idBytes = new TextEncoder().encode(uploadId);
  const out = new Uint8Array(4 + idBytes.byteLength + 4 + bytes.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, idBytes.byteLength, false);
  out.set(idBytes, 4);
  view.setUint32(4 + idBytes.byteLength, chunkIndex, false);
  out.set(bytes, 4 + idBytes.byteLength + 4);
  return out.buffer;
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

/** States where the agent is executing and an interrupt (ESC equivalent,
 *  #51) could land work. idle / waiting_input / done / error /
 *  disconnected have nothing to interrupt. Single source of truth so the
 *  lobby card and the detail view stay in sync when states change. */
export const RUNNING_STATES: ReadonlySet<string> = new Set([
  "sending",
  "thinking",
  "tool_running",
  "waiting_permission",
]);

/** States where terminating the agent is safe to do without a warning (#22):
 *  it is not mid-work, so nothing in flight is lost. Any other state prompts a
 *  confirm. Shared by the lobby card and the detail view. */
export const STOP_SAFE_STATES: ReadonlySet<string> = new Set([
  "idle",
  "waiting_input",
  "done",
]);

/** Recovers the owning host_id from a server-allocated agent_id
 *  (`<host_id>.<rand>`, ADR-0024 D3) so the operator can address `stop` to the
 *  right runner without the dashboard tracking host membership. The random
 *  suffix has no dots, so host_id is everything before the last dot. An
 *  agent_id with no dot (e.g. a manual wrapper not following the convention)
 *  yields itself; the stop is then a no-op as no runner owns it. */
export function hostIdFromAgentId(agentId: string): string {
  const lastDot = agentId.lastIndexOf(".");
  return lastDot > 0 ? agentId.slice(0, lastDot) : agentId;
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

/** A live host the operator can launch agents on (ADR-0023 / #22). Derived
 *  from the operator-only `hosts` push; viewers never receive it. */
export interface HostInfo {
  host_id: string;
  personas: Persona[];
  cwd_allowlist: string[];
  capabilities?: string[];
}

/** Operator launch request (案A, ADR-0024). The client sends only these; the
 *  server allocates agent_id and mints the per-agent token. */
export interface SpawnRequest {
  host_id: string;
  /** persona id, resolved server-side to the host's declared persona. */
  persona: string;
  cwd: string;
  /** Optional per-instance display name; overrides the persona's name for
   *  this agent only (not the agent_id). Empty/absent = the persona name. */
  name?: string;
  initial_prompt?: string;
  resume_session_id?: string;
}

/** Outcome of a spawn, forwarded from the runner (operator-only). */
export interface SpawnResult {
  host_id: string;
  agent_id: string;
  ok: boolean;
  reason?: string;
}

/** A resume candidate under a cwd (ADR-0014 F2; minimal metadata, T2). */
export interface RunnerSession {
  session_id: string;
  summary?: string;
  mtime?: string;
}

/** Resume candidates for a (host, cwd), forwarded from the runner's
 *  enumerate_sessions reply (operator-only, #22 phase-1). */
export interface RunnerSessions {
  host_id: string;
  cwd: string;
  sessions: RunnerSession[];
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
  /** A resume reconstruction reset (issue #50, ADR-0014 phase-2): the named
   *  agent's transcript should be dropped entirely, just before the server
   *  replays the JSONL-rebuilt `log` lines. Operator-only. */
  onHistoryReset?: (agentId: string) => void;
  /** A disconnected agent was removed (issue #14): drop it from the grid.
   *  Operator-only. */
  onAgentDeleted?: (agentId: string) => void;
  /** Live launchable hosts (#22); pushed on join and on every host
   *  register/drop. Operator-only — its arrival also marks this client an
   *  operator (viewers never receive it). */
  onHosts?: (hosts: HostInfo[]) => void;
  /** A spawn outcome forwarded from the runner (#22). Operator-only. */
  onSpawnResult?: (result: SpawnResult) => void;
  /** Resume candidates for a (host, cwd), in reply to enumerateSessions
   *  (#22 phase-1). Operator-only. */
  onSessions?: (result: RunnerSessions) => void;
  /** Wrapper rejected an individual upload (file-upload spec / ADR-0025).
   *  Operator-only. Forwarded from the envelope stream as a convenience. */
  onAttachRejected?: (payload: AttachRejectedPayload) => void;
  /** Wrapper rejected a whole instruction (file-upload spec / ADR-0025).
   *  Operator-only. Forwarded from the envelope stream as a convenience. */
  onInstructionRejected?: (payload: InstructionRejectedPayload) => void;
}

export interface KaoiroConnection {
  disconnect: () => void;
  /** Sends an operator instruction; rejects on server refusal
   * (forbidden / unknown_agent) or timeout. `attachmentIds` references
   * uploads previously sent through uploadFile / attach* (file-upload spec
   * / ADR-0025); the wrapper resolves each id to the corresponding bytes. */
  sendInstruction: (
    agentId: string,
    text: string,
    attachmentIds?: string[],
  ) => Promise<void>;
  /** Answers a pending permission_request; rejects like sendInstruction. */
  sendPermissionDecision: (
    agentId: string,
    requestId: string,
    allow: boolean,
  ) => Promise<void>;
  /** Interrupts the agent's current turn (#51, ESC equivalent); rejects
   * like sendInstruction (forbidden / unknown_agent / timeout). The
   * wrapper handles a stale interrupt as a no-op. */
  sendInterrupt: (agentId: string) => Promise<void>;
  /** Switches the model for the agent's subsequent turns (#54); rejects like
   * sendInstruction (forbidden / unknown_agent / timeout). `model` is a
   * `value` from ext.models. */
  setModel: (agentId: string, model: string) => Promise<void>;
  /** Switches the reasoning effort for the agent's subsequent turns (#54);
   * rejects like sendInstruction. `effort` is a level from a model's
   * effort_levels (low..max). */
  setEffort: (agentId: string, effort: string) => Promise<void>;
  /** Purges the agent's past-session reply log (issue #48); rejects like
   * sendInstruction (forbidden / unknown_agent / no_current_session). */
  clearHistory: (agentId: string) => Promise<void>;
  /** Removes a disconnected agent (issue #14); rejects like
   * sendInstruction (forbidden / unknown_agent / not_disconnected). */
  deleteAgent: (agentId: string) => Promise<void>;
  /** Terminates the running wrapper (#22): the runner that owns the agent
   * kills its process; the agent then goes `disconnected`. The host is
   * derived from the agent_id (hostIdFromAgentId). A no-op for an agent no
   * runner owns. Rejects like sendInstruction (forbidden / timeout). */
  stop: (agentId: string) => Promise<void>;
  /** Restores a disconnected agent (#22, ADR-0014「復帰」): the server
   * re-spawns the SAME agent_id with resume from its recorded session
   * pointer, so the agent comes back with its face / mood / conversation.
   * Rejects with `no_session` when no resumable pointer (session_id + cwd)
   * was recorded, `unknown_agent` when the agent is not known. */
  restore: (agentId: string) => Promise<void>;
  /** Requests a spawn (#22, 案A); resolves with the server-allocated
   * agent_id. Rejects like sendInstruction (forbidden / unknown_host /
   * unknown_persona / cwd_not_allowed). The eventual launch outcome
   * arrives separately via onSpawnResult. */
  spawn: (request: SpawnRequest) => Promise<{ agentId: string }>;
  /** Requests the resume candidates under (host, cwd) (#22 phase-1);
   * resolves when the server accepts the relay. The candidate list arrives
   * separately via onSessions. Rejects like sendInstruction. */
  enumerateSessions: (hostId: string, cwd: string) => Promise<void>;
  /** Uploads a File using attach_open / attach_chunk* / attach_close
   *  (file-upload spec / ADR-0025). Resolves with the upload_id once
   *  attach_close acks. Reject from the wrapper arrives asynchronously
   *  via onAttachRejected with the same upload_id.
   *
   *  `onProgress`, when provided, fires after each attach_chunk push with
   *  (uploaded_chunks, total_chunks). Chunk granularity (64 KB by spec /
   *  ADR-0025 F14) is fine enough for per-upload UI without per-byte
   *  bookkeeping. The bar may briefly flash 100% before attach_close
   *  resolves — the caller decides how to render that boundary. */
  uploadFile: (
    agentId: string,
    file: File,
    onProgress?: (uploaded: number, total: number) => void,
  ) => Promise<string>;
  /** Lower-level attach primitives — exposed mainly for tests and unusual
   *  upload patterns (the high-level uploadFile orchestrates them). */
  attachOpen: (agentId: string, meta: AttachOpenMeta) => Promise<void>;
  attachChunk: (data: ArrayBuffer) => void;
  attachClose: (agentId: string, uploadId: string) => Promise<void>;
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

/** Parses the `hosts` map (host_id => entry) into a HostInfo list, keeping
 *  only the operator-facing fields and skipping malformed entries. */
export function parseHosts(value: unknown): HostInfo[] {
  if (typeof value !== "object" || value === null) return [];
  const hosts: HostInfo[] = [];
  for (const [hostId, entry] of Object.entries(value)) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      Array.isArray((entry as HostInfo).personas) &&
      Array.isArray((entry as HostInfo).cwd_allowlist)
    ) {
      const e = entry as HostInfo;
      hosts.push({
        host_id: hostId,
        personas: e.personas,
        cwd_allowlist: e.cwd_allowlist,
        ...(Array.isArray(e.capabilities)
          ? { capabilities: e.capabilities }
          : {}),
      });
    }
  }
  return hosts;
}

/** Parses a `sessions` array, keeping only well-typed candidates. */
export function parseSessions(value: unknown): RunnerSession[] {
  if (!Array.isArray(value)) return [];
  const sessions: RunnerSession[] = [];
  for (const entry of value) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as RunnerSession).session_id === "string"
    ) {
      const s = entry as RunnerSession;
      sessions.push({
        session_id: s.session_id,
        ...(typeof s.summary === "string" ? { summary: s.summary } : {}),
        ...(typeof s.mtime === "string" ? { mtime: s.mtime } : {}),
      });
    }
  }
  return sessions;
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
    if (!isEnvelope(payload)) return;
    handlers.onEnvelope(payload);
    // Convenience dispatch for upload rejections (file-upload spec /
    // ADR-0025). The full envelope still goes through onEnvelope so
    // generic UIs see it; the specific handlers fire when bound.
    if (payload.type === "attach_rejected") {
      const p = payload.payload as Partial<AttachRejectedPayload> | undefined;
      if (
        p !== undefined &&
        typeof p.upload_id === "string" &&
        typeof p.reason === "string"
      ) {
        handlers.onAttachRejected?.({
          upload_id: p.upload_id,
          reason: p.reason,
          ...(typeof p.detail === "string" ? { detail: p.detail } : {}),
        });
      }
    } else if (payload.type === "instruction_rejected") {
      const p = payload.payload as Partial<InstructionRejectedPayload> | undefined;
      if (p !== undefined && typeof p.reason === "string") {
        handlers.onInstructionRejected?.({
          reason: p.reason,
          ...(Array.isArray(p.attachment_ids)
            ? {
                attachment_ids: p.attachment_ids.filter(
                  (id): id is string => typeof id === "string",
                ),
              }
            : {}),
          ...(typeof p.detail === "string" ? { detail: p.detail } : {}),
        });
      }
    }
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
  channel.on("history_reset", (payload: { agent_id?: unknown }) => {
    if (typeof payload.agent_id === "string") {
      handlers.onHistoryReset?.(payload.agent_id);
    }
  });
  channel.on("agent_deleted", (payload: { agent_id?: unknown }) => {
    if (typeof payload.agent_id === "string") {
      handlers.onAgentDeleted?.(payload.agent_id);
    }
  });
  channel.on("hosts", (payload: { hosts?: unknown }) => {
    handlers.onHosts?.(parseHosts(payload.hosts));
  });
  channel.on("spawn_result", (payload: unknown) => {
    const p = payload as Partial<SpawnResult>;
    if (
      typeof p.host_id === "string" &&
      typeof p.agent_id === "string" &&
      typeof p.ok === "boolean"
    ) {
      handlers.onSpawnResult?.({
        host_id: p.host_id,
        agent_id: p.agent_id,
        ok: p.ok,
        ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
      });
    }
  });
  channel.on("runner_sessions", (payload: unknown) => {
    const p = payload as Partial<RunnerSessions>;
    if (typeof p.host_id === "string" && typeof p.cwd === "string") {
      handlers.onSessions?.({
        host_id: p.host_id,
        cwd: p.cwd,
        sessions: parseSessions(p.sessions),
      });
    }
  });
  channel.join();

  return {
    disconnect: () => {
      channel.leave();
      socket.disconnect();
    },
    sendInstruction: (agentId, text, attachmentIds) =>
      pushAsync(
        channel,
        "instruction",
        attachmentIds !== undefined && attachmentIds.length > 0
          ? { agent_id: agentId, text, attachment_ids: attachmentIds }
          : { agent_id: agentId, text },
      ),
    sendPermissionDecision: (agentId, requestId, allow) =>
      pushAsync(channel, "permission_decision", {
        agent_id: agentId,
        request_id: requestId,
        allow,
      }),
    sendInterrupt: (agentId) =>
      pushAsync(channel, "interrupt", { agent_id: agentId }),
    setModel: (agentId, model) =>
      pushAsync(channel, "set_model", { agent_id: agentId, model }),
    setEffort: (agentId, effort) =>
      pushAsync(channel, "set_effort", { agent_id: agentId, effort }),
    clearHistory: (agentId) =>
      pushAsync(channel, "clear_history", { agent_id: agentId }),
    deleteAgent: (agentId) =>
      pushAsync(channel, "delete_agent", { agent_id: agentId }),
    stop: (agentId) =>
      pushAsync(channel, "stop", {
        host_id: hostIdFromAgentId(agentId),
        agent_id: agentId,
      }),
    restore: (agentId) =>
      pushAsync(channel, "restore", { agent_id: agentId }),
    spawn: (request) =>
      new Promise((resolve, reject) => {
        channel
          .push("spawn", { ...request })
          .receive("ok", (resp: { agent_id?: unknown }) =>
            typeof resp?.agent_id === "string"
              ? resolve({ agentId: resp.agent_id })
              : reject(new Error("error")),
          )
          .receive("error", (reason: { reason?: string } | undefined) =>
            reject(new Error(reason?.reason ?? "error")),
          )
          .receive("timeout", () => reject(new Error("timeout")));
      }),
    enumerateSessions: (hostId, cwd) =>
      pushAsync(channel, "enumerate_sessions", { host_id: hostId, cwd }),
    attachOpen: (agentId, meta) =>
      pushAsync(channel, "attach_open", { agent_id: agentId, ...meta }),
    attachChunk: (data) => {
      // Fire-and-forget binary frame: phoenix.js automatically encodes
      // ArrayBuffer payloads as a V2 binary frame. The server's handler
      // returns :noreply so awaiting a reply would only ever time out.
      channel.push("attach_chunk", data);
    },
    attachClose: (agentId, uploadId) =>
      pushAsync(channel, "attach_close", {
        agent_id: agentId,
        upload_id: uploadId,
      }),
    uploadFile: async (agentId, file, onProgress) => {
      const upload_id = crypto.randomUUID();
      const buffer = await file.arrayBuffer();
      const size = buffer.byteLength;
      const chunks = Math.max(1, Math.ceil(size / ATTACH_CHUNK_SIZE));
      await pushAsync(channel, "attach_open", {
        agent_id: agentId,
        upload_id,
        filename: file.name,
        mime: file.type,
        size,
        chunks,
      });
      for (let i = 0; i < chunks; i++) {
        const start = i * ATTACH_CHUNK_SIZE;
        const end = Math.min(start + ATTACH_CHUNK_SIZE, size);
        const chunkBytes = new Uint8Array(buffer.slice(start, end));
        channel.push("attach_chunk", buildChunkPayload(upload_id, i, chunkBytes));
        onProgress?.(i + 1, chunks);
      }
      await pushAsync(channel, "attach_close", {
        agent_id: agentId,
        upload_id,
      });
      return upload_id;
    },
  };
}

/** Socket endpoint derived from the page origin (Phoenix-served build). */
export function defaultSocketUrl(location: Location): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/client`;
}
