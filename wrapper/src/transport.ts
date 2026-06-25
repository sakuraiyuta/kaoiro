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

export interface ServerLinkOptions {
  /** Wrapper auth token (ADR-0011), sent as a connect param. */
  token?: string;
  /** An operator's instruction relayed by the server. */
  onInstruction?: (text: string) => void;
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
        options.onInstruction?.(payload.text);
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
