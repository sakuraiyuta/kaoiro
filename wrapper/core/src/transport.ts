// Server link — pushes envelopes to the kaoiro server over Phoenix Channels
// (ADR-0009: Channels only, wire vsn=2.0.0, which the official client speaks).
// The phoenix client owns reconnect/heartbeat; pushes made while disconnected
// are buffered and flushed on rejoin. Outbound envelopes get the wrapper's
// monotonic seq (ADR-0011: one assignment point for the whole series) and the
// current SDK session_id (protocol.md / ADR-0014 phase-0) stamped here;
// inbound pushes (instruction / permission_decision, protocol.md) are
// validated structurally and forwarded to the handlers.

import { Channel, Socket } from "phoenix";
import type { Envelope } from "@kaoiro/protocol";

/** A client's permission decision relayed by the server (protocol.md).
 *  Defined here (the wire layer that parses it); the PermissionBroker in
 *  @kaoiro/agent-common consumes it. */
export interface PermissionDecisionMessage {
  request_id: string;
  allow: boolean;
  message?: string;
}

/** A client's answer relayed by the server (protocol.md question_response).
 *  Wire twin of {@link PermissionDecisionMessage} for the AskUserQuestion
 *  path (ADR-0027); consumed by the QuestionBroker in @kaoiro/agent-common. */
export interface QuestionResponseMessage {
  request_id: string;
  /** Selected answers keyed by question text; ignored when cancelled. */
  answers: Record<string, string>;
  /** true = the operator dismissed the dialog (deny). */
  cancelled?: boolean;
}

/** context usage as it reaches a peer (phase-27, #160). Same three numbers
 *  the dashboard's ctx meter reads, so the two never disagree. The server
 *  only projects this when the reporting wrapper advertised
 *  `supports_context_usage: true`; an engine without the capability omits the
 *  field entirely rather than sending a null or an estimate (ADR-0040). */
export interface DirectoryContext {
  used_tokens: number;
  max_tokens: number;
  used_percentage: number;
}

/** One rate-limit window as it reaches a peer (phase-27, #160). Every field
 *  is optional because the engine reports what it knows; a window with none
 *  of them is dropped rather than sent empty. The snapshot is from the peer's
 *  LAST turn and is not refreshed while it idles — read `resets_at` against
 *  the current time and stop trusting `utilization` / `status` once it has
 *  passed. */
export interface DirectoryRateLimitWindow {
  status?: string;
  utilization?: number;
  resets_at?: number;
}

/** Active inter-agent conversation state of a peer (phase-27, #160). Always
 *  present on a current server (`{active: false, peers: []}` when idle), so
 *  an absent field means the server predates the feature — not "no
 *  conversation". `conversation_id` is deliberately not disclosed: the agreed
 *  disclosure scope is presence plus counterpart ids. */
export interface DirectoryConversation {
  active: boolean;
  peers: string[];
}

/** Single entry returned from `directory_request` (protocol-inter-agent
 * companion tool). Runtime traits are optional because an old/not-yet-init
 * wrapper may not have stamped them. Operator-grade cwd / permission /
 * session / capabilities / source fields remain excluded.
 *
 * phase-27 (#160) adds the situational fields below so an agent can pick a
 * delegate on its own. Every one of them is omitted rather than defaulted
 * when the server cannot vouch for it — **read an absent field as "unknown",
 * never as zero or "fine"**. `turns` in particular is omitted (not `0`) when
 * the server never observed this session's start. */
export interface DirectoryEntry {
  agent_id: string;
  persona: { id?: string; name?: string; sprite_set?: string };
  state: string;
  engine?: string;
  model?: string;
  effort?: string;
  context?: DirectoryContext;
  /** ISO8601 UTC. The time the SERVER observed the session start, not a
   *  wrapper-measured value. */
  session_started_at?: string;
  /** Reply round-trips counted in the current session. */
  turns?: number;
  /** ISO8601 UTC of the last envelope the server accepted from this peer.
   *  Grades how stale `context` / `rate_limits` are. */
  last_activity_at?: string;
  conversation?: DirectoryConversation;
  /** Keyed by window: `five_hour` / `seven_day` plus any engine-specific
   *  ones. */
  rate_limits?: Record<string, DirectoryRateLimitWindow>;
}

/** attach_open payload (protocol.md / file-upload spec, server -> wrapper
 *  relay). chunks is the advertised total chunk count for the upload. */
export interface AttachOpenMessage {
  upload_id: string;
  filename: string;
  mime: string;
  size: number;
  chunks: number;
}

export interface ServerLinkOptions {
  /** persona.id declared to the server at join time (ADR-0029 F3).
   *  The server rejects the join when this id is not in its pack manifest
   *  (or the reserved `default`); the wrapper then never opens its SDK
   *  session. Required — there is no fallback under fail-closed. */
  personaId: string;
  /** Session-transition correlation id relayed from the command that
   *  launched this wrapper (`config.transition_id`, phase-27 / #160). Sent
   *  verbatim as a join param so the server can recognise the connection a
   *  spawn / restore / reset produced — a session_id cannot identify it,
   *  because a same-session resume reuses the old one. Absent on a legacy
   *  runner; the server then declines to activate the pending transition
   *  and omits the affected activity metadata. */
  transitionId?: string;
  /** Wrapper auth token (ADR-0011), sent as a connect param. */
  token?: string;
  /** The server-composed personality + common footer (ADR-0029 F5)
   *  pushed once after join over the WS handshake. cli.ts awaits this
   *  before opening the SDK session — the SDK's systemPrompt.append is
   *  set once and never rewritten (F9 no hot-swap). */
  onPersonaPrompt?: (prompt: string) => void;
  /** An operator's instruction relayed by the server. `attachmentIds`, when
   *  present, lists prior uploads the wrapper should attach to this turn
   *  (file-upload spec). */
  onInstruction?: (text: string, attachmentIds?: string[]) => void;
  /** An operator's permission decision relayed by the server. */
  onPermissionDecision?: (decision: PermissionDecisionMessage) => void;
  /** An operator's AskUserQuestion answer relayed by the server (ADR-0027). */
  onQuestionResponse?: (response: QuestionResponseMessage) => void;
  /** An operator's interrupt request relayed by the server (protocol.md, #51).
   *  Payload is `{}` — the topic carries the agent_id. */
  onInterrupt?: () => void;
  /** An operator's model switch relayed by the server (protocol.md, #54).
   *  Payload is `{ model: string }` — an alias from ext.models. */
  onSetModel?: (value: string) => void;
  /** An operator's effort switch relayed by the server (protocol.md, #54).
   *  Payload is `{ effort: string }` — a level from a model's effort_levels. */
  onSetEffort?: (level: string) => void;
  /** An operator's manual retry of supportedModels() relayed by the server
   *  (protocol.md, ADR-0037 F6, phase-18-5). Payload is `{}` — the topic
   *  addresses the agent. The wrapper resets its retry counter + succeeded
   *  flag and kicks a fresh #refreshSupportedModels() attempt. */
  onRefreshModels?: (payload: { request_id?: string }) => void;
  /** An operator's permission-mode switch relayed by the server (#58). Also
   *  the carrier of the server's after-join push of the persisted last
   *  choice. Payload is `{ mode: string }` — one of the SDK PermissionMode
   *  values; validation lives in the wrapper. */
  onSetPermissionMode?: (mode: string) => void;
  /** attach_open relayed by the server (file-upload spec / ADR-0025).
   *  Announces an upcoming upload; the wrapper registers a pending entry. */
  onAttachOpen?: (msg: AttachOpenMessage) => void;
  /** attach_chunk relayed by the server — a V2 binary frame payload. The
   *  wrapper parses the upload_id / chunk_index header and appends bytes. */
  onAttachChunk?: (payload: ArrayBuffer | ArrayBufferView) => void;
  /** attach_close relayed by the server. The wrapper verifies the upload
   *  is complete; an incomplete or oversize upload emits attach_rejected. */
  onAttachClose?: (uploadId: string) => void;
  /** Inbound inter_agent_message envelope (protocol-inter-agent spec). The
   *  server pushes both routed messages (from peer wrapper) and synthesized
   *  ones (e.g. escalate-to-user on quota overshoot) to the receiving
   *  wrapper's topic — both flow through here. */
  onInterAgentMessage?: (envelope: Envelope) => void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Bounds mirrored from the server's own projection (phase-27, #160). The two
 *  sides MUST agree: a looser client would re-open the pass-through the
 *  server closed, since the model reads whatever survives here. */
const MAX_RATE_WINDOWS = 8;
const MAX_WINDOW_KEY_BYTES = 32;
const MAX_STATUS_BYTES = 64;
const WINDOW_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
/** Windows every engine is expected to report; kept ahead of engine-specific
 *  ones when the count has to be trimmed, so the two that drive delegation
 *  decisions never get pushed out. */
const CANONICAL_WINDOWS = ["five_hour", "seven_day"];

const utf8Bytes = new TextEncoder();

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** Non-negative counters and Unix-second timestamps alike: a negative or
 *  fractional value is not one, and a value past the safe-integer range has
 *  already lost precision. */
function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Copies only the three canonical numbers. An unknown nested key is not
 *  carried over, and a malformed one drops the whole field rather than
 *  handing the model a partial reading it would compare against a full one. */
function projectContext(value: unknown): DirectoryContext | undefined {
  if (!isObject(value)) return undefined;
  const used_tokens = finiteNumber(value.used_tokens);
  const max_tokens = finiteNumber(value.max_tokens);
  const used_percentage = finiteNumber(value.used_percentage);
  if (
    used_tokens === undefined ||
    max_tokens === undefined ||
    used_percentage === undefined
  ) {
    return undefined;
  }
  return { used_tokens, max_tokens, used_percentage };
}

/** `utilization` is deliberately NOT range-checked to 0..1 here: #164 is
 *  still reconciling what the engines actually report, and clamping now
 *  would hide the very values that investigation needs. */
function projectRateLimitWindow(
  key: string,
  value: unknown,
): DirectoryRateLimitWindow | undefined {
  if (!isObject(value)) return undefined;
  if (utf8Bytes.encode(key).length > MAX_WINDOW_KEY_BYTES) return undefined;
  if (!WINDOW_KEY_PATTERN.test(key)) return undefined;
  // Each field is optional, but a PRESENT one that fails validation drops the
  // whole window rather than just itself: a window reporting `utilization`
  // while silently discarding an out-of-spec `status` would read as a
  // complete picture when it is not.
  const window: DirectoryRateLimitWindow = {};
  if (value.status !== undefined) {
    if (typeof value.status !== "string") return undefined;
    if (utf8Bytes.encode(value.status).length > MAX_STATUS_BYTES) {
      return undefined;
    }
    window.status = value.status;
  }
  if (value.utilization !== undefined) {
    const utilization = finiteNumber(value.utilization);
    if (utilization === undefined) return undefined;
    window.utilization = utilization;
  }
  if (value.resets_at !== undefined) {
    const resetsAt = nonNegativeInteger(value.resets_at);
    if (resetsAt === undefined) return undefined;
    window.resets_at = resetsAt;
  }
  // No field at all — an empty window name tells a peer nothing.
  return Object.keys(window).length === 0 ? undefined : window;
}

function windowSortKey(key: string): [number, string] {
  const canonical = CANONICAL_WINDOWS.indexOf(key);
  return canonical === -1 ? [CANONICAL_WINDOWS.length, key] : [canonical, ""];
}

function projectRateLimits(
  value: unknown,
): Record<string, DirectoryRateLimitWindow> | undefined {
  if (!isObject(value)) return undefined;
  const valid: [string, DirectoryRateLimitWindow][] = [];
  for (const [key, raw] of Object.entries(value)) {
    const window = projectRateLimitWindow(key, raw);
    if (window !== undefined) valid.push([key, window]);
  }
  // Deterministic trim: canonical windows first, then the rest in lexical
  // order, so which windows survive never depends on object key order.
  valid.sort(([a], [b]) => {
    const [rankA, tieA] = windowSortKey(a);
    const [rankB, tieB] = windowSortKey(b);
    return rankA - rankB || tieA.localeCompare(tieB);
  });
  const kept = valid.slice(0, MAX_RATE_WINDOWS);
  return kept.length === 0 ? undefined : Object.fromEntries(kept);
}

function projectConversation(
  value: unknown,
): DirectoryConversation | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.active !== "boolean") return undefined;
  if (!Array.isArray(value.peers)) return undefined;
  if (!value.peers.every((peer): peer is string => typeof peer === "string")) {
    return undefined;
  }
  return { active: value.active, peers: value.peers };
}

/** Structural narrow for a single `directory_request` entry. Asserts every
 *  field DirectoryEntry declares non-optional, so a server response that
 *  drops `persona` or `state` cannot smuggle a malformed entry through the
 *  type system.
 *
 *  The optional fields are projected one at a time: a malformed one is
 *  dropped on its own and its valid siblings still reach the model, matching
 *  the "omit what we cannot vouch for" rule the whole feature is built on. */
function directoryEntryFrom(value: unknown): DirectoryEntry | null {
  if (!isObject(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.agent_id !== "string" ||
    !isObject(v.persona) ||
    typeof v.state !== "string"
  ) {
    return null;
  }
  const entry: DirectoryEntry = {
    agent_id: v.agent_id,
    persona: v.persona as DirectoryEntry["persona"],
    state: v.state,
  };
  for (const key of ["engine", "model", "effort"] as const) {
    const field = v[key];
    if (typeof field === "string" && field !== "") entry[key] = field;
  }
  const context = projectContext(v.context);
  if (context !== undefined) entry.context = context;
  const startedAt = nonEmptyText(v.session_started_at);
  if (startedAt !== undefined) entry.session_started_at = startedAt;
  // A non-negative integer; absent means "the server never observed this
  // session start", which is NOT the same as zero round-trips.
  const turns = nonNegativeInteger(v.turns);
  if (turns !== undefined) entry.turns = turns;
  const lastActivityAt = nonEmptyText(v.last_activity_at);
  if (lastActivityAt !== undefined) entry.last_activity_at = lastActivityAt;
  const conversation = projectConversation(v.conversation);
  if (conversation !== undefined) entry.conversation = conversation;
  const rateLimits = projectRateLimits(v.rate_limits);
  if (rateLimits !== undefined) entry.rate_limits = rateLimits;
  return entry;
}

export class ServerLink {
  readonly #socket: Socket;
  readonly #channel: Channel;
  #seq = 0;
  #lastEnvelope: Envelope | null = null;
  /** Latest SDK session id reported by the host (ADR-0014 phase-0); stamped
   *  onto every outgoing envelope until a newer one replaces it. */
  #sessionId: string | null = null;

  /**
   * @param serverUrl Socket endpoint, e.g. "ws://localhost:4000/wrapper"
   *   (the client appends "/websocket").
   * @param agentId Stable agent id; the channel topic is `wrapper:<agentId>`.
   */
  constructor(
    serverUrl: string,
    agentId: string,
    options: ServerLinkOptions,
  ) {
    this.#socket = new Socket(serverUrl, {
      transport: WebSocket,
      params: options.token === undefined ? {} : { token: options.token },
    });
    this.#socket.connect();
    // persona_id rides join params (channel-level) so the server can
    // reject an unknown-persona join before it consumes any state
    // (ADR-0029 F3, protocol.md「人格プロンプト配送」). transition_id rides
    // the same params (phase-27, #160) so the server can tell this join
    // apart from any other connection for the agent; omitted entirely when
    // unknown, since the server reads a blank value as a mismatch rather
    // than as the legacy absent case.
    this.#channel = this.#socket.channel(`wrapper:${agentId}`, {
      persona_id: options.personaId,
      ...(options.transitionId !== undefined && options.transitionId !== ""
        ? { transition_id: options.transitionId }
        : {}),
    });

    // ADR-0029 F5: the server pushes the ready-to-inject prompt (persona
    // personality + common footer) once after join. cli.ts's promise
    // resolves on this and starts the SDK session.
    this.#channel.on("persona_prompt", (payload: unknown) => {
      if (isObject(payload) && typeof payload.prompt === "string") {
        options.onPersonaPrompt?.(payload.prompt);
      }
    });

    this.#channel.on("instruction", (payload: unknown) => {
      if (isObject(payload) && typeof payload.text === "string") {
        // attachment_ids is optional (file-upload spec); validate it as an
        // array of strings or drop it silently so a malformed list does
        // not poison the text-only path.
        const ids = Array.isArray(payload.attachment_ids)
          ? payload.attachment_ids.filter(
              (id): id is string => typeof id === "string",
            )
          : undefined;
        options.onInstruction?.(
          payload.text,
          ids && ids.length > 0 ? ids : undefined,
        );
      }
    });
    this.#channel.on("permission_decision", (payload: unknown) => {
      if (
        isObject(payload) &&
        typeof payload.request_id === "string" &&
        typeof payload.allow === "boolean"
      ) {
        const decision: PermissionDecisionMessage = {
          request_id: payload.request_id,
          allow: payload.allow,
        };
        if (typeof payload.message === "string") {
          decision.message = payload.message;
        }
        options.onPermissionDecision?.(decision);
      }
    });
    // ADR-0027: server -> wrapper `question_response` carries the operator's
    // AskUserQuestion answers (or a cancel). `answers` is a string map keyed
    // by question text; malformed pushes are dropped.
    this.#channel.on("question_response", (payload: unknown) => {
      if (isObject(payload) && typeof payload.request_id === "string") {
        const response: QuestionResponseMessage = {
          request_id: payload.request_id,
          answers: isObject(payload.answers)
            ? (payload.answers as Record<string, string>)
            : {},
        };
        if (payload.cancelled === true) response.cancelled = true;
        options.onQuestionResponse?.(response);
      }
    });
    // protocol.md (#51): server -> wrapper `interrupt` carries an empty
    // payload; the topic already addresses the agent. Fire the handler
    // unconditionally — extra keys are ignored for forward compat.
    this.#channel.on("interrupt", (_payload: unknown) => {
      options.onInterrupt?.();
    });
    // protocol.md (#54): server -> wrapper `set_model` / `set_effort` carry
    // the operator's choice; the topic addresses the agent. Validate the one
    // string field structurally and forward; malformed pushes are dropped.
    this.#channel.on("set_model", (payload: unknown) => {
      if (isObject(payload) && typeof payload.model === "string") {
        options.onSetModel?.(payload.model);
      }
    });
    this.#channel.on("set_effort", (payload: unknown) => {
      if (isObject(payload) && typeof payload.effort === "string") {
        options.onSetEffort?.(payload.effort);
      }
    });
    // protocol.md (ADR-0037 F6, phase-18-5): server -> wrapper `refresh_models`
    // has no payload fields; the topic already addresses the agent. Fire the
    // handler unconditionally — extra keys are ignored for forward compat.
    this.#channel.on("refresh_models", (payload: unknown) => {
      // ADR-0039 F9 v2 = 藤 review D2a: payload now carries request_id so
      // the wrapper's refresh_models_result envelope can correlate. Older
      // servers may still push a bare {} — pass through as undefined.
      const rid =
        typeof payload === "object" &&
        payload !== null &&
        typeof (payload as { request_id?: unknown }).request_id === "string"
          ? (payload as { request_id: string }).request_id
          : undefined;
      options.onRefreshModels?.({
        ...(rid === undefined ? {} : { request_id: rid }),
      });
    });
    // protocol.md (#58): server -> wrapper `set_permission_mode` carries the
    // operator's mode pick AND the server's after-join push of the persisted
    // last choice. Mode-value validation lives in host.setPermissionMode.
    this.#channel.on("set_permission_mode", (payload: unknown) => {
      if (isObject(payload) && typeof payload.mode === "string") {
        options.onSetPermissionMode?.(payload.mode);
      }
    });
    // File-upload wire (file-upload spec / ADR-0025). attach_open declares an
    // upload, attach_chunk delivers a binary slice, attach_close finalises.
    // Malformed payloads are dropped — the wire is operator-only and the
    // server already vets shapes; a defensive drop is enough.
    this.#channel.on("attach_open", (payload: unknown) => {
      if (
        isObject(payload) &&
        typeof payload.upload_id === "string" &&
        typeof payload.filename === "string" &&
        typeof payload.mime === "string" &&
        typeof payload.size === "number" &&
        typeof payload.chunks === "number"
      ) {
        options.onAttachOpen?.({
          upload_id: payload.upload_id,
          filename: payload.filename,
          mime: payload.mime,
          size: payload.size,
          chunks: payload.chunks,
        });
      }
    });
    this.#channel.on("attach_chunk", (payload: unknown) => {
      // V2 binary frame: payload is an ArrayBuffer (browser) or a
      // Buffer/Uint8Array (Node ws). Anything else is malformed.
      if (payload instanceof ArrayBuffer || ArrayBuffer.isView(payload)) {
        options.onAttachChunk?.(payload as ArrayBuffer | ArrayBufferView);
      }
    });
    this.#channel.on("attach_close", (payload: unknown) => {
      if (isObject(payload) && typeof payload.upload_id === "string") {
        options.onAttachClose?.(payload.upload_id);
      }
    });
    // Inter-agent routing (protocol-inter-agent spec): the server pushes the
    // full envelope (type=inter_agent_message) onto wrapper:<self> for every
    // message routed to this agent, including the server-synthesized
    // escalate-to-user on quota overshoot. Trust the topic for addressing —
    // payload.to is informational here, not a filter. Drop anything but
    // inter_agent_message defensively (the server never pushes other types
    // to wrapper:<self>, but a future broker should not see them).
    this.#channel.on("envelope", (payload: unknown) => {
      if (!isObject(payload) || payload.type !== "inter_agent_message") return;
      options.onInterAgentMessage?.(payload as unknown as Envelope);
    });

    // Re-announce the latest state after a reconnect: the server keeps
    // agent state in memory only, so a restart (deploy) empties the
    // snapshot, and an agent absent from it cannot receive instructions.
    // On the first open #lastEnvelope is null (no-op); on reconnects the
    // push is buffered by the client until the channel rejoins. send()
    // stamps a fresh seq.
    this.#socket.onOpen(() => {
      if (this.#lastEnvelope) this.send(this.#lastEnvelope);
    });

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

  /** Records the SDK session id the host just captured (ADR-0014 phase-0).
   *  Subsequent sends carry it; re-announced envelopes pick up the current
   *  one too, which is correct since it only ever moves forward. */
  setSessionId(sessionId: string): void {
    this.#sessionId = sessionId;
  }

  /** Pushes one envelope with the next seq; buffered while disconnected. */
  send(envelope: Envelope): void {
    // Only state_change / permission_request define the latest state worth
    // re-announcing after a reconnect. log / result are transcript lines
    // the server keeps as history; re-sending them would duplicate it.
    if (
      envelope.type === "state_change" ||
      envelope.type === "permission_request"
    ) {
      this.#lastEnvelope = envelope;
    }
    this.#seq += 1;
    this.#channel.push("envelope", {
      ...envelope,
      ...(this.#sessionId !== null ? { session_id: this.#sessionId } : {}),
      seq: this.#seq,
    });
  }

  /** Asks the server to drop this agent's reply-log ring buffer before a
   *  resume history replay (ADR-0014 phase-2, issue #50), so the
   *  reconstructed lines overwrite rather than duplicate any pre-crash lines
   *  the server still holds for the same session. The topic carries the
   *  agent_id. Its replay token pairs reset with the completion boundary so
   *  clients can distinguish reconstructed rows from the next live reply. */
  sendHistoryReset(): string {
    const replayId = `resume-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.#channel.push("history_reset", { replay_id: replayId });
    return replayId;
  }

  /** Pushes the explicit end boundary after the final resume JSONL row. */
  sendHistoryReplayComplete(replayId: string): void {
    this.#channel.push("history_replay_complete", { replay_id: replayId });
  }

  /** Fetches the peer directory (protocol-inter-agent companion tool). The
   *  server replies with `{agents: [...]}` containing every currently-known
   *  agent except this wrapper. Used by the `mcp__kaoiro__list_agents` tool
   *  to resolve persona names → agent_ids before send_to_agent. Rejects on
   *  transport error or timeout so the tool surfaces the failure to the
   *  model rather than hanging. */
  requestDirectory(): Promise<DirectoryEntry[]> {
    return new Promise((resolve, reject) => {
      this.#channel
        .push("directory_request", {})
        .receive("ok", (payload: unknown) => {
          if (
            isObject(payload) &&
            Array.isArray((payload as { agents?: unknown }).agents)
          ) {
            const agents = (payload as { agents: unknown[] }).agents
              .map(directoryEntryFrom)
              .filter((entry): entry is DirectoryEntry => entry !== null);
            resolve(agents);
          } else {
            resolve([]);
          }
        })
        .receive("error", (reason: unknown) => {
          reject(new Error(`directory_request failed: ${JSON.stringify(reason)}`));
        })
        .receive("timeout", () => {
          reject(new Error("directory_request timeout"));
        });
    });
  }

  /** Leaves the channel and closes the socket. */
  close(): void {
    this.#channel.leave();
    this.#socket.disconnect();
  }
}
