// @kaoiro/agent-common public surface — the AI-agent common layer shared by
// every engine adapter (ADR-0017 / ADR-0032 F1): the state machine and
// envelope builders, the EngineAdapter interface, the permission / question
// brokers, and the common tool description layer.

export { askUserQuestionDescriptor } from "./ask_user_question.js";
export { mergeExtraModels } from "./catalog.js";
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
export { DeliveryStageReporter } from "./delivery_stages.js";
export type { DeliveryStageIdentity, DeliveryStageSender, DeliveryStageTurnSource } from "./delivery_stages.js";
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
  READ_STATUS_LINE_INPUT_SHAPE,
  READ_STATUS_LINE_TOOL_FQN,
  SEND_TO_AGENT_INPUT_SHAPE,
  SET_STATUS_LINE_INPUT_SHAPE,
  SET_STATUS_LINE_TOOL_FQN,
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
  boundErrorDetail,
  redactCredentials,
  writeRedactedStderr,
} from "./redact.js";
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
  PermissionDecideOptions,
  PermissionDecision,
  SettledPermissionDecision,
} from "./permission.js";
export type { PermissionDecisionMessage } from "./permission.js";
export { QuestionBroker } from "./question.js";
export type {
  QuestionBrokerOptions,
  QuestionDecision,
  QuestionResponseMessage,
} from "./question.js";
export {
  REQUEST_SESSION_RESET_INPUT_SHAPE,
  REQUEST_SESSION_RESET_TOOL_FQN,
  SESSION_RESET_RETRY_DELAY_MS,
  SessionResetCoordinator,
  requestSessionResetDescriptor,
  validateRequestSessionResetInput,
} from "./request_session_reset.js";
export type {
  RequestSessionResetOptions,
  SessionResetAccepted,
  SessionResetCoordinatorOptions,
  SessionResetMode,
  TurnBoundary,
} from "./request_session_reset.js";
export { operatorApprovalGated } from "./approval_gate.js";
export { flagArgument, personaOptInSource } from "./persona_opt_in.js";
export type { PersonaOptInSource } from "./persona_opt_in.js";
export type { ApprovalGateOptions } from "./approval_gate.js";
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
  ToolHandlerContext,
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
  DisplayedModelSource,
  ModelSource,
  PendingPermissionExt,
  PendingQuestionExt,
  PermissionAxesExt,
  PermissionSelection,
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

export { ReplyBasis, REPLY_AUTHORIZATION_USAGE_GUIDANCE, ordinaryPeerInput, bindToolResultHandoff, handoffToolResult, discardToolResult } from "./reply_basis.js";
export type { ReplyOrigin, ReplyAttempt, ReplyAuthorization } from "./reply_basis.js";

export { ToolOrigins } from "./tool_origins.js";
export { workToolDescriptors } from "./work_tools.js";
export { DELIVERY_ENGINE_SETTINGS, DELIVERY_ENV_KEYS, captureDeliveryEnvironment, resolveDelivery } from "./delivery_modes.js";
export type { DeliveryEnvironment, DeliveryInputs } from "./delivery_modes.js";
export { deliveryPersonaList } from "./persona_opt_in.js";
export type { WorkToolHandlers } from "./work_tools.js";
