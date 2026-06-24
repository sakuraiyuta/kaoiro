// Public surface of @kaoiro/runner.

export type { RunnerConfig } from "./config.js";
export {
  ConfigError,
  buildHeartbeat,
  buildRegister,
  loadRunnerConfig,
  parseRunnerConfig,
} from "./config.js";
export { RunnerLink } from "./transport.js";
export type { RunnerLinkOptions } from "./transport.js";
export { parseRunnerArgs } from "./args.js";
export type { RunnerCliArgs } from "./args.js";
export {
  MAX_RESTARTS,
  Supervisor,
  isCwdAllowed,
  parseSpawn,
  readAgentId,
  resolveWrapperConfig,
} from "./supervisor.js";
export type {
  LaunchFn,
  ManagedChild,
  ParsedSpawn,
  SupervisorOptions,
} from "./supervisor.js";
export { makeLauncher, toManagedChild } from "./spawn.js";
export {
  encodeCwd,
  isValidSessionId,
  listSessions,
  projectsDir,
  sessionExists,
} from "./sessions.js";
