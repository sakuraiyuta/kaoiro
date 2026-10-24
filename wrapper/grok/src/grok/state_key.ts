import type { Envelope } from "@kaoiro/agent-common";

/** JSON with the keys of every object sorted, so values that differ only in
 *  key order give the same string. Keys holding `undefined` are dropped.
 *  The input must be plain JSON data: `toJSON` is not called, so a `Date`,
 *  `Map`, `Set` or other class instance compares as `{}`. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Identity of a state_change envelope: everything but its timestamp. Two
 *  envelopes with the same key tell the server nothing new. */
export function stateChangeKey(envelope: Envelope): string {
  const { ts: _ts, ...rest } = envelope;
  return canonicalJson(rest);
}
