import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { PermissionConfiguration } from "@kaoiro/protocol";
import { codexHome } from "./codex_home.js";

const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const TAIL_BYTES = 512 * 1024;
const rolloutPathCache = new Map<string, string>();

export interface CodexPermissionRolloutCursor {
  root: string;
  sessionId: string | null;
  path: string | null;
  offset: number;
  knownTurnIds: ReadonlySet<string>;
  /** A resumed session must prove its pre-exec append boundary. Unlike a
   * fresh session, a later-discovered file can contain old contexts. */
  resumeBaselineUnavailable: boolean;
}

export interface CodexPermissionTurnContext {
  sessionId: string;
  turnId: string;
  sandbox: PermissionConfiguration["sandbox"];
  networkAccess: boolean;
  approvalPolicy: string;
}

export function codexRolloutsRoot(): string {
  return join(codexHome(), "sessions");
}

/** Finds one rollout by its validated opaque thread id. Callers are the
 * rate-limit reader, the sidecar path, and the permission-cursor helpers. */
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

function turnContextFrom(value: unknown, sessionId: string): CodexPermissionTurnContext | null {
  if (value === null || typeof value !== "object") return null;
  const entry = value as { type?: unknown; payload?: unknown };
  if (entry.type !== "turn_context" || entry.payload === null || typeof entry.payload !== "object") {
    return null;
  }
  const payload = entry.payload as {
    turn_id?: unknown;
    sandbox_policy?: unknown;
    approval_policy?: unknown;
  };
  if (
    typeof payload.turn_id !== "string" || payload.turn_id === "" ||
    typeof payload.approval_policy !== "string" ||
    payload.approval_policy === "" ||
    payload.sandbox_policy === null || typeof payload.sandbox_policy !== "object"
  ) {
    return null;
  }
  const sandboxPolicy = payload.sandbox_policy as {
    type?: unknown;
    network_access?: unknown;
  };
  switch (sandboxPolicy.type) {
    case "read-only":
      return {
        sessionId,
        turnId: payload.turn_id,
        sandbox: "read-only",
        networkAccess: false,
        approvalPolicy: payload.approval_policy,
      };
    case "danger-full-access":
      return {
        sessionId,
        turnId: payload.turn_id,
        sandbox: "danger-full-access",
        networkAccess: true,
        approvalPolicy: payload.approval_policy,
      };
    case "workspace-write":
      return typeof sandboxPolicy.network_access !== "boolean"
        ? null
        : {
            sessionId,
            turnId: payload.turn_id,
            sandbox: "workspace-write",
            networkAccess: sandboxPolicy.network_access,
            approvalPolicy: payload.approval_policy,
          };
    default:
      return null;
  }
}

function knownTurnIdsIn(path: string, sessionId: string): Set<string> | null {
  const known = new Set<string>();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    try {
      const context = turnContextFrom(JSON.parse(line), sessionId);
      if (context !== null) known.add(context.turnId);
    } catch {
      // A partial final line is not a completed prior turn context.
    }
  }
  return known;
}

/** Captures the append boundary before an exec. Resumed sessions have a
 * stable path at this point; a fresh session is bound after thread.started. */
export function captureCodexPermissionRolloutCursor(
  root: string,
  sessionId: string | null,
): CodexPermissionRolloutCursor {
  const path = sessionId === null ? null : rolloutPathIn(root, sessionId);
  if (path === null || sessionId === null) {
    return {
      root,
      sessionId,
      path: null,
      offset: 0,
      knownTurnIds: new Set(),
      resumeBaselineUnavailable: sessionId !== null,
    };
  }
  try {
    const knownTurnIds = knownTurnIdsIn(path, sessionId);
    if (knownTurnIds === null) throw new Error("rollout baseline is unreadable");
    return {
      root,
      sessionId,
      path,
      offset: statSync(path).size,
      knownTurnIds,
      resumeBaselineUnavailable: false,
    };
  } catch {
    return {
      root,
      sessionId,
      path: null,
      offset: 0,
      knownTurnIds: new Set(),
      resumeBaselineUnavailable: true,
    };
  }
}

/** Accepts one new turn's consistent policy evidence, including compaction
 * repeats. Distinct turns or conflicting axes cannot identify one exec. */
export function codexPermissionContextAfter(
  cursor: CodexPermissionRolloutCursor,
  sessionId: string,
  expectedTurnId?: string,
): CodexPermissionTurnContext | null {
  if (cursor.sessionId !== null && cursor.sessionId !== sessionId) return null;
  if (cursor.resumeBaselineUnavailable) return null;
  const path = cursor.path ?? rolloutPathIn(cursor.root, sessionId);
  if (path === null || (cursor.path !== null && path !== cursor.path)) return null;
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }
  if (size < cursor.offset) return null;
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const bytes = Buffer.alloc(size - cursor.offset);
    const read = readSync(fd, bytes, 0, bytes.length, cursor.offset);
    const complete = bytes.subarray(0, read).toString("utf8");
    const finalNewline = complete.lastIndexOf("\n");
    if (finalNewline < 0) return null;
    let candidate: CodexPermissionTurnContext | null = null;
    for (const line of complete.slice(0, finalNewline).split("\n")) {
      try {
        const context = turnContextFrom(JSON.parse(line), sessionId);
        if (context !== null && !cursor.knownTurnIds.has(context.turnId)) {
          // Compaction repeats turn_context for the same execution. A repeat
          // is evidence only when every observed policy axis still agrees.
          if (candidate !== null && (
            candidate.turnId !== context.turnId ||
            candidate.sandbox !== context.sandbox ||
            candidate.networkAccess !== context.networkAccess ||
            candidate.approvalPolicy !== context.approvalPolicy
          )) return null;
          candidate = context;
        }
      } catch {
        // Ignore malformed non-terminal records; a candidate must be a
        // complete, independently parseable turn_context line.
      }
    }
    return expectedTurnId !== undefined && candidate?.turnId !== expectedTurnId ? null : candidate;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Absolute path to a session's IA sidecar — beside its rollout file, per
 *  ADR-0051 D3-2. Null until the rollout itself exists: codex nests
 *  rollouts by date, so the directory is not derivable from the session id
 *  alone and the sidecar has to wait in the pending journal until it is. */
export function codexSidecarPath(
  sessionId: string,
  root = codexRolloutsRoot(),
): string | null {
  const rollout = rolloutPathIn(root, sessionId);
  if (rollout === null) return null;
  return join(dirname(rollout), `${sessionId}.ia.jsonl`);
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
  return codexRateLimitWindow(s.window_minutes, s.used_percent, s.resets_at);
}

/** Shared numeric conversion; wire field names and bucket identity belong
 * to their callers. Preserve exec's finite values without clamping. */
export function codexRateLimitWindow(minutes: unknown, usedPercent: unknown, resetsAt: unknown): {
  window: CodexRateLimitWindow;
  snapshot: CodexRateLimitSnapshot;
} | null {
  const window = windowFromMinutes(minutes);
  if (window === null) return null;
  const snapshot: CodexRateLimitSnapshot = {};
  if (typeof usedPercent === "number" && Number.isFinite(usedPercent)) {
    snapshot.utilization = usedPercent / 100;
  }
  if (typeof resetsAt === "number" && Number.isFinite(resetsAt)) {
    snapshot.resets_at = resetsAt;
  }
  // A window name alone is not an observed limit. Keeping this out of the
  // map preserves the protocol's absent = unknown contract for whoami and
  // state_change.ext when Codex emits an incomplete token_count slot.
  if (snapshot.utilization === undefined && snapshot.resets_at === undefined) {
    return null;
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
    // Codex currently emits one window per token_count (in `primary`), rather
    // than a pair on every event. Keep walking until each known window has its
    // newest value; stopping at the newest event alone loses (for example) a
    // seven_day value when the following event only carries five_hour.
    return out.size === 2;
  });
  return out;
}

/** Reads only the end of a rollout and returns the latest per-window
 *  rate-limit snapshots derived from `event_msg / token_count.rate_limits`.
 *  Returns an empty map when the rollout has no rate-limit data (unknown
 *  session id, no token_count yet, `rate_limits: null`).
 *
 *  `rolloutPathCache` stores the resolved path so the per-turn rate-limit
 *  read does not repeat the recursive sessions scan. Without this cache,
 *  host.ts's #refreshRateLimits (fired unconditionally after every
 *  turn.completed / turn.failed) would re-scan the sessions tree every turn. */
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
