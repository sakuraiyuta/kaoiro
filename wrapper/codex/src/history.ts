// Resume history reconstruction for Codex (#106). The SDK's resumeThread()
// continues the thread but does not emit past turns, so the wrapper projects
// display logs from the persisted rollout JSONL before accepting live work.

import { readFileSync } from "node:fs";
import {
  clipText,
  logEntryToPayload,
  makeLog,
} from "@kaoiro/agent-common";
import type {
  Envelope,
  LogEntry,
  LogPayload,
  WrapperConfig,
} from "@kaoiro/agent-common";
import { codexRolloutsRoot, rolloutPathIn } from "./rollout.js";

// Keep parity with Claude history.ts and AgentStates.@max_history.
const MAX_HISTORY = 200;
const HISTORY_STATE = "idle" as const;

interface RolloutLine {
  type?: unknown;
  timestamp?: unknown;
  payload?: Record<string, unknown>;
}

function textBlocks(content: unknown, blockType: string): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) continue;
    const block = raw as Record<string, unknown>;
    if (block.type === blockType && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  const text = parts.join("\n");
  return text.trim() === "" ? null : text;
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return { arguments: raw };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Preserve a malformed/future argument encoding as opaque text.
  }
  return { arguments: raw };
}

function toolName(payload: Record<string, unknown>): string | null {
  if (typeof payload.name !== "string" || payload.name === "") return null;
  if (payload.type === "custom_tool_call" && payload.name === "exec") {
    return "shell";
  }
  if (typeof payload.namespace === "string" && payload.namespace !== "") {
    return `mcp__${payload.namespace}__${payload.name}`;
  }
  return payload.name;
}

function userPayload(text: string): LogPayload {
  const clipped = clipText(text);
  return clipped.truncated
    ? { kind: "user", text: clipped.text, truncated: true }
    : { kind: "user", text: clipped.text };
}

function lineToPayloads(
  line: RolloutLine,
  toolNames: Map<string, string>,
): LogPayload[] {
  if (line.type !== "response_item" || line.payload === undefined) return [];
  const payload = line.payload;

  if (payload.type === "message") {
    if (payload.role === "user") {
      const text = textBlocks(payload.content, "input_text");
      return text === null ? [] : [userPayload(text)];
    }
    if (payload.role === "assistant") {
      const text = textBlocks(payload.content, "output_text");
      if (text === null) return [];
      return [logEntryToPayload({ kind: "assistant", text }, toolNames)];
    }
    return [];
  }

  if (payload.type === "custom_tool_call" || payload.type === "function_call") {
    const name = toolName(payload);
    const callId =
      typeof payload.call_id === "string" ? payload.call_id : undefined;
    if (name === null) return [];
    const input =
      payload.type === "custom_tool_call" && name === "shell"
        ? { command: payload.input }
        : parseArguments(payload.arguments ?? payload.input);
    const entry: LogEntry = {
      kind: "tool_use",
      ...(callId === undefined ? {} : { tool_use_id: callId }),
      tool_name: name,
      input,
    };
    return [logEntryToPayload(entry, toolNames)];
  }

  if (
    payload.type === "custom_tool_call_output" ||
    payload.type === "function_call_output"
  ) {
    const callId =
      typeof payload.call_id === "string" ? payload.call_id : undefined;
    const output = typeof payload.output === "string" ? payload.output : "";
    const entry: LogEntry = {
      kind: "tool_result",
      ...(callId === undefined ? {} : { tool_use_id: callId }),
      output,
    };
    return [logEntryToPayload(entry, toolNames)];
  }

  // reasoning is intentionally skipped: 0.144.1 stores encrypted_content
  // and observed summary arrays are empty. event_msg is also skipped because
  // it duplicates response_item messages and is not the persisted response
  // SoT.
  return [];
}

/** Pure JSONL -> display-envelope projection, capped like the server ring. */
export function reconstructCodexHistory(
  jsonlText: string,
  config: WrapperConfig,
  sessionId: string,
  now: () => string,
): Envelope[] {
  const envelopes: Envelope[] = [];
  const toolNames = new Map<string, string>();
  for (const raw of jsonlText.split("\n")) {
    if (raw.trim() === "") continue;
    let line: RolloutLine;
    try {
      line = JSON.parse(raw) as RolloutLine;
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

/** Reads one validated rollout; missing/unreadable files fail closed to []. */
export function readCodexHistory(
  sessionId: string,
  config: WrapperConfig,
  root = codexRolloutsRoot(),
  now: () => string = () => new Date().toISOString(),
): Envelope[] {
  const path = rolloutPathIn(root, sessionId);
  if (path === null) return [];
  try {
    return reconstructCodexHistory(
      readFileSync(path, "utf8"),
      config,
      sessionId,
      now,
    );
  } catch {
    return [];
  }
}

export interface HistoryTransport {
  setSessionId(sessionId: string): void;
  sendHistoryReset(): void;
  send(envelope: Envelope): void;
}

/** Fixed resume ordering, extracted so reset-before-replay is testable. */
export function replayCodexHistory(
  link: HistoryTransport,
  config: WrapperConfig,
  sessionId: string,
  seed?: Envelope,
  root?: string,
): Envelope[] {
  link.setSessionId(sessionId);
  if (seed !== undefined) link.send(seed);
  const history = readCodexHistory(sessionId, config, root);
  link.sendHistoryReset();
  for (const envelope of history) link.send(envelope);
  return history;
}
