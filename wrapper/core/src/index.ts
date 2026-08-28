// @kaoiro/wrapper-core public surface — the entity-agnostic base of the
// wrapper family (ADR-0017 / ADR-0032 F1): server transport, config
// loading/validation, and CLI argument parsing. No AI-engine concepts here.

export { parseCliArgs } from "./args.js";
export { ConfigError, PERMISSION_MODES, loadConfig, parseConfig } from "./persona.js";
export {
  MAX_REPLAY_IA_PUSH_BYTES,
  ServerLink,
  chunkReplayIaItems,
  hydrationVerdictFrom,
} from "./transport.js";
export type {
  AttachOpenMessage,
  HydrationVerdictMessage,
  InterAgentAcceptance,
  PermissionDecisionMessage,
  QuestionResponseMessage,
  ReplayIaItem,
  ServerLinkOptions,
} from "./transport.js";
/** Backward-compatible type exports. New consumers should import these
 * directory wire shapes from `@kaoiro/protocol`. */
export type {
  DirectoryContext,
  DirectoryConversation,
  DirectoryEntry,
  DirectoryRateLimitWindow,
  DirectoryResult,
  InterAgentDeliveryStatus,
  UserDirectoryEntry,
  UserRole,
} from "@kaoiro/protocol";
