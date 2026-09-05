// Extracts the latest "response" envelope per agent for the response
// timeline (issue #25). "Response" = the model's own speech to the
// operator: assistant-kind log lines and result envelopes. Tool traffic
// (tool_use / tool_result), operator-echoed user lines, cross-agent
// bubbles (inter_agent_message), and boundary markers (session_boundary)
// are excluded — they are visible in the detail transcript but do not
// belong in the operator's "who said what last" bird's-eye view.
//
// Pure so vitest can pin the extraction rules without mounting the
// component.

import type { Envelope } from "./protocol";

export interface LatestReplyEntry {
  agentId: string;
  envelope: Envelope;
  /** One-line preview text for the timeline row. Empty string when the
   *  reply had no readable text (e.g. an is_error result with no body). */
  summary: string;
}

/** Maximum characters shown in the one-line summary. Real text is
 *  clipped with an ellipsis; the CSS also caps display width, so this
 *  is a data-side cap that keeps the wire payload manageable and
 *  ellipsis position deterministic. */
export const SUMMARY_MAX_CHARS = 80;

/** Newlines and repeated whitespace collapse to a single space so the
 *  timeline row stays on one visual line even for long streams whose
 *  first "paragraph" contains a break. */
function toSummary(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= SUMMARY_MAX_CHARS) return collapsed;
  return collapsed.slice(0, SUMMARY_MAX_CHARS - 1) + "…";
}

function replyText(envelope: Envelope): string | null {
  if (envelope.type === "result") {
    const payload = envelope.payload as
      | { text?: unknown; is_error?: unknown; error_summary?: unknown }
      | undefined;
    // issue #287 (ふじ2 round1 S1): a success-subtype API error (e.g. auth
    // failure) never carries payload.text (adapter.ts drops it on
    // is_error, so the raw SDK text cannot reach the wire) -- reading
    // .text alone left the timeline row blank instead of showing the
    // wrapper's own bounded summary that AgentDetail already prefers.
    if (payload?.is_error === true) {
      const summary = payload.error_summary;
      return typeof summary === "string" ? summary : "";
    }
    const text = payload?.text;
    return typeof text === "string" ? text : "";
  }
  if (envelope.type === "log") {
    const payload = envelope.payload as
      | { kind?: unknown; text?: unknown }
      | undefined;
    if (payload?.kind !== "assistant") return null;
    return typeof payload.text === "string" ? payload.text : "";
  }
  return null;
}

/** Same key as protocol.ts compareTranscriptEnvelopes uses (ts primary,
 *  seq secondary). Positive result means `a` is newer than `b`. */
function compareTs(a: Envelope, b: Envelope): number {
  const byTime = a.ts.localeCompare(b.ts);
  if (byTime !== 0) return byTime;
  return (a.seq ?? 0) - (b.seq ?? 0);
}

/** Per-agent latest response, sorted newest first. Agents with no
 *  response envelope at all are omitted so the timeline shows only rows
 *  that carry information. */
export function latestReplies(
  logs: Record<string, Envelope[]>,
): LatestReplyEntry[] {
  const entries: LatestReplyEntry[] = [];
  for (const [agentId, transcript] of Object.entries(logs)) {
    let latest: Envelope | null = null;
    let latestText: string | null = null;
    for (const envelope of transcript) {
      const text = replyText(envelope);
      if (text === null) continue;
      // Keep the newer envelope: compareTs positive = envelope newer than latest.
      if (latest === null || compareTs(envelope, latest) > 0) {
        latest = envelope;
        latestText = text;
      }
    }
    if (latest !== null && latestText !== null) {
      entries.push({
        agentId,
        envelope: latest,
        summary: toSummary(latestText),
      });
    }
  }
  // Sort newest first: b newer than a → positive → b before a.
  entries.sort((a, b) => compareTs(b.envelope, a.envelope));
  return entries;
}
