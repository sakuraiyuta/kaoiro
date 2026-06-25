// Shared log-payload construction: turns the adapter's normalized LogEntry
// into the wire LogPayload, applying the size-clipping and secret-dropping
// invariants (protocol.md log.truncated). Used by both the live host path
// (host.ts) and resume history reconstruction (history.ts, ADR-0014 phase-2)
// so the two never drift on truncation / oversized-input handling.

import type { LogEntry, LogPayload } from "./types.js";

/** Relayed log text/output above this UTF-8 size is clipped (protocol.md
 *  truncated); oversized tool input is dropped wholesale like the
 *  permission payload. Keeps each envelope well under the server cap. */
export const MAX_LOG_BYTES = 16_384;

/** Clips text to MAX_LOG_BYTES of UTF-8, flagging truncation. A cut may
 *  land mid-codepoint; toString renders the partial byte as U+FFFD,
 *  which is harmless for a transcript. */
export function clipText(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= MAX_LOG_BYTES) {
    return { text, truncated: false };
  }
  const clipped = Buffer.from(text, "utf8")
    .subarray(0, MAX_LOG_BYTES)
    .toString("utf8");
  return { text: clipped, truncated: true };
}

/** Builds the wire LogPayload (size-clipped) for one normalized LogEntry.
 *  `toolNames` maps a tool_use_id to its tool_name so a tool_result can name
 *  its tool; a tool_use entry registers itself into it (the map is mutated,
 *  and tool_use is always seen before its result). */
export function logEntryToPayload(
  entry: LogEntry,
  toolNames: Map<string, string>,
): LogPayload {
  switch (entry.kind) {
    case "assistant": {
      const { text, truncated } = clipText(entry.text);
      return truncated
        ? { kind: "assistant", text, truncated: true }
        : { kind: "assistant", text };
    }
    case "tool_use": {
      if (entry.tool_use_id) {
        toolNames.set(entry.tool_use_id, entry.tool_name);
      }
      const payload: LogPayload = {
        kind: "tool_use",
        tool_name: entry.tool_name,
      };
      if (entry.tool_use_id) payload.tool_use_id = entry.tool_use_id;
      // Drop oversized input wholesale: a cut JSON is unparseable and
      // could split a secret (mirrors the permission payload).
      if (
        Buffer.byteLength(JSON.stringify(entry.input), "utf8") <= MAX_LOG_BYTES
      ) {
        payload.input = entry.input;
      } else {
        payload.truncated = true;
      }
      return payload;
    }
    case "tool_result": {
      const { text, truncated } = clipText(entry.output);
      const payload: LogPayload = { kind: "tool_result", output: text };
      if (entry.tool_use_id) payload.tool_use_id = entry.tool_use_id;
      const name = entry.tool_use_id
        ? toolNames.get(entry.tool_use_id)
        : undefined;
      if (name) payload.tool_name = name;
      if (truncated) payload.truncated = true;
      return payload;
    }
  }
}
