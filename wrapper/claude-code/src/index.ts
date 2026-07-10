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
} from "@kaoiro/agent-common";
export {
  initialMachineState,
  makeLog,
  makePermissionRequest,
  makeResult,
  makeStateChange,
  reduceStates,
  stepState,
} from "@kaoiro/agent-common";
export type { MachineState } from "@kaoiro/agent-common";
export { ConfigError, loadConfig, parseConfig } from "@kaoiro/wrapper-core";
export {
  sdkMessageToCost,
  sdkMessageToEvents,
  sdkMessageToLogs,
  sdkMessageToRateLimit,
  sdkMessageToResult,
} from "./adapter.js";
export { AgentHost } from "./host.js";
export type { AgentHostOptions, PermissionDecision } from "./host.js";
export { ServerLink } from "@kaoiro/wrapper-core";
export type { ServerLinkOptions } from "@kaoiro/wrapper-core";
export { PermissionBroker } from "@kaoiro/agent-common";
export type {
  PermissionBrokerOptions,
  PermissionDecisionMessage,
} from "@kaoiro/agent-common";
