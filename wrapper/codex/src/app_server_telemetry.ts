import { rpcObject } from "./app_server_rpc.js";
import { codexRateLimitWindow, type CodexRateLimitSnapshot, type CodexRateLimitWindow } from "./rollout.js";

export interface AppServerTokenCounts {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}
export interface AppServerUsage {
  last: AppServerTokenCounts;
  total: AppServerTokenCounts;
  modelContextWindow: number | null;
}

function counts(value: unknown): AppServerTokenCounts | null {
  if (!rpcObject(value)) return null;
  const result = {} as AppServerTokenCounts;
  for (const key of ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"] as const) {
    const n = key === "cacheWriteInputTokens" && value[key] === undefined ? 0 : value[key];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return null;
    result[key] = n;
  }
  return result;
}

export function appServerUsage(value: unknown): AppServerUsage | null {
  if (!rpcObject(value)) return null;
  const last = counts(value.last), total = counts(value.total);
  const window = value.modelContextWindow ?? null;
  if (last === null || total === null || (window !== null &&
    (typeof window !== "number" || !Number.isSafeInteger(window) || window <= 0))) return null;
  return { last, total, modelContextWindow: window };
}

export interface AppServerRateLimitBucket {
  limitId: string | null;
  windows: Partial<Record<CodexRateLimitWindow, CodexRateLimitSnapshot>>;
}
export interface AppServerRateLimits {
  readStatus: "not-read" | "available" | "unavailable";
  buckets: AppServerRateLimitBucket[];
}
interface ReadToken { request: number; notification: number }

function bucket(value: unknown, key?: string): AppServerRateLimitBucket | null {
  if (!rpcObject(value)) return null;
  const limitId = value.limitId ?? key ?? null;
  if (limitId !== null && typeof limitId !== "string") return null;
  // A contradictory keyed view cannot safely identify which meter it describes.
  if (key !== undefined && limitId !== key) return null;
  const windows: AppServerRateLimitBucket["windows"] = {};
  for (const slot of [value.primary, value.secondary]) {
    if (!rpcObject(slot)) continue;
    const converted = codexRateLimitWindow(slot.windowDurationMins, slot.usedPercent, slot.resetsAt);
    if (converted !== null && windows[converted.window] === undefined) windows[converted.window] = converted.snapshot;
  }
  return { limitId, windows };
}

function readBuckets(value: unknown): AppServerRateLimitBucket[] | null {
  if (!rpcObject(value)) return null;
  if (value.rateLimitsByLimitId != null) {
    if (!rpcObject(value.rateLimitsByLimitId)) return null;
    const buckets: AppServerRateLimitBucket[] = [];
    for (const [key, entry] of Object.entries(value.rateLimitsByLimitId)) {
      const parsed = bucket(entry, key);
      if (parsed === null) return null;
      buckets.push(parsed);
    }
    return buckets;
  }
  const parsed = bucket(value.rateLimits);
  return parsed === null ? null : [parsed];
}

/** Account telemetry has no turn identity. Keep meters separate and never
 * retain account, plan, credit, or other opaque backend fields. */
export class AppServerAccountTelemetry {
  #buckets = new Map<string | null, AppServerRateLimitBucket>();
  #readStatus: AppServerRateLimits["readStatus"] = "not-read";
  #request = 0;
  #notification = 0;

  get snapshot(): AppServerRateLimits {
    return structuredClone({ readStatus: this.#readStatus, buckets: [...this.#buckets.values()] });
  }

  update(value: unknown): void {
    const parsed = bucket(value);
    if (parsed === null) return;
    this.#notification += 1;
    this.#buckets.set(parsed.limitId, parsed);
  }

  beginRead(): ReadToken { return { request: ++this.#request, notification: this.#notification }; }

  finishRead(token: ReadToken, value: unknown): void {
    if (token.request !== this.#request) return;
    const parsed = readBuckets(value);
    this.#readStatus = parsed === null ? "unavailable" : "available";
    // Notifications arriving during a read are newer evidence. A failed or
    // stale read must not erase them or restore an older utilization value.
    if (parsed === null || token.notification !== this.#notification) return;
    this.#buckets = new Map(parsed.map(entry => [entry.limitId, entry]));
  }
}
