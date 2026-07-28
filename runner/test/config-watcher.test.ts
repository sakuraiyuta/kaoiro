import { mkdtempSync, rmSync, type FSWatcher, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerConfig } from "../src/config.js";
import {
  CONFIG_WATCH_DEBOUNCE_MS,
  watchRunnerConfig,
} from "../src/config-watcher.js";

const validConfig = {
  host_id: "lab-pc-1",
  server_url: "ws://localhost:4000/runner",
  cwd_allowlist: ["/home/user/git/kaoiro"],
};

describe("watchRunnerConfig", () => {
  let dir: string;
  let path: string;
  let watcher: { close: () => void } | undefined;
  let emitWatchEvent: ((event: string, filename: string | Buffer | null) => void) | undefined;
  let nativeWatcher: FSWatcher;
  let watchFactory: typeof import("node:fs").watch;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), "kaoiro-runner-cw-"));
    path = join(dir, "runner.config.json");
    writeFileSync(path, JSON.stringify(validConfig));
    nativeWatcher = {
      close: vi.fn(),
      on: vi.fn(),
    } as unknown as FSWatcher;
    watchFactory = vi.fn((_dir, _options, listener) => {
      emitWatchEvent = listener;
      return nativeWatcher;
    }) as unknown as typeof import("node:fs").watch;
  });

  afterEach(() => {
    watcher?.close();
    watcher = undefined;
    vi.clearAllTimers();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  function start(
    onReload: (next: RunnerConfig) => void,
    onParseError: (error: unknown) => void,
  ): void {
    watcher = watchRunnerConfig(path, onReload, onParseError, { watch: watchFactory });
  }

  async function dispatch(filename: string | Buffer | null = "runner.config.json"): Promise<void> {
    emitWatchEvent?.("change", filename);
    await vi.advanceTimersByTimeAsync(CONFIG_WATCH_DEBOUNCE_MS);
  }

  it("ファイル更新後 debounce 待ちで onReload に新 config を渡す", async () => {
    const onReload = vi.fn<(next: RunnerConfig) => void>();
    const onParseError = vi.fn();
    start(onReload, onParseError);
    const next = { ...validConfig, host_id: "lab-pc-2" };
    writeFileSync(path, JSON.stringify(next));
    await dispatch();
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onReload.mock.calls[0]?.[0]).toMatchObject({ host_id: "lab-pc-2" });
    expect(onParseError).not.toHaveBeenCalled();
  });

  it("壊れた JSON は onParseError に流し watcher は生存する", async () => {
    const onReload = vi.fn();
    const onParseError = vi.fn();
    start(onReload, onParseError);
    writeFileSync(path, "{not json");
    await dispatch();
    expect(onReload).not.toHaveBeenCalled();
    expect(onParseError).toHaveBeenCalledTimes(1);
    // 続けて有効な内容で保存 → 正しく onReload が呼ばれる (fail-soft の検証)
    writeFileSync(path, JSON.stringify({ ...validConfig, host_id: "lab-pc-3" }));
    await dispatch();
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onReload.mock.calls[0]?.[0]).toMatchObject({ host_id: "lab-pc-3" });
  });

  it("debounce 窓内の連続 write は onReload 一回に束ねる", async () => {
    const onReload = vi.fn();
    const onParseError = vi.fn();
    start(onReload, onParseError);
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(path, JSON.stringify({ ...validConfig, host_id: `h${i}` }));
      emitWatchEvent?.("change", "runner.config.json");
    }
    await vi.advanceTimersByTimeAsync(CONFIG_WATCH_DEBOUNCE_MS);
    expect(onReload).toHaveBeenCalledTimes(1);
    // 最後の書き込み内容が反映される
    expect(onReload.mock.calls[0]?.[0]?.host_id).toBe("h4");
  });

  it("close 後は以降の write イベントで onReload を呼ばない", async () => {
    const onReload = vi.fn();
    const onParseError = vi.fn();
    start(onReload, onParseError);
    const activeWatcher = watcher;
    expect(activeWatcher).toBeDefined();
    activeWatcher?.close();
    watcher = undefined;
    writeFileSync(path, JSON.stringify({ ...validConfig, host_id: "post" }));
    await dispatch();
    expect(onReload).not.toHaveBeenCalled();
  });
});
