// Permission broker — bridges canUseTool to the client approval UI
// (protocol.md "承認フロー", ADR-0011 / ADR-0022). decide() sends a
// permission_request envelope (initial notification) AND fires
// onPendingChange so the host can stamp the authoritative pending state
// onto state_change.ext.pending_permission. The promise is held until
// a relayed permission_decision resolves it; if a finite timeoutMs is
// configured it denies on no-response (fail-closed), otherwise it waits
// indefinitely matching the SDK's canUseTool default (ADR-0022 F6).

import { randomUUID } from "node:crypto";
import type { PermissionDecision } from "./host.js";
import { PendingRegistry } from "./pending.js";
import { makePermissionRequest } from "./state.js";
import type { Envelope, PendingPermissionExt, WrapperConfig } from "./types.js";

/** Tool input above this serialized size is dropped from the request
 *  payload (specs/protocol.md, specs/threat-model.md). */
const MAX_INPUT_BYTES = 16_384;

/** A client's decision relayed by the server (protocol.md). */
export interface PermissionDecisionMessage {
  request_id: string;
  allow: boolean;
  message?: string;
}

export interface PermissionBrokerOptions {
  config: WrapperConfig;
  /** Envelope sink, normally ServerLink#send. */
  send: (envelope: Envelope) => void;
  /** Fires synchronously inside decide() before the Promise is returned,
   *  so the host can stamp ext.pending_permission onto the next
   *  state_change. Fires again with null on resolve / timeout / close.
   *  Omitted = host stamping is opted out (ADR-0022 fallback). */
  onPendingChange?: (pending: PendingPermissionExt | null) => void;
  /** Overrides config.permission_timeout_ms (tests). Pass a finite number
   *  for fail-closed deny after that many ms; undefined inherits config;
   *  config undefined = no timeout (SDK default, ADR-0022 F6). */
  timeoutMs?: number;
  /** ISO-8601 timestamp source; injectable for tests. */
  now?: () => string;
  /** request_id source; injectable for tests. */
  newId?: () => string;
}

export class PermissionBroker {
  readonly #options: PermissionBrokerOptions;
  /** null = no timeout (wait until decision arrives). */
  readonly #timeoutMs: number | null;
  readonly #now: () => string;
  readonly #newId: () => string;
  readonly #registry: PendingRegistry<PermissionDecision>;

  constructor(options: PermissionBrokerOptions) {
    this.#options = options;
    const configured =
      options.timeoutMs ?? options.config.permission_timeout_ms;
    this.#timeoutMs = configured === undefined ? null : configured;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#newId = options.newId ?? randomUUID;
    this.#registry = new PendingRegistry<PermissionDecision>(this.#timeoutMs);
  }

  /** Compatible with AgentHostOptions#decidePermission. */
  decide(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionDecision> {
    const requestId = this.#newId();
    const ts = this.#now();
    const payload: Record<string, unknown> = {
      request_id: requestId,
      tool_name: toolName,
    };
    const pending: PendingPermissionExt = {
      request_id: requestId,
      tool_name: toolName,
      ts,
    };
    // Oversized input is dropped rather than partially serialized: a
    // cut JSON string would be unparseable and may split a secret.
    // Measured in UTF-8 bytes — .length counts UTF-16 units and would
    // under-count multibyte text.
    if (Buffer.byteLength(JSON.stringify(input), "utf8") <= MAX_INPUT_BYTES) {
      payload.input = input;
      pending.input = input;
    } else {
      payload.truncated = true;
      pending.truncated = true;
    }

    // Notify host SYNCHRONOUSLY so the next state_change emit carries
    // ext.pending_permission (ADR-0022 F3). Must precede the legacy
    // envelope so a subscriber draining its inbox sees them in order.
    this.#options.onPendingChange?.(pending);

    this.#options.send(
      makePermissionRequest(this.#options.config, ts, payload),
    );

    return new Promise((resolve) => {
      // settle clears the ext pending-record before resolving; the registry
      // owns the pending map, timeout, and shutdown drain (ADR-0027 F5).
      const settle = (decision: PermissionDecision): void => {
        this.#options.onPendingChange?.(null);
        resolve(decision);
      };
      this.#registry.add(requestId, settle, () => ({
        allow: false,
        message: "kaoiro: permission request timed out",
      }));
    });
  }

  /** Resolves a pending request; late/unknown request_ids are ignored
   *  (already timed out or never ours). */
  resolve(decision: PermissionDecisionMessage): void {
    const resolved: PermissionDecision = { allow: decision.allow === true };
    if (decision.message !== undefined) resolved.message = decision.message;
    this.#registry.resolve(decision.request_id, resolved);
  }

  /** Denies all in-flight requests (wrapper shutdown). */
  close(): void {
    this.#registry.closeAll({ allow: false, message: "kaoiro: wrapper closed" });
  }
}
