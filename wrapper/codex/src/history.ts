// Resume history reconstruction for Codex (#106). The SDK's resumeThread()
// continues the thread but does not emit past turns, so the wrapper projects
// display logs from the persisted rollout JSONL before accepting live work.

import { readFileSync } from "node:fs";
import {
  clipText,
  isFormattedInterAgentMessage,
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

/** Codex code mode persists every nested tool call as custom `exec` and puts
 *  the real tool name only in the JavaScript source (`tools.<name>(...)`).
 *  Recover the name when there is exactly one call; ambiguous/malformed code
 *  stays `shell` rather than inventing a misleading tool identity. */
function codeModeToolName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const names = new Set<string>();
  for (const match of input.matchAll(/\btools\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  if (names.size !== 1) return null;
  const [name] = names;
  return name === "exec_command" ? "shell" : (name ?? null);
}

function toolName(payload: Record<string, unknown>): string | null {
  if (typeof payload.name !== "string" || payload.name === "") return null;
  if (payload.type === "custom_tool_call" && payload.name === "exec") {
    return codeModeToolName(payload.input) ?? "shell";
  }
  if (typeof payload.namespace === "string" && payload.namespace !== "") {
    return `mcp__${payload.namespace}__${payload.name}`;
  }
  return payload.name;
}

const CODE_MODE_OUTPUT_HEADER =
  /^Script (?:completed|running)\b[\s\S]*?\nOutput:\n?$/;

/** Output is a string in old/direct fixtures, but Codex 0.144.1 code mode
 *  persists an array of input_text blocks: a runner status header followed
 *  by the actual nested tool result. Preserve every real text block and omit
 *  only that synthetic header so replay matches the live tool_result. */
function toolOutputText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw)) return "";
  const parts = raw.flatMap((block) => {
    if (typeof block !== "object" || block === null) return [];
    const record = block as Record<string, unknown>;
    return record.type === "input_text" && typeof record.text === "string"
      ? [record.text]
      : [];
  });
  if (CODE_MODE_OUTPUT_HEADER.test(parts[0] ?? "")) {
    parts.shift();
  }
  return parts.join("\n");
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
      // Structured inter_agent_message is the display SoT. Rollout JSONL also
      // records the injected framing as a user turn; do not replay that copy
      // as an operator log beside the restored IA bubble (#105).
      return text === null || isFormattedInterAgentMessage(text)
        ? []
        : [userPayload(text)];
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
    const output = toolOutputText(payload.output);
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
