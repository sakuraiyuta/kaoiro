import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const TAIL_BYTES = 512 * 1024;
const rolloutPathCache = new Map<string, string>();

export function codexRolloutsRoot(): string {
  return join(homedir(), ".codex", "sessions");
}

/** Substrings a resume failure's free-form error detail carries when the
 *  underlying rollout JSONL is corrupted mid-write (issue #263 — ENOSPC or
 *  a host crash truncated a line while codex was appending to it; resume
 *  re-reads the whole file and fails every time thereafter).
 *
 *  - `did not contain valid utf-?8` is MEASURED (issue #255 comment 3338,
 *    2026-08-17 incident: "stream did not contain valid UTF-8 (code
 *    -32603)", captured directly from a `run_streamed_rejected` detail).
 *  - `EOF while parsing` is UNVERIFIED — it is Rust `serde_json`'s
 *    documented wording for input that ends before a JSON value closes
 *    (`EOF while parsing a string` / `an object` / `a value`), and
 *    codex-rs's rollout reader is Rust, but no real truncated-JSON trace
 *    has confirmed this exact string in this environment. Callers must
 *    still fall back to ordinary handling on a non-match — this list is a
 *    moving target across codex-sdk versions, not a closed contract. */
const ROLLOUT_CORRUPTION_PATTERNS = [
  /did not contain valid utf-?8/i,
  /eof while parsing/i,
] as const;

/** True when a resume/run failure's error detail matches a known rollout-
 *  corruption CANDIDATE pattern (issue #263). This is a hint, not a
 *  verdict — see `verifyRolloutCorruption`'s own doc for why a text match
 *  alone must never drive the permanent classification (ふじ MF-1: the
 *  codex-sdk 0.144.1 stderr this matches against is generic free-form text
 *  several unrelated dependencies can also emit). A `false` here means
 *  "not recognized as a candidate" — it does NOT mean the rollout is fine;
 *  callers must treat it as "fall back to the ordinary failure path",
 *  never as an all-clear. */
export function isRolloutCorruptionDetail(detail: string): boolean {
  return ROLLOUT_CORRUPTION_PATTERNS.some((pattern) => pattern.test(detail));
}

/** Verdict from actually inspecting a session's rollout file (issue #263,
 *  ふじ MF-1). `"unknown"` means "cannot confirm either way" — callers MUST
 *  treat it the same as `"clean"` for classification purposes (fall back
 *  to the ordinary, non-permanent failure path), never as `"corrupted"`. */
export type RolloutCorruptionVerdict = "corrupted" | "clean" | "unknown";

/** The actual verdict a resume-failure candidate (`isRolloutCorruptionDetail`)
 *  must be confirmed against before a session is ever classified as
 *  permanently corrupted. A stderr keyword match alone is not enough: the
 *  matched wording is generic free-form text (ふじ's review measured
 *  `@openai/codex-sdk` 0.144.1's `runStreamed` stderr directly — neither
 *  "stream did not contain valid UTF-8" nor "EOF while parsing" is unique
 *  to the rollout reader), so acting on text alone would permanently stop
 *  resuming a session that failed for an unrelated, self-recoverable
 *  reason (network blip, a dependency's own transient UTF-8 hiccup, …).
 *
 *  Reads the WHOLE file (unlike `tailRollout`'s bounded tail read — a
 *  corrupted line anywhere in the file, not just near the end, is grounds
 *  for the classification) and checks two things per non-empty line: it
 *  must fatally UTF-8-decode, and it must `JSON.parse`. Either failure on
 *  ANY line is enough to confirm real corruption.
 *
 *  `"unknown"` (session id has no resolvable rollout, or the file could
 *  not be opened/read) is deliberately its own outcome, distinct from
 *  `"clean"` — an unreadable file proves nothing about whether it is
 *  corrupted, so the caller must fall back to the ordinary failure path
 *  exactly as it would for `"clean"`, never escalate an I/O failure into a
 *  false-positive permanent classification.
 *
 *  Synchronous, like every other reader in this module — this check only
 *  ever runs on the rare resume-failure-with-candidate-wording path, not
 *  on the hot per-turn path, so the one-time full-file read cost is
 *  accepted rather than adding a second (async) I/O style to this file. */
export function verifyRolloutCorruption(
  sessionId: string,
  root = codexRolloutsRoot(),
): RolloutCorruptionVerdict {
  const path = rolloutPathIn(root, sessionId);
  if (path === null) return "unknown";
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch {
    return "unknown";
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text: string;
  try {
    text = decoder.decode(raw);
  } catch {
    return "corrupted";
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      JSON.parse(line);
    } catch {
      return "corrupted";
    }
  }
  return "clean";
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
