// Session enumeration and existence checks (ADR-0014 F2/F6, phase 4-5),
// per engine (ADR-0032 F8):
//
// - claude-code persists each conversation at
//   `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`
// - codex persists each thread at
//   `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, with the cwd
//   recorded in the first line's session_meta (verified 2026-07-10; the
//   internal state_5.sqlite index is deliberately not relied on)
// - antigravity reads bounded metadata from
//   `~/.gemini/antigravity-cli/conversation_summaries.db` (issue #386).
//
// The runner lists these to offer resume candidates and verifies a resume
// target actually exists under the bound cwd (threat-model T3).

import {
  closeSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import {
  open as openFile,
  readdir as readDirectory,
  stat as statFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { EngineKind, SessionMeta } from "@kaoiro/protocol";

/** session_id rides a JSONL filename and the wrapper's `--resume` arg, so its
 *  charset is restricted (UUID-shaped: letters, digits, hyphen) — no path
 *  separators or dots, which keeps it safe in both. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]+$/;
const MAX_SESSION_ID = 128;
const JSONL = ".jsonl";
const require = createRequire(import.meta.url);

type SqliteModule = typeof import("node:sqlite");
type WarningSink = (message: string) => void;

interface AntigravityReadOptions {
  loadSqlite?: () => SqliteModule;
  nodeVersion?: string;
  warn?: WarningSink;
}

const SQLITE_BUSY_TIMEOUT_MS = 100;
const ANTIGRAVITY_SESSION_LIMIT = 500;
const ANTIGRAVITY_CANDIDATE_LIMIT = 10_000;
const WARNING_INTERVAL_MS = 60_000;
const warningTimes = new Map<string, number>();
const ANTIGRAVITY_COLUMNS = [
  "conversation_id",
  "title",
  "last_modified_time",
  "workspace_uris",
  "nesting_depth",
] as const;

function defaultWarningSink(message: string): void {
  process.stderr.write(
    `runner: antigravity session index unavailable: ${message}\n`,
  );
}

function warnAntigravity(
  cwd: string,
  failureClass: string,
  detail: string,
  sink: WarningSink,
): void {
  const key = `${cwd}\0${failureClass}`;
  const now = Date.now();
  const previous = warningTimes.get(key);
  if (previous !== undefined && now - previous < WARNING_INTERVAL_MS) return;
  warningTimes.set(key, now);
  sink(`${failureClass}: ${detail.replace(/[\r\n]+/g, " ")}`);
}

function clearAntigravityWarnings(cwd: string): void {
  const prefix = `${cwd}\0`;
  for (const key of warningTimes.keys()) {
    if (key.startsWith(prefix)) warningTimes.delete(key);
  }
}

function nodeSupportsSqlite(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 24 || major === 24 || (major === 22 && minor >= 16);
}

function antigravityDatabasePath(): string {
  return join(
    homedir(),
    ".gemini",
    "antigravity-cli",
    "conversation_summaries.db",
  );
}

function normalizedCwd(cwd: string): string {
  try {
    return normalize(realpathSync(cwd));
  } catch {
    return normalize(resolve(cwd));
  }
}

function workspaceMatches(
  workspaceValue: unknown,
  requestedCwd: string,
  requestedCwdUri: string,
  warn: (failureClass: string, detail: string) => void,
): boolean {
  if (typeof workspaceValue !== "string") {
    warn("invalid_workspace", "workspace_uris is not text");
    return false;
  }
  if (workspaceValue === "") return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(workspaceValue);
  } catch {
    warn("invalid_workspace", "workspace_uris is not valid JSON");
    return false;
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((value) => typeof value === "string")
  ) {
    warn("invalid_workspace", "workspace_uris is not an array of strings");
    return false;
  }

  let matched = false;
  for (const value of parsed) {
    if (value === requestedCwdUri) {
      matched = true;
      continue;
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      warn("invalid_workspace", "workspace_uris contains a malformed URI");
      return false;
    }
    if (url.protocol !== "file:") continue;
    if (url.host !== "") {
      warn(
        "invalid_workspace",
        "workspace_uris contains a file URI with an authority",
      );
      return false;
    }
    if (matched) {
      try {
        if (url.search !== "" || url.hash !== "" || /%(?![0-9a-f]{2})/i.test(url.pathname)) {
          throw new TypeError("malformed file URI");
        }
        if (/%(?:2f|5c)/i.test(url.pathname)) {
          throw new TypeError("encoded path separator");
        }
        decodeURIComponent(url.pathname);
      } catch {
        warn("invalid_workspace", "workspace_uris contains an invalid file URI");
        return false;
      }
      continue;
    }
    try {
      if (normalize(fileURLToPath(url)) === requestedCwd) matched = true;
    } catch {
      warn("invalid_workspace", "workspace_uris contains an invalid file URI");
      return false;
    }
  }
  return matched;
}

function validateAntigravitySchema(
  db: import("node:sqlite").DatabaseSync,
): string | undefined {
  const versionRow = db.prepare("PRAGMA user_version").get() as
    | { user_version?: unknown }
    | undefined;
  const version = versionRow?.user_version;
  const columns = db
    .prepare("PRAGMA table_info(conversation_summaries)")
    .all() as { name?: unknown }[];
  const names = new Set(
    columns.flatMap((column) =>
      typeof column.name === "string" ? [column.name] : [],
    ),
  );
  const missing = ANTIGRAVITY_COLUMNS.filter((column) => !names.has(column));
  if (version !== 3 || missing.length > 0) {
    return `user_version=${String(version)}; missing columns=${missing.join(",") || "none"}`;
  }
  return undefined;
}

function openAntigravityDatabase(
  dbPath: string,
  cwd: string,
  options: AntigravityReadOptions,
): import("node:sqlite").DatabaseSync | undefined {
  const warn = options.warn ?? defaultWarningSink;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  if (!nodeSupportsSqlite(nodeVersion)) {
    warnAntigravity(cwd, "unsupported_runtime", `node=${nodeVersion}`, warn);
    return undefined;
  }

  let sqlite: SqliteModule;
  try {
    sqlite = (options.loadSqlite ?? (() => require("node:sqlite") as SqliteModule))();
  } catch {
    warnAntigravity(cwd, "sqlite_unavailable", "node:sqlite could not be loaded", warn);
    return undefined;
  }

  try {
    const db = new sqlite.DatabaseSync(dbPath, {
      readOnly: true,
      timeout: SQLITE_BUSY_TIMEOUT_MS,
    });
    if (typeof db.function !== "function") {
      db.close();
      warnAntigravity(
        cwd,
        "sqlite_unavailable",
        "required SQLite function API is unavailable",
        warn,
      );
      return undefined;
    }
    const schemaProblem = validateAntigravitySchema(db);
    if (schemaProblem !== undefined) {
      db.close();
      warnAntigravity(cwd, "schema_mismatch", schemaProblem, warn);
      return undefined;
    }
    return db;
  } catch {
    warnAntigravity(cwd, "database_read_failed", "database open or schema query failed", warn);
    return undefined;
  }
}

function parseAgyTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match =
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{9})([+-])(\d{2}):(\d{2})$/.exec(
      value,
    );
  if (match === null) return undefined;
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    fractionText,
    sign,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = Number(offsetHourText);
  const offsetMinute = Number(offsetMinuteText);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return undefined;
  }

  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, 0);
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day
  ) {
    return undefined;
  }

  const fractionMs = Math.floor((Number(fractionText) + 500_000) / 1_000_000);
  const offsetMs =
    (offsetHour * 60 + offsetMinute) * 60_000 * (sign === "+" ? 1 : -1);
  return new Date(local.getTime() + fractionMs - offsetMs).toISOString();
}

function registerWorkspaceMatcher(
  db: import("node:sqlite").DatabaseSync,
  cwd: string,
  warn: (failureClass: string, detail: string) => void,
): void {
  const requestedCwdUri = pathToFileURL(cwd).href;
  db.function(
    "kaoiro_workspace_matches",
    { deterministic: true },
    (workspaceValue) =>
      workspaceMatches(workspaceValue, cwd, requestedCwdUri, warn) ? 1 : 0,
  );
}

/** Lists Antigravity sessions from its bounded summary index. */
export function listAntigravitySessionsFrom(
  dbPath: string,
  cwd: string,
  options: AntigravityReadOptions = {},
): SessionMeta[] {
  const db = openAntigravityDatabase(dbPath, cwd, options);
  if (db === undefined) return [];
  const sink = options.warn ?? defaultWarningSink;
  let hadWarning = false;
  const warn = (failureClass: string, detail: string): void => {
    hadWarning = true;
    warnAntigravity(cwd, failureClass, detail, sink);
  };
  try {
    const canonicalCwd = normalizedCwd(cwd);
    registerWorkspaceMatcher(db, canonicalCwd, warn);
    const rows = db.prepare(`
      WITH candidates AS MATERIALIZED (
        SELECT conversation_id, title, last_modified_time, workspace_uris, nesting_depth
        FROM conversation_summaries
        WHERE nesting_depth = 0
        ORDER BY last_modified_time DESC
        LIMIT ${ANTIGRAVITY_CANDIDATE_LIMIT}
      ), offset_summary AS MATERIALIZED (
        SELECT COUNT(DISTINCT substr(last_modified_time, -6)) AS offset_count
        FROM candidates
      )
      SELECT candidates.conversation_id, candidates.title,
        candidates.last_modified_time, offset_summary.offset_count
      FROM offset_summary LEFT JOIN candidates
        ON kaoiro_workspace_matches(workspace_uris) = 1
      ORDER BY candidates.last_modified_time DESC
      LIMIT ${ANTIGRAVITY_SESSION_LIMIT}
    `).all() as {
      conversation_id?: unknown;
      title?: unknown;
      last_modified_time?: unknown;
      offset_count?: unknown;
    }[];
    if (rows.length > 0 && Number(rows[0]?.offset_count) > 1) {
      warn("mixed_offsets", "mixed UTC offsets; picker order may be wrong");
    }
    const sessions: SessionMeta[] = [];
    for (const row of rows) {
      if (
        typeof row.conversation_id !== "string" ||
        !isValidSessionId(row.conversation_id)
      ) {
        continue;
      }
      const mtime = parseAgyTimestamp(row.last_modified_time);
      if (mtime === undefined) continue;
      const meta: SessionMeta = { session_id: row.conversation_id, mtime };
      if (typeof row.title === "string" && row.title.trim() !== "") {
        meta.summary = toSummaryLabel(row.title);
      }
      sessions.push(meta);
    }
    if (!hadWarning) clearAntigravityWarnings(cwd);
    return sessions;
  } catch {
    warn("database_read_failed", "session listing query failed");
    return [];
  } finally {
    try {
      db.close();
    } catch {
      /* Keep session reads fail-closed. */
    }
  }
}

/** Checks an Antigravity ID against the exact row and bound workspace. */
export function antigravitySessionExistsIn(
  dbPath: string,
  cwd: string,
  sessionId: string,
  options: AntigravityReadOptions = {},
): boolean {
  if (!isValidSessionId(sessionId)) return false;
  const db = openAntigravityDatabase(dbPath, cwd, options);
  if (db === undefined) return false;
  const sink = options.warn ?? defaultWarningSink;
  let hadWarning = false;
  const warn = (failureClass: string, detail: string): void => {
    hadWarning = true;
    warnAntigravity(cwd, failureClass, detail, sink);
  };
  try {
    const canonicalCwd = normalizedCwd(cwd);
    const row = db.prepare(`
      SELECT workspace_uris
      FROM conversation_summaries
      WHERE conversation_id = ?
    `).get(sessionId) as { workspace_uris?: unknown } | undefined;
    const exists = row !== undefined && workspaceMatches(
      row.workspace_uris,
      canonicalCwd,
      pathToFileURL(canonicalCwd).href,
      warn,
    );
    if (!hadWarning) clearAntigravityWarnings(cwd);
    return exists;
  } catch {
    warn("database_read_failed", "session existence query failed");
    return false;
  } finally {
    try {
      db.close();
    } catch {
      /* Keep session reads fail-closed. */
    }
  }
}

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
  if (engine === "antigravity") {
    return listAntigravitySessionsFrom(antigravityDatabasePath(), cwd);
  }
  return engine === "codex"
    ? listCodexSessionsIn(codexSessionsRoot(), cwd)
    : listSessionsIn(projectsDir(cwd));
}

/** The T3 existence check: session_id is valid AND exists in the engine's
 *  session store under the bound cwd, gating a resume to that cwd. */
export function sessionExists(
  cwd: string,
  sessionId: string,
  engine: EngineKind = "claude-code",
): boolean | Promise<boolean> {
  if (engine === "antigravity") {
    return antigravitySessionExistsIn(antigravityDatabasePath(), cwd, sessionId);
  }
  return engine === "codex"
    ? codexSessionExistsIn(codexSessionsRoot(), cwd, sessionId)
    : sessionExistsIn(projectsDir(cwd), sessionId);
}
