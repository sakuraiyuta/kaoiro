// Light entry for the runner: the Claude wrapper's operator-setting readers,
// without loading the SDK-hosting modules behind the package root.

export {
  CLAUDE_SCHEDULER_SETTINGS,
  claudeSchedulerRangeMessage,
  isClaudeSchedulerEnvSet,
  parseClaudeSchedulerNumber,
} from "@kaoiro/wrapper-core";
export type {
  ClaudeSchedulerField,
  ClaudeSchedulerSetting,
} from "@kaoiro/wrapper-core";
export {
  PERMISSION_TIMEOUT_ENV,
  TURN_WATCHDOG_MAX_DELAY_MS,
  TURN_WATCHDOG_MIN_ABORT_GRACE_MS,
  TURN_WATCHDOG_MIN_INACTIVITY_MS,
  isPermissionTimeoutEnvSet,
  parsePermissionTimeoutEnv,
} from "@kaoiro/wrapper-core";
export { readTurnWatchdogSettings } from "./turn_watchdog.js";
