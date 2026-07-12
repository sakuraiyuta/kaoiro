import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const TAIL_BYTES = 512 * 1024;
const rolloutPathCache = new Map<string, string>();

export function codexRolloutsRoot(): string {
  return join(homedir(), ".codex", "sessions");
}

function rolloutPathIn(root: string, sessionId: string): string | null {
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;
  let names: string[];
  try {
    names = readdirSync(root, { recursive: true }) as string[];
  } catch {
    return null;
  }
  const suffix = `-${sessionId}.jsonl`;
  const rel = names.find((name) => basename(name).endsWith(suffix));
  return rel === undefined ? null : join(root, rel);
}

function codexModelFromPath(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    const read = readSync(fd, buf, 0, buf.length, start);
    let text = buf.subarray(0, read).toString("utf8");
    // A tail starting mid-line must not be parsed as a complete JSON value.
    if (start > 0) {
      const newline = text.indexOf("\n");
      if (newline === -1) return null;
      text = text.slice(newline + 1);
    }
    const lines = text.trimEnd().split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const entry = JSON.parse(lines[i]!) as {
          type?: unknown;
          payload?: { model?: unknown };
        };
        if (
          entry.type === "turn_context" &&
          typeof entry.payload?.model === "string" &&
          entry.payload.model !== ""
        ) {
          return entry.payload.model;
        }
      } catch {
        // The last line may still be in flight; earlier complete lines remain usable.
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Reads only the end of a rollout and returns the latest resolved model. */
export function codexModelFromRolloutIn(
  root: string,
  sessionId: string,
): string | null {
  const path = rolloutPathIn(root, sessionId);
  return path === null ? null : codexModelFromPath(path);
}

/** The SDK emits thread.started close to the rollout write, so tolerate that race. */
export async function resolveCodexModel(
  sessionId: string,
  root = codexRolloutsRoot(),
): Promise<string | null> {
  const cacheKey = `${root}\0${sessionId}`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const cachedPath = rolloutPathCache.get(cacheKey);
    const path = cachedPath ?? rolloutPathIn(root, sessionId);
    if (path !== null && cachedPath === undefined) {
      rolloutPathCache.set(cacheKey, path);
    }
    const model = path === null ? null : codexModelFromPath(path);
    if (model !== null) return model;
    if (attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  return null;
}
