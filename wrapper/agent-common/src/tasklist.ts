// Shared tasklist wire shaping (issue #188, ADR-0049). Both engine adapters
// receive whole-list snapshots, so keeping the bounds and omission accounting
// here prevents Claude/Codex drift before either reaches the common task
// envelope builder.

import type {
  TasklistItem,
  TasklistItemStatus,
  TasklistOmitted,
} from "./types.js";

/** Reserved task identity for an agent's single tasklist entity. */
export const TASKLIST_TASK_ID = "tasklist";
/** Maximum number of real source items rendered in one snapshot. */
export const MAX_TASKLIST_ITEMS = 50;
/** Maximum UTF-8 size of one visible item text. */
export const MAX_TASKLIST_ITEM_TEXT_BYTES = 256;
/** Defense-in-depth JSON ceiling mirrored by server ingress validation. */
export const MAX_TASKLIST_ITEMS_JSON_BYTES = 16_384;

export interface TasklistSourceItem {
  text: string;
  status: TasklistItemStatus;
}

export interface TasklistSnapshot {
  items: TasklistItem[];
  omitted?: TasklistOmitted;
}

/** Clips a string at a UTF-8 code-point boundary. Unlike a raw Buffer slice,
 * this never introduces U+FFFD into a task text merely to fit the wire cap. */
function clipUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return text;

  let end = maxBytes;
  while (end > 0) {
    const byte = bytes[end];
    if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) break;
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf8");
}

/**
 * Normalizes an engine's whole-list source event into the bounded wire form.
 * The first items are retained in source order. Any remainder is represented
 * by an explicit count and completed tally, so the operator can see that the
 * detail is partial while aggregate progress remains accurate. The JSON cap
 * is checked incrementally because quote/backslash escaping can make a
 * byte-limited source string larger on the JSON wire.
 */
export function normalizeTasklist(
  source: readonly TasklistSourceItem[],
): TasklistSnapshot {
  const items: TasklistItem[] = [];

  for (const candidate of source) {
    if (items.length >= MAX_TASKLIST_ITEMS) break;
    const item: TasklistItem = {
      text: clipUtf8(candidate.text, MAX_TASKLIST_ITEM_TEXT_BYTES),
      status: candidate.status,
    };
    if (
      Buffer.byteLength(JSON.stringify([...items, item]), "utf8") >
      MAX_TASKLIST_ITEMS_JSON_BYTES
    ) {
      break;
    }
    items.push(item);
  }

  const omittedSource = source.slice(items.length);
  if (omittedSource.length === 0) return { items };

  return {
    items,
    omitted: {
      count: omittedSource.length,
      completed: omittedSource.filter((item) => item.status === "completed").length,
    },
  };
}
