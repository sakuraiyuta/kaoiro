import "../../scripts/test/fixtures/test-isolation.mjs";
import { EventEmitter } from "node:events";
import { mkdtempSync, renameSync, rmSync, writeFileSync, type watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configStamp, notifyConfigSaves } from "../src/config-watcher.js";

let dir: string;
let path: string;
let lines: string[];
let observer: ReturnType<typeof notifyConfigSaves> | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runner-config-notice-"));
  path = join(dir, "runner.json");
  writeFileSync(path, "{}");
  lines = [];
  vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
    lines.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  observer?.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function start(before = configStamp(path)) {
  const native = Object.assign(new EventEmitter(), { close: vi.fn() });
  let emit!: (event: string, file: string | null) => void;
  const factory = ((_dir: string, _opts: unknown, listener: typeof emit) => {
    emit = listener;
    return native;
  }) as unknown as typeof watch;
  observer = notifyConfigSaves(path, before, factory);
  return { native, emit };
}

it("ignores siblings and unknown names, then reports the first save only", () => {
  const { native, emit } = start();
  expect(lines).toHaveLength(1);
  const notice = lines[0]!;
  expect(notice).toContain("after restart");
  expect(notice).toContain("even with identical bytes, does not re-probe Antigravity");
  emit("change", "sibling");
  emit("rename", null);
  expect(lines).toEqual([notice]);
  expect(native.close).not.toHaveBeenCalled();
  writeFileSync(path, "private-fixture-value");
  emit("rename", "runner.json");
  expect(lines).toEqual([notice, notice]);
  expect(native.close).toHaveBeenCalledTimes(1);
  emit("change", "runner.json");
  observer?.close();
  expect(lines).toEqual([notice, notice]);
  expect(native.close).toHaveBeenCalledTimes(1);
});

it("observes an actual atomic replacement with identical bytes", async () => {
  observer = notifyConfigSaves(path, configStamp(path));
  const notice = lines[0];
  writeFileSync(join(dir, "replacement"), "{}");
  renameSync(join(dir, "replacement"), path);
  await vi.waitFor(() => expect(lines).toEqual([notice, notice]));
});

it("keeps watching after detecting an edit during startup", () => {
  const before = configStamp(path);
  writeFileSync(path, "during-startup");
  const { emit } = start(before);
  expect(lines).toEqual([lines[0], lines[0]]);
  emit("change", "runner.json");
  expect(lines).toHaveLength(3);
});

it("reports unavailable observation without exposing a filesystem error", () => {
  const before = configStamp(path);
  rmSync(path);
  const { native } = start(before);
  expect(lines).toEqual([lines[0], lines[0], expect.stringContaining("unavailable")]);
  native.emit("error", new Error("private-fixture-value"));
  expect(native.close).toHaveBeenCalledTimes(1);
  expect(lines.at(-1)).toContain("only after restart");
  expect(lines.join("")).not.toContain("private-fixture-value");
  rmSync(dir, { recursive: true });
  observer = notifyConfigSaves(path, undefined);
  expect(lines.at(-1)).toContain("unavailable");
});
