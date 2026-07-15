// Runner-local memory cache for the Claude engine's launch catalog
// (Option E, ADR-0039). Not persisted to disk — a runner restart re-primes
// via the next dialog-open probe. `force=true` (LaunchDialog manual refresh
// button) bypasses the freshness check; `force=false`/omitted honours the
// TTL. A concurrent probe for the same engine is deduplicated to one
// in-flight subprocess whose ProbeOutcome fans out to every awaiter.

import type { EngineModelInfo } from "@kaoiro/protocol";
import type { ProbeOutcome } from "@kaoiro/claude-code/probe-client";

/** Freshness window before an auto-refresh triggers a live probe. 1 hour
 *  matches Claude's model-catalog release cadence (Anthropic ships new
 *  models sporadically, not per-hour). A manual refresh (`force=true`)
 *  ignores this. */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
  models: EngineModelInfo[];
  fetchedAt: number;
}

export interface CacheState {
  cached: CacheEntry | null;
  /** In-flight probe promise, shared by concurrent callers. */
  inFlight: Promise<ProbeOutcome> | null;
}

export interface ClaudeCatalogCacheOptions {
  ttlMs?: number;
  now?: () => number;
}

/** Cache + dedup for one engine. Currently only used for "claude-code",
 *  but the shape stays engine-neutral in case a second live-catalog engine
 *  lands. */
export class ClaudeCatalogCache {
  readonly #ttlMs: number;
  readonly #now: () => number;
  #state: CacheState = { cached: null, inFlight: null };

  constructor(options: ClaudeCatalogCacheOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  /** Snapshot for tests / diagnostics. Callers must not mutate. */
  peek(): Readonly<CacheState> {
    return this.#state;
  }

  /** Cached models when the entry is still fresh; null otherwise. */
  getIfFresh(): EngineModelInfo[] | null {
    const c = this.#state.cached;
    if (c === null) return null;
    if (this.#now() - c.fetchedAt > this.#ttlMs) return null;
    return c.models;
  }

  /** Cached models regardless of TTL. Used as a graceful fallback when a
   *  probe fails: the operator still sees the last-known catalog rather
   *  than reverting to the bootstrap `default`-only list. */
  getStale(): EngineModelInfo[] | null {
    return this.#state.cached?.models ?? null;
  }

  /** Distinguishes an in-cache reply (no probe ran, no register push needed)
   *  from a live probe reply (either freshly measured or a still-cached
   *  fanned-out dedup result). Only "probe" outcomes should drive a
   *  register re-broadcast; "cache" is a pure metadata read. */
  static readonly CACHE_HIT: "cache" = "cache";

  /** Orchestrator: on `force`, always probe (even if fresh). Otherwise
   *  return the fresh cache without probing. Dedupes concurrent probes to
   *  one child process. Success writes the cache; failure leaves the
   *  previous entry intact. Never throws — callers get a ProbeOutcome. */
  async refresh(
    probe: () => Promise<ProbeOutcome>,
    force: boolean,
  ): Promise<ProbeOutcome> {
    if (!force) {
      const fresh = this.getIfFresh();
      if (fresh !== null) {
        // source: "cache" tells the orchestrator to skip updateRegister
        // (the cache is already what the register carries) — see藤 review
        // medium item.
        return {
          ok: true,
          models: fresh,
          elapsed_ms: 0,
          source: ClaudeCatalogCache.CACHE_HIT,
        };
      }
    }

    // Dedup: if a probe is already running, coalesce onto its result rather
    // than spawning a second subprocess. This is the "concurrent probe
    // dedup" constraint (藤 turn-1 制約 6). Note this dedups per engine —
    // if the caller passed force=true while a non-forced probe is in
    // flight, we still coalesce (the in-flight probe is doing the same
    // thing; the operator saw the button and it does a live probe). We
    // also tag the dedup fan-out as source:"cache" so only ONE register
    // push happens per real probe (藤 review medium item).
    if (this.#state.inFlight !== null) {
      const shared = this.#state.inFlight;
      return shared.then((outcome) =>
        outcome.ok
          ? { ...outcome, source: ClaudeCatalogCache.CACHE_HIT }
          : outcome,
      );
    }

    // Use an async IIFE so `finally` runs on BOTH resolve and reject
    // (previous `.then(...)` chain leaked inFlight forever on rejection —
    // 藤 must-fix 5). Errors are converted to a ProbeOutcome so callers
    // still see a structured result.
    const p = (async (): Promise<ProbeOutcome> => {
      try {
        const outcome = await probe();
        if (outcome.ok && outcome.models !== undefined) {
          this.#state.cached = {
            models: outcome.models,
            fetchedAt: this.#now(),
          };
        }
        return outcome;
      } catch (err) {
        return {
          ok: false,
          reason: "cli_error",
          detail: err instanceof Error ? err.message : String(err),
          elapsed_ms: 0,
        };
      } finally {
        this.#state.inFlight = null;
      }
    })();
    this.#state.inFlight = p;
    return p;
  }
}
