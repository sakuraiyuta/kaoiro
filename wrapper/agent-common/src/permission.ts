// Permission broker — bridges canUseTool to the client approval UI
// (protocol.md "承認フロー", ADR-0011 / ADR-0022). decide() sends a
// permission_request envelope (initial notification) AND fires
// onPendingChange so the host can stamp the authoritative pending state
// onto state_change.ext.pending_permission. The promise is held until
// a relayed permission_decision resolves it; if a finite timeoutMs is
// configured it denies on no-response (fail-closed), otherwise it waits
// indefinitely matching the SDK's canUseTool default (ADR-0022 F6).

import { randomUUID } from "node:crypto";
import type { PermissionDecisionMessage } from "@kaoiro/wrapper-core";
import { PendingRegistry } from "./pending.js";
import { makePermissionRequest } from "./state.js";
import type { Envelope, PendingPermissionExt, WrapperConfig } from "./types.js";

/** Tool input above this serialized size is dropped from the request
 *  payload (specs/protocol.md, specs/threat-model.md). Exported so a
 *  caller that wants to fail closed on an oversized input BEFORE it ever
 *  reaches an approval dialog can compare against the same ceiling
 *  {@link fitsApprovalPayload} enforces here. */
export const MAX_INPUT_BYTES = 16_384;

/** Whether a tool `input` would still carry its payload once `decide()`
 *  serializes it — the exact arithmetic below, exported so a caller
 *  outside this class can reuse it instead of re-deriving a ceiling that
 *  could silently drift from the broker's own. Raw byte counts on
 *  individual fields are not a substitute: JSON escaping (quotes,
 *  backslashes, newlines) can inflate the serialized size well past the
 *  sum of the fields' own UTF-8 lengths. */
export function fitsApprovalPayload(input: Record<string, unknown>): boolean {
  return Buffer.byteLength(JSON.stringify(input), "utf8") <= MAX_INPUT_BYTES;
}

/** The broker's answer handed back to the engine host (engine-agnostic;
 *  the Claude adapter forwards it to canUseTool). */
export interface PermissionDecision {
  allow: boolean;
  /** Reason returned to the agent when denied. */
  message?: string;
}

export type { PermissionDecisionMessage } from "@kaoiro/wrapper-core";

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
  /** Live pending records in arrival order (issue #285 review round 1, M2).
   *  ADR-0022 gives the wrapper ONE authoritative pending slot, so concurrent
   *  tool calls compete for it: the newest request takes the slot, and when
   *  one settles the slot falls back to whatever is still live instead of
   *  going empty. Left empty, a request nobody answered stays hidden from the
   *  operator with no way back — the dialog is its only settle path. */
  readonly #live = new Map<string, PendingPermissionExt>();

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
    if (fitsApprovalPayload(input)) {
      payload.input = input;
      pending.input = input;
    } else {
      payload.truncated = true;
      pending.truncated = true;
    }

    // Notify host SYNCHRONOUSLY so the next state_change emit carries
    // ext.pending_permission (ADR-0022 F3). Must precede the legacy
    // envelope so a subscriber draining its inbox sees them in order.
    this.#live.set(requestId, pending);
    this.#options.onPendingChange?.(this.#slot());

    this.#options.send(
      makePermissionRequest(this.#options.config, ts, payload),
    );

    return new Promise((resolve) => {
      // settle clears the ext pending-record before resolving; the registry
      // owns the pending map, timeout, and shutdown drain (ADR-0027 F5).
      const settle = (decision: PermissionDecision): void => {
        this.#live.delete(requestId);
        this.#options.onPendingChange?.(this.#slot());
        resolve(decision);
      };
      this.#registry.add(requestId, settle, () => ({
        allow: false,
        message: "kaoiro: permission request timed out",
      }));
    });
  }

  /** The record the single authoritative slot should currently show: the
   *  newest live request, or null when none is left. */
  #slot(): PendingPermissionExt | null {
    let newest: PendingPermissionExt | null = null;
    for (const pending of this.#live.values()) newest = pending;
    return newest;
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
