// @kaoiro/agent-common public surface — the AI-agent common layer shared by
// every engine adapter (ADR-0017 / ADR-0032 F1): the state machine and
// envelope builders, the EngineAdapter interface, the permission / question
// brokers, and the common tool description layer.

export { askUserQuestionDescriptor } from "./ask_user_question.js";
export type { EngineAdapter } from "./engine.js";
export { HistoryReplayer } from "./history_replay.js";
export type {
  HistoryReplayerOptions,
  HydrationVerdict,
} from "./history_replay.js";
export {
  IaSidecar,
  defaultPendingDir,
  isIngressStamp,
  isValidSidecarSessionId,
  parseSidecarLine,
} from "./ia_sidecar.js";
export type { IaSidecarOptions, SidecarRecord } from "./ia_sidecar.js";
export {
  INTER_AGENT_ERROR_CODES,
  INTER_AGENT_ERROR_MESSAGE_CODES,
  INTER_AGENT_TOOL_FQN,
  InterAgentTool,
  LIST_AGENTS_TOOL_FQN,
  SEND_TO_AGENT_INPUT_SHAPE,
  WHOAMI_TOOL_FQN,
  classifyInterAgentError,
  formatInboundMessage,
  isFormattedInterAgentMessage,
} from "./inter_agent.js";
export type {
  InterAgentErrorClassifyInput,
  InterAgentToolOptions,
  WhoamiSnapshot,
} from "./inter_agent.js";
export { MAX_LOG_BYTES, clipText, logEntryToPayload } from "./logpayload.js";
export { PendingRegistry } from "./pending.js";
export {
  computeResumeDrift,
  effectiveStatusEnvelopeFields,
  effectiveStatusWhoamiFields,
} from "./snapshot.js";
export type {
  EffectiveStatusSnapshot,
  EffectiveWhoamiFields,
} from "./snapshot.js";
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
  makeRefreshModelsResult,
  makeStateChange,
  reduceStates,
  stepState,
} from "./state.js";
export type { MachineState } from "./state.js";
export type {
  ToolDescriptor,
  ToolResult,
  ToolResultContent,
} from "./tooling.js";
export type {
  AdapterEvent,
  AssistantBlockKind,
  AttachRejectedPayload,
  Envelope,
  EngineKind,
  FileUploadRejectReason,
  InstructionRejectedPayload,
  InterAgentMessageKind,
  InterAgentMessagePayload,
  KaoiroState,
  LogEntry,
  LogKind,
  LogPayload,
  ModelSource,
  PendingPermissionExt,
  PendingQuestionExt,
  PermissionAxesExt,
  PermissionMode,
  Persona,
  Question,
  QuestionOption,
  ResolvedSnapshotExt,
  ResultPayload,
  ResultSubtype,
  ResumeDriftEntry,
  ResumeDriftExt,
  SessionCapabilitiesExt,
  SwitchErrorExt,
  WirePersona,
  WrapperConfig,
} from "./types.js";
