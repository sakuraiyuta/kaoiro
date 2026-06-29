// Server link — pushes envelopes to the kaoiro server over Phoenix Channels
// (ADR-0009: Channels only, wire vsn=2.0.0, which the official client speaks).
// The phoenix client owns reconnect/heartbeat; pushes made while disconnected
// are buffered and flushed on rejoin. Outbound envelopes get the wrapper's
// monotonic seq (ADR-0011: one assignment point for the whole series) and the
// current SDK session_id (protocol.md / ADR-0014 phase-0) stamped here;
// inbound pushes (instruction / permission_decision, protocol.md) are
// validated structurally and forwarded to the handlers.

import { Channel, Socket } from "phoenix";
import type { PermissionDecisionMessage } from "./permission.js";
import type { Envelope } from "./types.js";

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
  /** Wrapper auth token (ADR-0011), sent as a connect param. */
  token?: string;
  /** An operator's instruction relayed by the server. `attachmentIds`, when
   *  present, lists prior uploads the wrapper should attach to this turn
   *  (file-upload spec). */
  onInstruction?: (text: string, attachmentIds?: string[]) => void;
  /** An operator's permission decision relayed by the server. */
  onPermissionDecision?: (decision: PermissionDecisionMessage) => void;
  /** An operator's interrupt request relayed by the server (protocol.md, #51).
   *  Payload is `{}` — the topic carries the agent_id. */
  onInterrupt?: () => void;
  /** An operator's model switch relayed by the server (protocol.md, #54).
   *  Payload is `{ model: string }` — an alias from ext.models. */
  onSetModel?: (value: string) => void;
  /** An operator's effort switch relayed by the server (protocol.md, #54).
   *  Payload is `{ effort: string }` — a level from a model's effort_levels. */
  onSetEffort?: (level: string) => void;
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
    options: ServerLinkOptions = {},
  ) {
    this.#socket = new Socket(serverUrl, {
      transport: WebSocket,
      params: options.token === undefined ? {} : { token: options.token },
    });
    this.#socket.connect();
    this.#channel = this.#socket.channel(`wrapper:${agentId}`);

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
   *  agent_id; the payload is empty. */
  sendHistoryReset(): void {
    this.#channel.push("history_reset", {});
  }

  /** Leaves the channel and closes the socket. */
  close(): void {
    this.#channel.leave();
    this.#socket.disconnect();
  }
}
