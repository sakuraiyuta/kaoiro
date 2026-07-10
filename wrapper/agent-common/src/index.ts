// @kaoiro/agent-common public surface — the AI-agent common layer shared by
// every engine adapter (ADR-0017 / ADR-0032 F1): the state machine and
// envelope builders, the EngineAdapter interface, the permission / question
// brokers, and the common tool description layer.

export type { EngineAdapter } from "./engine.js";
export {
  MAX_LOG_BYTES,
  clipText,
  logEntryToPayload,
} from "./logpayload.js";
export { PendingRegistry } from "./pending.js";
export { PermissionBroker } from "./permission.js";
export type {
  PermissionBrokerOptions,
  PermissionDecision,
} from "./permission.js";
export type { PermissionDecisionMessage } from "./permission.js";
export { QuestionBroker } from "./question.js";
export type {
  QuestionBrokerOptions,
  QuestionDecision,
  QuestionResponseMessage,
} from "./question.js";
export {
  initialMachineState,
  makeAttachRejected,
  makeInstructionRejected,
  makeInterAgentMessage,
  makeLog,
  makePermissionRequest,
  makeQuestionRequest,
  makeResult,
  makeStateChange,
  reduceStates,
  stepState,
} from "./state.js";
export type { MachineState } from "./state.js";
export type { ToolDescriptor, ToolResult, ToolResultContent } from "./tooling.js";
export type {
  AdapterEvent,
  AssistantBlockKind,
  AttachRejectedPayload,
  Envelope,
  FileUploadRejectReason,
  InstructionRejectedPayload,
  InterAgentMessageKind,
  InterAgentMessagePayload,
  KaoiroState,
  LogEntry,
  LogKind,
  LogPayload,
  PendingPermissionExt,
  PendingQuestionExt,
  PermissionMode,
  Persona,
  Question,
  QuestionOption,
  ResultPayload,
  ResultSubtype,
  WirePersona,
  WrapperConfig,
} from "./types.js";
