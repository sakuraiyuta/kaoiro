import { vi } from "vitest";

export type Tap = { sawNotice: () => boolean; restore: () => void };

const TOKEN = '"deprecationNotice"';
// A chunk boundary can fall inside the token, so each decoder keeps the end of
// what it decoded before and the search runs over that tail plus the new text.
const TAIL = 32;

// Raw child stdout, before the transport drops notifications without a threadId.
export function tapStdout(): Tap {
  const decode = TextDecoder.prototype.decode;
  const tails = new WeakMap<object, string>();
  let seen = false;
  const spy = vi.spyOn(TextDecoder.prototype, "decode").mockImplementation(function (this: InstanceType<typeof TextDecoder>, ...args) {
    const text = decode.apply(this, args);
    const window = (tails.get(this) ?? "") + text;
    if (window.includes(TOKEN)) seen = true;
    tails.set(this, window.slice(-TAIL));
    return text;
  });
  return { sawNotice: () => seen, restore: () => spy.mockRestore() };
}
