import { createHash } from "node:crypto";
import {
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { clipUtf8Tail } from "@kaoiro/wrapper-core";

const MAX_CAPTURE_DIRECTORIES = 20;

export function defaultCodexTurnTraceDir(): string {
  if (process.env.KAOIRO_CODEX_TURN_TRACE_DIR !== undefined) {
    return process.env.KAOIRO_CODEX_TURN_TRACE_DIR;
  }
  // Unit tests intentionally do not leave failure traces in a developer's
  // home directory. Production has no VITEST marker and uses the durable
  // per-user diagnostic location below.
  if (process.env.VITEST !== undefined) {
    return join(tmpdir(), "kaoiro-codex-turn-traces-test");
  }
  return join(homedir(), ".kaoiro", "codex-turn-traces");
}

/** A host-private directory. The stable hashed agent segment helps operators
 * group traces without placing an arbitrary agent_id in a filesystem path. */
export function codexTurnTraceCaptureDir(
  baseDirectory: string,
  agentId: string,
  captureId: string,
): string {
  const agentKey = createHash("sha256").update(agentId).digest("hex").slice(0, 16);
  return join(baseDirectory, "agents", agentKey, captureId);
}

/** Retains a bounded number of former host-private capture directories for
 * one agent. The current host has a new capture id, so startup may prune its
 * predecessors before this host first writes diagnostics. */
export async function pruneCodexTurnTraceCaptureDirs(
  baseDirectory: string,
  agentId: string,
): Promise<void> {
  const agentKey = createHash("sha256").update(agentId).digest("hex").slice(0, 16);
  const agentDirectory = join(baseDirectory, "agents", agentKey);
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await readdir(agentDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const captures = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const path = join(agentDirectory, entry.name);
        try {
          return { path, mtimeMs: (await stat(path)).mtimeMs };
        } catch {
          return null;
        }
      }),
  );
  const stale = captures
    .filter((entry): entry is { path: string; mtimeMs: number } => entry !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(MAX_CAPTURE_DIRECTORIES);
  await Promise.all(stale.map(({ path }) => rm(path, { recursive: true, force: true })));
}

/** Keeps the longest tail of whole characters within `maxBytes` of UTF-8
 *  (issue #624: a plain byte cut could gain U+FFFD and exceed the cap).
 *  Exported for adapter.ts's operator-facing stderr-tail extraction
 *  (issue #300). */
export function clipTail(value: string, maxBytes: number): string {
  return clipUtf8Tail(value, maxBytes);
}
