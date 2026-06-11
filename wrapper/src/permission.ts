// Permission broker — bridges canUseTool to the client approval UI
// (protocol.md "承認フロー", ADR-0011). decide() sends a
// permission_request envelope and holds the promise until a relayed
// permission_decision resolves it or the no-response window denies it
// (fail-closed).

import { randomUUID } from "node:crypto";
import type { PermissionDecision } from "./host.js";
import { makePermissionRequest } from "./state.js";
import type { Envelope, WrapperConfig } from "./types.js";

/** Default no-response window before deny (ADR-0011: 600s). */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 600_000;

/** Tool input above this serialized size is dropped from the request
 *  payload (specs/protocol.md, specs/threat-model.md). */
const MAX_INPUT_BYTES = 16_384;

/** A client's decision relayed by the server (protocol.md). */
export interface PermissionDecisionMessage {
  request_id: string;
  allow: boolean;
  message?: string;
}

interface PendingRequest {
  resolve: (decision: PermissionDecision) => void;
  timer: NodeJS.Timeout;
}

export interface PermissionBrokerOptions {
  config: WrapperConfig;
  /** Envelope sink, normally ServerLink#send. */
  send: (envelope: Envelope) => void;
  /** Overrides config.permission_timeout_ms (tests). */
  timeoutMs?: number;
  /** ISO-8601 timestamp source; injectable for tests. */
  now?: () => string;
  /** request_id source; injectable for tests. */
  newId?: () => string;
}

export class PermissionBroker {
  readonly #options: PermissionBrokerOptions;
  readonly #timeoutMs: number;
  readonly #now: () => string;
  readonly #newId: () => string;
  readonly #pending = new Map<string, PendingRequest>();

  constructor(options: PermissionBrokerOptions) {
    this.#options = options;
    this.#timeoutMs =
      options.timeoutMs ??
      options.config.permission_timeout_ms ??
      DEFAULT_PERMISSION_TIMEOUT_MS;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#newId = options.newId ?? randomUUID;
  }

  /** Compatible with AgentHostOptions#decidePermission. */
  decide(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionDecision> {
    const requestId = this.#newId();
    const payload: Record<string, unknown> = {
      request_id: requestId,
      tool_name: toolName,
    };
    // Oversized input is dropped rather than partially serialized: a
    // cut JSON string would be unparseable and may split a secret.
    // Measured in UTF-8 bytes — .length counts UTF-16 units and would
    // under-count multibyte text.
    if (Buffer.byteLength(JSON.stringify(input), "utf8") <= MAX_INPUT_BYTES) {
      payload.input = input;
    } else {
      payload.truncated = true;
    }

    this.#options.send(
      makePermissionRequest(this.#options.config, this.#now(), payload),
    );

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        resolve({
          allow: false,
          message: "kaoiro: permission request timed out",
        });
      }, this.#timeoutMs);
      // Let the process exit even while a request is pending.
      timer.unref?.();
      this.#pending.set(requestId, { resolve, timer });
    });
  }

  /** Resolves a pending request; late/unknown request_ids are ignored
   *  (already timed out or never ours). */
  resolve(decision: PermissionDecisionMessage): void {
    const pending = this.#pending.get(decision.request_id);
    if (!pending) return;
    this.#pending.delete(decision.request_id);
    clearTimeout(pending.timer);
    const resolved: PermissionDecision = { allow: decision.allow === true };
    if (decision.message !== undefined) resolved.message = decision.message;
    pending.resolve(resolved);
  }

  /** Denies all in-flight requests (wrapper shutdown). */
  close(): void {
    for (const [requestId, pending] of this.#pending) {
      this.#pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve({ allow: false, message: "kaoiro: wrapper closed" });
    }
  }
}
