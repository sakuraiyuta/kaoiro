// Wrapper public API: state machine, persona config, SDK adapter, and host.

export type {
  AdapterEvent,
  AssistantBlockKind,
  Envelope,
  KaoiroState,
  LogEntry,
  LogKind,
  LogPayload,
  PendingPermissionExt,
  Persona,
  ResultPayload,
  ResultSubtype,
  WrapperConfig,
} from "./types.js";
export {
  initialMachineState,
  makeLog,
  makePermissionRequest,
  makeResult,
  makeStateChange,
  reduceStates,
  stepState,
} from "./state.js";
export type { MachineState } from "./state.js";
export {
  COMMON_FOOTER,
  ConfigError,
  loadConfig,
  parseConfig,
  resolvePersonaAppend,
} from "./persona.js";
export {
  sdkMessageToCost,
  sdkMessageToEvents,
  sdkMessageToLogs,
  sdkMessageToRateLimit,
  sdkMessageToResult,
} from "./adapter.js";
export { AgentHost } from "./host.js";
export type { AgentHostOptions, PermissionDecision } from "./host.js";
export { ServerLink } from "./transport.js";
export type { ServerLinkOptions } from "./transport.js";
export { PermissionBroker } from "./permission.js";
export type {
  PermissionBrokerOptions,
  PermissionDecisionMessage,
} from "./permission.js";
