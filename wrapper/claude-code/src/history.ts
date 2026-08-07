// Resume history reconstruction (ADR-0014 phase-2, issue #50). On a resumed
// session the wrapper reads its own SDK transcript JSONL
// (~/.claude/projects/<encoded-cwd>/<session-id>.jsonl) and rebuilds the
// server's display ring buffer (ADR-0012 F7) from it, because the SDK does
// not replay past turns into the query() stream on resume (Q-A4, verified
// 2026-06-23). The line -> display mapping reuses the live adapter
// (sdkMessageToLogs) and the shared payload builder so reconstructed lines
// match the live transcript exactly; the caller resets the server history,
// then replays the returned `log` envelopes.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sdkMessageToLogs } from "./adapter.js";
import {
  clipText,
  isFormattedInterAgentMessage,
  logEntryToPayload,
} from "@kaoiro/agent-common";
import { makeLog } from "@kaoiro/agent-common";
import type { KaoiroState, LogPayload } from "@kaoiro/agent-common";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";

// Historical log lines carry no live machine state; the display renders only
// the payload (ADR-0012 F5), so a neutral placeholder state is used.
const HISTORY_STATE: KaoiroState = "idle";

// Server ring-buffer parity (AgentStates @max_history): keep only the newest
// lines so a long transcript cannot grow the replay without bound.
const MAX_HISTORY = 200;

// session_id rides a JSONL filename, so its charset is restricted (UUID-shaped:
// letters, digits, hyphen — no path separators or dots) to keep it from
// traversing out of the projects dir. Defense-in-depth: the runner already
// validates before spawn (ADR-0014 T3), but `--resume` reaches the wrapper
// directly too. Mirrors runner/src/sessions.ts isValidSessionId.
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]+$/;
const MAX_SESSION_ID = 128;

function isValidSessionId(sessionId: string): boolean {
  return (
    sessionId.length > 0 &&
    sessionId.length <= MAX_SESSION_ID &&
    SESSION_ID_PATTERN.test(sessionId)
  );
}

/** Encodes an absolute cwd into the Claude projects dir name (every
 *  non-alphanumeric -> '-'). Mirrors the SDK's on-disk convention and
 *  runner/src/sessions.ts encodeCwd; kept local to avoid a wrapper->runner
 *  dependency. */
function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Absolute path to the resumed session's transcript JSONL. */
function sessionLogPath(cwd: string, sessionId: string): string {
  return join(
    homedir(),
    ".claude",
    "projects",
    encodeCwd(cwd),
    `${sessionId}.jsonl`,
  );
}

/** Absolute path to a session's IA sidecar — beside its transcript, per
 *  ADR-0051 D3-2. Null for a session_id that is not a safe path component
 *  (the same fail-closed guard `readSessionHistory` applies). */
export function sessionSidecarPath(
  cwd: string,
  sessionId: string,
): string | null {
  if (!isValidSessionId(sessionId)) return null;
  return join(
    homedir(),
    ".claude",
    "projects",
    encodeCwd(cwd),
    `${sessionId}.ia.jsonl`,
  );
}

/** One parsed JSONL transcript line — only the fields the mapping reads. The
 *  SDK persists each message as `{ type, message: { role, content }, ... }`
 *  plus bookkeeping lines (queue-operation / attachment / last-prompt / mode
 *  / system / ...) that are not user/assistant and are skipped. */
interface JsonlLine {
  type?: unknown;
  isMeta?: unknown;
  timestamp?: unknown;
  message?: { role?: unknown; content?: unknown };
}

/** Pulls an operator-instruction text from a user line's string content or
 *  its `text` blocks, or null when there is none. tool_result blocks are
 *  ignored here — the adapter maps them separately, so a message mixing text
 *  and tool_result loses neither part. */
function userInstructionText(content: unknown): string | null {
  if (typeof content === "string") {
    return content.trim() === "" ? null : content;
  }
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    const { type, text } = block as { type?: unknown; text?: unknown };
    if (type === "text" && typeof text === "string") parts.push(text);
  }
  const joined = parts.join("\n");
  return joined.trim() === "" ? null : joined;
}

/** Maps one parsed JSONL line to its display LogPayloads: assistant speech /
 *  tool calls and user tool_results reuse the live adapter; a user
 *  instruction adds the `user` echo (#31) the live path emits outside the
 *  adapter. Both are emitted for a user line, so a message mixing
 *  instruction text and tool_result keeps both. `toolNames` is shared across
 *  lines so a tool_result can name its tool. Non-user/assistant and meta
 *  lines map to nothing. */
function lineToPayloads(
  line: JsonlLine,
  toolNames: Map<string, string>,
): LogPayload[] {
  const type = line.type;
  if (type !== "user" && type !== "assistant") return [];
  // Skip synthetic/meta user lines (injected reminders, command echoes) so
  // they are not surfaced as operator instructions.
  if (line.isMeta === true) return [];

  const payloads: LogPayload[] = [];
  if (type === "user") {
    const text = userInstructionText(line.message?.content);
    // The structured inter_agent_message envelope is the display SoT. The
    // SDK also persists its injected framing as a user turn; replaying that
    // text would duplicate the restored IA bubble as an operator log (#105).
    if (text !== null && !isFormattedInterAgentMessage(text)) {
      const { text: clipped, truncated } = clipText(text);
      payloads.push(
        truncated
          ? { kind: "user", text: clipped, truncated: true }
          : { kind: "user", text: clipped },
      );
    }
  }

  // assistant speech/tool_use, or user tool_result -> reuse the live adapter.
  // The adapter reads only `.type` and `.message.content`, both present here.
  const sdkLike = { type, message: line.message } as unknown as Parameters<
    typeof sdkMessageToLogs
  >[0];
  for (const entry of sdkMessageToLogs(sdkLike)) {
    payloads.push(logEntryToPayload(entry, toolNames));
  }
  return payloads;
}

/** Reconstructs `log` envelopes from a JSONL transcript text (ADR-0014
 *  phase-2). Pure over the text so it is testable without the filesystem.
 *  Unparseable lines are dropped; non-user/assistant lines are skipped; the
 *  newest MAX_HISTORY lines are kept (server ring-buffer parity). */
export function reconstructHistory(
  jsonlText: string,
  config: WrapperConfig,
  sessionId: string,
  now: () => string,
): Envelope[] {
  const envelopes: Envelope[] = [];
  const toolNames = new Map<string, string>();
  for (const raw of jsonlText.split("\n")) {
    if (raw.trim() === "") continue;
    let line: JsonlLine;
    try {
      line = JSON.parse(raw) as JsonlLine;
    } catch {
      continue;
    }
    const ts = typeof line.timestamp === "string" ? line.timestamp : now();
    for (const payload of lineToPayloads(line, toolNames)) {
      const envelope = makeLog(config, HISTORY_STATE, ts, payload);
      envelope.session_id = sessionId;
      envelopes.push(envelope);
    }
  }
  return envelopes.length > MAX_HISTORY
    ? envelopes.slice(-MAX_HISTORY)
    : envelopes;
}

/** Reads and reconstructs the resumed session's transcript, or [] when the
 *  JSONL is missing / unreadable (a resume of a session with no local log,
 *  or a brand-new one). */
export function readSessionHistory(
  cwd: string,
  sessionId: string,
  config: WrapperConfig,
  now: () => string = () => new Date().toISOString(),
): Envelope[] {
  // Reject a path-traversing session_id before it reaches the filesystem.
  if (!isValidSessionId(sessionId)) return [];
  let text: string;
  try {
    text = readFileSync(sessionLogPath(cwd, sessionId), "utf8");
  } catch {
    return [];
  }
  return reconstructHistory(text, config, sessionId, now);
}
