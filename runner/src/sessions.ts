// Session enumeration and existence checks (ADR-0014 F2/F6, phase 4-5),
// per engine (ADR-0032 F8):
//
// - claude-code persists each conversation at
//   `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`
// - codex persists each thread at
//   `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, with the cwd
//   recorded in the first line's session_meta (verified 2026-07-10; the
//   internal state_5.sqlite index is deliberately not relied on)
// - antigravity enumeration is a stub (phase-34 B3): ADR-0057 F7 names
//   `~/.gemini/antigravity-cli/conversations/*.db` as the metadata source,
//   but reading it is deferred to Stage B, so both functions below report
//   "no sessions" for this engine rather than guessing the schema.
//
// The runner lists these to offer resume candidates and verifies a resume
// target actually exists under the bound cwd (threat-model T3).

import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import {
  open as openFile,
  readdir as readDirectory,
  stat as statFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EngineKind, SessionMeta } from "@kaoiro/protocol";

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
    if (
      firstUser === undefined &&
      line.type === "user" &&
      line.isMeta !== true
    ) {
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

// ---- codex rollouts (ADR-0032 F8) ----

/** Root of the codex session store. */
export function codexSessionsRoot(): string {
  return join(homedir(), ".codex", "sessions");
}

/** rollout filename -> session id (the trailing UUID), or null. */
function codexSessionIdOf(name: string): string | null {
  if (!name.startsWith("rollout-") || !name.endsWith(JSONL)) return null;
  // rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl — the uuid is the last 5
  // hyphen-groups (36 chars).
  const stem = name.slice(0, -JSONL.length);
  const id = stem.slice(-36);
  return isValidSessionId(id) && id.length === 36 ? id : null;
}

/** Reads the first line of a rollout and returns its session_meta cwd, or
 *  null when unreadable/foreign. The first line can be sizable (it embeds
 *  the base instructions), so a generous prefix is read. */
const CODEX_META_PREFIX_BYTES = 256 * 1024;

async function codexRolloutCwd(path: string): Promise<string | null> {
  let file: Awaited<ReturnType<typeof openFile>>;
  try {
    file = await openFile(path, "r");
  } catch {
    return null;
  }
  let prefix: string;
  try {
    const buf = Buffer.alloc(CODEX_META_PREFIX_BYTES);
    const { bytesRead } = await file.read(buf, 0, CODEX_META_PREFIX_BYTES, 0);
    prefix = buf.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await file.close();
  }
  const newline = prefix.indexOf("\n");
  const first = newline === -1 ? prefix : prefix.slice(0, newline);
  try {
    const line = JSON.parse(first) as {
      type?: unknown;
      payload?: { cwd?: unknown };
    };
    if (line.type !== "session_meta") return null;
    return typeof line.payload?.cwd === "string" ? line.payload.cwd : null;
  } catch {
    return null;
  }
}

const CODEX_DATE_COMPONENT = /^\d{2}$/;
const CODEX_YEAR_COMPONENT = /^\d{4}$/;

interface CodexRolloutFile {
  name: string;
  path: string;
}

/** Reads one date-tree level without throwing. `withFileTypes` lets the walk
 *  ignore files/symlinks where a YYYY/MM/DD directory is expected, avoiding
 *  the unbounded recursive flattening that previously ran on the event loop. */
async function dateDirectories(
  path: string,
  pattern: RegExp,
): Promise<string[]> {
  try {
    const entries = await readDirectory(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

/** Yields rollout files newest date/name first using async filesystem calls.
 *  The Codex store has a fixed YYYY/MM/DD depth, so an explicit bounded walk
 *  is both cheaper and safer than `readdirSync({recursive:true})`. Consumers
 *  that only need one session can return early without scanning older days. */
async function* codexRolloutFiles(
  root: string,
): AsyncGenerator<CodexRolloutFile> {
  for (const year of await dateDirectories(root, CODEX_YEAR_COMPONENT)) {
    const yearPath = join(root, year);
    for (const month of await dateDirectories(yearPath, CODEX_DATE_COMPONENT)) {
      const monthPath = join(yearPath, month);
      for (const day of await dateDirectories(
        monthPath,
        CODEX_DATE_COMPONENT,
      )) {
        const dayPath = join(monthPath, day);
        let names: string[];
        try {
          const entries = await readDirectory(dayPath, { withFileTypes: true });
          names = entries
            .filter(
              (entry) =>
                entry.isFile() && codexSessionIdOf(entry.name) !== null,
            )
            .map((entry) => entry.name)
            .sort((a, b) => b.localeCompare(a));
        } catch {
          continue;
        }
        for (const name of names) yield { name, path: join(dayPath, name) };
      }
    }
  }
}

/** Lists codex rollouts under root whose session_meta.cwd matches. Split
 *  from listCodexSessions so it is testable against a fixture dir. */
export async function listCodexSessionsIn(
  root: string,
  cwd: string,
): Promise<SessionMeta[]> {
  const sessions: SessionMeta[] = [];
  for await (const rollout of codexRolloutFiles(root)) {
    const sessionId = codexSessionIdOf(rollout.name);
    if (sessionId === null) continue;
    if ((await codexRolloutCwd(rollout.path)) !== cwd) continue;
    const meta: SessionMeta = { session_id: sessionId };
    try {
      meta.mtime = (await statFile(rollout.path)).mtime.toISOString();
    } catch {
      // Vanished between readdir and stat; report it without an mtime.
    }
    sessions.push(meta);
  }
  return sessions;
}

/** True when session_id names a rollout under root whose cwd matches (T3).
 *  A resume of the same session can create a new rollout under a different
 *  day-dir with the same UUID; walk to a cwd match instead of returning at
 *  the first UUID hit, so this stays symmetric with listCodexSessionsIn. */
export async function codexSessionExistsIn(
  root: string,
  cwd: string,
  sessionId: string,
): Promise<boolean> {
  if (!isValidSessionId(sessionId)) return false;
  for await (const rollout of codexRolloutFiles(root)) {
    if (codexSessionIdOf(rollout.name) !== sessionId) continue;
    if ((await codexRolloutCwd(rollout.path)) === cwd) return true;
  }
  return false;
}

// ---- engine dispatch ----

/** Lists the resume candidates under cwd (ADR-0014 F2), per engine.
 *  antigravity is a stub returning no candidates (phase-34 B3 TODO: read
 *  `~/.gemini/antigravity-cli/conversations/*.db`, ADR-0057 F7). */
export function listSessions(
  cwd: string,
  engine: EngineKind = "claude-code",
): SessionMeta[] | Promise<SessionMeta[]> {
  if (engine === "antigravity") return [];
  return engine === "codex"
    ? listCodexSessionsIn(codexSessionsRoot(), cwd)
    : listSessionsIn(projectsDir(cwd));
}

/** The T3 existence check: session_id is valid AND exists in the engine's
 *  session store under the bound cwd, gating a resume to that cwd.
 *  antigravity is a stub always reporting no match (phase-34 B3 TODO, see
 *  `listSessions`) — a resume request against this engine fails T3 rather
 *  than resuming an unverified session_id. */
export function sessionExists(
  cwd: string,
  sessionId: string,
  engine: EngineKind = "claude-code",
): boolean | Promise<boolean> {
  if (engine === "antigravity") return false;
  return engine === "codex"
    ? codexSessionExistsIn(codexSessionsRoot(), cwd, sessionId)
    : sessionExistsIn(projectsDir(cwd), sessionId);
}
