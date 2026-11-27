import type { SessionMeta } from "@kaoiro/protocol";

export const ACP_SESSION_LIST_PAGE_LIMIT = 20;
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

export function isValidAcpSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

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
  if (!page || !Array.isArray(page.sessions)) {
    throw new Error("malformed session/list page");
  }
  const sessions: SessionMeta[] = [];
  for (const raw of page.sessions) {
    const entry = record(raw);
    if (typeof entry?.sessionId !== "string" || typeof entry.cwd !== "string") {
      throw new Error("malformed session/list entry");
    }
    const { sessionId, title, updatedAt } = entry;
    if (entry.cwd !== cwd || !isValidAcpSessionId(sessionId)) continue;
    const session: SessionMeta = { session_id: sessionId };
    if (typeof title === "string" && title !== "") session.summary = title;
    if (typeof updatedAt === "string" && updatedAt !== "") {
      session.mtime = updatedAt;
    }
    sessions.push(session);
  }
  const cursor = page.nextCursor ?? undefined;
  if (cursor !== undefined && (typeof cursor !== "string" || cursor === "")) {
    throw new Error("malformed session/list cursor");
  }
  return { sessions, cursor };
}

/** Pages `session/list {cwd}`; `found` may stop the walk early. Throws when
 *  the page limit is reached before the last page. */
export async function walkAcpSessionPages(
  call: (method: string, params: unknown) => Promise<unknown>,
  cwd: string,
  found?: (session: SessionMeta) => boolean,
): Promise<{ sessions: SessionMeta[]; hit: boolean }> {
  const sessions: SessionMeta[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < ACP_SESSION_LIST_PAGE_LIMIT; page += 1) {
    const params = cursor === undefined ? { cwd } : { cwd, cursor };
    const read = readPage(await call("session/list", params), cwd);
    for (const session of read.sessions) {
      if (found?.(session)) return { sessions, hit: true };
      sessions.push(session);
    }
    if (read.cursor === undefined) return { sessions, hit: false };
    cursor = read.cursor;
  }
  throw new Error("session/list page limit reached");
}
