import type { CodexAuthMode as CatalogAuthMode } from "@kaoiro/codex";
import type { CodexConfig } from "./config.js";

export type CodexAuthMode = CatalogAuthMode;

export const CODEX_AUTH_MODE_UNSET_WARNING =
  'runner: warn — codex.auth_mode is not set; using unknown ' +
  '(standard Codex model catalog is empty; set codex.auth_mode to "apikey", ' +
  'or to "chatgpt" with codex.chatgpt_plan)\n';

/** Startup input for Codex auth-mode resolution.
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

export function shouldWarnUnsetCodexAuthMode(input: AuthModeResolveInput): boolean {
  return input.nextEnabled && input.nextCodex?.auth_mode === undefined;
}
