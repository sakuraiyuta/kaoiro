// Agent status lines on the dashboard wire (issue 482): the shapes the server
// sends, the parsers that vouch for them, and the ordering rule that keeps a
// late event from overwriting a newer line.
//
// The text is free markdown written by an agent. Nothing here renders it; the
// card shows the head as plain text and the history dialog renders markdown
// through UntrustedMarkdown.

/** One agent's latest line as the join snapshot and the live event carry it.
 *  A clear is a row too: the stamp lets the ordering rule reject an older line
 *  that arrives after it. */
export type StatusLineRow =
  | {
      cleared: false;
      seq: number;
      /** At most 512 UTF-8 bytes, cut by the server on a grapheme boundary. */
      head: string;
      /** The full line is longer than `head`. */
      truncated: boolean;
      /** Size of the full line in UTF-8 bytes. */
      bytes: number;
      updatedAt: string;
    }
  | { cleared: true; seq: number; updatedAt: string };

/** What a card shows. `none` is "do not draw the row": the snapshot has not
 *  arrived, or it was incomplete and this agent has no line of its own. It is
 *  never "unset", because "unset" is a statement about the agent. `cleared` is
 *  true when the agent had a line and withdrew it, so the change log has
 *  something to read. A truncated `set` head is already trimmed to what draws
 *  only what the full line draws (truncatedMarkdown.ts); it can be empty. */
export type StatusLineView =
  | { kind: "none" }
  | { kind: "unset"; cleared: boolean }
  | { kind: "set"; head: string; truncated: boolean; bytes: number; updatedAt: string };

/** Drawn in place of a truncated head that has nothing left to draw. A fixed
 *  sentence of the dashboard, never markdown: the agent's text cannot spell it
 *  into its own line without the normal class. */
export const HEAD_OMITTED = "(冒頭が長いため省略)";

/** Whether a `set` view draws HEAD_OMITTED instead of its head. A complete line
 *  that is only blank keeps drawing its blank body. */
export function headOmitted(view: { head: string; truncated: boolean }): boolean {
  return view.truncated && view.head.trim() === "";
}

/** The retention behind the change log (operators only). */
export type StatusLineSettings = {
  retention: number;
  source: "stored" | "env" | "default";
  min: number;
  max: number;
};

/** One entry of an agent's change log, newest first. `text` is the full line,
 *  or null for a clear. */
export type StatusLineHistoryEntry = {
  seq: number;
  text: string | null;
  bytes: number | null;
  updatedAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A row from the snapshot map or the live event. Rejects, never repairs: a
 *  line the client cannot vouch for is no line, and showing "unset" for it
 *  would be a claim. */
export function parseStatusLineRow(raw: unknown): StatusLineRow | null {
  if (!isRecord(raw)) return null;
  const seq = positiveInteger(raw.seq);
  const updatedAt = nonEmptyString(raw.updated_at);
  if (seq === null || updatedAt === null) return null;
  if (raw.cleared === true) return { cleared: true, seq, updatedAt };
  const bytes = positiveInteger(raw.bytes);
  if (typeof raw.head !== "string" || typeof raw.truncated !== "boolean" || bytes === null) {
    return null;
  }
  // The server sends an empty head only when even the first grapheme was too
  // large, which is a truncated line.
  if (raw.head === "" && !raw.truncated) return null;
  return { cleared: false, seq, head: raw.head, truncated: raw.truncated, bytes, updatedAt };
}

/** `status_line` live event: a row plus the agent it belongs to. */
export function parseStatusLine(raw: unknown): { agentId: string; row: StatusLineRow } | null {
  if (!isRecord(raw)) return null;
  const agentId = nonEmptyString(raw.agent_id);
  const row = parseStatusLineRow(raw);
  return agentId === null || row === null ? null : { agentId, row };
}

/** `status_line_snapshot`: a malformed entry is dropped alone. `incomplete`
 *  means the server could not vouch for the whole set, so an absent agent is
 *  unknown, not unset. */
export function parseStatusLineSnapshot(raw: unknown): {
  rows: Record<string, StatusLineRow>;
  incomplete: boolean;
} | null {
  if (!isRecord(raw) || !isRecord(raw.agents)) return null;
  const rows: Record<string, StatusLineRow> = {};
  for (const [agentId, entry] of Object.entries(raw.agents)) {
    const row = parseStatusLineRow(entry);
    if (row !== null) rows[agentId] = row;
  }
  return { rows, incomplete: raw.snapshot_incomplete === true };
}

export function parseStatusLineSettings(raw: unknown): StatusLineSettings | null {
  if (!isRecord(raw)) return null;
  const retention = positiveInteger(raw.retention);
  const min = positiveInteger(raw.min);
  const max = positiveInteger(raw.max);
  if (retention === null || min === null || max === null) return null;
  if (raw.source !== "stored" && raw.source !== "env" && raw.source !== "default") return null;
  return { retention, source: raw.source, min, max };
}

/** The reply to `status_line_history`. Null when the reply is not a list of
 *  entries; a malformed entry is dropped alone. */
export function parseStatusLineHistory(raw: unknown): StatusLineHistoryEntry[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.entries)) return null;
  const entries: StatusLineHistoryEntry[] = [];
  for (const item of raw.entries) {
    if (!isRecord(item)) continue;
    const seq = positiveInteger(item.seq);
    const updatedAt = nonEmptyString(item.updated_at);
    if (seq === null || updatedAt === null) continue;
    if (item.text === null) {
      entries.push({ seq, text: null, bytes: null, updatedAt });
    } else if (typeof item.text === "string") {
      entries.push({ seq, text: item.text, bytes: positiveInteger(item.bytes), updatedAt });
    }
  }
  return entries;
}

/** Whether `candidate` is strictly newer than `held`. `updatedAt` is compared
 *  first: the server stamps it at fixed microsecond precision in UTC so string
 *  order is time order, and it survives a store reset where `seq` restarts at
 *  1. `seq` breaks a tie. */
export function isNewer(
  candidate: { seq: number; updatedAt: string },
  held: { seq: number; updatedAt: string },
): boolean {
  if (candidate.updatedAt !== held.updatedAt) return candidate.updatedAt > held.updatedAt;
  return candidate.seq > held.seq;
}
