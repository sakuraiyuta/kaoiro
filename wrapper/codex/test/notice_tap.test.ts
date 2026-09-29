import { afterEach, expect, it } from "vitest";
import { tapStdout, type Tap } from "./fixtures/notice_tap.js";

let tap: Tap | undefined;
afterEach(() => { tap?.restore();tap = undefined; });
const bytes = (text: string) => new TextEncoder().encode(text);
const stream = { stream: true };

it("sees the notice token in one chunk", () => {
  tap = tapStdout();
  new TextDecoder().decode(bytes('{"method":"deprecationNotice","params":{}}\n'), stream);
  expect(tap.sawNotice()).toBe(true);
});

it("sees the notice token when a chunk boundary falls inside it", () => {
  tap = tapStdout();
  const decoder = new TextDecoder();
  decoder.decode(bytes('{"method":"deprecatio'), stream);
  expect(tap.sawNotice()).toBe(false);
  decoder.decode(bytes('nNotice","params":{}}\n'), stream);
  expect(tap.sawNotice()).toBe(true);
});

it("does not join the end of one stream to the start of another", () => {
  tap = tapStdout();
  new TextDecoder().decode(bytes('{"method":"deprecatio'), stream);
  new TextDecoder().decode(bytes('nNotice","params":{}}\n'), stream);
  expect(tap.sawNotice()).toBe(false);
});

it("stays silent for other notifications", () => {
  tap = tapStdout();
  const decoder = new TextDecoder();
  decoder.decode(bytes('{"method":"thread/status/changed"}\n'), stream);
  decoder.decode(bytes('{"method":"thread/tokenUsage/updated"}\n'), stream);
  expect(tap.sawNotice()).toBe(false);
});
