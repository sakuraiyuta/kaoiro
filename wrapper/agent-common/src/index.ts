// @kaoiro/agent-common public surface — the AI-agent common layer shared by
// every engine adapter (ADR-0017 / ADR-0032 F1): the state machine and
// envelope builders, the EngineAdapter interface, the permission / question
// brokers, and the common tool description layer.

export { askUserQuestionDescriptor } from "./ask_user_question.js";
export type { EngineAdapter } from "./engine.js";
export { mergePendingDisplayNameSync } from "./engine.js";
export { HistoryReplayer } from "./history_replay.js";
export {
  createDeliveryAcknowledgementRuntime,
  createDeliveryAcknowledgementWiring,
  DeliveryAcknowledgement,
  DeliveryAcknowledger,
} from "./delivery_ack.js";
export type {
  DeliveryAcknowledgementRuntime,
  DeliveryAcknowledgementWiring,
  DeliveryTurnSource,
} from "./delivery_ack.js";
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
  MAX_COALESCED_BYTES,
  MAX_COALESCED_MESSAGES,
  SEND_TO_AGENT_INPUT_SHAPE,
  WHOAMI_TOOL_FQN,
  canAddToCoalescedBatch,
  classifyInterAgentError,
  formatInboundMessage,
  formatInboundMessages,
  isFormattedInterAgentMessage,
} from "./inter_agent.js";
export type {
  InboundReplyMode,
  InterAgentErrorClassifyInput,
  InterAgentToolOptions,
  InterAgentDeliverySnapshot,
  WhoamiSnapshot,
} from "./inter_agent.js";
export { MAX_LOG_BYTES, clipText, logEntryToPayload } from "./logpayload.js";
export {
  MAX_TASKLIST_ITEMS,
  MAX_TASKLIST_ITEMS_JSON_BYTES,
  MAX_TASKLIST_ITEM_TEXT_BYTES,
  TASKLIST_TASK_ID,
  normalizeTasklist,
} from "./tasklist.js";
export type { TasklistSourceItem, TasklistSnapshot } from "./tasklist.js";
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
export {
  fitsApprovalPayload,
  MAX_INPUT_BYTES,
  PermissionBroker,
} from "./permission.js";
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
  makeTask,
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
  TaskPayload,
  TaskStatus,
  TasklistItem,
  TasklistItemStatus,
  TasklistOmitted,
  WirePersona,
  WrapperConfig,
} from "./types.js";
