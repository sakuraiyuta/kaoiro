// runner.config.json のライブリロード。runner はスタートアップで一度だけ
// config を読むが、dogfood の hot-reload 需要に応えるため、このモジュールが
// 監視 → 再読み込みを担う (cli.ts が dispatch)。設計判断:
//
//  - **親ディレクトリを監視**: エディタが atomic write (書き→ rename) で
//    保存すると、直接ファイルを watch する Node.js の `fs.watch` は
//    change イベントを取りこぼしやすい。親ディレクトリを watch して
//    filename でフィルタする方が横断的に堅い。
//  - **debounce**: エディタは 1 回の保存で複数 write を発火する。200ms
//    束ねてから再読み込みするので、書き途中の壊れ JSON を掴まない。
//  - **fail-soft**: 再パース例外は onParseError に流し、watcher は
//    生き続ける。編集中の一時的な broken JSON でランナーを落とさないため。

import { type FSWatcher, watch } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { loadRunnerConfig, type RunnerConfig } from "./config.js";

/** debounce 窓 (ms)。多段 write を束ねる目的なので、UI 応答性より
 *  「壊れ JSON を掴まない」を優先して十分長め。 */
export const CONFIG_WATCH_DEBOUNCE_MS = 200;

export interface ConfigWatcher {
  close(): void;
}

/** Injectable only at the filesystem boundary so debounce behaviour can be
 * tested without depending on the host kernel's fs.watch delivery timing. */
export interface WatchRunnerConfigOptions {
  watch?: typeof watch;
}

/**
 * `configPath` の親ディレクトリを watch し、対象ファイルの change イベントを
 * `CONFIG_WATCH_DEBOUNCE_MS` 束ねてから `loadRunnerConfig` を再走する。
 *
 * - 成功: `onReload(next)` を呼ぶ。値の diff / dispatch は呼び出し側の責務。
 * - パース失敗: `onParseError(error)` を呼ぶ。watcher は継続。
 *
 * `close()` は debounce タイマーごと watcher を停止する。
 */
export function watchRunnerConfig(
  configPath: string,
  onReload: (next: RunnerConfig) => void,
  onParseError: (error: unknown) => void,
  options: WatchRunnerConfigOptions = {},
): ConfigWatcher {
  const abs = resolve(configPath);
  const dir = dirname(abs);
  const name = basename(abs);
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  const trigger = (): void => {
    timer = undefined;
    try {
      const next = loadRunnerConfig(abs);
      onReload(next);
    } catch (error) {
      onParseError(error);
    }
  };

  const watcher: FSWatcher = (options.watch ?? watch)(
    dir,
    { persistent: false },
    (_event, filename) => {
      if (closed) return;
      // filename は Linux の inotify では通常 basename が入るが、環境に
      // よっては null が来る。null のときも保守的に発火して debounce に
      // 委ねる (取りこぼしより空振りの方が安全)。
      if (filename !== null && String(filename) !== name) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(trigger, CONFIG_WATCH_DEBOUNCE_MS);
    },
  );
  // FSWatcher は EventEmitter なので、'error' listener がないと 'error'
  // イベント発火時に unhandled として runner プロセス全体を落とす
  // (Node.js の EventEmitter 既定挙動)。想定される発生源: inotify の
  // watch descriptor 上限 (ENOSPC) / fd 上限 (EMFILE)、監視対象ディレ
  // クトリが削除される等。fail-soft ポリシー通り、log を吐いて config
  // reload 機能だけ静かに死なせる (次の SIGINT/SIGTERM まで watcher は
  // 復活しないが、既存の agent supervision は継続する)。
  watcher.on("error", (error) => {
    process.stderr.write(
      `runner: config watcher error (reload disabled): ${String(error)}\n`,
    );
  });

  return {
    close: (): void => {
      closed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      watcher.close();
    },
  };
}
