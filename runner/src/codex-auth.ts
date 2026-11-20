import type { CodexAuthMode as CatalogAuthMode } from "@kaoiro/codex";
import type { CodexConfig } from "./config.js";

export type CodexAuthMode = CatalogAuthMode;

export const CODEX_AUTH_MODE_UNSET_WARNING =
  'runner: warn — codex.auth_mode is not set; using unknown ' +
  '(standard Codex model catalog is empty; set codex.auth_mode to "apikey", ' +
  'or to "chatgpt" with codex.chatgpt_plan)\n';

/** Startup / hot-reload input for Codex auth-mode resolution.
 *  Explicit `codex.auth_mode` is used verbatim; unset resolves to `"unknown"`
 *  without invoking `codex doctor` (issue #1214). Implicit inference from
 *  `chatgpt_plan` is forbidden. */
export interface AuthModeResolveInput {
  nextCodex: CodexConfig | undefined;
  nextEnabled: boolean;
}

export async function resolveCodexAuthMode(
  input: AuthModeResolveInput,
): Promise<CodexAuthMode> {
  if (!input.nextEnabled) return "unknown";
  return input.nextCodex?.auth_mode ?? "unknown";
}

export interface CodexAuthModeWarningInput {
  nextCodex: CodexConfig | undefined;
  nextEnabled: boolean;
  prevCodex?: CodexConfig | undefined;
  prevEnabled?: boolean;
}

function isUnsetWhileEnabled(
  enabled: boolean,
  codex: CodexConfig | undefined,
): boolean {
  return enabled && codex?.auth_mode === undefined;
}

/** Whether to emit `CODEX_AUTH_MODE_UNSET_WARNING` after applying config.
 *  Startup warns when Codex is enabled with no `auth_mode`; reload warns only
 *  on transitions into that state (off -> on or explicit -> absent). */
export function shouldWarnUnsetCodexAuthMode(
  input: CodexAuthModeWarningInput,
): boolean {
  if (!isUnsetWhileEnabled(input.nextEnabled, input.nextCodex)) return false;
  if (input.prevEnabled === undefined) return true;
  return !isUnsetWhileEnabled(input.prevEnabled, input.prevCodex);
}
