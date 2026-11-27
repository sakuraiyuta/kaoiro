import { type FSWatcher, statSync, watch } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const RESTART_NOTICE =
  "runner: Runner config saves take effect only after restart. Saving the " +
  "file, even with identical bytes, does not re-probe Antigravity. " +
  "Its advertised model list is refreshed at the next runner start.\n";
const UNAVAILABLE =
  "runner: Config save detection unavailable. Changes take effect only after restart.\n";

export function configStamp(path: string): string | undefined {
  try {
    const s = statSync(path, { bigint: true });
    return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
  } catch {
    return undefined;
  }
}

/** Observe the first save, including editors that atomically replace the file. */
export function notifyConfigSaves(
  path: string, before: string | undefined, watchDirectory = watch,
): { close(): void } {
  const file = resolve(path);
  const name = basename(file);
  let watcher: FSWatcher | undefined;
  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    watcher?.close();
  }

  process.stderr.write(RESTART_NOTICE);
  try {
    watcher = watchDirectory(dirname(file), { persistent: false }, (_, filename) => {
      if (closed || filename !== name) return;
      process.stderr.write(RESTART_NOTICE);
      close();
    });
    watcher.on("error", () => {
      if (closed) return;
      process.stderr.write(UNAVAILABLE);
      close();
    });
    const after = configStamp(file);
    if (before !== after) process.stderr.write(RESTART_NOTICE);
    if (before === undefined || after === undefined) process.stderr.write(UNAVAILABLE);
  } catch {
    process.stderr.write(UNAVAILABLE);
    close();
  }
  return { close };
}
