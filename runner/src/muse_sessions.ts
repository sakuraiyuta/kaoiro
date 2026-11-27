// Muse session discovery through ACP `session/list`. Muse Code's own
// on-disk layout is not read: `session/list {cwd}` already applies the
// host's cwd binding.

import type { SessionMeta } from "@kaoiro/protocol";
import {
  ACP_SESSION_LIST_PAGE_LIMIT,
  isValidAcpSessionId,
  walkAcpSessionPages,
} from "./acp_session_pages.js";
import {
  MuseProbeAborted,
  runMuseProbe,
  type MuseProbeOptions,
} from "./muse_acp_probe.js";

export const MUSE_LIST_PAGE_LIMIT = ACP_SESSION_LIST_PAGE_LIMIT;

export type MuseDiscoveryOptions = Omit<MuseProbeOptions, "cwd">;

function warn(cwd: string, error: unknown): void {
  process.stderr.write(
    `runner: muse session discovery failed for ${cwd}: ${error instanceof Error ? error.message : "unknown"}\n`,
  );
}

/** Resume candidates under `cwd`. Any failure gives `[]`; an abort rejects
 *  with MuseProbeAborted so the caller can stay silent. */
export async function listMuseSessions(
  cwd: string,
  options: MuseDiscoveryOptions = {},
): Promise<SessionMeta[]> {
  try {
    const { sessions } = await runMuseProbe({ ...options, cwd }, (call) =>
      walkAcpSessionPages(call, cwd));
    return sessions;
  } catch (error) {
    if (error instanceof MuseProbeAborted) throw error;
    warn(cwd, error);
    return [];
  }
}

/** The T3 check: `sessionId` is listed under `cwd`. Any failure gives false
 *  (session_not_found); an abort rejects with MuseProbeAborted. */
export async function museSessionExists(
  cwd: string,
  sessionId: string,
  options: MuseDiscoveryOptions = {},
): Promise<boolean> {
  if (!isValidAcpSessionId(sessionId)) return false;
  try {
    const { hit } = await runMuseProbe({ ...options, cwd }, (call) =>
      walkAcpSessionPages(call, cwd, (row) => row.session_id === sessionId));
    return hit;
  } catch (error) {
    if (error instanceof MuseProbeAborted) throw error;
    warn(cwd, error);
    return false;
  }
}
