// Common event/protocol v0 types and the state-machine input events.
// Mirrors docs/specs/protocol.md and docs/specs/agent-sdk-events.md.

/** State set v0 (protocol.md). `disconnected` is derived server-side and is
 *  therefore not handled by the wrapper. */
export type KaoiroState =
  | "idle"
  | "thinking"
  | "tool_running"
  | "waiting_permission"
  | "waiting_input"
  | "done"
  | "error";

/** SDKResultMessage.subtype (agent-sdk-events.md). */
export type ResultSubtype =
  | "success"
  | "error_max_turns"
  | "error_during_execution"
  | "error_max_budget_usd"
  | "error_max_structured_output_retries";

/** SDKAssistantMessage content-block kinds that affect state derivation. */
export type AssistantBlockKind = "text" | "thinking" | "tool_use";

/**
 * The state-machine input: the adapter's normalized view of the SDK message
 * stream plus canUseTool. Bridging the real SDK types
 * (`@anthropic-ai/claude-agent-sdk`) into this shape is done by the adapter
 * wiring in the next phase, keeping state derivation free of SDK dependencies.
 */
export type AdapterEvent =
  /** SDKSystemMessage (init) */
  | { kind: "session_init" }
  /** SDKAssistantMessage. content kinds map to blocks, message.error to error.
   *  toolUseIds lists the ids of tool_use blocks (omitted when none). */
  | {
      kind: "assistant";
      blocks: AssistantBlockKind[];
      error?: boolean;
      toolUseIds?: string[];
    }
  /** tool_result block(s) of an SDKUserMessage. toolUseIds lists the answered
   *  tool_use ids (omitted when none could be extracted). */
  | { kind: "tool_result"; toolUseIds?: string[] }
  /** SDKResultMessage */
  | { kind: "result"; subtype: ResultSubtype }
  /** canUseTool invoked (promise pending) */
  | { kind: "permission_request" }
  /** canUseTool resolved (UI returned allow/deny) */
  | { kind: "permission_resolved" }
  /** SDKPartialAssistantMessage and other messages with no coarse-state effect */
  | { kind: "ignore" };

/** Assigned persona (protocol.md / ADR-0003). */
export interface Persona {
  id: string;
  name: string;
  sprite_set: string;
}

/** Wrapper init config. agent_id is a stable id, constant across restarts.
 *  server_url, when set, points the wrapper at the kaoiro server's wrapper
 *  socket (ws:// or wss://); omitted = local-only (no relay). */
export interface WrapperConfig {
  agent_id: string;
  persona: Persona;
  server_url?: string;
}

/**
 * Common event envelope v0 (protocol.md).
 * Per ADR-0010 the type enum fixes state_change only; log /
 * permission_request / result are reserved names, so payload stays loosely
 * typed until those are specified.
 */
export interface Envelope {
  version: "0";
  agent_id: string;
  persona: Persona;
  ts: string;
  type: "state_change";
  state: KaoiroState;
  payload: Record<string, unknown>;
  ext: Record<string, unknown>;
}
