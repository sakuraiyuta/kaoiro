import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** fs event → debounce → parse の一連を実行するのに実タイマー時間が要る。
 *  vi.useFakeTimers() は fs.watch のカーネル→JS ディスパッチと相性が悪く、
 *  イベント自体が届かないため、実タイマーで少しだけ待つ実運用 wait を採る。 */
const settle = (extra = 50): Promise<void> =>
  new Promise((resolve) =>
    setTimeout(resolve, CONFIG_WATCH_DEBOUNCE_MS + extra),
  );

describe("watchRunnerConfig", () => {
  let dir: string;
  let path: string;
  let watcher: { close: () => void } | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kaoiro-runner-cw-"));
    path = join(dir, "runner.config.json");
    writeFileSync(path, JSON.stringify(validConfig));
  });

  afterEach(() => {
    watcher?.close();
    watcher = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it("ファイル更新後 debounce 待ちで onReload に新 config を渡す", async () => {
    const onReload = vi.fn<(next: RunnerConfig) => void>();
    const onParseError = vi.fn();
    watcher = watchRunnerConfig(path, onReload, onParseError);
    const next = { ...validConfig, host_id: "lab-pc-2" };
    writeFileSync(path, JSON.stringify(next));
    await settle();
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onReload.mock.calls[0]?.[0]).toMatchObject({ host_id: "lab-pc-2" });
    expect(onParseError).not.toHaveBeenCalled();
  });

  it("壊れた JSON は onParseError に流し watcher は生存する", async () => {
    const onReload = vi.fn();
    const onParseError = vi.fn();
    watcher = watchRunnerConfig(path, onReload, onParseError);
    writeFileSync(path, "{not json");
    await settle();
    expect(onReload).not.toHaveBeenCalled();
    expect(onParseError).toHaveBeenCalledTimes(1);
    // 続けて有効な内容で保存 → 正しく onReload が呼ばれる (fail-soft の検証)
    writeFileSync(path, JSON.stringify({ ...validConfig, host_id: "lab-pc-3" }));
    await settle();
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onReload.mock.calls[0]?.[0]).toMatchObject({ host_id: "lab-pc-3" });
  });

  it("debounce 窓内の連続 write は onReload 一回に束ねる", async () => {
    const onReload = vi.fn();
    const onParseError = vi.fn();
    watcher = watchRunnerConfig(path, onReload, onParseError);
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(path, JSON.stringify({ ...validConfig, host_id: `h${i}` }));
    }
    await settle();
    expect(onReload).toHaveBeenCalledTimes(1);
    // 最後の書き込み内容が反映される
    expect(onReload.mock.calls[0]?.[0]?.host_id).toBe("h4");
  });

  it("close 後は以降の write イベントで onReload を呼ばない", async () => {
    const onReload = vi.fn();
    const onParseError = vi.fn();
    watcher = watchRunnerConfig(path, onReload, onParseError);
    watcher.close();
    watcher = undefined;
    writeFileSync(path, JSON.stringify({ ...validConfig, host_id: "post" }));
    await settle();
    expect(onReload).not.toHaveBeenCalled();
  });
});
