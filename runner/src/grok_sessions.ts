// Grok session discovery through ACP `session/list` (issue #644). Grok's own
// on-disk layout is not read: `session/list {cwd}` already applies Grok's cwd
// binding, including its long-path encoding and GROK_HOME.

import type { SessionMeta } from "@kaoiro/protocol";
import {
  ACP_SESSION_LIST_PAGE_LIMIT,
  isValidAcpSessionId,
  walkAcpSessionPages,
} from "./acp_session_pages.js";
import {
  GrokProbeAborted,
  runGrokProbe,
  type GrokProbeOptions,
} from "./grok_acp_probe.js";

export const GROK_LIST_PAGE_LIMIT = ACP_SESSION_LIST_PAGE_LIMIT;

export type GrokDiscoveryOptions = Omit<GrokProbeOptions, "cwd">;

function warn(cwd: string, error: unknown): void {
  process.stderr.write(
    `runner: grok session discovery failed for ${cwd}: ${error instanceof Error ? error.message : "unknown"}\n`,
  );
}

/** Resume candidates under `cwd`. Any failure gives `[]`; an abort rejects
 *  with GrokProbeAborted so the caller can stay silent. */
export async function listGrokSessions(
  cwd: string,
  options: GrokDiscoveryOptions = {},
): Promise<SessionMeta[]> {
  try {
    const { sessions } = await runGrokProbe({ ...options, cwd }, (call) =>
      walkAcpSessionPages(call, cwd));
    return sessions;
  } catch (error) {
    if (error instanceof GrokProbeAborted) throw error;
    warn(cwd, error);
    return [];
  }
}

/** The T3 check: `sessionId` is listed under `cwd`. Any failure gives false
 *  (session_not_found); an abort rejects with GrokProbeAborted. */
export async function grokSessionExists(
  cwd: string,
  sessionId: string,
  options: GrokDiscoveryOptions = {},
): Promise<boolean> {
  if (!isValidAcpSessionId(sessionId)) return false;
  try {
    const { hit } = await runGrokProbe({ ...options, cwd }, (call) =>
      walkAcpSessionPages(call, cwd, (row) => row.session_id === sessionId));
    return hit;
  } catch (error) {
    if (error instanceof GrokProbeAborted) throw error;
    warn(cwd, error);
    return false;
  }
}
