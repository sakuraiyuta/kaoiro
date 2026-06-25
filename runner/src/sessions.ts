// Session JSONL enumeration and existence checks (ADR-0014 F2/F6, phase 4-5).
// Claude Code persists each conversation at
// `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`; the runner lists these
// to offer resume candidates and verifies a resume target actually exists
// under the bound cwd (threat-model T3).

import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
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

// A resume listing labels each candidate with a short summary (T2: minimal,
// operator-only). It is read from the JSONL head only — the ai-title / opening
// prompt sit near the top, and a listing must not read multi-MB transcripts in
// full (#73).
const SUMMARY_PREFIX_BYTES = 64 * 1024;
const SUMMARY_MAX_CHARS = 100;

/** Collapses whitespace to a single-line label and caps its length. */
function toSummaryLabel(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > SUMMARY_MAX_CHARS
    ? `${oneLine.slice(0, SUMMARY_MAX_CHARS - 3)}...`
    : oneLine;
}

/** The instruction text of a user line: string content, or its text blocks
 *  joined (tool_result-only / empty lines yield undefined). */
function userLineText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.trim() === "" ? undefined : content;
  }
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    const { type, text } = block as { type?: unknown; text?: unknown };
    if (type === "text" && typeof text === "string") parts.push(text);
  }
  const joined = parts.join(" ").trim();
  return joined === "" ? undefined : joined;
}

/** A short, operator-facing label for a session: the SDK's generated title
 *  (`ai-title`) when one sits near the head, else the opening user instruction.
 *  Reads only the file's prefix; returns undefined when neither is found or the
 *  file is unreadable. */
function readSummary(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  let prefix: string;
  try {
    const buf = Buffer.alloc(SUMMARY_PREFIX_BYTES);
    const n = readSync(fd, buf, 0, SUMMARY_PREFIX_BYTES, 0);
    prefix = buf.subarray(0, n).toString("utf8");
    // Drop a trailing partial line only when the read filled the buffer. A
    // single line longer than the prefix (no newline at all) is left intact —
    // JSON.parse rejects the fragment and the scan falls through to undefined,
    // rather than blanking the whole prefix.
    if (n === SUMMARY_PREFIX_BYTES) {
      const lastNewline = prefix.lastIndexOf("\n");
      if (lastNewline !== -1) prefix = prefix.slice(0, lastNewline + 1);
    }
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }

  let firstUser: string | undefined;
  for (const raw of prefix.split("\n")) {
    if (raw.trim() === "") continue;
    let line: {
      type?: unknown;
      aiTitle?: unknown;
      isMeta?: unknown;
      message?: { content?: unknown };
    };
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    // Prefer the AI-generated title (concise); first occurrence wins.
    if (
      line.type === "ai-title" &&
      typeof line.aiTitle === "string" &&
      line.aiTitle.trim() !== ""
    ) {
      return toSummaryLabel(line.aiTitle);
    }
    if (firstUser === undefined && line.type === "user" && line.isMeta !== true) {
      const text = userLineText(line.message?.content);
      if (text !== undefined) firstUser = text;
    }
  }
  return firstUser !== undefined ? toSummaryLabel(firstUser) : undefined;
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
    const summary = readSummary(join(dir, name));
    if (summary !== undefined) meta.summary = summary;
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
