// Adapter — bridges Codex SDK ThreadEvents into the normalized AdapterEvent
// stream consumed by the state machine (@kaoiro/agent-common state.ts) and
// into relayable log entries. Pure: it only reads event shape, never calls
// the SDK. See docs/specs/codex-sdk-events.md; the Claude twin lives in
// @kaoiro/claude-code/src/adapter.ts.

import type { ThreadEvent, ThreadItem } from "@openai/codex-sdk";
import type {
  AdapterEvent,
  LogEntry,
  TasklistSourceItem,
} from "@kaoiro/agent-common";
import { redactCredentials } from "@kaoiro/agent-common";
import { clipTail } from "./turn_diagnostics.js";

/** Tool-ish items: they occupy the tool_running state between item.started
 *  and item.completed. agent_message / reasoning / todo_list are not tools. */
function isToolItem(item: ThreadItem): boolean {
  return (
    item.type === "command_execution" ||
    item.type === "file_change" ||
    item.type === "mcp_tool_call" ||
    item.type === "web_search"
  );
}

/**
 * Maps one ThreadEvent to zero or more adapter events (state-machine input).
 * Events with no coarse-state effect (item.updated, todo_list, error items)
 * map to no event. todo_list is instead mapped separately to a tasklist
 * envelope; the stream-fatal `error` event is handled by the host (it also
 * ends the turn on the SDK side).
 */
export function threadEventToEvents(event: ThreadEvent): AdapterEvent[] {
  switch (event.type) {
    case "thread.started":
      return [{ kind: "session_init" }];
    case "turn.started":
      // send() already raised user_send; the machine is in sending/thinking.
      return [{ kind: "assistant", blocks: ["thinking"] }];
    case "item.started": {
      const item = event.item;
      if (item.type === "agent_message") {
        return [{ kind: "assistant", blocks: ["text"] }];
      }
      if (item.type === "reasoning") {
        return [{ kind: "assistant", blocks: ["thinking"] }];
      }
      if (isToolItem(item)) {
        return [
          { kind: "assistant", blocks: ["tool_use"], toolUseIds: [item.id] },
        ];
      }
      return [];
    }
    case "item.completed": {
      const item = event.item;
      if (isToolItem(item)) {
        return [{ kind: "tool_result", toolUseIds: [item.id] }];
      }
      return [];
    }
    case "turn.completed":
      return [{ kind: "result", subtype: "success" }];
    case "turn.failed":
      return [{ kind: "result", subtype: "error_during_execution" }];
    default:
      return [];
  }
}

/** Maps this CodexHost's parent-thread todo_list snapshot to ADR-0049's
 * common item shape. `Thread.runStreamed()` reads one bound SDK Thread's
 * `codex exec` stream; the installed ThreadEvent union has neither a child
 * thread event nor an origin field, so child-thread items have no route into
 * this stream. If that SDK contract gains one, add explicit provenance before
 * mapping it here. Codex has no in-progress state, so an incomplete item is
 * `pending`. Thread events carry the complete list, not an item-level delta. */
export function threadEventToTasklist(
  event: ThreadEvent,
): TasklistSourceItem[] | null {
  if (
    event.type !== "item.started" &&
    event.type !== "item.updated" &&
    event.type !== "item.completed"
  ) {
    return null;
  }
  if (event.item.type !== "todo_list") return null;
  return event.item.items.map((item) => ({
    text: item.text,
    status: item.completed ? "completed" : "pending",
  }));
}

/** Human-readable tool name for the log stream (protocol.md log.kind).
 *  mcp tools keep the Claude-style FQN so the dashboard groups them the
 *  same way across engines. */
function toolName(item: ThreadItem): string {
  switch (item.type) {
    case "command_execution":
      return "shell";
    case "file_change":
      return "edit";
    case "web_search":
      return "web_search";
    case "mcp_tool_call":
      return `mcp__${item.server}__${item.tool}`;
    default:
      return item.type;
  }
}

/** Flattens an MCP tool result's content blocks to text (images and other
 *  non-text parts are dropped — the log stream is a textual transcript). */
function mcpResultText(item: Extract<ThreadItem, { type: "mcp_tool_call" }>): string {
  if (item.error) return item.error.message;
  const parts: string[] = [];
  for (const block of item.result?.content ?? []) {
    const { type, text } = block as { type?: unknown; text?: unknown };
    if (type === "text" && typeof text === "string") parts.push(text);
  }
  return parts.join("\n");
}

/**
 * Extracts relayable log entries from one ThreadEvent: assistant speech and
 * tool call / result pairs. item.started carries the tool_use line (input),
 * item.completed the tool_result line (output); agent_message text lands on
 * completion. reasoning / todo_list are not relayed as transcript logs:
 * todo_list travels separately as a tasklist envelope, while thinking stays
 * local, matching the Claude adapter.
 */
export function threadEventToLogs(event: ThreadEvent): LogEntry[] {
  if (event.type === "item.started") {
    const item = event.item;
    switch (item.type) {
      case "command_execution":
        return [
          {
            kind: "tool_use",
            tool_use_id: item.id,
            tool_name: toolName(item),
            input: { command: item.command },
          },
        ];
      case "file_change":
        return [
          {
            kind: "tool_use",
            tool_use_id: item.id,
            tool_name: toolName(item),
            input: { changes: item.changes },
          },
        ];
      case "mcp_tool_call":
        return [
          {
            kind: "tool_use",
            tool_use_id: item.id,
            tool_name: toolName(item),
            input:
              typeof item.arguments === "object" && item.arguments !== null
                ? (item.arguments as Record<string, unknown>)
                : { arguments: item.arguments },
          },
        ];
      case "web_search":
        return [
          {
            kind: "tool_use",
            tool_use_id: item.id,
            tool_name: toolName(item),
            input: { query: item.query },
          },
        ];
      default:
        return [];
    }
  }
  if (event.type === "item.completed") {
    const item = event.item;
    switch (item.type) {
      case "agent_message":
        return [{ kind: "assistant", text: item.text }];
      case "command_execution":
        return [
          {
            kind: "tool_result",
            tool_use_id: item.id,
            output:
              item.exit_code !== undefined && item.exit_code !== 0
                ? `(exit ${item.exit_code})\n${item.aggregated_output}`
                : item.aggregated_output,
          },
        ];
      case "file_change":
        return [
          {
            kind: "tool_result",
            tool_use_id: item.id,
            output: `${item.status}: ${item.changes
              .map((c) => `${c.kind} ${c.path}`)
              .join(", ")}`,
          },
        ];
      case "mcp_tool_call":
        return [
          {
            kind: "tool_result",
            tool_use_id: item.id,
            output: mcpResultText(item),
          },
        ];
      case "web_search":
        return [
          { kind: "tool_result", tool_use_id: item.id, output: "" },
        ];
      default:
        return [];
    }
  }
  return [];
}

/** Final-reply text of a turn: the last completed agent_message. The host
 *  accumulates via this helper while streaming and emits type=result at
 *  turn.completed. */
export function threadEventToFinalText(event: ThreadEvent): string | null {
  if (event.type === "item.completed" && event.item.type === "agent_message") {
    return event.item.text;
  }
  return null;
}

/** thread id from thread.started, or null. */
export function threadEventToSessionId(event: ThreadEvent): string | null {
  return event.type === "thread.started" ? event.thread_id : null;
}

/** Free-form failure detail from a turn.failed event (issue #131). Codex's
 *  ThreadError carries no structured reason like Claude's terminal_reason —
 *  just a message string; the shared inter-agent error classifier
 *  (@kaoiro/agent-common) keyword-sniffs it. */
export function threadEventToErrorDetail(event: ThreadEvent): string | null {
  return event.type === "turn.failed" ? event.error.message : null;
}

// --- Exec-failure stderr relay (issue #300) -------------------------------
//
// When codex-sdk's CodexExec.run() child process exits non-zero, the SDK
// throws `Error("Codex Exec exited with ${detail}: ${stderr}")` -- stderr is
// already captured by the SDK, just embedded in the thrown message rather
// than exposed as a separate field. Before this, the host computed `detail`
// but never passed it to #emitResult in the ordinary (non-rollout-corrupted)
// failure branch, so the operator saw a bare `is_error: true` with no detail
// at all. This section extracts a bounded, masked stderr tail for
// error_detail, and -- when the tail's last line is a single-line JSON
// error object -- error_code/error_summary/recovery_hint (issue #287
// fields) from a closed, wrapper-owned table.

/** Bounded stderr tail relayed to the operator on an exec-exit-nonzero
 *  failure. Independent of turn_diagnostics.ts's MAX_STDERR_BYTES=8192
 *  (that one bounds a host-private trace file); this one rides the wire
 *  inside error_detail, which itself gets clipText's 16384-byte clip
 *  downstream, so a smaller bound here leaves headroom for the exit-detail
 *  prefix kaoiro adds. */
export const MAX_RELAYED_STDERR_TAIL_BYTES = 4096;

/** Splits codex-sdk's own exec-failure Error message into the exit detail
 *  and the raw stderr it captured. Anchored to the EXACT format
 *  codex-sdk's CodexExec.run() throws -- verified directly against
 *  @openai/codex-sdk 0.153.4's dist/index.js (`throw new Error(
 *  \`Codex Exec exited with ${detail}: ${stderrBuffer.toString("utf8")}\`)`,
 *  where `detail` is `code ${code}` or `signal ${signal}`) -- rather than
 *  a generic non-greedy split, so JSON stderr content (which may itself
 *  contain ": ") cannot be mis-split. `message` should be the thrown
 *  Error's OWN `.message`, not `String(err)` (which prepends "Error: ").
 *  A future SDK release that changes this wording degrades to null here,
 *  not a crash -- the caller falls back to relaying the raw message
 *  as-is (masked and tail-clipped), losing only the JSON/code extraction. */
export function parseCodexExecErrorMessage(
  message: string,
): { exitDetail: string; stderrTail: string } | null {
  const match = /^Codex Exec exited with (code \d+|signal \S+): ([\s\S]*)$/.exec(
    message,
  );
  if (match === null) return null;
  return { exitDetail: match[1]!, stderrTail: match[2]! };
}

/** Extracts a single-line JSON error object from a stderr tail. Scans
 *  from the LAST line backwards (the real terminal error is more likely
 *  to be the last thing printed than the first) and returns the first
 *  line that parses as JSON with a `.error.message` string; `code`/`type`
 *  are included only when present and string-typed. Deliberately does
 *  not attempt multi-line/pretty-printed JSON -- when none is found, the
 *  caller still has the raw stderrTail for error_detail, so degrading to
 *  null loses only the structured error_code/error_summary/recovery_hint,
 *  not the underlying text. */
export function extractJsonErrorFromStderr(
  stderrTail: string,
): { message: string; code?: string; type?: string } | null {
  const lines = stderrTail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    // codex CLI prints its own JSON error lines with a log-level prefix
    // (`ERROR: {...}`, confirmed 2026-09 against a live `codex exec` 400
    // response) rather than as bare JSON, so parse from the line's first
    // `{` onward instead of the whole trimmed line.
    const jsonStart = line.indexOf("{");
    if (jsonStart === -1) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.slice(jsonStart));
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const error = (parsed as Record<string, unknown>).error;
    if (typeof error !== "object" || error === null) continue;
    const message = (error as Record<string, unknown>).message;
    if (typeof message !== "string") continue;
    const code = (error as Record<string, unknown>).code;
    const type = (error as Record<string, unknown>).type;
    return {
      message,
      ...(typeof code === "string" ? { code } : {}),
      ...(typeof type === "string" ? { type } : {}),
    };
  }
  return null;
}

interface CodexErrorCodeInfo {
  summary: string;
  hint?: string;
}

/** error_code mirrors an upstream enum only by convention: unlike
 *  claude-code's error_code (a closed TypeScript string-literal union at
 *  the SDK's own type level), Codex's `error.code`/`error.type` are plain
 *  fields inside unstructured, externally-controlled JSON text with no
 *  schema bounding their length (review finding, issue #300). Head-clip
 *  defensively so a malformed or reflected oversized value cannot ride
 *  the envelope unbounded -- every known real code (see CODEX_ERROR_CODES
 *  below) is a short snake_case word, well under this bound, so clipping
 *  before the table lookup never changes behavior for a legitimate code. */
export const MAX_ERROR_CODE_BYTES = 256;

/** A straight byte cut (as clipTail uses for the tail-clip case) can land
 *  mid-codepoint; toString("utf8") then substitutes a 3-byte U+FFFD for
 *  the dangling partial sequence, which can push the decoded string's own
 *  byte length back OVER MAX_ERROR_CODE_BYTES -- defeating the very bound
 *  this function exists to enforce (review finding, issue #300 round 2).
 *  Back off byte-by-byte from the cut point with a fatal decoder until the
 *  prefix is valid UTF-8 on its own, so the result never gains a
 *  cut-induced character and its byte length never exceeds the bound. */
function clipErrorCode(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= MAX_ERROR_CODE_BYTES) return value;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = MAX_ERROR_CODE_BYTES; end > 0; end--) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      continue;
    }
  }
  return "";
}

/** Closed, wrapper-owned code -> {summary, hint} table for Codex's own
 *  API/CLI JSON error envelope. Mirrors claude-code's
 *  ASSISTANT_ERROR_SUMMARIES (wrapper/claude-code/src/adapter.ts) in
 *  shape and in its degrade-gracefully contract: an unrecognized code
 *  still gets error_code set (forwarded as-is from `error.code ??
 *  error.type`, never fabricated) plus a fixed generic summary, so a
 *  future upstream error class does not vanish silently. Japanese text,
 *  matching the sibling table's precedent -- this is operator-facing UI
 *  copy shown on the dashboard, not repository documentation. */
const CODEX_ERROR_CODES: Readonly<Record<string, CodexErrorCodeInfo>> = {
  invalid_request_error: {
    summary: "リクエストが不正と判定されました。",
  },
  authentication_error: {
    summary: "認証エラーが発生しました。",
    hint: "Codex の認証情報を確認してください。",
  },
  rate_limit_error: {
    summary: "レート制限に達しました。",
    hint: "しばらく待ってから再送してください。",
  },
  server_error: {
    summary: "API サーバでエラーが発生しました。",
    hint: "しばらく待ってから再送してください。",
  },
};

const GENERIC_CODEX_ERROR_SUMMARY = "Codex でエラーが発生しました。";

/** Message-keyword sub-classification for a broad code: the code itself
 *  never changes on a match -- only recovery_hint is narrowed when the
 *  message identifies a specific, actionable cause the code alone does
 *  not distinguish. Kept deliberately small; add an entry only once a
 *  real failure has been observed carrying it (issue #300 決定 (b), the
 *  gpt-6-astra/invalid_request_error case below is the one currently
 *  on record). */
const CODEX_ERROR_MESSAGE_HINTS: ReadonlyArray<{
  pattern: RegExp;
  hint: string;
}> = [
  {
    pattern: /requires a newer version of codex/i,
    hint:
      "kaoiro が同梱する Codex CLI の更新が必要です。operator に連絡してください。",
  },
];

/** Builds error_code/error_summary/recovery_hint from a JSON error
 *  extracted from stderr: error_code is `error.code ?? error.type`,
 *  forwarded as-is (never fabricated -- null when the JSON has neither),
 *  head-clipped to MAX_ERROR_CODE_BYTES so it stays bounded like every
 *  sibling field; error_summary/recovery_hint come from the closed table
 *  above, falling back to a generic summary for a code the table does not
 *  yet recognize (same degrade-gracefully contract as claude-code's
 *  assistantErrorSummary). */
export function codexErrorClassification(jsonError: {
  message: string;
  code?: string;
  type?: string;
}): { error_code: string; error_summary: string; recovery_hint?: string } | null {
  const rawCode = jsonError.code ?? jsonError.type;
  if (rawCode === undefined) return null;
  const code = clipErrorCode(rawCode);
  const info = CODEX_ERROR_CODES[code];
  const keywordHint = CODEX_ERROR_MESSAGE_HINTS.find((entry) =>
    entry.pattern.test(jsonError.message),
  )?.hint;
  const hint = keywordHint ?? info?.hint;
  return {
    error_code: code,
    error_summary: info?.summary ?? GENERIC_CODEX_ERROR_SUMMARY,
    ...(hint !== undefined ? { recovery_hint: hint } : {}),
  };
}

/** Full relay payload for an exec-exit-nonzero failure (issue #300).
 *  `rawMessage` should be the thrown Error's own `.message` (see
 *  parseCodexExecErrorMessage's doc for why). JSON extraction reads the
 *  ORIGINAL, unmasked stderr tail (masking a still-JSON-structured line
 *  risks corrupting adjacent syntax, since the masking patterns' value
 *  capture does not stop at every JSON delimiter) -- safe because the
 *  extracted `message` field specifically is only ever used to
 *  keyword-match CODEX_ERROR_MESSAGE_HINTS above, never copied into what
 *  gets relayed (`code`/`type`, by contrast, ARE forwarded as-is via
 *  codexErrorClassification's error_code -- see decision (b) -- so only
 *  `message` gets this "extracted but not relayed" treatment). Masking
 *  is applied only to the separate copy that becomes error_detail, and
 *  BEFORE tail-clipping (not after), so a byte-cut cannot land mid-secret
 *  and leave an unmasked fragment exposed. Falls back to relaying
 *  `rawMessage` itself (masked and tail-clipped, no code/summary/hint)
 *  when it does not match the SDK's known exec-failure shape at all, so
 *  an unrecognized future SDK wording still relays SOMETHING rather than
 *  silently reverting to the pre-#300 bare `is_error: true`. */
export function codexExecFailureRelay(rawMessage: string): {
  error_detail: string;
  error_code?: string;
  error_summary?: string;
  recovery_hint?: string;
} {
  const parsed = parseCodexExecErrorMessage(rawMessage);
  const stderrTail = parsed?.stderrTail ?? rawMessage;
  const jsonError = extractJsonErrorFromStderr(stderrTail);
  const classification =
    jsonError !== null ? codexErrorClassification(jsonError) : null;
  const boundedTail = clipTail(
    redactCredentials(stderrTail),
    MAX_RELAYED_STDERR_TAIL_BYTES,
  );
  return {
    error_detail: boundedTail,
    ...(classification ?? {}),
  };
}
