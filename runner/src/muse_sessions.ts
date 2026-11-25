// Muse session discovery through ACP `session/list`. Muse Code's own
// on-disk layout is not read: `session/list {cwd}` already applies the
// host's cwd binding. The page reading mirrors grok_sessions.ts, which
// implements the same ACP contract for Grok.

import type { SessionMeta } from "@kaoiro/protocol";
import {
  MuseProbeAborted,
  runMuseProbe,
  type MuseProbeCall,
  type MuseProbeOptions,
} from "./muse_acp_probe.js";

export const MUSE_LIST_PAGE_LIMIT = 20;
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

export type MuseDiscoveryOptions = Omit<MuseProbeOptions, "cwd">;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** One page's entries under `cwd`, or a throw when the page is malformed. A
 *  malformed entry fails the page: a partial list is never authoritative. */
function readPage(result: unknown, cwd: string): {
  sessions: SessionMeta[];
  cursor: string | undefined;
} {
  const page = record(result);
  if (!page || !Array.isArray(page.sessions)) throw new Error("malformed session/list page");
  const sessions: SessionMeta[] = [];
  for (const raw of page.sessions) {
    const entry = record(raw);
    if (!entry || typeof entry.sessionId !== "string" || typeof entry.cwd !== "string")
      throw new Error("malformed session/list entry");
    if (entry.cwd !== cwd || !SESSION_ID_PATTERN.test(entry.sessionId)) continue;
    sessions.push({
      session_id: entry.sessionId,
      ...(typeof entry.title === "string" && entry.title !== "" ? { summary: entry.title } : {}),
      ...(typeof entry.updatedAt === "string" && entry.updatedAt !== "" ? { mtime: entry.updatedAt } : {}),
    });
  }
  const next = page.nextCursor;
  if (next !== undefined && next !== null && (typeof next !== "string" || next === ""))
    throw new Error("malformed session/list cursor");
  return { sessions, cursor: typeof next === "string" ? next : undefined };
}

/** Pages `session/list {cwd}`; `found` may stop the walk early. Throws when
 *  the page limit is reached before the last page. */
async function walk(
  call: MuseProbeCall,
  cwd: string,
  found?: (session: SessionMeta) => boolean,
): Promise<{ sessions: SessionMeta[]; hit: boolean }> {
  const sessions: SessionMeta[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MUSE_LIST_PAGE_LIMIT; page += 1) {
    const result = await call("session/list", cursor === undefined ? { cwd } : { cwd, cursor });
    const read = readPage(result, cwd);
    for (const session of read.sessions) {
      if (found?.(session)) return { sessions, hit: true };
      sessions.push(session);
    }
    if (read.cursor === undefined) return { sessions, hit: false };
    cursor = read.cursor;
  }
  throw new Error("session/list page limit reached");
}

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
    return (await runMuseProbe({ ...options, cwd }, (call) => walk(call, cwd))).sessions;
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
  if (!SESSION_ID_PATTERN.test(sessionId)) return false;
  try {
    return (await runMuseProbe({ ...options, cwd },
      (call) => walk(call, cwd, (session) => session.session_id === sessionId))).hit;
  } catch (error) {
    if (error instanceof MuseProbeAborted) throw error;
    warn(cwd, error);
    return false;
  }
}
