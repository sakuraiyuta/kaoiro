// Dashboard history on resume (issue #645). Grok keeps the authoritative
// conversation log of a session in `updates.jsonl` beside its other state;
// this reads it and builds the same `log` envelopes the live path publishes,
// for HistoryReplayer. Everything here is bounded and a bad line is skipped,
// never the whole file.
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  clipText,
  isFormattedInterAgentMessage,
  logEntryToPayload,
  makeLog,
  MAX_LOG_BYTES,
  writeRedactedStderr,
  type Envelope,
  type LogEntry,
  type LogPayload,
  type WrapperConfig,
} from "@kaoiro/agent-common";

/** Server ring-buffer parity: only the newest entries are replayed. */
export const MAX_HISTORY = 200;
const MAX_TAIL_BYTES = 8 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
// Grok's slug groups hold a `.cwd` file with the cwd; a longer one is no cwd.
const MAX_CWD_FILE_BYTES = 8 * 1024;
const MAX_GROUPS = 10_000;
// Grok's group name for a cwd stops being the encoded cwd past this size.
const MAX_GROUP_NAME_BYTES = 255;
// A session id is a path component: letters, digits and hyphens only.
const SESSION_ID = /^[A-Za-z0-9-]{1,128}$/;

export type SkipReason =
  | "invalid_json"
  | "invalid_shape"
  | "bad_timestamp"
  | "oversize_line"
  | "invalid_chunk"
  | "invalid_tool";

/** Grok names a session group after the cwd in RFC 3986 percent-encoding:
 *  `encodeURIComponent` leaves `! ' ( ) *` alone and Grok escapes them. */
export function groupName(cwd: string): string {
  return encodeURIComponent(cwd).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The directory of a session: `<home>/sessions/<group>/<id>`, where the group
 *  is the encoded cwd or, for a long cwd, a slug directory whose `.cwd` file
 *  holds the cwd. Undefined when the id is unsafe or nothing matches. */
export function sessionDirectory(
  cwd: string,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!SESSION_ID.test(sessionId)) return undefined;
  // A relative cwd encodes to itself, and ".." would leave the sessions directory.
  if (!isAbsolute(cwd)) return undefined;
  const root = join(env.GROK_HOME ?? join(env.HOME ?? homedir(), ".grok"), "sessions");
  const name = groupName(cwd);
  if (Buffer.byteLength(name) <= MAX_GROUP_NAME_BYTES) {
    const direct = join(root, name, sessionId);
    if (isDirectory(direct)) return direct;
  }
  let groups: string[];
  try {
    groups = readdirSync(root);
  } catch {
    return undefined;
  }
  for (const group of groups.slice(0, MAX_GROUPS)) {
    const candidate = join(root, group, sessionId);
    if (!isDirectory(candidate)) continue;
    try {
      const marker = join(root, group, ".cwd");
      if (statSync(marker).size > MAX_CWD_FILE_BYTES) continue;
      if (readFileSync(marker, "utf8") === cwd) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** The last MAX_TAIL_BYTES of a file, starting at a line boundary, as one
 *  buffer per line. A line over MAX_LINE_BYTES is not returned but counted. */
function tailLines(path: string): { lines: Buffer[]; oversize: number } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const windowStart = Math.max(0, size - MAX_TAIL_BYTES);
    // One byte before the window says whether it begins on a line boundary.
    const from = Math.max(0, windowStart - 1);
    const buffer = Buffer.alloc(size - from);
    let filled = 0;
    while (filled < buffer.length) {
      const read = readSync(fd, buffer, filled, buffer.length - filled, from + filled);
      if (read === 0) break;
      filled += read;
    }
    let start = 0;
    if (windowStart > 0) {
      start = buffer[0] === 0x0a ? 1 : buffer.indexOf(0x0a) + 1;
      if (start === 0) return { lines: [], oversize: 0 };
    }
    const lines: Buffer[] = [];
    let oversize = 0;
    while (start < filled) {
      let end = buffer.indexOf(0x0a, start);
      if (end < 0 || end > filled) end = filled;
      if (end - start > MAX_LINE_BYTES) oversize += 1;
      else if (end > start) lines.push(buffer.subarray(start, end));
      start = end + 1;
    }
    return { lines, oversize };
  } finally {
    closeSync(fd);
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Integer epoch seconds only; milliseconds, floats and strings are not. */
function isoTime(timestamp: unknown): string | undefined {
  if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp)) return undefined;
  if (timestamp < 1e9 || timestamp >= 1e11) return undefined;
  return new Date(timestamp * 1000).toISOString();
}

interface Join {
  kind: "user" | "assistant";
  ts: string;
  key: unknown;
  text: string;
  /** The UTF-8 size of `text`, as it will be when sent. */
  bytes: number;
}

/**
 * Builds the log entries of an `updates.jsonl` text, oldest first, and counts
 * what it skipped by reason. Pure over its input lines so it needs no file.
 */
export function reconstructHistory(
  lines: Iterable<string>,
  config: WrapperConfig,
  sessionId: string,
): { envelopes: Envelope[]; skipped: Partial<Record<SkipReason, number>> } {
  const envelopes: Envelope[] = [];
  const skipped: Partial<Record<SkipReason, number>> = {};
  const toolNames = new Map<string, string>();
  const skip = (reason: SkipReason) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  const emit = (ts: string, payload: LogPayload) => {
    const envelope = makeLog(config, "idle", ts, payload);
    envelope.session_id = sessionId;
    envelopes.push(envelope);
    // The newest MAX_HISTORY are kept; trimming in blocks keeps this linear.
    if (envelopes.length > MAX_HISTORY * 4) envelopes.splice(0, envelopes.length - MAX_HISTORY);
  };
  let join: Join | undefined;
  const flush = () => {
    const current = join;
    join = undefined;
    if (!current) return;
    if (current.kind === "assistant") {
      const payload = logEntryToPayload({ kind: "assistant", text: current.text }, toolNames);
      emit(current.ts, payload);
      return;
    }
    // The structured inter-agent envelope is the display source of truth.
    if (isFormattedInterAgentMessage(current.text)) return;
    const { text, truncated } = clipText(current.text);
    emit(current.ts, truncated ? { kind: "user", text, truncated: true } : { kind: "user", text });
  };
  // A join stops taking text once it holds more than a log line can show.
  // Text is dropped only past the bound, so clipText then reports it.
  const chunk = (kind: Join["kind"], ts: string, key: unknown, text: string) => {
    if (join && (join.kind !== kind || join.key !== key)) flush();
    join ??= { kind, ts, key, text: "", bytes: 0 };
    if (join.bytes > MAX_LOG_BYTES) return;
    // A pair of surrogates split between two chunks is two replacement
    // characters (3 bytes each) apart and one character (4 bytes) together.
    const split = /[\ud800-\udbff]$/.test(join.text) && /^[\udc00-\udfff]/.test(text);
    join.text += text;
    join.bytes += Buffer.byteLength(text) - (split ? 2 : 0);
  };
  const toolResult = (update: Record<string, unknown>): string => {
    const texts: string[] = [];
    if (Array.isArray(update.content)) {
      for (const item of update.content) {
        if (!plainObject(item) || item.type !== "content" || !plainObject(item.content)) continue;
        if (item.content.type === "text" && typeof item.content.text === "string")
          texts.push(item.content.text);
      }
    }
    return texts.join("\n");
  };

  for (const raw of lines) {
    try {
      let record: unknown;
      try {
        record = JSON.parse(raw);
      } catch {
        skip("invalid_json");
        continue;
      }
      if (!plainObject(record) || typeof record.method !== "string" || !plainObject(record.params)) {
        skip("invalid_shape");
        continue;
      }
      // Grok's own records (hooks, turn_completed) and other methods are not history.
      if (record.method !== "session/update") continue;
      const ts = isoTime(record.timestamp);
      if (ts === undefined) {
        skip("bad_timestamp");
        continue;
      }
      const update = record.params.update;
      if (!plainObject(update) || typeof update.sessionUpdate !== "string") {
        skip("invalid_shape");
        continue;
      }
      switch (update.sessionUpdate) {
        case "user_message_chunk":
        case "agent_message_chunk": {
          const content = update.content;
          if (!plainObject(content) || content.type !== "text" || typeof content.text !== "string") {
            skip("invalid_chunk");
            break;
          }
          const user = update.sessionUpdate === "user_message_chunk";
          const meta = update._meta;
          const index = plainObject(meta) && Number.isInteger(meta.promptIndex) ? meta.promptIndex : undefined;
          chunk(user ? "user" : "assistant", ts, user ? index : undefined, content.text);
          break;
        }
        case "tool_call": {
          const id = update.toolCallId;
          // Absent is an empty input; a null or any other shape is not.
          const input = update.rawInput === undefined ? {} : update.rawInput;
          if (typeof id !== "string" || id === "" || typeof update.title !== "string" || !plainObject(input)) {
            skip("invalid_tool");
            break;
          }
          flush();
          const entry: LogEntry = { kind: "tool_use", tool_use_id: id, tool_name: update.title, input };
          emit(ts, logEntryToPayload(entry, toolNames));
          break;
        }
        case "tool_call_update": {
          // Only the final update carries the result; the others are progress.
          if (update.status !== "completed" && update.status !== "failed") break;
          const id = update.toolCallId;
          if (typeof id !== "string" || id === "") {
            skip("invalid_tool");
            break;
          }
          flush();
          const entry: LogEntry = { kind: "tool_result", tool_use_id: id, output: toolResult(update) };
          emit(ts, logEntryToPayload(entry, toolNames));
          break;
        }
        default:
          // Thoughts, command lists, session info and unknown variants.
          break;
      }
    } catch {
      skip("invalid_shape");
    }
  }
  flush();
  return {
    envelopes: envelopes.length > MAX_HISTORY ? envelopes.slice(-MAX_HISTORY) : envelopes,
    skipped,
  };
}

/** Reads a resumed session's `updates.jsonl` and reconstructs its `log`
 *  envelopes, or [] when there is no such file or it cannot be read. */
export function readGrokHistory(
  cwd: string,
  sessionId: string,
  config: WrapperConfig,
  env: NodeJS.ProcessEnv = process.env,
): Envelope[] {
  const directory = sessionDirectory(cwd, sessionId, env);
  if (directory === undefined) return [];
  let tail: { lines: Buffer[]; oversize: number };
  try {
    tail = tailLines(join(directory, "updates.jsonl"));
  } catch {
    return [];
  }
  const { envelopes, skipped } = reconstructHistory(
    tail.lines.map((line) => line.toString("utf8")),
    config,
    sessionId,
  );
  if (tail.oversize > 0) skipped.oversize_line = tail.oversize;
  const counts = Object.entries(skipped).map(([reason, count]) => `${reason}=${count}`);
  if (counts.length > 0) writeRedactedStderr(`[kaoiro] grok history skipped lines: ${counts.join(" ")}\n`);
  return envelopes;
}
