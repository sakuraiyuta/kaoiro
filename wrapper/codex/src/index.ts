// @kaoiro/codex — Codex CLI engine adapter (ADR-0032, phase-14): wraps
// @openai/codex-sdk (one `codex exec` per turn), derives kaoiro states from
// ThreadEvents, and serves the common tools through the bundled stdio MCP
// bridge. See docs/specs/codex-sdk-events.md.

export {
  threadEventToEvents,
  threadEventToFinalText,
  threadEventToLogs,
  threadEventToSessionId,
  threadEventToTasklist,
} from "./adapter.js";
export { CODEX_ENGINE, resolveCodexCatalog } from "./catalog.js";
export type { ChatGptPlan, CodexAuthMode } from "./catalog.js";
export { CodexHost } from "./host.js";
export type {
  CodexClientLike,
  CodexHostOptions,
  CodexThreadLike,
  CodexLifecycleEvent,
} from "./host.js";
export {
  TurnWatchdog,
  readTurnWatchdogSettings,
} from "./turn_watchdog.js";
export type {
  TurnWatchdogOptions,
  TurnWatchdogSettings,
  TurnWatchdogWarning,
} from "./turn_watchdog.js";
export { ToolHost } from "./toolhost.js";
