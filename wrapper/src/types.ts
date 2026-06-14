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

/** log payload kind (protocol.md). assistant=model speech, tool_use=tool
 *  call, tool_result=tool output, user=operator instruction echoed into the
 *  transcript (#31). thinking is intentionally not relayed. */
export type LogKind = "assistant" | "tool_use" | "tool_result" | "user";

/** payload of a type="log" envelope (protocol.md). The fields present
 *  depend on `kind`; `truncated` flags wrapper-side size clipping. */
export interface LogPayload {
  kind: LogKind;
  text?: string;
  tool_name?: string;
  input?: Record<string, unknown>;
  output?: string;
  truncated?: boolean;
}

/** payload of a type="result" envelope (protocol.md): the turn's final
 *  reply, with is_error marking an error termination. */
export interface ResultPayload {
  text?: string;
  is_error?: boolean;
}

/**
 * The adapter's normalized view of a relayable log line, before the host
 * turns it into a log/result envelope. tool_result carries the answered
 * tool_use_id so the host can backfill tool_name from its tool_use map.
 */
export type LogEntry =
  | { kind: "assistant"; text: string }
  | {
      kind: "tool_use";
      tool_use_id?: string;
      tool_name: string;
      input: Record<string, unknown>;
    }
  | { kind: "tool_result"; tool_use_id?: string; output: string };

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
  /** Wrapper auth token, paired with agent_id on the server (ADR-0011). */
  server_token?: string;
  /** permission_request no-response window before the default deny
   *  (ADR-0011; defaults to 600s). */
  permission_timeout_ms?: number;
  /** Tool-permission ceiling passed to the SDK as allowedTools. Local
   *  config only — cannot be widened from the server side
   *  (specs/threat-model.md). Omitted = the CLI's read-only default. */
  allowed_tools?: string[];
}

/**
 * Common event envelope v0 (protocol.md). The type enum fixes
 * state_change / permission_request (ADR-0010/0011) and log / result
 * (ADR-0012). payload stays loosely typed; the per-type shapes are
 * LogPayload / ResultPayload above.
 */
export interface Envelope {
  version: "0";
  agent_id: string;
  persona: Persona;
  ts: string;
  /** Wrapper-issued monotonic sequence (ADR-0011), stamped by ServerLink
   *  at send time; absent on envelopes that never go to a server. */
  seq?: number;
  type: "state_change" | "permission_request" | "log" | "result";
  state: KaoiroState;
  payload: Record<string, unknown>;
  ext: Record<string, unknown>;
}
