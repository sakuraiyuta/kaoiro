// Session JSONL enumeration and existence checks (ADR-0014 F2/F6, phase 4-5).
// Claude Code persists each conversation at
// `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`; the runner lists these
// to offer resume candidates and verifies a resume target actually exists
// under the bound cwd (threat-model T3).

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionMeta } from "@kaoiro/protocol";

/** session_id rides a JSONL filename and the wrapper's `--resume` arg, so its
 *  charset is restricted (UUID-shaped: letters, digits, hyphen) — no path
 *  separators or dots, which keeps it safe in both. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]+$/;
const MAX_SESSION_ID = 128;
const JSONL = ".jsonl";

export function isValidSessionId(sessionId: string): boolean {
  return (
    sessionId.length > 0 &&
    sessionId.length <= MAX_SESSION_ID &&
    SESSION_ID_PATTERN.test(sessionId)
  );
}

/** Encodes an absolute cwd into the Claude projects dir name. Observed
 *  convention: every non-alphanumeric character becomes '-'. */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Absolute path to the projects dir holding a cwd's session JSONLs. */
export function projectsDir(cwd: string): string {
  return join(homedir(), ".claude", "projects", encodeCwd(cwd));
}

/** Lists the session JSONLs in a projects dir with minimal meta (T2: minimal,
 *  operator-only). Returns [] when the dir is absent or unreadable. Split from
 *  listSessions so the readdir/filter/stat logic is testable against a fixture
 *  dir without depending on the home directory. */
export function listSessionsIn(dir: string): SessionMeta[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const sessions: SessionMeta[] = [];
  for (const name of names) {
    if (!name.endsWith(JSONL)) continue;
    const sessionId = name.slice(0, -JSONL.length);
    if (!isValidSessionId(sessionId)) continue;
    const meta: SessionMeta = { session_id: sessionId };
    try {
      meta.mtime = statSync(join(dir, name)).mtime.toISOString();
    } catch {
      // Vanished between readdir and stat; report it without an mtime.
    }
    sessions.push(meta);
  }
  return sessions;
}

/** True when session_id is charset-valid AND its JSONL exists in dir. */
export function sessionExistsIn(dir: string, sessionId: string): boolean {
  if (!isValidSessionId(sessionId)) return false;
  try {
    return statSync(join(dir, `${sessionId}${JSONL}`)).isFile();
  } catch {
    return false;
  }
}

/** Lists the resume candidates under cwd (ADR-0014 F2). */
export function listSessions(cwd: string): SessionMeta[] {
  return listSessionsIn(projectsDir(cwd));
}

/** The T3 existence check: session_id is valid AND its JSONL exists under the
 *  bound cwd, gating a resume to that cwd. */
export function sessionExists(cwd: string, sessionId: string): boolean {
  return sessionExistsIn(projectsDir(cwd), sessionId);
}
