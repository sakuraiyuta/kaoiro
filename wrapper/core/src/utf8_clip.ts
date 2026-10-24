// UTF-8 byte caps that never split a character. A plain byte cut followed by
// a decode turns a partial sequence into U+FFFD (3 bytes), which can push the
// result past the cap it was cut to (issue #624).

function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0b1100_0000) === 0b1000_0000;
}

/** The largest end <= maxBytes that does not fall inside a UTF-8 sequence.
 *  It steps back over at most 3 continuation bytes, the most a valid sequence
 *  has, so a malformed run is cut near maxBytes rather than scanned. */
export function utf8HeadEnd(bytes: Uint8Array, maxBytes: number): number {
  if (maxBytes <= 0) return 0;
  if (bytes.byteLength <= maxBytes) return bytes.byteLength;
  let end = maxBytes;
  for (let step = 0; step < 3 && end > 0 && isContinuation(bytes[end]); step += 1) {
    end -= 1;
  }
  return end;
}

function utf8TailStart(bytes: Uint8Array, maxBytes: number): number {
  if (maxBytes <= 0) return bytes.byteLength;
  if (bytes.byteLength <= maxBytes) return 0;
  let start = bytes.byteLength - maxBytes;
  for (let step = 0; step < 3 && isContinuation(bytes[start]); step += 1) {
    start += 1;
  }
  return start;
}

/** The longest prefix of whole characters within maxBytes of UTF-8. */
export function clipUtf8Head(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const bytes = Buffer.from(text, "utf8");
  return bytes.subarray(0, utf8HeadEnd(bytes, maxBytes)).toString("utf8");
}

/** The longest suffix of whole characters within maxBytes of UTF-8. */
export function clipUtf8Tail(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const bytes = Buffer.from(text, "utf8");
  return bytes.subarray(utf8TailStart(bytes, maxBytes)).toString("utf8");
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/** The longest prefix within maxUnits UTF-16 code units that does not end
 *  between the two halves of a surrogate pair (issue #630). */
export function clipUtf16Head(text: string, maxUnits: number): string {
  if (maxUnits <= 0) return "";
  if (text.length <= maxUnits) return text;
  const end = isHighSurrogate(text.charCodeAt(maxUnits - 1)) ? maxUnits - 1 : maxUnits;
  return text.slice(0, end);
}

/** The longest suffix within maxUnits UTF-16 code units that does not start
 *  between the two halves of a surrogate pair (issue #630). */
export function clipUtf16Tail(text: string, maxUnits: number): string {
  if (maxUnits <= 0) return "";
  if (text.length <= maxUnits) return text;
  const start = text.length - maxUnits;
  return text.slice(isLowSurrogate(text.charCodeAt(start)) ? start + 1 : start);
}
