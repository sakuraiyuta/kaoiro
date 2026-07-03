// Wrapper-internal types: the adapter's normalized view of the SDK stream and
// the state-machine input events. The shared on-the-wire/protocol types
// (Envelope, KaoiroState, payloads, Persona, WrapperConfig, ...) live in
// @kaoiro/protocol and are re-exported here so wrapper modules keep importing
// from "./types.js". ResultSubtype / AssistantBlockKind stay here as they are
// Claude-SDK-coupled, not part of the shared wire protocol.

export type {
  KaoiroState,
  LogKind,
  LogPayload,
  ResultPayload,
  PermissionMode,
  Persona,
  WirePersona,
  WrapperConfig,
  PendingPermissionExt,
  PendingQuestionExt,
  Question,
  QuestionOption,
  Envelope,
  FileUploadRejectReason,
  AttachRejectedPayload,
  InstructionRejectedPayload,
  InterAgentMessageKind,
  InterAgentMessagePayload,
} from "@kaoiro/protocol";

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
  /** canUseTool invoked for AskUserQuestion (promise pending), ADR-0027 */
  | { kind: "question_request" }
  /** AskUserQuestion resolved (UI returned answers / cancel), ADR-0027 */
  | { kind: "question_resolved" }
  /** An operator instruction was accepted into the input queue. Not an SDK
   *  message — the host raises it so a turn started from rest shows `sending`
   *  until the model's first message arrives (#32). */
  | { kind: "user_send" }
  /** SDKPartialAssistantMessage and other messages with no coarse-state effect */
  | { kind: "ignore" };
