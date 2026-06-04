// Wrapper public API. The real SDK host (query/canUseTool) is added next phase.

export type {
  AdapterEvent,
  AssistantBlockKind,
  Envelope,
  KaoiroState,
  Persona,
  ResultSubtype,
  WrapperConfig,
} from "./types.js";
export { deriveStates, makeStateChange, reduceStates } from "./state.js";
export { ConfigError, loadConfig, parseConfig } from "./persona.js";
export { sdkMessageToEvents } from "./adapter.js";
export { AgentHost } from "./host.js";
export type { AgentHostOptions, PermissionDecision } from "./host.js";
