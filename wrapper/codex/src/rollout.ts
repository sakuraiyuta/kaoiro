import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const TAIL_BYTES = 512 * 1024;
const rolloutPathCache = new Map<string, string>();

export function codexRolloutsRoot(): string {
  return join(homedir(), ".codex", "sessions");
}

/** Finds one rollout by its validated opaque thread id. Shared by the tail
 * model resolver and full resume-history projection (#106). */
export function rolloutPathIn(root: string, sessionId: string): string | null {
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

/** Reads only the end of a rollout and passes each complete JSONL entry
 *  (newest last) to the visitor. The visitor returns true to stop; false to
 *  keep scanning older entries. A mid-line tail start and a partially written
 *  final line are both silently discarded. */
function tailRollout(
  path: string,
  visitor: (entry: Record<string, unknown>) => boolean,
): void {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return;
  }
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    const read = readSync(fd, buf, 0, buf.length, start);
    let text = buf.subarray(0, read).toString("utf8");
    if (start > 0) {
      const newline = text.indexOf("\n");
      if (newline === -1) return;
      text = text.slice(newline + 1);
    }
    const lines = text.trimEnd().split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(lines[i]!) as Record<string, unknown>;
      } catch {
        // The last line may still be in flight; earlier complete lines remain usable.
        continue;
      }
      if (visitor(entry)) return;
    }
  } catch {
    // Best-effort; caller treats absence as unknown.
  } finally {
    closeSync(fd);
  }
}

function codexModelFromPath(path: string): string | null {
  let found: string | null = null;
  tailRollout(path, (entry) => {
    const payload = entry.payload as { model?: unknown } | undefined;
    if (
      entry.type === "turn_context" &&
      typeof payload?.model === "string" &&
      payload.model !== ""
    ) {
      found = payload.model;
      return true;
    }
    return false;
  });
  return found;
}

/** Window keys aligned with Claude's SDKRateLimitInfo.rateLimitType, so
 *  downstream consumers can treat both engines uniformly. Codex only ever
 *  reports the two coarse windows; opus/sonnet/overage keys stay Claude-only. */
export type CodexRateLimitWindow = "five_hour" | "seven_day";

export type CodexRateLimitSnapshot = {
  /** Fraction 0-1 (Codex `used_percent` divided by 100), matching Claude's
   *  `SDKRateLimitInfo.utilization` unit. */
  utilization?: number;
  /** Unix seconds. Codex JSONL and Anthropic's oauth/usage both use seconds,
   *  so this matches Claude's `resets_at` as stored by AgentHost. */
  resets_at?: number;
};

/** Codex rollout `event_msg / token_count` payload as observed in
 *  `~/.codex/sessions/**\/*.jsonl`. Fields not needed here are omitted. */
type TokenCountSlot = {
  window_minutes?: unknown;
  used_percent?: unknown;
  resets_at?: unknown;
};

function windowFromMinutes(minutes: unknown): CodexRateLimitWindow | null {
  if (minutes === 300) return "five_hour";
  if (minutes === 10080) return "seven_day";
  return null;
}

function snapshotFromSlot(slot: unknown): {
  window: CodexRateLimitWindow;
  snapshot: CodexRateLimitSnapshot;
} | null {
  if (slot === null || typeof slot !== "object") return null;
  const s = slot as TokenCountSlot;
  const window = windowFromMinutes(s.window_minutes);
  if (window === null) return null;
  const snapshot: CodexRateLimitSnapshot = {};
  if (typeof s.used_percent === "number" && Number.isFinite(s.used_percent)) {
    snapshot.utilization = s.used_percent / 100;
  }
  if (typeof s.resets_at === "number" && Number.isFinite(s.resets_at)) {
    snapshot.resets_at = s.resets_at;
  }
  return { window, snapshot };
}

function codexRateLimitsFromPath(
  path: string,
): Map<CodexRateLimitWindow, CodexRateLimitSnapshot> {
  const out = new Map<CodexRateLimitWindow, CodexRateLimitSnapshot>();
  tailRollout(path, (entry) => {
    const payload = entry.payload as
      | { type?: unknown; rate_limits?: unknown }
      | undefined;
    if (entry.type !== "event_msg" || payload?.type !== "token_count") {
      return false;
    }
    const rl = payload.rate_limits as
      | { primary?: unknown; secondary?: unknown }
      | undefined;
    if (rl === undefined || rl === null) return true;
    for (const slot of [rl.primary, rl.secondary]) {
      const routed = snapshotFromSlot(slot);
      if (routed !== null && !out.has(routed.window)) {
        out.set(routed.window, routed.snapshot);
      }
    }
    // First (latest) token_count wins; earlier ones are stale.
    return true;
  });
  return out;
}

/** Reads only the end of a rollout and returns the latest resolved model. */
export function codexModelFromRolloutIn(
  root: string,
  sessionId: string,
): string | null {
  const path = rolloutPathIn(root, sessionId);
  return path === null ? null : codexModelFromPath(path);
}

/** Reads only the end of a rollout and returns the latest per-window
 *  rate-limit snapshots derived from `event_msg / token_count.rate_limits`.
 *  Returns an empty map when the rollout has no rate-limit data (unknown
 *  session id, no token_count yet, `rate_limits: null`).
 *
 *  Shares `rolloutPathCache` with `resolveCodexModel` so both accessors for
 *  the same session pay the recursive `readdirSync` scan of ~/.codex/sessions
 *  at most once, not once per turn. Without this cache, host.ts's
 *  #refreshRateLimits (fired unconditionally after every turn.completed /
 *  turn.failed) would re-scan the entire sessions tree — including all
 *  historical sessions — every turn, blocking the event loop and scaling
 *  poorly with session history. */
export function codexRateLimitsFromRolloutIn(
  root: string,
  sessionId: string,
): Map<CodexRateLimitWindow, CodexRateLimitSnapshot> {
  const cacheKey = `${root}\0${sessionId}`;
  const cached = rolloutPathCache.get(cacheKey);
  const path = cached ?? rolloutPathIn(root, sessionId);
  if (path !== null && cached === undefined) {
    rolloutPathCache.set(cacheKey, path);
  }
  return path === null
    ? new Map<CodexRateLimitWindow, CodexRateLimitSnapshot>()
    : codexRateLimitsFromPath(path);
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
