// @kaoiro/wrapper-core public surface — the entity-agnostic base of the
// wrapper family (ADR-0017 / ADR-0032 F1): server transport, config
// loading/validation, and CLI argument parsing. No AI-engine concepts here.

export { parseCliArgs } from "./args.js";
export { ConfigError, PERMISSION_MODES, loadConfig, parseConfig } from "./persona.js";
export {
  CLAUDE_SCHEDULER_SETTINGS,
  claudeSchedulerRangeMessage,
  isClaudeSchedulerEnvSet,
  parseClaudeSchedulerNumber,
} from "./claude_scheduler.js";
export { formatConsumerSettingsLine } from "./consumer_settings.js";
export {
  PERMISSION_TIMEOUT_ENV,
  isPermissionTimeoutEnvSet,
  parsePermissionTimeoutEnv,
} from "./permission_timeout.js";
export {
  TURN_WATCHDOG_MAX_DELAY_MS,
  TURN_WATCHDOG_MIN_ABORT_GRACE_MS,
  TURN_WATCHDOG_MIN_INACTIVITY_MS,
  formatTurnWatchdogLine,
  readDigitsMs,
  resolveDigitsMs,
} from "./turn_watchdog_settings.js";
export type { ResolvedMs, SettingSource } from "./turn_watchdog_settings.js";
export type {
  ClaudeSchedulerField,
  ClaudeSchedulerSetting,
} from "./claude_scheduler.js";
export {
  isWrapperBuildInfoConsistent,
  loadWrapperBuildInfo,
  normalizeWrapperBuildInfo,
} from "./build_info.js";
export type { WrapperBuildInfo } from "./build_info.js";
export { WrapperShutdownBudget } from "./shutdown_budget.js";
export type { ShutdownPhase } from "./shutdown_budget.js";
export { WrapperShutdown } from "./shutdown.js";
export type { WrapperDisconnectReason, WrapperShutdownHooks } from "./shutdown.js";
export {
  MAX_LOG_BYTES,
  boundErrorDetail,
  clipText,
  redactCredentials,
  writeRedactedStderr,
} from "./redact.js";
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
